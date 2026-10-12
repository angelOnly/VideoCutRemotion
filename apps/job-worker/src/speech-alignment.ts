import { stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type { EditingApplication } from "@videocut/application";
import {
  BridgeRunLostError,
  ComfyUIBridgeClient,
  type BridgeItemSlot,
  type BridgeOutput,
  type BridgeRun,
  type BridgeRunSubmission,
  type BridgeWorkflow,
  type BridgeWorkflowField
} from "@videocut/bridge";
import type { Asset, BridgeRunAudit, JobRecord, ProjectSnapshot, SpeechAsset, WordTiming } from "@videocut/contracts";
import { assetById, DomainError, millisecondsToFrames } from "@videocut/domain";

/** Worker 只负责 Bridge 调用和真实 JSON 时间戳解析；Revision 与 word_exact 状态由 Application 原子写入。 */
export type SpeechAlignmentCompletionInput = {
  projectId: string;
  jobId: string;
  alignment: {
    words: WordTiming[];
    source: string;
  };
  bridgeAudit: BridgeRunAudit;
};

type SpeechAlignmentCompletionApplication = EditingApplication & {
  completeSpeechAlignment(input: SpeechAlignmentCompletionInput): unknown | Promise<unknown>;
};

type SpeechAlignmentContext = {
  snapshot: ProjectSnapshot;
  speechAsset: SpeechAsset;
  speechFile: Asset;
  workflowId: string;
  outputSlotId?: string;
  scriptText: string;
};

type RawAlignmentToken = {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
};

const SPEECH_ALIGNMENT_JOB_KIND = "speech_alignment";
const MAX_ALIGNMENT_OUTPUT_CHARS = 2 * 1024 * 1024;

const normalizedLabel = (value: { label: string; kind: string }) => `${value.label} ${value.kind}`.trim().toLocaleLowerCase();
const normalizedMime = (mime: string | undefined) => mime?.split(";", 1)[0]?.trim().toLocaleLowerCase() || undefined;

function requirePayloadString(payload: Record<string, unknown>, key: string, message: string, code: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new DomainError(message, code);
  return value.trim();
}

function requirePayloadInteger(payload: Record<string, unknown>, key: string, message: string, code: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new DomainError(message, code);
  return value;
}

function assetPath(snapshot: ProjectSnapshot, asset: Asset): string {
  return isAbsolute(asset.managedPath) ? asset.managedPath : join(snapshot.project.rootPath, asset.managedPath);
}

function scriptTextForSpeech(snapshot: ProjectSnapshot, speechAsset: SpeechAsset): string {
  const segmentById = new Map(snapshot.speechSegments.map((segment) => [segment.id, segment]));
  const segments = speechAsset.timing.segments
    .slice()
    .sort((left, right) => left.startMs - right.startMs)
    .map((timing) => {
      const segment = segmentById.get(timing.speechSegmentId);
      if (!segment) throw new DomainError("SpeechAsset 的词级对齐缺少对应 SpeechSegment", "SPEECH_ALIGNMENT_SEGMENT_MISSING");
      return segment.text;
    });
  const text = segments.join("\n").trim();
  if (!text) throw new DomainError("当前 SpeechAsset 没有可强制对齐的最终 Script 文本", "SPEECH_ALIGNMENT_SCRIPT_EMPTY");
  return text;
}

/** 任务创建后项目若有任何 Revision 变化，就不能继续消费 Provider 配额。 */
export function resolveSpeechAlignmentContext(application: EditingApplication, job: JobRecord): SpeechAlignmentContext {
  const state = application.readProject(job.projectId);
  const requestedRevision = requirePayloadInteger(job.payload, "requestedRevision", "词级对齐任务缺少受管请求 Revision", "SPEECH_ALIGNMENT_JOB_PAYLOAD_INVALID");
  if (requestedRevision !== state.revision.number) {
    throw new DomainError("项目 Revision 已变化，不能继续提交旧旁白的词级对齐", "STALE_SPEECH_ALIGNMENT_REQUEST");
  }
  const speechAssetId = requirePayloadString(job.payload, "speechAssetId", "词级对齐任务缺少 SpeechAsset ID", "SPEECH_ALIGNMENT_JOB_PAYLOAD_INVALID");
  const scriptRevision = requirePayloadInteger(job.payload, "scriptRevision", "词级对齐任务缺少 Script Revision", "SPEECH_ALIGNMENT_JOB_PAYLOAD_INVALID");
  const speechAsset = state.snapshot.speechAsset;
  if (!speechAsset || speechAsset.status !== "ready" || speechAsset.id !== speechAssetId
    || speechAsset.scriptRevision !== scriptRevision || state.snapshot.script.revision !== scriptRevision) {
    throw new DomainError("词级对齐任务引用的 SpeechAsset 或 Script 已过期", "STALE_SPEECH_ALIGNMENT_REQUEST");
  }
  const speechFile = assetById(state.snapshot, speechAsset.assetId);
  if (speechFile.kind !== "speech" || speechFile.status !== "ready" || !speechFile.metadata?.hasAudio
    || typeof speechFile.metadata.durationMs !== "number" || !Number.isInteger(speechFile.metadata.durationMs) || speechFile.metadata.durationMs <= 0) {
    throw new DomainError("词级对齐需要当前已就绪、具有真实时长的本地 SpeechAsset 音频", "SPEECH_ALIGNMENT_AUDIO_NOT_READY");
  }
  const outputSlotId = typeof job.payload.outputSlotId === "string" && job.payload.outputSlotId.trim()
    ? job.payload.outputSlotId.trim()
    : undefined;
  return {
    snapshot: state.snapshot,
    speechAsset,
    speechFile,
    workflowId: requirePayloadString(job.payload, "workflowId", "词级对齐任务缺少明确的 Bridge workflowId", "SPEECH_ALIGNMENT_WORKFLOW_ID_REQUIRED"),
    outputSlotId,
    scriptText: scriptTextForSpeech(state.snapshot, speechAsset)
  };
}

async function assertReadableInput(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size <= 0) throw new DomainError("当前 SpeechAsset 本地音频文件不存在或为空", "SPEECH_ALIGNMENT_AUDIO_FILE_INVALID");
}

function audioSlotScore(slot: BridgeItemSlot): number {
  const label = normalizedLabel(slot);
  if (/(?:forced.?align|alignment|对齐|时间戳|timestamp)/u.test(label)) return 100;
  if (/(?:speech|voice|narration|audio|旁白|语音|音频)/u.test(label)) return 90;
  return 10;
}

function selectAudioSlot(workflow: BridgeWorkflow): BridgeItemSlot {
  const candidates = workflow.itemSlots.filter((slot) => slot.kind === "audio");
  if (candidates.length === 0) throw new DomainError("Bridge 当前对齐工作流没有音频输入槽", "SPEECH_ALIGNMENT_AUDIO_SLOT_MISSING");
  if (candidates.length === 1) return candidates[0]!;
  const ranked = candidates.map((slot) => ({ slot, score: audioSlotScore(slot) })).sort((left, right) => right.score - left.score || left.slot.id.localeCompare(right.slot.id));
  if (ranked[0]!.score === ranked[1]!.score) {
    throw new DomainError("Bridge 当前对齐工作流有多个同优先级音频输入槽，不能猜测哪一个是最终旁白", "SPEECH_ALIGNMENT_AUDIO_SLOT_AMBIGUOUS");
  }
  return ranked[0]!.slot;
}

function textFieldScore(field: BridgeWorkflowField): number {
  const label = normalizedLabel(field);
  if (/(?:language|locale|语言|地区|prompt|提示词|negative|反向)/u.test(label)) return 0;
  if (/(?:forced.?align|alignment.?text|align.?text|对齐文本|强制对齐|transcript|转写文本|script|脚本)/u.test(label)) return 100;
  if (/(?:text|content|字幕|文稿|文本|台词|旁白)/u.test(label)) return 80;
  return 0;
}

function selectScriptTextField(workflow: BridgeWorkflow): BridgeWorkflowField {
  const ranked = workflow.fields
    .map((field) => ({ field, score: textFieldScore(field) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.field.id.localeCompare(right.field.id));
  if (ranked.length > 0) {
    if (ranked.length > 1 && ranked[0]!.score === ranked[1]!.score) {
      throw new DomainError("Bridge 当前对齐工作流有多个同优先级文本字段，不能猜测哪一个承载最终 Script", "SPEECH_ALIGNMENT_TEXT_FIELD_AMBIGUOUS");
    }
    return ranked[0]!.field;
  }
  const textFields = workflow.fields.filter((field) => field.kind.toLocaleLowerCase() === "text");
  if (textFields.length === 1) return textFields[0]!;
  if (textFields.length > 1) throw new DomainError("Bridge 当前对齐工作流有多个文本字段，且没有可确认的 Script 标签", "SPEECH_ALIGNMENT_TEXT_FIELD_AMBIGUOUS");
  throw new DomainError("Bridge 当前对齐工作流没有可确认的 Script 文本字段", "SPEECH_ALIGNMENT_TEXT_FIELD_MISSING");
}

function mimeForSpeech(path: string): string {
  const extension = extname(path).toLocaleLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".flac") return "audio/flac";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".opus") return "audio/opus";
  return "application/octet-stream";
}

/** 每次 Schema 重试都会重新选择 field / slot，绝不持久化一次偶然读到的 Provider ID。 */
export async function buildSpeechAlignmentBridgeRequest(
  context: SpeechAlignmentContext,
  workflow: BridgeWorkflow
): Promise<{ fieldValues: Record<string, unknown>; files: Array<{ slot: BridgeItemSlot; path: string; mime: string }> }> {
  if (context.outputSlotId && !workflow.outputs.some((output) => output.id === context.outputSlotId)) {
    throw new DomainError("指定的词级对齐输出槽不在当前 Bridge Schema 中", "SPEECH_ALIGNMENT_OUTPUT_SLOT_NOT_FOUND");
  }
  const path = assetPath(context.snapshot, context.speechFile);
  await assertReadableInput(path);
  const textField = selectScriptTextField(workflow);
  const audioSlot = selectAudioSlot(workflow);
  return {
    fieldValues: { [textField.id]: context.scriptText },
    files: [{ slot: audioSlot, path, mime: mimeForSpeech(path) }]
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
      fileSlots: submission.request.files?.map((file) => ({ id: file.slot.id, kind: file.slot.kind, fileName: file.path.split(/[\\/]/u).pop() ?? "speech" })) ?? []
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
  const entries = Array.isArray(job.result?.bridgeRuns) ? job.result.bridgeRuns : [];
  return [...entries].reverse().find((entry): entry is BridgeRunAudit => isBridgeAudit(entry) && entry.workflowId === workflowId);
}

function completedAudit(previous: BridgeRunAudit, completed: BridgeRun): BridgeRunAudit {
  return { ...previous, completedAt: new Date().toISOString(), response: responseSummary(completed) };
}

function isJsonTextOutput(output: BridgeOutput): boolean {
  const mime = normalizedMime(output.mime);
  return typeof output.text === "string" && (output.kind === "text" || mime === "application/json" || Boolean(mime?.endsWith("+json")));
}

/** 多个 JSON 输出时必须由提交侧固定槽位，不能误把诊断、置信度摘要或中间结果当成最终对齐。 */
export function selectSpeechAlignmentOutput(run: BridgeRun, outputSlotId?: string): BridgeOutput {
  const candidates = run.outputs.filter(isJsonTextOutput);
  if (outputSlotId) {
    const selected = candidates.find((output) => output.outputSlotId === outputSlotId);
    if (!selected) throw new DomainError("Bridge 已完成，但指定输出槽没有可读取的 JSON 词级时间戳", "SPEECH_ALIGNMENT_OUTPUT_SLOT_MISSING");
    return selected;
  }
  if (candidates.length === 0) throw new DomainError("Bridge 已完成，但没有内联 JSON 词级时间戳输出", "SPEECH_ALIGNMENT_OUTPUT_MISSING");
  if (candidates.length > 1) throw new DomainError("Bridge 返回多个 JSON 词级输出；请提交任务时指定 outputSlotId", "SPEECH_ALIGNMENT_OUTPUT_AMBIGUOUS");
  return candidates[0]!;
}

const normalizeAlignmentText = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function explicitTimestampInMilliseconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new DomainError(`${label}必须是明确的整数毫秒`, "SPEECH_ALIGNMENT_TIMESTAMP_INVALID");
  }
  return value;
}

function secondsToMilliseconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new DomainError(`${label}必须是明确的秒数`, "SPEECH_ALIGNMENT_TIMESTAMP_INVALID");
  const milliseconds = value * 1000;
  if (!Number.isInteger(milliseconds)) {
    throw new DomainError(`${label}换算后不是完整毫秒；当前合同不允许静默四舍五入词级时间戳`, "SPEECH_ALIGNMENT_TIMESTAMP_PRECISION_UNSUPPORTED");
  }
  return milliseconds;
}

function textForRawToken(token: Record<string, unknown>): string {
  const candidates = [token.text, token.word, token.token].filter((value): value is string => typeof value === "string");
  if (candidates.length !== 1 || !candidates[0]!.trim()) {
    throw new DomainError("词级对齐 token 必须恰好提供一个非空 text、word 或 token 字段", "SPEECH_ALIGNMENT_TOKEN_TEXT_INVALID");
  }
  return candidates[0]!.trim();
}

/**
 * 支持两种不含猜测的 Provider 合同：startMs/endMs，或顶层 timeUnit + start/end。
 * 绝不从裸数字、字段名称相近程度或单词数量推断单位和位置。
 */
export function parseSpeechAlignmentJson(text: string): { tokens: RawAlignmentToken[]; source?: string } {
  if (!text.trim() || text.length > MAX_ALIGNMENT_OUTPUT_CHARS) {
    throw new DomainError("词级对齐 JSON 为空或超过允许大小", "SPEECH_ALIGNMENT_OUTPUT_SIZE_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DomainError("Bridge 词级对齐输出不是可解析 JSON", "SPEECH_ALIGNMENT_OUTPUT_NOT_JSON");
  }
  const root = asRecord(parsed);
  if (!root) throw new DomainError("Bridge 词级对齐 JSON 必须是对象", "SPEECH_ALIGNMENT_OUTPUT_SHAPE_INVALID");
  const rawWords = Array.isArray(root.words) ? root.words : undefined;
  const rawTokens = Array.isArray(root.tokens) ? root.tokens : undefined;
  if ((rawWords ? 1 : 0) + (rawTokens ? 1 : 0) !== 1) {
    throw new DomainError("Bridge 词级对齐 JSON 必须恰好包含 words 或 tokens 数组", "SPEECH_ALIGNMENT_OUTPUT_SHAPE_INVALID");
  }
  const entries = rawWords ?? rawTokens!;
  if (entries.length === 0 || entries.length > 20_000) {
    throw new DomainError("Bridge 词级对齐 JSON 的 token 数量必须在 1 到 20000 之间", "SPEECH_ALIGNMENT_OUTPUT_TOKEN_COUNT_INVALID");
  }
  const timeUnit = root.timeUnit;
  if (timeUnit !== undefined && timeUnit !== "ms" && timeUnit !== "seconds") {
    throw new DomainError("Bridge 词级对齐 JSON 的 timeUnit 只能是 ms 或 seconds", "SPEECH_ALIGNMENT_TIME_UNIT_INVALID");
  }
  const tokens = entries.map((entry, index) => {
    const token = asRecord(entry);
    if (!token) throw new DomainError(`第 ${index + 1} 个词级对齐 token 不是对象`, "SPEECH_ALIGNMENT_OUTPUT_SHAPE_INVALID");
    const hasMilliseconds = Object.hasOwn(token, "startMs") || Object.hasOwn(token, "endMs");
    const hasGeneric = Object.hasOwn(token, "start") || Object.hasOwn(token, "end");
    if (hasMilliseconds === hasGeneric) {
      throw new DomainError(`第 ${index + 1} 个词级对齐 token 必须使用且只使用一组明确时间字段`, "SPEECH_ALIGNMENT_TIMESTAMP_SHAPE_INVALID");
    }
    let startMs: number;
    let endMs: number;
    if (hasMilliseconds) {
      if (timeUnit !== undefined && timeUnit !== "ms") {
        throw new DomainError("startMs/endMs 与 timeUnit 不一致", "SPEECH_ALIGNMENT_TIME_UNIT_INVALID");
      }
      startMs = explicitTimestampInMilliseconds(token.startMs, `第 ${index + 1} 个 token 的 startMs`);
      endMs = explicitTimestampInMilliseconds(token.endMs, `第 ${index + 1} 个 token 的 endMs`);
    } else {
      if (timeUnit !== "ms" && timeUnit !== "seconds") {
        throw new DomainError("使用 start/end 时必须在顶层明确 timeUnit，不能猜测单位", "SPEECH_ALIGNMENT_TIME_UNIT_REQUIRED");
      }
      startMs = timeUnit === "ms"
        ? explicitTimestampInMilliseconds(token.start, `第 ${index + 1} 个 token 的 start`)
        : secondsToMilliseconds(token.start, `第 ${index + 1} 个 token 的 start`);
      endMs = timeUnit === "ms"
        ? explicitTimestampInMilliseconds(token.end, `第 ${index + 1} 个 token 的 end`)
        : secondsToMilliseconds(token.end, `第 ${index + 1} 个 token 的 end`);
    }
    const confidence = token.confidence;
    if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new DomainError(`第 ${index + 1} 个 token 的 confidence 必须在 0 到 1 之间，或由 Provider 省略`, "SPEECH_ALIGNMENT_CONFIDENCE_INVALID");
    }
    const value = textForRawToken(token);
    const suppliedNormalized = token.normalizedText;
    if (suppliedNormalized !== undefined && suppliedNormalized !== normalizeAlignmentText(value)) {
      throw new DomainError(`第 ${index + 1} 个 token 的 normalizedText 与本地规范化文本不一致`, "SPEECH_ALIGNMENT_NORMALIZED_TEXT_INVALID");
    }
    return { text: value, startMs, endMs, confidence };
  });
  return { tokens, source: typeof root.source === "string" && root.source.trim() ? root.source.trim() : undefined };
}

/** Worker 先做一次范围和文本核验；Application 会在写 Revision 前用相同事实再次复核。 */
export function materializeWordTimings(context: SpeechAlignmentContext, rawTokens: RawAlignmentToken[]): WordTiming[] {
  const durationMs = context.speechFile.metadata?.durationMs;
  if (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs <= 0) {
    throw new DomainError("SpeechAsset 缺少可验证时长，不能写入词级时间戳", "SPEECH_ALIGNMENT_AUDIO_NOT_READY");
  }
  const segmentTimings = context.speechAsset.timing.segments.slice().sort((left, right) => left.startMs - right.startMs);
  let previousEndMs = -1;
  const words = rawTokens.map((token, index) => {
    if (!Number.isInteger(token.startMs) || !Number.isInteger(token.endMs) || token.startMs < 0 || token.endMs <= token.startMs
      || token.endMs > durationMs || token.startMs < previousEndMs) {
      throw new DomainError(`第 ${index + 1} 个 token 的时间超出当前真实音频范围或发生重叠`, "SPEECH_ALIGNMENT_WORD_RANGE_INVALID");
    }
    const segment = segmentTimings.find((timing) => token.startMs >= timing.startMs && token.endMs <= timing.endMs);
    if (!segment) throw new DomainError(`第 ${index + 1} 个 token 跨越 SpeechSegment 边界或落在停顿区`, "SPEECH_ALIGNMENT_SEGMENT_MISMATCH");
    const startFrame = millisecondsToFrames(token.startMs, context.snapshot.timeline.fps);
    const endFrame = millisecondsToFrames(token.endMs, context.snapshot.timeline.fps);
    if (endFrame <= startFrame) {
      throw new DomainError(`第 ${index + 1} 个 token 在当前 FPS 下不足一帧，不能伪装成可用词级帧范围`, "SPEECH_ALIGNMENT_FRAME_INVALID");
    }
    previousEndMs = token.endMs;
    return {
      speechSegmentId: segment.speechSegmentId,
      text: token.text,
      normalizedText: normalizeAlignmentText(token.text),
      startMs: token.startMs,
      endMs: token.endMs,
      startFrame,
      endFrame,
      confidence: token.confidence
    };
  });
  if (words.map((word) => word.normalizedText).join("") !== normalizeAlignmentText(context.scriptText)) {
    throw new DomainError("Bridge token 文本与当前最终 Script 不一致，不能声明 word_exact", "SPEECH_ALIGNMENT_TEXT_MISMATCH");
  }
  return words;
}

async function completeSpeechAlignment(application: EditingApplication, input: SpeechAlignmentCompletionInput): Promise<unknown> {
  const candidate = application as SpeechAlignmentCompletionApplication;
  if (typeof candidate.completeSpeechAlignment !== "function") {
    throw new DomainError("当前 EditingApplication 尚未实现词级对齐结果写入", "SPEECH_ALIGNMENT_COMPLETION_NOT_IMPLEMENTED");
  }
  return candidate.completeSpeechAlignment(input);
}

function completedAlignmentResult(application: EditingApplication, job: JobRecord): Record<string, unknown> {
  const result = application.trackJob(job.id).result;
  if (typeof result?.speechAlignmentId !== "string" || !Number.isInteger(result.revision)) {
    throw new DomainError("词级对齐已写入项目，但 Job 缺少可追溯完成对象", "SPEECH_ALIGNMENT_COMPLETION_RESULT_MISSING");
  }
  return { speechAlignmentId: result.speechAlignmentId, revision: result.revision };
}

/** Application Revision 已写入但 Worker 尚未来得及标记 Job 成功时，禁止再次调用付费/远端 Provider。 */
function recoverCompletedProjectWrite(application: EditingApplication, job: JobRecord): Record<string, unknown> | undefined {
  const state = application.readProject(job.projectId);
  const alignment = state.snapshot.speechAlignment;
  if (!alignment || alignment.generationJobId !== job.id) return undefined;
  const recordedId = job.result?.speechAlignmentId;
  if (recordedId !== undefined && recordedId !== alignment.id) return undefined;
  return {
    jobId: job.id,
    runId: alignment.audit.runId,
    speechAlignmentId: alignment.id,
    revision: state.revision.number,
    wordCount: alignment.words.length,
    recoveredProjectWrite: true
  };
}

/**
 * 真实强制对齐链：先动态读取 Schema 并持久化 run 审计，再只接受明确 JSON 时间戳输出。
 * Run 丢失时不自动重提，因为对齐 Provider 可能已计费、音频或模型版本也可能已改变。
 */
export async function runSpeechAlignment(
  application: EditingApplication,
  job: JobRecord,
  bridge: ComfyUIBridgeClient
): Promise<Record<string, unknown>> {
  if (job.kind !== SPEECH_ALIGNMENT_JOB_KIND) throw new DomainError("词级对齐 Worker 收到了错误的任务类型", "INVALID_SPEECH_ALIGNMENT_JOB");
  const recovered = recoverCompletedProjectWrite(application, job);
  if (recovered) return recovered;
  const context = resolveSpeechAlignmentContext(application, job);
  const previousAudit = latestBridgeAudit(job, context.workflowId);

  if (previousAudit) {
    try {
      const completed = await bridge.waitForRun(previousAudit.runId);
      const audit = completedAudit(previousAudit, completed);
      application.recordBridgeRun(job.id, audit);
      const output = selectSpeechAlignmentOutput(completed, context.outputSlotId);
      const parsed = parseSpeechAlignmentJson(output.text!);
      const words = materializeWordTimings(context, parsed.tokens);
      await completeSpeechAlignment(application, {
        projectId: job.projectId,
        jobId: job.id,
        alignment: { words, source: parsed.source ?? `Bridge workflow ${context.workflowId} / ${output.displayName}` },
        bridgeAudit: audit
      });
      return { jobId: job.id, runId: completed.id, wordCount: words.length, ...completedAlignmentResult(application, job), recoveredExistingRun: true };
    } catch (error) {
      if (!(error instanceof BridgeRunLostError)) throw error;
      throw new DomainError(
        `词级对齐 Provider 的 Run ${previousAudit.runId} 已不可查询；为避免重复计费或混用模型结果，请确认后再用新的 idempotencyKey 重新提交。`,
        "ALIGNMENT_RUN_LOST_REQUIRES_RECONFIRMATION"
      );
    }
  }

  const submittedAt = new Date().toISOString();
  const submission = await bridge.createRunWithSchemaRetry(
    context.workflowId,
    async (workflow) => buildSpeechAlignmentBridgeRequest(context, workflow)
  );
  application.recordBridgeRun(job.id, createBridgeAudit(submission, undefined, submittedAt));
  const completed = await bridge.waitForRun(submission.run.id);
  const audit = createBridgeAudit(submission, completed, submittedAt);
  application.recordBridgeRun(job.id, audit);
  const output = selectSpeechAlignmentOutput(completed, context.outputSlotId);
  const parsed = parseSpeechAlignmentJson(output.text!);
  const words = materializeWordTimings(context, parsed.tokens);
  await completeSpeechAlignment(application, {
    projectId: job.projectId,
    jobId: job.id,
    alignment: { words, source: parsed.source ?? `Bridge workflow ${context.workflowId} / ${output.displayName}` },
    bridgeAudit: audit
  });
  return { jobId: job.id, runId: completed.id, wordCount: words.length, ...completedAlignmentResult(application, job) };
}
