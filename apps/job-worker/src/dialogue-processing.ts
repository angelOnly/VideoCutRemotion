import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CompletedDialogueProcessingVariant,
  DialogueProcessingJobPayload,
  EditingApplication
} from "@videocut/application";
import type { Asset, DialogueProcessingIssue, JobRecord, ProjectSnapshot } from "@videocut/contracts";
import { assetById, DomainError, millisecondsToFrames } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";

const DIALOGUE_PROCESSING_JOB_KIND = "dialogue_processing";
const PROFILES = ["minimal", "strong"] as const;
// PCM WAV 的时长应保持源样本数；给 ffprobe 的毫秒取整保留极小容差，不能只靠同一帧桶放行半帧漂移。
const MAX_DURATION_DRIFT_MS = 5;
const KNOWN_ISSUES = new Set<DialogueProcessingIssue>([
  "noise", "low_frequency", "sibilance", "loudness", "true_peak"
]);
let availableFiltersPromise: Promise<Set<string>> | undefined;

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

type DialogueProcessingContext = {
  snapshot: ProjectSnapshot;
  source: Asset;
  payload: DialogueProcessingJobPayload;
  expectedFrames: number;
};

function managedPath(snapshot: ProjectSnapshot, asset: Asset): string {
  const projectRoot = resolve(snapshot.project.rootPath);
  const path = isAbsolute(asset.managedPath) ? resolve(asset.managedPath) : resolve(projectRoot, asset.managedPath);
  const relativePath = relative(projectRoot, path);
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw new DomainError("Dialogue Processing 只能读取当前项目受管的 Speech 文件", "DIALOGUE_PROCESSING_SOURCE_PATH_UNSAFE");
  }
  return path;
}

function payloadFrom(job: JobRecord): DialogueProcessingJobPayload {
  const payload = job.payload as Partial<DialogueProcessingJobPayload>;
  const issueTypes = Array.isArray(payload.issueTypes) ? payload.issueTypes : [];
  const requestedRevision = payload.requestedRevision;
  const speechAssetId = payload.speechAssetId?.trim();
  const sourceAssetId = payload.sourceAssetId?.trim();
  const scriptRevision = payload.scriptRevision;
  const sourceDurationMs = payload.sourceDurationMs;
  const evidenceNote = payload.evidenceNote?.trim();
  if (!isInteger(requestedRevision) || !speechAssetId || !sourceAssetId
    || !isInteger(scriptRevision) || !isInteger(sourceDurationMs) || sourceDurationMs <= 0
    || !evidenceNote || payload.processingVersion !== "v1" || issueTypes.length === 0
    || issueTypes.some((issue) => typeof issue !== "string" || !KNOWN_ISSUES.has(issue as DialogueProcessingIssue))) {
    throw new DomainError("Dialogue Processing Job 缺少受管的旁白来源、问题或审阅依据", "DIALOGUE_PROCESSING_JOB_PAYLOAD_INVALID");
  }
  return {
    requestedRevision,
    speechAssetId,
    sourceAssetId,
    scriptRevision,
    sourceDurationMs,
    issueTypes: [...new Set(issueTypes as DialogueProcessingIssue[])],
    evidenceNote,
    processingVersion: "v1"
  };
}

/** Worker 再次核对 Job 绑定事实，避免领取到过期任务后仍读写新旁白。 */
export function resolveDialogueProcessingContext(application: EditingApplication, job: JobRecord): DialogueProcessingContext {
  if (job.kind !== DIALOGUE_PROCESSING_JOB_KIND) {
    throw new DomainError("Dialogue Processing Worker 收到了错误的 Job 类型", "DIALOGUE_PROCESSING_JOB_KIND_INVALID");
  }
  const payload = payloadFrom(job);
  const state = application.readProject(job.projectId);
  if (state.revision.number !== payload.requestedRevision) {
    throw new DomainError("项目 Revision 已变化，不能继续处理旧 Dialogue", "STALE_DIALOGUE_PROCESSING_REQUEST");
  }
  const speechAsset = state.snapshot.speechAsset;
  if (!speechAsset || speechAsset.id !== payload.speechAssetId || speechAsset.assetId !== payload.sourceAssetId
    || speechAsset.scriptRevision !== payload.scriptRevision) {
    throw new DomainError("当前 SpeechAsset、原声文件或 Script 已变化，不能继续处理旧 Dialogue", "STALE_DIALOGUE_PROCESSING_SOURCE");
  }
  const source = assetById(state.snapshot, payload.sourceAssetId);
  if (source.kind !== "speech" || source.status !== "ready" || !source.metadata?.hasAudio || source.metadata.durationMs !== payload.sourceDurationMs) {
    throw new DomainError("当前 SpeechAsset 原声尚不可处理或时长已变化", "DIALOGUE_PROCESSING_SOURCE_NOT_READY");
  }
  const dialogueTrack = state.snapshot.timeline.tracks.find((track) => track.name === "Dialogue");
  const dialogueItems = state.snapshot.timeline.items.filter((item) => (
    item.trackId === dialogueTrack?.id && item.assetId === source.id && !item.disabled
  ));
  if (dialogueItems.length !== 1) {
    throw new DomainError("当前 SpeechAsset 必须以唯一 Item 写入 Dialogue 轨，才能生成可比较候选", "SPEECH_DIALOGUE_ITEM_MISSING");
  }
  return {
    snapshot: state.snapshot,
    source,
    payload,
    expectedFrames: dialogueItems[0]!.endFrame - dialogueItems[0]!.startFrame
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

/** Windows 上 FFmpeg 退出后句柄可能短暂未释放；对临时 WAV 做有限重试，避免残留被下次任务误用。 */
async function removeTemporaryFile(path: string): Promise<void> {
  await rm(path, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
}

async function availableFilters(): Promise<Set<string>> {
  availableFiltersPromise ??= runProcess("ffmpeg", ["-hide_banner", "-filters"], 60_000).then((output) => (
    // ffmpeg 的三位 flag 列允许空格（例如 " TS"、" .."），不能假定三位都是字母或点。
    new Set([...output.matchAll(/^\s*[.A-Z]{0,3}\s+([a-z0-9_]+)\s+A->A/gimu)].map((match) => match[1]!))
  ));
  return availableFiltersPromise;
}

/**
 * 不根据能量读数擅自判断“有齿音/噪声”。调用方先试听并显式指出问题，
 * 这里仅把已确认的问题映射为克制或较强的可审计滤镜组合。
 */
export function buildDialogueProcessingFilters(
  profile: (typeof PROFILES)[number],
  issueTypes: DialogueProcessingIssue[]
): string[] {
  const issues = new Set(issueTypes);
  const strong = profile === "strong";
  const filters: string[] = [];
  if (issues.has("low_frequency")) filters.push(`highpass=f=${strong ? 90 : 75}:p=2`);
  if (issues.has("noise")) filters.push(`afftdn=nr=${strong ? 14 : 6}:nf=${strong ? -38 : -32}:tn=1`);
  if (issues.has("sibilance")) filters.push(`deesser=i=${strong ? 0.34 : 0.14}:m=${strong ? 0.7 : 0.45}:f=0.5`);
  // 仅响度或峰值问题也必须能形成真正可比较的两档候选，不能给两份同一 WAV 换不同名称。
  if (issues.has("loudness")) filters.push(`loudnorm=I=-16:TP=-1.5:LRA=${strong ? 7 : 11}`);
  if (issues.has("true_peak")) filters.push(`alimiter=limit=${strong ? 0.841 : 0.891}`);
  if (filters.length === 0) throw new DomainError("Dialogue Processing 没有可执行的已确认声音问题", "DIALOGUE_PROCESSING_FILTERS_EMPTY");
  return filters;
}

function requiredFilterNames(issueTypes: DialogueProcessingIssue[]): string[] {
  const names = new Set<string>();
  if (issueTypes.includes("low_frequency")) names.add("highpass");
  if (issueTypes.includes("noise")) names.add("afftdn");
  if (issueTypes.includes("sibilance")) names.add("deesser");
  if (issueTypes.includes("loudness")) names.add("loudnorm");
  if (issueTypes.includes("true_peak")) names.add("alimiter");
  return [...names];
}

async function assertRequiredFiltersAvailable(issueTypes: DialogueProcessingIssue[]): Promise<void> {
  const available = await availableFilters();
  const missing = requiredFilterNames(issueTypes).filter((filter) => !available.has(filter));
  if (missing.length > 0) {
    throw new DomainError(`当前 FFmpeg 缺少已请求的 Dialogue Processing 滤镜：${missing.join(", ")}；系统不会静默跳过。`, "DIALOGUE_PROCESSING_FILTER_UNAVAILABLE");
  }
}

function outputRelativePath(job: JobRecord, profile: (typeof PROFILES)[number]): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(job.id)) throw new DomainError("Dialogue Processing Job ID 不可用于受管输出路径", "DIALOGUE_PROCESSING_JOB_ID_INVALID");
  return join("assets", "speech", "processed", job.id, `${profile}.wav`);
}

async function inspectExistingOutput(path: string, expectedFrames: number, fps: number, expectedDurationMs: number): Promise<Pick<CompletedDialogueProcessingVariant, "contentHash" | "durationMs" | "metadata"> | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0) return undefined;
    const metadata = await probeMedia(path);
    if (!metadata.hasAudio || metadata.audioCodec?.toLocaleLowerCase() !== "pcm_s16le" || metadata.durationMs <= 0
      || millisecondsToFrames(metadata.durationMs, fps) !== expectedFrames
      || Math.abs(metadata.durationMs - expectedDurationMs) > MAX_DURATION_DRIFT_MS) return undefined;
    return { contentHash: await sha256File(path), durationMs: metadata.durationMs, metadata };
  } catch {
    return undefined;
  }
}

async function renderVariant(input: {
  context: DialogueProcessingContext;
  job: JobRecord;
  profile: (typeof PROFILES)[number];
}): Promise<{ variant: CompletedDialogueProcessingVariant; createdPath?: string }> {
  const relativePath = outputRelativePath(input.job, input.profile).replace(/\\/gu, "/");
  const outputPath = join(input.context.snapshot.project.rootPath, relativePath);
  const existing = await inspectExistingOutput(outputPath, input.context.expectedFrames, input.context.snapshot.timeline.fps, input.context.payload.sourceDurationMs);
  const filters = buildDialogueProcessingFilters(input.profile, input.context.payload.issueTypes);
  if (existing) {
    return {
      variant: { profile: input.profile, path: outputPath, relativePath, filters, ...existing }
    };
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = outputPath.replace(/\.wav$/iu, ".partial.wav");
  await removeTemporaryFile(temporaryPath);
  try {
    await runProcess("ffmpeg", [
      "-hide_banner", "-nostdin", "-v", "error", "-y",
      "-i", managedPath(input.context.snapshot, input.context.source),
      "-map", "0:a:0", "-vn",
      "-af", filters.join(","),
      // PCM WAV avoids codec padding changing the Dialogue frame range after a simple processing pass.
      "-c:a", "pcm_s16le",
      temporaryPath
    ], 10 * 60_000);
    const inspected = await inspectExistingOutput(temporaryPath, input.context.expectedFrames, input.context.snapshot.timeline.fps, input.context.payload.sourceDurationMs);
    if (!inspected) {
      throw new DomainError("Dialogue Processing 输出没有可播放 PCM 音轨，或改变了当前 Dialogue 的帧时长", "DIALOGUE_PROCESSING_OUTPUT_INVALID");
    }
    await removeTemporaryFile(outputPath);
    await rename(temporaryPath, outputPath);
    return {
      variant: { profile: input.profile, path: outputPath, relativePath, filters, ...inspected },
      createdPath: outputPath
    };
  } catch (error) {
    await removeTemporaryFile(temporaryPath);
    throw error;
  }
}

/**
 * 对白处理是本地、可重试的 Worker：失败时保留原声，不写 Revision；
 * 成功后由 Application 仅登记候选，真正切换仍是独立的人工选择命令。
 */
export async function runDialogueProcessing(application: EditingApplication, job: JobRecord): Promise<Record<string, unknown>> {
  const persisted = application.trackJob(job.id).result;
  if (typeof persisted?.dialogueProcessingJobId === "string") return persisted;
  const completedState = application.readProject(job.projectId);
  const completedProcessing = completedState.snapshot.speechAsset?.dialogueProcessing;
  if (completedProcessing?.jobId === job.id) {
    /**
     * Project Revision 已先于 Job 回执提交时进程可能中断。此处只恢复同一 Job
     * 已登记的候选，令 Job Runtime 补写 succeeded，不会因 requestedRevision 变旧而误报失败。
     */
    return {
      dialogueProcessingJobId: job.id,
      speechAssetId: completedState.snapshot.speechAsset!.id,
      sourceAssetId: completedProcessing.sourceAssetId,
      variantAssetIds: Object.fromEntries(completedProcessing.variants.map((variant) => [variant.profile, variant.assetId])),
      revision: completedState.revision.number,
      duplicate: true
    };
  }
  const context = resolveDialogueProcessingContext(application, job);
  await assertRequiredFiltersAvailable(context.payload.issueTypes);
  const createdPaths: string[] = [];
  try {
    const outputs: CompletedDialogueProcessingVariant[] = [];
    for (const profile of PROFILES) {
      const rendered = await renderVariant({ context, job, profile });
      if (rendered.createdPath) createdPaths.push(rendered.createdPath);
      outputs.push(rendered.variant);
    }
    const completed = application.completeDialogueProcessing({ projectId: job.projectId, jobId: job.id, variants: outputs });
    return {
      dialogueProcessingJobId: job.id,
      speechAssetId: context.payload.speechAssetId,
      sourceAssetId: context.payload.sourceAssetId,
      variantAssetIds: Object.fromEntries(completed.processing.variants.map((variant) => [variant.profile, variant.assetId])),
      revision: completed.state.revision.number,
      duplicate: completed.duplicate
    };
  } catch (error) {
    // 只清理由本次调用新写出的文件；复用的已有输出可能属于一次已完成但回执丢失的任务。
    await Promise.all(createdPaths.map((path) => removeTemporaryFile(path)));
    throw error;
  }
}
