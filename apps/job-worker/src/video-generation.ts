import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
import type { Asset, BridgeRunAudit, JobRecord, MediaMetadata, ProjectSnapshot } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import { probeMedia } from "@videocut/speech";

/**
 * 这份模块只负责 MiniMax H3 视频生成的 Worker 侧事实：动态 Schema、受管输入、
 * Bridge 审计、下载与二进制核验。Project Revision、AssetRequest 和 Timeline 的写入
 * 仍由 EditingApplication 的 completeVideoGeneration 原子完成。
 */
export const VIDEO_GENERATION_JOB_KIND = "video_generation" as const;

export type MiniMaxVideoGenerationMode =
  | "text_to_video"
  | "image_to_video"
  | "first_last_frame"
  | "multi_reference";

/**
 * Application 提交给 Worker 的窄合同。inputAssetIds 的语义由 mode 固定：
 * - text_to_video：空数组；
 * - image_to_video：[首帧图片]；
 * - first_last_frame：[首帧图片，尾帧图片]；
 * - multi_reference：任意顺序的最多 6 张图片、1 条参考视频和 3 条参考音频，
 *   同类素材在数组中的顺序会对应动态 Schema 中同类 Slot 的顺序。
 *
 * workflowId 是调用侧明确确认的真实 Bridge 工作流，不把文档中的历史 ID 当成永久 Schema。
 */
export interface VideoGenerationJobPayload {
  requestedRevision: number;
  workflowId: string;
  mode: MiniMaxVideoGenerationMode;
  inputAssetIds: string[];
  prompt: string;
  durationSeconds: number;
  /** 仅允许等于当前 Project Brief；省略时自动采用 Brief。 */
  aspectRatio?: "9:16" | "16:9" | "1:1";
  outputSlotId?: string;
  /** 可选但建议固定，以便同一 Job 的 Bridge 审计能完整回溯。 */
  seed?: number;
  /** 单阶段工作流的目标清晰度（百万像素）。 */
  megapixels?: number;
  /** 多参考工作流的初采/二采参数；不传则严格沿用当前 Workflow 默认值。 */
  initialSeed?: number;
  finalSeed?: number;
  initialMegapixels?: number;
  finalMegapixels?: number;
  /** 由 Application 用于关联生成降级的 AssetRequest；Worker 不改变其状态。 */
  assetRequestId?: string;
}

export interface GeneratedVideo {
  path: string;
  relativePath: string;
  name: string;
  contentHash: string;
  sourceHash: string;
  durationMs: number;
  metadata: MediaMetadata;
}

export interface VideoGenerationCompletionInput {
  projectId: string;
  jobId: string;
  generatedVideo: GeneratedVideo;
  bridgeAudit: BridgeRunAudit;
}

type VideoCompletionApplication = EditingApplication & {
  completeVideoGeneration(input: VideoGenerationCompletionInput): unknown | Promise<unknown>;
};

export interface VideoGenerationContext {
  snapshot: ProjectSnapshot;
  requestedRevision: number;
  workflowId: string;
  mode: MiniMaxVideoGenerationMode;
  inputAssets: Asset[];
  prompt: string;
  durationSeconds: number;
  aspectRatio: ProjectSnapshot["project"]["brief"]["aspectRatio"];
  outputSlotId?: string;
  seed?: number;
  megapixels?: number;
  initialSeed?: number;
  finalSeed?: number;
  initialMegapixels?: number;
  finalMegapixels?: number;
}

type PreparedInputAsset = {
  asset: Asset;
  path: string;
  mediaKind: "image" | "video" | "audio";
};

const MAX_BRIDGE_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_GENERATED_VIDEO_BYTES = readRuntimeConfig().downloads.maxGeneratedVideoBytes;
const generatedVideoDirectory = (snapshot: ProjectSnapshot) => join(snapshot.project.rootPath, "assets", "generated");
const safeFileName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");

function requireText(value: unknown, message: string, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DomainError(message, code);
  return value.trim();
}

function requirePositiveInteger(value: unknown, message: string, code: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new DomainError(message, code);
  return number;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new DomainError(`${label}必须是非负整数`, "VIDEO_GENERATION_OPTION_INVALID");
  return number;
}

function optionalMegapixels(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0.1 || number > 16) {
    throw new DomainError(`${label}必须在 0.1 到 16 百万像素之间`, "VIDEO_GENERATION_OPTION_INVALID");
  }
  return number;
}

function modeFromPayload(value: unknown): MiniMaxVideoGenerationMode {
  if (value === "text_to_video" || value === "image_to_video" || value === "first_last_frame" || value === "multi_reference") return value;
  throw new DomainError("视频生成任务缺少受支持的 mode", "VIDEO_GENERATION_MODE_INVALID");
}

function inputAssetIdsFromPayload(value: unknown): string[] {
  if (!Array.isArray(value)) throw new DomainError("视频生成任务缺少 inputAssetIds", "VIDEO_GENERATION_INPUTS_REQUIRED");
  const ids = value.map((entry) => typeof entry === "string" ? entry.trim() : "");
  if (ids.some((id) => !id)) throw new DomainError("视频生成 inputAssetIds 必须全部为非空 Asset ID", "VIDEO_GENERATION_INPUTS_INVALID");
  if (new Set(ids).size !== ids.length) throw new DomainError("同一视频生成任务不能重复引用同一个输入 Asset", "VIDEO_GENERATION_INPUTS_DUPLICATED");
  if (ids.length > 10) throw new DomainError("多参考视频最多接受 10 个输入素材", "VIDEO_GENERATION_INPUTS_TOO_MANY");
  return ids;
}

function visualImageAsset(asset: Asset): boolean {
  if (asset.kind === "image") {
    return Boolean(asset.metadata?.videoCodec && asset.metadata.width && asset.metadata.height);
  }
  // Derived 可能是截图也可能是视频；只在它有视觉流且没有有效时长时把它当作静态帧。
  return asset.kind === "derived" && Boolean(asset.metadata?.videoCodec) && !(asset.metadata?.durationMs && asset.metadata.durationMs > 0);
}

function visualVideoAsset(asset: Asset): boolean {
  if (asset.kind === "video" || asset.kind === "actor_video") {
    return Boolean(asset.metadata?.videoCodec && asset.metadata.durationMs && asset.metadata.durationMs > 0);
  }
  const durationMs = asset.metadata?.durationMs ?? 0;
  return asset.kind === "derived" && Boolean(asset.metadata?.videoCodec) && durationMs > 0;
}

function audioAsset(asset: Asset): boolean {
  return (asset.kind === "audio" || asset.kind === "speech") && Boolean(asset.metadata?.hasAudio);
}

function assertUsableInputAsset(asset: Asset, usage: string): void {
  if (asset.status !== "ready") throw new DomainError(`${usage}必须是已就绪的本地 Asset`, "VIDEO_GENERATION_INPUT_NOT_READY");
}

function classifyMultiReferenceInputs(inputAssets: Asset[]): { images: Asset[]; videos: Asset[]; audio: Asset[] } {
  const images: Asset[] = [];
  const videos: Asset[] = [];
  const audio: Asset[] = [];
  for (const asset of inputAssets) {
    if (visualImageAsset(asset)) images.push(asset);
    else if (visualVideoAsset(asset)) videos.push(asset);
    else if (audioAsset(asset)) audio.push(asset);
    else throw new DomainError(`多参考输入“${asset.name}”不是已分析的图片、视频或音频`, "VIDEO_GENERATION_INPUT_KIND_INVALID");
  }
  if (images.length > 6 || videos.length > 1 || audio.length > 3) {
    throw new DomainError("多参考视频最多接受 6 张图片、1 条视频和 3 条音频", "VIDEO_GENERATION_MULTI_REFERENCE_LIMIT");
  }
  return { images, videos, audio };
}

function assertModeInputs(mode: MiniMaxVideoGenerationMode, inputAssets: Asset[]): void {
  for (const asset of inputAssets) assertUsableInputAsset(asset, "生成输入素材");
  if (mode === "text_to_video") {
    if (inputAssets.length !== 0) throw new DomainError("文生视频不接受输入 Asset", "VIDEO_GENERATION_TEXT_INPUTS_FORBIDDEN");
    return;
  }
  if (mode === "image_to_video") {
    if (inputAssets.length !== 1 || !visualImageAsset(inputAssets[0]!)) {
      throw new DomainError("图生视频必须且只能提供一张已就绪的首帧图片", "VIDEO_GENERATION_IMAGE_INPUT_REQUIRED");
    }
    return;
  }
  if (mode === "first_last_frame") {
    if (inputAssets.length !== 2 || inputAssets.some((asset) => !visualImageAsset(asset))) {
      throw new DomainError("首尾帧生视频必须按顺序提供首帧和尾帧两张已就绪图片", "VIDEO_GENERATION_FIRST_LAST_INPUT_REQUIRED");
    }
    return;
  }
  classifyMultiReferenceInputs(inputAssets);
}

/**
 * 从 Job 和当前 Project 建立执行上下文。提交外部付费任务前必须拒绝已过期 Revision，
 * 避免主线变化后仍生成已失效的画面。
 */
export function resolveVideoGenerationContext(application: EditingApplication, job: JobRecord): VideoGenerationContext {
  if (String(job.kind) !== VIDEO_GENERATION_JOB_KIND) {
    throw new DomainError("视频生成 Worker 收到了错误的任务类型", "INVALID_VIDEO_GENERATION_JOB");
  }
  const state = application.readProject(job.projectId);
  const payload = job.payload as Partial<VideoGenerationJobPayload>;
  const requestedRevision = requirePositiveInteger(payload.requestedRevision, "视频生成任务缺少受管的请求 Revision", "VIDEO_GENERATION_JOB_PAYLOAD_INVALID");
  if (requestedRevision !== state.revision.number) {
    throw new DomainError("项目 Revision 已变化，不能继续向视频 Provider 提交旧请求", "STALE_VIDEO_GENERATION_REQUEST");
  }
  const mode = modeFromPayload(payload.mode);
  const inputAssetIds = inputAssetIdsFromPayload(payload.inputAssetIds);
  const inputAssets = inputAssetIds.map((assetId) => {
    const asset = state.snapshot.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new DomainError(`视频生成输入 Asset 不存在：${assetId}`, "VIDEO_GENERATION_INPUT_NOT_FOUND");
    return asset;
  });
  assertModeInputs(mode, inputAssets);
  const requestedAspect = payload.aspectRatio;
  if (requestedAspect !== undefined && requestedAspect !== state.snapshot.project.brief.aspectRatio) {
    throw new DomainError("生成画面比例必须与当前 Project Brief 一致，不能在 Worker 中悄悄改画幅", "VIDEO_GENERATION_ASPECT_RATIO_MISMATCH");
  }
  const durationSeconds = requirePositiveInteger(payload.durationSeconds, "视频生成时长必须是正整数秒", "VIDEO_GENERATION_DURATION_INVALID");
  if (durationSeconds > 1_800) throw new DomainError("单次视频生成时长不能超过 1800 秒", "VIDEO_GENERATION_DURATION_EXCEEDS_LIMIT");
  return {
    snapshot: state.snapshot,
    requestedRevision,
    workflowId: requireText(payload.workflowId, "视频生成任务缺少明确的 Bridge workflowId", "VIDEO_GENERATION_WORKFLOW_ID_REQUIRED"),
    mode,
    inputAssets,
    prompt: requireText(payload.prompt, "视频生成任务缺少明确提示词", "VIDEO_GENERATION_PROMPT_REQUIRED"),
    durationSeconds,
    aspectRatio: state.snapshot.project.brief.aspectRatio,
    outputSlotId: typeof payload.outputSlotId === "string" && payload.outputSlotId.trim() ? payload.outputSlotId.trim() : undefined,
    seed: optionalNonNegativeInteger(payload.seed, "随机种子"),
    megapixels: optionalMegapixels(payload.megapixels, "清晰度"),
    initialSeed: optionalNonNegativeInteger(payload.initialSeed, "初采随机种子"),
    finalSeed: optionalNonNegativeInteger(payload.finalSeed, "二采随机种子"),
    initialMegapixels: optionalMegapixels(payload.initialMegapixels, "初采清晰度"),
    finalMegapixels: optionalMegapixels(payload.finalMegapixels, "最终清晰度")
  };
}

function normalizedLabel(value: { label: string; kind?: string }): string {
  return `${value.label} ${value.kind ?? ""}`.trim().toLocaleLowerCase();
}

function isNegativePromptField(field: BridgeWorkflowField): boolean {
  return /(?:negative|neg_prompt|exclude|forbid|反向|负面|排除|不要)/u.test(normalizedLabel(field));
}

/** 只接受唯一最高优先级字段，避免把提示词写进反向提示词或把时长写进上限字段。 */
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
  const label = normalizedLabel(field);
  if (/^(?:prompt|提示词)(?:\s|$)/u.test(label)) return 100;
  if (/(?:video|image|画面|视频|图像).*(?:prompt|description|提示词|描述)/u.test(label)) return 95;
  if (/(?:prompt|提示词)/u.test(label)) return 90;
  if (/(?:description|描述)/u.test(label)) return 70;
  return 0;
}

function durationFieldScore(field: BridgeWorkflowField): number {
  const label = normalizedLabel(field);
  if (/(?:max|min|minimum|maximum|最大|最小|范围|range)/u.test(label)) return 0;
  if (/^(?:duration|length|时长|长度)(?:\s|$)/u.test(label)) return 100;
  if (/(?:duration|length|seconds?|时长|秒数|长度)/u.test(label)) return 80;
  return 0;
}

function aspectRatioFields(workflow: BridgeWorkflow): BridgeWorkflowField[] {
  return workflow.fields.filter((field) => /(?:aspect.*ratio|ratio.*aspect|画面比例|画幅|比例)/u.test(normalizedLabel(field)));
}

function optionForAspectRatio(field: BridgeWorkflowField, aspectRatio: string): unknown {
  const matching = (field.options ?? []).filter((option) => `${option.label} ${option.value}`.includes(aspectRatio));
  if (matching.length !== 1) {
    throw new DomainError(`Bridge 当前 Schema 的“${field.label}”没有唯一的 ${aspectRatio} 画幅选项`, "VIDEO_GENERATION_ASPECT_RATIO_UNSUPPORTED");
  }
  return matching[0]!.value;
}

function optionValueForNumber(field: BridgeWorkflowField, value: number, label: string): unknown {
  if (!field.options?.length) return value;
  const matching = field.options.filter((option) => Number(option.value) === value || Number(option.label) === value);
  if (matching.length !== 1) {
    throw new DomainError(`Bridge 当前 Schema 的“${field.label}”没有精确的 ${value} ${label}选项`, "VIDEO_GENERATION_OPTION_UNSUPPORTED");
  }
  return matching[0]!.value;
}

function fieldsMatching(workflow: BridgeWorkflow, pattern: RegExp): BridgeWorkflowField[] {
  return workflow.fields.filter((field) => pattern.test(normalizedLabel(field)));
}

function fieldsInWorkflowOrder<T extends { id: string; label: string }>(fields: T[]): T[] {
  const numbered = fields.map((field, index) => {
    const matched = field.label.match(/(?:^|\D)([1-9]\d*)(?:\D|$)/u);
    return { field, index, number: matched ? Number(matched[1]) : undefined };
  });
  // 有明确序号时优先序号；没有序号时严格保留 Bridge 返回顺序，便于审计和测试复现。
  return numbered.sort((left, right) => {
    if (left.number !== undefined && right.number !== undefined) return left.number - right.number || left.index - right.index;
    if (left.number !== undefined) return -1;
    if (right.number !== undefined) return 1;
    return left.index - right.index;
  }).map((entry) => entry.field);
}

function applySingleOptionalField(
  fieldValues: Record<string, unknown>,
  workflow: BridgeWorkflow,
  pattern: RegExp,
  value: number | undefined,
  label: string
): void {
  if (value === undefined) return;
  const fields = fieldsMatching(workflow, pattern);
  if (fields.length !== 1) {
    throw new DomainError(`Bridge 当前 Schema 无法唯一匹配${label}字段`, "VIDEO_GENERATION_OPTION_FIELD_AMBIGUOUS");
  }
  fieldValues[fields[0]!.id] = optionValueForNumber(fields[0]!, value, label);
}

function applyMultiPassOptionalFields(
  fieldValues: Record<string, unknown>,
  workflow: BridgeWorkflow,
  pattern: RegExp,
  common: number | undefined,
  initial: number | undefined,
  final: number | undefined,
  label: string
): void {
  if (common === undefined && initial === undefined && final === undefined) return;
  const fields = fieldsInWorkflowOrder(fieldsMatching(workflow, pattern));
  if (fields.length !== 2) {
    throw new DomainError(`Bridge 当前多参考 Schema 无法确认初采和最终${label}字段`, "VIDEO_GENERATION_OPTION_FIELD_AMBIGUOUS");
  }
  const initialField = fields.find((field) => /(?:初采|initial|first\s*pass|第一)/u.test(normalizedLabel(field))) ?? fields[0]!;
  const finalField = fields.find((field) => /(?:最终|final|second\s*pass|二采|第二)/u.test(normalizedLabel(field))) ?? fields[1]!;
  if (initialField.id === finalField.id) throw new DomainError(`Bridge 当前多参考 Schema 无法区分初采和最终${label}`, "VIDEO_GENERATION_OPTION_FIELD_AMBIGUOUS");
  const initialValue = initial ?? common;
  const finalValue = final ?? common;
  if (initialValue !== undefined) fieldValues[initialField.id] = optionValueForNumber(initialField, initialValue, label);
  if (finalValue !== undefined) fieldValues[finalField.id] = optionValueForNumber(finalField, finalValue, label);
}

function mimeForAsset(asset: Asset, path: string, fallback: string): string {
  const fromMetadata = asset.metadata?.mime?.split(";", 1)[0]?.trim();
  if (fromMetadata) return fromMetadata;
  const extension = extname(path).toLocaleLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".avif") return "image/avif";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".webm") return "video/webm";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".flac") return "audio/flac";
  if (extension === ".m4a") return "audio/mp4";
  return fallback;
}

function resolvedManagedPath(snapshot: ProjectSnapshot, asset: Asset): string {
  const root = resolve(snapshot.project.rootPath);
  const path = resolve(isAbsolute(asset.managedPath) ? asset.managedPath : join(root, asset.managedPath));
  const relativePath = relative(root, path);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${String.fromCharCode(92)}`) || relativePath.startsWith("../")) {
    throw new DomainError(`生成输入 Asset“${asset.name}”不在当前项目受管目录中`, "VIDEO_GENERATION_INPUT_PATH_INVALID");
  }
  return path;
}

async function prepareInputAsset(snapshot: ProjectSnapshot, asset: Asset): Promise<PreparedInputAsset> {
  const path = resolvedManagedPath(snapshot, asset);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size <= 0) {
    throw new DomainError(`生成输入 Asset“${asset.name}”对应的本地文件不存在或为空`, "VIDEO_GENERATION_INPUT_FILE_INVALID");
  }
  if (info.size > MAX_BRIDGE_INPUT_BYTES) {
    throw new DomainError(`生成输入 Asset“${asset.name}”超过 Bridge 单文件 512MB 限制`, "VIDEO_GENERATION_INPUT_FILE_TOO_LARGE");
  }
  if (visualImageAsset(asset)) return { asset, path, mediaKind: "image" };
  if (visualVideoAsset(asset)) return { asset, path, mediaKind: "video" };
  if (audioAsset(asset)) return { asset, path, mediaKind: "audio" };
  throw new DomainError(`生成输入 Asset“${asset.name}”不是可用的图片、视频或音频`, "VIDEO_GENERATION_INPUT_KIND_INVALID");
}

function uniqueSlotByLabel(
  workflow: BridgeWorkflow,
  kind: BridgeItemSlot["kind"],
  pattern: RegExp,
  role: string,
  fallbackOnlySlot = false
): BridgeItemSlot {
  const slots = workflow.itemSlots.filter((slot) => slot.kind === kind);
  const matched = slots.filter((slot) => pattern.test(normalizedLabel(slot)));
  if (matched.length === 1) return matched[0]!;
  if (matched.length === 0 && fallbackOnlySlot && slots.length === 1) return slots[0]!;
  throw new DomainError(`Bridge 当前 Schema 无法唯一匹配${role} ${kind} 输入槽`, "VIDEO_GENERATION_SLOT_AMBIGUOUS");
}

function firstAndLastImageSlots(workflow: BridgeWorkflow): { first: BridgeItemSlot; last: BridgeItemSlot } {
  const images = workflow.itemSlots.filter((slot) => slot.kind === "image");
  const firstCandidates = images.filter((slot) => /(?:首帧|首图|首张|first\s*(?:frame|image)|start\s*(?:frame|image))/u.test(normalizedLabel(slot)));
  const lastCandidates = images.filter((slot) => /(?:尾帧|末帧|尾图|last\s*(?:frame|image)|end\s*(?:frame|image))/u.test(normalizedLabel(slot)));
  if (firstCandidates.length === 1 && lastCandidates.length === 1 && firstCandidates[0]!.id !== lastCandidates[0]!.id) {
    return { first: firstCandidates[0]!, last: lastCandidates[0]! };
  }
  // 仅在 Schema 恰好只有两个图片槽且没有可解释标签时，允许按 Bridge 声明顺序映射。
  if (firstCandidates.length === 0 && lastCandidates.length === 0 && images.length === 2) {
    return { first: images[0]!, last: images[1]! };
  }
  throw new DomainError("Bridge 当前 Schema 无法区分首帧和尾帧输入槽", "VIDEO_GENERATION_FIRST_LAST_SLOT_AMBIGUOUS");
}

function requiredSlotsAreCovered(workflow: BridgeWorkflow, files: Array<{ slot: BridgeItemSlot }>): void {
  const uploaded = new Set(files.map((file) => file.slot.id));
  const missing = workflow.itemSlots.filter((slot) => slot.required && !uploaded.has(slot.id));
  if (missing.length > 0) {
    throw new DomainError(`Bridge 当前 Schema 存在未处理的必填输入槽：${missing.map((slot) => slot.label).join("、")}`, "VIDEO_GENERATION_REQUIRED_SLOT_UNHANDLED");
  }
}

function outputSlotExists(workflow: BridgeWorkflow, outputSlotId: string | undefined): void {
  if (outputSlotId && !workflow.outputs.some((output) => output.id === outputSlotId)) {
    throw new DomainError("指定的视频输出槽不在当前 Bridge Schema 中", "VIDEO_GENERATION_OUTPUT_SLOT_NOT_FOUND");
  }
}

/**
 * 不保存任何历史 field/slot ID。每次创建 Run 前均依据本次读取的 Schema、Slot 标签和顺序
 * 重新匹配，且遇到歧义直接失败，而不是把参考图/音频静默上传给错误节点。
 */
export async function buildVideoGenerationBridgeRequest(
  context: VideoGenerationContext,
  workflow: BridgeWorkflow
): Promise<{ fieldValues: Record<string, unknown>; files: Array<{ slot: BridgeItemSlot; path: string; mime: string }> }> {
  outputSlotExists(workflow, context.outputSlotId);
  const promptField = chooseUniqueField(
    workflow,
    promptFieldScore,
    "Bridge 当前视频工作流没有可确认的正向提示词字段",
    "VIDEO_GENERATION_PROMPT_FIELD_MISSING",
    "Bridge 当前视频工作流存在多个同优先级提示词字段",
    "VIDEO_GENERATION_PROMPT_FIELD_AMBIGUOUS"
  );
  const durationField = chooseUniqueField(
    workflow,
    durationFieldScore,
    "Bridge 当前视频工作流没有可确认的时长字段",
    "VIDEO_GENERATION_DURATION_FIELD_MISSING",
    "Bridge 当前视频工作流存在多个同优先级时长字段",
    "VIDEO_GENERATION_DURATION_FIELD_AMBIGUOUS"
  );
  const ratioFields = aspectRatioFields(workflow);
  if (ratioFields.length === 0) throw new DomainError("Bridge 当前视频工作流没有可确认的画幅字段", "VIDEO_GENERATION_ASPECT_RATIO_FIELD_MISSING");
  const fieldValues: Record<string, unknown> = {
    [promptField.id]: context.prompt,
    [durationField.id]: optionValueForNumber(durationField, context.durationSeconds, "秒")
  };
  for (const field of ratioFields) fieldValues[field.id] = optionForAspectRatio(field, context.aspectRatio);

  const qualityPattern = /(?:quality|resolution|megapixel|清晰度|像素)/u;
  const seedPattern = /(?:seed|随机种子)/u;
  if (context.mode === "multi_reference") {
    applyMultiPassOptionalFields(fieldValues, workflow, qualityPattern, context.megapixels, context.initialMegapixels, context.finalMegapixels, "清晰度");
    applyMultiPassOptionalFields(fieldValues, workflow, seedPattern, context.seed, context.initialSeed, context.finalSeed, "随机种子");
  } else {
    applySingleOptionalField(fieldValues, workflow, qualityPattern, context.megapixels, "清晰度");
    applySingleOptionalField(fieldValues, workflow, seedPattern, context.seed, "随机种子");
  }

  const prepared = await Promise.all(context.inputAssets.map((asset) => prepareInputAsset(context.snapshot, asset)));
  const files: Array<{ slot: BridgeItemSlot; path: string; mime: string }> = [];
  const addFile = (slot: BridgeItemSlot, input: PreparedInputAsset) => {
    files.push({ slot, path: input.path, mime: mimeForAsset(input.asset, input.path, `${input.mediaKind}/*`) });
  };

  if (context.mode === "image_to_video") {
    const first = prepared[0]!;
    const slot = uniqueSlotByLabel(workflow, "image", /(?:首帧|首图|首张|first\s*(?:frame|image)|reference\s*image)/u, "首帧", true);
    addFile(slot, first);
  } else if (context.mode === "first_last_frame") {
    const slots = firstAndLastImageSlots(workflow);
    addFile(slots.first, prepared[0]!);
    addFile(slots.last, prepared[1]!);
  } else if (context.mode === "multi_reference") {
    const images = prepared.filter((entry) => entry.mediaKind === "image");
    const videos = prepared.filter((entry) => entry.mediaKind === "video");
    const audio = prepared.filter((entry) => entry.mediaKind === "audio");
    const imageSlots = fieldsInWorkflowOrder(workflow.itemSlots.filter((slot) => slot.kind === "image"));
    const audioSlots = fieldsInWorkflowOrder(workflow.itemSlots.filter((slot) => slot.kind === "audio"));
    if (images.length > imageSlots.length || audio.length > audioSlots.length) {
      throw new DomainError("Bridge 当前多参考 Schema 的图片或音频输入槽数量不足", "VIDEO_GENERATION_MULTI_REFERENCE_SLOT_MISSING");
    }
    for (const [index, input] of images.entries()) addFile(imageSlots[index]!, input);
    for (const [index, input] of audio.entries()) addFile(audioSlots[index]!, input);
    if (videos.length === 1) {
      const slot = uniqueSlotByLabel(workflow, "video", /(?:参考视频|reference\s*video|video\s*reference)/u, "参考视频", true);
      addFile(slot, videos[0]!);
    }
  }
  requiredSlotsAreCovered(workflow, files);
  return { fieldValues, files };
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

function normalizedOutputMime(mime: string | undefined): string | undefined {
  const normalized = mime?.split(";", 1)[0]?.trim().toLocaleLowerCase();
  return normalized || undefined;
}

function isVideoOutput(output: BridgeOutput): boolean {
  const mime = normalizedOutputMime(output.mime);
  return output.kind === "video" || Boolean(mime?.startsWith("video/"));
}

/** 多个可下载视频时必须由提交侧固定 outputSlotId，不能猜“第一个”是最终成片。 */
export function selectGeneratedVideoOutput(run: BridgeRun, outputSlotId?: string): BridgeOutput {
  const available = run.outputs.filter((output) => isVideoOutput(output) && Boolean(output.downloadUrl));
  if (outputSlotId) {
    const selected = available.find((output) => output.outputSlotId === outputSlotId);
    if (!selected) throw new DomainError("Bridge 已完成，但指定的视频输出槽没有可下载视频", "VIDEO_GENERATION_OUTPUT_SLOT_MISSING");
    return selected;
  }
  if (available.length === 0) throw new DomainError("Bridge 已完成，但没有可下载的视频输出", "MISSING_VIDEO_GENERATION_OUTPUT");
  if (available.length > 1) throw new DomainError("Bridge 返回多个视频输出；提交任务时必须指定 outputSlotId", "VIDEO_GENERATION_OUTPUT_AMBIGUOUS");
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

/**
 * 当前 Web Player / Render 对 MiniMax 生成素材采用保守边界：MP4/H.264，若含音轨则 AAC。
 * 不在 Worker 中隐式转码，避免把 Provider 失败、时长变化或音画问题伪装成可交付素材。
 */
export async function inspectGeneratedVideoFile(path: string, outputMime?: string): Promise<Pick<GeneratedVideo, "contentHash" | "sourceHash" | "durationMs" | "metadata">> {
  const mime = normalizedOutputMime(outputMime);
  if (mime && mime !== "video/mp4") {
    throw new DomainError(`视频输出 MIME 必须为 video/mp4，当前为：${outputMime}`, "VIDEO_GENERATION_OUTPUT_MIME_UNSUPPORTED");
  }
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new DomainError("视频输出为空或不是文件", "VIDEO_GENERATION_OUTPUT_EMPTY");
  if (!Number.isFinite(MAX_GENERATED_VIDEO_BYTES) || MAX_GENERATED_VIDEO_BYTES < 1 || info.size > MAX_GENERATED_VIDEO_BYTES) {
    throw new DomainError("视频输出超过本地受管文件大小上限", "VIDEO_GENERATION_OUTPUT_TOO_LARGE");
  }
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(Math.min(512, info.size));
    await handle.read(header, 0, header.length, 0);
    const leadingText = header.toString("utf8").trimStart().toLocaleLowerCase();
    if (/^(?:<!doctype\s+html|<html(?:\s|>)|<\?xml)/u.test(leadingText)) {
      throw new DomainError("视频下载结果是网页错误页，不是视频", "VIDEO_GENERATION_OUTPUT_HTML");
    }
  } finally {
    await handle.close();
  }
  const metadata = await probeMedia(path);
  if (!metadata.videoCodec || metadata.durationMs <= 0) {
    throw new DomainError("视频输出无法被 ffprobe 识别为有效视觉流", "VIDEO_GENERATION_OUTPUT_VISUAL_STREAM_MISSING");
  }
  if (metadata.videoCodec.toLocaleLowerCase() !== "h264"
    || (metadata.audioCodec !== undefined && metadata.audioCodec.toLocaleLowerCase() !== "aac")) {
    throw new DomainError("视频输出不是当前 Player/Render 支持的 MP4/H.264（音轨存在时为 AAC）", "VIDEO_GENERATION_OUTPUT_CODEC_UNSUPPORTED");
  }
  const contentHash = await hashFile(path);
  return { contentHash, sourceHash: contentHash, durationMs: metadata.durationMs, metadata };
}

function generatedRelativePath(job: JobRecord, output: BridgeOutput): string {
  const original = basename(output.fileName ?? "generated-video.mp4");
  const stem = safeFileName(basename(original, extname(original))) || "generated-video";
  return join("assets", "generated", `video-${job.id}-${stem}.mp4`);
}

async function inspectExistingGeneratedVideo(snapshot: ProjectSnapshot, relativePath: string): Promise<GeneratedVideo | undefined> {
  const path = join(snapshot.project.rootPath, relativePath);
  try {
    const inspected = await inspectGeneratedVideoFile(path);
    return { path, relativePath, name: basename(path), ...inspected };
  } catch {
    return undefined;
  }
}

/** 下载先进入 Job 专属缓存；仅在 HTML、大小、ffprobe、编码和哈希都通过后才原子移动到 assets/generated。 */
export async function localizeGeneratedVideo(
  bridge: ComfyUIBridgeClient,
  snapshot: ProjectSnapshot,
  job: JobRecord,
  output: BridgeOutput
): Promise<GeneratedVideo> {
  const relativePath = generatedRelativePath(job, output);
  const targetPath = join(snapshot.project.rootPath, relativePath);
  const existing = await inspectExistingGeneratedVideo(snapshot, relativePath);
  if (existing) return existing;
  const cachePath = join(snapshot.project.rootPath, "cache", "video-generation", `${job.id}-probe.partial`);
  await mkdir(dirname(cachePath), { recursive: true });
  await rm(cachePath, { force: true }).catch(() => undefined);
  try {
    await bridge.downloadOutput(output, cachePath);
    const inspected = await inspectGeneratedVideoFile(cachePath, output.mime);
    await mkdir(dirname(targetPath), { recursive: true });
    await rm(targetPath, { force: true }).catch(() => undefined);
    await rename(cachePath, targetPath);
    return { path: targetPath, relativePath, name: basename(targetPath), ...inspected };
  } catch (error) {
    await rm(cachePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Bridge Run 丢失时，仅接受 Job 专属且已通过本地核验的文件作为恢复依据。 */
async function findRecoveredGeneratedVideo(snapshot: ProjectSnapshot, job: JobRecord): Promise<GeneratedVideo | undefined> {
  const directory = generatedVideoDirectory(snapshot);
  const prefix = `video-${job.id}-`;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || entry.name.endsWith(".partial")) continue;
    const relativePath = join("assets", "generated", entry.name);
    const inspected = await inspectExistingGeneratedVideo(snapshot, relativePath);
    if (inspected) return inspected;
  }
  return undefined;
}

async function completeVideoGeneration(application: EditingApplication, input: VideoGenerationCompletionInput): Promise<unknown> {
  const candidate = application as VideoCompletionApplication;
  if (typeof candidate.completeVideoGeneration !== "function") {
    throw new DomainError("当前 EditingApplication 尚未实现视频生成结果写入", "VIDEO_GENERATION_COMPLETION_NOT_IMPLEMENTED");
  }
  return candidate.completeVideoGeneration(input);
}

function completedVideoResult(application: EditingApplication, job: JobRecord): Record<string, unknown> {
  const result = application.trackJob(job.id).result;
  const generatedVideoAssetId = result?.generatedVideoAssetId;
  const revision = result?.revision;
  if (typeof generatedVideoAssetId !== "string" || !Number.isInteger(revision)) {
    throw new DomainError("视频结果已写入项目，但 Job 缺少可追溯的完成对象", "VIDEO_GENERATION_COMPLETION_RESULT_MISSING");
  }
  return { generatedVideoAssetId, revision };
}

/**
 * Application 提交 Revision 后、Job.result 写回前可能崩溃。父层实现应把 generationJobId
 * 写入生成 Asset 的 provenance；这里同时兼容已写入 generatedVideoAssetId 的完成回执，
 * 从而不会因为重领 Job 再次消耗远端视频额度。
 */
function recoverCompletedProjectWrite(application: EditingApplication, job: JobRecord): Record<string, unknown> | undefined {
  const state = application.readProject(job.projectId);
  const resultAssetId = typeof job.result?.generatedVideoAssetId === "string" ? job.result.generatedVideoAssetId : undefined;
  const asset = state.snapshot.assets.find((candidate) => {
    if (resultAssetId) return candidate.id === resultAssetId;
    const provenance = candidate.provenance as (Asset["provenance"] & { generationJobId?: unknown }) | undefined;
    return provenance?.generationJobId === job.id;
  });
  if (!asset || asset.kind !== "video" || asset.status !== "ready") return undefined;
  return {
    jobId: job.id,
    generatedVideoAssetId: asset.id,
    revision: state.revision.number,
    generatedVideo: {
      relativePath: asset.managedPath,
      contentHash: asset.sourceHash,
      durationMs: asset.metadata?.durationMs
    },
    recoveredProjectWrite: true
  };
}

/**
 * 四类 MiniMax H3 视频工作流的共同执行链：提交前动态读 Schema，Run 创建后立即持久化审计，
 * 成功后下载并核验受管本地文件。Run 丢失且没有本地完成物时绝不自动重提，避免未知额度下重复扣费。
 */
export async function runVideoGeneration(
  application: EditingApplication,
  job: JobRecord,
  bridge: ComfyUIBridgeClient
): Promise<Record<string, unknown>> {
  const recoveredProjectWrite = recoverCompletedProjectWrite(application, job);
  if (recoveredProjectWrite) return recoveredProjectWrite;
  const context = resolveVideoGenerationContext(application, job);
  const previousAudit = latestBridgeAudit(job, context.workflowId);

  if (previousAudit) {
    try {
      const completed = await bridge.waitForRun(previousAudit.runId);
      const audit = completedAudit(previousAudit, completed);
      await application.recordBridgeRun(job.id, audit);
      const generatedVideo = await localizeGeneratedVideo(bridge, context.snapshot, job, selectGeneratedVideoOutput(completed, context.outputSlotId));
      await completeVideoGeneration(application, { projectId: job.projectId, jobId: job.id, generatedVideo, bridgeAudit: audit });
      return { jobId: job.id, runId: completed.id, generatedVideo, ...completedVideoResult(application, job), recoveredExistingRun: true };
    } catch (error) {
      if (!(error instanceof BridgeRunLostError)) throw error;
      const generatedVideo = await findRecoveredGeneratedVideo(context.snapshot, job);
      if (generatedVideo) {
        // 远端完成状态已不可查，不伪造 completedAt；本地文件仍须完整通过同一套核验。
        await completeVideoGeneration(application, { projectId: job.projectId, jobId: job.id, generatedVideo, bridgeAudit: previousAudit });
        return { jobId: job.id, runId: previousAudit.runId, generatedVideo, ...completedVideoResult(application, job), recoveredLocalOutput: true };
      }
      throw new DomainError(
        `视频 Provider 的 Run ${previousAudit.runId} 已不可查询，且没有可恢复的本地视频；请确认是否重新生成。`,
        "VIDEO_GENERATION_RUN_LOST_REQUIRES_RECONFIRMATION"
      );
    }
  }

  const submittedAt = new Date().toISOString();
  const submission = await bridge.createRunWithSchemaRetry(
    context.workflowId,
    async (workflow) => buildVideoGenerationBridgeRequest(context, workflow)
  );
  // 先保存 run_id，再等待；这样 Worker 中断或 ComfyUI 重启后仍有可诊断、可恢复的本地事实。
  await application.recordBridgeRun(job.id, createBridgeAudit(submission, undefined, submittedAt));
  const completed = await bridge.waitForRun(submission.run.id);
  const audit = createBridgeAudit(submission, completed, submittedAt);
  await application.recordBridgeRun(job.id, audit);
  const generatedVideo = await localizeGeneratedVideo(bridge, context.snapshot, job, selectGeneratedVideoOutput(completed, context.outputSlotId));
  await completeVideoGeneration(application, { projectId: job.projectId, jobId: job.id, generatedVideo, bridgeAudit: audit });
  return { jobId: job.id, runId: completed.id, generatedVideo, ...completedVideoResult(application, job) };
}
