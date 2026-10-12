import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import type { Asset, BridgeRunAudit, JobRecord, MediaMetadata, ProjectSnapshot, SourceAudioAlignment, SpeechAsset, SpeechSegmentAsset, SpeechTiming } from "@videocut/contracts";
import { BridgeError, BridgeRunLostError, FUNASR_SOURCE_CAPTION_WORKFLOW_ID, FUNASR_WORKFLOW_ID, OMNIVOICE_WORKFLOW_ID, ComfyUIBridgeClient, type BridgeRun, type BridgeRunSubmission, type BridgeWorkflow } from "@videocut/bridge";
import { assetById, createId, createMediaAsset, DomainError, millisecondsToFrames, now, sourceAudioAlignmentOwnerMatches } from "@videocut/domain";
import { EditingApplication } from "@videocut/application";

export class MediaProcessError extends Error {
  constructor(message: string, public readonly output: string,
    public readonly details?: { exitCode?: number | null; systemCode?: string; timedOut?: boolean }) {
    super(message);
  }
}

export async function runProcess(command: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new MediaProcessError(`${command} 执行超时`, output, { timedOut: true }));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new MediaProcessError(`无法启动 ${command}：${error.message}`, output, { systemCode: (error as NodeJS.ErrnoException).code }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new MediaProcessError(`${command} 失败，退出码 ${code}`, output, { exitCode: code }));
    });
  });
}

const safeOutputName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");
const assetPath = (snapshot: ProjectSnapshot, asset: Asset) => isAbsolute(asset.managedPath) ? asset.managedPath : join(snapshot.project.rootPath, asset.managedPath);

export type BridgeRunReporter = (audit: BridgeRunAudit) => void | Promise<void>;

/**
 * 只记录请求字段、文件槽位和 Bridge 响应子集；媒体二进制仍保存在受管 Asset 中。
 * 这份审计会先写入本地 Job，随后在成功时一并落入 Transcript / SpeechSegmentAsset。
 */
function createBridgeRunAudit(
  submission: BridgeRunSubmission,
  completed?: BridgeRun,
  submittedAt = now(),
  metadata?: Record<string, string | number | boolean>
): BridgeRunAudit {
  return {
    workflowId: submission.workflow.id,
    runId: submission.run.id,
    schemaVersion: submission.workflow.schemaVersion,
    schemaRetryCount: submission.schemaRetryCount,
    submittedAt,
    completedAt: completed ? now() : undefined,
    request: {
      fieldValues: submission.request.fieldValues,
      fileSlots: submission.request.files?.map((file) => ({
        id: file.slot.id,
        kind: file.slot.kind,
        fileName: basename(file.path)
      })) ?? [],
      metadata
    },
    response: completed ? {
      status: completed.status,
      error: completed.error,
      outputs: completed.outputs.map((output) => ({
        outputSlotId: output.outputSlotId,
        displayName: output.displayName,
        kind: output.kind,
        fileName: output.fileName,
        mime: output.mime,
        outputId: output.outputId,
        downloadUrl: output.downloadUrl,
        text: output.text
      }))
    } : undefined
  };
}

function completeBridgeRunAudit(previous: BridgeRunAudit, completed: BridgeRun): BridgeRunAudit {
  return {
    ...previous,
    completedAt: now(),
    response: {
      status: completed.status,
      error: completed.error,
      outputs: completed.outputs.map((output) => ({
        outputSlotId: output.outputSlotId,
        displayName: output.displayName,
        kind: output.kind,
        fileName: output.fileName,
        mime: output.mime,
        outputId: output.outputId,
        downloadUrl: output.downloadUrl,
        text: output.text
      }))
    }
  };
}

/**
 * 只接受 ffmpeg 明确标为带 Alpha 的常见像素格式；不把普通 PNG、pal8 或文件扩展名
 * 误判为透明人物 Mask。遇到未知格式时保守返回 false，由后续人工/Provider 能力链路降级。
 */
function hasVerifiedAlphaPixelFormat(pixelFormat: string | undefined): boolean {
  const normalized = pixelFormat?.trim().toLowerCase();
  return Boolean(normalized && /^(?:rgba|argb|bgra|abgr|yuva|gbrap|ya\d|ayuv)/u.test(normalized));
}

export async function probeMedia(filePath: string): Promise<MediaMetadata> {
  const output = await runProcess("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:format=format_name:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    filePath
  ], 60_000);
  const data = JSON.parse(output) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }>;
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const [numerator, denominator] = video?.r_frame_rate?.split("/").map(Number) ?? [];
  const fps = numerator && denominator ? numerator / denominator : undefined;
  return {
    durationMs: Math.round(Number(data.format?.duration ?? 0) * 1000),
    width: video?.width,
    height: video?.height,
    fps,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: audio?.channels,
    videoCodec: video?.codec_name,
    pixelFormat: video?.pix_fmt,
    hasAlpha: hasVerifiedAlphaPixelFormat(video?.pix_fmt),
    mime: data.format?.format_name
  };
}

export async function extractAudioForTranscription(snapshot: ProjectSnapshot, asset: Asset): Promise<string> {
  const sourcePath = assetPath(snapshot, asset);
  const targetPath = join(snapshot.project.rootPath, "cache", `transcription-${asset.id}.wav`);
  await mkdir(join(snapshot.project.rootPath, "cache"), { recursive: true });
  await runProcess("ffmpeg", ["-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", targetPath], 5 * 60_000);
  return targetPath;
}

/** FunASR 输出只落为完整文本，绝不在这里估算词级时间。 */
export class FunASRService {
  constructor(private readonly application: EditingApplication, private readonly bridge: ComfyUIBridgeClient) {}

  private existingTranscript(projectId: string, assetId: string, runId: string) {
    return this.application.readProject(projectId).snapshot.transcripts.find((transcript) => (
      transcript.assetId === assetId && transcript.source === "funasr" && transcript.bridgeRunId === runId
    ));
  }

  private async applyCompletedRun(
    projectId: string,
    assetId: string,
    completed: BridgeRun,
    audit: BridgeRunAudit,
    onBridgeRun?: BridgeRunReporter
  ): Promise<{ runId: string; textLength: number }> {
    const existing = this.existingTranscript(projectId, assetId, completed.id);
    if (existing) {
      await onBridgeRun?.(existing.bridgeAudit ?? audit);
      return { runId: completed.id, textLength: existing.text.length };
    }
    const output = completed.outputs.find((candidate) => candidate.kind === "text" && typeof candidate.text === "string");
    if (!output?.text?.trim()) throw new DomainError("FunASR 已完成，但没有返回文本输出", "MISSING_TRANSCRIPT_OUTPUT");
    const completedAudit = completeBridgeRunAudit(audit, completed);
    this.application.applyTranscript({
      projectId,
      assetId,
      text: output.text,
      bridgeRunId: completed.id,
      schemaVersion: audit.schemaVersion,
      bridgeAudit: completedAudit
    });
    // 先写入幂等的 Transcript 回执，再补 Job 审计；两步之间崩溃时可按 bridgeRunId 安全恢复。
    await onBridgeRun?.(completedAudit);
    return { runId: completed.id, textLength: output.text.length };
  }

  async transcribe(projectId: string, assetId: string, onBridgeRun?: BridgeRunReporter): Promise<{ runId: string; textLength: number }> {
    const state = this.application.readProject(projectId);
    const asset = assetById(state.snapshot, assetId);
    if (!asset.metadata?.hasAudio) throw new DomainError("素材没有音频，不能提交转写", "NO_AUDIO");
    const audioPath = await extractAudioForTranscription(state.snapshot, asset);
    const submission = await this.bridge.createRunWithSchemaRetry(FUNASR_WORKFLOW_ID, async (detail) => ({
      fieldValues: {},
      files: [{ slot: this.bridge.findRequiredSlot(detail, "audio"), path: audioPath, mime: "audio/wav" }]
    }));
    const submittedAt = now();
    const audit = createBridgeRunAudit(submission, undefined, submittedAt);
    await onBridgeRun?.(audit);
    const completed = await this.bridge.waitForRun(submission.run.id);
    return this.applyCompletedRun(projectId, assetId, completed, audit, onBridgeRun);
  }

  /**
   * 超时或 Worker 重启后只等待已持久化的 run_id。Run 丢失必须显式失败，
   * 绝不能把“查询不到”解释成“从未提交”并自动创建第二次转写。
   */
  async resumeTranscription(
    projectId: string,
    assetId: string,
    audit: BridgeRunAudit,
    onBridgeRun?: BridgeRunReporter
  ): Promise<{ runId: string; textLength: number }> {
    if (audit.workflowId !== FUNASR_WORKFLOW_ID || !audit.runId) {
      throw new DomainError("转写任务的 Bridge 审计与当前 FunASR 工作流不匹配", "TRANSCRIPTION_BRIDGE_AUDIT_INVALID");
    }
    // 将来源 Job 的恢复依据复制到当前 Job，保证再次中断后仍从同一个 run_id 继续。
    await onBridgeRun?.(audit);
    const existing = this.existingTranscript(projectId, assetId, audit.runId);
    if (existing) {
      await onBridgeRun?.(existing.bridgeAudit ?? audit);
      return { runId: audit.runId, textLength: existing.text.length };
    }
    let completed: BridgeRun;
    try {
      completed = await this.bridge.waitForRun(audit.runId);
    } catch (error) {
      if (!(error instanceof BridgeRunLostError)) throw error;
      throw new DomainError(
        `FunASR Run ${audit.runId} 已不可查询，无法确认原转写结果；系统未自动创建新 Run，请确认后重新提交转写。`,
        "TRANSCRIPTION_RUN_LOST_REQUIRES_RESUBMISSION"
      );
    }
    return this.applyCompletedRun(projectId, assetId, completed, audit, onBridgeRun);
  }
}

/**
 * 原声字幕只能按检测到的静音边界分块：不根据字符数或均分时长伪造字幕时间。
 * 这个阈值是字幕可读性的上限，不是对讲话内容的切分判断；连续讲话超限会明确报障。
 */
const SOURCE_CAPTION_SILENCE_NOISE_DB = -42;
const SOURCE_CAPTION_SILENCE_SECONDS = 0.28;
const SOURCE_CAPTION_MIN_CHUNK_SECONDS = 0.18;
const SOURCE_CAPTION_MAX_CHUNK_SECONDS = 12;
const SOURCE_CAPTION_MAX_CHUNKS = 160;

type SourceCaptionJobPayload = {
  speechSource?: SourceAudioAlignment["speechSource"];
  requestedRevision: number;
  assetId: string;
  timelineItemId: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  timelineStartFrame: number;
  timelineEndFrame: number;
};

type SourceCaptionChunkPlan = {
  index: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
};

type SourceCaptionPlan = SourceCaptionJobPayload & {
  version: 1;
  chunks: SourceCaptionChunkPlan[];
};

type SourceCaptionSubmissionIntent = SourceCaptionChunkPlan & {
  kind: "source_caption_chunk";
  createdAt: string;
};

type SourceCaptionResult = {
  chunk: SourceCaptionChunkPlan;
  bridgeRunId: string;
  text: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function sourceCaptionPayloadFromJob(
  job: JobRecord,
  expectedKind: "source_caption_generation" | "source_caption_sentence_alignment" | "source_caption_alignment" = "source_caption_generation"
): SourceCaptionJobPayload {
  const payload = job.payload;
  const fields = [
    "requestedRevision", "sourceStartFrame", "sourceEndFrame", "timelineStartFrame", "timelineEndFrame"
  ] as const;
  if (job.kind !== expectedKind || typeof payload.assetId !== "string" || !payload.assetId.trim()
    || typeof payload.timelineItemId !== "string" || !payload.timelineItemId.trim()
    || fields.some((field) => !integer(payload[field]))) {
    throw new DomainError("原声字幕 Job 缺少完整且可恢复的来源定位", "SOURCE_CAPTION_JOB_PAYLOAD_INVALID");
  }
  const parsed: SourceCaptionJobPayload = {
    requestedRevision: payload.requestedRevision as number,
    assetId: payload.assetId,
    timelineItemId: payload.timelineItemId,
    sourceStartFrame: payload.sourceStartFrame as number,
    sourceEndFrame: payload.sourceEndFrame as number,
    timelineStartFrame: payload.timelineStartFrame as number,
    timelineEndFrame: payload.timelineEndFrame as number
  };
  if (payload.speechSource !== undefined) {
    const source = payload.speechSource;
    if (!isRecord(source) || typeof source.speechAssetId !== "string" || !source.speechAssetId.trim()
      || !integer(source.scriptRevision) || source.scriptRevision < 1 || typeof source.scriptText !== "string" || !source.scriptText.trim()) {
      throw new DomainError("旁白字幕 Job 缺少已固定的 SpeechAsset 与 Script 来源", "SOURCE_CAPTION_JOB_PAYLOAD_INVALID");
    }
    parsed.speechSource = { speechAssetId: source.speechAssetId, scriptRevision: source.scriptRevision, scriptText: source.scriptText };
  }
  if (parsed.requestedRevision < 1 || parsed.sourceStartFrame < 0 || parsed.timelineStartFrame < 0
    || parsed.sourceEndFrame <= parsed.sourceStartFrame || parsed.timelineEndFrame <= parsed.timelineStartFrame
    || parsed.sourceEndFrame - parsed.sourceStartFrame !== parsed.timelineEndFrame - parsed.timelineStartFrame) {
    throw new DomainError("原声字幕 Job 的源范围或一比一时间映射无效", "SOURCE_CAPTION_JOB_PAYLOAD_INVALID");
  }
  return parsed;
}

function sourceCaptionPlanFromResult(value: unknown): SourceCaptionPlan | undefined {
  if (!isRecord(value)) return undefined;
  const plan = value.sourceCaptionPlan;
  if (plan === undefined) return undefined;
  if (!isRecord(plan) || plan.version !== 1 || typeof plan.assetId !== "string" || typeof plan.timelineItemId !== "string"
    || !integer(plan.requestedRevision) || !integer(plan.sourceStartFrame) || !integer(plan.sourceEndFrame)
    || !integer(plan.timelineStartFrame) || !integer(plan.timelineEndFrame) || !Array.isArray(plan.chunks)) {
    throw new DomainError("原声字幕 Job 的持久化分块计划已损坏，不能安全恢复", "SOURCE_CAPTION_PLAN_INVALID");
  }
  const planSourceStartFrame = plan.sourceStartFrame as number;
  const planSourceEndFrame = plan.sourceEndFrame as number;
  let previousEnd = planSourceStartFrame;
  const chunks = plan.chunks.map((candidate, index): SourceCaptionChunkPlan => {
    if (!isRecord(candidate) || !integer(candidate.index) || !integer(candidate.sourceStartFrame) || !integer(candidate.sourceEndFrame)
      || candidate.index !== index || candidate.sourceStartFrame < planSourceStartFrame || candidate.sourceEndFrame <= candidate.sourceStartFrame
      || candidate.sourceEndFrame > planSourceEndFrame || candidate.sourceStartFrame < previousEnd) {
      throw new DomainError("原声字幕 Job 的持久化分块范围已损坏，不能安全恢复", "SOURCE_CAPTION_PLAN_INVALID");
    }
    previousEnd = candidate.sourceEndFrame;
    return {
      index: candidate.index,
      sourceStartFrame: candidate.sourceStartFrame,
      sourceEndFrame: candidate.sourceEndFrame
    };
  });
  if (chunks.length === 0 || chunks.length > SOURCE_CAPTION_MAX_CHUNKS) {
    throw new DomainError("原声字幕 Job 的持久化分块数量无效，不能安全恢复", "SOURCE_CAPTION_PLAN_INVALID");
  }
  return {
    version: 1,
    requestedRevision: plan.requestedRevision,
    assetId: plan.assetId,
    timelineItemId: plan.timelineItemId,
    sourceStartFrame: plan.sourceStartFrame,
    sourceEndFrame: plan.sourceEndFrame,
    timelineStartFrame: plan.timelineStartFrame,
    timelineEndFrame: plan.timelineEndFrame,
    chunks
  };
}

function sourceCaptionPlanMatchesPayload(plan: SourceCaptionPlan, payload: SourceCaptionJobPayload): boolean {
  return plan.requestedRevision === payload.requestedRevision && plan.assetId === payload.assetId
    && plan.timelineItemId === payload.timelineItemId && plan.sourceStartFrame === payload.sourceStartFrame
    && plan.sourceEndFrame === payload.sourceEndFrame && plan.timelineStartFrame === payload.timelineStartFrame
    && plan.timelineEndFrame === payload.timelineEndFrame;
}

function sameSourceCaptionPlan(left: SourceCaptionPlan, right: SourceCaptionPlan): boolean {
  return sourceCaptionPlanMatchesPayload(left, right)
    && left.chunks.length === right.chunks.length
    && left.chunks.every((chunk, index) => chunk.index === right.chunks[index]?.index
      && chunk.sourceStartFrame === right.chunks[index]?.sourceStartFrame
      && chunk.sourceEndFrame === right.chunks[index]?.sourceEndFrame);
}

function isBridgeRunAudit(value: unknown): value is BridgeRunAudit {
  if (!isRecord(value)) return false;
  return typeof value.workflowId === "string" && typeof value.runId === "string" && typeof value.schemaVersion === "string"
    && typeof value.schemaRetryCount === "number" && typeof value.submittedAt === "string" && isRecord(value.request);
}

function sourceCaptionChunkFromAudit(audit: BridgeRunAudit, plan: SourceCaptionPlan): SourceCaptionChunkPlan | undefined {
  if (audit.workflowId !== FUNASR_WORKFLOW_ID) return undefined;
  const metadata = audit.request.metadata;
  if (!metadata || metadata.sourceCaptionKind !== "chunk"
    || metadata.sourceCaptionAssetId !== plan.assetId || metadata.sourceCaptionTimelineItemId !== plan.timelineItemId
    || metadata.sourceCaptionRequestedRevision !== plan.requestedRevision
    || !integer(metadata.sourceCaptionChunkIndex) || !integer(metadata.sourceCaptionStartFrame) || !integer(metadata.sourceCaptionEndFrame)) {
    return undefined;
  }
  return plan.chunks.find((chunk) => chunk.index === metadata.sourceCaptionChunkIndex
    && chunk.sourceStartFrame === metadata.sourceCaptionStartFrame
    && chunk.sourceEndFrame === metadata.sourceCaptionEndFrame);
}

function sourceCaptionMetadata(plan: SourceCaptionPlan, chunk: SourceCaptionChunkPlan): Record<string, string | number | boolean> {
  return {
    sourceCaptionKind: "chunk",
    sourceCaptionAssetId: plan.assetId,
    sourceCaptionTimelineItemId: plan.timelineItemId,
    sourceCaptionRequestedRevision: plan.requestedRevision,
    sourceCaptionChunkIndex: chunk.index,
    sourceCaptionStartFrame: chunk.sourceStartFrame,
    sourceCaptionEndFrame: chunk.sourceEndFrame,
    bridgeQueueMode: "foreground"
  };
}

function sourceCaptionIntentFromUnknown(value: unknown): SourceCaptionSubmissionIntent | undefined {
  if (!isRecord(value) || value.kind !== "source_caption_chunk" || !integer(value.index)
    || !integer(value.sourceStartFrame) || !integer(value.sourceEndFrame) || typeof value.createdAt !== "string") return undefined;
  return {
    kind: "source_caption_chunk",
    index: value.index,
    sourceStartFrame: value.sourceStartFrame,
    sourceEndFrame: value.sourceEndFrame,
    createdAt: value.createdAt
  };
}

function silenceRanges(output: string, durationSeconds: number): Array<{ startSeconds: number; endSeconds: number }> {
  const starts = [...output.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/gu)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const ends = [...output.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/gu)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return starts.map((start, index) => ({
    startSeconds: Math.min(durationSeconds, Math.max(0, start)),
    endSeconds: Math.min(durationSeconds, Math.max(start, ends[index] ?? durationSeconds))
  })).filter((range) => range.endSeconds > range.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

function buildSourceCaptionChunks(input: {
  sourceStartFrame: number;
  sourceEndFrame: number;
  fps: number;
  silenceOutput: string;
}): SourceCaptionChunkPlan[] {
  const durationSeconds = (input.sourceEndFrame - input.sourceStartFrame) / input.fps;
  const voicedRanges: Array<{ startSeconds: number; endSeconds: number }> = [];
  let cursor = 0;
  for (const silence of silenceRanges(input.silenceOutput, durationSeconds)) {
    if (silence.startSeconds - cursor >= SOURCE_CAPTION_MIN_CHUNK_SECONDS) {
      voicedRanges.push({ startSeconds: cursor, endSeconds: silence.startSeconds });
    }
    cursor = Math.max(cursor, silence.endSeconds);
  }
  if (durationSeconds - cursor >= SOURCE_CAPTION_MIN_CHUNK_SECONDS) {
    voicedRanges.push({ startSeconds: cursor, endSeconds: durationSeconds });
  }
  if (voicedRanges.length === 0) {
    throw new DomainError("所选 A-roll 范围只检测到静音，无法生成原声字幕", "SOURCE_CAPTION_NO_SPEECH");
  }
  const chunks = voicedRanges.map((range, index) => {
    const sourceStartFrame = Math.max(input.sourceStartFrame, Math.min(input.sourceEndFrame,
      input.sourceStartFrame + Math.round(range.startSeconds * input.fps)));
    const sourceEndFrame = Math.max(sourceStartFrame, Math.min(input.sourceEndFrame,
      input.sourceStartFrame + Math.round(range.endSeconds * input.fps)));
    if (sourceEndFrame <= sourceStartFrame) {
      throw new DomainError("静音边界无法映射为有效的原声字幕帧范围", "SOURCE_CAPTION_CHUNK_INVALID");
    }
    if ((sourceEndFrame - sourceStartFrame) / input.fps > SOURCE_CAPTION_MAX_CHUNK_SECONDS) {
      throw new DomainError(
        `检测到连续讲话超过 ${SOURCE_CAPTION_MAX_CHUNK_SECONDS} 秒，不能按字符或均分时长伪切字幕；请在真实停顿处拆分 A-roll 后重试。`,
        "SOURCE_CAPTION_CONTINUOUS_SPEECH_TOO_LONG"
      );
    }
    return { index, sourceStartFrame, sourceEndFrame };
  });
  if (chunks.length > SOURCE_CAPTION_MAX_CHUNKS) {
    throw new DomainError("原声字幕分块数量超过安全上限；请先将 A-roll 拆为更小的独立使用范围。", "SOURCE_CAPTION_CHUNK_COUNT_EXCEEDED");
  }
  return chunks;
}

/**
 * 原声 A-roll 字幕的 Worker 服务。它只把检测到的静音边界和 FunASR 的完整分块文本
 * 写成 chunk_coarse CaptionCard，不创建 Transcript、Script 或替代任何 Dialogue 音频。
 */
export class SourceCaptionService {
  constructor(private readonly application: EditingApplication, private readonly bridge: ComfyUIBridgeClient) {}

  private jobLineage(job: JobRecord, payload: SourceCaptionJobPayload): JobRecord[] {
    const lineage = [job];
    const visited = new Set<string>([job.id]);
    let parentId: unknown = job.payload.retryOfJobId;
    while (parentId !== undefined) {
      if (typeof parentId !== "string" || !parentId.trim() || visited.has(parentId)) {
        throw new DomainError("原声字幕重试来源无效或形成循环，不能安全恢复外部 Run", "SOURCE_CAPTION_RETRY_SOURCE_INVALID");
      }
      visited.add(parentId);
      const parent = this.application.trackJob(parentId);
      if (parent.projectId !== job.projectId || parent.kind !== "source_caption_generation") {
        throw new DomainError("原声字幕重试来源必须是同一项目的原声字幕 Job", "SOURCE_CAPTION_RETRY_SOURCE_MISMATCH");
      }
      const parentPayload = sourceCaptionPayloadFromJob(parent);
      if (JSON.stringify(parentPayload) !== JSON.stringify(payload)) {
        throw new DomainError("原声字幕重试来源的 A-roll 使用或源范围已变化，不能复用旧 Run", "SOURCE_CAPTION_RETRY_SOURCE_MISMATCH");
      }
      lineage.push(parent);
      parentId = parent.payload.retryOfJobId;
    }
    return lineage;
  }

  private sourceCaptionIntents(job: JobRecord): SourceCaptionSubmissionIntent[] {
    const stored = job.result?.sourceCaptionSubmissionIntents;
    if (stored === undefined) return [];
    if (!Array.isArray(stored)) {
      throw new DomainError("原声字幕 Job 的外部提交检查点已损坏，不能安全重试", "SOURCE_CAPTION_SUBMISSION_INTENT_INVALID");
    }
    return stored.map((entry) => {
      const intent = sourceCaptionIntentFromUnknown(entry);
      if (!intent) throw new DomainError("原声字幕 Job 的外部提交检查点已损坏，不能安全重试", "SOURCE_CAPTION_SUBMISSION_INTENT_INVALID");
      return intent;
    });
  }

  private intentMatchesChunk(intent: SourceCaptionSubmissionIntent, chunk: SourceCaptionChunkPlan): boolean {
    return intent.index === chunk.index && intent.sourceStartFrame === chunk.sourceStartFrame && intent.sourceEndFrame === chunk.sourceEndFrame;
  }

  private saveSubmissionIntent(jobId: string, chunk: SourceCaptionChunkPlan): void {
    const job = this.application.trackJob(jobId);
    const intents = this.sourceCaptionIntents(job);
    if (intents.some((intent) => this.intentMatchesChunk(intent, chunk))) return;
    this.application.recordJobCheckpoint(jobId, {
      sourceCaptionSubmissionIntents: [...intents, {
        kind: "source_caption_chunk" as const,
        index: chunk.index,
        sourceStartFrame: chunk.sourceStartFrame,
        sourceEndFrame: chunk.sourceEndFrame,
        createdAt: now()
      }]
    });
  }

  private clearSubmissionIntent(jobId: string, chunk: SourceCaptionChunkPlan): void {
    const job = this.application.trackJob(jobId);
    this.application.recordJobCheckpoint(jobId, {
      sourceCaptionSubmissionIntents: this.sourceCaptionIntents(job)
        .filter((intent) => !this.intentMatchesChunk(intent, chunk))
    });
  }

  private planFromLineage(job: JobRecord, payload: SourceCaptionJobPayload, lineage: JobRecord[]): SourceCaptionPlan | undefined {
    let recovered: SourceCaptionPlan | undefined;
    for (const candidate of lineage) {
      const plan = sourceCaptionPlanFromResult(candidate.result);
      if (!plan) continue;
      if (!sourceCaptionPlanMatchesPayload(plan, payload)) {
        throw new DomainError("原声字幕 Job 的持久化分块计划与当前 A-roll 使用不匹配", "SOURCE_CAPTION_PLAN_MISMATCH");
      }
      if (recovered && !sameSourceCaptionPlan(recovered, plan)) {
        throw new DomainError("原声字幕重试链存在互相冲突的分块计划，不能猜测采用哪一份", "SOURCE_CAPTION_PLAN_MISMATCH");
      }
      recovered = plan;
    }
    if (recovered && sourceCaptionPlanFromResult(job.result) === undefined) {
      this.application.recordJobCheckpoint(job.id, { sourceCaptionPlan: recovered });
    }
    return recovered;
  }

  private knownAudits(job: JobRecord, plan: SourceCaptionPlan, lineage: JobRecord[]): Map<number, BridgeRunAudit> {
    const byChunk = new Map<number, BridgeRunAudit>();
    const seenRunIds = new Set<string>();
    for (const candidate of lineage) {
      const stored = candidate.result?.bridgeRuns;
      if (stored === undefined) continue;
      if (!Array.isArray(stored)) {
        throw new DomainError("原声字幕 Job 的 Bridge 审计格式损坏，不能安全恢复", "SOURCE_CAPTION_BRIDGE_AUDIT_INVALID");
      }
      for (const entry of stored) {
        if (!isBridgeRunAudit(entry)) {
          throw new DomainError("原声字幕 Job 保存了无法识别的 Bridge 审计，不能安全恢复", "SOURCE_CAPTION_BRIDGE_AUDIT_INVALID");
        }
        const chunk = sourceCaptionChunkFromAudit(entry, plan);
        if (!chunk) {
          throw new DomainError("原声字幕 Job 的 Bridge 审计不属于当前分块计划，不能安全恢复", "SOURCE_CAPTION_BRIDGE_AUDIT_INVALID");
        }
        const previous = byChunk.get(chunk.index);
        if (previous && previous.runId !== entry.runId) {
          throw new DomainError("同一原声字幕分块存在多个 Bridge Run；系统不会猜测采用哪一次结果", "SOURCE_CAPTION_DUPLICATE_BRIDGE_RUN");
        }
        if (!seenRunIds.has(entry.runId) && candidate.id !== job.id) this.application.recordBridgeRun(job.id, entry);
        seenRunIds.add(entry.runId);
        byChunk.set(chunk.index, entry);
      }
    }
    return byChunk;
  }

  private assertNoUnresolvedSubmissionIntent(lineage: JobRecord[], plan: SourceCaptionPlan, knownAudits: Map<number, BridgeRunAudit>, chunk: SourceCaptionChunkPlan): void {
    for (const candidate of lineage) {
      for (const intent of this.sourceCaptionIntents(candidate)) {
        const planChunk = plan.chunks.find((entry) => entry.index === intent.index
          && entry.sourceStartFrame === intent.sourceStartFrame && entry.sourceEndFrame === intent.sourceEndFrame);
        if (!planChunk) {
          throw new DomainError("原声字幕 Job 的外部提交检查点不属于当前分块计划，不能安全恢复", "SOURCE_CAPTION_SUBMISSION_INTENT_INVALID");
        }
        if (this.intentMatchesChunk(intent, chunk) && !knownAudits.has(chunk.index)) {
          throw new DomainError(
            "该原声字幕分块曾开始提交 Bridge，但本地没有收到 run_id；结果未知，系统不会自动重复提交。请先对账外部 Bridge 后重新发起一个明确的新任务。",
            "EXTERNAL_RUN_OUTCOME_UNKNOWN"
          );
        }
      }
    }
  }

  private async createPlanFromSource(projectId: string, payload: SourceCaptionJobPayload): Promise<SourceCaptionPlan> {
    const state = this.application.readProject(projectId);
    if (state.revision.number !== payload.requestedRevision) {
      throw new DomainError("A-roll 已在原声字幕分块前发生变化；请基于当前 Revision 重新提交", "SOURCE_CAPTION_REVISION_STALE");
    }
    const item = state.snapshot.timeline.items.find((candidate) => candidate.id === payload.timelineItemId);
    const asset = state.snapshot.assets.find((candidate) => candidate.id === payload.assetId);
    if (!item || !asset || item.disabled || item.assetId !== asset.id || !asset.metadata?.hasAudio
      || !sourceAudioAlignmentOwnerMatches(state.snapshot, { sourceAssetId: payload.assetId, sourceTimelineItemId: payload.timelineItemId, speechSource: payload.speechSource })
      || item.sourceStartFrame !== payload.sourceStartFrame || item.sourceEndFrame !== payload.sourceEndFrame
      || item.startFrame !== payload.timelineStartFrame || item.endFrame !== payload.timelineEndFrame) {
      throw new DomainError("原声字幕 Job 所绑定的 A-roll 已改变或不再带有可用音频", "SOURCE_CAPTION_REVISION_STALE");
    }
    const durationSeconds = (payload.sourceEndFrame - payload.sourceStartFrame) / state.snapshot.timeline.fps;
    const silenceOutput = await runProcess("ffmpeg", [
      "-hide_banner", "-nostdin",
      "-ss", (payload.sourceStartFrame / state.snapshot.timeline.fps).toFixed(6),
      "-t", durationSeconds.toFixed(6),
      "-i", assetPath(state.snapshot, asset),
      "-vn", "-af", `asetpts=PTS-STARTPTS,silencedetect=n=${SOURCE_CAPTION_SILENCE_NOISE_DB}dB:d=${SOURCE_CAPTION_SILENCE_SECONDS}`,
      "-f", "null", "-"
    ], Math.max(120_000, Math.ceil(durationSeconds * 8_000)));
    return {
      version: 1,
      ...payload,
      chunks: buildSourceCaptionChunks({
        sourceStartFrame: payload.sourceStartFrame,
        sourceEndFrame: payload.sourceEndFrame,
        fps: state.snapshot.timeline.fps,
        silenceOutput
      })
    };
  }

  private async extractChunkAudio(job: JobRecord, plan: SourceCaptionPlan, chunk: SourceCaptionChunkPlan): Promise<string> {
    const state = this.application.readProject(job.projectId);
    const asset = assetById(state.snapshot, plan.assetId);
    const item = state.snapshot.timeline.items.find((candidate) => candidate.id === plan.timelineItemId);
    if (!item || item.disabled || item.assetId !== asset.id || !asset.metadata?.hasAudio) {
      throw new DomainError("原声字幕分块时 A-roll 已不可播放", "SOURCE_CAPTION_REVISION_STALE");
    }
    const directory = join(state.snapshot.project.rootPath, "cache", "source-captions", safeOutputName(job.id));
    const path = join(directory, `chunk-${String(chunk.index).padStart(3, "0")}-${chunk.sourceStartFrame}-${chunk.sourceEndFrame}.wav`);
    const durationSeconds = (chunk.sourceEndFrame - chunk.sourceStartFrame) / state.snapshot.timeline.fps;
    await mkdir(directory, { recursive: true });
    await runProcess("ffmpeg", [
      "-hide_banner", "-nostdin", "-y",
      "-ss", (chunk.sourceStartFrame / state.snapshot.timeline.fps).toFixed(6),
      "-t", durationSeconds.toFixed(6),
      "-i", assetPath(state.snapshot, asset),
      "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path
    ], Math.max(120_000, Math.ceil(durationSeconds * 8_000)));
    return path;
  }

  private async submitChunkRun(input: {
    audioPath: string;
    beforeSubmit: () => void;
    onSchemaRejected: () => void;
  }): Promise<BridgeRunSubmission> {
    let workflow = await this.bridge.getWorkflow(FUNASR_WORKFLOW_ID);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const request = {
        fieldValues: {},
        queueMode: "foreground" as const,
        files: [{ slot: this.bridge.findRequiredSlot(workflow, "audio"), path: input.audioPath, mime: "audio/wav" }]
      };
      input.beforeSubmit();
      try {
        const run = await this.bridge.createRun({ workflow, ...request });
        return { workflow, run, request, schemaRetryCount: attempt };
      } catch (error) {
        // HTTP 409 明确表示旧 schema 没有接收 Run；可重新读取只读 workflow 后安全重试一次。
        if (error instanceof BridgeError && error.status === 409 && attempt === 0) {
          input.onSchemaRejected();
          workflow = await this.bridge.getWorkflow(FUNASR_WORKFLOW_ID);
          continue;
        }
        throw error;
      }
    }
    throw new DomainError("无法使用当前 FunASR Workflow 提交原声字幕分块", "SOURCE_CAPTION_SUBMISSION_FAILED");
  }

  private async waitForChunk(job: JobRecord, chunk: SourceCaptionChunkPlan, audit: BridgeRunAudit): Promise<SourceCaptionResult> {
    this.application.recordBridgeRun(job.id, audit);
    let completed: BridgeRun;
    try {
      completed = await this.bridge.waitForRun(audit.runId);
    } catch (error) {
      if (error instanceof BridgeRunLostError) {
        throw new DomainError(
          `原声字幕 FunASR Run ${audit.runId} 已不可查询；系统未自动创建新 Run，请在 Bridge 对账后明确重新提交。`,
          "SOURCE_CAPTION_RUN_LOST_REQUIRES_RESUBMISSION"
        );
      }
      throw error;
    }
    const completedAudit = completeBridgeRunAudit(audit, completed);
    this.application.recordBridgeRun(job.id, completedAudit);
    const output = completed.outputs.find((candidate) => candidate.kind === "text" && typeof candidate.text === "string");
    if (!output?.text?.trim()) {
      throw new DomainError("FunASR 原声字幕分块已完成，但没有返回可显示文本", "MISSING_SOURCE_CAPTION_OUTPUT");
    }
    return { chunk, bridgeRunId: completed.id, text: output.text.trim() };
  }

  async generate(job: JobRecord): Promise<Record<string, unknown>> {
    // 只保留该类以便旧发行物/测试读取历史类型；正式 Worker 已移除调度，直接调用也绝不执行 VAD。
    if (job.kind === "source_caption_generation") {
      throw new DomainError("历史 VAD chunk_coarse 字幕 Job 已停用，不能重新执行", "SOURCE_CAPTION_LEGACY_JOB_DISABLED");
    }
    const payload = sourceCaptionPayloadFromJob(job);
    const lineage = this.jobLineage(job, payload);
    let plan = this.planFromLineage(job, payload, lineage);
    if (!plan) {
      plan = await this.createPlanFromSource(job.projectId, payload);
      this.application.recordJobCheckpoint(job.id, { sourceCaptionPlan: plan });
    }
    // 先确认 Bridge 实际支持前置队列；不支持时不再创建会被长视频任务饿死的新 Run。
    await this.bridge.requireQueueMode("foreground");
    const knownAudits = this.knownAudits(job, plan, lineage);
    const results: SourceCaptionResult[] = [];
    const cacheDirectory = join(this.application.readProject(job.projectId).snapshot.project.rootPath, "cache", "source-captions", safeOutputName(job.id));
    try {
      for (const chunk of plan.chunks) {
        let audit = knownAudits.get(chunk.index);
        if (!audit) {
          const currentRevision = this.application.readProject(job.projectId).revision.number;
          if (currentRevision !== payload.requestedRevision) {
            throw new DomainError("A-roll 已在原声字幕生成期间发生变化；不会为旧 Revision 新建 Bridge Run", "SOURCE_CAPTION_REVISION_STALE");
          }
          this.assertNoUnresolvedSubmissionIntent(lineage, plan, knownAudits, chunk);
          const audioPath = await this.extractChunkAudio(job, plan, chunk);
          let externalSubmissionPending = false;
          try {
            const submission = await this.submitChunkRun({
              audioPath,
              beforeSubmit: () => {
                this.saveSubmissionIntent(job.id, chunk);
                externalSubmissionPending = true;
              },
              onSchemaRejected: () => {
                this.clearSubmissionIntent(job.id, chunk);
                externalSubmissionPending = false;
              }
            });
            audit = createBridgeRunAudit(submission, undefined, now(), sourceCaptionMetadata(plan, chunk));
            this.application.recordBridgeRun(job.id, audit);
            this.clearSubmissionIntent(job.id, chunk);
            knownAudits.set(chunk.index, audit);
          } catch (error) {
            // 有完整 HTTP 响应时可确定本次 Run 没有被接受；网络中断则保持检查点并阻止盲重试。
            if (!externalSubmissionPending) throw error;
            if (error instanceof BridgeError && error.status !== undefined) {
              this.clearSubmissionIntent(job.id, chunk);
              throw error;
            }
            if (error instanceof DomainError && error.code === "SOURCE_CAPTION_SUBMISSION_FAILED") throw error;
            throw new DomainError(
              "提交原声字幕 Bridge Run 时连接中断，外部结果未知；系统已保留检查点且不会自动重提。请先对账。",
              "EXTERNAL_RUN_OUTCOME_UNKNOWN"
            );
          }
        }
        results.push(await this.waitForChunk(job, chunk, audit));
      }
      const state = this.application.completeSourceAudioCaptions({
        projectId: job.projectId,
        ...payload,
        chunks: results.map((result) => ({
          sourceStartFrame: result.chunk.sourceStartFrame,
          sourceEndFrame: result.chunk.sourceEndFrame,
          text: result.text,
          bridgeRunId: result.bridgeRunId
        }))
      });
      return {
        requestedRevision: payload.requestedRevision,
        revision: state.revision.number,
        chunkCount: plan.chunks.length,
        captionCount: results.length,
        bridgeRunIds: results.map((result) => result.bridgeRunId)
      };
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

type SourceCaptionAlignmentIntent = {
  kind: "source_caption_alignment";
  createdAt: string;
};

type SourceCaptionAlignmentToken = {
  text: string;
  startMs: number;
  endMs: number;
};

/** 一个 Provider segment 对应一屏字幕；只有完整可核验 token 才保存范围。 */
type SourceCaptionProviderSegment = {
  displayText: string;
  startMs: number;
  endMs: number;
  tokenStart?: number;
  tokenEnd?: number;
};

type SourceCaptionAlignmentResult = {
  text: string;
  tokenPrecision: "provider_token_timed" | "unavailable";
  tokens?: SourceCaptionAlignmentToken[];
  segments: SourceCaptionProviderSegment[];
};

function sourceCaptionAlignmentMetadata(payload: SourceCaptionJobPayload): Record<string, string | number | boolean> {
  return {
    sourceCaptionKind: "caption_alignment",
    sourceCaptionAssetId: payload.assetId,
    sourceCaptionTimelineItemId: payload.timelineItemId,
    sourceCaptionRequestedRevision: payload.requestedRevision,
    sourceCaptionStartFrame: payload.sourceStartFrame,
    sourceCaptionEndFrame: payload.sourceEndFrame,
    ...(payload.speechSource ? { sourceCaptionSpeechAssetId: payload.speechSource.speechAssetId, sourceCaptionScriptRevision: payload.speechSource.scriptRevision } : {}),
    bridgeQueueMode: "foreground"
  };
}

function sourceCaptionAlignmentAuditMatches(audit: BridgeRunAudit, payload: SourceCaptionJobPayload): boolean {
  if (audit.workflowId !== FUNASR_SOURCE_CAPTION_WORKFLOW_ID) return false;
  const metadata = audit.request.metadata;
  return Boolean(metadata
    && metadata.sourceCaptionKind === "caption_alignment"
    && metadata.sourceCaptionAssetId === payload.assetId
    && metadata.sourceCaptionTimelineItemId === payload.timelineItemId
    && metadata.sourceCaptionRequestedRevision === payload.requestedRevision
    && metadata.sourceCaptionStartFrame === payload.sourceStartFrame
    && metadata.sourceCaptionEndFrame === payload.sourceEndFrame
    && metadata.sourceCaptionSpeechAssetId === payload.speechSource?.speechAssetId
    && metadata.sourceCaptionScriptRevision === payload.speechSource?.scriptRevision
    && metadata.bridgeQueueMode === "foreground");
}

function sourceCaptionAlignmentIntentFromUnknown(value: unknown): SourceCaptionAlignmentIntent | undefined {
  if (!isRecord(value) || value.kind !== "source_caption_alignment" || typeof value.createdAt !== "string") return undefined;
  return { kind: "source_caption_alignment", createdAt: value.createdAt };
}

function requireTextOutputSlot(workflow: BridgeWorkflow, outputSlotId: string): void {
  const matching = workflow.outputs.filter((output) => output.id === outputSlotId);
  if (matching.length !== 1 || matching[0]?.kind !== "text") {
    throw new DomainError(
      `FunASR 原声字幕对齐 Workflow 缺少独立的文本输出槽位 ${outputSlotId}；不会改用任意第一个文本输出。`,
      "MISSING_SOURCE_CAPTION_ALIGNMENT_OUTPUT_SLOT"
    );
  }
}

function requireTextOutput(run: BridgeRun, outputSlotId: string): string {
  const matching = run.outputs.filter((output) => output.outputSlotId === outputSlotId);
  if (matching.length !== 1 || matching[0]?.kind !== "text" || typeof matching[0].text !== "string" || !matching[0].text.trim()) {
    throw new DomainError(
      `FunASR 原声字幕对齐完成但缺少 ${outputSlotId} 文本输出；不会改用任意第一个输出。`,
      "MISSING_SOURCE_CAPTION_ALIGNMENT_OUTPUT"
    );
  }
  return matching[0].text.trim();
}

function normalizeSourceCaptionComparableText(value: string): string {
  return value.normalize("NFKC").replace(/[\p{White_Space}\p{P}]/gu, "").toLocaleLowerCase("en-US");
}

/**
 * 严格接收 v4 段级合同。Provider 的 segment 时间本身就是正式字幕的时间事实；
 * token 只有能逐项核验时才开放给编辑重分段，绝不用字符或标点补算。
 */
export function parseSourceCaptionAlignmentOutput(value: string): SourceCaptionAlignmentResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DomainError("FunASR 原声字幕对齐输出不是合法 JSON", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  if (!isRecord(parsed) || parsed.version !== 4 || parsed.precision !== "provider_segment_timed"
    || typeof parsed.text !== "string" || !parsed.text.trim() || !Array.isArray(parsed.segments)
    || !isRecord(parsed.alignment)
    || (parsed.alignment.tokenPrecision !== "provider_token_timed" && parsed.alignment.tokenPrecision !== "unavailable")
    || (parsed.alignment.tokenEvidence !== undefined
      && !((parsed.alignment.tokenEvidence === "verified" && parsed.alignment.tokenPrecision === "provider_token_timed")
        || (parsed.alignment.tokenEvidence === "unavailable" && parsed.alignment.tokenPrecision === "unavailable")))) {
    throw new DomainError("FunASR 原声字幕对齐必须是 version=4、provider_segment_timed，并明确 tokenPrecision", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  const tokenPrecision = parsed.alignment.tokenPrecision;
  if (parsed.alignment.tokens !== undefined && !Array.isArray(parsed.alignment.tokens)) {
    throw new DomainError("FunASR 原声字幕 alignment.tokens 必须是数组或省略", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  const rawTokens = parsed.alignment.tokens ?? [];
  if (tokenPrecision === "provider_token_timed" && rawTokens.length === 0) {
    throw new DomainError("FunASR 声称提供逐 token 时间，但没有完整 token 结果", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  if (tokenPrecision === "unavailable" && rawTokens.length > 0) {
    throw new DomainError("FunASR 未提供完整 token 时间时不能混入部分 token", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  const tokens = rawTokens.map((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.text !== "string" || !candidate.text.trim()
      || !integer(candidate.startMs) || !integer(candidate.endMs) || candidate.startMs < 0 || candidate.endMs <= candidate.startMs) {
      throw new DomainError(`FunASR 第 ${index + 1} 个 token 结果结构无效`, "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
    }
    return {
      text: candidate.text,
      startMs: candidate.startMs,
      endMs: candidate.endMs
    };
  });
  const segments = parsed.segments.map((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.displayText !== "string" || !candidate.displayText.trim()
      || !normalizeSourceCaptionComparableText(candidate.displayText)
      || !integer(candidate.startMs) || !integer(candidate.endMs)
      || (tokenPrecision === "provider_token_timed" && (!integer(candidate.tokenStart) || !integer(candidate.tokenEnd)))
      || (tokenPrecision === "unavailable" && (candidate.tokenStart !== undefined || candidate.tokenEnd !== undefined))) {
      throw new DomainError(`FunASR 第 ${index + 1} 个字幕段结果结构无效`, "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
    }
    const tokenRange = tokenPrecision === "provider_token_timed" ? {
      tokenStart: candidate.tokenStart as number,
      tokenEnd: candidate.tokenEnd as number
    } : {};
    return {
      displayText: candidate.displayText,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      ...tokenRange
    };
  });
  if (segments.length === 0 || normalizeSourceCaptionComparableText(parsed.text) === "") {
    throw new DomainError("FunASR 原声字幕对齐没有可显示的字幕段", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  return { text: parsed.text.trim(), tokenPrecision, ...(tokenPrecision === "provider_token_timed" ? { tokens } : {}), segments };
}

/**
 * 对完整 A-roll 音频执行 FunASR 段级对齐。Provider 的一个 segment 会在 Application 同一
 * 提交中自动成为一屏字幕；token 仅用于验证其文字与时间，绝不逐字显示。
 */
export class SourceCaptionAlignmentService {
  constructor(private readonly application: EditingApplication, private readonly bridge: ComfyUIBridgeClient) {}

  private jobLineage(job: JobRecord, payload: SourceCaptionJobPayload): JobRecord[] {
    const lineage = [job];
    const visited = new Set<string>([job.id]);
    let parentId: unknown = job.payload.retryOfJobId;
    while (parentId !== undefined) {
      if (typeof parentId !== "string" || !parentId.trim() || visited.has(parentId)) {
        throw new DomainError("原声段级字幕重试来源无效或形成循环，不能安全恢复外部 Run", "SOURCE_CAPTION_ALIGNMENT_RETRY_SOURCE_INVALID");
      }
      visited.add(parentId);
      const parent = this.application.trackJob(parentId);
      if (parent.projectId !== job.projectId || parent.kind !== "source_caption_alignment") {
        throw new DomainError("原声段级字幕重试来源必须是同一项目的段级对齐 Job", "SOURCE_CAPTION_ALIGNMENT_RETRY_SOURCE_MISMATCH");
      }
      const parentPayload = sourceCaptionPayloadFromJob(parent, "source_caption_alignment");
      if (JSON.stringify(parentPayload) !== JSON.stringify(payload)) {
        throw new DomainError("原声段级字幕重试来源的 A-roll 使用或源范围已变化，不能复用旧 Run", "SOURCE_CAPTION_ALIGNMENT_RETRY_SOURCE_MISMATCH");
      }
      lineage.push(parent);
      parentId = parent.payload.retryOfJobId;
    }
    return lineage;
  }

  private intents(job: JobRecord): SourceCaptionAlignmentIntent[] {
    const stored = job.result?.sourceCaptionAlignmentIntents;
    if (stored === undefined) return [];
    if (!Array.isArray(stored)) {
      throw new DomainError("原声段级字幕 Job 的外部提交检查点已损坏，不能安全重试", "SOURCE_CAPTION_ALIGNMENT_SUBMISSION_INTENT_INVALID");
    }
    return stored.map((value) => {
      const intent = sourceCaptionAlignmentIntentFromUnknown(value);
      if (!intent) throw new DomainError("原声段级字幕 Job 的外部提交检查点已损坏，不能安全重试", "SOURCE_CAPTION_ALIGNMENT_SUBMISSION_INTENT_INVALID");
      return intent;
    });
  }

  private saveIntent(jobId: string): void {
    const job = this.application.trackJob(jobId);
    if (this.intents(job).length > 0) return;
    this.application.recordJobCheckpoint(jobId, {
      sourceCaptionAlignmentIntents: [{ kind: "source_caption_alignment", createdAt: now() }]
    });
  }

  private clearIntent(jobId: string): void {
    this.application.recordJobCheckpoint(jobId, { sourceCaptionAlignmentIntents: [] });
  }

  private knownAudit(job: JobRecord, payload: SourceCaptionJobPayload, lineage: JobRecord[]): BridgeRunAudit | undefined {
    let found: BridgeRunAudit | undefined;
    for (const candidate of lineage) {
      const stored = candidate.result?.bridgeRuns;
      if (stored === undefined) continue;
      if (!Array.isArray(stored)) {
        throw new DomainError("原声段级字幕 Job 的 Bridge 审计格式损坏，不能安全恢复", "SOURCE_CAPTION_ALIGNMENT_BRIDGE_AUDIT_INVALID");
      }
      for (const entry of stored) {
        if (!isBridgeRunAudit(entry) || !sourceCaptionAlignmentAuditMatches(entry, payload)) {
          throw new DomainError("原声段级字幕 Job 的 Bridge 审计不属于当前 A-roll 对齐请求，不能安全恢复", "SOURCE_CAPTION_ALIGNMENT_BRIDGE_AUDIT_INVALID");
        }
        if (found && found.runId !== entry.runId) {
          throw new DomainError("同一原声段级字幕请求存在多个 Bridge Run；系统不会猜测采用哪一次结果", "SOURCE_CAPTION_ALIGNMENT_DUPLICATE_BRIDGE_RUN");
        }
        found = entry;
        if (candidate.id !== job.id) this.application.recordBridgeRun(job.id, entry);
      }
    }
    return found;
  }

  private assertNoUnresolvedIntent(lineage: JobRecord[], audit: BridgeRunAudit | undefined): void {
    if (!audit && lineage.some((candidate) => this.intents(candidate).length > 0)) {
      throw new DomainError(
        "原声段级字幕对齐曾开始提交 Bridge，但本地没有收到 run_id；结果未知，系统不会自动重复提交。请先对账外部 Bridge 后重新发起一个明确的新任务。",
        "EXTERNAL_RUN_OUTCOME_UNKNOWN"
      );
    }
  }

  private async extractArollAudio(job: JobRecord, payload: SourceCaptionJobPayload): Promise<string> {
    const state = this.application.readProject(job.projectId);
    if (state.revision.number !== payload.requestedRevision) {
      throw new DomainError("A-roll 已在字幕对齐前发生变化；不会为旧 Revision 新建 Bridge Run", "SOURCE_CAPTION_ALIGNMENT_REVISION_STALE");
    }
    const item = state.snapshot.timeline.items.find((candidate) => candidate.id === payload.timelineItemId);
    const asset = state.snapshot.assets.find((candidate) => candidate.id === payload.assetId);
    if (!item || !asset || item.disabled || item.assetId !== asset.id || !asset.metadata?.hasAudio
      || item.sourceStartFrame !== payload.sourceStartFrame || item.sourceEndFrame !== payload.sourceEndFrame
      || item.startFrame !== payload.timelineStartFrame || item.endFrame !== payload.timelineEndFrame) {
      throw new DomainError("原声段级字幕 Job 所绑定的 A-roll 已改变或不再带有可用音频", "SOURCE_CAPTION_ALIGNMENT_REVISION_STALE");
    }
    const directory = join(state.snapshot.project.rootPath, "cache", "source-caption-alignment", safeOutputName(job.id));
    const path = join(directory, `aroll-${payload.sourceStartFrame}-${payload.sourceEndFrame}.wav`);
    const durationSeconds = (payload.sourceEndFrame - payload.sourceStartFrame) / state.snapshot.timeline.fps;
    await mkdir(directory, { recursive: true });
    await runProcess("ffmpeg", [
      "-hide_banner", "-nostdin", "-y",
      "-ss", (payload.sourceStartFrame / state.snapshot.timeline.fps).toFixed(6),
      "-t", durationSeconds.toFixed(6),
      "-i", assetPath(state.snapshot, asset),
      "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path
    ], Math.max(120_000, Math.ceil(durationSeconds * 8_000)));
    return path;
  }

  private async submitRun(audioPath: string, beforeSubmit: () => void, onSchemaRejected: () => void): Promise<BridgeRunSubmission> {
    let workflow = await this.bridge.getWorkflow(FUNASR_SOURCE_CAPTION_WORKFLOW_ID);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      requireTextOutputSlot(workflow, "transcript-text");
      requireTextOutputSlot(workflow, "caption-alignment-json");
      const request = {
        fieldValues: {},
        queueMode: "foreground" as const,
        files: [{ slot: this.bridge.findRequiredSlot(workflow, "audio"), path: audioPath, mime: "audio/wav" }]
      };
      beforeSubmit();
      try {
        const run = await this.bridge.createRun({ workflow, ...request });
        return { workflow, run, request, schemaRetryCount: attempt };
      } catch (error) {
        // 409 表示服务明确拒绝旧 Schema，因此可清除 Intent 后重读一次动态 Schema；
        // 网络中断则保留 Intent，避免将可能已创建的 Run 当作不存在。
        if (error instanceof BridgeError && error.status === 409 && attempt === 0) {
          onSchemaRejected();
          workflow = await this.bridge.getWorkflow(FUNASR_SOURCE_CAPTION_WORKFLOW_ID);
          continue;
        }
        throw error;
      }
    }
    throw new DomainError("无法使用当前 FunASR Workflow 提交原声段级字幕对齐", "SOURCE_CAPTION_ALIGNMENT_SUBMISSION_FAILED");
  }

  async align(job: JobRecord): Promise<Record<string, unknown>> {
    const payload = sourceCaptionPayloadFromJob(job, "source_caption_alignment");
    const lineage = this.jobLineage(job, payload);
    await this.bridge.requireQueueMode("foreground");
    let audit = this.knownAudit(job, payload, lineage);
    this.assertNoUnresolvedIntent(lineage, audit);
    const cacheDirectory = join(this.application.readProject(job.projectId).snapshot.project.rootPath, "cache", "source-caption-alignment", safeOutputName(job.id));
    try {
      if (!audit) {
        const audioPath = await this.extractArollAudio(job, payload);
        let externalSubmissionPending = false;
        try {
          const submission = await this.submitRun(
            audioPath,
            () => {
              this.saveIntent(job.id);
              externalSubmissionPending = true;
            },
            () => {
              this.clearIntent(job.id);
              externalSubmissionPending = false;
            }
          );
          audit = createBridgeRunAudit(submission, undefined, now(), sourceCaptionAlignmentMetadata(payload));
          this.application.recordBridgeRun(job.id, audit);
          this.clearIntent(job.id);
        } catch (error) {
          if (!externalSubmissionPending) throw error;
          if (error instanceof BridgeError && error.status !== undefined) {
            this.clearIntent(job.id);
            throw error;
          }
          if (error instanceof DomainError && error.code === "SOURCE_CAPTION_ALIGNMENT_SUBMISSION_FAILED") throw error;
          throw new DomainError(
            "提交原声段级字幕对齐 Bridge Run 时连接中断，外部结果未知；系统已保留检查点且不会自动重提。请先对账。",
            "EXTERNAL_RUN_OUTCOME_UNKNOWN"
          );
        }
      }
      let completed: BridgeRun;
      try {
        completed = await this.bridge.waitForRun(audit.runId);
      } catch (error) {
        if (error instanceof BridgeRunLostError) {
          throw new DomainError(
            `原声段级字幕对齐 FunASR Run ${audit.runId} 已不可查询；系统未自动创建新 Run，请在 Bridge 对账后明确重新提交。`,
            "SOURCE_CAPTION_ALIGNMENT_RUN_LOST_REQUIRES_RESUBMISSION"
          );
        }
        throw error;
      }
      const completedAudit = completeBridgeRunAudit(audit, completed);
      this.application.recordBridgeRun(job.id, completedAudit);
      const transcriptText = requireTextOutput(completed, "transcript-text");
      const alignment = parseSourceCaptionAlignmentOutput(requireTextOutput(completed, "caption-alignment-json"));
      if (normalizeSourceCaptionComparableText(transcriptText) !== normalizeSourceCaptionComparableText(alignment.text)) {
        throw new DomainError("FunASR 独立全文输出与段级对齐全文不一致，不能写入字幕", "SOURCE_CAPTION_ALIGNMENT_TRANSCRIPT_MISMATCH");
      }
      const state = this.application.completeSourceAudioCaptionAlignment({
        projectId: job.projectId,
        ...payload,
        transcriptText,
        bridgeAudit: completedAudit,
        tokenPrecision: alignment.tokenPrecision,
        tokens: alignment.tokens,
        segments: alignment.segments.map((segment) => ({
          displayText: segment.displayText,
          startMs: segment.startMs,
          endMs: segment.endMs,
          ...(alignment.tokenPrecision === "provider_token_timed" ? {
            tokenStartIndex: segment.tokenStart,
            tokenEndIndex: segment.tokenEnd
          } : {})
        }))
      });
      const completedAlignment = state.snapshot.sourceAudioAlignments.find((candidate) => candidate.sourceTimelineItemId === payload.timelineItemId
        && candidate.bridgeAudit.runId === completed.id && candidate.status === "ready");
      const program = completedAlignment
        ? state.snapshot.sourceCaptionPrograms.find((candidate) => candidate.alignmentId === completedAlignment.id && candidate.source === "provider_segments")
        : undefined;
      if (!completedAlignment || !program || program.captionIds.length !== alignment.segments.length) {
        throw new DomainError("原声段级字幕已写入 Revision，但找不到完整的默认 Program 或 CaptionCard", "SOURCE_CAPTION_ALIGNMENT_COMPLETION_MISSING");
      }
      return {
        requestedRevision: payload.requestedRevision,
        revision: state.revision.number,
        alignmentId: completedAlignment.id,
        tokenCount: alignment.tokens?.length ?? 0,
        segmentCount: alignment.segments.length,
        captionCount: program.captionIds.length,
        programId: program.id,
        bridgeRunId: completed.id,
        timingPrecision: alignment.tokenPrecision === "provider_token_timed" ? "source_token_anchored" : "sentence_exact"
      };
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

type SegmentMaterial = { speechSegmentId: string; segmentAsset: SpeechSegmentAsset; path: string; durationMs: number; prePauseMs: number; postPauseMs: number };

async function assembleAudio(materials: SegmentMaterial[], targetPath: string): Promise<void> {
  if (materials.length === 0) throw new DomainError("没有可拼接的语音片段", "NO_SPEECH_SEGMENTS");
  await mkdir(join(targetPath, ".."), { recursive: true });
  const args = ["-y"];
  const labels: string[] = [];
  let inputIndex = 0;
  for (const material of materials) {
    if (material.prePauseMs > 0) {
      args.push("-f", "lavfi", "-t", (material.prePauseMs / 1000).toFixed(3), "-i", "anullsrc=r=24000:cl=mono");
      labels.push(`[${inputIndex}:a]aresample=24000, aformat=sample_rates=24000:channel_layouts=mono[p${inputIndex}]`);
      inputIndex += 1;
    }
    args.push("-i", material.path);
    labels.push(`[${inputIndex}:a]aresample=24000, aformat=sample_rates=24000:channel_layouts=mono[p${inputIndex}]`);
    inputIndex += 1;
    if (material.postPauseMs > 0) {
      args.push("-f", "lavfi", "-t", (material.postPauseMs / 1000).toFixed(3), "-i", "anullsrc=r=24000:cl=mono");
      labels.push(`[${inputIndex}:a]aresample=24000, aformat=sample_rates=24000:channel_layouts=mono[p${inputIndex}]`);
      inputIndex += 1;
    }
  }
  const inputLabels = labels.map((entry, index) => `[p${index}]`).join("");
  const filter = `${labels.join(";")};${inputLabels}concat=n=${labels.length}:v=0:a=1[outa]`;
  args.push("-filter_complex", filter, "-map", "[outa]", "-c:a", "pcm_s16le", targetPath);
  await runProcess("ffmpeg", args, 10 * 60_000);
}

/** 复用真实段音频，在明确的帧起点之间插入静音；不再次调用语音模型。 */
export async function assemblePlacedSpeech(application: EditingApplication, job: JobRecord): Promise<{ speechAssetId: string; revision: number }> {
  const requestedRevision = Number(job.payload.requestedRevision);
  const previousSpeechAssetId = String(job.payload.speechAssetId);
  const placements = job.payload.placements as Array<{ speechSegmentId: string; startFrame: number }>;
  const state = application.readProject(job.projectId);
  if (state.revision.number !== requestedRevision || state.snapshot.speechAsset?.id !== previousSpeechAssetId) throw new DomainError("旁白编排期间项目已变化", "STALE_SPEECH_PLACEMENT");
  const previous = state.snapshot.speechAsset;
  const fps = state.snapshot.timeline.fps;
  const materials: SegmentMaterial[] = [];
  const timing: SpeechTiming["segments"] = [];
  let cursorMs = 0;
  for (const placement of placements) {
    const segmentAsset = state.snapshot.speechSegmentAssets.find((asset) => asset.speechSegmentId === placement.speechSegmentId && previous.segmentAssetIds.includes(asset.id));
    if (!segmentAsset) throw new DomainError("段音频已变化", "STALE_SPEECH_PLACEMENT");
    const asset = assetById(state.snapshot, segmentAsset.assetId);
    const startMs = placement.startFrame * 1000 / fps;
    if (startMs < cursorMs - 0.5) throw new DomainError("段音频起点重叠", "INVALID_SPEECH_PLACEMENT");
    const gapMs = Math.max(0, startMs - cursorMs);
    materials.push({ speechSegmentId: placement.speechSegmentId, segmentAsset, path: assetPath(state.snapshot, asset), durationMs: segmentAsset.durationMs, prePauseMs: gapMs, postPauseMs: 0 });
    const endMs = startMs + segmentAsset.durationMs;
    timing.push({ speechSegmentId: placement.speechSegmentId, startMs, endMs, startFrame: placement.startFrame, endFrame: millisecondsToFrames(endMs, fps) });
    cursorMs = endMs;
  }
  const durationFrames = job.payload.durationFrames === undefined ? undefined : Number(job.payload.durationFrames);
  if (durationFrames !== undefined) {
    const durationMs = durationFrames * 1000 / fps;
    if (!Number.isInteger(durationFrames) || durationMs < cursorMs - 0.5) throw new DomainError("旁白总轨时长无效", "INVALID_SPEECH_PLACEMENT_DURATION");
    materials[materials.length - 1]!.postPauseMs = Math.max(0, durationMs - cursorMs);
    cursorMs = durationMs;
  }
  const relativePath = join("assets", "speech", `speech-placement-${job.id}.wav`);
  const targetPath = join(state.snapshot.project.rootPath, relativePath);
  await assembleAudio(materials, targetPath);
  const metadata = await probeMedia(targetPath);
  if (!metadata.hasAudio || metadata.durationMs < cursorMs - 20) throw new DomainError("重排旁白文件不完整", "INVALID_SPEECH_OUTPUT");
  const speechFile = createMediaAsset({ name: `编排旁白 ${job.id}`, kind: "speech", managedPath: relativePath });
  speechFile.status = "ready";
  speechFile.metadata = metadata;
  const speechAsset: SpeechAsset = { id: createId("speech_asset"), assetId: speechFile.id, scriptRevision: previous.scriptRevision, segmentAssetIds: previous.segmentAssetIds, timing: { precision: "segment_exact", source: "已就绪段音频真实时长 + 指定帧起点", segments: timing }, status: "ready" };
  const committed = application.completeSpeechPlacement({ projectId: job.projectId, requestedRevision, previousSpeechAssetId, speechFile, speechAsset });
  return { speechAssetId: speechAsset.id, revision: committed.revision.number };
}

function makeSpeechTiming(snapshot: ProjectSnapshot, materials: SegmentMaterial[]): SpeechTiming {
  let cursorMs = 0;
  const segments = materials.map((material) => {
    cursorMs += material.prePauseMs;
    const startMs = cursorMs;
    cursorMs += material.durationMs;
    const endMs = cursorMs;
    cursorMs += material.postPauseMs;
    return {
      speechSegmentId: material.speechSegmentId,
      startMs,
      endMs,
      startFrame: millisecondsToFrames(startMs, snapshot.timeline.fps),
      endFrame: millisecondsToFrames(endMs, snapshot.timeline.fps)
    };
  });
  return { precision: "segment_exact", source: "OmniVoice 输出真实时长 + 明确段间停顿", segments };
}

/**
 * OmniVoice 的每个任务都携带同一份本地 VoiceReference 和一个完整 SpeechSegment，
 * 不建立不存在的远端 Voice ID，也不把克隆与 TTS 拆成两套外部任务。
 */
export class OmniVoiceSegmentService {
  constructor(private readonly application: EditingApplication, private readonly bridge: ComfyUIBridgeClient) {}

  async synthesize(
    projectId: string,
    voiceReferenceAssetId: string | undefined,
    segmentIds: string[],
    expectedScriptRevision: number,
    voiceReferenceId?: string,
    onBridgeRun?: BridgeRunReporter
  ): Promise<{ segmentCount: number; speechAssetId?: string }> {
    const initial = this.application.readProject(projectId);
    if (initial.snapshot.script.revision !== expectedScriptRevision) {
      throw new DomainError("Script 已变化，拒绝将旧语音写入当前项目", "STALE_SCRIPT");
    }
    const voiceReference = voiceReferenceAssetId ? assetById(initial.snapshot, voiceReferenceAssetId) : undefined;
    const referencePath = voiceReference ? assetPath(initial.snapshot, voiceReference) : undefined;
    const requested = segmentIds.map((segmentId) => {
      const segment = initial.snapshot.speechSegments.find((candidate) => candidate.id === segmentId);
      if (!segment) throw new DomainError(`SpeechSegment 不存在：${segmentId}`, "SPEECH_SEGMENT_NOT_FOUND");
      return segment;
    });
    const generatedAssets: Asset[] = [];
    const generatedSegmentAssets: SpeechSegmentAsset[] = [];
    const replacement = new Map<string, SpeechSegmentAsset>();

    for (const segment of requested) {
      const submission = await this.bridge.createRunWithSchemaRetry(referencePath ? OMNIVOICE_WORKFLOW_ID : "omnivoice-default-reference-v1", async (detail) => {
        const textField = this.bridge.findTextField(detail);
        if (!referencePath && detail.itemSlots.some((slot) => slot.required)) {
          throw new DomainError("服务端默认音色工作流仍要求上传文件，请修复默认音色配置", "VOICE_DEFAULT_NOT_CONFIGURED");
        }
        return {
          fieldValues: { [textField.id]: segment.text },
          files: referencePath ? [{ slot: this.bridge.findRequiredSlot(detail, "audio"), path: referencePath, mime: "audio/wav" }] : []
        };
      });
      const submittedAt = now();
      await onBridgeRun?.(createBridgeRunAudit(submission, undefined, submittedAt));
      const completed = await this.bridge.waitForRun(submission.run.id);
      const output = completed.outputs.find((candidate) => candidate.kind === "audio" && candidate.downloadUrl);
      if (!output?.downloadUrl) throw new DomainError("OmniVoice 已完成，但没有音频输出", "MISSING_SPEECH_OUTPUT");
      const extension = extname(output.fileName ?? "") || ".flac";
      const relativePath = join("assets", "speech", `${segment.id}-${safeOutputName(basename(output.fileName ?? "voice")) || "voice"}${extension === ".flac" && (output.fileName ?? "").endsWith(".flac") ? "" : ""}`);
      const targetPath = join(initial.snapshot.project.rootPath, relativePath);
      await mkdir(join(initial.snapshot.project.rootPath, "assets", "speech"), { recursive: true });
      await this.bridge.downloadOutput(output, targetPath);
      await assertFileReadable(targetPath);
      const metadata = await probeMedia(targetPath);
      if (metadata.durationMs <= 0 || !metadata.hasAudio) throw new DomainError("下载的 OmniVoice 输出不可读或为空", "INVALID_SPEECH_OUTPUT");
      const generatedAsset = createMediaAsset({ name: `旁白：${segment.text.slice(0, 18)}`, kind: "speech", managedPath: relativePath });
      generatedAsset.status = "ready";
      generatedAsset.metadata = metadata;
      generatedAssets.push(generatedAsset);
      const segmentAsset: SpeechSegmentAsset = {
        id: createId("speech_segment_asset"),
        speechSegmentId: segment.id,
        voiceReferenceAssetId,
        voiceReferenceId,
        assetId: generatedAsset.id,
        durationMs: metadata.durationMs,
        bridgeRunId: completed.id,
        schemaVersion: submission.workflow.schemaVersion,
        bridgeAudit: createBridgeRunAudit(submission, completed, submittedAt),
        quality: "passed"
      };
      generatedSegmentAssets.push(segmentAsset);
      replacement.set(segment.id, segmentAsset);
    }

    const latest = this.application.readProject(projectId);
    if (latest.snapshot.script.revision !== expectedScriptRevision) {
      throw new DomainError("语音生成期间 Script 已变化，结果保留为任务产物但不写入项目", "STALE_SCRIPT");
    }
    const existing = new Map(latest.snapshot.speechSegmentAssets.map((segmentAsset) => [segmentAsset.speechSegmentId, segmentAsset]));
    for (const [segmentId, segmentAsset] of replacement) existing.set(segmentId, segmentAsset);
    const materials: SegmentMaterial[] = [];
    for (const segment of latest.snapshot.speechSegments.sort((left, right) => left.order - right.order)) {
      const segmentAsset = existing.get(segment.id);
      if (!segmentAsset) continue;
      const asset = generatedAssets.find((candidate) => candidate.id === segmentAsset.assetId) ?? latest.snapshot.assets.find((candidate) => candidate.id === segmentAsset.assetId);
      if (!asset) continue;
      materials.push({
        speechSegmentId: segment.id,
        segmentAsset,
        path: assetPath(latest.snapshot, asset),
        durationMs: segmentAsset.durationMs,
        // 兼容旧快照的毫秒字段；新 Segment 的停顿来自 semantic-continuity 的明确原因。
        prePauseMs: segment.pauseBefore?.durationMs ?? segment.prePauseMs ?? 0,
        postPauseMs: segment.pauseAfter?.durationMs ?? segment.postPauseMs ?? 0
      });
    }
    if (materials.length !== latest.snapshot.speechSegments.length) {
      this.application.applySpeechAssembly({ projectId, generatedAssets, segmentAssets: generatedSegmentAssets });
      return { segmentCount: generatedSegmentAssets.length };
    }
    const speechRelativePath = join("assets", "speech", `speech-${expectedScriptRevision}.wav`);
    const speechPath = join(latest.snapshot.project.rootPath, speechRelativePath);
    await assembleAudio(materials, speechPath);
    const finalMetadata = await probeMedia(speechPath);
    const speechFileAsset = createMediaAsset({ name: `旁白总轨 Revision ${expectedScriptRevision}`, kind: "speech", managedPath: speechRelativePath });
    speechFileAsset.status = "ready";
    speechFileAsset.metadata = finalMetadata;
    generatedAssets.push(speechFileAsset);
    const speechAsset: SpeechAsset = {
      id: createId("speech_asset"),
      assetId: speechFileAsset.id,
      scriptRevision: expectedScriptRevision,
      segmentAssetIds: materials.map((material) => material.segmentAsset.id),
      timing: makeSpeechTiming(latest.snapshot, materials),
      status: "ready"
    };
    this.application.applySpeechAssembly({ projectId, generatedAssets, segmentAssets: generatedSegmentAssets, speechAsset });
    return { segmentCount: generatedSegmentAssets.length, speechAssetId: speechAsset.id };
  }
}

export async function assertFileReadable(filePath: string): Promise<void> {
  const data = await stat(filePath);
  if (data.size <= 0) throw new DomainError("生成文件为空", "EMPTY_OUTPUT_FILE");
}
