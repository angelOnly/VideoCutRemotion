import { runSourceMaterialAcquisition } from "./source-material-acquisition.js";
import { assetAcquisitionOptionsSchema } from "../../../packages/asset-acquisition/src/options.js";
import { runSoundRanking } from "./sound-ranking.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import {
  AssetProviderRegistry,
  assertDownloadedProviderMedia,
  assertProviderMediaAnalysis,
  createDefaultAssetProviderRegistry
} from "@videocut/acquisition";
import { ComfyUIBridgeClient, FUNASR_WORKFLOW_ID } from "@videocut/bridge";
import { createApplication, type EditingApplication } from "@videocut/application";
import { assetById, DomainError } from "@videocut/domain";
import { runOneQueuedJob, type JobProcessor } from "@videocut/job-runtime";
import { readRuntimeConfig } from "@videocut/project-overview";
import { FunASRService, OmniVoiceSegmentService, SourceCaptionAlignmentService, assemblePlacedSpeech, probeMedia, runProcess } from "@videocut/speech";
import type { Asset, AssetCandidate, BridgeRunAudit, JobKind, JobRecord, ProjectSnapshot } from "@videocut/contracts";
import { runAvatarGeneration } from "./avatar-generation.js";
import { runDialogueProcessing } from "./dialogue-processing.js";
import { runMulticamSync } from "./multicam-sync.js";
import { runMusicGeneration } from "./music-generation.js";
import { runSpeechAlignment } from "./speech-alignment.js";
import { runVideoGeneration } from "./video-generation.js";
import { runVlogAnalysis } from "./vlog-analysis.js";
import { runMediaUnderstanding, runMediaSearch } from "./media-understanding.js";
import { runMotionLibrarySearch, runMotionReferenceAnalysis } from "./motion-library.js";

const workspaceRoot = readRuntimeConfig().workspace.root;
let defaultApplication: EditingApplication | undefined;
const getDefaultApplication = () => (defaultApplication ??= createApplication(workspaceRoot));

/**
 * 历史 source_caption_generation / source_caption_sentence_alignment 仍可从 SQLite 读取，
 * 但绝不能被 Worker claim 或重新执行；唯一正式入口是段级 source_caption_alignment。
 */
export const MEDIA_JOB_KINDS: JobKind[] = ["media_analysis", "vlog_analysis", "multicam_sync", "asset_acquisition", "transcription", "source_caption_alignment", "voice_synthesis", "speech_assembly", "dialogue_processing", "speech_alignment", "music_generation", "video_generation", "avatar_generation"];
MEDIA_JOB_KINDS.push("source_material_acquisition", "media_understanding", "media_search", "sound_ranking", "motion_library_search", "motion_reference_analysis");

const resolveAssetPath = (snapshot: ProjectSnapshot, asset: Asset) => isAbsolute(asset.managedPath) ? asset.managedPath : join(snapshot.project.rootPath, asset.managedPath);

/**
 * Evidence 的原始 PDF 不会进入 Timeline 或被 ffprobe 伪装成视频；
 * Worker 只确认其基础文件头后登记为 ready，实际可视页面仍必须由独立图片快照绑定。
 */
async function analyzeDocument(path: string): Promise<NonNullable<Asset["metadata"]>> {
  if (extname(path).toLocaleLowerCase() !== ".pdf") {
    throw new DomainError("当前只支持将 PDF 作为可追溯的原始证据文档导入", "DOCUMENT_FORMAT_UNSUPPORTED");
  }
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 5 || header.toString("ascii") !== "%PDF-") {
      throw new DomainError("证据文档不是可识别的 PDF 文件", "DOCUMENT_PDF_INVALID");
    }
  } finally {
    await handle.close();
  }
  return { durationMs: 0, hasAudio: false, mime: "application/pdf" };
}

async function createThumbnail(snapshot: ProjectSnapshot, asset: Asset): Promise<string | undefined> {
  // 静态图片本身可直接作为素材预览；不把它送进视频 seek 流程，避免没有时长的图片被误报失败。
  if (asset.kind !== "video" && asset.kind !== "actor_video") return undefined;
  if (!asset.metadata?.videoCodec) return undefined;
  const relativePath = join("assets", "proxy", `${asset.id}.jpg`);
  const targetPath = join(snapshot.project.rootPath, relativePath);
  await mkdir(join(snapshot.project.rootPath, "assets", "proxy"), { recursive: true });
  const seekSeconds = Math.max(0, Math.min(1, asset.metadata.durationMs / 2000));
  await runProcess("ffmpeg", ["-y", "-ss", seekSeconds.toFixed(2), "-i", resolveAssetPath(snapshot, asset), "-frames:v", "1", "-vf", "scale=320:-2", targetPath], 120_000);
  return relativePath;
}

async function runMediaAnalysis(application: EditingApplication, job: JobRecord): Promise<Record<string, unknown>> {
  const assetId = String(job.payload.assetId ?? "");
  application.markAssetAnalyzing({ projectId: job.projectId, assetId });
  const current = application.readProject(job.projectId);
  const asset = assetById(current.snapshot, assetId);
  try {
    const sourcePath = resolveAssetPath(current.snapshot, asset);
    const metadata = asset.kind === "document"
      ? await analyzeDocument(sourcePath)
      : await probeMedia(sourcePath);
    metadata.thumbnailPath = await createThumbnail(current.snapshot, { ...asset, metadata });
    application.applyMediaAnalysis({ projectId: job.projectId, assetId, metadata });
    return { assetId, durationMs: metadata.durationMs, hasAudio: metadata.hasAudio, thumbnailPath: metadata.thumbnailPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    application.failAssetAnalysis({ projectId: job.projectId, assetId, reason: message });
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

/**
 * 下载只发生在 Worker：候选中的公开来源和技术信息先由 Application 校验。
 * 图片和视频均须通过 MIME、文件头、哈希与 ffprobe 的视觉流核验后，才进入项目受管目录。
 */
async function runAssetAcquisition(
  application: EditingApplication,
  job: JobRecord,
  providers: AssetProviderRegistry
): Promise<Record<string, unknown>> {
  const assetCandidateId = String(job.payload.assetCandidateId ?? "");
  if (!assetCandidateId) throw new DomainError("素材本地化任务缺少 assetCandidateId", "ASSET_CANDIDATE_ID_MISSING");
  let storedPath: string | undefined;
  let temporaryDirectory: string | undefined;
  try {
    application.markAssetCandidateAcquiring({ projectId: job.projectId, assetCandidateId });
    // 新任务执行提交时的来源快照；旧任务沿其既有候选与固定获取选项继续。
    const candidate = (job.payload.candidate ?? application.readAssetCandidate({ projectId: job.projectId, assetCandidateId }).candidate) as AssetCandidate;
    const provider = providers.get(candidate.provider);
    temporaryDirectory = join(application.readProject(job.projectId).snapshot.project.rootPath, "cache", "asset-acquisition", job.id);
    const acquisition = assetAcquisitionOptionsSchema.parse(job.payload.acquisition ?? {});
    const downloaded = await provider.download({ candidate, temporaryDirectory, options: acquisition });
    await assertDownloadedProviderMedia({
      filePath: downloaded.filePath,
      contentType: downloaded.contentType,
      expectedKind: candidate.kind,
      expectedMimeType: candidate.mimeType
    });
    const metadata = await probeMedia(downloaded.filePath);
    assertProviderMediaAnalysis({ candidate, metadata });
    if (JSON.stringify(downloaded.sourceRange) !== JSON.stringify(acquisition.sourceRange)) throw new DomainError("获取结果缺少一致的原片范围，不能猜测本地时间", "ASSET_SOURCE_RANGE_MISMATCH");
    if (acquisition.sourceRange && Math.abs(metadata.durationMs - (acquisition.sourceRange.endMs - acquisition.sourceRange.startMs)) > Math.max(150, 2000 / (metadata.fps || 24))) {
      throw new DomainError("取得片段的实测时长与原片范围不一致", "ASSET_SOURCE_RANGE_MISMATCH");
    }
    const sourceHash = await hashFile(downloaded.filePath);
    const current = application.readProject(job.projectId);
    const duplicate = current.snapshot.assets.find((asset) => asset.sourceHash === sourceHash);
    const extension = extname(downloaded.fileName).toLocaleLowerCase();
    if (!extension) throw new DomainError("Provider 必须提供与已验证媒体一致的文件后缀", "ASSET_DOWNLOAD_EXTENSION_MISSING");
    const relativePath = join("assets", "source", `${sourceHash.slice(0, 20)}${extension}`);
    storedPath = join(current.snapshot.project.rootPath, relativePath);
    if (duplicate) {
      await rm(downloaded.filePath, { force: true });
      storedPath = undefined;
    } else {
      await mkdir(join(current.snapshot.project.rootPath, "assets", "source"), { recursive: true });
      await rename(downloaded.filePath, storedPath);
    }
    const completed = application.completeAssetAcquisition({
      projectId: job.projectId,
      assetCandidateId,
      jobId: job.id,
      name: downloaded.fileName,
      managedPath: duplicate?.managedPath ?? relativePath,
      sourceHash,
      metadata
    });
    // 并发下载同一内容时，Application 会保留先入库的 Asset；清理这次多余移动的临时副本。
    if (completed.duplicate && storedPath) await rm(storedPath, { force: true });
    return {
      assetCandidateId,
      assetId: completed.asset.id,
      duplicate: completed.duplicate,
      sourceHash,
      mediaAnalysisJobId: completed.mediaAnalysisJob?.id,
      durationMs: metadata.durationMs,
      sourceRange: downloaded.sourceRange,
      localRange: downloaded.sourceRange ? { startMs: 0, endMs: metadata.durationMs } : undefined,
      observations: application.readAssetCandidate({ projectId: job.projectId, assetCandidateId }).observations
    };
  } catch (error) {
    if (storedPath) await rm(storedPath, { force: true }).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    try {
      application.failAssetCandidateAcquisition({ projectId: job.projectId, assetCandidateId, jobId: job.id, reason });
    } catch {
      // Job 可能在失败前被取消或候选已被其它 Worker 完成；原始错误仍由 Job Runtime 记录。
    }
    throw error;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isBridgeRunAudit(value: unknown): value is BridgeRunAudit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.workflowId === "string"
    && typeof record.runId === "string"
    && typeof record.schemaVersion === "string"
    && typeof record.schemaRetryCount === "number"
    && typeof record.submittedAt === "string"
    && Boolean(record.request)
    && typeof record.request === "object";
}

function latestTranscriptionAudit(job: JobRecord): BridgeRunAudit | undefined {
  const stored = job.result?.bridgeRuns;
  if (stored === undefined) return undefined;
  if (!Array.isArray(stored)) {
    throw new DomainError("转写 Job 的 Bridge 审计格式损坏，不能安全判断是否已提交 Run", "TRANSCRIPTION_BRIDGE_AUDIT_INVALID");
  }
  if (stored.length === 0) return undefined;
  const audit = [...stored].reverse().find((entry): entry is BridgeRunAudit => (
    isBridgeRunAudit(entry) && entry.workflowId === FUNASR_WORKFLOW_ID
  ));
  if (!audit) {
    throw new DomainError("转写 Job 已保留外部运行记录，但没有可识别的 FunASR 审计", "TRANSCRIPTION_BRIDGE_AUDIT_INVALID");
  }
  return audit;
}

/** 沿 retryOfJobId 追溯原任务；只要任一层已有 Run，就必须恢复它而不能重新提交。 */
function resolveTranscriptionAudit(application: EditingApplication, job: JobRecord): BridgeRunAudit | undefined {
  const ownAudit = latestTranscriptionAudit(job);
  if (ownAudit) return ownAudit;
  const visited = new Set<string>([job.id]);
  let sourceId: unknown = job.payload.retryOfJobId;
  while (sourceId !== undefined) {
    if (typeof sourceId !== "string" || visited.has(sourceId)) {
      throw new DomainError("转写重试来源无效或形成循环，不能安全恢复外部 Run", "TRANSCRIPTION_RETRY_SOURCE_INVALID");
    }
    visited.add(sourceId);
    const source = application.trackJob(sourceId);
    if (source.projectId !== job.projectId || source.kind !== "transcription" || source.payload.assetId !== job.payload.assetId) {
      throw new DomainError("转写重试来源必须是同一项目、同一素材的转写 Job", "TRANSCRIPTION_RETRY_SOURCE_MISMATCH");
    }
    const audit = latestTranscriptionAudit(source);
    if (audit) return audit;
    sourceId = source.payload.retryOfJobId;
  }
  return undefined;
}

/**
 * 为注入的 Application 创建处理器。这样测试与独立 Worker 都不会误用进程级全局实例。
 */
export function createMediaJobProcessor(
  app: EditingApplication,
  bridge = new ComfyUIBridgeClient(),
  providers: AssetProviderRegistry = createDefaultAssetProviderRegistry()
): JobProcessor {
  const funAsr = new FunASRService(app, bridge);
  const sourceCaptionAlignment = new SourceCaptionAlignmentService(app, bridge);
  const omniVoice = new OmniVoiceSegmentService(app, bridge);
  return async (job) => {
    switch (job.kind) {
      case "source_material_acquisition": return runSourceMaterialAcquisition(app, job);
      case "media_analysis":
        return runMediaAnalysis(app, job);
      case "media_understanding":
        return runMediaUnderstanding(app, job, bridge, providers);
      case "sound_ranking": return runSoundRanking(app, job, bridge);
      case "media_search":
        return runMediaSearch(app, job, bridge);
      case "motion_library_search": return runMotionLibrarySearch(app, job, bridge);
      case "motion_reference_analysis": return runMotionReferenceAnalysis(app, job, bridge);
      case "vlog_analysis":
        return runVlogAnalysis(app, job);
      case "multicam_sync":
        return runMulticamSync(app, job);
      case "asset_acquisition":
        return runAssetAcquisition(app, job, providers);
      case "transcription": {
        const assetId = String(job.payload.assetId);
        const audit = resolveTranscriptionAudit(app, job);
        const report = (entry: BridgeRunAudit) => { app.recordBridgeRun(job.id, entry); };
        return audit
          ? funAsr.resumeTranscription(job.projectId, assetId, audit, report)
          : funAsr.transcribe(job.projectId, assetId, report);
      }
      case "source_caption_alignment":
        return sourceCaptionAlignment.align(job);
      case "voice_synthesis":
        return omniVoice.synthesize(
          job.projectId,
          typeof job.payload.voiceReferenceAssetId === "string" ? job.payload.voiceReferenceAssetId : undefined,
          Array.isArray(job.payload.speechSegmentIds) ? job.payload.speechSegmentIds.map(String) : [],
          Number(job.payload.scriptRevision),
          typeof job.payload.voiceReferenceId === "string" ? job.payload.voiceReferenceId : undefined,
          (audit) => { app.recordBridgeRun(job.id, audit); }
        );
      case "speech_assembly":
        return assemblePlacedSpeech(app, job);
      case "dialogue_processing":
        return runDialogueProcessing(app, job);
      case "speech_alignment":
        return runSpeechAlignment(app, job, bridge);
      case "music_generation":
        return runMusicGeneration(app, job, bridge);
      case "video_generation":
        return runVideoGeneration(app, job, bridge);
      case "avatar_generation":
        return runAvatarGeneration(app, job, bridge);
      default:
        throw new DomainError(`任务类型 ${job.kind} 不属于媒体 Worker`, "JOB_NOT_IMPLEMENTED");
    }
  };
}

export async function runOneJob(
  app: EditingApplication = getDefaultApplication(),
  processor: JobProcessor = createMediaJobProcessor(app)
): Promise<boolean> {
  return runOneQueuedJob(app, MEDIA_JOB_KINDS, processor);
}

export async function runWorkerForever(app: EditingApplication = getDefaultApplication(), signal?: AbortSignal, processor: JobProcessor = createMediaJobProcessor(app)): Promise<void> {
  let stopping = signal?.aborted ?? false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    // 两条有界消费循环允许长时间外部分析等待时，另一条继续领取配音与素材任务。
    const consume = async () => {
      while (!stopping) {
        const worked = await runOneJob(app, processor);
        if (!worked) await new Promise((resolve) => setTimeout(resolve, 750));
      }
    };
    await Promise.all([consume(), consume()]);
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

// 发行 Runtime 以 CommonJS bundle 引入本模块；只让源码 Worker 入口自行启动。
const launchedAsStandaloneWorker = /(?:^|\/)apps\/job-worker\/src\/index\.(?:ts|js)$/u.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (launchedAsStandaloneWorker) {
  runWorkerForever().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
