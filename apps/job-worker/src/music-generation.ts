import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { EditingApplication } from "@videocut/application";
import {
  BridgeRunLostError,
  ComfyUIBridgeClient,
  type BridgeOutput,
  type BridgeRun,
  type BridgeRunSubmission,
  type BridgeWorkflow,
  type BridgeWorkflowField
} from "@videocut/bridge";
import type { BridgeRunAudit, JobRecord, MediaMetadata, ProjectSnapshot } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { probeMedia } from "@videocut/speech";

/**
 * 音乐 Worker 与 Application 的窄交接面。Worker 只负责动态 Bridge、下载和媒体核验；
 * 资产、Revision、来源与 BGM 写入仍必须由 Application 原子完成。
 */
export type GeneratedMusicAudio = {
  path: string;
  relativePath: string;
  name: string;
  contentHash: string;
  sourceHash: string;
  durationMs: number;
  metadata: MediaMetadata;
};

export type MusicGenerationCompletionInput = {
  projectId: string;
  jobId: string;
  musicAudio: GeneratedMusicAudio;
  bridgeAudit: BridgeRunAudit;
};

type MusicCompletionApplication = EditingApplication & {
  completeMusicGeneration(input: MusicGenerationCompletionInput): unknown | Promise<unknown>;
};

export type MusicGenerationContext = {
  snapshot: ProjectSnapshot;
  workflowId: string;
  prompt: string;
  durationSeconds: number;
  outputSlotId?: string;
};

const MUSIC_JOB_KIND = "music_generation";
const musicDirectory = (snapshot: ProjectSnapshot) => join(snapshot.project.rootPath, "assets", "music");
const safeFileName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

function requiredPayloadText(payload: Record<string, unknown>, key: string, message: string, code: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new DomainError(message, code);
  return value.trim();
}

function requiredPositiveInteger(payload: Record<string, unknown>, key: string, message: string, code: string): number {
  const value = Number(payload[key]);
  if (!Number.isInteger(value) || value < 1) throw new DomainError(message, code);
  return value;
}

function requiredRevision(payload: Record<string, unknown>): number {
  const revision = Number(payload.requestedRevision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new DomainError("音乐生成任务缺少受管的请求 Revision", "MUSIC_JOB_PAYLOAD_INVALID");
  }
  return revision;
}

/**
 * 不允许一次请求无限长的付费音乐。上限只限制单次 Provider 调用，不限制 BGM 在 Timeline 中循环或裁切。
 */
function boundedMusicDuration(payload: Record<string, unknown>): number {
  const duration = requiredPositiveInteger(payload, "durationSeconds", "音乐生成时长必须是正整数秒", "INVALID_MUSIC_DURATION");
  if (duration > 1_800) {
    throw new DomainError("单次音乐生成时长不能超过 1800 秒；请按章节生成并在 Timeline 中人工复听拼接", "MUSIC_DURATION_EXCEEDS_LIMIT");
  }
  return duration;
}

/** 只接受与当前 Revision 绑定的请求，防止主线变化后继续消耗远端配额。 */
export function resolveMusicGenerationContext(application: EditingApplication, job: JobRecord): MusicGenerationContext {
  const state = application.readProject(job.projectId);
  const requestedRevision = requiredRevision(job.payload);
  if (requestedRevision !== state.revision.number) {
    throw new DomainError("项目 Revision 已变化，不能继续向音乐 Provider 提交旧请求", "STALE_MUSIC_REQUEST");
  }
  const outputSlotId = typeof job.payload.outputSlotId === "string" && job.payload.outputSlotId.trim()
    ? job.payload.outputSlotId.trim()
    : undefined;
  return {
    snapshot: state.snapshot,
    workflowId: requiredPayloadText(job.payload, "workflowId", "音乐生成任务缺少经确认的 Bridge workflowId", "MUSIC_WORKFLOW_ID_REQUIRED"),
    prompt: requiredPayloadText(job.payload, "prompt", "音乐生成任务缺少明确的音乐提示词", "MUSIC_PROMPT_REQUIRED"),
    durationSeconds: boundedMusicDuration(job.payload),
    outputSlotId
  };
}

function normalizedFieldLabel(field: BridgeWorkflowField): string {
  return `${field.label} ${field.kind}`.trim().toLocaleLowerCase();
}

function isNegativePromptField(field: BridgeWorkflowField): boolean {
  return /(?:negative|neg_prompt|exclude|forbid|反向|负面|排除|不要)/u.test(normalizedFieldLabel(field));
}

/**
 * Bridge 的字段 ID 不可写死。为避免把时长写到“最大时长”或把提示词写到负提示词，
 * 只接受唯一的、优先级最高的语义匹配；平级歧义必须让调用方确认 Schema 后重试。
 */
function chooseUniqueField(
  workflow: BridgeWorkflow,
  score: (field: BridgeWorkflowField) => number,
  missingMessage: string,
  missingCode: string,
  ambiguousMessage: string,
  ambiguousCode: string
): BridgeWorkflowField {
  const ranked = workflow.fields
    .map((field) => ({ field, score: score(field) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.field.id.localeCompare(right.field.id));
  if (ranked.length === 0) throw new DomainError(missingMessage, missingCode);
  const top = ranked[0]!;
  if (ranked.filter((entry) => entry.score === top.score).length !== 1) {
    throw new DomainError(ambiguousMessage, ambiguousCode);
  }
  return top.field;
}

function promptFieldScore(field: BridgeWorkflowField): number {
  if (isNegativePromptField(field)) return 0;
  const label = normalizedFieldLabel(field);
  if (/^(?:prompt|提示词)(?:\s|$)/u.test(label)) return 100;
  if (/(?:music|audio|音乐|配乐).*(?:prompt|描述|description|提示词)/u.test(label)) return 95;
  if (/(?:prompt|提示词)/u.test(label)) return 90;
  if (/(?:description|描述|brief|风格|style)/u.test(label)) return 70;
  return 0;
}

function durationFieldScore(field: BridgeWorkflowField): number {
  const label = normalizedFieldLabel(field);
  if (/(?:max|min|minimum|maximum|最大|最小|范围|range)/u.test(label)) return 0;
  if (/^(?:duration|length|时长|长度)(?:\s|$)/u.test(label)) return 100;
  if (/(?:duration|length|seconds?|时长|秒数|长度)/u.test(label)) return 80;
  return 0;
}

function durationFromOption(value: string): number | undefined {
  const matched = value.trim().toLocaleLowerCase().match(/^(\d+(?:\.0+)?)\s*(?:s|sec|secs|second|seconds|秒)?$/u);
  if (!matched) return undefined;
  const parsed = Number(matched[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Select 类型的 Duration 必须正好存在目标秒数；不能偷偷选“最接近”的选项，
 * 否则 Project 会记录 30 秒、实际却花费并生成 60 秒音乐。
 */
function durationValueForField(field: BridgeWorkflowField, durationSeconds: number): unknown {
  if (!field.options?.length) return durationSeconds;
  const matching = field.options.filter((option) => (
    durationFromOption(option.value) === durationSeconds || durationFromOption(option.label) === durationSeconds
  ));
  if (matching.length !== 1) {
    throw new DomainError(
      `Bridge 当前音乐工作流不提供精确的 ${durationSeconds} 秒选项`,
      "MUSIC_DURATION_UNSUPPORTED_BY_WORKFLOW"
    );
  }
  return matching[0]!.value;
}

export function buildMusicBridgeRequest(context: MusicGenerationContext, workflow: BridgeWorkflow): {
  fieldValues: Record<string, unknown>;
} {
  if (context.outputSlotId && !workflow.outputs.some((output) => output.id === context.outputSlotId)) {
    throw new DomainError("指定的音乐输出槽不在当前 Bridge Schema 中", "MUSIC_OUTPUT_SLOT_NOT_FOUND");
  }
  const promptField = chooseUniqueField(
    workflow,
    promptFieldScore,
    "Bridge 当前音乐工作流没有可确认的正向提示词字段",
    "MUSIC_PROMPT_FIELD_MISSING",
    "Bridge 当前音乐工作流存在多个同优先级提示词字段；请明确调整 Provider Schema",
    "MUSIC_PROMPT_FIELD_AMBIGUOUS"
  );
  const durationField = chooseUniqueField(
    workflow,
    durationFieldScore,
    "Bridge 当前音乐工作流没有可确认的时长字段",
    "MUSIC_DURATION_FIELD_MISSING",
    "Bridge 当前音乐工作流存在多个同优先级时长字段；请明确调整 Provider Schema",
    "MUSIC_DURATION_FIELD_AMBIGUOUS"
  );
  return {
    fieldValues: {
      [promptField.id]: context.prompt,
      [durationField.id]: durationValueForField(durationField, context.durationSeconds)
    }
  };
}

function responseSummary(run: BridgeRun): BridgeRunAudit["response"] {
  return {
    status: run.status,
    error: run.error,
    outputs: run.outputs.map((output) => ({
      outputSlotId: output.outputSlotId,
      displayName: output.displayName,
      kind: output.kind,
      fileName: output.fileName,
      mime: output.mime,
      outputId: output.outputId,
      downloadUrl: output.downloadUrl,
      text: output.text
    }))
  };
}

function createBridgeAudit(submission: BridgeRunSubmission, completed?: BridgeRun, submittedAt = new Date().toISOString()): BridgeRunAudit {
  return {
    workflowId: submission.workflow.id,
    runId: submission.run.id,
    schemaVersion: submission.workflow.schemaVersion,
    schemaRetryCount: submission.schemaRetryCount,
    submittedAt,
    completedAt: completed ? new Date().toISOString() : undefined,
    request: {
      fieldValues: submission.request.fieldValues,
      fileSlots: []
    },
    response: completed ? responseSummary(completed) : undefined
  };
}

function isBridgeAudit(value: unknown): value is BridgeRunAudit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.workflowId === "string" && typeof record.runId === "string" && typeof record.schemaVersion === "string"
    && typeof record.submittedAt === "string" && Boolean(record.request) && typeof record.request === "object";
}

function latestBridgeAudit(job: JobRecord, workflowId: string): BridgeRunAudit | undefined {
  const entries = Array.isArray(job.result?.bridgeRuns) ? job.result?.bridgeRuns : [];
  return [...entries].reverse().find((entry): entry is BridgeRunAudit => isBridgeAudit(entry) && entry.workflowId === workflowId);
}

function completedAudit(previous: BridgeRunAudit, completed: BridgeRun): BridgeRunAudit {
  return { ...previous, completedAt: new Date().toISOString(), response: responseSummary(completed) };
}

function normalizedOutputMime(mime: string | undefined): string | undefined {
  const normalized = mime?.split(";", 1)[0]?.trim().toLocaleLowerCase();
  return normalized || undefined;
}

function isAudioOutput(output: BridgeOutput): boolean {
  const mime = normalizedOutputMime(output.mime);
  return output.kind === "audio" || Boolean(mime?.startsWith("audio/"));
}

/** 多个可下载音频时必须让提交侧固定 outputSlotId，防止误把试听片段或 stem 当成最终 BGM。 */
export function selectMusicOutput(run: BridgeRun, outputSlotId?: string): BridgeOutput {
  const available = run.outputs.filter((output) => isAudioOutput(output) && Boolean(output.downloadUrl));
  if (outputSlotId) {
    const selected = available.find((output) => output.outputSlotId === outputSlotId);
    if (!selected) throw new DomainError("Bridge 已完成，但指定的音乐输出槽没有可下载音频", "MUSIC_OUTPUT_SLOT_MISSING");
    return selected;
  }
  if (available.length === 0) throw new DomainError("Bridge 已完成，但没有可下载的音频输出", "MISSING_MUSIC_OUTPUT");
  if (available.length > 1) {
    throw new DomainError("Bridge 返回多个音频输出；提交音乐任务时必须指定 outputSlotId", "MUSIC_OUTPUT_AMBIGUOUS");
  }
  return available[0]!;
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once("error", rejectHash);
    stream.once("end", () => resolveHash(hash.digest("hex")));
  });
}

const PLAYABLE_AUDIO_CODECS = new Set([
  "aac", "mp3", "opus", "vorbis", "flac", "alac",
  "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le"
]);

/**
 * 远端只要返回“成功”不代表可用于编辑。这里拒绝 HTML 错误页、无声文件和当前 Player/Render
 * 未承诺的音频编码；不做隐式转码，以免改变音乐长度或隐藏 Provider 输出问题。
 */
export async function inspectGeneratedMusicFile(path: string, outputMime?: string): Promise<Pick<GeneratedMusicAudio, "contentHash" | "sourceHash" | "durationMs" | "metadata">> {
  const mime = normalizedOutputMime(outputMime);
  if (mime && !mime.startsWith("audio/")) {
    throw new DomainError(`音乐输出 MIME 必须为 audio/*，当前为：${outputMime}`, "MUSIC_OUTPUT_MIME_UNSUPPORTED");
  }
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new DomainError("音乐输出为空或不是文件", "MUSIC_OUTPUT_EMPTY");
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(Math.min(512, info.size));
    await handle.read(header, 0, header.length, 0);
    const leadingText = header.toString("utf8").trimStart().toLocaleLowerCase();
    if (/^(?:<!doctype\s+html|<html(?:\s|>)|<\?xml)/u.test(leadingText)) {
      throw new DomainError("音乐下载结果是网页错误页，不是音频", "MUSIC_OUTPUT_HTML");
    }
  } finally {
    await handle.close();
  }
  const metadata = await probeMedia(path);
  if (!metadata.hasAudio || metadata.durationMs <= 0) {
    throw new DomainError("音乐输出没有可读取的有效音轨", "MUSIC_OUTPUT_AUDIO_STREAM_MISSING");
  }
  const codec = metadata.audioCodec?.toLocaleLowerCase();
  if (!codec || !PLAYABLE_AUDIO_CODECS.has(codec)) {
    throw new DomainError(`音乐输出编码 ${metadata.audioCodec ?? "未知"} 不在当前 Player/Render 支持范围内`, "MUSIC_OUTPUT_CODEC_UNSUPPORTED");
  }
  const contentHash = await hashFile(path);
  return { contentHash, sourceHash: contentHash, durationMs: metadata.durationMs, metadata };
}

function isExtensionCompatibleWithAudio(extension: string, metadata: MediaMetadata): boolean {
  const codec = metadata.audioCodec?.toLocaleLowerCase();
  if (extension === ".mp3") return codec === "mp3";
  if (extension === ".wav") return Boolean(codec?.startsWith("pcm_"));
  if (extension === ".m4a") return codec === "aac" || codec === "alac";
  if (extension === ".ogg") return codec === "opus" || codec === "vorbis";
  if (extension === ".opus") return codec === "opus";
  if (extension === ".flac") return codec === "flac";
  if (extension === ".aac") return codec === "aac";
  return false;
}

function extensionForMusic(output: BridgeOutput, metadata: MediaMetadata): string {
  const provided = extname(output.fileName ?? "").toLocaleLowerCase();
  // Provider 的文件名有时会沿用错误后缀；先以 ffprobe 的真实音频编码确认它和容器相容。
  if (isExtensionCompatibleWithAudio(provided, metadata)) return provided;
  const mime = normalizedOutputMime(output.mime);
  if (mime === "audio/mpeg") return ".mp3";
  if (["audio/wav", "audio/x-wav"].includes(mime ?? "")) return ".wav";
  if (["audio/mp4", "audio/x-m4a"].includes(mime ?? "")) return ".m4a";
  if (mime === "audio/ogg") return ".ogg";
  if (mime === "audio/opus") return ".opus";
  if (mime === "audio/flac") return ".flac";
  const codec = metadata.audioCodec?.toLocaleLowerCase();
  if (codec === "mp3") return ".mp3";
  if (codec?.startsWith("pcm_")) return ".wav";
  if (codec === "aac" || codec === "alac") return ".m4a";
  if (codec === "opus") return ".opus";
  if (codec === "vorbis") return ".ogg";
  if (codec === "flac") return ".flac";
  return ".audio";
}

function musicRelativePath(job: JobRecord, output: BridgeOutput, metadata: MediaMetadata): string {
  const original = basename(output.fileName ?? "music");
  const extension = extensionForMusic(output, metadata);
  const stem = safeFileName(basename(original, extname(original))) || "music";
  return join("assets", "music", `music-${job.id}-${stem}${extension}`);
}

async function inspectExistingMusic(snapshot: ProjectSnapshot, relativePath: string): Promise<GeneratedMusicAudio | undefined> {
  const path = join(snapshot.project.rootPath, relativePath);
  try {
    const inspected = await inspectGeneratedMusicFile(path);
    return { path, relativePath, name: basename(path), ...inspected };
  } catch {
    return undefined;
  }
}

/** 下载先写入 .partial，所有格式和解码校验通过后再原子替换目标文件。 */
export async function localizeGeneratedMusic(
  bridge: ComfyUIBridgeClient,
  snapshot: ProjectSnapshot,
  job: JobRecord,
  output: BridgeOutput
): Promise<GeneratedMusicAudio> {
  const probePath = join(snapshot.project.rootPath, "cache", "music-generation", `${job.id}-probe`);
  await mkdir(dirname(probePath), { recursive: true });
  const partialPath = `${probePath}.partial`;
  await rm(partialPath, { force: true }).catch(() => undefined);
  try {
    // 先用临时文件测出真实音频编码与合适扩展名，避免 Provider 文件名把 M4A 写成 MP3。
    await bridge.downloadOutput(output, partialPath);
    const inspected = await inspectGeneratedMusicFile(partialPath, output.mime);
    const relativePath = musicRelativePath(job, output, inspected.metadata);
    const targetPath = join(snapshot.project.rootPath, relativePath);
    const existing = await inspectExistingMusic(snapshot, relativePath);
    if (existing) {
      await rm(partialPath, { force: true }).catch(() => undefined);
      return existing;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await rename(partialPath, targetPath);
    return { path: targetPath, relativePath, name: basename(targetPath), ...inspected };
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Bridge run 丢失时，只有 Job 专属目录里已通过本地解码校验的文件才允许恢复。 */
async function findRecoveredMusic(snapshot: ProjectSnapshot, job: JobRecord): Promise<GeneratedMusicAudio | undefined> {
  const directory = musicDirectory(snapshot);
  const prefix = `music-${job.id}-`;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || entry.name.endsWith(".partial")) continue;
    const relativePath = join("assets", "music", entry.name);
    const inspected = await inspectExistingMusic(snapshot, relativePath);
    if (inspected) return inspected;
  }
  return undefined;
}

async function completeMusicGeneration(application: EditingApplication, input: MusicGenerationCompletionInput): Promise<unknown> {
  const candidate = application as MusicCompletionApplication;
  if (typeof candidate.completeMusicGeneration !== "function") {
    throw new DomainError("当前 EditingApplication 尚未实现音乐生成结果写入", "MUSIC_COMPLETION_NOT_IMPLEMENTED");
  }
  return candidate.completeMusicGeneration(input);
}

function completedMusicResult(application: EditingApplication, job: JobRecord): Record<string, unknown> {
  const result = application.trackJob(job.id).result;
  const musicAssetId = result?.musicAssetId;
  const revision = result?.revision;
  if (typeof musicAssetId !== "string" || !Number.isInteger(revision)) {
    throw new DomainError("音乐结果已写入项目，但 Job 缺少可追溯的完成对象", "MUSIC_COMPLETION_RESULT_MISSING");
  }
  return { musicAssetId, revision };
}

/**
 * 真实音乐生成链：调用前动态读取 Schema，先持久化 run 审计，再等待、下载、ffprobe、哈希，
 * 最后交由 Application 写入受管 Asset。当前没有经确认 workflowId 时，这个函数会明确失败，
 * 不会伪造远端音乐已经生成。
 */
export async function runMusicGeneration(
  application: EditingApplication,
  job: JobRecord,
  bridge: ComfyUIBridgeClient
): Promise<Record<string, unknown>> {
  if (job.kind !== MUSIC_JOB_KIND) {
    throw new DomainError("音乐 Worker 收到了错误的任务类型", "INVALID_MUSIC_JOB");
  }
  const context = resolveMusicGenerationContext(application, job);
  const previousAudit = latestBridgeAudit(job, context.workflowId);

  if (previousAudit) {
    try {
      const completed = await bridge.waitForRun(previousAudit.runId);
      const audit = completedAudit(previousAudit, completed);
      await application.recordBridgeRun(job.id, audit);
      const musicAudio = await localizeGeneratedMusic(bridge, context.snapshot, job, selectMusicOutput(completed, context.outputSlotId));
      await completeMusicGeneration(application, { projectId: job.projectId, jobId: job.id, musicAudio, bridgeAudit: audit });
      return { jobId: job.id, runId: completed.id, musicAudio, ...completedMusicResult(application, job), recoveredExistingRun: true };
    } catch (error) {
      if (!(error instanceof BridgeRunLostError)) throw error;
      const musicAudio = await findRecoveredMusic(context.snapshot, job);
      if (musicAudio) {
        // 远端状态不可查，但文件已经经本地解码和哈希验证；保留未完成的原审计而不伪造远端完成时间。
        await completeMusicGeneration(application, { projectId: job.projectId, jobId: job.id, musicAudio, bridgeAudit: previousAudit });
        return { jobId: job.id, runId: previousAudit.runId, musicAudio, ...completedMusicResult(application, job), recoveredLocalOutput: true };
      }
      // 音乐生成可能消耗额度。远端 Run 丢失且本地无产物时不能自动重提，必须由用户确认新请求。
      throw new DomainError(
        `音乐 Provider 的 Run ${previousAudit.runId} 已不可查询，且没有可恢复的本地音频；请确认是否重新生成。`,
        "MUSIC_RUN_LOST_REQUIRES_RECONFIRMATION"
      );
    }
  }

  const submittedAt = new Date().toISOString();
  const submission = await bridge.createRunWithSchemaRetry(
    context.workflowId,
    async (workflow) => buildMusicBridgeRequest(context, workflow)
  );
  await application.recordBridgeRun(job.id, createBridgeAudit(submission, undefined, submittedAt));
  const completed = await bridge.waitForRun(submission.run.id);
  const audit = createBridgeAudit(submission, completed, submittedAt);
  await application.recordBridgeRun(job.id, audit);
  const musicAudio = await localizeGeneratedMusic(bridge, context.snapshot, job, selectMusicOutput(completed, context.outputSlotId));
  await completeMusicGeneration(application, { projectId: job.projectId, jobId: job.id, musicAudio, bridgeAudit: audit });
  return { jobId: job.id, runId: completed.id, musicAudio, ...completedMusicResult(application, job) };
}
