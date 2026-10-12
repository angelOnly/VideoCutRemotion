import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
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
import type { ActorCapabilityProfile, Asset, BridgeRunAudit, JobRecord, MediaMetadata, ProjectSnapshot } from "@videocut/contracts";
import { assetById, DomainError, millisecondsToFrames } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";

/**
 * 这里是 Worker 与 Application 的窄交接面。所有 Revision、Timeline、ActorPerformance
 * 写入都留在 Application，Worker 只提交已核验的本地视频和真实 Bridge 审计。
 */
export type AvatarActorVideo = {
  path: string;
  relativePath: string;
  name: string;
  contentHash: string;
  sourceHash: string;
  durationMs: number;
  durationFrames: number;
  metadata: MediaMetadata;
};

export type AvatarCompletionInput = {
  projectId: string;
  jobId: string;
  actorVideo: AvatarActorVideo;
  bridgeAudit: BridgeRunAudit;
};

type AvatarCompletionApplication = EditingApplication & {
  completeAvatarGeneration(input: AvatarCompletionInput): unknown | Promise<unknown>;
};

type AvatarGenerationContext = {
  snapshot: ProjectSnapshot;
  profile: ActorCapabilityProfile;
  referenceImage: Asset;
  speechFile: Asset;
  generationRange: { startFrame: number; endFrame: number; speechSegmentIds: string[] };
  prompt: string;
  requestedDurationSeconds: number;
};

const defaultAvatarPrompt = "参考图片中的人物以稳定、自然的主持人口吻面对镜头说话，表情和动作克制。使用提供的音频作为表演参考；不要添加屏幕文字、无关人物或无关场景。";
const avatarDirectory = (snapshot: ProjectSnapshot) => join(snapshot.project.rootPath, "assets", "avatar");
const safeFileName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

const assetPath = (snapshot: ProjectSnapshot, asset: Asset) => (
  isAbsolute(asset.managedPath) ? asset.managedPath : join(snapshot.project.rootPath, asset.managedPath)
);

function nonEmptyPayloadString(payload: Record<string, unknown>, key: string, message: string, code: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new DomainError(message, code);
  return value.trim();
}

function readGenerationRange(payload: Record<string, unknown>): { startFrame: number; endFrame: number; speechSegmentIds: string[] } {
  const value = payload.generationRange;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("数字人任务缺少局部生成范围", "AVATAR_GENERATION_RANGE_REQUIRED");
  }
  const record = value as Record<string, unknown>;
  const startFrame = Number(record.startFrame);
  const endFrame = Number(record.endFrame);
  const speechSegmentIds = Array.isArray(record.speechSegmentIds) ? record.speechSegmentIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())) : [];
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame || speechSegmentIds.length === 0) {
    throw new DomainError("数字人局部生成范围无效", "INVALID_AVATAR_GENERATION_RANGE");
  }
  return { startFrame, endFrame, speechSegmentIds };
}

function mimeForPath(path: string, fallback: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".flac") return "audio/flac";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".mp4") return "video/mp4";
  return fallback;
}

async function assertReadableInput(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size <= 0) throw new DomainError(`${label}文件不存在或为空`, "AVATAR_INPUT_FILE_INVALID");
}

function requestedDurationSeconds(
  snapshot: ProjectSnapshot,
  profile: ActorCapabilityProfile,
  payload: Record<string, unknown>,
  range: { startFrame: number; endFrame: number }
): number {
  const derived = Math.max(1, Math.ceil((range.endFrame - range.startFrame) / snapshot.timeline.fps));
  const provided = payload.durationSeconds;
  const duration = provided === undefined ? derived : Number(provided);
  if (!Number.isInteger(duration) || duration < 1) throw new DomainError("数字人生成时长必须是正整数秒", "INVALID_AVATAR_DURATION");
  if (duration > profile.maxDurationSeconds) {
    throw new DomainError(`人物生成时长 ${duration} 秒超过能力档案上限 ${profile.maxDurationSeconds} 秒，请先按自然段或 Cutaway 边界拆分`, "AVATAR_DURATION_EXCEEDS_CAPABILITY");
  }
  // 明确的生成范围不能被调用方悄悄截断，否则会产生“视频成功但旁白不完整”的假成功。
  if (duration < derived) throw new DomainError("数字人请求时长不能短于对应 SpeechSegment 的生成范围", "AVATAR_DURATION_SHORTER_THAN_RANGE");
  return duration;
}

function resolveAvatarContext(application: EditingApplication, job: JobRecord): AvatarGenerationContext {
  const state = application.readProject(job.projectId);
  const snapshot = state.snapshot;
  const requestedRevision = Number(job.payload.requestedRevision);
  // 外部 Provider 调用昂贵且不可回滚；在创建 run 前先拒绝已经落后的 Job。
  if (!Number.isInteger(requestedRevision)) {
    throw new DomainError("数字人任务缺少受管的请求 Revision", "AVATAR_JOB_PAYLOAD_INVALID");
  }
  if (requestedRevision !== state.revision.number) {
    throw new DomainError("项目 Revision 已变化，不能继续向 Avatar Provider 提交旧人物任务", "STALE_AVATAR_REQUEST");
  }
  const profileId = nonEmptyPayloadString(job.payload, "capabilityProfileId", "数字人任务缺少能力档案 ID", "AVATAR_CAPABILITY_ID_REQUIRED");
  const referenceImageId = nonEmptyPayloadString(job.payload, "referenceImageAssetId", "数字人任务缺少人物肖像素材 ID", "AVATAR_REFERENCE_IMAGE_REQUIRED");
  const speechAssetId = nonEmptyPayloadString(job.payload, "speechAssetId", "数字人任务缺少 SpeechAsset ID", "AVATAR_SPEECH_ASSET_REQUIRED");
  const profile = snapshot.actorCapabilityProfiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new DomainError("数字人任务引用的人物能力档案不存在", "ACTOR_CAPABILITY_NOT_FOUND");
  if (profile.provider !== "minimax_h3_multi_reference") throw new DomainError("当前 Worker 不支持该数字人 Provider", "AVATAR_PROVIDER_UNSUPPORTED");
  if (!profile.supportsReferenceImage) throw new DomainError("当前人物能力档案未声明支持肖像图片输入", "AVATAR_REFERENCE_IMAGE_UNSUPPORTED");
  if (!profile.inputModes.includes("audio")) throw new DomainError("当前人物能力档案未声明支持 SpeechAsset 音频输入", "AVATAR_AUDIO_INPUT_UNSUPPORTED");
  if (!profile.supportsAudioDrivenLipSync) {
    throw new DomainError("当前人物能力档案尚未确认音频驱动口型能力，不能向 Avatar Provider 提交", "AVATAR_LIP_SYNC_CAPABILITY_UNSUPPORTED");
  }
  const referenceImage = assetById(snapshot, referenceImageId);
  if (referenceImage.status !== "ready" || !["image", "derived"].includes(referenceImage.kind)) {
    throw new DomainError("人物肖像必须是已就绪的图片或派生图片素材", "AVATAR_REFERENCE_IMAGE_INVALID");
  }
  const speechAsset = snapshot.speechAsset;
  if (!speechAsset || speechAsset.status !== "ready" || speechAsset.id !== speechAssetId) {
    throw new DomainError("人物任务引用的 SpeechAsset 已过期或不是当前已就绪版本", "STALE_ACTOR_SPEECH");
  }
  const speechFile = assetById(snapshot, speechAsset.assetId);
  if (speechFile.status !== "ready" || (speechFile.metadata && !speechFile.metadata.hasAudio)) {
    throw new DomainError("当前 SpeechAsset 对应的音频文件不可用", "AVATAR_SPEECH_FILE_INVALID");
  }
  const prompt = typeof job.payload.prompt === "string" && job.payload.prompt.trim() ? job.payload.prompt.trim() : defaultAvatarPrompt;
  const generationRange = readGenerationRange(job.payload);
  return {
    snapshot,
    profile,
    referenceImage,
    speechFile,
    generationRange,
    prompt,
    requestedDurationSeconds: requestedDurationSeconds(snapshot, profile, job.payload, generationRange)
  };
}

function normalizedFieldLabel(field: BridgeWorkflowField): string {
  return `${field.label} ${field.kind}`.trim().toLocaleLowerCase();
}

/** 反向提示词绝不能承载人物表演指令，否则会在一次付费调用中得到相反结果。 */
function isNegativePromptField(field: BridgeWorkflowField): boolean {
  return /(?:negative|neg_prompt|exclude|forbid|反向|负面|排除|不要)/u.test(normalizedFieldLabel(field));
}

/**
 * Avatar 的 Schema 会随 Bridge 版本变化。这里仅选择唯一、明确的正向提示词字段；
 * 不把“第一个 text”或“第一个 required”当作语义匹配，避免错误提交外部付费任务。
 */
function selectAvatarPromptField(workflow: BridgeWorkflow): BridgeWorkflowField {
  const ranked = workflow.fields
    .filter((field) => !isNegativePromptField(field))
    .map((field) => {
      const label = normalizedFieldLabel(field);
      const score = /^(?:prompt|提示词)(?:\s|$)/u.test(label)
        ? 100
        : /(?:avatar|person|character|presenter|人物|数字人|角色|主持).*(?:prompt|提示词|description|描述)|(?:prompt|提示词).*(?:avatar|person|character|presenter|人物|数字人|角色|主持)/u.test(label)
          ? 95
          : /(?:prompt|提示词)/u.test(label)
            ? 90
            : /(?:description|描述)/u.test(label)
              ? 70
              : 0;
      return { field, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.field.id.localeCompare(right.field.id));
  if (ranked.length === 0) {
    throw new DomainError("Bridge 当前 Avatar 工作流没有可确认的正向提示词字段", "AVATAR_PROMPT_FIELD_MISSING");
  }
  const top = ranked[0]!;
  if (ranked.filter((entry) => entry.score === top.score).length !== 1) {
    throw new DomainError("Bridge 当前 Avatar 工作流存在多个同优先级正向提示词字段，不能猜测应写入哪个字段", "AVATAR_PROMPT_FIELD_AMBIGUOUS");
  }
  return top.field;
}

/** 只接受标签明确且唯一的肖像/旁白槽位；多个候选时宁可停止，也不猜 Provider 的 Slot 顺序。 */
function selectExplicitAvatarSlot(
  workflow: BridgeWorkflow,
  kind: BridgeItemSlot["kind"],
  patterns: RegExp[],
  role: "portrait" | "speech"
): BridgeItemSlot {
  const candidates = workflow.itemSlots.filter((slot) => (
    slot.kind === kind && patterns.some((pattern) => pattern.test(slot.label.toLocaleLowerCase()))
  ));
  if (candidates.length === 0) {
    throw new DomainError(
      `Bridge 当前 Avatar 工作流没有可确认的${role === "portrait" ? "肖像" : "旁白"}${kind}输入槽位`,
      role === "portrait" ? "AVATAR_PORTRAIT_SLOT_MISSING" : "AVATAR_SPEECH_SLOT_MISSING"
    );
  }
  if (candidates.length > 1) {
    throw new DomainError(
      `Bridge 当前 Avatar 工作流存在多个可匹配的${role === "portrait" ? "肖像" : "旁白"}${kind}输入槽位，不能猜测 Slot 顺序`,
      role === "portrait" ? "AVATAR_PORTRAIT_SLOT_AMBIGUOUS" : "AVATAR_SPEECH_SLOT_AMBIGUOUS"
    );
  }
  return candidates[0]!;
}

/** 只要还有必填 image/audio Slot 未被明确语义绑定，就不能向 Provider 创建 Run。 */
function assertRequiredAvatarMediaSlotsCovered(workflow: BridgeWorkflow, files: Array<{ slot: BridgeItemSlot }>): void {
  const uploaded = new Set(files.map((file) => file.slot.id));
  const missing = workflow.itemSlots.filter((slot) => slot.required && (slot.kind === "image" || slot.kind === "audio") && !uploaded.has(slot.id));
  if (missing.length > 0) {
    throw new DomainError(
      `Bridge 当前 Avatar 工作流存在未被明确覆盖的必填媒体槽位：${missing.map((slot) => slot.label).join("、")}`,
      "AVATAR_REQUIRED_MEDIA_SLOT_UNHANDLED"
    );
  }
}

function setAspectRatioFields(fieldValues: Record<string, unknown>, workflow: BridgeWorkflow, aspectRatio: ProjectSnapshot["project"]["brief"]["aspectRatio"]): void {
  const fields = workflow.fields.filter((field) => [/aspect/, /ratio/, /画面比例/, /比例/, /画幅/].some((pattern) => pattern.test(`${field.label} ${field.kind}`.toLowerCase())));
  for (const field of fields) {
    const option = field.options?.find((candidate) => `${candidate.label} ${candidate.value}`.includes(aspectRatio));
    if (option) {
      fieldValues[field.id] = option.value;
      continue;
    }
    // Schema 没有列出可选比例时，不猜 Provider 私有值；若默认值已匹配可以安全沿用。
    if (typeof field.defaultValue === "string" && field.defaultValue.includes(aspectRatio)) continue;
    if (field.required) throw new DomainError(`Bridge 当前 Schema 没有 ${aspectRatio} 画幅的可用选项`, "AVATAR_ASPECT_RATIO_UNSUPPORTED");
  }
}

async function buildAvatarBridgeRequest(
  context: AvatarGenerationContext,
  workflow: BridgeWorkflow,
  speechSlicePath: string
): Promise<{ fieldValues: Record<string, unknown>; files: Array<{ slot: BridgeItemSlot; path: string; mime: string }> }> {
  const referencePath = assetPath(context.snapshot, context.referenceImage);
  await Promise.all([assertReadableInput(referencePath, "人物肖像"), assertReadableInput(speechSlicePath, "局部 SpeechAsset")]);

  const fieldValues: Record<string, unknown> = {};
  const promptField = selectAvatarPromptField(workflow);
  fieldValues[promptField.id] = context.prompt;
  const durationField = workflow.fields.find((field) => /duration|second|seconds|时长|秒/u.test(normalizedFieldLabel(field)));
  if (durationField) fieldValues[durationField.id] = context.requestedDurationSeconds;
  setAspectRatioFields(fieldValues, workflow, context.snapshot.project.brief.aspectRatio);

  const imageSlot = selectExplicitAvatarSlot(workflow, "image", [/portrait/, /person/, /character/, /reference/, /参考/, /人物/, /image/], "portrait");
  const audioSlot = selectExplicitAvatarSlot(workflow, "audio", [/speech/, /voice/, /audio/, /声音/, /音频/, /参考/], "speech");
  const files = [
    { slot: imageSlot, path: referencePath, mime: mimeForPath(referencePath, "image/png") },
    { slot: audioSlot, path: speechSlicePath, mime: "audio/wav" }
  ];
  assertRequiredAvatarMediaSlotsCovered(workflow, files);
  return {
    fieldValues,
    files
  };
}

function avatarSpeechSlicePath(context: AvatarGenerationContext, job: JobRecord): string {
  const { startFrame, endFrame } = context.generationRange;
  return join(context.snapshot.project.rootPath, "cache", "avatar-generation", `${job.id}-${startFrame}-${endFrame}.wav`);
}

/**
 * 数字人局部重生成只能看到目标范围的旁白。这里按当前 Timeline 帧率裁出临时 WAV，
 * 避免把整条 SpeechAsset 作为“参考音频”错误上传，造成口型和局部范围不一致。
 */
async function prepareAvatarSpeechSlice(context: AvatarGenerationContext, job: JobRecord): Promise<string> {
  const sourcePath = assetPath(context.snapshot, context.speechFile);
  const targetPath = avatarSpeechSlicePath(context, job);
  await assertReadableInput(sourcePath, "SpeechAsset");
  await mkdir(dirname(targetPath), { recursive: true });
  await rm(targetPath, { force: true }).catch(() => undefined);
  const startSeconds = context.generationRange.startFrame / context.snapshot.timeline.fps;
  const durationSeconds = (context.generationRange.endFrame - context.generationRange.startFrame) / context.snapshot.timeline.fps;
  await runProcess("ffmpeg", [
    "-y",
    "-i", sourcePath,
    // 放在输入之后使用精确裁切；局部重生成不能因为快速 seek 多带入前后段旁白。
    "-ss", startSeconds.toFixed(3),
    "-t", durationSeconds.toFixed(3),
    "-vn",
    "-ac", "1",
    "-ar", "24000",
    "-c:a", "pcm_s16le",
    targetPath
  ], 5 * 60_000);
  const metadata = await probeMedia(targetPath);
  if (!metadata.hasAudio || metadata.durationMs <= 0) {
    throw new DomainError("按人物生成范围裁出的 SpeechAsset 为空或无音频", "AVATAR_SPEECH_SLICE_INVALID");
  }
  return targetPath;
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
      fileSlots: submission.request.files?.map((file) => ({ id: file.slot.id, kind: file.slot.kind, fileName: basename(file.path) })) ?? []
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

function videoOutput(run: BridgeRun): BridgeOutput {
  const output = run.outputs.find((candidate) => candidate.kind === "video" && Boolean(candidate.downloadUrl));
  if (!output) throw new DomainError("数字人 Bridge 任务已完成，但没有可下载的视频输出", "MISSING_AVATAR_OUTPUT");
  return output;
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

/** 下载 URL 有时会错误返回 HTML；先看文件头，再用 ffprobe 判定是否真是视频。 */
async function assertAvatarVideo(path: string, mime?: string): Promise<void> {
  const normalizedMime = mime?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedMime && normalizedMime !== "video/mp4") {
    throw new DomainError(`数字人输出必须为 video/mp4，当前为：${mime}`, "AVATAR_OUTPUT_CONTAINER_UNSUPPORTED");
  }
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new DomainError("数字人输出为空或不是文件", "AVATAR_OUTPUT_EMPTY");
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(Math.min(512, info.size));
    await handle.read(header, 0, header.length, 0);
    const leadingText = header.toString("utf8").trimStart().toLowerCase();
    if (leadingText.startsWith("<!doctype html") || leadingText.startsWith("<html") || leadingText.startsWith("<?xml")) {
      throw new DomainError("数字人下载结果是网页错误页，不是视频", "AVATAR_OUTPUT_HTML");
    }
  } finally {
    await handle.close();
  }
}

/**
 * 当前 Player/Render 的 Avatar 输入边界是 MP4 + H.264，音轨存在时为 AAC。
 * 不做隐式转码：生成画面默认静音，转码反而可能改变口型时长；不兼容输出应明确失败后重试 Provider。
 */
function assertRemotionPlayableAvatar(metadata: MediaMetadata): void {
  if (metadata.videoCodec?.toLowerCase() !== "h264"
    || (metadata.audioCodec !== undefined && metadata.audioCodec.toLowerCase() !== "aac")) {
    throw new DomainError("Avatar 输出不是当前 Remotion 可播放的 MP4/H.264（音轨存在时为 AAC）", "AVATAR_OUTPUT_CODEC_UNSUPPORTED");
  }
}

function avatarRelativePath(job: JobRecord, outputName: string): string {
  const extension = extname(outputName).toLowerCase();
  const safeName = safeFileName(basename(outputName, extension || undefined)) || "avatar";
  return join("assets", "avatar", `avatar-${job.id}-${safeName}.mp4`);
}

async function inspectAvatarFile(snapshot: ProjectSnapshot, relativePath: string): Promise<AvatarActorVideo | undefined> {
  const path = join(snapshot.project.rootPath, relativePath);
  try {
    await assertAvatarVideo(path);
    const metadata = await probeMedia(path);
    if (!metadata.videoCodec || metadata.durationMs <= 0) return undefined;
    assertRemotionPlayableAvatar(metadata);
    const contentHash = await hashFile(path);
    return {
      path,
      relativePath,
      name: basename(path),
      contentHash,
      sourceHash: contentHash,
      durationMs: metadata.durationMs,
      durationFrames: Math.max(1, millisecondsToFrames(metadata.durationMs, snapshot.timeline.fps)),
      metadata
    };
  } catch {
    return undefined;
  }
}

async function localizeAvatarOutput(
  bridge: ComfyUIBridgeClient,
  snapshot: ProjectSnapshot,
  job: JobRecord,
  output: BridgeOutput
): Promise<AvatarActorVideo> {
  const relativePath = avatarRelativePath(job, output.fileName ?? "avatar.mp4");
  const targetPath = join(snapshot.project.rootPath, relativePath);
  const existing = await inspectAvatarFile(snapshot, relativePath);
  if (existing) return existing;
  await mkdir(dirname(targetPath), { recursive: true });
  const partialPath = `${targetPath}.partial`;
  await rm(partialPath, { force: true }).catch(() => undefined);
  await rm(targetPath, { force: true }).catch(() => undefined);
  try {
    await bridge.downloadOutput(output, partialPath);
    await assertAvatarVideo(partialPath, output.mime);
    const metadata = await probeMedia(partialPath);
    if (!metadata.videoCodec || metadata.durationMs <= 0) {
      throw new DomainError("数字人输出无法被 ffprobe 识别为有效视频", "INVALID_AVATAR_OUTPUT");
    }
    assertRemotionPlayableAvatar(metadata);
    const contentHash = await hashFile(partialPath);
    await rename(partialPath, targetPath);
    return {
      path: targetPath,
      relativePath,
      name: basename(targetPath),
      contentHash,
      sourceHash: contentHash,
      durationMs: metadata.durationMs,
      durationFrames: Math.max(1, millisecondsToFrames(metadata.durationMs, snapshot.timeline.fps)),
      metadata
    };
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Bridge 重启后无法查询 run 时，只接受当前 Job 专属目录中的完整、可解码视频作为恢复依据。 */
async function findRecoveredAvatarVideo(snapshot: ProjectSnapshot, job: JobRecord): Promise<AvatarActorVideo | undefined> {
  const directory = avatarDirectory(snapshot);
  const prefix = `avatar-${job.id}-`;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || entry.name.endsWith(".partial")) continue;
    const inspected = await inspectAvatarFile(snapshot, join("assets", "avatar", entry.name));
    if (inspected) return inspected;
  }
  return undefined;
}

async function completeAvatarGeneration(
  application: EditingApplication,
  input: AvatarCompletionInput
): Promise<unknown> {
  const candidate = application as AvatarCompletionApplication;
  if (typeof candidate.completeAvatarGeneration !== "function") {
    throw new DomainError("当前 EditingApplication 尚未实现数字人结果写入", "AVATAR_COMPLETION_NOT_IMPLEMENTED");
  }
  return candidate.completeAvatarGeneration(input);
}

/** Job 只保存可定位的完成对象，不能把 Application 返回的完整 Revision Snapshot 再复制一份。 */
function completedAvatarResult(application: EditingApplication, job: JobRecord): Record<string, unknown> {
  const result = application.trackJob(job.id).result;
  const actorAssetId = result?.actorAssetId;
  const timelineItemId = result?.timelineItemId;
  const actorPerformanceId = result?.actorPerformanceId;
  const revision = result?.revision;
  if (typeof actorAssetId !== "string" || typeof timelineItemId !== "string" || typeof actorPerformanceId !== "string" || !Number.isInteger(revision)) {
    throw new DomainError("Avatar 结果已写入项目，但 Job 缺少可追溯的完成对象", "AVATAR_COMPLETION_RESULT_MISSING");
  }
  return { actorAssetId, timelineItemId, actorPerformanceId, revision };
}

/**
 * Application 的 Revision 提交与 Job 状态更新之间可能发生进程中断。此时结果已经在
 * Snapshot 中，但 Job 仍是 running；必须先从项目对象恢复成功，不可因新 Revision 再次调用 Provider。
 */
function recoverCompletedProjectWrite(application: EditingApplication, job: JobRecord): Record<string, unknown> | undefined {
  const state = application.readProject(job.projectId);
  const performance = state.snapshot.actorPerformances.find((candidate) => candidate.generationJobId === job.id);
  if (!performance) return undefined;
  const timelineItem = state.snapshot.timeline.items.find((candidate) => candidate.id === performance.timelineItemId);
  if (!timelineItem) return undefined;
  const asset = state.snapshot.assets.find((candidate) => candidate.id === timelineItem.assetId);
  if (!asset) return undefined;
  const recordedPerformanceId = job.result?.actorPerformanceId;
  const recordedItemId = job.result?.timelineItemId;
  const recordedAssetId = job.result?.actorAssetId;
  // 有已写入的 Job 结果时也交叉核对，避免把损坏或手工篡改的引用当作已完成任务。
  if ((typeof recordedPerformanceId === "string" && recordedPerformanceId !== performance.id)
    || (typeof recordedItemId === "string" && recordedItemId !== timelineItem.id)
    || (typeof recordedAssetId === "string" && recordedAssetId !== asset.id)) {
    return undefined;
  }
  const result: Record<string, unknown> = {
    jobId: job.id,
    actorAssetId: asset.id,
    timelineItemId: timelineItem.id,
    actorPerformanceId: performance.id,
    revision: state.revision.number,
    actorVideo: {
      relativePath: asset.managedPath,
      contentHash: asset.sourceHash,
      durationMs: asset.metadata?.durationMs
    },
    recoveredProjectWrite: true
  };
  if (performance.bridgeAudit?.runId) result.runId = performance.bridgeAudit.runId;
  return result;
}

/**
 * H3 多参考工作流的真实执行链：每次提交都重新读 Schema；先持久化 run 审计，
 * 再轮询、下载、ffprobe 和哈希，最后把受管文件交给 Application 原子写入。
 */
export async function runAvatarGeneration(
  application: EditingApplication,
  job: JobRecord,
  bridge: ComfyUIBridgeClient
): Promise<Record<string, unknown>> {
  if (job.kind !== "avatar_generation") throw new DomainError("数字人 Worker 收到了错误的任务类型", "INVALID_AVATAR_JOB");
  const recoveredProjectWrite = recoverCompletedProjectWrite(application, job);
  if (recoveredProjectWrite) return recoveredProjectWrite;
  const context = resolveAvatarContext(application, job);
  const previousAudit = latestBridgeAudit(job, context.profile.workflowId);

  if (previousAudit) {
    try {
      const completed = await bridge.waitForRun(previousAudit.runId);
      const audit = completedAudit(previousAudit, completed);
      await application.recordBridgeRun(job.id, audit);
      const actorVideo = await localizeAvatarOutput(bridge, context.snapshot, job, videoOutput(completed));
      await completeAvatarGeneration(application, { projectId: job.projectId, jobId: job.id, actorVideo, bridgeAudit: audit });
      return { jobId: job.id, runId: completed.id, actorVideo, ...completedAvatarResult(application, job), recoveredExistingRun: true };
    } catch (error) {
      if (!(error instanceof BridgeRunLostError)) throw error;
      const actorVideo = await findRecoveredAvatarVideo(context.snapshot, job);
      if (actorVideo) {
        // 远端状态不可查，但文件已经通过本地 ffprobe 和哈希；保留原审计，不伪造 completedAt。
        await completeAvatarGeneration(application, { projectId: job.projectId, jobId: job.id, actorVideo, bridgeAudit: previousAudit });
        return { jobId: job.id, runId: previousAudit.runId, actorVideo, ...completedAvatarResult(application, job), recoveredLocalOutput: true };
      }
      // 既没有可查询 Run，也没有本地产物；下面才会重新读取 Schema 并安全重提。
    }
  }

  const submittedAt = new Date().toISOString();
  const speechSlicePath = await prepareAvatarSpeechSlice(context, job);
  let submission: BridgeRunSubmission;
  try {
    submission = await bridge.createRunWithSchemaRetry(
      context.profile.workflowId,
      async (workflow) => buildAvatarBridgeRequest(context, workflow, speechSlicePath)
    );
  } finally {
    // Bridge.createRun 在返回前已读取 multipart 二进制；临时局部音频不应长期占用项目空间。
    await rm(speechSlicePath, { force: true }).catch(() => undefined);
  }
  await application.recordBridgeRun(job.id, createBridgeAudit(submission, undefined, submittedAt));
  const completed = await bridge.waitForRun(submission.run.id);
  const audit = createBridgeAudit(submission, completed, submittedAt);
  await application.recordBridgeRun(job.id, audit);
  const actorVideo = await localizeAvatarOutput(bridge, context.snapshot, job, videoOutput(completed));
  await completeAvatarGeneration(application, { projectId: job.projectId, jobId: job.id, actorVideo, bridgeAudit: audit });
  return { jobId: job.id, runId: completed.id, actorVideo, ...completedAvatarResult(application, job) };
}
