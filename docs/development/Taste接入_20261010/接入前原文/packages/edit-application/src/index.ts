import { sourceMaterialSchema, type SourceMaterialInput } from "../../asset-acquisition/src/source-research.js";
import { assetAcquisitionOptionsSchema } from "../../asset-acquisition/src/options.js";
import type { AssetAcquisitionOptions } from "@videocut/contracts";
import { captionPlacementSchema, captionDisplaySchema, validCaptionDisplay, type CaptionDisplay } from "../../contracts/src/caption-presentation.js";
import { applyAudioDesign, soundRequirementSchema, type AudioDesignInput } from "./sound-design.js";
import { prepareProjectFrameRateChange } from "./frame-rate-change.js";
import { digest as mediaDigest, assetRequestVersion } from "../../media-intelligence/src/index.js";
import { assertEffectCoverage } from "@videocut/domain";
import { MediaIntelligenceApplication } from "./media-intelligence.js";
import { createHash } from "node:crypto";
import { bindEffectAudioEvent, type EffectAudioEventInput } from "./effect-audio-events.js";
import { evidenceHash, validateEditorialObservations } from "./editorial-evidence.js";
import { validateMotionReviewEvidence } from "./motion-review.js";
import type { MotionReviewEvidenceInput, MotionReviewOutcome } from "@videocut/contracts";
import { EDITORIAL_PASSES, evidenceSupportsPass, mergeEditorialReviews, missingReviewRanges, openEditorialFindings, reviewCoverage } from "../../quality-system/src/editorial-review.js";
import { boundMotionFontSchema, boundMotionImageSchema, boundMotionVideoSchema, motionSubmissionSchema, type MotionSubmission } from "../../motion-work/src/schema.js";
import { bindMotionFonts } from "../../motion-work/src/fonts.js";
import { motionHash, motionHashEngine, MOTION_ENGINE_VERSION, validateMotionSource } from "../../motion-work/src/compiler.js";
import { MotionSourceValidationError } from "../../motion-work/src/source-validation-error.js";
import { MotionSubmissionValidationError } from "./motion-submission-validation.js";
import { assertEffectCueRange } from "./effect-cue-validation.js";
import { inspectEffectContentContract } from "@videocut/contracts";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentWorkOrder,
  AgentWorkOrderRelatedObjectIssue,
  AgentWorkOrderResultImpact,
  Asset,
  AssetCandidate,
  AssetRequest,
  ActorCapabilityProfile,
  ActorGenerationRange,
  ActorLayout,
  ActorAudioMode,
  ActorMaskMode,
  ActorPerformanceSource,
  AvatarInputMode,
  AvatarProviderKind,
  AudioCue,
  AudioCueKind,
  AudioDucking,
  BridgeRunAudit,
  CaptionCard,
  CaptionEmphasis,
  CaptionFormat,
  CreativeBrief,
  CreativeDelegation,
  Cutaway,
  CutawayAudioMode,
  CutawayFit,
  CutawayMode,
  DialogueProcessing,
  DialogueProcessingIssue,
  DialogueProcessingProfile,
  DialogueProcessingVariant,
  EffectAssetBinding,
  EffectCue,
  EffectMotion,
  EffectType,
  EvidenceCapture,
  EvidenceHighlight,
  EditorialQualityReview,
  EditorialReviewFinding,
  EditorialReviewCategory,
  EditorialReviewPass,
  EditorialReviewSeverity,
  EditorialReviewObservation,
  EditorialFindingResolution,
  ExportPurpose,
  ExportArtifact,
  ExportArtifactReview,
  ExplainerSceneKind,
  ExplainerSceneProgram,
  ExplainerSceneState,
  Id,
  ImpactReport,
  JobKind,
  JobRecord,
  JobStatus,
  MediaMetadata,
  MulticamAngleSync,
  MulticamCut,
  MulticamGroup,
  MulticamSourceRange,
  MulticamSyncPreview,
  NarrativeMap,
  NarrativeMapBeat,
  ProjectSnapshot,
  ProjectSummary,
  RepairTicket,
  RepairTicketCategory,
  RepairTicketStatus,
  RevisionRecord,
  SceneType,
  SemanticUnitKind,
  SemanticUnit,
  SearchIntent,
  SkillExecutionReport,
  SourceAudioAlignment,
  SourceAudioAlignmentTokenPrecision,
  SourceAudioAlignmentSentenceCandidateMode,
  SourceAudioAlignmentSentence,
  SourceAudioAlignmentSegment,
  SourceAudioAlignmentToken,
  SourceCaptionProgram,
  SpatialAnchor,
  StoryBeat,
  SpeechAlignment,
  SpeechAsset,
  SpeechSegmentAsset,
  SpeechTiming,
  TimelineItem,
  VideoGenerationMode,
  VisualTreatment,
  VisualTreatmentIntensity,
  VisualTreatmentMode,
  VlogEvent,
  VlogMusicBeat,
  VlogShotAnalysis,
  VlogShotFunction,
  VlogShotSelect,
  VlogSourceAudioMode,
  VoiceReference,
  WordTiming
} from "@videocut/contracts";
import {
  assetById,
  assertProjectGraphValid,
  assertTimelineValid,
  cloneSnapshot,
  compileSpeechSegments,
  createActorPerformance,
  createAgentWorkOrder,
  createAudioCue,
  createCutaway,
  createEffectCue,
  createId,
  createMediaAsset,
  createScene,
  createSemanticUnit,
  createTranscriptSentenceCandidates,
  createVoiceReference,
  createTimelineItem,
  createVisualTreatment,
  DomainError,
  framesToMilliseconds,
  millisecondsToFrames,
  sourceAudioAlignmentOwnerMatches,
  now,
  trackByName
} from "@videocut/domain";
import { DEFAULT_CAPTION_FORMAT, sourceAudioTimeOrigin } from "@videocut/contracts";
import { evaluateQualityWithBrowser, exportBlockingIssues } from "@videocut/quality";
import { sourceCaptionTextReviewSchema, exportApprovalSchema } from "../../contracts/src/editorial-inputs.js";
import { sourceCaptionDisplayTextIsValid } from "@videocut/domain";
import type { SourceCaptionTextReviewInput, AssetProvenance } from "@videocut/contracts";
import { readRuntimeConfig } from "@videocut/project-overview";
import { editPresenterSourceInSnapshot, type PresenterSourceEditInput } from "./presenter-source-edit";
import {
  NotFoundError,
  ProjectRepository,
  RevisionConflictError,
  type ProjectState
} from "./persistence";

// 保持既有 @videocut/application 导入兼容；数据库实现集中在 persistence/。
export {
  NotFoundError,
  PROJECT_DATABASE_SCHEMA_SQL,
  PROJECT_DATABASE_TABLES,
  ProjectRepository,
  RevisionConflictError,
  type ProjectState
} from "./persistence";

/**
 * 预览检查是 Job 的派生证据：只有 inspect_composed_frames 成功后才会写入。
 * 它不进入 Revision Snapshot，避免把审片产物误当成剪辑状态。
 */
type PreviewInspectionEvidence = {
  revision: number;
  sourcePreviewJobId: Id;
  inspectedAt: string;
  frames: Array<{ frame: number; relativePath: string }>;
};

/**
 * Avatar Job 只保存一次提交时已确认的输入事实。Worker 只消费这份合同，
 * 不能在异步完成后按“当前最新项目”猜测人物该落到哪里。
 */
type AvatarGenerationPlacement = {
  sceneId: Id;
  startFrame: number;
  endFrame: number;
};

type AvatarGenerationJobPayload = {
  requestedRevision: number;
  capabilityProfileId: Id;
  workflowId: string;
  referenceImageAssetId: Id;
  speechAssetId: Id;
  generationRange: ActorGenerationRange;
  placement: AvatarGenerationPlacement;
  replaceActorPerformanceId?: Id;
  prompt?: string;
  maskMode: "none";
  audioMode: "use_dialogue_track" | "muted";
  layout?: ActorLayout;
  note?: string;
};

type CompletedAvatarVideo = {
  /** Worker 已完成下载、ffprobe 与哈希校验的项目内绝对路径。 */
  path: string;
  /** 相对于 Project 根目录的受管路径，用于 Revision 和 Render Worker。 */
  relativePath: string;
  name: string;
  contentHash: string;
  sourceHash: string;
  durationMs: number;
  metadata: MediaMetadata;
};

/** Vlog Worker 只返回可测量的镜头边界和音轨事实；事件含义与 Select 仍由导演明确写入。 */
type VlogAnalysisJobPayload = {
  requestedRevision: number;
  assetIds: Id[];
  sceneThreshold: number;
};

/** 多机位 Worker 只回传经共同音轨验证的固定偏移，不会根据画面相似度猜测同步。 */
type MulticamSyncJobPayload = {
  requestedRevision: number;
  title: string;
  assetIds: Id[];
  /** 机位名称必须由调用方显式提供；Worker 不从文件名或时间元数据猜 A/B/C。 */
  angleLabels: Record<Id, string>;
  /** 防止异步 Worker 对“同名但已替换”的二进制继续写入同步结论。 */
  sourceHashes: Record<Id, string>;
  referenceAssetId: Id;
  masterAudioAssetId: Id;
  maxSearchSeconds: number;
  /** 缺失仅用于兼容旧的排队 Job；新提交会归一为每个机位一条完整源范围。 */
  sourceRanges?: Record<Id, MulticamSourceRange>;
};

export type CompletedMulticamAngleSync = Omit<MulticamAngleSync, "method"> & {
  method: "audio_correlation";
};

/** 音乐 Provider 由调用方明确指定 workflowId；不以文件名或一个隐含的默认模型猜测。 */
type MusicGenerationJobPayload = {
  requestedRevision: number;
  workflowId: string;
  prompt: string;
  durationSeconds: number;
  outputSlotId?: string;
};

/**
 * 视频生成 Job 固化提交时的创作输入。Worker 仍会读取当前 Bridge Schema，
 * 这里不保存 Schema 字段 ID 或下载 URL，避免工作流升级后把旧实现当成当前能力。
 */
type VideoGenerationJobPayload = {
  requestedRevision: number;
  workflowId: string;
  mode: VideoGenerationMode;
  inputAssetIds: Id[];
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
  assetRequestId?: Id;
};

/** Worker 只在下载、解码和哈希都已验证后才可把这个对象交回 Application。 */
type CompletedGeneratedVideo = {
  path: string;
  relativePath: string;
  name: string;
  contentHash: string;
  sourceHash: string;
  durationMs: number;
  metadata: MediaMetadata;
};

/** 词级对齐必须由调用方明确指定真实 workflow，避免把某个 ASR 或 TTS 默认当成强制对齐器。 */
type SpeechAlignmentJobPayload = {
  requestedRevision: number;
  speechAssetId: Id;
  scriptRevision: number;
  workflowId: string;
  outputSlotId?: string;
};

export type CompletedSpeechAlignment = {
  words: WordTiming[];
  source: string;
};

/**
 * 对白处理固定当前完整 SpeechAsset 与当前 Revision。它不接受局部源范围，
 * 因为局部修补会牵涉 Room Tone、边界拼接和段级时序，首版不能假装已解决。
 */
export type DialogueProcessingJobPayload = {
  requestedRevision: number;
  speechAssetId: Id;
  sourceAssetId: Id;
  scriptRevision: number;
  sourceDurationMs: number;
  issueTypes: DialogueProcessingIssue[];
  evidenceNote: string;
  processingVersion: "v1";
};

/** Worker 在本地生成、探测与哈希完成后才交给 Application 登记的派生产物。 */
export type CompletedDialogueProcessingVariant = {
  profile: Exclude<DialogueProcessingProfile, "original">;
  path: string;
  relativePath: string;
  contentHash: string;
  durationMs: number;
  metadata: MediaMetadata;
  filters: string[];
};

type CompletedMusicAudio = {
  path: string;
  relativePath: string;
  name: string;
  contentHash: string;
  sourceHash: string;
  durationMs: number;
  metadata: MediaMetadata;
};

export type CompletedVlogShotAnalysis = {
  assetId: Id;
  sourceStartFrame: number;
  sourceEndFrame: number;
  source: VlogShotAnalysis["source"];
  sceneChangeScore?: number;
  technicalScore: number;
  hasAudio: boolean;
  evidenceNote: string;
};

/** 用流式读取核对最终文件，避免批准大文件时一次性把整段视频读入内存。 */
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

export interface AppEvent {
  projectId: Id;
  revision: number;
  /** 修复工单不写入视频 Revision，但仍要通知同项目的监测方刷新状态。 */
  type: "revision" | "job" | "repair_ticket";
}

function assertAssetProvenanceValid(provenance: NonNullable<Asset["provenance"]>): void {
  if (provenance.derivedFrom && (!provenance.derivedFrom.assetId || !provenance.derivedFrom.sourceHash
    || !Number.isSafeInteger(provenance.derivedFrom.startMs) || !Number.isSafeInteger(provenance.derivedFrom.endMs)
    || provenance.derivedFrom.startMs < 0 || provenance.derivedFrom.endMs <= provenance.derivedFrom.startMs)) {
    throw new DomainError("派生音频缺少有效的源素材身份或源范围", "DERIVED_AUDIO_SOURCE_INVALID");
  }
  if (provenance.source === "provider" && (!provenance.provider?.trim() || !provenance.sourceUrl?.trim())) {
    throw new DomainError("外部素材必须记录来源平台和原始页面", "PROVENANCE_SOURCE_REQUIRED");
  }
}

function assetRequestById(snapshot: ProjectSnapshot, assetRequestId: Id): AssetRequest {
  const request = snapshot.assetRequests.find((candidate) => candidate.id === assetRequestId);
  if (!request) throw new NotFoundError(`素材需求不存在：${assetRequestId}`);
  return request;
}

function assetCandidateById(snapshot: ProjectSnapshot, assetCandidateId: Id): AssetCandidate {
  const candidate = snapshot.assetCandidates.find((entry) => entry.id === assetCandidateId);
  if (!candidate) throw new NotFoundError(`素材候选不存在：${assetCandidateId}`);
  return candidate;
}

function vlogShotById(snapshot: ProjectSnapshot, shotAnalysisId: Id): VlogShotAnalysis {
  const shot = snapshot.vlogShotAnalyses.find((candidate) => candidate.id === shotAnalysisId);
  if (!shot) throw new NotFoundError(`Vlog 镜头分析不存在：${shotAnalysisId}`);
  return shot;
}

function vlogEventById(snapshot: ProjectSnapshot, eventId: Id): VlogEvent {
  const event = snapshot.vlogEvents.find((candidate) => candidate.id === eventId);
  if (!event) throw new NotFoundError(`Vlog 事件不存在：${eventId}`);
  return event;
}

function vlogShotSelectById(snapshot: ProjectSnapshot, shotSelectId: Id): VlogShotSelect {
  const select = snapshot.vlogShotSelects.find((candidate) => candidate.id === shotSelectId);
  if (!select) throw new NotFoundError(`Vlog Shot Select 不存在：${shotSelectId}`);
  return select;
}

function normalizeVlogFunction(value: VlogShotFunction | undefined): VlogShotFunction {
  if (!value || !["establish", "action", "detail", "reaction", "transition", "atmosphere"].includes(value)) {
    throw new DomainError("Vlog 镜头功能必须是 establish/action/detail/reaction/transition/atmosphere 之一", "INVALID_VLOG_SHOT_FUNCTION");
  }
  return value;
}

function normalizeVlogSourceAudioMode(value: VlogSourceAudioMode | undefined): VlogSourceAudioMode {
  if (value !== "keep" && value !== "mute") {
    throw new DomainError("Vlog 镜头必须明确保留或静音原始现场声", "VLOG_SOURCE_AUDIO_MODE_REQUIRED");
  }
  return value;
}

function visualTreatmentById(snapshot: ProjectSnapshot, visualTreatmentId: Id): VisualTreatment {
  const treatment = snapshot.visualTreatments.find((candidate) => candidate.id === visualTreatmentId);
  if (!treatment) throw new NotFoundError(`VisualTreatment 不存在：${visualTreatmentId}`);
  return treatment;
}

function cutawayById(snapshot: ProjectSnapshot, cutawayId: Id): Cutaway {
  const cutaway = snapshot.cutaways.find((candidate) => candidate.id === cutawayId);
  if (!cutaway) throw new NotFoundError(`Cutaway 不存在：${cutawayId}`);
  return cutaway;
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new DomainError(`${label}不能为空`, "REQUIRED_TEXT_MISSING");
  return text;
}

/** 正式切换只能引用构建产物的内容摘要，不能用 latest、分支名或人工版本号代替。 */
function requireReleaseId(value: string | undefined, label: string): string {
  const releaseId = requireText(value, label);
  if (!/^release-[a-f0-9]{64}$/u.test(releaseId)) {
    throw new DomainError(`${label}必须是构建 manifest 的 release-<sha256>`, "REPAIR_TICKET_RELEASE_ID_INVALID");
  }
  return releaseId;
}

/**
 * 强制对齐的文字核验只忽略空白和标点；绝不按字符数补时间，也不允许 Provider 偷换可朗读内容。
 * NFKC 让全半角数字等同后再比较，保留汉字、字母和数字本体。
 */
function normalizeAlignmentText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function expectedSpeechAlignmentText(snapshot: ProjectSnapshot, speechAsset: SpeechAsset): string {
  return speechAsset.timing.segments
    .slice()
    .sort((left, right) => left.startMs - right.startMs)
    .map((timing) => snapshot.speechSegments.find((segment) => segment.id === timing.speechSegmentId)?.text ?? "")
    .join("");
}

/**
 * Worker 已经验证一次；Application 再次用当前 Revision 的真实音频、段边界和文本复核，
 * 避免任何外部输出或过期 Job 绕过 Project 的共同事实。
 */
function validateCompletedSpeechAlignment(
  snapshot: ProjectSnapshot,
  speechAsset: SpeechAsset,
  words: WordTiming[]
): WordTiming[] {
  const speechFile = assetById(snapshot, speechAsset.assetId);
  const durationMs = speechFile.metadata?.durationMs;
  if (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs <= 0) {
    throw new DomainError("SpeechAsset 缺少可验证的真实音频时长，不能接收词级对齐", "SPEECH_ALIGNMENT_AUDIO_DURATION_MISSING");
  }
  if (words.length === 0 || words.length > 20_000) {
    throw new DomainError("真实词级对齐必须返回 1 到 20000 个词或字时间戳", "SPEECH_ALIGNMENT_WORDS_REQUIRED");
  }
  const segmentTimings = speechAsset.timing.segments.slice().sort((left, right) => left.startMs - right.startMs);
  let previousEndMs = -1;
  const normalized = words.map((word) => {
    const text = word.text.trim();
    const normalizedText = normalizeAlignmentText(text);
    if (!text || !normalizedText || text.length > 160 || word.normalizedText !== normalizedText) {
      throw new DomainError("词级对齐返回了空 token 或与本地归一化结果不一致的文本", "SPEECH_ALIGNMENT_WORD_TEXT_INVALID");
    }
    if (!Number.isInteger(word.startMs) || !Number.isInteger(word.endMs) || word.startMs < 0 || word.endMs <= word.startMs
      || word.endMs > durationMs || word.startMs < previousEndMs) {
      throw new DomainError("词级对齐时间戳超出真实音频范围、重叠或无效", "SPEECH_ALIGNMENT_WORD_RANGE_INVALID");
    }
    const segmentTiming = segmentTimings.find((segment) => word.startMs >= segment.startMs && word.endMs <= segment.endMs);
    if (!segmentTiming || word.speechSegmentId !== segmentTiming.speechSegmentId) {
      throw new DomainError("词级对齐 token 没有完整落在当前 SpeechSegment 的真实范围内", "SPEECH_ALIGNMENT_SEGMENT_MISMATCH");
    }
    const startFrame = millisecondsToFrames(word.startMs, snapshot.timeline.fps);
    const endFrame = millisecondsToFrames(word.endMs, snapshot.timeline.fps);
    if (word.startFrame !== startFrame || word.endFrame !== endFrame || endFrame <= startFrame) {
      throw new DomainError("词级对齐帧号必须由真实毫秒时间按当前 Timeline FPS 换算", "SPEECH_ALIGNMENT_FRAME_INVALID");
    }
    if (word.confidence !== undefined && (!Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1)) {
      throw new DomainError("词级对齐置信度必须在 0 到 1 之间，或由 Provider 明确省略", "SPEECH_ALIGNMENT_CONFIDENCE_INVALID");
    }
    previousEndMs = word.endMs;
    return { ...word, text, normalizedText };
  });
  const expected = normalizeAlignmentText(expectedSpeechAlignmentText(snapshot, speechAsset));
  if (!expected || normalized.map((word) => word.normalizedText).join("") !== expected) {
    throw new DomainError("词级对齐 token 与当前可播放 Script 不一致，不能标记为 word_exact", "SPEECH_ALIGNMENT_TEXT_MISMATCH");
  }
  return normalized;
}

/** 主声音或 Script 变化后保留旧审计供追溯，但绝不让旧时间戳继续升级当前成片精度。 */
function markSpeechAlignmentStale(snapshot: ProjectSnapshot, impact: ImpactReport, reason: string): void {
  const alignment = snapshot.speechAlignment;
  if (!alignment || alignment.status === "stale") return;
  alignment.status = "stale";
  impact.changed.push(alignment.id);
  impact.stale.push(alignment.id);
  impact.warnings.push(`词级对齐已过期：${reason}`);
}

type CaptionFormatPatch = Partial<Omit<CaptionFormat, "backgroundColor" | "backgroundOpacity" | "placement">> & {
  backgroundColor?: string | null;
  backgroundOpacity?: number | null;
  placement?: CaptionFormat["placement"] | null;
};
type AudioDuckingPatch = Partial<AudioDucking>;

const DEFAULT_BGM_DUCKING: AudioDucking = {
  enabled: true,
  reductionDb: -14,
  attackFrames: 4,
  releaseFrames: 14
};

const DIALOGUE_PROCESSING_ISSUES = new Set<DialogueProcessingIssue>([
  "noise", "low_frequency", "sibilance", "loudness", "true_peak"
]);
// PCM WAV 不应改变完整旁白时长；只允许 ffprobe 毫秒取整带来的极小差异。
const DIALOGUE_PROCESSING_MAX_DURATION_DRIFT_MS = 5;

/** Dialogue 的物理 Item 必须唯一；候选试听不能通过新建第二条旁白来叠加原声。 */
function currentDialogueItem(snapshot: ProjectSnapshot, speechAsset: SpeechAsset): TimelineItem {
  const dialogueTrack = trackByName(snapshot, "Dialogue");
  const items = snapshot.timeline.items.filter((item) => (
    item.trackId === dialogueTrack.id && item.assetId === speechAsset.assetId && !item.disabled
  ));
  if (items.length !== 1) {
    throw new DomainError("当前 SpeechAsset 必须以唯一可播放 Item 写入 Dialogue 轨，才能处理或切换候选", "SPEECH_DIALOGUE_ITEM_MISSING");
  }
  return items[0]!;
}

function readySpeechFile(snapshot: ProjectSnapshot, speechAsset: SpeechAsset): Asset {
  const asset = assetById(snapshot, speechAsset.assetId);
  if (asset.kind !== "speech" || asset.status !== "ready" || !asset.metadata?.hasAudio || asset.metadata.durationMs <= 0 || !asset.managedPath.trim()) {
    throw new DomainError("当前 SpeechAsset 没有已就绪的完整本地 Speech 音频，不能进行 Dialogue Processing", "DIALOGUE_SOURCE_NOT_READY");
  }
  return asset;
}

/** BGM / SFX 只接收已本地化的独立音频，不能把任意带声视频悄悄当作音乐或音效。 */
function requireReadyAudioAsset(snapshot: ProjectSnapshot, assetId: Id): Asset {
  const asset = assetById(snapshot, assetId);
  if (asset.kind !== "audio" || asset.status !== "ready" || !asset.metadata?.hasAudio || !asset.managedPath.trim()) {
    throw new DomainError("BGM / SFX 必须使用已就绪、已本地化的独立音频素材", "AUDIO_ASSET_NOT_READY");
  }
  return asset;
}

function requireAudioFrame(value: number, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DomainError(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数帧`, "INVALID_AUDIO_FRAME");
  }
  return value;
}

function normalizeAudioDucking(patch: AudioDuckingPatch | undefined, current?: AudioDucking): AudioDucking {
  // MCP / HTTP 的可选嵌套字段可能显式传入 undefined；这不应覆盖已有 Duck 参数。
  const definedPatch = Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)) as AudioDuckingPatch;
  const next = { ...DEFAULT_BGM_DUCKING, ...current, ...definedPatch };
  if (typeof next.enabled !== "boolean") throw new DomainError("Duck 开关必须是布尔值", "INVALID_AUDIO_DUCKING");
  if (!Number.isFinite(next.reductionDb) || next.reductionDb > -1 || next.reductionDb < -36) {
    throw new DomainError("Duck 衰减必须在 -36 到 -1 dB 之间", "INVALID_AUDIO_DUCKING");
  }
  for (const [label, value] of [["Duck 攻击", next.attackFrames], ["Duck 释放", next.releaseFrames], ["Duck 保持", next.holdFrames ?? 0]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 240) {
      throw new DomainError(`${label}必须是 0 到 240 帧`, "INVALID_AUDIO_DUCKING");
    }
  }
  return next;
}

const captionColorPattern = /^#[0-9a-f]{6}$/iu;

/** 保留用户主动换行，但限制为稳定双行字幕，避免把段级 Card 变成整页文字。 */
function normalizeCaptionText(value: string, label = "字幕文案"): string {
  const text = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!text) throw new DomainError(`${label}不能为空`, "CAPTION_TEXT_REQUIRED");
  if (text.length > 80) throw new DomainError(`${label}不能超过 80 个字符`, "CAPTION_TEXT_TOO_LONG");
  if (text.split("\n").length > 2) throw new DomainError(`${label}最多允许两行`, "CAPTION_TOO_MANY_LINES");
  return text;
}

/**
 * Provider 段先原样进入字幕轨，让真实画幅排版决定是否 overflow；不能用任意字符数上限
 * 假装它适合两行。显式三行仍然是无效输入，异常段应由 editorial override 重分屏。
 */
function normalizeProviderCaptionText(value: string, label = "Provider 字幕段文案"): string {
  const text = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!text) throw new DomainError(`${label}不能为空`, "SOURCE_CAPTION_SEGMENT_TEXT_INVALID");
  if (!normalizeCaptionComparisonText(text)) throw new DomainError(`${label}只有标点或符号，不能作为字幕`, "SOURCE_CAPTION_SEGMENT_TEXT_INVALID");
  // 这里只防御畸形 Provider 响应/内存放大，不把任意字符数当成“最多两行”的替代品。
  // 正常长段必须先进入真实画幅布局检查，再由 CAPTION_LAYOUT_OVERFLOW 引导例外重分屏。
  if (text.length > 10_000) throw new DomainError(`${label}异常长，无法作为单个 Provider 输出安全处理`, "SOURCE_CAPTION_SEGMENT_TEXT_TOO_LONG");
  if (text.split("\n").length > 2) throw new DomainError(`${label}包含超过两行的显式换行；不能把多屏内容伪装成一个 segment`, "SOURCE_CAPTION_SEGMENT_TOO_MANY_LINES");
  return text;
}

function requireCaptionColor(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!captionColorPattern.test(value)) throw new DomainError(`${label}必须是 #RRGGBB 颜色`, "INVALID_CAPTION_COLOR");
  return value.toLowerCase();
}

/** 只接收明确的字幕排版字段，避免把任意 CSS 写进可渲染 Project Snapshot。 */
function applyCaptionFormat(current: CaptionFormat | undefined, patch: CaptionFormatPatch): CaptionFormat {
  // null 只表示显式移除背景或透明度，不应作为运行时样式写入 Snapshot。
  const { backgroundColor, backgroundOpacity, placement, ...rawFormatPatch } = patch;
  // MCP 解构会携带未传字段的 undefined；它们不能覆盖既有安全排版值。
  const formatPatch = Object.fromEntries(Object.entries(rawFormatPatch).filter(([, value]) => value !== undefined)) as Partial<Omit<CaptionFormat, "backgroundColor" | "backgroundOpacity" | "placement">>;
  const next: CaptionFormat = { ...DEFAULT_CAPTION_FORMAT, ...current, ...formatPatch };
  if (placement === null) delete next.placement;
  else if (placement !== undefined) next.placement = captionPlacementSchema.parse(placement);
  if (backgroundColor === null) {
    delete next.backgroundColor;
    delete next.backgroundOpacity;
  }
  else if (backgroundColor !== undefined) next.backgroundColor = backgroundColor;
  if (backgroundOpacity === null) delete next.backgroundOpacity;
  else if (backgroundOpacity !== undefined) next.backgroundOpacity = backgroundOpacity;
  if (!Number.isInteger(next.fontSize) || next.fontSize < 16 || next.fontSize > 72) {
    throw new DomainError("字幕字号必须在 16 到 72 之间", "INVALID_CAPTION_FONT_SIZE");
  }
  if (!Number.isInteger(next.fontWeight) || next.fontWeight < 400 || next.fontWeight > 900) {
    throw new DomainError("字幕字重必须在 400 到 900 之间", "INVALID_CAPTION_FONT_WEIGHT");
  }
  if (!Number.isFinite(next.bottomPercent) || next.bottomPercent < 0 || next.bottomPercent > 95) {
    throw new DomainError("字幕底部位置必须在 0% 到 95% 之间", "INVALID_CAPTION_BOTTOM");
  }
  if (!Number.isFinite(next.horizontalInsetPercent) || next.horizontalInsetPercent < 0 || next.horizontalInsetPercent > 45) {
    throw new DomainError("字幕左右边距必须在 0% 到 45% 之间", "INVALID_CAPTION_INSET");
  }
  next.color = requireCaptionColor(next.color, "字幕颜色")!;
  const normalizedBackgroundColor = requireCaptionColor(next.backgroundColor, "字幕背景颜色");
  if (normalizedBackgroundColor === undefined) delete next.backgroundColor;
  else next.backgroundColor = normalizedBackgroundColor;
  if (next.backgroundOpacity !== undefined) {
    if (!next.backgroundColor) throw new DomainError("字幕背景透明度必须与背景颜色一起使用", "CAPTION_BACKGROUND_OPACITY_REQUIRES_COLOR");
    if (!Number.isFinite(next.backgroundOpacity) || next.backgroundOpacity < 0.1 || next.backgroundOpacity > 1) {
      throw new DomainError("字幕背景透明度必须在 0.1 到 1 之间", "INVALID_CAPTION_BACKGROUND_OPACITY");
    }
  }
  if (!["left", "center", "right"].includes(next.textAlign)) {
    throw new DomainError("字幕对齐方式无效", "INVALID_CAPTION_ALIGNMENT");
  }
  return next;
}

/** 原声 Card 的时间只能来自其保存的源范围，屏幕文案或版式不能绕过该审计。 */
function assertCurrentSourceAudioCaption(snapshot: ProjectSnapshot, caption: CaptionCard): void {
  const sourceItem = caption.sourceTimelineItemId
    ? snapshot.timeline.items.find((item) => item.id === caption.sourceTimelineItemId)
    : undefined;
  if (!sourceItem || sourceItem.disabled || sourceItem.assetId !== caption.sourceAssetId
    || caption.sourceStartFrame === undefined || caption.sourceEndFrame === undefined
    || caption.startFrame !== sourceItem.startFrame + (caption.sourceStartFrame - sourceItem.sourceStartFrame)
    || caption.endFrame !== sourceItem.startFrame + (caption.sourceEndFrame - sourceItem.sourceStartFrame)) {
    throw new DomainError("原声字幕的 A-roll 来源或时间映射已变化；请重新生成字幕", "CAPTION_SOURCE_STALE");
  }
}

type SourceCaptionAlignmentTokenInput = {
  text: string;
  startMs: number;
  endMs: number;
};

type SourceCaptionAlignmentSentenceInput = {
  text: string;
  startMs: number;
  endMs: number;
  tokenStartIndex: number;
  tokenEndIndex: number;
};

/** Provider 的一个 segment 就是一屏字幕；token 范围只在服务端验证同源时间。 */
type SourceCaptionAlignmentSegmentInput = {
  displayText: string;
  startMs: number;
  endMs: number;
  tokenStartIndex?: number;
  tokenEndIndex?: number;
};

type SourceCaptionAlignmentTarget = {
  item: TimelineItem;
  asset: Asset;
};

/**
 * 比对 FunASR 输出与既有原声文本时，只忽略 Unicode 空白、标点与英文大小写；
 * 汉字、数字和其他实义字符必须逐一保留，避免“看起来接近”的转写覆盖原字幕。
 */
function normalizeCaptionComparisonText(value: string): string {
  return value.normalize("NFKC").replace(/[\p{White_Space}\p{P}]/gu, "").toLocaleLowerCase("en-US");
}

/** Provider 的 raw token 已保留原始顺序；这里只恢复拉丁单词间必需的可读空格，不参与定时。 */
function joinSourceAudioTokens(tokens: Array<Pick<SourceAudioAlignmentToken, "text">>): string {
  let text = "";
  let previous = "";
  for (const token of tokens) {
    const next = token.text.trim();
    if (!next) throw new DomainError("原声 token 文字不能为空", "SOURCE_CAPTION_TOKEN_TEXT_INVALID");
    if (text && /[A-Za-z0-9]$/u.test(previous) && /^[A-Za-z0-9]/u.test(next)) text += " ";
    text += next;
    previous = next;
  }
  return text;
}

/**
 * Application 只接受 Provider 明确返回的 token；文本、候选句和时间必须来自同一输出。
 * 任何不一致均失败，绝不按字符、标点或时长估算补齐。
 */
function validateSourceAudioAlignmentEvidence(input: {
  transcriptText: string;
  tokens: SourceCaptionAlignmentTokenInput[];
  sentences: SourceCaptionAlignmentSentenceInput[];
  sentenceCandidateMode?: SourceAudioAlignmentSentenceCandidateMode;
  durationMs: number;
}): { tokens: SourceAudioAlignmentToken[]; sentences: SourceAudioAlignmentSentence[]; sentenceCandidateMode: SourceAudioAlignmentSentenceCandidateMode } {
  const transcript = requireText(input.transcriptText, "FunASR 对齐全文");
  const sentenceCandidateMode = input.sentenceCandidateMode ?? (input.sentences.length === 0 ? "none" : "provider_punctuation");
  if (input.tokens.length === 0 || input.tokens.length > 20_000 || input.sentences.length > 2_000
    || (sentenceCandidateMode !== "none" && sentenceCandidateMode !== "provider_punctuation")
    || (sentenceCandidateMode === "none" && input.sentences.length !== 0)
    || (sentenceCandidateMode === "provider_punctuation" && input.sentences.length === 0)) {
    throw new DomainError("FunASR 原声 token 或候选句数量无效", "SOURCE_CAPTION_TOKEN_OUTPUT_INVALID");
  }
  let previousEndMs = -1;
  const tokens = input.tokens.map((candidate, index) => {
    const text = requireText(candidate.text, `FunASR 第 ${index + 1} 个 token 文案`);
    if (text.length > 160 || !normalizeCaptionComparisonText(text)
      || !Number.isInteger(candidate.startMs) || !Number.isInteger(candidate.endMs)
      || candidate.startMs < 0 || candidate.endMs <= candidate.startMs || candidate.endMs > input.durationMs
      || candidate.startMs < previousEndMs) {
      throw new DomainError("FunASR 原声 token 的文字、顺序或时间无效", "SOURCE_CAPTION_TOKEN_OUTPUT_INVALID");
    }
    previousEndMs = candidate.endMs;
    return { index, text, startMs: candidate.startMs, endMs: candidate.endMs };
  });
  const tokenComparableText = normalizeCaptionComparisonText(joinSourceAudioTokens(tokens));
  if (!tokenComparableText || tokenComparableText !== normalizeCaptionComparisonText(transcript)) {
    throw new DomainError("FunASR 原声 token 与同次全文输出不一致，不能创建对齐证据", "SOURCE_CAPTION_TOKEN_TRANSCRIPT_MISMATCH");
  }
  if (sentenceCandidateMode === "none") return { tokens, sentences: [], sentenceCandidateMode };
  let expectedTokenStart = 0;
  const sentences = input.sentences.map((candidate, index) => {
    const text = requireText(candidate.text, `FunASR 第 ${index + 1} 个候选句文案`);
    if (!Number.isInteger(candidate.startMs) || !Number.isInteger(candidate.endMs)
      || !Number.isInteger(candidate.tokenStartIndex) || !Number.isInteger(candidate.tokenEndIndex)
      || candidate.tokenStartIndex !== expectedTokenStart || candidate.tokenEndIndex <= candidate.tokenStartIndex
      || candidate.tokenEndIndex > tokens.length) {
      throw new DomainError("FunASR 候选句的 token 范围不连续或无效", "SOURCE_CAPTION_SENTENCE_OUTPUT_INVALID");
    }
    const range = tokens.slice(candidate.tokenStartIndex, candidate.tokenEndIndex);
    const sourceText = joinSourceAudioTokens(range);
    if (normalizeCaptionComparisonText(text) !== normalizeCaptionComparisonText(sourceText)
      || candidate.startMs !== range[0]!.startMs || candidate.endMs !== range.at(-1)!.endMs) {
      throw new DomainError("FunASR 候选句与同源 token 时间不一致，不能把标点分段伪作字幕证据", "SOURCE_CAPTION_SENTENCE_OUTPUT_INVALID");
    }
    expectedTokenStart = candidate.tokenEndIndex;
    return {
      index,
      text,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      tokenStartIndex: candidate.tokenStartIndex,
      tokenEndIndex: candidate.tokenEndIndex
    };
  });
  if (expectedTokenStart !== tokens.length) {
    throw new DomainError("FunASR 候选句没有完整覆盖同源 token，不能猜测遗漏文本的时间", "SOURCE_CAPTION_SENTENCE_OUTPUT_INVALID");
  }
  return { tokens, sentences, sentenceCandidateMode };
}

/**
 * 正式 v4 链只接收 Provider 已完成的字幕段。段文字、时间和 token 区间必须来自同一次
 * 对齐；服务端只核验并编译，不按字符、标点或空白时长再切一遍。
 */
function validateSourceAudioCaptionAlignmentEvidence(input: {
  transcriptText: string;
  /** 未显式标记的旧调用只在确有 token 时按严格路径兼容；正式 v4 Worker 必须传此字段。 */
  tokenPrecision?: SourceAudioAlignmentTokenPrecision;
  tokens?: SourceCaptionAlignmentTokenInput[];
  segments: SourceCaptionAlignmentSegmentInput[];
  durationMs: number;
}): {
  tokenPrecision: SourceAudioAlignmentTokenPrecision;
  tokens?: SourceAudioAlignmentToken[];
  segments: SourceAudioAlignmentSegment[];
} {
  const transcript = requireText(input.transcriptText, "FunASR 对齐全文");
  const tokenPrecision = input.tokenPrecision ?? (input.tokens?.length ? "provider_token_timed" : "unavailable");
  if (tokenPrecision !== "provider_token_timed" && tokenPrecision !== "unavailable") {
    throw new DomainError("FunASR 原声字幕 token 精度声明无效", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  if (!Array.isArray(input.segments) || input.segments.length === 0 || input.segments.length > 300) {
    throw new DomainError("FunASR 原声字幕段数量无效", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  let previousEndMs = -1;
  const normalizedSegments = input.segments.map((candidate, index) => {
    const displayText = normalizeProviderCaptionText(candidate.displayText, `FunASR 第 ${index + 1} 个字幕段文案`);
    if (!Number.isInteger(candidate.startMs) || !Number.isInteger(candidate.endMs)
      || candidate.startMs < 0 || candidate.endMs <= candidate.startMs || candidate.endMs > input.durationMs
      || candidate.startMs < previousEndMs) {
      throw new DomainError("FunASR 字幕段的文字、顺序或时间无效", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
    }
    previousEndMs = candidate.endMs;
    return {
      displayText,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      tokenStartIndex: candidate.tokenStartIndex,
      tokenEndIndex: candidate.tokenEndIndex
    };
  });
  if (normalizeCaptionComparisonText(normalizedSegments.map((segment) => segment.displayText).join(""))
    !== normalizeCaptionComparisonText(transcript)) {
    throw new DomainError("FunASR 字幕段与同次全文输出不一致，不能静默省略或补写文字", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }

  if (tokenPrecision === "unavailable") {
    if ((input.tokens?.length ?? 0) > 0 || normalizedSegments.some((segment) => (
      segment.tokenStartIndex !== undefined || segment.tokenEndIndex !== undefined
    ))) {
      throw new DomainError("Provider 未提供完整 token 时间时，字幕段不能携带猜测出的 token 范围", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
    }
    return {
      tokenPrecision,
      segments: normalizedSegments.map(({ displayText, startMs, endMs }) => ({ displayText, startMs, endMs }))
    };
  }

  const evidence = validateSourceAudioAlignmentEvidence({
    transcriptText: transcript,
    tokens: input.tokens ?? [],
    sentences: [],
    sentenceCandidateMode: "none",
    durationMs: input.durationMs
  });
  let expectedTokenStart = 0;
  const segments = normalizedSegments.map((segment) => {
    const tokenStartIndex = segment.tokenStartIndex;
    const tokenEndIndex = segment.tokenEndIndex;
    if (typeof tokenStartIndex !== "number" || typeof tokenEndIndex !== "number"
      || !Number.isInteger(tokenStartIndex) || !Number.isInteger(tokenEndIndex)
      || tokenStartIndex !== expectedTokenStart || tokenEndIndex <= tokenStartIndex
      || tokenEndIndex > evidence.tokens.length) {
      throw new DomainError("FunASR 字幕段的 token 范围不连续或无效", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
    }
    const tokens = evidence.tokens.slice(tokenStartIndex, tokenEndIndex);
    const sourceText = joinSourceAudioTokens(tokens);
    if (normalizeCaptionComparisonText(segment.displayText) !== normalizeCaptionComparisonText(sourceText)
      || segment.startMs !== tokens[0]!.startMs || segment.endMs !== tokens.at(-1)!.endMs) {
      throw new DomainError("FunASR 字幕段的文字或时间不属于同源 token；不能估时或改写实义词", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
    }
    expectedTokenStart = tokenEndIndex;
    return {
      ...segment,
      tokenStartIndex,
      tokenEndIndex
    };
  });
  if (expectedTokenStart !== evidence.tokens.length) {
    throw new DomainError("FunASR 字幕段没有完整覆盖同源 spoken token，不能静默省略", "SOURCE_CAPTION_SEGMENT_TOKEN_COVERAGE_INVALID");
  }
  return { tokenPrecision, tokens: evidence.tokens, segments };
}

/** 只有完全自动生成的 VAD 粗字幕可以由后续 Program 原子替换，避免覆盖任何人工编辑。 */
function isReplaceableSourceCaptionCoarse(caption: CaptionCard): boolean {
  return caption.precision === "chunk_coarse"
    && caption.textMode !== "manual"
    && caption.emphasis === undefined
    && typeof caption.sourceBridgeRunId === "string"
    && Boolean(caption.sourceBridgeRunId.trim())
    && typeof caption.sourceText === "string"
    && caption.sourceText === caption.text
    && caption.sourceAlignmentId === undefined
    && caption.sourceCaptionProgramId === undefined
    && caption.sourceTokenStartIndex === undefined
    && caption.sourceTokenEndIndex === undefined
    && caption.sourceCaptionRationale === undefined;
}

/**
 * 正式段级字幕只要求当前 A-roll 可安全读取。若存在旧的纯自动 chunk_coarse，新的默认
 * Program 会在同一提交中替换它；人工或已审片的 Program 绝不能被新 Run 静默覆盖。
 */
function sourceCaptionAlignmentTarget(snapshot: ProjectSnapshot, timelineItemId: Id, speechSource?: SourceAudioAlignment["speechSource"]): SourceCaptionAlignmentTarget {
  const item = snapshot.timeline.items.find((candidate) => candidate.id === timelineItemId);
  if (!item || item.disabled) throw new DomainError("原声字幕对齐目标 Timeline Item 不存在或不可播放", "SOURCE_CAPTION_ALIGNMENT_ITEM_NOT_FOUND");
  if (speechSource) {
    if (!sourceAudioAlignmentOwnerMatches(snapshot, { sourceTimelineItemId: item.id, sourceAssetId: item.assetId, speechSource })
      || item.startFrame !== 0 || item.sourceStartFrame !== 0
      || item.sourceEndFrame !== millisecondsToFrames(assetById(snapshot, item.assetId).metadata?.durationMs ?? 0, snapshot.timeline.fps)) {
      throw new DomainError("旁白字幕只能绑定当前完整、唯一可播放的 SpeechAsset，不能伪装成原声 A-roll", "SPEECH_CAPTION_SOURCE_STALE");
    }
    const derivedCaptions = snapshot.timeline.captions.filter(caption => caption.sourceKind !== "source_audio");
    if (derivedCaptions.some(caption => caption.textMode === "manual" || caption.emphasis !== undefined
      || caption.text !== snapshot.speechSegments.find(segment => segment.id === caption.speechSegmentId)?.text)) {
      throw new DomainError("旁白已有人工改写或强调的字幕，不能静默覆盖；请先确认要重做的字幕", "SPEECH_CAPTION_EDIT_CONFLICT");
    }
    if (derivedCaptions.some(caption => JSON.stringify(caption.format ?? DEFAULT_CAPTION_FORMAT)
      !== JSON.stringify(derivedCaptions[0]?.format ?? DEFAULT_CAPTION_FORMAT))) {
      throw new DomainError("旁白字幕已有不同的局部版式，不能在重分屏时静默丢失；请先确认统一版式", "SPEECH_CAPTION_EDIT_CONFLICT");
    }
  } else {
  const actorTrack = trackByName(snapshot, "Actor / A-roll");
  if (item.trackId !== actorTrack.id) throw new DomainError("原声字幕对齐只能绑定 Actor / A-roll 中的一次明确使用", "SOURCE_CAPTION_ALIGNMENT_ITEM_NOT_ACTOR");
  const performance = snapshot.actorPerformances.find((candidate) => candidate.timelineItemId === item.id);
  if (!performance || performance.status !== "ready" || performance.audioMode !== "use_source_audio") {
    throw new DomainError("原声字幕对齐要求当前 A-roll 已登记为 use_source_audio 的就绪人物表演", "SOURCE_CAPTION_ALIGNMENT_AUDIO_MODE_REQUIRED");
  }
  if (snapshot.speechAsset?.status === "ready") {
    throw new DomainError("当前已有可播放 SpeechAsset；不能将它与原声字幕对齐混用", "SOURCE_CAPTION_ALIGNMENT_DIALOGUE_CONFLICT");
  }
  }
  const asset = assetById(snapshot, item.assetId);
  if (asset.status !== "ready" || !asset.metadata?.hasAudio) {
    throw new DomainError("原声字幕对齐目标必须是已就绪且确实包含音频的 A-roll", "SOURCE_CAPTION_ALIGNMENT_ASSET_NOT_READY");
  }
  if (item.sourceEndFrame - item.sourceStartFrame !== item.endFrame - item.startFrame) {
    throw new DomainError("当前 A-roll 使用了非一比一源范围，不能安全投影 FunASR 字幕段时间", "SOURCE_CAPTION_ALIGNMENT_TIME_MAPPING_UNSUPPORTED");
  }
  const captions = snapshot.timeline.captions
    .filter((caption) => caption.sourceKind === "source_audio" && caption.sourceTimelineItemId === item.id)
    .sort((left, right) => (left.sourceStartFrame ?? 0) - (right.sourceStartFrame ?? 0));
  for (const caption of captions) {
    assertCurrentSourceAudioCaption(snapshot, caption);
    if (caption.sourceAssetId !== asset.id || !isReplaceableSourceCaptionCoarse(caption)) {
      throw new DomainError(
        "当前 A-roll 含人工或已编译的原声字幕；新 Provider 段不会猜测如何覆盖它们。请先明确保留或重做这些字幕。",
        "SOURCE_CAPTION_ALIGNMENT_COARSE_CAPTIONS_INELIGIBLE"
      );
    }
  }
  if (snapshot.sourceCaptionPrograms.some((program) => program.sourceTimelineItemId === item.id)) {
    throw new DomainError("当前 A-roll 已有已编译的原声字幕 Program；不能在未明确重做前覆盖已审片结果", "SOURCE_CAPTION_PROGRAM_ALREADY_EXISTS");
  }
  return { item, asset };
}

/**
 * 将 Provider 的正式段级结果编译为当前 A-roll 的默认字幕 Program。这里一段只创建一张
 * CaptionCard；token 索引仅用于复核时间事实，Renderer 不会逐个读取或显示 token。
 */
function compileProviderSourceCaptionProgram(input: {
  snapshot: ProjectSnapshot;
  item: TimelineItem;
  asset: Asset;
  alignment: SourceAudioAlignment;
}): { program: SourceCaptionProgram; captions: CaptionCard[] } {
  const { snapshot, item, asset, alignment } = input;
  if (alignment.segments.length === 0) {
    throw new DomainError("原声字幕对齐没有 Provider 字幕段，不能创建空 Program", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  const programId = createId("source_caption_program");
  const tokens = alignment.tokens;
  const hasTokenEvidence = alignment.tokenPrecision === "provider_token_timed" && Boolean(tokens?.length);
  if (alignment.tokenPrecision === "provider_token_timed" && !hasTokenEvidence) {
    throw new DomainError("原声字幕对齐声明 token 精度但缺少完整 token 证据", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
  }
  let previousSourceEndFrame = item.sourceStartFrame;
  const captions = alignment.segments.map((segment, index): CaptionCard => {
    const displayText = normalizeProviderCaptionText(segment.displayText, `第 ${index + 1} 个 Provider 字幕段文案`);
    if (hasTokenEvidence) {
      if (!Number.isInteger(segment.tokenStartIndex) || !Number.isInteger(segment.tokenEndIndex)
        || segment.tokenStartIndex === undefined || segment.tokenEndIndex === undefined
        || (index > 0 && segment.tokenStartIndex !== alignment.segments[index - 1]?.tokenEndIndex)
        || segment.tokenEndIndex <= segment.tokenStartIndex || segment.tokenEndIndex > tokens!.length) {
        throw new DomainError("Provider 字幕段 token 范围不是连续的，不能编译为默认字幕", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
      }
      const sourceTokens = tokens!.slice(segment.tokenStartIndex, segment.tokenEndIndex);
      const sourceTokenText = joinSourceAudioTokens(sourceTokens);
      if (normalizeCaptionComparisonText(displayText) !== normalizeCaptionComparisonText(sourceTokenText)
        || segment.startMs !== sourceTokens[0]!.startMs || segment.endMs !== sourceTokens.at(-1)!.endMs) {
        throw new DomainError("Provider 字幕段无法由当前同源 token 验证，不能创建估时字幕", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
      }
    } else if (segment.tokenStartIndex !== undefined || segment.tokenEndIndex !== undefined) {
      throw new DomainError("没有完整 token 证据的 Provider 段不能携带 token 范围", "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID");
    }
    const sourceStartFrame = sourceAudioTimeOrigin(alignment) + millisecondsToFrames(segment.startMs, snapshot.timeline.fps);
    const sourceEndFrame = sourceAudioTimeOrigin(alignment) + millisecondsToFrames(segment.endMs, snapshot.timeline.fps);
    const startFrame = item.startFrame + (sourceStartFrame - item.sourceStartFrame);
    const endFrame = item.startFrame + (sourceEndFrame - item.sourceStartFrame);
    if (sourceStartFrame < previousSourceEndFrame || sourceEndFrame <= sourceStartFrame
      || sourceStartFrame < item.sourceStartFrame || sourceEndFrame > item.sourceEndFrame
      || startFrame < item.startFrame || endFrame <= startFrame || endFrame > item.endFrame) {
      throw new DomainError("Provider 字幕段无法安全映射到当前 Timeline", "SOURCE_CAPTION_SEGMENT_TIME_MAPPING_INVALID");
    }
    previousSourceEndFrame = sourceEndFrame;
    const tokenFields = hasTokenEvidence ? {
      sourceTokenStartIndex: segment.tokenStartIndex,
      sourceTokenEndIndex: segment.tokenEndIndex,
      sourceCaptionRationale: "Provider 返回的同源字幕段"
    } : {};
    return {
      id: createId("caption"),
      sourceKind: "source_audio",
      sourceAssetId: asset.id,
      sourceTimelineItemId: item.id,
      sourceStartFrame,
      sourceEndFrame,
      sourceBridgeRunId: alignment.bridgeAudit.runId,
      sourceAlignmentId: alignment.id,
      sourceCaptionProgramId: programId,
      ...tokenFields,
      // Provider 标点属于同次段级输出，不把它误标成用户手工改写。
      sourceText: displayText,
      text: displayText,
      textMode: "derived",
      startFrame,
      endFrame,
      style: "stable",
      format: { ...DEFAULT_CAPTION_FORMAT },
      precision: hasTokenEvidence ? "source_token_anchored" : "sentence_exact"
    };
  });
  if (hasTokenEvidence && alignment.segments.at(-1)?.tokenEndIndex !== tokens!.length) {
    throw new DomainError("Provider 字幕段没有完整覆盖原声 token，不能创建默认字幕", "SOURCE_CAPTION_SEGMENT_TOKEN_COVERAGE_INVALID");
  }
  return {
    program: {
      id: programId,
      alignmentId: alignment.id,
      sourceAssetId: asset.id,
      sourceTimelineItemId: item.id,
      captionIds: captions.map((caption) => caption.id),
      source: "provider_segments",
      createdAt: now()
    },
    captions
  };
}

function occurrenceIndex(text: string, phrase: string, occurrence: number): number {
  let index = -1;
  for (let offset = 0; offset <= occurrence; offset += 1) {
    index = text.indexOf(phrase, index + 1);
    if (index < 0) return -1;
  }
  return index;
}

function normalizeCaptionEmphasis(value: CaptionEmphasis, captionText: string): CaptionEmphasis {
  const text = requireText(value.text, "字幕强调短语");
  if (text.length > 40 || text.includes("\n")) {
    throw new DomainError("字幕强调短语必须是一行不超过 40 个字符的连续文字", "INVALID_CAPTION_EMPHASIS_TEXT");
  }
  if (!Number.isInteger(value.occurrence) || value.occurrence < 0 || occurrenceIndex(captionText, text, value.occurrence) < 0) {
    throw new DomainError("字幕强调短语必须是当前字幕中的连续文字", "CAPTION_EMPHASIS_NOT_FOUND");
  }
  if (value.scale !== undefined && (!Number.isFinite(value.scale) || value.scale < 0.8 || value.scale > 1.35)) {
    throw new DomainError("字幕强调缩放必须在 0.8 到 1.35 之间", "INVALID_CAPTION_EMPHASIS_SCALE");
  }
  if (value.fontWeight !== undefined && (!Number.isInteger(value.fontWeight) || value.fontWeight < 400 || value.fontWeight > 900)) {
    throw new DomainError("字幕强调字重必须在 400 到 900 之间", "INVALID_CAPTION_EMPHASIS_WEIGHT");
  }
  return {
    text,
    occurrence: value.occurrence,
    color: requireCaptionColor(value.color, "字幕强调颜色"),
    backgroundColor: requireCaptionColor(value.backgroundColor, "字幕强调背景颜色"),
    fontWeight: value.fontWeight,
    scale: value.scale
  };
}

function normalizedTextList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

/** 从 Scene props 读取必填文字；不接受空白字符串冒充已提供事实。 */
function asRequiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 仅保留可展示的文字项，避免把任意 JSON 直接写进视觉解释场景。 */
function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

/** 历史节点必须保留日期与发生内容；不能把一串无来源的装饰文字当作时间线。 */
function asHistoryEvents(value: unknown): Array<{ date: string; label: string; detail?: string }> {
  if (!Array.isArray(value)) return [];
  const events = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    const date = asRequiredString(record.date);
    const label = asRequiredString(record.label);
    if (!date || !label) return undefined;
    return { date, label, detail: asRequiredString(record.detail) };
  });
  return events.every((item) => item !== undefined) ? events : [];
}

const EXPLAINER_KINDS: ExplainerSceneKind[] = [
  "HeroReveal",
  "Comparison",
  "ProgressiveClassification",
  "RouteAndFlow",
  "EvidenceDocument",
  "UIWalkthrough",
  "DataConclusion",
  "PeopleGrouping",
  "LayerStack",
  "HistoryTimeline",
  "QuotePortrait",
  "RealityBroll"
];

/**
 * Explainer 的可渲染画面发生兼容性变化时必须递增此版本。
 * 它进入 Scene Cache Key，避免旧的局部预览被错误复用于新版组件。
 */
const EXPLAINER_SCENE_RUNTIME_VERSION = "1";

/** 递归排序让同一 Scene 输入产生稳定缓存键，而不是受对象字段插入顺序影响。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function explainerCacheKey(input: {
  kind: ExplainerSceneKind;
  primaryTask: string;
  assetHashes: string[];
  states: ExplainerSceneState[];
  props: Record<string, unknown>;
  stylePackId: string;
  renderTarget: { fps: number; width: number; height: number };
  runtimeVersion: string;
  narrativeMapBeat: NarrativeMapBeat;
  evidence?: Pick<EvidenceCapture, "id" | "sourceAssetId" | "snapshotAssetId" | "excerpt" | "claim" | "limitation" | "highlights">;
}): string {
  return createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 32);
}

function requireExplainerKind(value: ExplainerSceneKind | undefined): ExplainerSceneKind {
  if (!value || !EXPLAINER_KINDS.includes(value)) throw new DomainError("Explainer Scene 类型尚未注册", "EXPLAINER_SCENE_KIND_UNSUPPORTED");
  return value;
}

function normalizeEvidenceHighlights(highlights: EvidenceHighlight[] | undefined): EvidenceHighlight[] {
  const normalized = (highlights ?? []).map((highlight) => ({
    x: highlight.x,
    y: highlight.y,
    width: highlight.width,
    height: highlight.height,
    label: highlight.label?.trim() || undefined
  }));
  if (normalized.length === 0 || normalized.length > 12) throw new DomainError("证据必须提供 1 到 12 个高亮区域", "EVIDENCE_HIGHLIGHT_REQUIRED");
  for (const highlight of normalized) {
    if (![highlight.x, highlight.y, highlight.width, highlight.height].every(Number.isFinite)
      || highlight.x < 0 || highlight.y < 0 || highlight.width <= 0 || highlight.height <= 0
      || highlight.x + highlight.width > 1 || highlight.y + highlight.height > 1) {
      throw new DomainError("证据高亮必须位于 0 到 1 的页面归一化范围内", "INVALID_EVIDENCE_HIGHLIGHT");
    }
  }
  return normalized;
}

function normalizeExplainerStates(states: ExplainerSceneState[], duration: number): ExplainerSceneState[] {
  if (states.length < 4 || states.length > 12) throw new DomainError("Explainer Scene 必须提供 Entry、Progressive、Settled、Exit 四类局部状态", "EXPLAINER_STATE_REQUIRED");
  const normalized = states.map((state) => ({
    id: state.id || createId("explainer_state"),
    phase: state.phase,
    startFrame: state.startFrame,
    endFrame: state.endFrame,
    label: requireText(state.label, "Explainer 状态标签"),
    detail: state.detail?.trim() || undefined
  })).sort((left, right) => left.startFrame - right.startFrame);
  const required = new Set<ExplainerSceneState["phase"]>(["entry", "progressive", "settled", "exit"]);
  const present = new Set(normalized.map((state) => state.phase));
  if (![...required].every((phase) => present.has(phase))) throw new DomainError("Explainer Scene 缺少 Entry、Progressive、Settled 或 Exit 状态", "EXPLAINER_STATE_PHASE_MISSING");
  // 允许一个阶段拆成多段，但叙事顺序必须始终是建立 → 推进 → 稳定阅读 → 退出。
  const phaseOrder: Record<ExplainerSceneState["phase"], number> = { entry: 0, progressive: 1, settled: 2, exit: 3 };
  if (normalized.some((state, index) => index > 0 && phaseOrder[normalized[index - 1]!.phase] > phaseOrder[state.phase])) {
    throw new DomainError("Explainer 局部状态必须按 Entry、Progressive、Settled、Exit 顺序推进", "EXPLAINER_STATE_PHASE_ORDER_INVALID");
  }
  if (normalized[0]?.startFrame !== 0 || normalized.at(-1)?.endFrame !== duration) {
    throw new DomainError("Explainer 局部状态必须从场景第 0 帧连续覆盖到结束帧", "EXPLAINER_STATE_COVERAGE_INVALID");
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const state = normalized[index]!;
    if (!Number.isInteger(state.startFrame) || !Number.isInteger(state.endFrame) || state.startFrame < 0 || state.endFrame <= state.startFrame || state.endFrame > duration) {
      throw new DomainError("Explainer 局部状态帧范围无效", "EXPLAINER_STATE_RANGE_INVALID");
    }
    if (index > 0 && normalized[index - 1]!.endFrame !== state.startFrame) {
      throw new DomainError("Explainer 局部状态不能重叠或留下未解释空档", "EXPLAINER_STATE_GAP_INVALID");
    }
  }
  return normalized;
}

/** 人物头部/手部锚点只能是人工确认的静态画布位置，不能伪装成逐帧追踪数据。 */
function normalizeActorLayout(layout: ActorLayout | undefined): ActorLayout | undefined {
  if (!layout) return undefined;
  const normalizePoint = (point: ActorLayout["actorHead"] | undefined, label: string) => {
    if (!point) return undefined;
    if (point.source !== "manual_static") throw new DomainError(`${label}目前只支持人工确认的静态锚点`, "ACTOR_ANCHOR_SOURCE_UNSUPPORTED");
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      throw new DomainError(`${label}必须位于 0 到 1 的画布范围内`, "INVALID_ACTOR_ANCHOR");
    }
    return { x: point.x, y: point.y, source: "manual_static" as const };
  };
  const actorHead = normalizePoint(layout.actorHead, "人物头部锚点");
  const actorHands = normalizePoint(layout.actorHands, "人物手部锚点");
  if (!actorHead && !actorHands) throw new DomainError("人物布局至少需要一个头部或手部锚点", "EMPTY_ACTOR_LAYOUT");
  return { actorHead, actorHands };
}

function normalizeAvatarInputModes(inputModes: AvatarInputMode[]): AvatarInputMode[] {
  const next = [...new Set(inputModes)];
  if (next.length === 0 || next.some((mode) => mode !== "audio" && mode !== "text")) {
    throw new DomainError("人物能力档案至少需要声明 audio 或 text 输入", "INVALID_AVATAR_INPUT_MODE");
  }
  return next;
}

function normalizeActorMaskModes(maskModes: ActorMaskMode[]): ActorMaskMode[] {
  const next = [...new Set(maskModes)];
  if (next.length === 0 || next.some((mode) => !["alpha_asset", "embedded_alpha", "none"].includes(mode))) {
    throw new DomainError("人物能力档案必须声明至少一种有效 Mask 模式", "INVALID_AVATAR_MASK_MODE");
  }
  return next;
}

function candidateFilterReasons(
  candidate: Pick<AssetCandidate, "originalAssetId" | "sourceUrl" | "durationMs"> & { kind?: AssetCandidate["kind"] },
  request: Pick<AssetRequest, "minDurationMs" | "mediaKind">
): string[] {
  const reasons: string[] = [];
  if ((request.mediaKind === "audio") !== (candidate.kind === "audio")) reasons.push("候选媒介类型不符合声音/视觉需求。");
  if (!candidate.originalAssetId.trim()) reasons.push("Provider 未返回原始素材 ID。");
  if (!candidate.sourceUrl.trim()) reasons.push("Provider 未返回可追溯的来源页面。");
  // 连续长度留到实际选段判断；缺省或短文件仍可取得并探测。
  return reasons;
}

function candidateIsAllowed(candidate: Pick<AssetCandidate, "originalAssetId" | "sourceUrl" | "durationMs" | "hardFilterPassed" | "kind">, request: Pick<AssetRequest, "minDurationMs" | "mediaKind">): boolean {
  if (!candidate.hardFilterPassed) return false;
  return candidateFilterReasons(candidate, request).length === 0;
}

/** 只移除已废弃的自动时长拒绝，不解除人工拒绝或需求变化。 */
function refreshCandidateDurationFilter(candidate: AssetCandidate, request: AssetRequest): AssetCandidate {
  const oldReasons = candidate.filterReasons;
  const remaining = oldReasons.filter(reason => !/^时长不足 \d+ 秒。$/u.test(reason));
  if (remaining.length === oldReasons.length) return candidate;
  const automaticallyRejected = candidate.rejectionReason === oldReasons.join(" ");
  candidate.filterReasons = [...new Set([...remaining, ...candidateFilterReasons(candidate, request)])];
  candidate.hardFilterPassed = candidate.filterReasons.length === 0;
  if (automaticallyRejected) {
    candidate.rejectionReason = candidate.filterReasons.join(" ") || undefined;
    if (candidate.status === "rejected" && candidate.hardFilterPassed) candidate.status = "available";
  }
  return candidate;
}

/** Provider 已完成字段归一化后的候选；私有下载地址和 API Key 不进入 Revision。 */
export interface AssetSearchCandidateInput {
  originalAssetId: string;
  name: string;
  kind?: AssetCandidate["kind"];
  sourceUrl: string;
  previewUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  creator?: string;
  tags?: string[];
}

/** Editing Application 是唯一命令入口；HTTP、MCP 和 Worker 都委托这里。 */
export class EditingApplication {
  private readonly listeners = new Set<(event: AppEvent) => void>();
  private readonly productionAuditWrites = new Map<Id, Promise<void>>();

  /** 同一入口并发提交审片/决策时串行读改写，避免后完成的请求覆盖先完成的问题。 */
  private async withProductionAuditLock<T>(projectId: Id, operation: () => Promise<T>): Promise<T> {
    const previous = this.productionAuditWrites.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    this.productionAuditWrites.set(projectId, pending);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.productionAuditWrites.get(projectId) === pending) this.productionAuditWrites.delete(projectId);
    }
  }

  readonly intelligence: MediaIntelligenceApplication;
  constructor(public readonly repository: ProjectRepository) {
    this.intelligence = new MediaIntelligenceApplication(this);
  }

  close(): void {
    this.repository.close();
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: AppEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private agentWorkOrderById(snapshot: ProjectSnapshot, workOrderId: Id): AgentWorkOrder {
    const workOrder = snapshot.agentWorkOrders.find((candidate) => candidate.id === workOrderId);
    if (!workOrder) throw new NotFoundError(`Agent 工作单不存在：${workOrderId}`);
    return workOrder;
  }

  /**
   * 工作单引用始终指向当前 Revision：对象消失时阻止接手/完成，已 stale 则留下提示，
   * 让 Codex 先复核，而不是把旧对象当作仍然可编辑的事实。
   */
  private inspectAgentWorkOrderObjects(snapshot: ProjectSnapshot, relatedObjectIds: Id[]): AgentWorkOrderRelatedObjectIssue[] {
    const objects = [
      snapshot.project, snapshot.story, ...snapshot.assets, ...snapshot.assetRequests, ...snapshot.searchIntents,
      ...snapshot.assetCandidates, ...(snapshot.narrativeMap ? [snapshot.narrativeMap] : []), ...snapshot.evidenceCaptures,
      ...snapshot.explainerPrograms, ...snapshot.vlogShotAnalyses, ...snapshot.vlogEvents, ...snapshot.vlogShotSelects,
      ...snapshot.vlogAmbientCues, ...snapshot.vlogMusicBeats, ...snapshot.multicamGroups, ...snapshot.multicamCuts,
      ...snapshot.visualTreatments, ...snapshot.cutaways, ...snapshot.audioCues, ...snapshot.voiceReferences,
      ...snapshot.transcripts, ...snapshot.transcriptSentenceCandidates, ...snapshot.semanticUnits, ...snapshot.speechSegments,
      ...snapshot.speechSegmentAssets, ...(snapshot.speechAsset ? [snapshot.speechAsset] : []), ...snapshot.actorCapabilityProfiles,
      ...snapshot.actorPerformances, ...snapshot.scenes, ...snapshot.effectCues, ...snapshot.timeline.tracks,
      ...snapshot.timeline.items, ...snapshot.timeline.captions, ...snapshot.markers
    ] as Array<{ id: Id; status?: unknown }>;
    const objectById = new Map(objects.map((object) => [object.id, object]));
    const missing = relatedObjectIds.filter((objectId) => !objectById.has(objectId));
    if (missing.length > 0) {
      throw new DomainError(`Agent 工作单关联对象不存在于当前 Revision：${missing.join(", ")}`, "AGENT_WORK_ORDER_OBJECT_NOT_FOUND");
    }
    return relatedObjectIds.flatMap((objectId) => objectById.get(objectId)?.status === "stale"
      ? [{ objectId, kind: "stale" as const, message: "关联对象当前为 stale，完成前需要确认它仍满足工作单意图。" }]
      : []);
  }

  /** 完成前比较编辑快照，排除工作单和 project.updatedAt 的纯审计变化。 */
  private hasActualAgentWorkOrderEdit(projectId: Id, claimedRevision: number, resultRevision: number): boolean {
    const comparable = (revision: number) => {
      const snapshot = cloneSnapshot(this.repository.getRevision(projectId, revision).snapshot);
      snapshot.agentWorkOrders = [];
      snapshot.project.updatedAt = "";
      return JSON.stringify(snapshot);
    };
    return comparable(claimedRevision) !== comparable(resultRevision);
  }

  /** 从不可变 Revision 历史聚合实际影响，完成记录不依赖会话文字或临时 UI 状态。 */
  private agentWorkOrderResultImpact(projectId: Id, claimedRevision: number, resultRevision: number): {
    changedObjectIds: Id[];
    impact: AgentWorkOrderResultImpact;
  } {
    const revisions = this.repository.listRevisions(projectId)
      .filter((revision) => revision.number > claimedRevision && revision.number <= resultRevision)
      .sort((left, right) => left.number - right.number);
    const workOrderIds = new Set<Id>();
    for (const revision of revisions) {
      for (const workOrder of this.repository.getRevision(projectId, revision.number).snapshot.agentWorkOrders) workOrderIds.add(workOrder.id);
    }
    const changedObjectIds = [...new Set(revisions.flatMap((revision) => [...revision.impact.changed, ...revision.impact.moved])
      .filter((objectId) => !workOrderIds.has(objectId)))];
    return {
      changedObjectIds,
      impact: {
        fromRevision: claimedRevision,
        toRevision: resultRevision,
        revisions: revisions.map((revision) => ({
          revision: revision.number,
          summary: revision.summary,
          changedObjectIds: revision.impact.changed.filter((objectId) => !workOrderIds.has(objectId)),
          movedObjectIds: revision.impact.moved.filter((objectId) => !workOrderIds.has(objectId)),
          staleObjectIds: revision.impact.stale.filter((objectId) => !workOrderIds.has(objectId)),
          dirtyRanges: revision.impact.dirtyRanges,
          warnings: revision.impact.warnings
        }))
      }
    };
  }

  createProject(input: { name: string; profile?: ProjectSnapshot["project"]["profile"]; brief?: Partial<CreativeBrief>; fps?: number }): ProjectState {
    const state = this.repository.createProject(input);
    this.publish({ projectId: state.snapshot.project.id, revision: state.revision.number, type: "revision" });
    return state;
  }

  previewProjectFrameRateChange(input: { projectId: Id; baseRevision: number; fps: number }) {
    const current = this.readProject(input.projectId);
    if (current.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, current.revision.number);
    return prepareProjectFrameRateChange(current.snapshot, input.fps, current.revision.number, this.repository.listJobs(input.projectId)).report;
  }

  setProjectFrameRate(input: { projectId: Id; baseRevision: number; fps: number }) {
    const current = this.readProject(input.projectId);
    if (current.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, current.revision.number);
    const initial = prepareProjectFrameRateChange(current.snapshot, input.fps, current.revision.number, this.repository.listJobs(input.projectId));
    if (!initial.report.canApply) throw new DomainError(initial.report.blockers.map(entry => `${entry.objectId ?? "项目"}：${entry.message}`).join("；"), initial.report.blockers[0].code);
    if (!initial.report.changed) return { ...current, frameRateChange: initial.report };
    let report = initial.report;
    const state = this.repository.commit(input.projectId, input.baseRevision, `项目帧率 ${current.snapshot.timeline.fps} → ${input.fps}，保持实际时间`, (snapshot, impact) => {
      // 在事务中再次检查Worker状态与转换结果，预检查不是绕过并发保护的令牌。
      const change = prepareProjectFrameRateChange(snapshot, input.fps, input.baseRevision, this.repository.listJobs(input.projectId));
      if (!change.report.canApply) throw new DomainError(change.report.blockers.map(entry => `${entry.objectId ?? "项目"}：${entry.message}`).join("；"), change.report.blockers[0].code);
      report = change.report;
      Object.assign(snapshot, change.snapshot);
      impact.changed.push(...report.affectedObjectIds);
      impact.recomputed.push("项目帧坐标、语音毫秒投影与动效事件映射");
      impact.warnings.push(...report.warnings);
      if (snapshot.timeline.durationInFrames) impact.dirtyRanges.push({ startFrame: 0, endFrame: snapshot.timeline.durationInFrames, reason: "项目帧率变化，重建合成预览并复核声画" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return { ...state, frameRateChange: report };
  }

  listProjects(): ProjectSummary[] {
    return this.repository.listProjects();
  }

  readProject(projectId: Id): ProjectState {
    return this.repository.getCurrent(projectId);
  }

  readRevisions(projectId: Id) {
    return this.repository.listRevisions(projectId);
  }

  /**
   * 工作单是 Web 与 Codex 的交接队列，不是另一份 Timeline。读取时连同当前 Revision 返回，
   * 让接手方可以在修改前显式处理并发冲突。
   */
  readAgentWorkOrders(projectId: Id): { revision: number; agentWorkOrders: AgentWorkOrder[] } {
    const state = this.readProject(projectId);
    return { revision: state.revision.number, agentWorkOrders: state.snapshot.agentWorkOrders };
  }

  /**
   * 平台修复工单与视频编辑 Revision 严格分表保存。剪辑 Agent 因 MCP 或 Runtime 被阻断时，
   * 只能报告事实并暂停；它不能借“报障”修改 Timeline、素材或源码。
   */
  reportEditingBlocker(input: {
    projectId: Id;
    reportedRevision: number;
    category: RepairTicketCategory;
    summary: string;
    detail?: string;
    toolName?: string;
    jobId?: Id;
    reporterId: string;
    reportedReleaseId: string;
    idempotencyKey: string;
  }): RepairTicket {
    if (!Number.isInteger(input.reportedRevision) || input.reportedRevision <= 0) {
      throw new DomainError("修复工单必须绑定一个有效的视频 Revision", "REPAIR_TICKET_REVISION_INVALID");
    }
    if (!(["tool_missing", "tool_error", "runtime_failure", "workflow_blocker"] as const).includes(input.category)) {
      throw new DomainError("修复工单类别无效", "REPAIR_TICKET_CATEGORY_INVALID");
    }
    const summary = requireText(input.summary, "修复工单摘要");
    const reporterId = requireText(input.reporterId, "剪辑 Agent 标识");
    const reportedReleaseId = requireText(input.reportedReleaseId, "报告时发行版本");
    const idempotencyKey = requireText(input.idempotencyKey, "修复工单幂等键");
    const detail = input.detail?.trim() || undefined;
    const toolName = input.toolName?.trim() || undefined;
    if (summary.length > 1_000 || detail && detail.length > 8_000 || toolName && toolName.length > 160
      || reporterId.length > 160 || reportedReleaseId.length > 160 || idempotencyKey.length > 240) {
      throw new DomainError("修复工单字段超过允许长度", "REPAIR_TICKET_TEXT_TOO_LONG");
    }
    const ticket = this.repository.createRepairTicket({
      projectId: input.projectId,
      reportedRevision: input.reportedRevision,
      category: input.category,
      summary,
      detail,
      toolName,
      jobId: input.jobId,
      reporterId,
      reportedReleaseId,
      idempotencyKey
    });
    // 事件只通知外部刷新；ticket 不会制造一个虚假的视频 Revision。
    this.publish({ projectId: ticket.projectId, revision: this.readProject(ticket.projectId).revision.number, type: "repair_ticket" });
    return ticket;
  }

  /** 读取工单时同时带回当前视频 Revision，剪辑 Agent 重新开始前仍必须显式处理并发变化。 */
  readRepairTickets(input: { projectId: Id; statuses?: RepairTicketStatus[] }): { revision: number; repairTickets: RepairTicket[] } {
    const state = this.readProject(input.projectId);
    const statuses = input.statuses ? [...new Set(input.statuses)] : undefined;
    if (statuses && statuses.some((status) => !(["open", "claimed", "ready_for_cutover", "deployed", "acknowledged", "resolved_without_deployment"] as const).includes(status))) {
      throw new DomainError("修复工单状态筛选无效", "REPAIR_TICKET_STATUS_INVALID");
    }
    return { revision: state.revision.number, repairTickets: this.repository.listRepairTickets({ projectId: input.projectId, statuses }) };
  }

  /** 修复任务只可接手平台工单；不能接手后顺便进入正式视频项目做剪辑。 */
  claimRepairTicket(input: { ticketId: Id; repairerId: string }): RepairTicket {
    const repairerId = requireText(input.repairerId, "修复 Agent 标识");
    if (repairerId.length > 160) throw new DomainError("修复 Agent 标识不能超过 160 个字符", "REPAIR_TICKET_AGENT_TOO_LONG");
    const ticket = this.repository.claimRepairTicket({ ticketId: input.ticketId, repairerId });
    this.publish({ projectId: ticket.projectId, revision: this.readProject(ticket.projectId).revision.number, type: "repair_ticket" });
    return ticket;
  }

  releaseRepairTicket(input: { ticketId: Id; repairerId: string; reason: string }): RepairTicket {
    const repairerId = requireText(input.repairerId, "修复 Agent 标识");
    const reason = requireText(input.reason, "修复工单释放原因");
    if (repairerId.length > 160 || reason.length > 4_000) {
      throw new DomainError("修复工单释放字段超过允许长度", "REPAIR_TICKET_TEXT_TOO_LONG");
    }
    const ticket = this.repository.releaseRepairTicket({ ticketId: input.ticketId, repairerId, reason });
    this.publish({ projectId: ticket.projectId, revision: this.readProject(ticket.projectId).revision.number, type: "repair_ticket" });
    return ticket;
  }

  /** 输入错误、重复报告或宿主外部恢复走有证据的非部署收口，不伪造 Release 切换。 */
  resolveRepairTicketWithoutDeployment(input: { ticketId: Id; repairerId: string; kind: "invalid_input" | "duplicate" | "external_recovery"; evidence: string }): RepairTicket {
    const repairerId = requireText(input.repairerId, "修复 Agent 标识");
    const evidence = requireText(input.evidence, "非部署收口证据");
    if (repairerId.length > 160 || evidence.length < 16 || evidence.length > 8_000
      || !(["invalid_input", "duplicate", "external_recovery"] as const).includes(input.kind)) {
      throw new DomainError("非部署收口分类或证据无效", "REPAIR_TICKET_RESOLUTION_INVALID");
    }
    const ticket = this.repository.resolveRepairTicketWithoutDeployment({ ticketId: input.ticketId, repairerId, kind: input.kind, evidence });
    this.publish({ projectId: ticket.projectId, revision: this.readProject(ticket.projectId).revision.number, type: "repair_ticket" });
    return ticket;
  }

  /** 候选版必须经隔离复现与回归验证，不能把临时绕过描述成可切换版本。 */
  markRepairTicketReadyForCutover(input: {
    ticketId: Id;
    repairerId: string;
    candidateReleaseId: string;
    validationSummary: string;
  }): RepairTicket {
    const repairerId = requireText(input.repairerId, "修复 Agent 标识");
    const candidateReleaseId = requireReleaseId(input.candidateReleaseId, "候选发行版本");
    const validationSummary = requireText(input.validationSummary, "候选版本验证摘要");
    if (repairerId.length > 160 || candidateReleaseId.length > 160 || validationSummary.length > 8_000) {
      throw new DomainError("候选版本字段超过允许长度", "REPAIR_TICKET_TEXT_TOO_LONG");
    }
    const ticket = this.repository.markRepairTicketReadyForCutover({
      ticketId: input.ticketId, repairerId, candidateReleaseId, validationSummary
    });
    this.publish({ projectId: ticket.projectId, revision: this.readProject(ticket.projectId).revision.number, type: "repair_ticket" });
    return ticket;
  }

  /** 部署记录只接受与已经验证的候选版完全相同的 Release ID。 */
  markRepairTicketDeployed(input: {
    ticketId: Id;
    repairerId: string;
    releaseId: string;
    deploymentEvidence: string;
  }): RepairTicket {
    const repairerId = requireText(input.repairerId, "修复 Agent 标识");
    const releaseId = requireReleaseId(input.releaseId, "已部署发行版本");
    const deploymentEvidence = requireText(input.deploymentEvidence, "部署证据");
    if (repairerId.length > 160 || releaseId.length > 160 || deploymentEvidence.length > 8_000) {
      throw new DomainError("部署字段超过允许长度", "REPAIR_TICKET_TEXT_TOO_LONG");
    }
    const ticket = this.repository.markRepairTicketDeployed({ ticketId: input.ticketId, repairerId, releaseId, deploymentEvidence });
    this.publish({ projectId: ticket.projectId, revision: this.readProject(ticket.projectId).revision.number, type: "repair_ticket" });
    return ticket;
  }

  /** 剪辑 Agent 重连新版 MCP 后，以当前实际 Revision 确认恢复；不允许旧会话代替确认。 */
  acknowledgeRepairTicketDeployment(input: {
    ticketId: Id;
    editorId: string;
    releaseId: string;
    observedRevision: number;
  }): RepairTicket {
    const editorId = requireText(input.editorId, "剪辑 Agent 标识");
    const releaseId = requireReleaseId(input.releaseId, "确认发行版本");
    if (editorId.length > 160 || releaseId.length > 160 || !Number.isInteger(input.observedRevision) || input.observedRevision <= 0) {
      throw new DomainError("部署确认字段无效", "REPAIR_TICKET_ACKNOWLEDGEMENT_INVALID");
    }
    const ticket = this.repository.acknowledgeRepairTicketDeployment({
      ticketId: input.ticketId, editorId, releaseId, observedRevision: input.observedRevision
    });
    this.publish({ projectId: ticket.projectId, revision: ticket.acknowledgedRevision!, type: "repair_ticket" });
    return ticket;
  }

  /** Web 用户创建可审计意图；关联对象只保存 ID，不复制它们的内容或 Timeline。 */
  createAgentWorkOrder(input: {
    projectId: Id;
    baseRevision: number;
    title: string;
    intent: string;
    relatedObjectIds?: Id[];
  }): { state: ProjectState; workOrder: AgentWorkOrder } {
    let workOrder!: AgentWorkOrder;
    const state = this.repository.commit(input.projectId, input.baseRevision, "创建 Agent 工作单", (snapshot, impact) => {
      const title = requireText(input.title, "Agent 工作单标题");
      const intent = requireText(input.intent, "Agent 工作单意图");
      if (title.length > 160 || intent.length > 4_000) {
        throw new DomainError("Agent 工作单标题或意图过长", "AGENT_WORK_ORDER_TEXT_TOO_LONG");
      }
      const relatedObjectIds = [...new Set((input.relatedObjectIds ?? []).map((id) => id.trim()))];
      if (relatedObjectIds.some((id) => !id) || relatedObjectIds.length > 80) {
        throw new DomainError("Agent 工作单关联对象不能为空且不能超过 80 个", "AGENT_WORK_ORDER_RELATION_INVALID");
      }
      this.inspectAgentWorkOrderObjects(snapshot, relatedObjectIds);
      workOrder = createAgentWorkOrder({ title, intent, relatedObjectIds, createdRevision: input.baseRevision + 1 });
      snapshot.agentWorkOrders.push(workOrder);
      impact.changed.push(workOrder.id);
      impact.recomputed.push("已建立可由 Codex 接手的 Agent 工作单");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return { state, workOrder };
  }

  /** Codex 接手必须写入新 Revision，避免“已处理”只停留在会话文字中。 */
  claimAgentWorkOrder(input: {
    projectId: Id;
    baseRevision: number;
    workOrderId: Id;
    agentId: string;
  }): { state: ProjectState; workOrder: AgentWorkOrder } {
    let workOrder!: AgentWorkOrder;
    const state = this.repository.commit(input.projectId, input.baseRevision, "Codex 接手 Agent 工作单", (snapshot, impact) => {
      workOrder = this.agentWorkOrderById(snapshot, input.workOrderId);
      if (workOrder.status !== "open") {
        throw new DomainError("只有待处理的 Agent 工作单可以接手", "AGENT_WORK_ORDER_NOT_OPEN");
      }
      const agentId = requireText(input.agentId, "Codex 接手者");
      if (agentId.length > 160) throw new DomainError("Codex 接手者名称不能超过 160 个字符", "AGENT_WORK_ORDER_AGENT_TOO_LONG");
      workOrder.relatedObjectIssues = this.inspectAgentWorkOrderObjects(snapshot, workOrder.relatedObjectIds);
      workOrder.status = "claimed";
      workOrder.claimedBy = agentId;
      workOrder.claimedRevision = input.baseRevision + 1;
      workOrder.updatedAt = now();
      impact.changed.push(workOrder.id);
      impact.recomputed.push("Agent 工作单已由 Codex 接手");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return { state, workOrder };
  }

  /** 原接手者可释放尚未完成的工作单回到 open，供另一位 Codex 在新 Revision 中重新接手。 */
  releaseAgentWorkOrder(input: {
    projectId: Id;
    baseRevision: number;
    workOrderId: Id;
    agentId: string;
    reason: string;
  }): { state: ProjectState; workOrder: AgentWorkOrder } {
    let workOrder!: AgentWorkOrder;
    const state = this.repository.commit(input.projectId, input.baseRevision, "Codex 释放 Agent 工作单", (snapshot, impact) => {
      workOrder = this.agentWorkOrderById(snapshot, input.workOrderId);
      if (workOrder.status !== "claimed") throw new DomainError("只有已接手的 Agent 工作单可以释放", "AGENT_WORK_ORDER_NOT_CLAIMED");
      const agentId = requireText(input.agentId, "Codex 释放者");
      if (workOrder.claimedBy !== agentId) throw new DomainError("只有原接手的 Codex 可以释放工作单", "AGENT_WORK_ORDER_CLAIMER_MISMATCH");
      const reason = requireText(input.reason, "释放原因");
      if (reason.length > 2_000) throw new DomainError("Agent 工作单释放原因不能超过 2000 个字符", "AGENT_WORK_ORDER_RELEASE_REASON_TOO_LONG");
      workOrder.status = "open";
      workOrder.releasedRevision = input.baseRevision + 1;
      workOrder.releaseReason = reason;
      workOrder.claimedBy = undefined;
      workOrder.claimedRevision = undefined;
      workOrder.relatedObjectIssues = this.inspectAgentWorkOrderObjects(snapshot, workOrder.relatedObjectIds);
      workOrder.updatedAt = now();
      impact.changed.push(workOrder.id);
      impact.recomputed.push("Agent 工作单已由 Codex 释放回待处理队列");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return { state, workOrder };
  }

  /** Web 用户可撤回尚未被接手的意图；已接手任务只能由原 Codex 释放，避免静默中断执行。 */
  cancelAgentWorkOrder(input: {
    projectId: Id;
    baseRevision: number;
    workOrderId: Id;
    reason: string;
  }): { state: ProjectState; workOrder: AgentWorkOrder } {
    let workOrder!: AgentWorkOrder;
    const state = this.repository.commit(input.projectId, input.baseRevision, "取消 Agent 工作单", (snapshot, impact) => {
      workOrder = this.agentWorkOrderById(snapshot, input.workOrderId);
      if (workOrder.status !== "open") throw new DomainError("只有待处理的 Agent 工作单可以由 Web 取消", "AGENT_WORK_ORDER_NOT_OPEN");
      const reason = requireText(input.reason, "取消原因");
      if (reason.length > 2_000) throw new DomainError("Agent 工作单取消原因不能超过 2000 个字符", "AGENT_WORK_ORDER_CANCEL_REASON_TOO_LONG");
      workOrder.status = "cancelled";
      workOrder.cancelledRevision = input.baseRevision + 1;
      workOrder.cancellationReason = reason;
      workOrder.updatedAt = now();
      impact.changed.push(workOrder.id);
      impact.recomputed.push("Web 用户已取消未接手的 Agent 工作单");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return { state, workOrder };
  }

  /**
   * 完成回写永远从当前 Revision 推导实际结果 Revision，调用方不能伪造一个旧编号。
   * 本次状态写入自身会再生成一个 Revision，因此同时保存 resultRevision 与 completedRevision。
   */
  completeAgentWorkOrder(input: {
    projectId: Id;
    baseRevision: number;
    workOrderId: Id;
    agentId: string;
    completionSummary: string;
    completionKind: "edited" | "reviewed_no_change";
  }): { state: ProjectState; workOrder: AgentWorkOrder } {
    let workOrder!: AgentWorkOrder;
    const state = this.repository.commit(input.projectId, input.baseRevision, "Codex 完成 Agent 工作单", (snapshot, impact) => {
      workOrder = this.agentWorkOrderById(snapshot, input.workOrderId);
      if (workOrder.status !== "claimed") {
        throw new DomainError("只有已接手的 Agent 工作单可以完成", "AGENT_WORK_ORDER_NOT_CLAIMED");
      }
      const agentId = requireText(input.agentId, "Codex 完成者");
      if (workOrder.claimedBy !== agentId) {
        throw new DomainError("只有原接手的 Codex 可以回写完成状态", "AGENT_WORK_ORDER_CLAIMER_MISMATCH");
      }
      const completionSummary = requireText(input.completionSummary, "Agent 工作单完成摘要");
      if (completionSummary.length > 4_000) throw new DomainError("Agent 工作单完成摘要不能超过 4000 个字符", "AGENT_WORK_ORDER_SUMMARY_TOO_LONG");
      const relatedObjectIssues = this.inspectAgentWorkOrderObjects(snapshot, workOrder.relatedObjectIds);
      if (input.completionKind !== "edited" && input.completionKind !== "reviewed_no_change") {
        throw new DomainError("Agent 工作单完成类型无效", "AGENT_WORK_ORDER_COMPLETION_KIND_INVALID");
      }
      let resultChangedObjectIds: Id[] | undefined;
      let resultImpact: AgentWorkOrderResultImpact | undefined;
      if (input.completionKind === "edited") {
        if (input.baseRevision <= workOrder.claimedRevision! || !this.hasActualAgentWorkOrderEdit(input.projectId, workOrder.claimedRevision!, input.baseRevision)) {
          throw new DomainError("接手后没有实际编辑变化；请改用 reviewed_no_change 明确回写审查结论", "AGENT_WORK_ORDER_NO_EDIT_RESULT");
        }
        const evidence = this.agentWorkOrderResultImpact(input.projectId, workOrder.claimedRevision!, input.baseRevision);
        if (evidence.changedObjectIds.length === 0) {
          throw new DomainError("实际编辑没有可追溯的对象影响；不能把无证据的工作单标记为已编辑完成", "AGENT_WORK_ORDER_EDIT_EVIDENCE_MISSING");
        }
        resultChangedObjectIds = evidence.changedObjectIds;
        resultImpact = evidence.impact;
      }
      workOrder.status = "completed";
      workOrder.resultRevision = input.baseRevision;
      workOrder.completedRevision = input.baseRevision + 1;
      workOrder.completionSummary = completionSummary;
      workOrder.completionKind = input.completionKind;
      workOrder.resultChangedObjectIds = resultChangedObjectIds;
      workOrder.resultImpact = resultImpact;
      workOrder.relatedObjectIssues = relatedObjectIssues;
      workOrder.updatedAt = now();
      impact.changed.push(workOrder.id);
      impact.recomputed.push("Agent 工作单已回写实际 Revision 与完成摘要");
      if (workOrder.completionKind === "reviewed_no_change") {
        impact.warnings.push("该工作单以 reviewed_no_change 完成：仅固化审查结论，不声称产生了编辑改动。");
      }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return { state, workOrder };
  }

  /** Story 与 Scene、Timeline 一样由 Revision 事务管理，避免 Web 另存一份叙事说明。 */
  updateStory(input: {
    projectId: Id;
    baseRevision: number;
    title?: string;
    summary?: string;
    beats?: Array<Pick<StoryBeat, "title" | "purpose"> & Partial<Pick<StoryBeat, "id" | "semanticUnitIds" | "sceneIds">>>;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "更新 Story", (snapshot, impact) => {
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw new DomainError("Story 标题不能为空", "INVALID_STORY_TITLE");
        snapshot.story.title = title;
      }
      if (input.summary !== undefined) snapshot.story.summary = input.summary.trim();
      if (input.beats !== undefined) {
        const semanticIds = new Set(snapshot.semanticUnits.map((unit) => unit.id));
        const sceneIds = new Set(snapshot.scenes.map((scene) => scene.id));
        const existingById = new Map(snapshot.story.beats.map((beat) => [beat.id, beat]));
        const existingByFingerprint = new Map(snapshot.story.beats.map((beat) => [`${beat.title}::${beat.purpose}`, beat]));
        const usedIds = new Set<Id>();
        const nextBeats = input.beats.map((beat, order) => {
          const title = beat.title.trim();
          const purpose = beat.purpose.trim();
          if (!title || !purpose) throw new DomainError("Story Beat 必须包含标题和叙事目的", "INVALID_STORY_BEAT");
          const beatSemanticIds = beat.semanticUnitIds ?? [];
          const beatSceneIds = beat.sceneIds ?? [];
          for (const id of beatSemanticIds) if (!semanticIds.has(id)) throw new DomainError(`Story Beat 引用了未知语义单元：${id}`, "STORY_SEMANTIC_NOT_FOUND");
          for (const id of beatSceneIds) if (!sceneIds.has(id)) throw new DomainError(`Story Beat 引用了未知场景：${id}`, "STORY_SCENE_NOT_FOUND");
          const requested = beat.id ? existingById.get(beat.id) : undefined;
          if (beat.id && !requested) throw new DomainError(`Story Beat 不存在：${beat.id}`, "STORY_BEAT_NOT_FOUND");
          const fallback = existingByFingerprint.get(`${title}::${purpose}`) ?? snapshot.story.beats[order];
          const id = requested?.id ?? (fallback && !usedIds.has(fallback.id) ? fallback.id : createId("story_beat"));
          if (usedIds.has(id)) throw new DomainError("Story Beat 不能在同一次更新中重复", "DUPLICATE_STORY_BEAT");
          usedIds.add(id);
          return { id, order, title, purpose, semanticUnitIds: [...beatSemanticIds], sceneIds: [...beatSceneIds] };
        });
        snapshot.story.beats = nextBeats;
        // Story 是 Scene 关系的唯一编辑入口之一，写入时同步反向边，避免图出现半边引用。
        for (const scene of snapshot.scenes) {
          scene.narrativeBeatIds = nextBeats.filter((beat) => beat.sceneIds.includes(scene.id)).map((beat) => beat.id);
        }
        const nextBeatIds = new Set(nextBeats.map((beat) => beat.id));
        const removedTreatmentIds = new Set<Id>();
        for (const treatment of snapshot.visualTreatments) {
          if (!treatment.narrativeBeatId || nextBeatIds.has(treatment.narrativeBeatId)) continue;
          if (treatment.sceneId) {
            treatment.narrativeBeatId = undefined;
            treatment.status = "stale";
            treatment.updatedAt = now();
            impact.changed.push(treatment.id);
            impact.stale.push(treatment.id);
          } else {
            removedTreatmentIds.add(treatment.id);
          }
        }
        if (removedTreatmentIds.size > 0) {
          snapshot.visualTreatments = snapshot.visualTreatments.filter((treatment) => !removedTreatmentIds.has(treatment.id));
          for (const cutaway of snapshot.cutaways.filter((candidate) => candidate.visualTreatmentId && removedTreatmentIds.has(candidate.visualTreatmentId))) {
            cutaway.visualTreatmentId = undefined;
            this.markCutawayStale(snapshot, cutaway, impact, "关联的 Story Beat 已被移除");
          }
          impact.stale.push(...removedTreatmentIds);
        }
        impact.changed.push(...nextBeats.map((beat) => beat.id), ...snapshot.scenes.map((scene) => scene.id));
        impact.recomputed.push("Story Beat 与 Scene 关联");
      }
      snapshot.story.updatedAt = now();
      impact.changed.push(snapshot.story.id);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 将可用本地音频显式登记为 VoiceReference，避免把 Asset ID 误称为远端声音档案。 */
  registerVoiceReference(input: { projectId: Id; baseRevision: number; assetId: Id; label?: string; usageNote?: string }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "登记 VoiceReference", (snapshot, impact) => {
      const asset = assetById(snapshot, input.assetId);
      if (asset.kind !== "audio" || asset.status !== "ready" || !asset.metadata?.hasAudio) {
        throw new DomainError("VoiceReference 必须是已就绪且含音频的本地 Asset", "INVALID_VOICE_REFERENCE");
      }
      const label = input.label?.trim() || asset.name;
      const durationMs = asset.metadata.durationMs;
      const suitableDuration = durationMs >= 3_000 && durationMs <= 15_000;
      const quality = suitableDuration && (asset.metadata.sampleRate ?? 0) >= 8_000 ? "passed" as const : "warning" as const;
      const usageNote = input.usageNote?.trim() || "仅用于当前项目的本地语音合成。";
      const recommendedRange = { startMs: 0, endMs: Math.min(durationMs, 15_000) };
      const existing = snapshot.voiceReferences.find((reference) => reference.assetId === asset.id);
      if (existing) {
        existing.label = label;
        existing.usageNote = usageNote;
        existing.recommendedRange = recommendedRange;
        existing.quality = quality;
        existing.usable = durationMs > 0;
        impact.changed.push(existing.id);
      } else {
        const reference: VoiceReference = createVoiceReference({
          assetId: asset.id,
          label,
          usageNote,
          recommendedRange,
          quality,
          usable: durationMs > 0
        });
        snapshot.voiceReferences.push(reference);
        impact.changed.push(reference.id);
      }
      if (!suitableDuration) impact.warnings.push("参考声音建议使用 3～15 秒、单人且低噪声的片段；当前仅标记为可用但需复核。");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  getProjectRoot(projectId: Id): string {
    return this.repository.getProjectRow(projectId).root_path;
  }

  /** incomplete 不是终态；补充决定或审片后可继续同一份 ProductionRun。 */
  private resumeIncompleteProductionRun(report: SkillExecutionReport, action: string): void {
    if (report.status === "completed" || report.status === "abandoned") {
      throw new DomainError(`ProductionRun 已结束，不能继续${action}`, "PRODUCTION_RUN_CLOSED");
    }
    if (report.status === "incomplete") {
      report.status = "active";
      report.completedAt = undefined;
      report.completionBlockers = [];
    }
  }

  /** 只接受位于项目目录内的预览或帧文件，避免报告引用任意本机路径。 */
  private resolveProjectEvidencePath(projectId: Id, candidatePath: string): string | undefined {
    if (!candidatePath.trim()) return undefined;
    const rootPath = resolve(this.getProjectRoot(projectId));
    const resolvedPath = resolve(rootPath, candidatePath);
    const relativePath = relative(rootPath, resolvedPath);
    if (!relativePath || /^\.\.(?:[\\/]|$)/u.test(relativePath) || isAbsolute(relativePath)) return undefined;
    return resolvedPath;
  }

  /**
   * 自动同步候选只能依赖当前 Job 写出的受管并排预览。这里同时核对文件哈希、共同会话
   * 与每个机位的反向源映射，避免客户端用任意 MP4 或脱离 sourceRange 的裁片伪造确认依据。
   */
  private assertMulticamSyncPreview(input: {
    projectId: Id;
    snapshot: ProjectSnapshot;
    angleSyncs: readonly MulticamAngleSync[];
    assetIds: readonly Id[];
    syncPreview: MulticamSyncPreview;
  }): MulticamSyncPreview {
    const preview = input.syncPreview as unknown as Record<string, unknown>;
    if (!preview || typeof preview !== "object" || Array.isArray(preview)
      || typeof preview.relativePath !== "string" || !preview.relativePath.trim() || isAbsolute(preview.relativePath)
      || typeof preview.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(preview.contentHash)
      || !Number.isFinite(preview.durationMs) || (preview.durationMs as number) <= 0
      || !Number.isFinite(preview.fps) || preview.fps !== input.snapshot.timeline.fps
      || !Number.isInteger(preview.sessionStartFrame) || !Number.isInteger(preview.sessionEndFrame)
      || (preview.sessionEndFrame as number) <= (preview.sessionStartFrame as number)
      || !preview.sourceWindows || typeof preview.sourceWindows !== "object" || Array.isArray(preview.sourceWindows)) {
      throw new DomainError("多机位 Worker 没有返回有效的受管连续预览合同", "MULTICAM_SYNC_PREVIEW_INVALID");
    }
    const previewPath = this.resolveProjectEvidencePath(input.projectId, preview.relativePath);
    if (!previewPath) throw new DomainError("多机位同步预览必须位于当前项目目录内", "MULTICAM_SYNC_PREVIEW_PATH_INVALID");
    try {
      const info = statSync(previewPath);
      // 同步预览固定为短窗口；异常巨大的文件更可能是路径或 Worker 输出错误，不能同步读入校验。
      if (!info.isFile() || info.size <= 0 || info.size > 256 * 1024 * 1024) {
        throw new DomainError("多机位同步预览文件不存在、为空或异常过大", "MULTICAM_SYNC_PREVIEW_MISSING");
      }
      const actualHash = createHash("sha256").update(readFileSync(previewPath)).digest("hex");
      if (actualHash !== preview.contentHash) {
        throw new DomainError("多机位同步预览文件已变化，不能据此确认同步", "MULTICAM_SYNC_PREVIEW_HASH_MISMATCH");
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("多机位同步预览文件不存在或不可读", "MULTICAM_SYNC_PREVIEW_MISSING");
    }

    const sourceWindows = preview.sourceWindows as Record<string, unknown>;
    const expected = new Set(input.assetIds);
    if (Object.keys(sourceWindows).length !== input.assetIds.length || Object.keys(sourceWindows).some((assetId) => !expected.has(assetId))) {
      throw new DomainError("多机位同步预览没有完整覆盖当前 Job 的全部机位", "MULTICAM_SYNC_PREVIEW_WINDOWS_INVALID");
    }
    const commonSessionRange = this.resolveMulticamCommonSessionRange(input.snapshot, { angleSyncs: input.angleSyncs });
    const sessionStartFrame = preview.sessionStartFrame as number;
    const sessionEndFrame = preview.sessionEndFrame as number;
    if (sessionStartFrame < commonSessionRange.startFrame || sessionEndFrame > commonSessionRange.endFrame) {
      throw new DomainError("多机位同步预览超出已验证的共同会话范围", "MULTICAM_SYNC_PREVIEW_RANGE_INVALID");
    }
    const normalizedWindows: Record<Id, MulticamSourceRange> = {};
    for (const assetId of input.assetIds) {
      const sync = input.angleSyncs.find((candidate) => candidate.assetId === assetId);
      const window = sourceWindows[assetId];
      if (!sync || !window || typeof window !== "object" || Array.isArray(window)) {
        throw new DomainError("多机位同步预览缺少机位窗口", "MULTICAM_SYNC_PREVIEW_WINDOWS_INVALID");
      }
      const candidate = window as Record<string, unknown>;
      const startFrame = candidate.startFrame;
      const endFrame = candidate.endFrame;
      const sourceRange = this.multicamSourceRangeFor(input.snapshot, sync);
      const expectedStart = sessionStartFrame - sync.sessionOffsetFrames;
      const expectedEnd = sessionEndFrame - sync.sessionOffsetFrames;
      if (Object.keys(candidate).some((key) => key !== "startFrame" && key !== "endFrame")
        || !Number.isInteger(startFrame) || !Number.isInteger(endFrame)
        || startFrame !== expectedStart || endFrame !== expectedEnd
        || (startFrame as number) < sourceRange.startFrame || (endFrame as number) > sourceRange.endFrame) {
        throw new DomainError("多机位同步预览的机位窗口没有遵守已验证偏移和源范围", "MULTICAM_SYNC_PREVIEW_WINDOWS_INVALID");
      }
      normalizedWindows[assetId] = { startFrame: startFrame as number, endFrame: endFrame as number };
    }
    return {
      relativePath: preview.relativePath,
      contentHash: preview.contentHash,
      durationMs: Math.round(preview.durationMs as number),
      fps: preview.fps as number,
      sessionStartFrame,
      sessionEndFrame,
      sourceWindows: normalizedWindows
    };
  }

  /** Preview 必须由 Render Worker 成功产出当前 Revision 的真实文件，不能只登记一个 Job。 */
  private async hasSucceededPreviewForRevision(projectId: Id, revision: number): Promise<boolean> {
    for (const job of this.repository.listJobs(projectId)) {
      if (job.kind !== "preview" || job.status !== "succeeded" || Number(job.result?.revision ?? job.payload.revision) !== revision) continue;
      const previewPath = typeof job.result?.path === "string" ? this.resolveProjectEvidencePath(projectId, job.result.path) : undefined;
      if (!previewPath || !existsSync(previewPath)) continue;
      try {
        const preview = await stat(previewPath);
        if (preview.isFile() && preview.size > 0) return true;
      } catch {
        // Worker 写入失败或文件被清理时，这个 Job 不能成为交付证据。
      }
    }
    return false;
  }

  /**
   * 合成帧必须同时满足：来自成功 Preview Job、由 inspect_composed_frames 登记、文件仍可读。
   * 这样手工放一个同名 jpg，或仅伪造 Job.result.path，都不能让 ProductionRun 收口。
   */
  private async findComposedFrameEvidence(projectId: Id, revision: number): Promise<Array<{ frame: number; relativePath: string }>> {
    const evidence = new Map<string, { frame: number; relativePath: string }>();
    for (const job of this.repository.listJobs(projectId)) {
      if (job.kind !== "preview" || job.status !== "succeeded" || Number(job.result?.revision ?? job.payload.revision) !== revision) continue;
      const inspection = job.result?.inspection as Partial<PreviewInspectionEvidence> | undefined;
      if (!inspection || inspection.revision !== revision || inspection.sourcePreviewJobId !== job.id || !Array.isArray(inspection.frames)) continue;
      // 默认的检查会抽取进入、稳定、退出三帧；少于三帧不能支撑完整的效果审片。
      if (inspection.frames.length < 3) continue;
      const validFrames: Array<{ frame: number; relativePath: string }> = [];
      for (const artifact of inspection.frames) {
        if (!artifact || !Number.isInteger(artifact.frame) || typeof artifact.relativePath !== "string") continue;
        const artifactPath = this.resolveProjectEvidencePath(projectId, artifact.relativePath);
        if (!artifactPath || !existsSync(artifactPath)) continue;
        try {
          const artifactStat = await stat(artifactPath);
          if (artifactStat.isFile() && artifactStat.size > 0) validFrames.push({ frame: artifact.frame, relativePath: artifact.relativePath });
        } catch {
          // 文件被清理或损坏时，不再作为当前收口依据。
        }
      }
      if (validFrames.length === inspection.frames.length) {
        validFrames.forEach((artifact) => evidence.set(`${artifact.frame}:${artifact.relativePath}`, artifact));
      }
    }
    return [...evidence.values()].sort((left, right) => left.frame - right.frame || left.relativePath.localeCompare(right.relativePath));
  }

  /** ProductionRun 只落为项目内 JSON 审计，不进入 Revision Snapshot，避免制造第二份剪辑状态。 */
  private reportPath(projectId: Id, reportId: Id): string {
    if (!/^production_run_[a-zA-Z0-9-]+$/u.test(reportId)) {
      throw new DomainError("ProductionRun 标识不合法", "INVALID_PRODUCTION_RUN_ID");
    }
    return join(this.getProjectRoot(projectId), "reports", `production-run-${reportId}.json`);
  }

  private async writeSkillExecutionReport(report: SkillExecutionReport): Promise<void> {
    const path = this.reportPath(report.projectId, report.id);
    await mkdir(join(this.getProjectRoot(report.projectId), "reports"), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  async readSkillExecutionReport(input: { projectId: Id; runId: Id }): Promise<SkillExecutionReport> {
    try {
      const raw = await readFile(this.reportPath(input.projectId, input.runId), "utf8");
      const report = JSON.parse(raw) as SkillExecutionReport;
      if (report.projectId !== input.projectId || report.id !== input.runId) {
        throw new DomainError("ProductionRun 报告与当前项目不匹配", "PRODUCTION_RUN_MISMATCH");
      }
      // 旧报告没有收口证据字段时按空值处理，不能把历史记录误判为已通过新门禁。
      report.composedFrameEvidence ??= [];
      report.completionBlockers ??= [];
      return report;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("未找到 ProductionRun 报告", "PRODUCTION_RUN_NOT_FOUND");
    }
  }

  /**
   * QualityReport 汇总各 Run 的审片与未关闭问题；审片报告仍然留在项目目录，
   * 不把人工判断复制进 Revision Snapshot。
   */
  async readLatestEditorialQualityReview(input: { projectId: Id; revision?: number }): Promise<EditorialQualityReview | undefined> {
    const reportsDirectory = join(this.getProjectRoot(input.projectId), "reports");
    let entries: Array<{ name: string; isFile: () => boolean }>;
    try {
      entries = await readdir(reportsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new DomainError("无法读取项目审片报告", "EDITORIAL_REVIEW_READ_FAILED");
    }
    const reports = await Promise.all(entries
      .filter((entry) => entry.isFile() && /^production-run-production_run_[a-zA-Z0-9-]+\.json$/u.test(entry.name))
      .map(async (entry) => {
        try {
          return JSON.parse(await readFile(join(reportsDirectory, entry.name), "utf8")) as SkillExecutionReport;
        } catch {
          // 不能因审计损坏把历史严重问题静默当作不存在。
          throw new DomainError(`审片报告无法读取：${entry.name}；保留文件并修复审计后再收口`, "EDITORIAL_REVIEW_READ_FAILED");
        }
      }));
    const revision = input.revision ?? this.readProject(input.projectId).revision.number;
    const review = mergeEditorialReviews(reports.filter((report): report is SkillExecutionReport => Boolean(report && report.projectId === input.projectId))
      .flatMap((report) => [...(report.editorialReviewHistory ?? []), ...(report.editorialReview ? [report.editorialReview] : [])]), revision);
    if (!review) return undefined;
    // 文件被清理或替换后，不再让旧哈希支撑当前覆盖或问题关闭。
    const hashes = new Map<string, string | undefined>();
    for (const evidence of review.evidenceRecords ?? []) {
      if (hashes.has(evidence.relativePath)) continue;
      try { hashes.set(evidence.relativePath, await evidenceHash(this.getProjectRoot(input.projectId), evidence.relativePath)); }
      catch { hashes.set(evidence.relativePath, undefined); }
    }
    review.evidenceRecords = (review.evidenceRecords ?? []).filter((entry) => hashes.get(entry.relativePath) === entry.contentHash);
    const validIds = new Set(review.evidenceRecords.map((entry) => entry.id));
    review.resolutions = (review.resolutions ?? []).filter((entry) => entry.evidenceIds.length > 0 && entry.evidenceIds.every((id) => validIds.has(id)));
    return review;
  }

  /** 导出和当前 QualityReport 都必须读取目标 Revision 的审片，不能被另一版本的最新报告覆盖。 */
  async readEditorialQualityReview(input: { projectId: Id; revision: number }): Promise<EditorialQualityReview | undefined> {
    return this.readLatestEditorialQualityReview(input);
  }

  async startProductionRun(input: { projectId: Id; baseRevision?: number; loadedSkills: string[]; loadedReferences?: string[] }): Promise<SkillExecutionReport> {
    const current = this.readProject(input.projectId);
    const baseRevision = input.baseRevision ?? current.revision.number;
    this.repository.getRevision(input.projectId, baseRevision);
    const report: SkillExecutionReport = {
      id: createId("production_run"),
      projectId: input.projectId,
      status: "active",
      baseRevision,
      loadedSkills: [...new Set(input.loadedSkills.map((skill) => skill.trim()).filter(Boolean))],
      loadedReferences: [...new Set((input.loadedReferences ?? []).map((reference) => reference.trim()).filter(Boolean))],
      creativeDecisions: [],
      quietRanges: [],
      effectDecisions: [],
      rejectedAlternatives: [],
      mcpCommands: [{ name: "start_production_run", revision: current.revision.number, createdAt: now() }],
      previewEvidence: [],
      composedFrameEvidence: [],
      qualityReview: [],
      completionBlockers: [],
      createdAt: now()
    };
    await this.writeSkillExecutionReport(report);
    return report;
  }

  async recordCreativeDecision(input: {
    projectId: Id;
    runId: Id;
    category: "story" | "semantic" | "scene" | "visual" | "audio" | "quality";
    decision: string;
    rationale: string;
    objectIds?: Id[];
    evidence?: string[];
    alternatives?: string[];
    delegation?: CreativeDelegation;
    quietRange?: { startFrame: number; endFrame: number; reason: string };
    effectDecision?: string;
    rejectedAlternative?: string;
    mcpCommand?: string;
    previewEvidence?: string;
    qualityReview?: string;
  }): Promise<SkillExecutionReport> {
    return this.withProductionAuditLock(input.projectId, () => this.recordCreativeDecisionUnlocked(input));
  }

  private validateCreativeDelegation(projectId: Id, value: CreativeDelegation | undefined): CreativeDelegation | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DomainError("子代理来源必须包含代理、分派、职责和输入版本", "INVALID_CREATIVE_DELEGATION");
    }
    const agentId = typeof value.agentId === "string" ? value.agentId.trim() : "";
    const assignmentId = typeof value.assignmentId === "string" ? value.assignmentId.trim() : "";
    if (!agentId || agentId.length > 160 || !assignmentId || assignmentId.length > 160
      || !["director", "specialist", "reviewer"].includes(value.role)
      || !Number.isSafeInteger(value.inputRevision) || value.inputRevision < 1) {
      throw new DomainError("子代理来源的标识、职责或输入版本无效", "INVALID_CREATIVE_DELEGATION");
    }
    // 核对本项目的真实历史，不把自报来源升级成权限证明，也不自动重定基旧方案。
    this.repository.getRevision(projectId, value.inputRevision);
    return { agentId, assignmentId, role: value.role, inputRevision: value.inputRevision };
  }

  private async recordCreativeDecisionUnlocked(input: Parameters<EditingApplication["recordCreativeDecision"]>[0]): Promise<SkillExecutionReport> {
    const report = await this.readSkillExecutionReport({ projectId: input.projectId, runId: input.runId });
    this.resumeIncompleteProductionRun(report, "创作判断");
    const decision = input.decision.trim();
    const rationale = input.rationale.trim();
    if (!decision || !rationale) throw new DomainError("创作判断必须说明决定与原因", "INVALID_CREATIVE_DECISION");
    const delegation = this.validateCreativeDelegation(input.projectId, input.delegation);
    report.creativeDecisions.push({
      id: createId("creative_decision"),
      category: input.category,
      decision,
      rationale,
      objectIds: input.objectIds ?? [],
      evidence: input.evidence ?? [],
      alternatives: input.alternatives?.filter(Boolean),
      ...(delegation ? { delegation } : {}),
      createdAt: now()
    });
    if (input.quietRange) {
      if (input.quietRange.startFrame < 0 || input.quietRange.endFrame <= input.quietRange.startFrame || !input.quietRange.reason.trim()) {
        throw new DomainError("安静区范围或原因无效", "INVALID_QUIET_RANGE");
      }
      report.quietRanges.push({ ...input.quietRange, reason: input.quietRange.reason.trim() });
    }
    if (input.effectDecision?.trim()) report.effectDecisions.push(input.effectDecision.trim());
    if (input.rejectedAlternative?.trim()) report.rejectedAlternatives.push(input.rejectedAlternative.trim());
    if (input.mcpCommand?.trim()) report.mcpCommands.push({ name: input.mcpCommand.trim(), revision: this.readProject(input.projectId).revision.number, createdAt: now() });
    if (input.previewEvidence?.trim()) report.previewEvidence.push(input.previewEvidence.trim());
    if (input.qualityReview?.trim()) report.qualityReview.push(input.qualityReview.trim());
    await this.writeSkillExecutionReport(report);
    return report;
  }

  /** 分阶段累积真实审片；记录与复核不会创建视频 Revision。 */
  async recordEditorialQualityReview(input: {
    projectId: Id;
    runId: Id;
    revision: number;
    passes: EditorialReviewPass[];
    previewEvidence: string[];
    observations?: EditorialReviewObservation[];
    resolutions?: Array<{ findingId: Id; evidenceIds: Id[]; note: string; scope?: "caption_text" }>;
    findings: Array<{
      pass: EditorialReviewPass;
      severity: EditorialReviewSeverity;
      category: EditorialReviewCategory;
      summary: string;
      evidence: string;
      impact: string;
      suggestedFix?: string;
      verificationMethod?: string;
      objectId?: Id;
      frameRange?: { startFrame: number; endFrame: number };
    }>;
  }): Promise<SkillExecutionReport> {
    return this.withProductionAuditLock(input.projectId, () => this.recordEditorialQualityReviewUnlocked(input));
  }

  private async recordEditorialQualityReviewUnlocked(input: Parameters<EditingApplication["recordEditorialQualityReview"]>[0]): Promise<SkillExecutionReport> {
    const report = await this.readSkillExecutionReport({ projectId: input.projectId, runId: input.runId });
    this.resumeIncompleteProductionRun(report, "审片");
    const target = this.repository.getRevision(input.projectId, input.revision);
    const passes = [...new Set(input.passes)];
    if (!passes.length || passes.some((pass) => !EDITORIAL_PASSES.includes(pass))) {
      throw new DomainError("审片至少记录一个真实执行的轮次", "EDITORIAL_REVIEW_INCOMPLETE");
    }
    if ((input.observations ?? []).some((entry) => !passes.includes(entry.pass))) throw new DomainError("证据引用了未执行的轮次", "EDITORIAL_REVIEW_PASS_MISSING");
    const evidenceRecords = await validateEditorialObservations(target.snapshot, input.revision, this.repository.listJobs(input.projectId), input.observations ?? []);
    const previewEvidence = [...new Set(input.previewEvidence.map((evidence) => evidence.trim()).filter(Boolean))];
    if (previewEvidence.length === 0 && evidenceRecords.length === 0 && !input.resolutions?.length) throw new DomainError("审片必须附至少一条真实预览证据", "PREVIEW_EVIDENCE_REQUIRED");
    const findings = input.findings.map((finding) => {
      if (!passes.includes(finding.pass)) throw new DomainError("审片问题引用了未执行的审片轮次", "EDITORIAL_REVIEW_PASS_MISSING");
      const summary = finding.summary.trim();
      const evidence = finding.evidence.trim();
      const impact = finding.impact.trim();
      if (!summary || !evidence || !impact) throw new DomainError("审片问题必须说明现象、证据和影响", "INVALID_EDITORIAL_FINDING");
      if (finding.frameRange && (!Number.isInteger(finding.frameRange.startFrame) || !Number.isInteger(finding.frameRange.endFrame) || finding.frameRange.startFrame < 0 || finding.frameRange.endFrame <= finding.frameRange.startFrame || finding.frameRange.endFrame > target.snapshot.timeline.durationInFrames)) {
        throw new DomainError("审片问题的帧范围无效", "INVALID_EDITORIAL_FRAME_RANGE");
      }
      return {
        id: createId("editorial_finding"),
        revision: input.revision,
        recordedAt: now(),
        pass: finding.pass,
        severity: finding.severity,
        category: finding.category,
        summary,
        evidence,
        impact,
        suggestedFix: finding.suggestedFix?.trim() || undefined,
        verificationMethod: finding.verificationMethod?.trim() || undefined,
        objectId: finding.objectId,
        frameRange: finding.frameRange
      };
    });
    const previous = await this.readEditorialQualityReview({ projectId: input.projectId, revision: input.revision });
    const availableEvidence = [...(previous?.evidenceRecords ?? []), ...evidenceRecords];
    const resolutions: EditorialFindingResolution[] = (input.resolutions ?? []).map((resolution) => {
      const finding = openEditorialFindings(previous).find((entry) => entry.id === resolution.findingId);
      if (!finding || !resolution.note.trim()) throw new DomainError("复核必须引用仍待修的问题并说明结果", "EDITORIAL_RESOLUTION_INVALID");
      // 跨版本优先跟随可定位对象；无法证明问题的新位置时要求整片，不接受任意缩小复核窗口。
      const located = [...target.snapshot.effectCues, ...target.snapshot.cutaways, ...target.snapshot.scenes, ...target.snapshot.timeline.items, ...target.snapshot.timeline.captions].find((entry) => entry.id === finding.objectId);
      const range = (finding.revision === input.revision ? finding.frameRange : located) ?? { startFrame: 0, endFrame: target.snapshot.timeline.durationInFrames };
      const evidence = resolution.evidenceIds.map((id) => availableEvidence.find((entry) => entry.id === id));
      if (resolution.scope === "caption_text") {
        const caption = target.snapshot.timeline.captions.find((entry) => entry.id === finding.objectId);
        // 只允许有实际字幕对象的文字问题；单帧不因此取得声音或整轮连续覆盖资格。
        if (!caption || finding.pass !== "mute_visual" || !["semantic", "typography"].includes(finding.category)
          || !evidence.length || evidence.some((entry) => !entry || entry.revision !== input.revision || entry.pass !== "mute_visual" || entry.method !== "frames"
            || entry.endFrame !== entry.startFrame + 1 || entry.startFrame < caption.startFrame || entry.endFrame > caption.endFrame
            || (finding.recordedAt && entry.recordedAt < finding.recordedAt))) throw new DomainError("文字复核仅接受当前字幕卡内、发现问题后登记的单帧静音证据；不能关闭声音或运动问题", "EDITORIAL_RESOLUTION_EVIDENCE_REQUIRED");
        return { findingId: finding.id, revision: input.revision, evidenceIds: [...new Set(resolution.evidenceIds)], note: resolution.note.trim(), resolvedAt: now(), scope: "caption_text", frameRange: { startFrame: caption.startFrame, endFrame: caption.endFrame } };
      }
      if (!evidence.length || evidence.some((entry) => !entry || entry.revision !== input.revision || entry.pass !== finding.pass || !evidenceSupportsPass(entry) || (finding.recordedAt && entry.recordedAt < finding.recordedAt)) || missingReviewRanges(evidence.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)), range.startFrame, range.endFrame).length) throw new DomainError("问题关闭需要发现问题之后登记的当前 Revision、对应轮次与完整复核范围的连续证据", "EDITORIAL_RESOLUTION_EVIDENCE_REQUIRED");
      return { findingId: finding.id, revision: input.revision, evidenceIds: [...new Set(resolution.evidenceIds)], note: resolution.note.trim(), resolvedAt: now(), frameRange: { startFrame: range.startFrame, endFrame: range.endFrame } };
    });
    if (report.editorialReview && report.editorialReview.revision !== input.revision) {
      (report.editorialReviewHistory ??= []).push(report.editorialReview);
      report.editorialReview = undefined;
    }
    const ownPrevious = report.editorialReview;
    report.editorialReview = {
      revision: input.revision,
      passes: [...new Set([...(ownPrevious?.passes ?? []), ...passes])],
      previewEvidence: [...new Set([...(ownPrevious?.previewEvidence ?? []), ...previewEvidence, ...evidenceRecords.map((entry) => entry.relativePath)])],
      findings: [...(ownPrevious?.findings ?? []), ...findings],
      evidenceRecords: [...(ownPrevious?.evidenceRecords ?? []), ...evidenceRecords],
      resolutions: [...(ownPrevious?.resolutions ?? []), ...resolutions],
      reviewedAt: now()
    };
    report.previewEvidence = [...new Set([...report.previewEvidence, ...previewEvidence])];
    report.qualityReview.push(`R${input.revision} 追加 ${passes.join("、")} 审片记录；全片覆盖以结构化证据为准。`);
    report.mcpCommands.push({ name: "record_editorial_quality_review", revision: input.revision, createdAt: now() });
    await this.writeSkillExecutionReport(report);
    return report;
  }

  /**
   * Presenter 正式生产只能在真实结构、预览、合成帧和完整审片都已归属同一 Revision 时收口。
   * 未满足时保留 incomplete 状态，调用方可以继续补证据而不会丢失本次导演判断。
   */
  async completeProductionRun(input: { projectId: Id; runId: Id; finalRevision?: number; qualityReview?: string[]; previewEvidence?: string[] }): Promise<SkillExecutionReport> {
    return this.withProductionAuditLock(input.projectId, () => this.completeProductionRunUnlocked(input));
  }

  private async completeProductionRunUnlocked(input: Parameters<EditingApplication["completeProductionRun"]>[0]): Promise<SkillExecutionReport> {
    const report = await this.readSkillExecutionReport({ projectId: input.projectId, runId: input.runId });
    this.resumeIncompleteProductionRun(report, "收口");
    const current = this.readProject(input.projectId);
    const finalRevision = input.finalRevision ?? current.revision.number;
    const target = this.repository.getRevision(input.projectId, finalRevision);
    if (input.previewEvidence) report.previewEvidence.push(...input.previewEvidence.map((value) => value.trim()).filter(Boolean));
    if (input.qualityReview) report.qualityReview.push(...input.qualityReview.map((value) => value.trim()).filter(Boolean));

    const blockers: string[] = [];
    if (finalRevision !== current.revision.number) blockers.push(`正式 ProductionRun 必须收口当前 Revision（当前 R${current.revision.number}，请求 R${finalRevision}）。`);
    const decisionCategories = new Set(report.creativeDecisions.map((decision) => decision.category));
    for (const category of ["semantic", "story", "visual"] as const) {
      if (!decisionCategories.has(category)) blockers.push(`缺少 ${category === "semantic" ? "语义" : category === "story" ? "故事" : "视觉处理"}决策记录。`);
    }
    if (!(await this.hasSucceededPreviewForRevision(input.projectId, finalRevision))) blockers.push(`R${finalRevision} 没有成功且文件仍可读的局部 Preview Job。`);
    const composedFrameEvidence = await this.findComposedFrameEvidence(input.projectId, finalRevision);
    const composedFramePaths = composedFrameEvidence.map((artifact) => artifact.relativePath);
    report.composedFrameEvidence = composedFramePaths;
    // 制作完成只表明当前版本可产出；抽帧、辅助审阅与人工定稿另行保留事实。
    const projectReview = await this.readEditorialQualityReview({ projectId: input.projectId, revision: finalRevision });
    const quality = await evaluateQualityWithBrowser(target.snapshot, finalRevision, projectReview);
    blockers.push(...exportBlockingIssues(quality, "draft").map(entry => `技术/用途条件：${entry.message}`));
    report.finalRevision = finalRevision;
    report.mcpCommands.push({ name: "complete_production_run", revision: finalRevision, createdAt: now() });
    report.completionBlockers = [...new Set(blockers)];
    if (report.completionBlockers.length > 0) {
      report.status = "incomplete";
      report.completedAt = undefined;
      await this.writeSkillExecutionReport(report);
      return report;
    }
    report.status = "completed";
    report.completedAt = now();
    report.completionBlockers = [];
    await this.writeSkillExecutionReport(report);
    return report;
  }

  /** 提交只创建固定输入的 Job；不改变 Timeline，也不把代码装进平台 Registry。 */
  submitManagedMotion(input: { projectId: Id; baseRevision: number; idempotencyKey: string; work: MotionSubmission }): JobRecord {
    const work = motionSubmissionSchema.parse(input.work);
    try { validateMotionSource(work.source); } catch (error) {
      // 这里只包住纯源码校验；数据库、素材、字体和 Worker 异常不能取得重试许可。
      if (error instanceof MotionSourceValidationError) throw new MotionSubmissionValidationError(error);
      throw error;
    }
    const existing = this.repository.listJobs(input.projectId).find((job) => job.idempotencyKey === `motion:${input.idempotencyKey}`);
    if (existing) {
      if (existing.kind !== "motion_generation" || motionHash(motionSubmissionSchema.parse(existing.payload.work)) !== motionHash(work)) throw new DomainError("幂等键已用于不同作品输入", "MOTION_IDEMPOTENCY_CONFLICT");
      return existing;
    }
    if (!work.creativeBrief) throw new DomainError("新作品必须提供创作说明 creativeBrief；参考可选，不填写占位参考", "MOTION_CREATIVE_BRIEF_REQUIRED");
    const current = this.readProject(input.projectId);
    if (current.revision.number !== input.baseRevision) throw new DomainError("项目 Revision 已变化，请重新读取", "REVISION_CONFLICT");
    if (work.previousAssetId && !current.snapshot.assets.some((asset) => asset.id === work.previousAssetId && asset.motion)) throw new DomainError("上一版本不是当前项目的受管作品", "MOTION_PREVIOUS_VERSION_MISSING");
    const boundImages = Object.entries(work.imageBindings).map(([slot, assetId]) => {
      const asset = assetById(current.snapshot, assetId);
      if (asset.kind !== "image" || asset.status !== "ready" || !asset.sourceHash) throw new DomainError("作品只绑定已就绪且有内容哈希的项目图片", "MOTION_IMAGE_NOT_READY");
      return { slot, assetId, managedPath: asset.managedPath, hash: asset.sourceHash };
    });
    const boundVideos = boundMotionVideoSchema.array().parse(Object.entries(work.videoBindings ?? {}).map(([slot, binding]) => {
      const asset = assetById(current.snapshot, binding.assetId);
      if (asset.kind !== "video" || asset.status !== "ready" || !asset.sourceHash || !asset.metadata?.durationMs || asset.motion) throw new DomainError("绑定已就绪且有真实时长和哈希的源视频；受管动效请直接放置", "MOTION_VIDEO_NOT_READY");
      if (binding.sourceEndMs > asset.metadata.durationMs) throw new DomainError("视频源范围超出素材时长", "MOTION_VIDEO_SOURCE_RANGE");
      return { slot, ...binding, managedPath: asset.managedPath, hash: asset.sourceHash };
    }));
    const boundFonts = bindMotionFonts(work);
    const version = motionHash(work, boundImages, MOTION_ENGINE_VERSION, boundVideos, boundFonts);
    const job = this.repository.createJob({ projectId: input.projectId, kind: "motion_generation", payload: { work, version, engineVersion: MOTION_ENGINE_VERSION, requestedRevision: input.baseRevision, boundImages, ...(boundVideos.length ? { boundVideos } : {}), ...(boundFonts.length ? { boundFonts } : {}) }, idempotencyKey: `motion:${input.idempotencyKey}` });
    this.publish({ projectId: input.projectId, revision: current.revision.number, type: "job" });
    return job;
  }

  readManagedMotion(projectId: Id, jobId: Id) {
    const job = this.repository.getJob(jobId);
    if (job.projectId !== projectId || job.kind !== "motion_generation") throw new DomainError("作品任务不属于当前项目", "MOTION_JOB_NOT_FOUND");
    const asset = this.readProject(projectId).snapshot.assets.find((item) => item.motion?.jobId === jobId);
    return { job, asset, nextStep: asset ? "连续查看作品并以 outcome、note、evidence 审阅；未审或未看清仍可放置、预览、修改和导出，审阅状态如实保留。写入前重读 Revision，最终效果由用户确认。" : "等待 track_job；失败时读取诊断，不猜测已生成" };
  }

  /** Worker 可重复完成，但同一任务只登记一个固定版本的作品 Asset。 */
  completeManagedMotion(input: { projectId: Id; jobId: Id; engineVersion: string; sourceHash: string; metadata: NonNullable<Asset["metadata"]>; eventMap?: NonNullable<Asset["motion"]>["eventMap"] }): Asset {
    const job = this.repository.getJob(input.jobId);
    if (job.projectId !== input.projectId || job.kind !== "motion_generation") throw new DomainError("作品任务不属于当前项目", "MOTION_JOB_NOT_FOUND");
    if (job.status === "cancelled") throw new DomainError("作品任务已取消，不能登记素材", "MOTION_CANCELLED");
    const current = this.readProject(input.projectId);
    const existing = current.snapshot.assets.find((asset) => asset.motion?.jobId === job.id);
    if (existing) return existing;
    const work = motionSubmissionSchema.parse(job.payload.work);
    const boundImages = boundMotionImageSchema.array().parse(job.payload.boundImages ?? []);
    const boundVideos = boundMotionVideoSchema.array().parse(job.payload.boundVideos ?? []);
    const boundFonts = boundMotionFontSchema.array().parse(job.payload.boundFonts ?? []);
    const version = motionHash(work, boundImages, motionHashEngine(work, boundImages, job.payload.version, job.payload.engineVersion, boundVideos, boundFonts), boundVideos, boundFonts);
    if (version !== job.payload.version) throw new DomainError("作品固定输入已损坏", "MOTION_VERSION_MISMATCH");
    const directory = `assets/derived/motion/${job.id}/${version}`;
    const images = [...boundImages, ...boundVideos];
    let asset!: Asset;
    const state = this.repository.commit(input.projectId, current.revision.number, "登记受管 Remotion 作品（待审阅）", (snapshot, impact) => {
      if (this.repository.getJob(job.id).status === "cancelled") throw new DomainError("作品任务已取消，不能登记素材", "MOTION_CANCELLED");
      asset = {
        id: createId("asset"), name: work.name, kind: "video", status: "ready", managedPath: `${directory}/preview.mp4`, sourceHash: input.sourceHash,
        role: "generated_visual", tags: ["managed_motion", "work_review_required"], createdAt: now(), metadata: input.metadata,
        provenance: { source: "generated", provider: "managed_remotion", generationJobId: job.id, acquiredAt: now() },
        motion: { jobId: job.id, version, engineVersion: input.engineVersion, previousAssetId: work.previousAssetId, sourceAssetIds: [...new Set(images.map(image => image.assetId))], ...(boundImages.length ? { imageSources: boundImages.map(image => ({ slot: image.slot, assetId: image.assetId, sourceHash: image.hash })) } : {}), ...(boundVideos.length ? { videoSources: boundVideos.map(v => ({ slot: v.slot, assetId: v.assetId, sourceHash: v.hash, sourceStartMs: v.sourceStartMs, sourceEndMs: v.sourceEndMs, startFrame: v.startFrame, endFrame: v.endFrame })) } : {}), ...(boundFonts.length ? { fontSources: boundFonts.map(f => ({ slot: f.slot, fontId: f.fontId, sourceHash: f.hash, weight: f.weight, style: f.style })) } : {}), sourcePath: `${directory}/source.json`, framesDirectory: `${directory}/frames`, frameCount: work.durationInFrames, fps: work.fps, width: work.width, height: work.height, referenceUrl: work.reference?.url, creativeBrief: work.creativeBrief, eventMap: input.eventMap }
      };
      snapshot.assets.push(asset);
      impact.changed.push(asset.id);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return asset;
  }

  async reviewManagedMotion(input: { projectId: Id; baseRevision: number; assetId: Id; outcome?: MotionReviewOutcome; referenceMatch?: MotionReviewOutcome; note: string; evidence?: MotionReviewEvidenceInput }): Promise<ProjectState> {
    const outcome = input.outcome ?? input.referenceMatch;
    if (!outcome || !["passed", "failed", "inconclusive"].includes(outcome)) throw new DomainError("动效审阅结论无效", "MOTION_REVIEW_INVALID");
    if (input.note.trim().length < 16 || input.note.length > 2400) throw new DomainError("请说明设计兑现和实际效果，或待审原因与复核范围", "MOTION_REVIEW_EVIDENCE_REQUIRED");
    if (input.outcome && input.referenceMatch) throw new DomainError("不能同时提交新结果与旧参考别名", "MOTION_REVIEW_INPUT_CONFLICT");
    const current = this.readProject(input.projectId);
    if (current.revision.number !== input.baseRevision) throw new DomainError("项目 Revision 已变化，请重新读取", "REVISION_CONFLICT");
    const target = assetById(current.snapshot, input.assetId);
    if (!target.motion) throw new DomainError("不是受管作品", "MOTION_ASSET_REQUIRED");
    const legacy = input.outcome === undefined;
    if (legacy && (target.motion.creativeBrief || !target.motion.referenceUrl || input.evidence)) throw new DomainError("旧参考别名只兼容历史参考作品；新作品使用 outcome 和实际 evidence", "MOTION_LEGACY_REVIEW_REJECTED");
    const evidence = legacy ? undefined : await validateMotionReviewEvidence(current.snapshot, input.baseRevision, this.repository.listJobs(input.projectId), target, outcome, input.evidence);
    // 媒体验证有异步等待；提交再次检查 Revision，不能用旧证据覆盖并发修改。
    const state = this.repository.commit(input.projectId, input.baseRevision, "记录受管作品动态审阅", (snapshot, impact) => {
      const asset = assetById(snapshot, input.assetId);
      if (!asset.motion) throw new DomainError("不是受管作品", "MOTION_ASSET_REQUIRED");
      asset.motion.review = legacy ? { referenceMatch: outcome, note: input.note.trim(), reviewedAt: now() }
        : { outcome, version: asset.motion.version, evidence, note: input.note.trim(), reviewedAt: now() };
      impact.changed.push(asset.id);
      for (const cue of snapshot.effectCues.filter((item) => item.assetBindings.some((binding) => binding.assetId === asset.id))) {
        impact.dirtyRanges.push({ startFrame: cue.startFrame, endFrame: cue.endFrame, reason: "作品审阅结论变化" });
      }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  private assertManagedMotionCue(snapshot: ProjectSnapshot, cue: EffectCue): void {
    if (cue.type !== "ManagedMotion") return;
    const asset = snapshot.assets.find((item) => item.id === cue.assetBindings.find((binding) => binding.slot === "motion")?.assetId);
    const content = inspectEffectContentContract(cue, snapshot.assets, snapshot.timeline);
    if (!content.ready || !asset?.motion) throw new DomainError(content.missing.join("；"), "MOTION_NOT_READY");
    if (asset.motion.width !== snapshot.timeline.width || asset.motion.height !== snapshot.timeline.height) throw new DomainError("作品画幅不匹配，请按目标画布重新生成", "MOTION_CANVAS_MISMATCH");
    if (Object.keys(cue.props).length) throw new DomainError("修改作品 Props 必须提交新作品版本，不能在 Cue 上设置无效参数", "MOTION_PROPS_REQUIRE_NEW_VERSION");
  }

  registerImportedAsset(input: {
    projectId: Id;
    baseRevision: number;
    name: string;
    kind: Asset["kind"];
    managedPath: string;
    originalPath?: string;
    sourceHash?: string;
    role?: Asset["role"];
    provenance?: Asset["provenance"];
    tags?: string[];
  }): { state: ProjectState; asset: Asset; job: JobRecord } {
    let asset!: Asset;
    const state = this.repository.commit(input.projectId, input.baseRevision, `导入素材：${input.name}`, (snapshot, impact) => {
      if (input.provenance) assertAssetProvenanceValid(input.provenance);
      asset = createMediaAsset(input);
      snapshot.assets.push(asset);
      impact.changed.push(asset.id);
      impact.recomputed.push("素材分析");
    });
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "media_analysis",
      payload: { assetId: asset.id },
      idempotencyKey: `media_analysis:${asset.id}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return { state, asset, job };
  }

  /**
   * 角色、标签和来源由导入后的编辑判断补充。素材仍需经过媒体分析才可进入正式 Timeline，
   * 但不能因此丢失它来自哪里、可否使用的事实。
   */
  updateAssetEditorialMetadata(input: {
    projectId: Id;
    baseRevision: number;
    assetId: Id;
    role?: Asset["role"];
    tags?: string[];
    provenance?: Asset["provenance"];
  }): ProjectState {
    if (input.role === undefined && input.tags === undefined && input.provenance === undefined) {
      throw new DomainError("至少提供一种素材角色、标签或来源信息", "EMPTY_ASSET_METADATA_UPDATE");
    }
    const state = this.repository.commit(input.projectId, input.baseRevision, "更新素材来源与叙事角色", (snapshot, impact) => {
      const asset = assetById(snapshot, input.assetId);
      if (input.role !== undefined) asset.role = input.role;
      if (input.tags !== undefined) asset.tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))];
      if (input.provenance !== undefined) {
        assertAssetProvenanceValid(input.provenance);
        if (asset.motion) {
          if (input.provenance.source !== "generated") throw new DomainError("受管作品必须保留生成来源", "MOTION_PROVENANCE_INVALID");
        }
        asset.provenance = input.provenance;
      }
      impact.changed.push(asset.id);
      impact.recomputed.push("素材角色与来源");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 素材需求只描述缺什么和为什么缺，不把候选 URL 或最终 Scene 使用方式写进需求。
   * 这样搜索、下载和 Cutaway 决策仍能分别审查。
   */
  manageAssetRequirement(input: {
    projectId: Id;
    baseRevision: number;
    action: "create" | "update" | "close";
    assetRequestId?: Id;
    title?: string;
    purpose?: string;
    visualBrief?: string;
    mediaKind?: AssetRequest["mediaKind"];
    audioBrief?: string;
    sound?: AssetRequest["sound"];
    role?: Asset["role"];
    queryHints?: string[];
    excludedTerms?: string[];
    targetAspectRatio?: AssetRequest["targetAspectRatio"];
    minDurationMs?: number | null;
    fallbackPlan?: AssetRequest["fallbackPlan"];
    closeReason?: string;
  }): ProjectState {
    if (input.action !== "create" && !input.assetRequestId) {
      throw new DomainError("更新或关闭素材需求时必须提供 assetRequestId", "ASSET_REQUEST_ID_REQUIRED");
    }
    if (input.action === "create") {
      if (!input.title?.trim() || !input.purpose?.trim() || !(input.mediaKind === "audio" ? input.audioBrief : input.visualBrief)?.trim()) {
        throw new DomainError("创建素材需求必须说明标题、叙事用途和具体画面/声音", "ASSET_REQUEST_CONTENT_REQUIRED");
      }
      if (input.minDurationMs != null && (!Number.isInteger(input.minDurationMs) || input.minDurationMs <= 0 || input.minDurationMs > 300_000)) {
        throw new DomainError("素材最小时长必须是 1 到 300000 的整数，null 表示无时长限制", "INVALID_ASSET_REQUEST_DURATION");
      }
    }
    const state = this.repository.commit(input.projectId, input.baseRevision, input.action === "create" ? "创建素材需求" : input.action === "close" ? "关闭素材需求" : "更新素材需求", (snapshot, impact) => {
      const updatedAt = now();
      let request: AssetRequest;
      if (input.action === "create") {
        request = {
          id: createId("asset_request"),
          title: input.title!.trim(),
          purpose: input.purpose!.trim(),
          mediaKind: input.mediaKind ?? "visual",
          visualBrief: input.visualBrief?.trim(),
          audioBrief: input.audioBrief?.trim(),
          sound: input.sound && soundRequirementSchema.parse(input.sound),
          role: input.role ?? (input.mediaKind === "audio" ? "sfx" : "b_roll"),
          queryHints: normalizedTextList(input.queryHints),
          excludedTerms: normalizedTextList(input.excludedTerms),
          targetAspectRatio: input.mediaKind === "audio" ? undefined : input.targetAspectRatio ?? snapshot.project.brief.aspectRatio,
          minDurationMs: input.minDurationMs ?? undefined,
          fallbackPlan: input.fallbackPlan ?? (input.mediaKind === "audio" ? "ask_user" : "keep_presenter"),
          status: "open",
          createdAt: updatedAt,
          updatedAt
        };
        snapshot.assetRequests.push(request);
      } else {
        request = assetRequestById(snapshot, input.assetRequestId!);
        if (input.action === "close") {
          request.status = "closed";
          request.closeReason = input.closeReason?.trim() || "当前需求不再需要外部素材。";
          request.updatedAt = updatedAt;
        } else {
          if (request.status === "closed") throw new DomainError("已关闭的素材需求不能直接更新，请新建需求", "ASSET_REQUEST_CLOSED");
          if (input.mediaKind !== undefined && input.mediaKind !== (request.mediaKind ?? "visual")) throw new DomainError("不能把既有视觉需求改成声音需求或反向修改，请新建需求", "ASSET_REQUEST_KIND_IMMUTABLE");
          if (input.sound !== undefined) request.sound = soundRequirementSchema.parse(input.sound);
          if (input.audioBrief !== undefined) {
            if (!input.audioBrief.trim()) throw new DomainError("声音需求说明不能为空", "ASSET_REQUEST_CONTENT_REQUIRED");
            request.audioBrief = input.audioBrief.trim();
          }
          if (input.title !== undefined) {
            const title = input.title.trim();
            if (!title) throw new DomainError("素材需求标题不能为空", "INVALID_ASSET_REQUEST_TITLE");
            request.title = title;
          }
          if (input.purpose !== undefined) {
            const purpose = input.purpose.trim();
            if (!purpose) throw new DomainError("素材需求用途不能为空", "INVALID_ASSET_REQUEST_PURPOSE");
            request.purpose = purpose;
          }
          if (input.visualBrief !== undefined) {
            const visualBrief = input.visualBrief.trim();
            if (!visualBrief) throw new DomainError("素材需求必须保留具体画面说明", "INVALID_ASSET_REQUEST_VISUAL_BRIEF");
            request.visualBrief = visualBrief;
          }
          if (input.role !== undefined) request.role = input.role;
          if (input.queryHints !== undefined) request.queryHints = normalizedTextList(input.queryHints);
          if (input.excludedTerms !== undefined) request.excludedTerms = normalizedTextList(input.excludedTerms);
          if (input.targetAspectRatio !== undefined) request.targetAspectRatio = input.targetAspectRatio;
          if (input.minDurationMs !== undefined) {
            if (input.minDurationMs !== null && (!Number.isInteger(input.minDurationMs) || input.minDurationMs <= 0 || input.minDurationMs > 300_000)) throw new DomainError("素材最小时长必须是 1 到 300000 的整数，null 用于清空", "INVALID_ASSET_REQUEST_DURATION");
            request.minDurationMs = input.minDurationMs ?? undefined;
          }
          if (input.fallbackPlan !== undefined) request.fallbackPlan = input.fallbackPlan;
          request.updatedAt = updatedAt;
          const searchCriteriaChanged = input.sound !== undefined || input.purpose !== undefined
            || input.audioBrief !== undefined
            || input.role !== undefined
            || input.visualBrief !== undefined
            || input.queryHints !== undefined
            || input.excludedTerms !== undefined
            || input.targetAspectRatio !== undefined
            || input.minDurationMs !== undefined;
          if (searchCriteriaChanged) {
            const hasDownloadInFlight = snapshot.assetCandidates.some((candidate) => candidate.assetRequestId === request.id && (candidate.status === "acquisition_queued" || candidate.status === "acquiring"));
            if (hasDownloadInFlight) throw new DomainError("已有候选正在下载，不能同时修改它的搜索条件", "ASSET_REQUEST_ACQUISITION_IN_PROGRESS");
            // 保留历史记录，但旧候选必须经新的 SearchIntent 再次检查，不能继续自动入库。
            for (const candidate of snapshot.assetCandidates.filter((entry) => entry.assetRequestId === request.id && entry.status === "available")) {
              candidate.status = "rejected";
              candidate.rejectionReason = "素材需求已更新，必须重新搜索并复核候选。";
              candidate.filterReasons = [...candidate.filterReasons, candidate.rejectionReason];
              candidate.updatedAt = updatedAt;
            }
            request.status = "open";
          }
        }
      }
      // 关闭保留历史关联；取消意图或删除计划后仍须能结束旧需求。
      if (request.sound && input.action !== "close") {
        const plan = snapshot.soundPlans?.find((entry) => entry.id === request.sound!.soundPlanId);
        if (request.mediaKind !== "audio" || !plan || plan.status !== "current" || !plan.intents.some((entry) => entry.id === request.sound!.soundIntentId)) throw new DomainError("声音需求必须关联有效段落意图", "SOUND_PLAN_STALE");
      }
      if (request.mediaKind === "audio") {
        if (!request.audioBrief?.trim() || !["sfx", "bgm"].includes(request.role) || !["local_audio", "omit_audio", "ask_user"].includes(request.fallbackPlan) || request.visualBrief || input.targetAspectRatio) {
          throw new DomainError("声音需求需 audioBrief、sfx/bgm 角色及声音 fallback，不接受视觉参数", "INVALID_AUDIO_ASSET_REQUEST");
        }
      } else if (request.audioBrief || ["sfx", "bgm"].includes(request.role) || ["local_audio", "omit_audio"].includes(request.fallbackPlan)) {
        throw new DomainError("视觉需求不接受声音专用字段", "INVALID_VISUAL_ASSET_REQUEST");
      }
      impact.changed.push(request.id);
      impact.recomputed.push("素材需求与搜索范围");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 选定来源使用既有队列；相同键的重试不能悄悄改 URL 或材料参数。 */
  submitSourceMaterial(projectId: Id, raw: SourceMaterialInput): JobRecord {
    const input = sourceMaterialSchema.parse(raw);
    const current = this.readProject(projectId);
    const key = `source-material:${input.idempotencyKey}`;
    const existing = this.repository.listJobs(projectId).find(j => j.idempotencyKey === key);
    if (existing) {
      if (JSON.stringify(existing.payload.input) !== JSON.stringify(input)) throw new DomainError("来源任务幂等输入冲突", "SOURCE_IDEMPOTENCY_CONFLICT");
      return existing;
    }
    if (current.revision.number !== input.baseRevision) throw new DomainError("项目 Revision 已变化", "REVISION_CONFLICT");
    const job = this.repository.createJob({ projectId, kind: "source_material_acquisition", payload: { input }, idempotencyKey: key });
    this.publish({ projectId, revision: current.revision.number, type: "job" });
    return job;
  }

  completeSourceMaterial(projectId: Id, jobId: Id, manifest: { url: string; fetchedAt: string; capture?: unknown; files: Array<{ file: string; kind: "document" | "image"; hash: string; page?: number }> }) {
    const job = this.repository.getJob(jobId);
    if (job.projectId !== projectId || job.kind !== "source_material_acquisition") throw new DomainError("来源任务不属于当前项目", "SOURCE_JOB_MISMATCH");
    const input = sourceMaterialSchema.parse(job.payload.input);
    const current = this.readProject(projectId);
    let assets = current.snapshot.assets.filter(a => a.provenance?.generationJobId === jobId);
    if (!assets.length) {
      const state = this.repository.commit(projectId, current.revision.number, "登记选定来源原文件与页面", (snapshot, impact) => {
        assets = manifest.files.map(file => createMediaAsset({ name: file.page ? `来源第${file.page}页` : new URL(manifest.url).hostname,
          kind: file.kind, managedPath: `assets/derived/source-material/${jobId}/${file.file}`, sourceHash: file.hash, role: "evidence", tags: ["source_material", ...(file.page ? [`pdf_page:${file.page}`] : [])],
          provenance: { source: "provider", provider: "source_material", generationJobId: jobId, sourceUrl: manifest.url, originalAssetId: file.page ? `${manifest.url}#page=${file.page}` : manifest.url, acquiredAt: manifest.fetchedAt, } }));
        snapshot.assets.push(...assets); impact.changed.push(...assets.map(a => a.id));
      });
      this.publish({ projectId, revision: state.revision.number, type: "revision" });
    }
    const mediaAnalysisJobs = assets.map(asset => this.repository.createJob({ projectId, kind: "media_analysis", payload: { assetId: asset.id }, idempotencyKey: `media_analysis:${asset.id}` }));
    return { assetIds: assets.map(a => a.id), sourceAssetId: assets[0].id, pages: manifest.files.flatMap((f,i) => f.page ? [{ page: f.page, snapshotAssetId: assets[i].id, sourceAssetId: assets[0].id }] : []), sourceUrl: manifest.url, acquiredAt: manifest.fetchedAt, capture: manifest.capture, mediaAnalysisJobIds: mediaAnalysisJobs.map(j => j.id) };
  }

  /** 搜索是操作数据；正式采用才把必要候选提升到创作快照。 */
  recordAssetSearch(input: {
    projectId: Id; baseRevision: number; assetRequestId: Id; provider: string; query: string;
    candidates: AssetSearchCandidateInput[]; requestVersion?: string; cursor?: string; nextCursor?: string;
    mediaType?: "image" | "video" | "audio";
    diagnostics?: import("@videocut/contracts").AssetSearchDiagnostics;
  }): { nextCursor?: string; state: ProjectState; intent: SearchIntent; candidates: AssetCandidate[]; reused: boolean; sessionId: string; requestVersion: string; diagnostics: import("@videocut/contracts").AssetSearchDiagnostics } {
    const state = this.readProject(input.projectId);
    const request = assetRequestById(state.snapshot, input.assetRequestId);
    const version = assetRequestVersion(request);
    if (input.requestVersion && input.requestVersion !== version) throw new DomainError("搜索期间需求已变化，请重新检索", "MEDIA_REQUEST_STALE");
    if (request.status === "closed") throw new DomainError("素材需求已关闭", "ASSET_REQUEST_CLOSED");
    const query = input.query.trim();
    if (!query) throw new DomainError("搜索查询不能为空", "EMPTY_ASSET_SEARCH_QUERY");
    const diagnostics = input.diagnostics ?? { complete: true, warnings: [] };
    // 第 4 版不再按时长限制搜索或下载；旧缓存仍可按候选 ID 重新核对。
    const existing = diagnostics.complete && this.repository.mediaIntelligence.searches(input.projectId).find((entry) => entry.resultFormatVersion === 4 && entry.intent.cursor === input.cursor && entry.diagnostics?.complete !== false && entry.intent.mediaType === input.mediaType && entry.requestId === request.id && entry.requestVersion === version && entry.intent.provider === input.provider && entry.intent.query === query && Date.now() - Date.parse(entry.createdAt) < 30 * 60_000);
    if (existing) return { nextCursor: existing.nextCursor, state, intent: existing.intent, candidates: existing.candidates, reused: true, sessionId: existing.id, requestVersion: version, diagnostics: existing.diagnostics ?? { complete: true, warnings: [] } };
    const createdAt = now();
    const intent: SearchIntent = { id: createId("search_intent"), assetRequestId: request.id, provider: input.provider, query, mediaType: input.mediaType, ...(input.cursor ? { cursor: input.cursor } : {}), createdAt };
    if (input.candidates.length > 30) throw new DomainError("Provider 单页超过30条保存预算", "ASSET_SEARCH_PAGE_BUDGET");
    const candidates: AssetCandidate[] = [...new Map(input.candidates.map(c => [c.originalAssetId, c])).values()].map((source) => {
      const filterReasons = candidateFilterReasons(source, request);
      return { ...source, id: createId("asset_candidate"), assetRequestId: request.id, searchIntentId: intent.id, provider: input.provider,
        originalAssetId: source.originalAssetId.trim(), name: source.name.trim() || "未命名候选", kind: source.kind ?? "video",
        sourceUrl: source.sourceUrl.trim(), tags: normalizedTextList(source.tags), hardFilterPassed: !filterReasons.length, filterReasons,
        status: filterReasons.length ? "rejected" : "available", rejectionReason: filterReasons.length ? filterReasons.join(" ") : undefined, createdAt, updatedAt: createdAt };
    });
    const session = { id: createId("search_session"), projectId: input.projectId, requestId: request.id, requestVersion: version, intent, candidates, diagnostics, resultFormatVersion: 4, nextCursor: input.nextCursor, createdAt };
    this.repository.mediaIntelligence.saveSearch(session);
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return { nextCursor: input.nextCursor, state, intent, candidates, reused: false, sessionId: session.id, requestVersion: version, diagnostics };
  }

  readAssetCandidate(input: { projectId: Id; assetCandidateId: Id }): { revision: number; request: AssetRequest; intent: SearchIntent; candidate: AssetCandidate; requestVersion: string; observations: unknown[] } {
    const state = this.readProject(input.projectId);
    const cached = this.repository.mediaIntelligence.candidate(input.projectId, input.assetCandidateId);
    const candidate = state.snapshot.assetCandidates.find((entry) => entry.id === input.assetCandidateId) ?? cached?.candidate;
    if (!candidate) throw new NotFoundError("素材候选不存在");
    const request = assetRequestById(state.snapshot, candidate.assetRequestId);
    refreshCandidateDurationFilter(candidate, request);
    const intent = state.snapshot.searchIntents.find((entry) => entry.id === candidate.searchIntentId) ?? cached?.session.intent;
    if (!intent) throw new DomainError("素材候选缺少搜索意图", "ASSET_CANDIDATE_INTENT_MISSING");
    return { revision: state.revision.number, request, intent, candidate, requestVersion: cached?.session.requestVersion ?? assetRequestVersion(request),
      observations: this.repository.mediaIntelligence.sources(input.projectId).filter((source) => source.target.candidateId === candidate.id).flatMap((source) => this.repository.mediaIntelligence.observations(input.projectId, source.id)) };
  }

  /** Candidate 只有经过技术过滤才能进入下载队列。 */
  acquireAssetCandidate(input: { projectId: Id; baseRevision: number; assetCandidateId: Id; idempotencyKey?: string; options?: AssetAcquisitionOptions }): { state: ProjectState; candidate: AssetCandidate; job: JobRecord } {
    const current = this.readProject(input.projectId);
    const selected = this.readAssetCandidate(input).candidate;
    const options = assetAcquisitionOptionsSchema.parse({ ...input.options,
      qualityHeight: selected.kind === "video" && ["youtube", "pexels"].includes(selected.provider) ? input.options?.qualityHeight ?? current.snapshot.timeline.height : input.options?.qualityHeight });
    if (options.sourceRange && (selected.provider !== "youtube" || selected.kind !== "video")) throw new DomainError("当前仅 YouTube 视频支持按原片范围取得", "ASSET_RANGE_UNSUPPORTED");
    if (options.qualityHeight && (selected.kind !== "video" || !["youtube", "pexels"].includes(selected.provider))) throw new DomainError("当前来源不支持画质选择", "ASSET_QUALITY_UNSUPPORTED");
    if (options.sourceRange && selected.durationMs && options.sourceRange.endMs > selected.durationMs) throw new DomainError("取得范围超出已知原片时长", "ASSET_SOURCE_RANGE_INVALID");
    const jobs = this.repository.listJobs(input.projectId);
    const sameOptions = (job: JobRecord) => job.payload.acquisition === undefined
      ? !options.sourceRange && input.options?.qualityHeight === undefined
      : JSON.stringify(job.payload.acquisition) === JSON.stringify(options);
    const active = jobs.find(job => job.kind === "asset_acquisition" && job.payload.assetCandidateId === input.assetCandidateId && ["queued", "running", "unknown"].includes(job.status));
    if (active && !sameOptions(active)) throw new DomainError("该候选已有未结束的获取任务，请先查询原任务", "ASSET_ACQUISITION_IN_PROGRESS");
    const existing = jobs.find((job) => job.kind === "asset_acquisition" && job.payload.assetCandidateId === input.assetCandidateId && sameOptions(job) && !["failed", "cancelled"].includes(job.status));
    const currentCandidate = current.snapshot.assetCandidates.find((entry) => entry.id === input.assetCandidateId);
    if (existing && currentCandidate) {
      return { state: current, candidate: currentCandidate, job: existing };
    }
    let candidateId!: Id;
    let job!: JobRecord;
    const state = this.repository.commit(input.projectId, input.baseRevision, "提交素材本地化任务", (snapshot, impact) => {
      if (!snapshot.assetCandidates.some((entry) => entry.id === input.assetCandidateId)) {
        const cached = this.repository.mediaIntelligence.candidate(input.projectId, input.assetCandidateId);
        if (!cached) throw new NotFoundError("素材候选不存在");
        const request = assetRequestById(snapshot, cached.candidate.assetRequestId);
        if (cached.session.requestVersion !== assetRequestVersion(request) || Date.now() - Date.parse(cached.session.createdAt) > 24 * 3600_000) throw new DomainError("候选需求已变化或搜索已过期，需要重新检索", "MEDIA_REQUEST_STALE");
        snapshot.assetCandidates.push(structuredClone(cached.candidate));
        if (!snapshot.searchIntents.some((entry) => entry.id === cached.session.intent.id)) snapshot.searchIntents.push(structuredClone(cached.session.intent));
      }
      const candidate = assetCandidateById(snapshot, input.assetCandidateId);
      const request = assetRequestById(snapshot, candidate.assetRequestId);
      refreshCandidateDurationFilter(candidate, request);
      if (candidate.status === "acquired") candidate.status = "available";
      // 仅恢复已有明确失败 Job 的获取；不把人工拒绝或未知执行结果变成可重试。
      const recovering = candidate.status === "failed" && jobs.some(entry => entry.kind === "asset_acquisition" && entry.payload.assetCandidateId === candidate.id && entry.status === "failed");
      if (recovering) {
        if (jobs.some(entry => entry.idempotencyKey === (input.idempotencyKey ?? `asset_acquisition:${candidate.id}:${input.baseRevision}`))) throw new DomainError("失败恢复需要新的获取幂等键，旧 Job 保留失败记录", "ASSET_ACQUISITION_IDEMPOTENCY_CONFLICT");
        if (!candidateIsAllowed(candidate, request)) throw new DomainError("失败候选不满足当前技术过滤，不能恢复获取", "ASSET_CANDIDATE_NOT_ALLOWED");
        candidate.status = "available";
      }
      if (candidate.status !== "available") throw new DomainError("只有可用候选才能提交本地化任务", "ASSET_CANDIDATE_NOT_AVAILABLE");
      if (!candidateIsAllowed(candidate, request)) {
        throw new DomainError("候选素材没有通过技术过滤，不能下载", "ASSET_CANDIDATE_NOT_ALLOWED");
      }
      candidate.status = "acquisition_queued";
      candidate.acquisition = options;
      candidate.acquisitionError = undefined;
      candidate.updatedAt = now();
      request.status = "acquiring";
      request.updatedAt = candidate.updatedAt;
      candidateId = candidate.id;
      impact.changed.push(candidate.id, request.id);
      impact.recomputed.push("素材本地化任务");
      // 入队与候选提升在同一事务中；崩溃不能留下没有 Job 的 acquisition_queued。
      job = this.repository.createJob({ projectId: input.projectId, kind: "asset_acquisition", payload: { assetCandidateId: candidateId, acquisition: options }, idempotencyKey: input.idempotencyKey ?? `asset_acquisition:${candidateId}:${input.baseRevision}` });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return { state, candidate: assetCandidateById(state.snapshot, candidateId), job };
  }

  markAssetCandidateAcquiring(input: { projectId: Id; assetCandidateId: Id }): ProjectState {
    const current = this.readProject(input.projectId);
    const candidate = assetCandidateById(current.snapshot, input.assetCandidateId);
    if (candidate.status === "acquiring") return current;
    if (candidate.status !== "acquisition_queued") throw new DomainError("素材候选当前不在下载队列中", "ASSET_CANDIDATE_NOT_QUEUED");
    const state = this.repository.commit(input.projectId, current.revision.number, "开始素材本地化", (snapshot, impact) => {
      const target = assetCandidateById(snapshot, input.assetCandidateId);
      target.status = "acquiring";
      target.updatedAt = now();
      impact.changed.push(target.id);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 下载文件已在受管临时目录校验完成后，才在这里注册正式 Asset 并触发媒体分析。 */
  completeAssetAcquisition(input: {
    projectId: Id;
    assetCandidateId: Id;
    name: string;
    managedPath: string;
    sourceHash: string;
    metadata?: MediaMetadata;
  }): { state: ProjectState; candidate: AssetCandidate; asset: Asset; duplicate: boolean; mediaAnalysisJob?: JobRecord } {
    const current = this.readProject(input.projectId);
    let asset!: Asset;
    let duplicate = false;
    const state = this.repository.commit(input.projectId, current.revision.number, "完成素材本地化并登记来源", (snapshot, impact) => {
      const candidate = assetCandidateById(snapshot, input.assetCandidateId);
      const request = assetRequestById(snapshot, candidate.assetRequestId);
      refreshCandidateDurationFilter(candidate, request);
      if (candidate.status !== "acquiring" && candidate.status !== "acquisition_queued") {
        throw new DomainError("素材候选当前不允许完成本地化", "ASSET_CANDIDATE_NOT_ACQUIRING");
      }
      if (!candidateIsAllowed(candidate, request)) {
        throw new DomainError("候选素材已不满足当前技术需求，不能登记为项目素材", "ASSET_CANDIDATE_NOT_ALLOWED");
      }
      const acquiredAt = now();
      const existing = snapshot.assets.find((entry) => entry.sourceHash === input.sourceHash && entry.provenance?.provider === candidate.provider && entry.provenance?.originalAssetId === candidate.originalAssetId && JSON.stringify(entry.provenance.acquisition?.sourceRange) === JSON.stringify(candidate.acquisition?.sourceRange));
      if (existing) {
        asset = existing;
        duplicate = true;
        const acquisition = asset.provenance!.acquisition ??= { ...candidate.acquisition, candidateId: candidate.id };
        acquisition.candidateIds = [...new Set([acquisition.candidateId, ...(acquisition.candidateIds ?? []), candidate.id])];
      } else {
        const provenance: Asset["provenance"] = {
          source: "provider",
          provider: candidate.provider,
          sourceUrl: candidate.sourceUrl,
          originalAssetId: candidate.originalAssetId,
          creator: candidate.creator,
          acquisition: { ...candidate.acquisition, candidateId: candidate.id },
          acquiredAt
        };
        assertAssetProvenanceValid(provenance);
        asset = createMediaAsset({
          name: input.name,
          kind: candidate.kind,
          managedPath: input.managedPath,
          sourceHash: input.sourceHash,
          role: request.role,
          tags: [...candidate.tags, ...request.queryHints],
          provenance
        });
        snapshot.assets.push(asset);
        impact.recomputed.push("素材分析");
      }
      if (input.metadata) {
        asset.metadata = input.metadata;
        asset.status = "ready";
        // 片段实测时长属于 Asset；候选仍描述原片，不能被截取长度覆盖。
        candidate.width = input.metadata.width;
        candidate.height = input.metadata.height;
        if (!candidate.acquisition?.sourceRange) candidate.durationMs = input.metadata.durationMs;
      }
      candidate.status = "acquired";
      candidate.acquiredAssetId = asset.id;
      candidate.acquisitionError = undefined;
      candidate.updatedAt = acquiredAt;
      request.status = "fulfilled";
      request.updatedAt = acquiredAt;
      impact.changed.push(candidate.id, request.id, asset.id);
      impact.recomputed.push("素材来源与本地 Asset");
    });
    const mediaAnalysisJob = duplicate ? undefined : this.repository.createJob({
      projectId: input.projectId,
      kind: "media_analysis",
      payload: { assetId: asset.id },
      idempotencyKey: `media_analysis:${asset.id}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    if (mediaAnalysisJob) this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return { state, candidate: assetCandidateById(state.snapshot, input.assetCandidateId), asset, duplicate, mediaAnalysisJob };
  }

  failAssetCandidateAcquisition(input: { projectId: Id; assetCandidateId: Id; reason: string }): ProjectState {
    const current = this.readProject(input.projectId);
    const state = this.repository.commit(input.projectId, current.revision.number, "素材本地化失败", (snapshot, impact) => {
      const candidate = assetCandidateById(snapshot, input.assetCandidateId);
      const request = assetRequestById(snapshot, candidate.assetRequestId);
      candidate.status = "failed";
      candidate.acquisitionError = input.reason;
      candidate.updatedAt = now();
      const hasPending = snapshot.assetCandidates.some((entry) => entry.assetRequestId === request.id && (entry.status === "acquisition_queued" || entry.status === "acquiring"));
      const hasAlternative = snapshot.assetCandidates.some((entry) => entry.assetRequestId === request.id && entry.status === "available");
      request.status = hasPending ? "acquiring" : hasAlternative ? "candidates_ready" : "open";
      request.updatedAt = candidate.updatedAt;
      impact.changed.push(candidate.id, request.id);
      impact.warnings.push(`素材候选“${candidate.name}”本地化失败：${input.reason}`);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  readAssetProvenance(input: { projectId: Id; assetId: Id }): { revision: number; asset: Asset; provenance?: Asset["provenance"]; candidate?: AssetCandidate } {
    const state = this.readProject(input.projectId);
    const asset = assetById(state.snapshot, input.assetId);
    return {
      revision: state.revision.number,
      asset,
      provenance: asset.provenance,
      candidate: state.snapshot.assetCandidates.find((candidate) => candidate.acquiredAssetId === asset.id)
    };
  }

  applyMediaAnalysis(input: { projectId: Id; assetId: Id; metadata: MediaMetadata }): ProjectState {
    const current = this.readProject(input.projectId);
    const state = this.repository.commit(input.projectId, current.revision.number, "完成媒体分析", (snapshot, impact) => {
      const asset = assetById(snapshot, input.assetId);
      asset.status = "ready";
      asset.metadata = input.metadata;
      asset.failureReason = undefined;
      impact.changed.push(asset.id);
      impact.recomputed.push("素材元数据、缩略图与代理证据");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  failAssetAnalysis(input: { projectId: Id; assetId: Id; reason: string }): ProjectState {
    const current = this.readProject(input.projectId);
    const state = this.repository.commit(input.projectId, current.revision.number, "媒体分析失败", (snapshot, impact) => {
      const asset = assetById(snapshot, input.assetId);
      asset.status = "failed";
      asset.failureReason = input.reason;
      impact.changed.push(asset.id);
      impact.warnings.push(`素材 ${asset.name} 分析失败：${input.reason}`);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  markAssetAnalyzing(input: { projectId: Id; assetId: Id }): ProjectState {
    const current = this.readProject(input.projectId);
    const asset = assetById(current.snapshot, input.assetId);
    if (asset.status === "analyzing") return current;
    const state = this.repository.commit(input.projectId, current.revision.number, "开始媒体分析", (snapshot, impact) => {
      const target = assetById(snapshot, input.assetId);
      target.status = "analyzing";
      impact.changed.push(target.id);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 提交实拍镜头的基础分析。这里固定的是源文件、阈值和当时 Revision；Worker 只能回传可测量的边界，
   * 不会把场景变化误写成“人物完成了某个动作”。
   */
  submitVlogAnalysis(input: {
    projectId: Id;
    baseRevision: number;
    assetIds: Id[];
    sceneThreshold?: number;
    idempotencyKey?: string;
  }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, state.revision.number);
    if (state.snapshot.project.profile !== "vlog" && state.snapshot.project.profile !== "hybrid") {
      throw new DomainError("镜头分析只适用于 Vlog 或以实拍事件为主的混合项目", "VLOG_PROFILE_REQUIRED");
    }
    const assetIds = [...new Set(input.assetIds)];
    if (!assetIds.length || assetIds.length !== input.assetIds.length) {
      throw new DomainError("请提供至少一条且不重复的 Vlog 视频素材", "VLOG_ANALYSIS_ASSETS_REQUIRED");
    }
    for (const assetId of assetIds) {
      const asset = assetById(state.snapshot, assetId);
      if (asset.status !== "ready" || asset.kind !== "video" || !asset.metadata?.videoCodec || asset.metadata.durationMs <= 0) {
        throw new DomainError("Vlog 镜头分析只能提交已完成媒体分析的本地视频素材", "VLOG_ANALYSIS_ASSET_NOT_READY");
      }
    }
    const sceneThreshold = input.sceneThreshold ?? 0.18;
    if (!Number.isFinite(sceneThreshold) || sceneThreshold < 0.05 || sceneThreshold > 0.9) {
      throw new DomainError("镜头边界阈值必须在 0.05 到 0.9 之间", "INVALID_VLOG_SCENE_THRESHOLD");
    }
    const payload: VlogAnalysisJobPayload = { requestedRevision: state.revision.number, assetIds, sceneThreshold };
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "vlog_analysis",
      payload,
      idempotencyKey: input.idempotencyKey ?? `vlog_analysis:${assetIds.join(",")}:${sceneThreshold}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /** Worker 完成后原子登记 Shot Evidence；重复领取同一 Job 时只读回已写入的结果。 */
  completeVlogAnalysis(input: {
    projectId: Id;
    jobId: Id;
    analyses: CompletedVlogShotAnalysis[];
  }): { state: ProjectState; analyses: VlogShotAnalysis[]; duplicate: boolean } {
    const job = this.repository.getJob(input.jobId);
    if (job.projectId !== input.projectId || job.kind !== "vlog_analysis") {
      throw new DomainError("该任务不是当前项目的 Vlog 镜头分析任务", "VLOG_ANALYSIS_JOB_NOT_FOUND");
    }
    const alreadyCompleted = this.readProject(input.projectId).snapshot.vlogShotAnalyses.filter((shot) => shot.analysisJobId === job.id);
    if (alreadyCompleted.length > 0) {
      const current = this.readProject(input.projectId);
      this.repository.updateJob(job.id, {
        status: job.status,
        result: { ...(job.result ?? {}), analysisIds: alreadyCompleted.map((shot) => shot.id), revision: current.revision.number }
      });
      return { state: current, analyses: alreadyCompleted, duplicate: true };
    }
    const payload = job.payload as Partial<VlogAnalysisJobPayload>;
    if (!Number.isInteger(payload.requestedRevision) || !Array.isArray(payload.assetIds) || !payload.assetIds.every((assetId) => typeof assetId === "string")
      || !Number.isFinite(payload.sceneThreshold)) {
      throw new DomainError("Vlog 镜头分析任务缺少受管提交合同", "VLOG_ANALYSIS_PAYLOAD_INVALID");
    }
    if (!input.analyses.length) throw new DomainError("Vlog 镜头分析没有产出任何源片段", "VLOG_ANALYSIS_EMPTY_OUTPUT");
    const selectedAssetIds = new Set(payload.assetIds);
    const outputAssetIds = new Set(input.analyses.map((analysis) => analysis.assetId));
    if (input.analyses.some((analysis) => !selectedAssetIds.has(analysis.assetId)) || [...selectedAssetIds].some((assetId) => !outputAssetIds.has(assetId))) {
      throw new DomainError("Vlog 镜头分析结果必须覆盖且只能覆盖提交时选择的素材", "VLOG_ANALYSIS_ASSET_MISMATCH");
    }
    const rangeKeys = new Set<string>();
    for (const analysis of input.analyses) {
      if (!Number.isInteger(analysis.sourceStartFrame) || !Number.isInteger(analysis.sourceEndFrame) || analysis.sourceStartFrame < 0 || analysis.sourceEndFrame <= analysis.sourceStartFrame
        || !Number.isFinite(analysis.technicalScore) || analysis.technicalScore < 0 || analysis.technicalScore > 1 || !analysis.evidenceNote.trim()) {
        throw new DomainError("Vlog 镜头分析结果包含无效范围、评分或证据说明", "INVALID_VLOG_ANALYSIS_OUTPUT");
      }
      const key = `${analysis.assetId}:${analysis.sourceStartFrame}-${analysis.sourceEndFrame}`;
      if (rangeKeys.has(key)) throw new DomainError("Vlog 镜头分析不能重复写入同一源范围", "DUPLICATE_VLOG_ANALYSIS_RANGE");
      rangeKeys.add(key);
    }
    const current = this.readProject(input.projectId);
    let written: VlogShotAnalysis[] = [];
    const state = this.repository.commit(input.projectId, current.revision.number, "完成 Vlog 镜头分析", (snapshot, impact) => {
      for (const assetId of selectedAssetIds) {
        const asset = assetById(snapshot, assetId);
        if (asset.status !== "ready" || asset.kind !== "video" || !asset.metadata?.videoCodec) {
          throw new DomainError("镜头分析完成时素材已不可用或不是视频", "STALE_VLOG_ANALYSIS_ASSET");
        }
      }
      const staleShotIds = new Set(snapshot.vlogShotAnalyses.filter((shot) => selectedAssetIds.has(shot.assetId) && shot.status !== "stale").map((shot) => shot.id));
      for (const shot of snapshot.vlogShotAnalyses.filter((candidate) => staleShotIds.has(candidate.id))) {
        shot.status = "stale";
        shot.updatedAt = now();
        impact.changed.push(shot.id);
        impact.stale.push(shot.id);
      }
      for (const event of snapshot.vlogEvents.filter((candidate) => candidate.shotAnalysisIds.some((shotId) => staleShotIds.has(shotId)))) {
        event.status = "stale";
        event.updatedAt = now();
        impact.changed.push(event.id);
        impact.stale.push(event.id);
      }
      for (const select of snapshot.vlogShotSelects.filter((candidate) => staleShotIds.has(candidate.shotAnalysisId))) {
        this.markVlogShotSelectStale(snapshot, select, impact, "其源镜头分析已重新运行");
      }
      written = input.analyses.map((analysis) => {
        const asset = assetById(snapshot, analysis.assetId);
        const sourceDuration = millisecondsToFrames(asset.metadata!.durationMs, snapshot.timeline.fps);
        if (analysis.sourceEndFrame > sourceDuration) {
          throw new DomainError(`镜头分析范围超出素材“${asset.name}”的真实时长`, "VLOG_ANALYSIS_RANGE_OUT_OF_BOUNDS");
        }
        const shot: VlogShotAnalysis = {
          id: createId("vlog_shot"),
          assetId: analysis.assetId,
          analysisJobId: job.id,
          sourceStartFrame: analysis.sourceStartFrame,
          sourceEndFrame: analysis.sourceEndFrame,
          source: analysis.source,
          sceneChangeScore: analysis.sceneChangeScore,
          technicalScore: analysis.technicalScore,
          hasAudio: analysis.hasAudio,
          evidenceNote: analysis.evidenceNote.trim(),
          status: "ready",
          createdAt: now(),
          updatedAt: now()
        };
        snapshot.vlogShotAnalyses.push(shot);
        impact.changed.push(shot.id);
        return shot;
      });
      impact.recomputed.push("Vlog 镜头边界、技术可用性与现场声证据");
    });
    const updatedJob = this.repository.updateJob(job.id, {
      status: job.status,
      result: { ...(job.result ?? {}), analysisIds: written.map((shot) => shot.id), revision: state.revision.number }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    this.publish({ projectId: updatedJob.projectId, revision: state.revision.number, type: "job" });
    return { state, analyses: written, duplicate: false };
  }

  readVlogPlan(projectId: Id): Pick<ProjectSnapshot, "vlogShotAnalyses" | "vlogEvents" | "vlogShotSelects" | "vlogAmbientCues" | "vlogMusicBeats"> & { revision: number } {
    const state = this.readProject(projectId);
    return {
      revision: state.revision.number,
      vlogShotAnalyses: state.snapshot.vlogShotAnalyses,
      vlogEvents: state.snapshot.vlogEvents,
      vlogShotSelects: state.snapshot.vlogShotSelects,
      vlogAmbientCues: state.snapshot.vlogAmbientCues,
      vlogMusicBeats: state.snapshot.vlogMusicBeats
    };
  }

  /**
   * 多机位同步事实与切机位决定分开读取。Group 是不可被 Timeline 编辑改写的同步基线，
   * Cut 才是导演在该基线上做出的主画面选择。
   */
  readMulticamPlan(projectId: Id): Pick<ProjectSnapshot, "multicamGroups" | "multicamCuts"> & { revision: number } {
    const state = this.readProject(projectId);
    return {
      revision: state.revision.number,
      multicamGroups: state.snapshot.multicamGroups,
      multicamCuts: state.snapshot.multicamCuts
    };
  }

  /**
   * 音频相关只能产生同步候选。它固定输入二进制哈希与分析边界，Worker 成功后仍须由
   * verifyMulticamGroup 记录连续预览/人工确认，才允许任何 Cut 进入 Timeline。
   */
  submitMulticamSync(input: {
    projectId: Id;
    baseRevision: number;
    title?: string;
    assetIds: Id[];
    angleLabels: Record<Id, string>;
    referenceAssetId?: Id;
    masterAudioAssetId?: Id;
    maxSearchSeconds?: number;
    /**
     * 每个机位实际参与本次自动同步的原始源范围。传入后必须完整覆盖 assetIds；
     * 不创建物理裁片，范围坐标统一使用项目 Timeline FPS。
     */
    sourceRanges?: Record<Id, MulticamSourceRange>;
    idempotencyKey?: string;
  }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, state.revision.number);
    if (state.snapshot.project.profile === "visual_explainer") {
      throw new DomainError("多机位同步只适用于 Presenter、Vlog 或 Hybrid 项目", "MULTICAM_PROFILE_UNSUPPORTED");
    }
    const assetIds = [...new Set(input.assetIds)];
    if (assetIds.length < 2 || assetIds.length !== input.assetIds.length) {
      throw new DomainError("多机位同步至少需要两条且不重复的视频素材", "MULTICAM_ASSETS_REQUIRED");
    }
    const referenceAssetId = input.referenceAssetId ?? assetIds[0]!;
    const masterAudioAssetId = input.masterAudioAssetId ?? referenceAssetId;
    this.assertMulticamAssets(state.snapshot, assetIds, referenceAssetId, masterAudioAssetId, true);
    const sourceRanges = this.normalizeMulticamSourceRanges(state.snapshot, assetIds, input.sourceRanges);
    const angleLabels = Object.fromEntries(assetIds.map((assetId) => {
      const label = input.angleLabels[assetId]?.trim();
      if (!label) throw new DomainError("多机位同步必须为每个输入机位显式提供名称，不能从文件名或拍摄日期猜测", "MULTICAM_ANGLE_LABEL_REQUIRED");
      return [assetId, label];
    })) as Record<Id, string>;
    if (new Set(Object.values(angleLabels)).size !== assetIds.length) {
      throw new DomainError("同一多机位 Group 的机位名称不能重复", "MULTICAM_ANGLE_LABEL_DUPLICATED");
    }
    const maxSearchSeconds = input.maxSearchSeconds ?? 600;
    if (!Number.isInteger(maxSearchSeconds) || maxSearchSeconds < 20 || maxSearchSeconds > 1_800) {
      throw new DomainError("多机位自动同步搜索范围必须在 20 到 1800 秒之间", "MULTICAM_SEARCH_RANGE_INVALID");
    }
    const sourceHashes = Object.fromEntries(assetIds.map((assetId) => [assetId, assetById(state.snapshot, assetId).sourceHash!])) as Record<Id, string>;
    const title = input.title?.trim() || "多机位同步";
    const payload: MulticamSyncJobPayload = {
      requestedRevision: state.revision.number,
      title,
      assetIds,
      angleLabels,
      sourceHashes,
      referenceAssetId,
      masterAudioAssetId,
      maxSearchSeconds,
      sourceRanges
    };
    const sourceRangeKey = assetIds.map((assetId) => {
      const range = sourceRanges[assetId]!;
      return `${assetId}:${range.startFrame}-${range.endFrame}`;
    }).join(",");
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "multicam_sync",
      payload,
      // 相同素材换了同步区间必须是不同的分析输入，不能被旧 Job 错误去重。
      idempotencyKey: input.idempotencyKey ?? `multicam_sync:${assetIds.join(",")}:${referenceAssetId}:${masterAudioAssetId}:${maxSearchSeconds}:${sourceRangeKey}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /** Worker 写回的是候选证据。低相关、峰值歧义或双窗口漂移均必须在 Worker 端失败，不写入误导性的 Group。 */
  completeMulticamSync(input: {
    projectId: Id;
    jobId: Id;
    angleSyncs: CompletedMulticamAngleSync[];
    /** Worker 成功生成的受管并排预览；自动 candidate 没有它不得进入确认流程。 */
    syncPreview: MulticamSyncPreview;
  }): { state: ProjectState; group: MulticamGroup; duplicate: boolean } {
    const job = this.repository.getJob(input.jobId);
    if (job.projectId !== input.projectId || job.kind !== "multicam_sync") {
      throw new DomainError("该任务不是当前项目的多机位同步任务", "MULTICAM_SYNC_JOB_NOT_FOUND");
    }
    const current = this.readProject(input.projectId);
    const completed = current.snapshot.multicamGroups.find((group) => group.syncJobId === job.id);
    if (completed) {
      const preview = this.assertMulticamSyncPreview({
        projectId: input.projectId,
        snapshot: current.snapshot,
        angleSyncs: completed.angleSyncs,
        assetIds: completed.angleAssetIds,
        syncPreview: input.syncPreview
      });
      this.repository.updateJob(job.id, {
        status: job.status,
        result: { ...(job.result ?? {}), multicamGroupId: completed.id, revision: current.revision.number, multicamSyncPreview: preview }
      });
      return { state: current, group: completed, duplicate: true };
    }
    const payload = job.payload as Partial<MulticamSyncJobPayload>;
    if (!Number.isInteger(payload.requestedRevision) || !Array.isArray(payload.assetIds) || payload.assetIds.length < 2
      || !payload.assetIds.every((assetId): assetId is Id => typeof assetId === "string")
      || !payload.referenceAssetId || !payload.masterAudioAssetId || !payload.sourceHashes
      || !payload.angleLabels
      || !Number.isInteger(payload.maxSearchSeconds) || typeof payload.title !== "string") {
      throw new DomainError("多机位同步任务缺少受管提交合同", "MULTICAM_SYNC_PAYLOAD_INVALID");
    }
    const assetIds = payload.assetIds;
    const expected = new Set(assetIds);
    if (new Set(assetIds).size !== assetIds.length || input.angleSyncs.length !== assetIds.length
      || new Set(input.angleSyncs.map((sync) => sync.assetId)).size !== assetIds.length
      || input.angleSyncs.some((sync) => !expected.has(sync.assetId) || sync.method !== "audio_correlation" || sync.status !== "candidate")) {
      throw new DomainError("多机位同步结果没有完整覆盖提交时的机位，或混入了未经验证的同步状态", "MULTICAM_SYNC_RESULT_INVALID");
    }
    let group!: MulticamGroup;
    let preview!: MulticamSyncPreview;
    const state = this.repository.commit(input.projectId, current.revision.number, "完成多机位音频同步候选", (snapshot, impact) => {
      this.assertMulticamAssets(snapshot, assetIds, payload.referenceAssetId!, payload.masterAudioAssetId!, true);
      const referenceAsset = assetById(snapshot, payload.referenceAssetId!);
      // 旧排队 Job 没有 sourceRanges 时按整条素材补齐；新 Job 的 Worker 必须原样回传范围。
      const sourceRanges = this.normalizeMulticamSourceRanges(snapshot, assetIds, payload.sourceRanges);
      const referenceRange = sourceRanges[payload.referenceAssetId!]!;
      const fps = snapshot.timeline.fps;
      const driftLimitFrames = Math.max(2, Math.round(fps * 0.12));
      const normalizedAngleSyncs: MulticamAngleSync[] = [];
      for (const sync of input.angleSyncs) {
        const asset = assetById(snapshot, sync.assetId);
        const expectedHash = payload.sourceHashes![sync.assetId];
        const expectedRange = sourceRanges[sync.assetId]!;
        // 只兼容旧 payload 缺少字段的情况；新提交不得让 Worker 静默省略或改写范围。
        const returnedRange = sync.sourceRange ?? (payload.sourceRanges === undefined ? expectedRange : undefined);
        if (!expectedHash || asset.sourceHash !== expectedHash || sync.evidence.referenceSourceHash !== referenceAsset.sourceHash
          || sync.evidence.angleSourceHash !== asset.sourceHash) {
          throw new DomainError("多机位同步期间源文件已变化，不能把旧分析结论写入当前 Revision", "MULTICAM_SYNC_SOURCE_CHANGED");
        }
        if (sync.label !== payload.angleLabels![sync.assetId] || !Number.isInteger(sync.sessionOffsetFrames) || !Number.isFinite(sync.confidence) || sync.confidence < 0 || sync.confidence > 1
          || !Number.isInteger(sync.evidence.referenceSourceFrame) || !Number.isInteger(sync.evidence.angleSourceFrame)
          || !Number.isInteger(sync.evidence.windowFrames) || sync.evidence.windowFrames <= 0
          || !sync.evidence.analysisVersion.trim() || !sync.evidence.note.trim()) {
          throw new DomainError("多机位 Worker 返回了无效的同步证据", "MULTICAM_SYNC_EVIDENCE_INVALID");
        }
        if (!returnedRange || returnedRange.startFrame !== expectedRange.startFrame || returnedRange.endFrame !== expectedRange.endFrame
          || sync.evidence.referenceSourceFrame < referenceRange.startFrame
          || sync.evidence.referenceSourceFrame + sync.evidence.windowFrames > referenceRange.endFrame
          || sync.evidence.angleSourceFrame < expectedRange.startFrame
          || sync.evidence.angleSourceFrame + sync.evidence.windowFrames > expectedRange.endFrame) {
          throw new DomainError("多机位 Worker 返回的同步范围或锚点超出提交时受管源范围", "MULTICAM_SYNC_SOURCE_RANGE_INVALID");
        }
        if (sync.driftFrames !== undefined && sync.driftFrames > driftLimitFrames) {
          throw new DomainError(`多机位“${asset.name}”的双窗口偏移漂移为 ${sync.driftFrames} 帧，超过 ${driftLimitFrames} 帧；请拆短段或使用人工同步点，不能静默变速补偿。`, "MULTICAM_SYNC_DRIFT_EXCEEDED");
        }
        normalizedAngleSyncs.push({ ...sync, sourceRange: structuredClone(expectedRange) });
      }
      const referenceSync = normalizedAngleSyncs.find((sync) => sync.assetId === payload.referenceAssetId!);
      if (!referenceSync || referenceSync.sessionOffsetFrames !== 0) {
        throw new DomainError("多机位 Worker 必须将参考机位写为 0 偏移", "MULTICAM_REFERENCE_OFFSET_INVALID");
      }
      // 在写入 candidate 前，先把 Worker 文件与当前 sourceRange/固定偏移交叉核对。
      preview = this.assertMulticamSyncPreview({
        projectId: input.projectId,
        snapshot,
        angleSyncs: normalizedAngleSyncs,
        assetIds,
        syncPreview: input.syncPreview
      });
      group = {
        id: createId("multicam_group"),
        title: payload.title!.trim(),
        referenceAssetId: payload.referenceAssetId!,
        masterAudioAssetId: payload.masterAudioAssetId!,
        angleAssetIds: assetIds,
        angleSyncs: normalizedAngleSyncs,
        syncJobId: job.id,
        status: "candidate",
        createdAt: now(),
        updatedAt: now()
      };
      // 所有角度必须真正拥有同一个可切换会话区间，不能各自只在不同片段成立。
      this.resolveMulticamCommonSessionRange(snapshot, group);
      snapshot.multicamGroups.push(group);
      impact.changed.push(group.id);
      impact.recomputed.push("多机位共同音轨同步候选与受管连续预览；等待人工确认");
      impact.warnings.push("自动音频相关只生成了同步候选。请在此 Job 的受管连续预览中确认所有角度的口型、动作和现场声一致后再启用切机位。");
    });
    const updatedJob = this.repository.updateJob(job.id, {
      status: job.status,
      result: { ...(job.result ?? {}), multicamGroupId: group.id, revision: state.revision.number, multicamSyncPreview: preview }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    this.publish({ projectId: updatedJob.projectId, revision: state.revision.number, type: "job" });
    return { state, group, duplicate: false };
  }

  /**
   * 无共同可用音轨时，允许操作者在每个机位标记同一拍手、落物或明确动作帧。
   * 手工标记是可追溯事实，不会从文件名、拍摄日期或平均时长推导偏移。
   */
  createManualMulticamGroup(input: {
    projectId: Id;
    baseRevision: number;
    title: string;
    referenceAssetId: Id;
    masterAudioAssetId: Id;
    markers: Array<{ assetId: Id; label: string; sourceFrame: number; note: string }>;
  }): { state: ProjectState; group: MulticamGroup } {
    let group!: MulticamGroup;
    const state = this.repository.commit(input.projectId, input.baseRevision, "建立人工确认的多机位同步", (snapshot, impact) => {
      const assetIds = input.markers.map((marker) => marker.assetId);
      if (assetIds.length < 2 || new Set(assetIds).size !== assetIds.length) {
        throw new DomainError("人工多机位同步必须为每个且仅每个机位提供一个同一事件标记", "MULTICAM_MANUAL_MARKERS_INVALID");
      }
      this.assertMulticamAssets(snapshot, assetIds, input.referenceAssetId, input.masterAudioAssetId, false);
      const byAsset = new Map(input.markers.map((marker) => [marker.assetId, marker]));
      if (new Set(input.markers.map((marker) => marker.label.trim())).size !== input.markers.length || input.markers.some((marker) => !marker.label.trim())) {
        throw new DomainError("人工多机位同步必须为每个机位提供唯一且明确的名称", "MULTICAM_ANGLE_LABEL_REQUIRED");
      }
      const referenceMarker = byAsset.get(input.referenceAssetId);
      if (!referenceMarker || !Number.isInteger(referenceMarker.sourceFrame) || referenceMarker.sourceFrame < 0 || !referenceMarker.note.trim()) {
        throw new DomainError("人工多机位同步缺少参考机位的有效同一事件标记", "MULTICAM_REFERENCE_MARKER_INVALID");
      }
      const referenceAsset = assetById(snapshot, input.referenceAssetId);
      const angleSyncs: MulticamAngleSync[] = assetIds.map((assetId) => {
        const marker = byAsset.get(assetId)!;
        const asset = assetById(snapshot, assetId);
        const sourceDuration = millisecondsToFrames(asset.metadata!.durationMs, snapshot.timeline.fps);
        if (!Number.isInteger(marker.sourceFrame) || marker.sourceFrame < 0 || marker.sourceFrame >= sourceDuration || !marker.note.trim()) {
          throw new DomainError(`机位“${asset.name}”的人工同步点不在其真实源范围内`, "MULTICAM_MANUAL_MARKER_OUT_OF_BOUNDS");
        }
        return {
          assetId,
          label: marker.label.trim(),
          sessionOffsetFrames: referenceMarker.sourceFrame - marker.sourceFrame,
          method: "manual_marker",
          confidence: 1,
          status: "verified",
          evidence: {
            referenceSourceFrame: referenceMarker.sourceFrame,
            angleSourceFrame: marker.sourceFrame,
            windowFrames: 1,
            analysisVersion: "manual-marker-v1",
            referenceSourceHash: referenceAsset.sourceHash!,
            angleSourceHash: asset.sourceHash!,
            note: marker.note.trim(),
            verifiedAt: now()
          }
        };
      });
      group = {
        id: createId("multicam_group"),
        title: requireText(input.title, "多机位 Group 标题"),
        referenceAssetId: input.referenceAssetId,
        masterAudioAssetId: input.masterAudioAssetId,
        angleAssetIds: assetIds,
        angleSyncs,
        status: "ready",
        createdAt: now(),
        updatedAt: now()
      };
      snapshot.multicamGroups.push(group);
      impact.changed.push(group.id);
      impact.recomputed.push("人工确认的多机位同步基线");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return { state, group };
  }

  /** 自动相关的 candidate 必须一次性确认全部机位；部分确认不能让 Group 进入可编译状态。 */
  verifyMulticamGroup(input: {
    projectId: Id;
    baseRevision: number;
    groupId: Id;
    previewEvidence: string;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "确认多机位同步预览", (snapshot, impact) => {
      const group = this.multicamGroupById(snapshot, input.groupId);
      if (group.status === "stale") throw new DomainError("多机位 Group 已过期，请重新同步后再确认", "MULTICAM_GROUP_STALE");
      if (!input.previewEvidence.trim()) throw new DomainError("确认多机位同步必须记录连续预览或人工逐角度核对证据", "MULTICAM_PREVIEW_EVIDENCE_REQUIRED");
      if (group.syncJobId) {
        const syncJob = this.repository.getJob(group.syncJobId);
        if (syncJob.projectId !== input.projectId || syncJob.kind !== "multicam_sync") {
          throw new DomainError("多机位 Group 绑定的同步 Job 不属于当前项目", "MULTICAM_SYNC_JOB_NOT_FOUND");
        }
        // completeMulticamSync 在 Worker 运行中写入候选；只有 Runtime 成功收口后，
        // 才允许把这个候选升级为可剪辑的 ready，避免失败 Job 留下半成品 Group。
        if (syncJob.status !== "succeeded") {
          throw new DomainError("多机位同步 Job 尚未成功完成，不能确认自动同步候选", "MULTICAM_SYNC_PREVIEW_JOB_NOT_READY");
        }
        if (syncJob.result?.multicamGroupId !== group.id) {
          throw new DomainError("多机位同步 Job 没有返回当前 Group 的受管预览结果", "MULTICAM_SYNC_PREVIEW_RESULT_INVALID");
        }
        this.assertMulticamSyncPreview({
          projectId: input.projectId,
          snapshot,
          angleSyncs: group.angleSyncs,
          assetIds: group.angleAssetIds,
          syncPreview: syncJob.result?.multicamSyncPreview as MulticamSyncPreview
        });
      }
      if (group.angleSyncs.some((sync) => sync.status !== "candidate" && sync.status !== "verified")) {
        throw new DomainError("多机位 Group 含被拒绝或证据不足的机位，不能确认", "MULTICAM_EVIDENCE_NOT_VERIFIABLE");
      }
      for (const sync of group.angleSyncs) {
        sync.status = "verified";
        sync.evidence.verifiedAt = now();
        sync.evidence.note = `${sync.evidence.note}；预览确认：${input.previewEvidence.trim()}`;
      }
      group.status = "ready";
      group.updatedAt = now();
      impact.changed.push(group.id, ...group.angleSyncs.map((sync) => sync.assetId));
      impact.recomputed.push("多机位同步候选已通过人工连续预览确认");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 导演只选择机位和会话范围；源范围由已验证同步偏移推导，不能由调用者越过同步事实直接指定。 */
  manageMulticamCuts(input: {
    projectId: Id;
    baseRevision: number;
    action: "create" | "update" | "remove";
    groupId?: Id;
    cutId?: Id;
    order?: number;
    angleAssetId?: Id;
    sessionStartFrame?: number;
    sessionEndFrame?: number;
    reason?: string;
    continuityNote?: string;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, input.action === "create" ? "建立多机位切换" : input.action === "update" ? "调整多机位切换" : "移除多机位切换", (snapshot, impact) => {
      const disableExistingProgram = (group: MulticamGroup) => {
        if (group.sceneId) this.disableMulticamProgram(snapshot, group, impact, "机位切换已调整", "planned");
      };
      if (input.action === "remove") {
        const cut = this.multicamCutById(snapshot, requireText(input.cutId, "多机位 Cut ID"));
        const group = this.multicamGroupById(snapshot, cut.groupId);
        disableExistingProgram(group);
        snapshot.multicamCuts = snapshot.multicamCuts.filter((candidate) => candidate.id !== cut.id);
        impact.changed.push(cut.id);
        impact.stale.push(cut.id);
        return;
      }
      const existing = input.action === "update" ? this.multicamCutById(snapshot, requireText(input.cutId, "多机位 Cut ID")) : undefined;
      const group = this.multicamGroupById(snapshot, input.groupId ?? existing?.groupId ?? "");
      if (group.status !== "ready") throw new DomainError("多机位 Group 尚未完成同步确认，不能建立或调整切换", "MULTICAM_GROUP_NOT_READY");
      if (existing && group.id !== existing.groupId) throw new DomainError("调整多机位 Cut 不能悄悄换到另一个 Group；请新建 Cut", "MULTICAM_CUT_GROUP_IMMUTABLE");
      disableExistingProgram(group);
      const candidate = {
        groupId: group.id,
        order: input.order ?? existing?.order,
        angleAssetId: input.angleAssetId ?? existing?.angleAssetId,
        sessionStartFrame: input.sessionStartFrame ?? existing?.sessionStartFrame,
        sessionEndFrame: input.sessionEndFrame ?? existing?.sessionEndFrame,
        reason: input.reason ?? existing?.reason,
        continuityNote: input.continuityNote ?? existing?.continuityNote
      };
      const normalized = this.assertMulticamCut(snapshot, candidate, existing?.id);
      if (existing) {
        Object.assign(existing, normalized, { status: "planned", sceneId: undefined, timelineItemId: undefined, updatedAt: now() });
        impact.changed.push(existing.id);
      } else {
        const cut: MulticamCut = {
          id: createId("multicam_cut"),
          ...normalized,
          status: "planned",
          createdAt: now(),
          updatedAt: now()
        };
        snapshot.multicamCuts.push(cut);
        impact.changed.push(cut.id);
      }
      impact.recomputed.push("多机位会话范围与可切换机位计划");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 将同一已确认 Group 的 Cut 平铺到现有 Background/Ambient；所有画面源声静音，
   * 整段只从明确的 master audio 角度播放，避免镜头切换时声画跳变或多路叠音。
   */
  compileMulticamProgram(input: {
    projectId: Id;
    baseRevision: number;
    groupId: Id;
    cutIds: Id[];
    startFrame?: number;
    titlePrefix?: string;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "编译多机位主线", (snapshot, impact) => {
      const group = this.multicamGroupById(snapshot, input.groupId);
      if (group.status !== "ready" || group.angleSyncs.some((sync) => sync.status !== "verified")) {
        throw new DomainError("多机位同步尚未被完整确认，不能编译到 Timeline", "MULTICAM_GROUP_NOT_READY");
      }
      if (!input.cutIds.length || new Set(input.cutIds).size !== input.cutIds.length) {
        throw new DomainError("多机位编译必须明确选择至少一个且不重复的 Cut", "MULTICAM_CUTS_REQUIRED");
      }
      const selected = input.cutIds.map((cutId) => this.multicamCutById(snapshot, cutId));
      if (selected.some((cut) => cut.groupId !== group.id || cut.status === "stale")) {
        throw new DomainError("多机位编译不能混用不同 Group 或已过期的 Cut", "MULTICAM_CUT_GROUP_MISMATCH");
      }
      const ordered = [...selected].sort((left, right) => left.sessionStartFrame - right.sessionStartFrame || left.order - right.order || left.id.localeCompare(right.id));
      for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index - 1]!.sessionEndFrame !== ordered[index]!.sessionStartFrame) {
          throw new DomainError("首版多机位只能编译连续、无重叠的会话范围；请补齐空档或拆成另一段", "MULTICAM_SESSION_NOT_CONTIGUOUS");
        }
      }
      const sessionStartFrame = ordered[0]!.sessionStartFrame;
      const sessionEndFrame = ordered[ordered.length - 1]!.sessionEndFrame;
      const masterSync = group.angleSyncs.find((sync) => sync.assetId === group.masterAudioAssetId);
      const masterAsset = assetById(snapshot, group.masterAudioAssetId);
      if (!masterSync || masterSync.status !== "verified" || masterAsset.status !== "ready" || !masterAsset.metadata?.hasAudio) {
        throw new DomainError("多机位主声音必须来自当前已确认、可播放且含音轨的机位", "MULTICAM_MASTER_AUDIO_UNAVAILABLE");
      }
      const masterSourceStart = sessionStartFrame - masterSync.sessionOffsetFrames;
      const masterSourceEnd = sessionEndFrame - masterSync.sessionOffsetFrames;
      const masterDuration = millisecondsToFrames(masterAsset.metadata.durationMs, snapshot.timeline.fps);
      const masterSourceRange = this.multicamSourceRangeFor(snapshot, masterSync);
      const commonSessionRange = this.resolveMulticamCommonSessionRange(snapshot, group);
      if (masterSourceStart < 0 || masterSourceEnd > masterDuration || masterSourceEnd <= masterSourceStart
        || masterSourceStart < masterSourceRange.startFrame || masterSourceEnd > masterSourceRange.endFrame
        || sessionStartFrame < commonSessionRange.startFrame || sessionEndFrame > commonSessionRange.endFrame) {
        throw new DomainError("主声音机位没有完整覆盖本次已确认同步的共同会话范围", "MULTICAM_MASTER_AUDIO_RANGE_INVALID");
      }
      for (const cut of ordered) this.assertMulticamCut(snapshot, cut, cut.id);
      const startFrame = input.startFrame ?? 0;
      if (!Number.isInteger(startFrame) || startFrame < 0) throw new DomainError("多机位主线起点必须是非负整数帧", "MULTICAM_PROGRAM_START_INVALID");
      const endFrame = startFrame + sessionEndFrame - sessionStartFrame;
      const backgroundTrack = trackByName(snapshot, "Background");
      const ambientTrack = trackByName(snapshot, "Ambient");
      if (backgroundTrack.locked || ambientTrack.locked) throw new DomainError("Background 或 Ambient 轨已锁定，不能编译多机位主线", "TRACK_LOCKED");
      this.disableMulticamProgram(snapshot, group, impact, "正在重新编译", "planned");
      const overlaps = (trackId: Id) => snapshot.timeline.items.some((item) => !item.disabled && item.trackId === trackId && item.startFrame < endFrame && item.endFrame > startFrame);
      if (overlaps(backgroundTrack.id) || overlaps(ambientTrack.id)) {
        throw new DomainError("目标范围已有可播放主画面或环境声；请明确选择空闲位置后再编译多机位主线", "MULTICAM_PROGRAM_TRACK_OVERLAP");
      }
      const scene = createScene({
        type: "VlogMontageScene",
        title: `${input.titlePrefix?.trim() || "多机位"}：${group.title}`,
        purpose: "在已验证同步基线上选择叙事机位，并固定使用一条主声音。",
        startFrame,
        endFrame,
        assetIds: [...new Set([...ordered.map((cut) => cut.angleAssetId), group.masterAudioAssetId])]
      });
      scene.status = "ready";
      scene.stylePackId = snapshot.project.stylePackId;
      snapshot.scenes.push(scene);
      let cursor = startFrame;
      for (const cut of ordered) {
        const duration = cut.sessionEndFrame - cut.sessionStartFrame;
        const videoItem = createTimelineItem({
          trackId: backgroundTrack.id,
          sceneId: scene.id,
          assetId: cut.angleAssetId,
          startFrame: cursor,
          endFrame: cursor + duration,
          sourceStartFrame: cut.sourceStartFrame,
          sourceEndFrame: cut.sourceEndFrame,
          gainDb: -96
        });
        snapshot.timeline.items.push(videoItem);
        const asset = assetById(snapshot, cut.angleAssetId);
        asset.role = "vlog_source";
        cut.sceneId = scene.id;
        cut.timelineItemId = videoItem.id;
        cut.status = "ready";
        cut.updatedAt = now();
        impact.changed.push(cut.id, videoItem.id, asset.id);
        cursor += duration;
      }
      const masterAudioItem = createTimelineItem({
        trackId: ambientTrack.id,
        sceneId: scene.id,
        assetId: masterAsset.id,
        startFrame,
        endFrame,
        sourceStartFrame: masterSourceStart,
        sourceEndFrame: masterSourceEnd,
        gainDb: 0
      });
      snapshot.timeline.items.push(masterAudioItem);
      group.sceneId = scene.id;
      group.masterAudioTimelineItemId = masterAudioItem.id;
      group.programStartFrame = startFrame;
      group.programEndFrame = endFrame;
      group.updatedAt = now();
      impact.changed.push(scene.id, masterAudioItem.id, group.id);
      this.staleAudioCuesForMainline(snapshot, impact, "多机位主线已重新编译");
      impact.recomputed.push("多机位 Background 切换、单一 Ambient 主声音与主线时长");
      impact.dirtyRanges.push({ startFrame, endFrame, reason: "编译多机位主线；需要连续预览检查口型、动作、视线与声音同步" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** Event Map 必须显式引用已分析 Shot；系统不根据文件名、镜头数量或技术评分猜测故事。 */
  manageVlogEvents(input: {
    projectId: Id;
    baseRevision: number;
    action: "create" | "update" | "remove";
    eventId?: Id;
    order?: number;
    title?: string;
    summary?: string;
    shotAnalysisIds?: Id[];
    goal?: string;
    actionNote?: string;
    change?: string;
    reaction?: string;
    outcome?: string;
    locationNote?: string;
    continuityNote?: string;
    status?: "draft" | "ready";
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, input.action === "create" ? "建立 Vlog 事件地图" : input.action === "update" ? "更新 Vlog 事件地图" : "移除 Vlog 事件", (snapshot, impact) => {
      const assertEventOrder = (order: number, ownId?: Id) => {
        if (!Number.isInteger(order) || order < 0) throw new DomainError("Vlog 事件顺序必须是非负整数", "INVALID_VLOG_EVENT_ORDER");
        if (snapshot.vlogEvents.some((event) => event.id !== ownId && event.order === order && event.status !== "stale")) {
          throw new DomainError("Vlog 事件顺序不能重复，请明确真实事件的先后关系", "DUPLICATE_VLOG_EVENT_ORDER");
        }
      };
      const assertShotIds = (shotIds: Id[], allowStale = false) => {
        const unique = [...new Set(shotIds)];
        if (!unique.length || unique.length !== shotIds.length) throw new DomainError("每个 Vlog 事件必须关联不重复的镜头分析", "VLOG_EVENT_SHOTS_REQUIRED");
        for (const shotId of unique) {
          const shot = vlogShotById(snapshot, shotId);
          if (!allowStale && shot.status !== "ready") throw new DomainError("Vlog 事件不能使用已过期的镜头分析，请重新检查素材", "VLOG_EVENT_SHOT_STALE");
        }
        return unique;
      };
      if (input.action === "remove") {
        const event = vlogEventById(snapshot, requireText(input.eventId, "Vlog 事件 ID"));
        if (snapshot.vlogShotSelects.some((select) => select.eventId === event.id)) {
          throw new DomainError("该 Vlog 事件仍被 Shot Select 引用；请先停止或重新归属这些镜头选择", "VLOG_EVENT_IN_USE");
        }
        snapshot.vlogEvents = snapshot.vlogEvents.filter((candidate) => candidate.id !== event.id);
        impact.changed.push(event.id);
        impact.stale.push(event.id);
        return;
      }
      if (input.action === "create") {
        if (input.order === undefined || input.shotAnalysisIds === undefined) throw new DomainError("创建 Vlog 事件必须提供顺序和镜头分析", "VLOG_EVENT_FIELDS_REQUIRED");
        assertEventOrder(input.order);
        const shotAnalysisIds = assertShotIds(input.shotAnalysisIds);
        const status = input.status ?? "ready";
        const event: VlogEvent = {
          id: createId("vlog_event"),
          order: input.order,
          title: requireText(input.title, "Vlog 事件标题"),
          summary: requireText(input.summary, "Vlog 事件说明"),
          shotAnalysisIds,
          goal: input.goal?.trim() || undefined,
          action: input.actionNote?.trim() || undefined,
          change: input.change?.trim() || undefined,
          reaction: input.reaction?.trim() || undefined,
          outcome: input.outcome?.trim() || undefined,
          locationNote: input.locationNote?.trim() || undefined,
          continuityNote: input.continuityNote?.trim() || undefined,
          status,
          createdAt: now(),
          updatedAt: now()
        };
        snapshot.vlogEvents.push(event);
        impact.changed.push(event.id);
        impact.recomputed.push("Vlog 事件地图");
        return;
      }
      const event = vlogEventById(snapshot, requireText(input.eventId, "Vlog 事件 ID"));
      const nextShotIds = input.shotAnalysisIds === undefined ? event.shotAnalysisIds : assertShotIds(input.shotAnalysisIds);
      for (const select of snapshot.vlogShotSelects.filter((candidate) => candidate.eventId === event.id)) {
        if (!nextShotIds.includes(select.shotAnalysisId)) {
          throw new DomainError("不能从已被 Shot Select 使用的事件中移除镜头；请先处理对应 Select", "VLOG_EVENT_SHOT_IN_USE");
        }
        this.markVlogShotSelectStale(snapshot, select, impact, "其事件地图已更新");
      }
      const nextOrder = input.order ?? event.order;
      assertEventOrder(nextOrder, event.id);
      const nextStatus = input.status ?? (event.status === "stale" ? "ready" : event.status);
      if (nextStatus === "ready") assertShotIds(nextShotIds);
      event.order = nextOrder;
      event.title = input.title === undefined ? event.title : requireText(input.title, "Vlog 事件标题");
      event.summary = input.summary === undefined ? event.summary : requireText(input.summary, "Vlog 事件说明");
      event.shotAnalysisIds = nextShotIds;
      if (input.goal !== undefined) event.goal = input.goal.trim() || undefined;
      if (input.actionNote !== undefined) event.action = input.actionNote.trim() || undefined;
      if (input.change !== undefined) event.change = input.change.trim() || undefined;
      if (input.reaction !== undefined) event.reaction = input.reaction.trim() || undefined;
      if (input.outcome !== undefined) event.outcome = input.outcome.trim() || undefined;
      if (input.locationNote !== undefined) event.locationNote = input.locationNote.trim() || undefined;
      if (input.continuityNote !== undefined) event.continuityNote = input.continuityNote.trim() || undefined;
      event.status = nextStatus;
      event.updatedAt = now();
      impact.changed.push(event.id);
      impact.recomputed.push("Vlog 事件地图与 Shot Select 复核");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** Shot Select 由导演明确给出用途与连续性理由，不能把“最高技术评分”当成自动入选。 */
  manageVlogShotSelects(input: {
    projectId: Id;
    baseRevision: number;
    action: "create" | "update" | "remove";
    shotSelectId?: Id;
    eventId?: Id;
    shotAnalysisId?: Id;
    order?: number;
    sourceStartFrame?: number;
    sourceEndFrame?: number;
    function?: VlogShotFunction;
    selectionReason?: string;
    continuityNote?: string;
    sourceAudioMode?: VlogSourceAudioMode;
    status?: "planned" | "ready";
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, input.action === "create" ? "建立 Vlog Shot Select" : input.action === "update" ? "调整 Vlog Shot Select" : "停止 Vlog Shot Select", (snapshot, impact) => {
      const assertSelection = (candidate: {
        eventId: Id;
        shotAnalysisId: Id;
        order: number;
        sourceStartFrame: number;
        sourceEndFrame: number;
        function: VlogShotFunction | undefined;
        selectionReason: string | undefined;
        continuityNote: string | undefined;
        sourceAudioMode: VlogSourceAudioMode | undefined;
        status: "planned" | "ready";
      }, ownId?: Id) => {
        const event = vlogEventById(snapshot, candidate.eventId);
        const shot = vlogShotById(snapshot, candidate.shotAnalysisId);
        if (!event.shotAnalysisIds.includes(shot.id)) throw new DomainError("Shot Select 的镜头必须属于指定 Vlog 事件", "VLOG_SELECT_EVENT_SHOT_MISMATCH");
        if (!Number.isInteger(candidate.order) || candidate.order < 0 || snapshot.vlogShotSelects.some((select) => select.id !== ownId && select.eventId === event.id && select.order === candidate.order && select.status !== "stale")) {
          throw new DomainError("同一 Vlog 事件内的 Shot Select 顺序必须是唯一非负整数", "INVALID_VLOG_SELECT_ORDER");
        }
        if (!Number.isInteger(candidate.sourceStartFrame) || !Number.isInteger(candidate.sourceEndFrame)
          || candidate.sourceStartFrame < shot.sourceStartFrame || candidate.sourceEndFrame > shot.sourceEndFrame || candidate.sourceEndFrame <= candidate.sourceStartFrame) {
          throw new DomainError("Shot Select 源范围必须完全落在已分析镜头内", "INVALID_VLOG_SELECT_RANGE");
        }
        const asset = assetById(snapshot, shot.assetId);
        if (asset.status !== "ready" || asset.kind !== "video" || !asset.metadata?.videoCodec) throw new DomainError("Shot Select 只能使用已就绪视频素材", "VLOG_SELECT_ASSET_NOT_READY");
        if (candidate.status === "ready" && (event.status !== "ready" || shot.status !== "ready")) {
          throw new DomainError("要启用 Shot Select，事件和镜头分析都必须是当前已就绪状态", "VLOG_SELECT_SOURCE_STALE");
        }
        const sourceAudioMode = normalizeVlogSourceAudioMode(candidate.sourceAudioMode);
        if (sourceAudioMode === "keep" && (!shot.hasAudio || !asset.metadata.hasAudio)) {
          throw new DomainError("没有真实音轨的镜头不能声明保留现场声", "VLOG_AMBIENT_SOURCE_MISSING");
        }
        return { event, shot, function: normalizeVlogFunction(candidate.function), sourceAudioMode };
      };
      if (input.action === "remove") {
        const select = vlogShotSelectById(snapshot, requireText(input.shotSelectId, "Vlog Shot Select ID"));
        this.markVlogShotSelectStale(snapshot, select, impact, "已被停止使用");
        return;
      }
      if (input.action === "create") {
        if (input.eventId === undefined || input.shotAnalysisId === undefined || input.order === undefined || input.sourceStartFrame === undefined || input.sourceEndFrame === undefined) {
          throw new DomainError("创建 Shot Select 必须提供事件、镜头、顺序和完整源范围", "VLOG_SELECT_FIELDS_REQUIRED");
        }
        const status = input.status ?? "ready";
        const checked = assertSelection({
          eventId: input.eventId,
          shotAnalysisId: input.shotAnalysisId,
          order: input.order,
          sourceStartFrame: input.sourceStartFrame,
          sourceEndFrame: input.sourceEndFrame,
          function: input.function,
          selectionReason: input.selectionReason,
          continuityNote: input.continuityNote,
          sourceAudioMode: input.sourceAudioMode,
          status
        });
        const select: VlogShotSelect = {
          id: createId("vlog_select"),
          eventId: checked.event.id,
          shotAnalysisId: checked.shot.id,
          order: input.order,
          sourceStartFrame: input.sourceStartFrame,
          sourceEndFrame: input.sourceEndFrame,
          function: checked.function,
          selectionReason: requireText(input.selectionReason, "Shot Select 入选理由"),
          continuityNote: requireText(input.continuityNote, "Shot Select 连续性说明"),
          sourceAudioMode: checked.sourceAudioMode,
          status,
          createdAt: now(),
          updatedAt: now()
        };
        snapshot.vlogShotSelects.push(select);
        impact.changed.push(select.id);
        impact.recomputed.push("Vlog Shot Select 与现场声策略");
        return;
      }
      const select = vlogShotSelectById(snapshot, requireText(input.shotSelectId, "Vlog Shot Select ID"));
      if (select.sceneId) this.markVlogShotSelectStale(snapshot, select, impact, "镜头选择已更新");
      const status = input.status ?? "ready";
      const candidate = {
        eventId: input.eventId ?? select.eventId,
        shotAnalysisId: input.shotAnalysisId ?? select.shotAnalysisId,
        order: input.order ?? select.order,
        sourceStartFrame: input.sourceStartFrame ?? select.sourceStartFrame,
        sourceEndFrame: input.sourceEndFrame ?? select.sourceEndFrame,
        function: input.function ?? select.function,
        selectionReason: input.selectionReason ?? select.selectionReason,
        continuityNote: input.continuityNote ?? select.continuityNote,
        sourceAudioMode: input.sourceAudioMode ?? select.sourceAudioMode,
        status
      };
      const checked = assertSelection(candidate, select.id);
      select.eventId = checked.event.id;
      select.shotAnalysisId = checked.shot.id;
      select.order = candidate.order;
      select.sourceStartFrame = candidate.sourceStartFrame;
      select.sourceEndFrame = candidate.sourceEndFrame;
      select.function = checked.function;
      select.selectionReason = requireText(candidate.selectionReason, "Shot Select 入选理由");
      select.continuityNote = requireText(candidate.continuityNote, "Shot Select 连续性说明");
      select.sourceAudioMode = checked.sourceAudioMode;
      select.status = status;
      select.updatedAt = now();
      impact.changed.push(select.id);
      impact.recomputed.push("Vlog Shot Select 与现场声策略");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 将已确认的 Shot Select 编译为统一 Timeline。第一版不变速、不自动卡点，也不按素材文件顺序猜故事；
   * 每个视频 Item 始终静音，选择保留的现场声在独立 Ambient 轨以同一源范围播放，避免重复输出。
   */
  compileVlogMontage(input: {
    projectId: Id;
    baseRevision: number;
    shotSelectIds: Id[];
    startFrame?: number;
    titlePrefix?: string;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "编译 Vlog Montage 主线", (snapshot, impact) => {
      if (snapshot.project.profile !== "vlog" && snapshot.project.profile !== "hybrid") {
        throw new DomainError("Vlog Montage 只能写入 Vlog 或以实拍事件为主的混合项目", "VLOG_PROFILE_REQUIRED");
      }
      const selectIds = [...new Set(input.shotSelectIds)];
      if (!selectIds.length || selectIds.length !== input.shotSelectIds.length) {
        throw new DomainError("编译 Vlog Montage 必须明确选择至少一个且不重复的 Shot Select", "VLOG_MONTAGE_SELECTS_REQUIRED");
      }
      const selects = selectIds.map((selectId) => vlogShotSelectById(snapshot, selectId));
      const eventById = new Map(snapshot.vlogEvents.map((event) => [event.id, event]));
      const shotById = new Map(snapshot.vlogShotAnalyses.map((shot) => [shot.id, shot]));
      for (const select of selects) {
        const event = eventById.get(select.eventId);
        const shot = shotById.get(select.shotAnalysisId);
        if (!event || event.status !== "ready" || !shot || shot.status !== "ready" || select.status === "stale") {
          throw new DomainError("Vlog Montage 只能使用当前已就绪的事件、镜头分析和 Shot Select", "VLOG_MONTAGE_SOURCE_STALE");
        }
        if (!event.shotAnalysisIds.includes(shot.id) || select.sourceStartFrame < shot.sourceStartFrame || select.sourceEndFrame > shot.sourceEndFrame) {
          throw new DomainError("Shot Select 已不属于其事件或超出镜头证据范围", "VLOG_MONTAGE_SELECT_INVALID");
        }
        const asset = assetById(snapshot, shot.assetId);
        if (asset.status !== "ready" || asset.kind !== "video" || !asset.metadata?.videoCodec) {
          throw new DomainError("Vlog Montage 引用的视频素材尚未就绪", "VLOG_MONTAGE_ASSET_NOT_READY");
        }
        if (select.sourceAudioMode === "keep" && (!shot.hasAudio || !asset.metadata.hasAudio)) {
          throw new DomainError("被要求保留现场声的 Vlog 镜头没有可播放音轨", "VLOG_AMBIENT_SOURCE_MISSING");
        }
      }
      const ordered = [...selects].sort((left, right) => {
        const eventDelta = eventById.get(left.eventId)!.order - eventById.get(right.eventId)!.order;
        return eventDelta || left.order - right.order || left.id.localeCompare(right.id);
      });
      const startFrame = input.startFrame ?? 0;
      if (!Number.isInteger(startFrame) || startFrame < 0) throw new DomainError("Vlog Montage 起点必须是非负整数帧", "INVALID_VLOG_MONTAGE_START");
      const backgroundTrack = trackByName(snapshot, "Background");
      const ambientTrack = trackByName(snapshot, "Ambient");
      if (backgroundTrack.locked || ambientTrack.locked) throw new DomainError("Background 或 Ambient 轨已锁定，不能编译 Vlog Montage", "TRACK_LOCKED");

      // 先停用本次重编涉及的旧场景；未选中的旧 Select 不会被静默删掉，仍保留为 stale 审计记录。
      const sceneIdsToStale = new Set(ordered.map((select) => select.sceneId).filter((sceneId): sceneId is Id => Boolean(sceneId)));
      for (const sceneId of sceneIdsToStale) this.markVlogMontageSceneStale(snapshot, sceneId, impact, "正在重新编译");

      const totalFrames = ordered.reduce((sum, select) => sum + (select.sourceEndFrame - select.sourceStartFrame), 0);
      const endFrame = startFrame + totalFrames;
      const overlaps = (trackId: Id) => snapshot.timeline.items.some((item) => !item.disabled && item.trackId === trackId && item.startFrame < endFrame && item.endFrame > startFrame);
      if (overlaps(backgroundTrack.id) || overlaps(ambientTrack.id)) {
        throw new DomainError("目标范围已有可播放的 Vlog 或环境声片段；请先选择空闲位置或通过明确编辑调整现有主线", "VLOG_MONTAGE_TRACK_OVERLAP");
      }

      const grouped = new Map<Id, VlogShotSelect[]>();
      for (const select of ordered) {
        const group = grouped.get(select.eventId) ?? [];
        group.push(select);
        grouped.set(select.eventId, group);
      }
      let cursor = startFrame;
      for (const [eventId, eventSelects] of [...grouped.entries()].sort((left, right) => eventById.get(left[0])!.order - eventById.get(right[0])!.order)) {
        const event = eventById.get(eventId)!;
        const sceneStart = cursor;
        const assetIds = [...new Set(eventSelects.map((select) => shotById.get(select.shotAnalysisId)!.assetId))];
        const scene = createScene({
          type: "VlogMontageScene",
          title: `${input.titlePrefix?.trim() || "Vlog"}：${event.title}`,
          purpose: event.summary,
          startFrame: sceneStart,
          endFrame: sceneStart + eventSelects.reduce((sum, select) => sum + (select.sourceEndFrame - select.sourceStartFrame), 0),
          assetIds
        });
        scene.status = "ready";
        scene.stylePackId = snapshot.project.stylePackId;
        snapshot.scenes.push(scene);
        impact.changed.push(scene.id);
        for (const select of eventSelects) {
          const shot = shotById.get(select.shotAnalysisId)!;
          const asset = assetById(snapshot, shot.assetId);
          const duration = select.sourceEndFrame - select.sourceStartFrame;
          // VideoLayer 的源声由 gainDb 控制；统一静音后才由独立 Ambient Item 决定何时保留现场感。
          const videoItem = createTimelineItem({
            trackId: backgroundTrack.id,
            sceneId: scene.id,
            assetId: asset.id,
            startFrame: cursor,
            endFrame: cursor + duration,
            sourceStartFrame: select.sourceStartFrame,
            sourceEndFrame: select.sourceEndFrame,
            gainDb: -96
          });
          snapshot.timeline.items.push(videoItem);
          asset.role = "vlog_source";
          select.sceneId = scene.id;
          select.timelineItemId = videoItem.id;
          select.ambientTimelineItemId = undefined;
          select.status = "ready";
          select.updatedAt = now();
          impact.changed.push(select.id, videoItem.id, asset.id);
          if (select.sourceAudioMode === "keep") {
            const ambientItem = createTimelineItem({
              trackId: ambientTrack.id,
              sceneId: scene.id,
              assetId: asset.id,
              startFrame: cursor,
              endFrame: cursor + duration,
              sourceStartFrame: select.sourceStartFrame,
              sourceEndFrame: select.sourceEndFrame,
              gainDb: 0
            });
            snapshot.timeline.items.push(ambientItem);
            snapshot.vlogAmbientCues.push({
              id: createId("vlog_ambient"),
              shotSelectId: select.id,
              assetId: asset.id,
              timelineItemId: ambientItem.id,
              purpose: `保留${select.function}镜头的真实现场声`,
              status: "ready",
              createdAt: now(),
              updatedAt: now()
            });
            select.ambientTimelineItemId = ambientItem.id;
            impact.changed.push(ambientItem.id);
          }
          cursor += duration;
        }
      }
      this.staleAudioCuesForMainline(snapshot, impact, "Vlog 主线已重新编译");
      impact.recomputed.push("VlogMontageScene、Background 主画面、Ambient 现场声与主线时长");
      impact.dirtyRanges.push({ startFrame, endFrame, reason: "编译 Vlog Montage；需要连续预览动作、空间和声音连续性" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 只记录已经由人试听确认的 BGM 拍点，供剪辑参考；不会自动移动镜头或声称完成音乐分析。 */
  manageVlogMusicBeats(input: {
    projectId: Id;
    baseRevision: number;
    action: "create" | "update" | "remove";
    beatId?: Id;
    audioCueId?: Id;
    frame?: number;
    note?: string;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, input.action === "create" ? "记录 Vlog 音乐拍点" : input.action === "update" ? "调整 Vlog 音乐拍点" : "移除 Vlog 音乐拍点", (snapshot, impact) => {
      const assertBeat = (audioCueId: Id, frame: number, ownId?: Id) => {
        const cue = snapshot.audioCues.find((candidate) => candidate.id === audioCueId);
        const item = cue ? snapshot.timeline.items.find((candidate) => candidate.id === cue.timelineItemId) : undefined;
        if (!cue || cue.kind !== "bgm" || cue.status !== "ready" || !item || item.disabled) {
          throw new DomainError("Vlog 拍点必须绑定当前已就绪的 BGM", "VLOG_BEAT_BGM_NOT_READY");
        }
        if (!Number.isInteger(frame) || frame < item.startFrame || frame >= item.endFrame) {
          throw new DomainError("Vlog 拍点必须落在 BGM 的实际播放范围内", "INVALID_VLOG_BEAT_FRAME");
        }
        if (snapshot.vlogMusicBeats.some((beat) => beat.id !== ownId && beat.audioCueId === cue.id && beat.frame === frame && beat.status === "ready")) {
          throw new DomainError("同一 BGM 的同一帧不能重复登记拍点", "DUPLICATE_VLOG_BEAT");
        }
        return cue;
      };
      if (input.action === "remove") {
        const beatId = requireText(input.beatId, "Vlog 拍点 ID");
        if (!snapshot.vlogMusicBeats.some((beat) => beat.id === beatId)) throw new NotFoundError("Vlog 音乐拍点不存在");
        snapshot.vlogMusicBeats = snapshot.vlogMusicBeats.filter((beat) => beat.id !== beatId);
        impact.changed.push(beatId);
        return;
      }
      if (input.action === "create") {
        if (!input.audioCueId || input.frame === undefined) throw new DomainError("记录 Vlog 拍点必须提供 BGM 和帧", "VLOG_BEAT_FIELDS_REQUIRED");
        const cue = assertBeat(input.audioCueId, input.frame);
        const beat: VlogMusicBeat = {
          id: createId("vlog_beat"),
          audioCueId: cue.id,
          frame: input.frame,
          note: requireText(input.note, "Vlog 拍点说明"),
          source: "manual_verified",
          status: "ready",
          createdAt: now()
        };
        snapshot.vlogMusicBeats.push(beat);
        impact.changed.push(beat.id);
        return;
      }
      const beat = snapshot.vlogMusicBeats.find((candidate) => candidate.id === requireText(input.beatId, "Vlog 拍点 ID"));
      if (!beat) throw new NotFoundError("Vlog 音乐拍点不存在");
      const cue = assertBeat(input.audioCueId ?? beat.audioCueId, input.frame ?? beat.frame, beat.id);
      beat.audioCueId = cue.id;
      beat.frame = input.frame ?? beat.frame;
      beat.note = input.note === undefined ? beat.note : requireText(input.note, "Vlog 拍点说明");
      beat.status = "ready";
      impact.changed.push(beat.id);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  submitTranscription(input: { projectId: Id; assetId: Id; idempotencyKey?: string }): JobRecord {
    const state = this.readProject(input.projectId);
    const asset = assetById(state.snapshot, input.assetId);
    if (asset.status !== "ready") throw new DomainError("素材尚未就绪，不能提交转写", "ASSET_NOT_READY");
    if (!asset.metadata?.hasAudio) throw new DomainError("该素材没有音频，这是成功分析结果，不能转写", "NO_AUDIO");
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "transcription",
      payload: { assetId: input.assetId },
      idempotencyKey: input.idempotencyKey ?? `transcription:${input.assetId}:${state.revision.number}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /**
   * 原声 Presenter 不经过 OmniVoice：提交一次完整 A-roll 的 Provider 段级字幕对齐。
   * Worker 将在同一 Revision 写入 Alignment、默认 Program 和一段一屏的 CaptionCard。
   */
  generateSourceAudioCaptions(input: { projectId: Id; baseRevision: number; timelineItemId: Id; idempotencyKey?: string }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) {
      throw new RevisionConflictError(input.baseRevision, state.revision.number);
    }
    const { item, asset } = sourceCaptionAlignmentTarget(state.snapshot, input.timelineItemId);
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "source_caption_alignment",
      payload: {
        requestedRevision: state.revision.number,
        assetId: asset.id,
        timelineItemId: item.id,
        sourceStartFrame: item.sourceStartFrame,
        sourceEndFrame: item.sourceEndFrame,
        timelineStartFrame: item.startFrame,
        timelineEndFrame: item.endFrame
      },
      idempotencyKey: input.idempotencyKey ?? `source_caption_alignment:${item.id}:${state.revision.number}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /** 复用真实音频对齐与分屏；自然 TTS 段、声音和 Scene 不参与字幕切分。 */
  generateSpeechCaptions(input: { projectId: Id; baseRevision: number; idempotencyKey?: string }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, state.revision.number);
    const speech = state.snapshot.speechAsset;
    if (!speech || speech.status !== "ready" || speech.scriptRevision !== state.snapshot.script.revision) {
      throw new DomainError("必须先完成当前 Script 的真实旁白组装，再生成字幕", "SPEECH_CAPTION_SOURCE_NOT_READY");
    }
    const item = currentDialogueItem(state.snapshot, speech);
    const speechSource = { speechAssetId: speech.id, scriptRevision: speech.scriptRevision, scriptText: expectedSpeechAlignmentText(state.snapshot, speech) };
    sourceCaptionAlignmentTarget(state.snapshot, item.id, speechSource);
    const job = this.repository.createJob({ projectId: input.projectId, kind: "source_caption_alignment", payload: {
      requestedRevision: state.revision.number, assetId: speech.assetId, timelineItemId: item.id,
      sourceStartFrame: item.sourceStartFrame, sourceEndFrame: item.sourceEndFrame,
      timelineStartFrame: item.startFrame, timelineEndFrame: item.endFrame, speechSource
    }, idempotencyKey: input.idempotencyKey ?? `speech_captions:${speech.id}:${state.revision.number}` });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /** 历史 VAD 入口只保留名称兼容；不能再创建 source_caption_generation Job。 */
  submitSourceAudioCaptions(_input: { projectId: Id; baseRevision: number; timelineItemId: Id; idempotencyKey?: string }): JobRecord {
    throw new DomainError("旧的 VAD 粗字幕链已停用；请使用 generateSourceAudioCaptions 生成 Provider 段级字幕", "SOURCE_CAPTION_LEGACY_JOB_DISABLED");
  }

  /** 旧 token-only 候选入口不再创建 Job，避免再次把正常字幕交给 Agent 手工分卡。 */
  submitSourceAudioTokenAlignment(_input: { projectId: Id; baseRevision: number; timelineItemId: Id; idempotencyKey?: string }): JobRecord {
    throw new DomainError("旧 token-only 字幕入口已停用；请使用 generateSourceAudioCaptions", "SOURCE_CAPTION_LEGACY_JOB_DISABLED");
  }

  /** 历史别名同样只读兼容，绝不创建 source_caption_sentence_alignment Job。 */
  submitSourceAudioSentenceAlignment(_input: { projectId: Id; baseRevision: number; timelineItemId: Id; idempotencyKey?: string }): JobRecord {
    throw new DomainError("旧句级对齐入口已停用；请使用 generateSourceAudioCaptions", "SOURCE_CAPTION_LEGACY_JOB_DISABLED");
  }

  /** Worker 仅在请求所见 Revision 仍完整保留原声 Item 时写入稳定字幕，避免结果覆盖后续剪辑。 */
  completeSourceAudioCaptions(input: {
    projectId: Id;
    requestedRevision: number;
    assetId: Id;
    timelineItemId: Id;
    sourceStartFrame: number;
    sourceEndFrame: number;
    timelineStartFrame: number;
    timelineEndFrame: number;
    chunks: Array<{ sourceStartFrame: number; sourceEndFrame: number; text: string; bridgeRunId: string }>;
  }): ProjectState {
    // 历史 Job 仍可从 SQLite 读取，但任何新运行都不能再把 VAD 块写回当前 Revision。
    throw new DomainError("旧 VAD chunk_coarse 字幕写入已停用；请重新执行 Provider 段级字幕 Job", "SOURCE_CAPTION_LEGACY_WRITE_DISABLED");
    if (input.chunks.length === 0) throw new DomainError("原声字幕没有得到可显示的语音分块", "SOURCE_CAPTION_NO_SPEECH");
    const current = this.readProject(input.projectId);
    if (current.revision.number !== input.requestedRevision) {
      // Worker 可能已完成 Revision 写入、却在写 Job 成功回执前中断。只有每个
      // 源范围、Run 和原文都完全相同才把它视为同一幂等完成，绝不覆盖后来人工改字。
      const existing = current.snapshot.timeline.captions
        .filter((caption) => caption.sourceKind === "source_audio" && caption.sourceTimelineItemId === input.timelineItemId);
      const alreadyWritten = existing.length === input.chunks.length && input.chunks.every((chunk) => {
        const sourceText = normalizeCaptionText(chunk.text, "原声字幕分块文案");
        return existing.some((caption) => caption.sourceAssetId === input.assetId
          && caption.sourceStartFrame === chunk.sourceStartFrame
          && caption.sourceEndFrame === chunk.sourceEndFrame
          && caption.sourceBridgeRunId === chunk.bridgeRunId
          && (caption.sourceText ?? caption.text) === sourceText);
      });
      if (alreadyWritten) return current;
    }
    const state = this.repository.commit(input.projectId, input.requestedRevision, "写入原声 A-roll 稳定字幕", (snapshot, impact) => {
      const item = snapshot.timeline.items.find((candidate) => candidate.id === input.timelineItemId);
      if (!item || item.disabled || item.assetId !== input.assetId
        || item.sourceStartFrame !== input.sourceStartFrame || item.sourceEndFrame !== input.sourceEndFrame
        || item.startFrame !== input.timelineStartFrame || item.endFrame !== input.timelineEndFrame) {
        throw new DomainError("A-roll 已在字幕生成期间改变；不能把旧分块写入当前 Timeline", "SOURCE_CAPTION_REVISION_STALE");
      }
      const performance = snapshot.actorPerformances.find((candidate) => candidate.timelineItemId === item.id);
      if (!performance || performance.status !== "ready" || performance.audioMode !== "use_source_audio") {
        throw new DomainError("A-roll 的声音所有权已变化；不能写入原声字幕", "SOURCE_CAPTION_AUDIO_MODE_STALE");
      }
      const sourceDuration = millisecondsToFrames(assetById(snapshot, input.assetId).metadata?.durationMs ?? 0, snapshot.timeline.fps);
      let previousEnd = input.sourceStartFrame;
      const nextCaptions: CaptionCard[] = input.chunks.map((chunk) => {
        if (!Number.isInteger(chunk.sourceStartFrame) || !Number.isInteger(chunk.sourceEndFrame)
          || chunk.sourceStartFrame < input.sourceStartFrame || chunk.sourceEndFrame <= chunk.sourceStartFrame
          || chunk.sourceEndFrame > input.sourceEndFrame || chunk.sourceEndFrame > sourceDuration
          || chunk.sourceStartFrame < previousEnd || !chunk.bridgeRunId.trim()) {
          throw new DomainError("原声字幕分块范围或 Bridge Run 审计无效", "SOURCE_CAPTION_CHUNK_INVALID");
        }
        previousEnd = chunk.sourceEndFrame;
        const startFrame = item.startFrame + (chunk.sourceStartFrame - item.sourceStartFrame);
        const endFrame = item.startFrame + (chunk.sourceEndFrame - item.sourceStartFrame);
        if (startFrame < item.startFrame || endFrame <= startFrame || endFrame > item.endFrame) {
          throw new DomainError("原声字幕无法安全映射到当前 Timeline", "SOURCE_CAPTION_TIME_MAPPING_INVALID");
        }
        const text = normalizeCaptionText(chunk.text, "原声字幕分块文案");
        return {
          id: createId("caption"),
          sourceKind: "source_audio",
          sourceAssetId: input.assetId,
          sourceTimelineItemId: item.id,
          sourceStartFrame: chunk.sourceStartFrame,
          sourceEndFrame: chunk.sourceEndFrame,
          sourceBridgeRunId: chunk.bridgeRunId,
          sourceText: text,
          text,
          textMode: "derived",
          startFrame,
          endFrame,
          style: "stable",
          format: { ...DEFAULT_CAPTION_FORMAT },
          precision: "chunk_coarse"
        };
      });
      const replaced = snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio" && caption.sourceTimelineItemId === item.id);
      snapshot.timeline.captions = snapshot.timeline.captions.filter((caption) => !(caption.sourceKind === "source_audio" && caption.sourceTimelineItemId === item.id));
      snapshot.timeline.captions.push(...nextCaptions);
      impact.changed.push(...nextCaptions.map((caption) => caption.id), ...replaced.map((caption) => caption.id));
      impact.recomputed.push("原声 A-roll 静音边界分块字幕（chunk_coarse）");
      impact.dirtyRanges.push({ startFrame: item.startFrame, endFrame: item.endFrame, reason: "写入原声稳定字幕" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * FunASR 段级对齐完成后，在同一 Repository Commit 保存证据、默认 Program 与一段一屏的
   * CaptionCard。正常流程不需要 Agent 再提交 Program，也不会产生中间半成品 Revision。
   */
  completeSourceAudioCaptionAlignment(input: {
    projectId: Id;
    speechSource?: SourceAudioAlignment["speechSource"];
    requestedRevision: number;
    assetId: Id;
    timelineItemId: Id;
    sourceStartFrame: number;
    sourceEndFrame: number;
    timelineStartFrame: number;
    timelineEndFrame: number;
    transcriptText: string;
    bridgeAudit: BridgeRunAudit;
    tokenPrecision?: SourceAudioAlignmentTokenPrecision;
    tokens?: SourceCaptionAlignmentTokenInput[];
    segments: SourceCaptionAlignmentSegmentInput[];
  }): ProjectState {
    if (!input.bridgeAudit?.runId?.trim() || !input.bridgeAudit.workflowId?.trim() || !input.bridgeAudit.completedAt) {
      throw new DomainError("FunASR 原声字幕对齐缺少已完成的 Bridge 审计", "SOURCE_CAPTION_ALIGNMENT_AUDIT_INVALID");
    }
    const current = this.readProject(input.projectId);
    const currentItem = current.snapshot.timeline.items.find((candidate) => candidate.id === input.timelineItemId);
    if (!currentItem || currentItem.assetId !== input.assetId) {
      throw new DomainError("原声字幕对齐目标 A-roll 已不存在或已更换素材", "SOURCE_CAPTION_ALIGNMENT_REVISION_STALE");
    }
    const currentDurationMs = Math.ceil(((input.sourceEndFrame - input.sourceStartFrame) / current.snapshot.timeline.fps) * 1000);
    const evidence = validateSourceAudioCaptionAlignmentEvidence({
      transcriptText: input.transcriptText,
      tokenPrecision: input.tokenPrecision,
      tokens: input.tokens,
      segments: input.segments,
      durationMs: currentDurationMs
    });
    if (current.revision.number !== input.requestedRevision) {
      // Worker 在写入 Revision 后、写 Job 成功回执前中断时，只接受同一 Run、同一段级证据和
      // 已完整自动编译的默认 Program；绝不创建第二份 Caption。
      const existing = current.snapshot.sourceAudioAlignments.find((candidate) => candidate.sourceTimelineItemId === input.timelineItemId
        && candidate.sourceAssetId === input.assetId && candidate.bridgeAudit.runId === input.bridgeAudit.runId && candidate.status === "ready");
      if (existing && existing.transcriptText === input.transcriptText
        && JSON.stringify(existing.speechSource) === JSON.stringify(input.speechSource)
        && existing.requestedRevision === input.requestedRevision
        && existing.sourceStartFrame === input.sourceStartFrame && existing.sourceEndFrame === input.sourceEndFrame
        && existing.timelineStartFrame === input.timelineStartFrame && existing.timelineEndFrame === input.timelineEndFrame
        && existing.tokenPrecision === evidence.tokenPrecision
        && JSON.stringify(existing.tokens) === JSON.stringify(evidence.tokens)
        && JSON.stringify(existing.segments) === JSON.stringify(evidence.segments)
        && current.snapshot.sourceCaptionPrograms.some((program) => program.alignmentId === existing.id && program.source === "provider_segments")) return current;
    }

    const state = this.repository.commit(input.projectId, input.requestedRevision, "写入原声 A-roll 段级字幕与同源对齐证据", (snapshot, impact) => {
      const target = sourceCaptionAlignmentTarget(snapshot, input.timelineItemId, input.speechSource);
      const { item, asset } = target;
      if (asset.id !== input.assetId || item.sourceStartFrame !== input.sourceStartFrame || item.sourceEndFrame !== input.sourceEndFrame
        || item.startFrame !== input.timelineStartFrame || item.endFrame !== input.timelineEndFrame) {
        throw new DomainError("A-roll 已在字幕对齐期间改变；不能覆盖当前字幕", "SOURCE_CAPTION_ALIGNMENT_REVISION_STALE");
      }
      const alignmentDurationMs = Math.ceil(((item.sourceEndFrame - item.sourceStartFrame) / snapshot.timeline.fps) * 1000);
      const checkedEvidence = validateSourceAudioCaptionAlignmentEvidence({
        transcriptText: input.transcriptText,
        tokenPrecision: input.tokenPrecision,
        tokens: input.tokens,
        segments: input.segments,
        durationMs: alignmentDurationMs
      });
      const replacedAlignments = snapshot.sourceAudioAlignments.filter((alignment) => alignment.sourceTimelineItemId === item.id);
      const replacedPrograms = snapshot.sourceCaptionPrograms.filter((program) => program.sourceTimelineItemId === item.id);
      const alignment: SourceAudioAlignment = {
        id: createId("source_alignment"),
        ...(input.speechSource ? { speechSource: structuredClone(input.speechSource) } : {}),
        sourceAssetId: asset.id,
        sourceAssetHash: asset.sourceHash,
        sourceTimelineItemId: item.id,
        sourceStartFrame: item.sourceStartFrame,
        sourceEndFrame: item.sourceEndFrame,
        timelineStartFrame: item.startFrame,
        timelineEndFrame: item.endFrame,
        requestedRevision: input.requestedRevision,
        transcriptText: requireText(input.transcriptText, "FunASR 对齐全文"),
        tokenPrecision: checkedEvidence.tokenPrecision,
        tokens: checkedEvidence.tokens,
        segments: checkedEvidence.segments,
        // 只为读取旧快照保留这些候选句字段；v4 的正式字幕段不走旧候选链。
        sentenceCandidateMode: "none",
        sentences: [],
        bridgeAudit: input.bridgeAudit,
        status: "ready",
        createdAt: now()
      };
      const compiled = compileProviderSourceCaptionProgram({ snapshot, item, asset, alignment });
      // 同一事务替换旧的整段默认卡，避免旁白段字幕与 ASR 分屏同时出现。
      const replacedSpeechCaptions = input.speechSource ? snapshot.timeline.captions.filter(caption => caption.sourceKind !== "source_audio") : [];
      if (replacedSpeechCaptions.length > 0) {
        const sharedFormat = replacedSpeechCaptions[0]!.format;
        if (replacedSpeechCaptions.every(caption => JSON.stringify(caption.format) === JSON.stringify(sharedFormat))) {
          for (const caption of compiled.captions) caption.format = structuredClone(sharedFormat ?? DEFAULT_CAPTION_FORMAT);
        }
        snapshot.timeline.captions = snapshot.timeline.captions.filter(caption => caption.sourceKind === "source_audio");
      }
      const replaceableCoarseCaptions = snapshot.timeline.captions
        .filter((caption) => caption.sourceKind === "source_audio" && caption.sourceTimelineItemId === item.id)
        .sort((left, right) => (left.sourceStartFrame ?? 0) - (right.sourceStartFrame ?? 0));
      for (const caption of replaceableCoarseCaptions) {
        assertCurrentSourceAudioCaption(snapshot, caption);
        if (caption.sourceAssetId !== asset.id || !isReplaceableSourceCaptionCoarse(caption)) {
          throw new DomainError("当前 A-roll 的原声字幕不是可原子替换的历史 chunk_coarse；不能覆盖人工或已审片字幕", "SOURCE_CAPTION_PROGRAM_CAPTION_CONFLICT");
        }
      }
      snapshot.sourceAudioAlignments = snapshot.sourceAudioAlignments.filter((candidate) => candidate.sourceTimelineItemId !== item.id);
      snapshot.sourceCaptionPrograms = snapshot.sourceCaptionPrograms.filter((candidate) => candidate.sourceTimelineItemId !== item.id);
      snapshot.timeline.captions = snapshot.timeline.captions.filter((caption) => !replaceableCoarseCaptions.some((coarse) => coarse.id === caption.id));
      snapshot.sourceAudioAlignments.push(alignment);
      snapshot.sourceCaptionPrograms.push(compiled.program);
      snapshot.timeline.captions.push(...compiled.captions);
      impact.changed.push(
        alignment.id,
        compiled.program.id,
        ...compiled.captions.map((caption) => caption.id),
        ...replacedAlignments.map((candidate) => candidate.id),
        ...replacedPrograms.map((candidate) => candidate.id),
        ...replaceableCoarseCaptions.map((caption) => caption.id),
        ...replacedSpeechCaptions.map(caption => caption.id)
      );
      impact.stale.push(...replacedAlignments.map((candidate) => candidate.id), ...replacedPrograms.map((candidate) => candidate.id));
      impact.recomputed.push("FunASR Provider 段级原声字幕（一个 segment 对应一屏）");
      impact.dirtyRanges.push({ startFrame: item.startFrame, endFrame: item.endFrame, reason: "写入 Provider 段级原声字幕" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 读取可供 semantic-continuity 审查的原声 token 对齐证据；它不执行任何编辑写入。 */
  readSourceAudioAlignment(input: { projectId: Id; alignmentId?: Id; timelineItemId?: Id }): SourceAudioAlignment[] {
    const alignments = this.readProject(input.projectId).snapshot.sourceAudioAlignments.filter((alignment) => (
      (input.alignmentId === undefined || alignment.id === input.alignmentId)
      && (input.timelineItemId === undefined || alignment.sourceTimelineItemId === input.timelineItemId)
    ));
    if (input.alignmentId && alignments.length !== 1) throw new NotFoundError("原声 token 对齐证据不存在");
    return structuredClone(alignments);
  }

  /**
   * 仅用于 Provider 段 overflow、错分段或经回听确认的修正。它以同一 Alignment 的 token 时间
   * 原子替换现有默认 Program，不重跑 ASR，也不能手填毫秒、删词、补词或伪造时间。
   */
  applySourceCaptionProgram(input: {
    projectId: Id;
    baseRevision: number;
    alignmentId: Id;
    cards: Array<{ tokenStartIndex: number; tokenEndIndex: number; displayText?: string; rationale: string }>;
  }): ProjectState {
    if (!Array.isArray(input.cards) || input.cards.length === 0 || input.cards.length > 300) {
      throw new DomainError("原声字幕 Program 必须包含 1 到 300 张语义卡", "SOURCE_CAPTION_PROGRAM_CARDS_INVALID");
    }
    const state = this.repository.commit(input.projectId, input.baseRevision, "原子替换原声字幕编辑覆盖 Program", (snapshot, impact) => {
      const alignment = snapshot.sourceAudioAlignments.find((candidate) => candidate.id === input.alignmentId);
      if (!alignment || alignment.status !== "ready") throw new DomainError("原声 token 对齐证据不存在或已过期", "SOURCE_CAPTION_ALIGNMENT_NOT_READY");
      const tokens = alignment.tokens;
      if (alignment.tokenPrecision !== "provider_token_timed" || !tokens?.length) {
        throw new DomainError(
          "当前 Provider 只有段级真实时间，不能安全重新分段；请保留 Provider 分段或取得完整 token 对齐。",
          "SOURCE_CAPTION_PROGRAM_TOKEN_EVIDENCE_UNAVAILABLE"
        );
      }
      const item = snapshot.timeline.items.find((candidate) => candidate.id === alignment.sourceTimelineItemId);
      const asset = snapshot.assets.find((candidate) => candidate.id === alignment.sourceAssetId);
      if (!item || !asset || item.disabled || item.assetId !== alignment.sourceAssetId
        || item.sourceStartFrame !== alignment.sourceStartFrame || item.sourceEndFrame !== alignment.sourceEndFrame
        || item.startFrame !== alignment.timelineStartFrame || item.endFrame !== alignment.timelineEndFrame
        || asset.sourceHash !== alignment.sourceAssetHash) {
        throw new DomainError("原声 token 对齐绑定的 A-roll 或素材哈希已变化；请重新对齐", "SOURCE_CAPTION_ALIGNMENT_STALE");
      }
      const existingPrograms = snapshot.sourceCaptionPrograms.filter((candidate) => candidate.sourceTimelineItemId === item.id);
      if (existingPrograms.length > 1 || (existingPrograms[0] && existingPrograms[0].alignmentId !== alignment.id)) {
        throw new DomainError("当前 A-roll 有不属于本次对齐的字幕 Program；不能猜测应覆盖哪一份", "SOURCE_CAPTION_PROGRAM_CONFLICT");
      }
      const existingProgram = existingPrograms[0];
      const replaceableCaptions = snapshot.timeline.captions
        .filter((caption) => caption.sourceKind === "source_audio" && caption.sourceTimelineItemId === item.id)
        .sort((left, right) => (left.sourceStartFrame ?? 0) - (right.sourceStartFrame ?? 0));
      if (replaceableCaptions.some(caption => caption.sourceTextReview)) {
        throw new DomainError("字幕已有回听纠错，重新分屏会丢失纠错；请先明确 reset 这些卡，再分屏并复核文案", "SOURCE_CAPTION_REVIEW_RESEGMENT_CONFLICT");
      }
      for (const caption of replaceableCaptions) {
        assertCurrentSourceAudioCaption(snapshot, caption);
        const belongsToExistingProgram = Boolean(existingProgram
          && caption.sourceCaptionProgramId === existingProgram.id
          && caption.sourceAlignmentId === alignment.id
          && existingProgram.captionIds.includes(caption.id));
        if (caption.sourceAssetId !== asset.id || (!isReplaceableSourceCaptionCoarse(caption) && !belongsToExistingProgram)) {
          throw new DomainError(
            "当前 A-roll 的原声字幕不是可原子替换的默认 Program 或历史 chunk_coarse；不能混入人工或别的 Program 卡。",
            "SOURCE_CAPTION_PROGRAM_CAPTION_CONFLICT"
          );
        }
      }
      const programId = createId("source_caption_program");
      let expectedTokenStart = 0;
      let previousSourceEndFrame = item.sourceStartFrame;
      const captions: CaptionCard[] = input.cards.map((plan, index) => {
        if (!Number.isInteger(plan.tokenStartIndex) || !Number.isInteger(plan.tokenEndIndex)
          || plan.tokenStartIndex !== expectedTokenStart || plan.tokenEndIndex <= plan.tokenStartIndex || plan.tokenEndIndex > tokens.length) {
          throw new DomainError("原声字幕 Program 的 token 范围必须连续、无重叠且完整覆盖", "SOURCE_CAPTION_PROGRAM_TOKEN_RANGE_INVALID");
        }
        const sourceTokens = tokens.slice(plan.tokenStartIndex, plan.tokenEndIndex);
        const sourceText = normalizeCaptionText(joinSourceAudioTokens(sourceTokens), `第 ${index + 1} 张原声字幕来源文案`);
        const displayText = plan.displayText === undefined ? sourceText : normalizeCaptionText(plan.displayText, `第 ${index + 1} 张原声字幕屏幕文案`);
        if (normalizeCaptionComparisonText(displayText) !== normalizeCaptionComparisonText(sourceText)) {
          throw new DomainError("语义字幕 Program 不能增删或改写原声实义词；更正 ASR 必须先做真实 source-audio 强制对齐", "SOURCE_CAPTION_PROGRAM_TEXT_MISMATCH");
        }
        const rationale = requireText(plan.rationale, `第 ${index + 1} 张原声字幕的语义理由`);
        if (rationale.length > 240) throw new DomainError("原声字幕语义理由不能超过 240 个字符", "SOURCE_CAPTION_PROGRAM_RATIONALE_INVALID");
        const first = sourceTokens[0]!;
        const last = sourceTokens[sourceTokens.length - 1]!;
        const sourceStartFrame = sourceAudioTimeOrigin(alignment) + millisecondsToFrames(first.startMs, snapshot.timeline.fps);
        const sourceEndFrame = sourceAudioTimeOrigin(alignment) + millisecondsToFrames(last.endMs, snapshot.timeline.fps);
        const startFrame = item.startFrame + (sourceStartFrame - item.sourceStartFrame);
        const endFrame = item.startFrame + (sourceEndFrame - item.sourceStartFrame);
        if (sourceStartFrame < previousSourceEndFrame || sourceEndFrame <= sourceStartFrame
          || sourceStartFrame < item.sourceStartFrame || sourceEndFrame > item.sourceEndFrame
          || startFrame < item.startFrame || endFrame <= startFrame || endFrame > item.endFrame) {
          throw new DomainError("原声字幕 Program 的 token 边界无法安全映射到当前 Timeline", "SOURCE_CAPTION_PROGRAM_TIME_MAPPING_INVALID");
        }
        expectedTokenStart = plan.tokenEndIndex;
        previousSourceEndFrame = sourceEndFrame;
        return {
          id: createId("caption"),
          sourceKind: "source_audio",
          sourceAssetId: asset.id,
          sourceTimelineItemId: item.id,
          sourceStartFrame,
          sourceEndFrame,
          sourceBridgeRunId: alignment.bridgeAudit.runId,
          sourceAlignmentId: alignment.id,
          sourceCaptionProgramId: programId,
          sourceTokenStartIndex: plan.tokenStartIndex,
          sourceTokenEndIndex: plan.tokenEndIndex,
          sourceCaptionRationale: rationale,
          sourceText,
          text: displayText,
          textMode: displayText === sourceText ? "derived" : "manual",
          startFrame,
          endFrame,
          style: "stable",
          format: { ...DEFAULT_CAPTION_FORMAT },
          precision: "source_token_anchored"
        };
      });
      if (expectedTokenStart !== tokens.length) {
        throw new DomainError("原声字幕 Program 漏掉了已对齐的 spoken token，不能静默省略", "SOURCE_CAPTION_PROGRAM_TOKEN_COVERAGE_INVALID");
      }
      const program: SourceCaptionProgram = {
        id: programId,
        alignmentId: alignment.id,
        sourceAssetId: asset.id,
        sourceTimelineItemId: item.id,
        captionIds: captions.map((caption) => caption.id),
        source: "editorial_override",
        createdAt: now()
      };
      const replacementCaptionIds = new Set(replaceableCaptions.map((caption) => caption.id));
      snapshot.timeline.captions = snapshot.timeline.captions.filter((caption) => !replacementCaptionIds.has(caption.id));
      snapshot.timeline.captions.push(...captions);
      if (existingProgram) {
        snapshot.sourceCaptionPrograms = snapshot.sourceCaptionPrograms.filter((program) => program.id !== existingProgram.id);
      }
      snapshot.sourceCaptionPrograms.push(program);
      impact.changed.push(
        program.id,
        ...captions.map((caption) => caption.id),
        ...replaceableCaptions.map((caption) => caption.id),
        ...(existingProgram ? [existingProgram.id] : [])
      );
      if (existingProgram) impact.stale.push(existingProgram.id, ...replaceableCaptions.map((caption) => caption.id));
      impact.recomputed.push("原声 A-roll 编辑覆盖字幕 Program（source_token_anchored）");
      impact.dirtyRanges.push({ startFrame: item.startFrame, endFrame: item.endFrame, reason: "原子替换原声字幕编辑覆盖 Program" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  applyTranscript(input: { projectId: Id; baseRevision?: number; assetId: Id; text: string; bridgeRunId?: string; schemaVersion?: string; bridgeAudit?: BridgeRunAudit; source?: "funasr" | "manual" }): ProjectState {
    const current = this.readProject(input.projectId);
    const state = this.repository.commit(input.projectId, input.baseRevision ?? current.revision.number, "写入转写候选", (snapshot, impact) => {
      assetById(snapshot, input.assetId);
      const oldTranscriptIds = new Set(snapshot.transcripts.filter((transcript) => transcript.assetId === input.assetId).map((transcript) => transcript.id));
      snapshot.transcripts = snapshot.transcripts.filter((transcript) => transcript.assetId !== input.assetId);
      snapshot.transcriptSentenceCandidates = snapshot.transcriptSentenceCandidates.filter((candidate) => !oldTranscriptIds.has(candidate.transcriptId));
      snapshot.semanticUnits = snapshot.semanticUnits.filter((unit) => !unit.transcriptId || !oldTranscriptIds.has(unit.transcriptId));
      const transcript = {
        id: createId("transcript"),
        assetId: input.assetId,
        text: input.text.trim(),
        source: input.source ?? "funasr",
        bridgeRunId: input.bridgeRunId,
        schemaVersion: input.schemaVersion,
        bridgeAudit: input.bridgeAudit,
        createdAt: now()
      } as const;
      snapshot.transcripts.push(transcript);
      snapshot.transcriptSentenceCandidates.push(...createTranscriptSentenceCandidates(transcript.id, input.assetId, transcript.text));
      // 已失效语义单元不能继续被 Story 误引用；Skill 会在候选基础上重新给出完整判断。
      const activeSemanticUnitIds = new Set(snapshot.semanticUnits.map((unit) => unit.id));
      for (const beat of snapshot.story.beats) {
        beat.semanticUnitIds = beat.semanticUnitIds.filter((id) => activeSemanticUnitIds.has(id));
      }
      this.reconcileScript(snapshot, impact);
      impact.changed.push(transcript.id);
      impact.recomputed.push("TranscriptSentenceCandidate、等待 SemanticUnit 判断、Script、SpeechSegment");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  private reconcileScript(snapshot: ProjectSnapshot, impact: ImpactReport): void {
    // Script 改动会使旧旁白与字幕失效；同时移除 Dialogue 上的系统 SpeechAsset，
    // 防止观众继续听到已经不属于当前 Script 的旧语音。
    const dialogueTrack = snapshot.timeline.tracks.find((track) => track.name === "Dialogue");
    const obsoleteSpeechAssetIds = new Set([
      snapshot.speechAsset?.assetId,
      ...snapshot.speechSegmentAssets.map((segmentAsset) => segmentAsset.assetId)
    ].filter((assetId): assetId is string => Boolean(assetId)));
    if (dialogueTrack && obsoleteSpeechAssetIds.size > 0) {
      const removed = snapshot.timeline.items.filter((item) => item.trackId === dialogueTrack.id && obsoleteSpeechAssetIds.has(item.assetId));
      snapshot.timeline.items = snapshot.timeline.items.filter((item) => !removed.includes(item));
      if (removed.length > 0) {
        impact.changed.push(...removed.map((item) => item.id));
        impact.recomputed.push("移除失效 Dialogue 旁白");
      }
    }
    const oldSegments = snapshot.speechSegments;
    const oldByIdentity = new Map(oldSegments.map((segment) => [`${segment.semanticUnitIds.join("|")}::${segment.text}`, segment]));
    const compiled = compileSpeechSegments(snapshot.semanticUnits).map((segment) => {
      const old = oldByIdentity.get(`${segment.semanticUnitIds.join("|")}::${segment.text}`);
      // 同一句的音频可复用；但停顿来自最新语义判断，必须覆盖旧的节奏参数。
      return old ? { ...segment, id: old.id, status: old.status } : segment;
    });
    const currentIds = new Set(compiled.map((segment) => segment.id));
    for (const oldSegment of oldSegments) {
      if (!currentIds.has(oldSegment.id)) {
        impact.stale.push(oldSegment.id);
      }
    }
    snapshot.speechSegments = compiled;
    snapshot.script = {
      semanticUnitIds: snapshot.semanticUnits.filter((unit) => unit.status === "included").sort((left, right) => left.order - right.order).map((unit) => unit.id),
      speechSegmentIds: compiled.map((segment) => segment.id),
      revision: snapshot.script.revision + 1
    };
    snapshot.speechSegmentAssets = snapshot.speechSegmentAssets.filter((segmentAsset) => currentIds.has(segmentAsset.speechSegmentId));
    // 历史 Revision 仍保留旧对齐审计；当前 Script 已改变时不能把旧词级时间戳留在当前图中。
    markSpeechAlignmentStale(snapshot, impact, "Script 已重新编译");
    snapshot.speechAlignment = undefined;
    snapshot.speechAsset = undefined;
    const speechAssetCaptions = snapshot.timeline.captions.filter((caption) => caption.sourceKind !== "source_audio");
    if (speechAssetCaptions.length > 0) {
      // 不能静默沿用旧语音的 Card；下一次 SpeechAsset 组装会以最新段级时序重建字幕。
      // 原声字幕由 A-roll 的真实源范围驱动，不能因 Script 文字重排被误删。
      impact.stale.push(...speechAssetCaptions.map((caption) => caption.id));
      impact.recomputed.push("失效 Caption Program");
    }
    snapshot.timeline.captions = snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio");
    for (const performance of snapshot.actorPerformances) {
      if (performance.source === "generated" && performance.scriptRevision !== snapshot.script.revision) {
        performance.status = "stale";
        impact.stale.push(performance.id);
      }
    }
    for (const cue of snapshot.effectCues) {
      const semanticAnchorTarget = cue.semanticAnchor?.type === "speech_segment" ? cue.semanticAnchor.targetId : undefined;
      const legacyAnchorTarget = cue.semanticAnchor ? undefined : cue.anchorTargetId;
      if ((legacyAnchorTarget && !currentIds.has(legacyAnchorTarget)) || (semanticAnchorTarget && !currentIds.has(semanticAnchorTarget))) {
        cue.status = "stale";
        impact.stale.push(cue.id);
      }
    }
    // 音乐长度、Duck 与音效事件都依赖主声音；Script 变化后不能悄悄沿用旧包装。
    this.staleAudioCuesForMainline(snapshot, impact, "Script 或主声音结构已变化");
  }

  /**
   * 将标点候选升级为经 semantic-continuity 审阅的 SemanticUnit。
   * 这一步才允许生成 Script / SpeechSegment，避免把标点边界误称为语义边界。
   */
  applySemanticUnits(input: {
    projectId: Id;
    baseRevision: number;
    units: Array<{
      candidateIds: Id[];
      text: string;
      kind: SemanticUnitKind;
      dependencies?: Id[];
      precedingContext?: string;
      followingContext?: string;
      retakeGroupId?: Id;
      confidence?: number;
      pauseBefore?: { durationMs: number; reason: "sentence" | "contrast" | "emotion" | "breath" | "chapter" };
    }>;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "应用语义单元判断", (snapshot, impact) => {
      const candidatesById = new Map(snapshot.transcriptSentenceCandidates.map((candidate) => [candidate.id, candidate]));
      const oldByIdentity = new Map(snapshot.semanticUnits.map((unit) => [`${unit.candidateIds.join("|")}::${unit.text}`, unit]));
      const nextUnits = input.units.map((draft, order) => {
        if (draft.candidateIds.length === 0) throw new DomainError("SemanticUnit 必须包含转写候选", "SEMANTIC_CANDIDATE_REQUIRED");
        const candidates = draft.candidateIds.map((candidateId) => {
          const candidate = candidatesById.get(candidateId);
          if (!candidate) throw new DomainError(`转写候选不存在：${candidateId}`, "SENTENCE_CANDIDATE_NOT_FOUND");
          return candidate;
        });
        const transcriptId = candidates[0]!.transcriptId;
        const sourceAssetId = candidates[0]!.sourceAssetId;
        if (candidates.some((candidate) => candidate.transcriptId !== transcriptId || candidate.sourceAssetId !== sourceAssetId)) {
          throw new DomainError("一个 SemanticUnit 只能组合来自同一转写素材的候选", "SEMANTIC_CANDIDATE_SOURCE_MISMATCH");
        }
        const unit = createSemanticUnit({
          transcriptId,
          sourceAssetId,
          candidateIds: draft.candidateIds,
          text: draft.text,
          order,
          kind: draft.kind,
          dependencies: draft.dependencies,
          precedingContext: draft.precedingContext,
          followingContext: draft.followingContext,
          retakeGroupId: draft.retakeGroupId,
          confidence: draft.confidence,
          pauseBefore: draft.pauseBefore
        });
        const old = oldByIdentity.get(`${unit.candidateIds.join("|")}::${unit.text}`);
        return old ? { ...unit, id: old.id, status: old.status } : unit;
      });
      this.replaceSemanticUnits(snapshot, impact, nextUnits);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 原创新稿以人工确认的完整思想入稿，不借用音色样本制造转写或估算时序。 */
  applyAuthoredScript(input: {
    projectId: Id;
    baseRevision: number;
    sourceNote: string;
    units: Array<Omit<Parameters<EditingApplication["applySemanticUnits"]>[0]["units"][number], "candidateIds">>;
  }): ProjectState {
    if (!input.sourceNote.trim() || input.sourceNote.length > 2_000 || input.units.length === 0 || input.units.length > 200) {
      throw new DomainError("原稿需包含来源说明和 1 至 200 个完整语义段", "INVALID_AUTHORED_SCRIPT");
    }
    const state = this.repository.commit(input.projectId, input.baseRevision, "应用原创新稿", (snapshot, impact) => {
      const available = snapshot.semanticUnits.filter((unit) => unit.sourceKind === "authored");
      const nextUnits = input.units.map((draft, order) => {
        if (draft.text.length > 2_000) throw new DomainError("单个原创语义段不能超过 2000 字符", "INVALID_AUTHORED_SCRIPT");
        const unit = createSemanticUnit({ ...draft, sourceKind: "authored", sourceNote: input.sourceNote, transcriptId: undefined, sourceAssetId: undefined, candidateIds: [], order });
        // 相同句子仍可能有意重复；一对一复用身份，不把两处重复合成同一个 ID。
        const oldIndex = available.findIndex((old) => old.text === unit.text);
        const old = oldIndex < 0 ? undefined : available.splice(oldIndex, 1)[0];
        return old ? { ...unit, id: old.id } : unit;
      });
      this.replaceSemanticUnits(snapshot, impact, nextUnits);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  private replaceSemanticUnits(snapshot: ProjectSnapshot, impact: ImpactReport, nextUnits: SemanticUnit[]): void {
    const nextIds = new Set(nextUnits.map((unit) => unit.id));
    const oldIds = new Set(snapshot.semanticUnits.map((unit) => unit.id));
    snapshot.semanticUnits = nextUnits;
    for (const beat of snapshot.story.beats) beat.semanticUnitIds = beat.semanticUnitIds.filter((id) => nextIds.has(id));
    for (const oldId of oldIds) if (!nextIds.has(oldId)) impact.stale.push(oldId);
    impact.changed.push(...nextUnits.map((unit) => unit.id));
    this.reconcileScript(snapshot, impact);
    impact.recomputed.push("SemanticUnit、Script、SpeechSegment、语义锚点");
  }

  applyScript(input: { projectId: Id; baseRevision: number; semanticUnitIds: Id[] }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "更新最终 Script", (snapshot, impact) => {
      const wanted = new Set(input.semanticUnitIds);
      for (const unit of snapshot.semanticUnits) unit.status = wanted.has(unit.id) ? "included" : "deleted";
      input.semanticUnitIds.forEach((unitId, index) => {
        const unit = snapshot.semanticUnits.find((candidate) => candidate.id === unitId);
        if (!unit) throw new DomainError(`Script 包含未知语义单元：${unitId}`, "SEMANTIC_UNIT_NOT_FOUND");
        unit.order = index;
        impact.changed.push(unit.id);
      });
      this.reconcileScript(snapshot, impact);
      impact.recomputed.push("SpeechSegment、字幕、Cue 依赖关系");
      impact.warnings.push("没有词级时间时，字幕和动效只能使用段级边界。");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 主线变化时先停止旧声音包装，避免旧 SFX 落在新语义上或 BGM 沿用过期 Duck。 */
  private markAudioCueStale(snapshot: ProjectSnapshot, cue: AudioCue, impact: ImpactReport, reason: string): void {
    const item = snapshot.timeline.items.find((candidate) => candidate.id === cue.timelineItemId);
    if (cue.status !== "stale") {
      cue.status = "stale";
      cue.updatedAt = now();
      impact.changed.push(cue.id);
    }
    if (item && !item.disabled) {
      item.disabled = true;
      impact.changed.push(item.id);
      impact.dirtyRanges.push({ startFrame: item.startFrame, endFrame: item.endFrame, reason: "声音包装等待主线复核" });
    }
    // 节拍标记依附 BGM 的实际播放范围；音乐被重新确认前，旧拍点不能继续被当作可用编辑证据。
    for (const beat of snapshot.vlogMusicBeats ?? []) {
      if (beat.audioCueId !== cue.id || beat.status === "stale") continue;
      beat.status = "stale";
      impact.changed.push(beat.id);
      impact.stale.push(beat.id);
    }
    impact.stale.push(cue.id);
    impact.warnings.push(`${cue.kind === "bgm" ? "BGM" : "SFX"}「${cue.purpose}」${reason}，已停止参与合成，等待重新确认。`);
  }

  private staleAudioCuesForMainline(snapshot: ProjectSnapshot, impact: ImpactReport, reason: string): void {
    for (const cue of snapshot.audioCues ?? []) {
      this.markAudioCueStale(snapshot, cue, impact, reason);
    }
  }

  private multicamGroupById(snapshot: ProjectSnapshot, groupId: Id): MulticamGroup {
    const group = snapshot.multicamGroups.find((candidate) => candidate.id === groupId);
    if (!group) throw new NotFoundError("多机位 Group 不存在");
    return group;
  }

  private multicamCutById(snapshot: ProjectSnapshot, cutId: Id): MulticamCut {
    const cut = snapshot.multicamCuts.find((candidate) => candidate.id === cutId);
    if (!cut) throw new NotFoundError("多机位 Cut 不存在");
    return cut;
  }

  /**
   * 新自动同步必须明确覆盖每个机位；旧 Job / 旧 Group 缺失范围时才兼容为整条素材。
   * 坐标刻意统一为项目 Timeline FPS，避免把 25fps 与 50fps 的源物理帧混进同一 Group。
   */
  private normalizeMulticamSourceRanges(
    snapshot: ProjectSnapshot,
    assetIds: Id[],
    sourceRanges: unknown
  ): Record<Id, MulticamSourceRange> {
    const hasExplicitRanges = sourceRanges !== undefined;
    if (hasExplicitRanges && (!sourceRanges || typeof sourceRanges !== "object" || Array.isArray(sourceRanges))) {
      throw new DomainError("多机位 sourceRanges 必须是按机位素材 ID 索引的范围对象", "MULTICAM_SOURCE_RANGES_INVALID");
    }
    const rawRanges = hasExplicitRanges ? sourceRanges as Record<string, unknown> : undefined;
    if (rawRanges) {
      const keys = Object.keys(rawRanges);
      if (keys.length !== assetIds.length || keys.some((assetId) => !assetIds.includes(assetId as Id))) {
        throw new DomainError("多机位 sourceRanges 必须完整且仅覆盖本次提交的每个机位", "MULTICAM_SOURCE_RANGES_INVALID");
      }
    }
    const normalized: Record<Id, MulticamSourceRange> = {};
    for (const assetId of assetIds) {
      const asset = assetById(snapshot, assetId);
      const duration = millisecondsToFrames(asset.metadata!.durationMs, snapshot.timeline.fps);
      const rawRange = rawRanges?.[assetId];
      const range = rawRange ?? (hasExplicitRanges ? undefined : { startFrame: 0, endFrame: duration });
      if (!range || typeof range !== "object" || Array.isArray(range)) {
        throw new DomainError("多机位 sourceRanges 缺少机位范围", "MULTICAM_SOURCE_RANGES_INVALID");
      }
      const candidate = range as Record<string, unknown>;
      const startFrame = candidate.startFrame;
      const endFrame = candidate.endFrame;
      if (Object.keys(candidate).some((key) => key !== "startFrame" && key !== "endFrame")
        || !Number.isInteger(startFrame) || !Number.isInteger(endFrame)
        || (startFrame as number) < 0 || (endFrame as number) <= (startFrame as number) || (endFrame as number) > duration) {
        throw new DomainError("多机位 sourceRange 必须位于对应素材的有效源范围内", "MULTICAM_SOURCE_RANGE_INVALID");
      }
      normalized[assetId] = { startFrame: startFrame as number, endFrame: endFrame as number };
    }
    return normalized;
  }

  /** 旧 Group 缺少 sourceRange 时保留整条素材语义；新自动 Group 的范围会在提交/完成时严格校验。 */
  private multicamSourceRangeFor(snapshot: ProjectSnapshot, sync: MulticamAngleSync): MulticamSourceRange {
    return this.normalizeMulticamSourceRanges(snapshot, [sync.assetId], sync.sourceRange
      ? { [sync.assetId]: sync.sourceRange }
      : undefined)[sync.assetId]!;
  }

  /** 将每个机位的有效源范围映射到 session 坐标后求交集，确保它们真的是同一个可切换会话。 */
  private resolveMulticamCommonSessionRange(snapshot: ProjectSnapshot, group: { angleSyncs: readonly MulticamAngleSync[] }): MulticamSourceRange {
    let startFrame = Number.NEGATIVE_INFINITY;
    let endFrame = Number.POSITIVE_INFINITY;
    for (const sync of group.angleSyncs) {
      const sourceRange = this.multicamSourceRangeFor(snapshot, sync);
      startFrame = Math.max(startFrame, sourceRange.startFrame + sync.sessionOffsetFrames);
      endFrame = Math.min(endFrame, sourceRange.endFrame + sync.sessionOffsetFrames);
    }
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame) {
      throw new DomainError("多机位各机位的已同步源范围没有有效的共同会话区间", "MULTICAM_SYNC_COMMON_RANGE_INVALID");
    }
    return { startFrame, endFrame };
  }

  /**
   * 自动相关要求每个角度都有可实际解码的音轨；人工标记允许静音机位，但主声音仍必须真实可播。
   * sourceHash 是异步同步的输入身份，不能因文件名相同就省略。
   */
  private assertMulticamAssets(snapshot: ProjectSnapshot, assetIds: Id[], referenceAssetId: Id, masterAudioAssetId: Id, requireAllAudio: boolean): void {
    if (!assetIds.includes(referenceAssetId) || !assetIds.includes(masterAudioAssetId)) {
      throw new DomainError("当前首版多机位仅支持相机内录：参考机位和主声音必须属于输入视频机位集合；独立录音机同步尚未接入。", "MULTICAM_ASSET_MEMBERSHIP_INVALID");
    }
    for (const assetId of assetIds) {
      const asset = assetById(snapshot, assetId);
      if (asset.status !== "ready" || asset.kind !== "video" || !asset.metadata?.videoCodec || asset.metadata.durationMs <= 0 || !asset.sourceHash) {
        throw new DomainError("多机位只能使用已完成媒体分析、具有受管二进制哈希的本地视频素材", "MULTICAM_ASSET_NOT_READY");
      }
      if (requireAllAudio && !asset.metadata.hasAudio) {
        throw new DomainError("自动多机位同步要求每个机位都具有真实可解码音轨；无音轨机位请使用人工同一事件标记", "MULTICAM_AUDIO_REQUIRED");
      }
    }
    const master = assetById(snapshot, masterAudioAssetId);
    if (!master.metadata?.hasAudio) throw new DomainError("多机位主声音机位必须具有真实音轨", "MULTICAM_MASTER_AUDIO_REQUIRED");
  }

  /** 统一以项目 Timeline FPS 表达 session/source 帧，避免把 25fps 与 50fps 源物理帧直接混用。 */
  private assertMulticamCut(snapshot: ProjectSnapshot, candidate: {
    groupId: Id;
    order: number | undefined;
    angleAssetId: Id | undefined;
    sessionStartFrame: number | undefined;
    sessionEndFrame: number | undefined;
    reason: string | undefined;
    continuityNote: string | undefined;
  }, ownId?: Id): Pick<MulticamCut, "groupId" | "order" | "angleAssetId" | "sessionStartFrame" | "sessionEndFrame" | "sourceStartFrame" | "sourceEndFrame" | "reason" | "continuityNote"> {
    const group = this.multicamGroupById(snapshot, candidate.groupId);
    const angleAssetId = requireText(candidate.angleAssetId, "多机位机位素材 ID");
    const sync = group.angleSyncs.find((entry) => entry.assetId === angleAssetId);
    if (!sync || sync.status !== "verified") throw new DomainError("多机位 Cut 只能选择已确认同步的机位", "MULTICAM_ANGLE_NOT_VERIFIED");
    const order = candidate.order;
    if (!Number.isInteger(order) || order === undefined || order < 0) {
      throw new DomainError("同一多机位 Group 的 Cut 顺序必须唯一且为非负整数", "MULTICAM_CUT_ORDER_INVALID");
    }
    const resolvedOrder: number = order;
    if (snapshot.multicamCuts.some((cut) => cut.id !== ownId && cut.groupId === group.id && cut.order === resolvedOrder && cut.status !== "stale")) {
      throw new DomainError("同一多机位 Group 的 Cut 顺序必须唯一且为非负整数", "MULTICAM_CUT_ORDER_INVALID");
    }
    const sessionStartFrame = candidate.sessionStartFrame;
    const sessionEndFrame = candidate.sessionEndFrame;
    if (!Number.isInteger(sessionStartFrame) || sessionStartFrame === undefined || !Number.isInteger(sessionEndFrame) || sessionEndFrame === undefined || sessionStartFrame < 0 || sessionEndFrame <= sessionStartFrame) {
      throw new DomainError("多机位 Cut 的会话范围必须是有效的非负连续帧区间", "MULTICAM_CUT_RANGE_INVALID");
    }
    const resolvedSessionStartFrame: number = sessionStartFrame;
    const resolvedSessionEndFrame: number = sessionEndFrame;
    const sourceStartFrame = resolvedSessionStartFrame - sync.sessionOffsetFrames;
    const sourceEndFrame = resolvedSessionEndFrame - sync.sessionOffsetFrames;
    const asset = assetById(snapshot, angleAssetId);
    const sourceDuration = millisecondsToFrames(asset.metadata!.durationMs, snapshot.timeline.fps);
    if (sourceStartFrame < 0 || sourceEndFrame > sourceDuration || sourceEndFrame - sourceStartFrame !== resolvedSessionEndFrame - resolvedSessionStartFrame) {
      throw new DomainError("多机位 Cut 在所选机位中不具备完整 1:1 源范围；请缩短会话范围或改选可覆盖机位", "MULTICAM_CUT_SOURCE_RANGE_INVALID");
    }
    const sourceRange = this.multicamSourceRangeFor(snapshot, sync);
    const commonSessionRange = this.resolveMulticamCommonSessionRange(snapshot, group);
    if (sourceStartFrame < sourceRange.startFrame || sourceEndFrame > sourceRange.endFrame
      || resolvedSessionStartFrame < commonSessionRange.startFrame || resolvedSessionEndFrame > commonSessionRange.endFrame) {
      throw new DomainError("多机位 Cut 超出了本次已确认同步的共同源范围；请缩短范围或为另一段会话新建同步 Group", "MULTICAM_CUT_OUTSIDE_SYNC_RANGE");
    }
    const overlaps = snapshot.multicamCuts.some((cut) => cut.id !== ownId && cut.groupId === group.id && cut.status !== "stale"
      && cut.sessionStartFrame < resolvedSessionEndFrame && cut.sessionEndFrame > resolvedSessionStartFrame);
    if (overlaps) throw new DomainError("同一多机位 Group 的 Cut 会话范围不能重叠；请明确唯一主画面", "MULTICAM_CUT_SESSION_OVERLAP");
    return {
      groupId: group.id,
      order: resolvedOrder,
      angleAssetId,
      sessionStartFrame: resolvedSessionStartFrame,
      sessionEndFrame: resolvedSessionEndFrame,
      sourceStartFrame,
      sourceEndFrame,
      reason: requireText(candidate.reason, "多机位切换理由"),
      continuityNote: requireText(candidate.continuityNote, "多机位连续性说明")
    };
  }

  /** 停用旧平铺 Timeline，不改写同步 Group；切换决定仍保留为 planned/stale，供下一次明确重编。 */
  private disableMulticamProgram(
    snapshot: ProjectSnapshot,
    group: MulticamGroup,
    impact: ImpactReport,
    reason: string,
    nextCutStatus: "planned" | "stale"
  ): void {
    const sceneId = group.sceneId;
    const scene = sceneId ? snapshot.scenes.find((candidate) => candidate.id === sceneId) : undefined;
    let changed = false;
    if (scene && scene.status !== "stale") {
      scene.status = "stale";
      impact.changed.push(scene.id);
      changed = true;
    }
    for (const item of snapshot.timeline.items.filter((candidate) => candidate.sceneId === sceneId && !candidate.disabled)) {
      item.disabled = true;
      impact.changed.push(item.id);
      impact.dirtyRanges.push({ startFrame: item.startFrame, endFrame: item.endFrame, reason: "多机位主线等待重新编译" });
      changed = true;
    }
    for (const cut of snapshot.multicamCuts.filter((candidate) => candidate.groupId === group.id)) {
      if (cut.sceneId || cut.timelineItemId || cut.status === "ready") {
        cut.sceneId = undefined;
        cut.timelineItemId = undefined;
        cut.status = nextCutStatus;
        cut.updatedAt = now();
        impact.changed.push(cut.id);
        if (nextCutStatus === "stale") impact.stale.push(cut.id);
        changed = true;
      }
    }
    if (!changed) return;
    group.sceneId = undefined;
    group.masterAudioTimelineItemId = undefined;
    group.programStartFrame = undefined;
    group.programEndFrame = undefined;
    group.updatedAt = now();
    impact.changed.push(group.id);
    impact.warnings.push(`多机位 Group「${group.title}」${reason}，旧画面与主声音已停止参与合成，等待重新编译。`);
  }

  /** Vlog 的一个 Scene 内多个 Select 共同承担事件；任一 Select 改动时整段必须回到待复核状态。 */
  private markVlogMontageSceneStale(snapshot: ProjectSnapshot, sceneId: Id, impact: ImpactReport, reason: string): void {
    const scene = snapshot.scenes.find((candidate) => candidate.id === sceneId);
    if (scene && scene.status !== "stale") {
      scene.status = "stale";
      impact.changed.push(scene.id);
    }
    for (const select of snapshot.vlogShotSelects ?? []) {
      if (select.sceneId !== sceneId) continue;
      const videoItem = select.timelineItemId ? snapshot.timeline.items.find((item) => item.id === select.timelineItemId) : undefined;
      const ambientItem = select.ambientTimelineItemId ? snapshot.timeline.items.find((item) => item.id === select.ambientTimelineItemId) : undefined;
      const ambient = snapshot.vlogAmbientCues.find((cue) => cue.shotSelectId === select.id);
      if (videoItem && !videoItem.disabled) {
        videoItem.disabled = true;
        impact.changed.push(videoItem.id);
        impact.dirtyRanges.push({ startFrame: videoItem.startFrame, endFrame: videoItem.endFrame, reason: "Vlog 镜头选择等待重新编译" });
      }
      if (ambientItem && !ambientItem.disabled) {
        ambientItem.disabled = true;
        impact.changed.push(ambientItem.id);
      }
      if (ambient && ambient.status !== "stale") {
        ambient.status = "stale";
        ambient.updatedAt = now();
        impact.changed.push(ambient.id);
        impact.stale.push(ambient.id);
      }
      select.sceneId = undefined;
      select.timelineItemId = undefined;
      select.ambientTimelineItemId = undefined;
      select.status = "stale";
      select.updatedAt = now();
      impact.changed.push(select.id);
      impact.stale.push(select.id);
    }
    impact.warnings.push(`Vlog 场景${reason}，相关镜头和现场声已停止参与合成，等待重新编译。`);
  }

  private markVlogShotSelectStale(snapshot: ProjectSnapshot, select: VlogShotSelect, impact: ImpactReport, reason: string): void {
    if (select.sceneId) {
      this.markVlogMontageSceneStale(snapshot, select.sceneId, impact, reason);
      return;
    }
    if (select.status !== "stale") {
      select.status = "stale";
      select.updatedAt = now();
      impact.changed.push(select.id);
      impact.stale.push(select.id);
    }
  }

  /** stale Cutaway 不再参与真实合成，但会保留在当前 Revision 供主工作流复核和替换。 */
  private markCutawayStale(snapshot: ProjectSnapshot, cutaway: Cutaway, impact: ImpactReport, reason: string): void {
    const scene = snapshot.scenes.find((candidate) => candidate.id === cutaway.cutawaySceneId);
    const item = snapshot.timeline.items.find((candidate) => candidate.id === cutaway.timelineItemId);
    if (cutaway.status !== "stale") {
      cutaway.status = "stale";
      cutaway.updatedAt = now();
      impact.changed.push(cutaway.id);
    }
    if (scene && scene.status !== "stale") {
      scene.status = "stale";
      impact.changed.push(scene.id);
    }
    if (item && !item.disabled) {
      item.disabled = true;
      impact.changed.push(item.id);
    }
    impact.stale.push(cutaway.id);
    impact.warnings.push(`Cutaway「${cutaway.purpose}」${reason}，已停止参与合成，等待重新确认。`);
  }

  /** Presenter 主线重新编译会移除旧 Scene；相关 Cutaway 不能遗留悬空引用。 */
  private removeCutawaysForHostScenes(snapshot: ProjectSnapshot, hostSceneIds: Set<Id>, impact: ImpactReport): void {
    const removed = snapshot.cutaways.filter((cutaway) => hostSceneIds.has(cutaway.hostSceneId));
    if (removed.length === 0) return;
    const cutawayIds = new Set(removed.map((cutaway) => cutaway.id));
    const sceneIds = new Set(removed.map((cutaway) => cutaway.cutawaySceneId));
    const itemIds = new Set(removed.map((cutaway) => cutaway.timelineItemId));
    const cueIds = snapshot.effectCues.filter((cue) => sceneIds.has(cue.sceneId)).map((cue) => cue.id);

    snapshot.cutaways = snapshot.cutaways.filter((cutaway) => !cutawayIds.has(cutaway.id));
    snapshot.timeline.items = snapshot.timeline.items.filter((item) => !itemIds.has(item.id));
    snapshot.effectCues = snapshot.effectCues.filter((cue) => !sceneIds.has(cue.sceneId));
    snapshot.scenes = snapshot.scenes.filter((scene) => !sceneIds.has(scene.id));
    for (const beat of snapshot.story.beats) {
      beat.sceneIds = beat.sceneIds.filter((sceneId) => !sceneIds.has(sceneId));
    }

    const removedTreatmentIds = new Set<Id>();
    for (const treatment of snapshot.visualTreatments) {
      if (!treatment.sceneId || !sceneIds.has(treatment.sceneId)) continue;
      if (treatment.narrativeBeatId) {
        treatment.sceneId = undefined;
        treatment.status = "stale";
        treatment.updatedAt = now();
        impact.changed.push(treatment.id);
        impact.stale.push(treatment.id);
      } else {
        removedTreatmentIds.add(treatment.id);
      }
    }
    if (removedTreatmentIds.size > 0) {
      snapshot.visualTreatments = snapshot.visualTreatments.filter((treatment) => !removedTreatmentIds.has(treatment.id));
    }
    impact.stale.push(...removed.map((cutaway) => cutaway.id), ...sceneIds, ...itemIds, ...cueIds, ...removedTreatmentIds);
    impact.recomputed.push("移除失效 Cutaway、CutawayScene 与顶层素材 Item");
  }

  /** 主场景仍存在时，不猜测旧 B-roll 是否仍相关；先标 stale 再交回 Cutaway 规划复核。 */
  private staleCutawaysForHostScenes(snapshot: ProjectSnapshot, hostSceneIds: Set<Id>, impact: ImpactReport, reason: string): void {
    for (const cutaway of snapshot.cutaways.filter((candidate) => hostSceneIds.has(candidate.hostSceneId))) {
      this.markCutawayStale(snapshot, cutaway, impact, reason);
    }
  }

  private resolveCutawayPlan(snapshot: ProjectSnapshot, input: {
    hostSceneId: Id;
    assetId: Id;
    visualTreatmentId?: Id;
    mode: CutawayMode;
    fit: CutawayFit;
    pipAnchor?: SpatialAnchor;
    pipScale?: number;
    sourceStartFrame: number;
    sourceEndFrame: number;
    startFrame: number;
    endFrame: number;
  }): { hostScene: ProjectSnapshot["scenes"][number]; asset: Asset } {
    const hostScene = snapshot.scenes.find((scene) => scene.id === input.hostSceneId);
    if (!hostScene) throw new DomainError("Cutaway 主场景不存在", "CUTAWAY_HOST_SCENE_NOT_FOUND");
    if (hostScene.type === "CutawayScene") throw new DomainError("Cutaway 不能以 CutawayScene 作为主场景", "INVALID_CUTAWAY_HOST");
    const asset = assetById(snapshot, input.assetId);
    if (asset.status !== "ready" || !asset.metadata?.videoCodec || !asset.managedPath.trim()) {
      throw new DomainError("Cutaway 只能使用已就绪且已本地化的视频素材", "CUTAWAY_ASSET_NOT_READY");
    }
    if (!Number.isInteger(input.startFrame) || !Number.isInteger(input.endFrame) || input.startFrame < hostScene.startFrame || input.endFrame > hostScene.endFrame || input.endFrame <= input.startFrame) {
      throw new DomainError("Cutaway 的目标范围必须完整位于主场景内", "CUTAWAY_OUT_OF_HOST_SCENE");
    }
    const sourceDuration = input.sourceEndFrame - input.sourceStartFrame;
    const targetDuration = input.endFrame - input.startFrame;
    const assetDuration = millisecondsToFrames(asset.metadata.durationMs, snapshot.timeline.fps);
    if (!Number.isInteger(input.sourceStartFrame) || !Number.isInteger(input.sourceEndFrame) || input.sourceStartFrame < 0 || input.sourceEndFrame > assetDuration || sourceDuration < targetDuration) {
      throw new DomainError("Cutaway 源范围无效或不足以覆盖目标播放时长", "INVALID_CUTAWAY_SOURCE_RANGE");
    }
    if (input.mode === "pip" && (!input.pipAnchor || input.pipAnchor === "full_frame")) {
      throw new DomainError("PiP Cutaway 必须指定非全屏安全区锚点", "PIP_ANCHOR_REQUIRED");
    }
    if (input.pipScale !== undefined && (input.pipScale < 0.2 || input.pipScale > 0.6)) {
      throw new DomainError("PiP 缩放必须在 0.2 到 0.6 之间", "INVALID_PIP_SCALE");
    }
    if (input.visualTreatmentId) {
      const treatment = visualTreatmentById(snapshot, input.visualTreatmentId);
      if (treatment.status !== "ready") throw new DomainError("关联的 VisualTreatment 已失效，请先重新确认视觉计划", "VISUAL_TREATMENT_STALE");
      if (treatment.sceneId && treatment.sceneId !== hostScene.id) {
        throw new DomainError("VisualTreatment 必须属于当前 Cutaway 的主场景", "VISUAL_TREATMENT_SCENE_MISMATCH");
      }
    }
    return { hostScene, asset };
  }

  /** 清理 Presenter Scene、反向 Story 引用和依附其上的 Cue，但保留物理 A-roll。 */
  private clearPresenterScenes(snapshot: ProjectSnapshot, impact: ImpactReport): void {
    const removedSceneIds = new Set(snapshot.scenes.filter((scene) => scene.type === "PresenterScene").map((scene) => scene.id));
    this.removeCutawaysForHostScenes(snapshot, removedSceneIds, impact);
    const removedTreatmentIds = new Set<Id>();
    for (const treatment of snapshot.visualTreatments) {
      if (!treatment.sceneId || !removedSceneIds.has(treatment.sceneId)) continue;
      if (treatment.narrativeBeatId) {
        treatment.sceneId = undefined;
        treatment.status = "stale";
        treatment.updatedAt = now();
        impact.changed.push(treatment.id);
        impact.stale.push(treatment.id);
      } else {
        removedTreatmentIds.add(treatment.id);
      }
    }
    if (removedTreatmentIds.size > 0) {
      snapshot.visualTreatments = snapshot.visualTreatments.filter((treatment) => !removedTreatmentIds.has(treatment.id));
      impact.stale.push(...removedTreatmentIds);
    }
    const removedCueIds = snapshot.effectCues.filter((cue) => removedSceneIds.has(cue.sceneId)).map((cue) => cue.id);
    snapshot.effectCues = snapshot.effectCues.filter((cue) => !removedSceneIds.has(cue.sceneId));
    snapshot.scenes = snapshot.scenes.filter((scene) => scene.type !== "PresenterScene");
    for (const item of snapshot.timeline.items) {
      if (item.sceneId && removedSceneIds.has(item.sceneId)) item.sceneId = undefined;
    }
    for (const beat of snapshot.story.beats) {
      beat.sceneIds = beat.sceneIds.filter((sceneId) => !removedSceneIds.has(sceneId));
    }
    impact.stale.push(...removedCueIds);
  }

  /** 清理重建会失效的 Presenter 对象，连同反向 Story 引用和 Cue 一起处理。 */
  private clearPresenterStructure(snapshot: ProjectSnapshot, impact: ImpactReport): void {
    const track = trackByName(snapshot, "Actor / A-roll");
    const removedActorItemIds = new Set(snapshot.timeline.items.filter((item) => item.trackId === track.id).map((item) => item.id));
    for (const performance of snapshot.actorPerformances) {
      if (removedActorItemIds.has(performance.timelineItemId)) impact.stale.push(performance.id);
    }
    snapshot.actorPerformances = snapshot.actorPerformances.filter((performance) => !removedActorItemIds.has(performance.timelineItemId));
    // 显式重建会移除旧 Item；它的原始/裁剪派生字幕证据随旧 Revision 留存，当前图不能保留悬空审计引用。
    const removedAlignments = snapshot.sourceAudioAlignments.filter((alignment) => removedActorItemIds.has(alignment.sourceTimelineItemId));
    const removedPrograms = snapshot.sourceCaptionPrograms.filter((program) => removedActorItemIds.has(program.sourceTimelineItemId));
    impact.stale.push(...removedAlignments.map((alignment) => alignment.id), ...removedPrograms.map((program) => program.id));
    snapshot.sourceAudioAlignments = snapshot.sourceAudioAlignments.filter((alignment) => !removedActorItemIds.has(alignment.sourceTimelineItemId));
    snapshot.sourceCaptionPrograms = snapshot.sourceCaptionPrograms.filter((program) => !removedActorItemIds.has(program.sourceTimelineItemId));
    this.clearPresenterScenes(snapshot, impact);
    snapshot.timeline.items = snapshot.timeline.items.filter((item) => item.trackId !== track.id);
  }

  /** 物理素材组装：只按明确选择的 A-roll 拼接，不生成任何叙事 Scene。 */
  private assemblePresenterTrackInSnapshot(snapshot: ProjectSnapshot, impact: ImpactReport, assetIds: Id[]): TimelineItem[] {
    const track = trackByName(snapshot, "Actor / A-roll");
    const selected = assetIds.map((assetId) => assetById(snapshot, assetId));
    if (selected.length === 0) throw new DomainError("至少需要一条明确选择的 A-roll 素材", "EMPTY_TIMELINE");
    if (selected.some((asset) => asset.status !== "ready" || !asset.metadata?.videoCodec)) {
      throw new DomainError("Presenter 主线只能使用已就绪的视频素材", "ASSET_NOT_READY");
    }
    this.clearPresenterStructure(snapshot, impact);
    let cursor = 0;
    const items: TimelineItem[] = [];
    for (const asset of selected) {
      const duration = millisecondsToFrames(asset.metadata!.durationMs, snapshot.timeline.fps);
      if (duration <= 0) throw new DomainError(`A-roll 素材时长无效：${asset.name}`, "INVALID_ITEM_RANGE");
      // 这是调用方的显式选择，才将素材标为 A-roll；不会扫描所有视频自动加入。
      asset.role = "a_roll";
      const item = createTimelineItem({
        trackId: track.id,
        assetId: asset.id,
        startFrame: cursor,
        endFrame: cursor + duration,
        sourceStartFrame: 0,
        sourceEndFrame: duration,
        gainDb: 0
      });
      snapshot.timeline.items.push(item);
      items.push(item);
      impact.changed.push(item.id, asset.id);
      cursor = item.endFrame;
    }
    impact.recomputed.push("A-roll 物理拼接、主轨时长");
    impact.dirtyRanges.push({ startFrame: 0, endFrame: cursor, reason: "重建 Presenter A-roll 主线" });
    return items;
  }

  /**
   * 叙事 Scene 编译：必须由调用方提供目的与 Beat 关系，禁止按素材数量或固定 N 条视频猜测。
   */
  private compilePresenterScenesInSnapshot(snapshot: ProjectSnapshot, impact: ImpactReport, input: {
    scenes: Array<{ title: string; purpose: string; startFrame: number; endFrame: number; narrativeBeatIds?: Id[]; stylePackId?: string }>;
  }): void {
    const track = trackByName(snapshot, "Actor / A-roll");
    const actorItems = snapshot.timeline.items.filter((item) => item.trackId === track.id && !item.disabled).sort((left, right) => left.startFrame - right.startFrame);
    if (actorItems.length === 0) throw new DomainError("请先组装明确的 Presenter A-roll 主线", "MISSING_PRIMARY_VIDEO");
    const storyBeatIds = new Set(snapshot.story.beats.map((beat) => beat.id));
    const plans = [...input.scenes].sort((left, right) => left.startFrame - right.startFrame);
    if (plans.length === 0) throw new DomainError("至少需要一个叙事 Scene 计划", "EMPTY_SCENE_PLAN");
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index]!;
      if (!plan.title.trim() || !plan.purpose.trim() || plan.startFrame < 0 || plan.endFrame <= plan.startFrame) {
        throw new DomainError("Presenter Scene 计划缺少有效标题、目的或时间范围", "INVALID_SCENE_PLAN");
      }
      if (index > 0 && plans[index - 1]!.endFrame > plan.startFrame) throw new DomainError("Presenter Scene 计划不能重叠", "SCENE_OVERLAP");
      for (const beatId of plan.narrativeBeatIds ?? []) if (!storyBeatIds.has(beatId)) throw new DomainError(`Scene 引用了未知 Story Beat：${beatId}`, "STORY_BEAT_NOT_FOUND");
    }
    const coveredItemIds = new Set<Id>();
    for (const plan of plans) {
      const items = actorItems.filter((item) => item.startFrame >= plan.startFrame && item.endFrame <= plan.endFrame);
      if (items.length === 0) throw new DomainError("每个 Presenter Scene 必须覆盖至少一个完整 A-roll Item", "SCENE_ITEM_REQUIRED");
      for (const item of items) {
        if (coveredItemIds.has(item.id)) throw new DomainError("同一 A-roll Item 不能属于多个 Presenter Scene", "ITEM_MULTI_SCENE");
        coveredItemIds.add(item.id);
      }
      const scene = createScene({
        type: "PresenterScene",
        title: plan.title,
        purpose: plan.purpose,
        startFrame: plan.startFrame,
        endFrame: plan.endFrame,
        assetIds: [...new Set(items.map((item) => item.assetId))]
      });
      scene.narrativeBeatIds = [...(plan.narrativeBeatIds ?? [])];
      scene.stylePackId = plan.stylePackId?.trim() || snapshot.project.stylePackId;
      snapshot.scenes.push(scene);
      for (const item of items) item.sceneId = scene.id;
      for (const beatId of scene.narrativeBeatIds) {
        const beat = snapshot.story.beats.find((candidate) => candidate.id === beatId)!;
        beat.sceneIds = [...new Set([...beat.sceneIds, scene.id])];
        impact.changed.push(beat.id);
      }
      impact.changed.push(scene.id, ...items.map((item) => item.id));
    }
    if (coveredItemIds.size !== actorItems.length) {
      throw new DomainError("Presenter Scene 计划必须覆盖全部 A-roll Item；未覆盖片段不能偷偷归入场景", "SCENE_COVERAGE_INCOMPLETE");
    }
    impact.recomputed.push("Story Beat、PresenterScene、Scene Strip");
  }

  /** 对外的物理组装入口，供导演层在确定 A-roll 后调用。 */
  assemblePresenterTrack(input: { projectId: Id; baseRevision: number; assetIds: Id[] }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "组装 Presenter A-roll 主线", (snapshot, impact) => {
      this.assemblePresenterTrackInSnapshot(snapshot, impact, input.assetIds);
      this.staleAudioCuesForMainline(snapshot, impact, "Presenter 主画面重新组装");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 裁剪既有原声 A-roll，保留原媒体，不产生隐式生成任务或第二条声音。 */
  editPresenterSource(input: PresenterSourceEditInput & { projectId: Id; baseRevision: number }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, `裁剪原声人物片段：${input.reason}`, (snapshot, impact) => {
      if (this.repository.listJobs(input.projectId).some((job) => ["queued", "running", "unknown"].includes(job.status))) {
        throw new DomainError("存在未终态或结果未知的 Job，需先对账再裁剪主线", "SOURCE_EDIT_PENDING_JOBS");
      }
      const { affectedSceneIds, firstRemovedFrame } = editPresenterSourceInSnapshot(snapshot, impact, input, input.baseRevision + 1);
      this.staleCutawaysForHostScenes(snapshot, affectedSceneIds, impact, "原声主线已裁剪");
      for (const cue of snapshot.audioCues) {
        const item = snapshot.timeline.items.find((candidate) => candidate.id === cue.timelineItemId);
        if (firstRemovedFrame !== undefined && item && item.endFrame > firstRemovedFrame) this.markAudioCueStale(snapshot, cue, impact, "原声主线已裁剪");
      }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 对外的叙事 Scene 编译入口，接受 Skill 已做出的 Story / Speech / VisualTreatment 判断。 */
  compilePresenterScenes(input: {
    projectId: Id;
    baseRevision: number;
    scenes: Array<{ title: string; purpose: string; startFrame: number; endFrame: number; narrativeBeatIds?: Id[]; stylePackId?: string }>;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "编译 Presenter 叙事场景", (snapshot, impact) => {
      // Scene 重新编译时，旧 Scene / Cue 必须成组失效，A-roll 物理拼接保持不动。
      this.clearPresenterScenes(snapshot, impact);
      this.compilePresenterScenesInSnapshot(snapshot, impact, { scenes: input.scenes });
      this.staleAudioCuesForMainline(snapshot, impact, "叙事 Scene 已重新编译");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 兼容旧客户端的单步入口。新 MCP/Web 不再调用它；它仍会明确标记为兼容路径，
   * 以防升级时把已有项目直接打断。
   */
  buildPresenterTimeline(input: { projectId: Id; baseRevision: number; assetIds: Id[]; sceneSize?: number }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "兼容模式建立 Presenter 主时间线", (snapshot, impact) => {
      const items = this.assemblePresenterTrackInSnapshot(snapshot, impact, input.assetIds);
      const sceneSize = Math.max(1, input.sceneSize ?? 2);
      const plans = [] as Array<{ title: string; purpose: string; startFrame: number; endFrame: number }>;
      for (let start = 0; start < items.length; start += sceneSize) {
        const group = items.slice(start, start + sceneSize);
        plans.push({
          title: `兼容口播片段 ${Math.floor(start / sceneSize) + 1}`,
          purpose: "兼容旧客户端的临时主线分组；正式创作请使用 Story Beat 编译场景。",
          startFrame: group[0]!.startFrame,
          endFrame: group[group.length - 1]!.endFrame
        });
      }
      this.compilePresenterScenesInSnapshot(snapshot, impact, { scenes: plans });
      this.staleAudioCuesForMainline(snapshot, impact, "Presenter 主线与场景重新建立");
      impact.warnings.push("当前通过兼容入口按素材分组生成 Scene；正式创作请使用 assemblePresenterTrack + compilePresenterScenes。");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 人物能力档案属于 Project Revision，便于后续生成结果与当时允许的能力准确对账。 */
  manageActorCapabilityProfile(input: {
    projectId: Id;
    baseRevision: number;
    action: "create" | "update" | "remove";
    profileId?: Id;
    provider?: AvatarProviderKind;
    label?: string;
    workflowId?: string;
    inputModes?: AvatarInputMode[];
    maskModes?: ActorMaskMode[];
    supportsReferenceImage?: boolean;
    supportsReferenceVideo?: boolean;
    supportsAudioDrivenLipSync?: boolean;
    supportsGazeControl?: boolean;
    supportsGestureControl?: boolean;
    supportsPartialRegeneration?: boolean;
    maxDurationSeconds?: number;
    privacyNote?: string;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, input.action === "create" ? "创建人物能力档案" : input.action === "update" ? "更新人物能力档案" : "移除人物能力档案", (snapshot, impact) => {
      const ensureProvider = (provider: AvatarProviderKind | undefined): AvatarProviderKind => {
        if (provider !== "minimax_h3_multi_reference") throw new DomainError("当前只支持 minimax_h3_multi_reference 人物 Provider", "AVATAR_PROVIDER_UNSUPPORTED");
        return provider;
      };
      const ensureDuration = (value: number | undefined): number => {
        if (!Number.isFinite(value) || !Number.isInteger(value) || value! < 1 || value! > 1_800) {
          throw new DomainError("人物生成最大时长必须是 1 到 1800 的整数秒", "INVALID_AVATAR_MAX_DURATION");
        }
        return value!;
      };
      const profiles = snapshot.actorCapabilityProfiles;
      if (input.action === "remove") {
        const profileId = input.profileId;
        if (!profileId) throw new DomainError("移除人物能力档案必须指定 profileId", "ACTOR_CAPABILITY_ID_REQUIRED");
        if (!profiles.some((profile) => profile.id === profileId)) throw new DomainError("要移除的人物能力档案不存在", "ACTOR_CAPABILITY_NOT_FOUND");
        if (snapshot.actorPerformances.some((performance) => performance.capabilityProfileId === profileId)) {
          throw new DomainError("该能力档案仍被人物表演引用，不能直接移除", "ACTOR_CAPABILITY_IN_USE");
        }
        snapshot.actorCapabilityProfiles = profiles.filter((profile) => profile.id !== profileId);
        impact.changed.push(profileId);
        impact.recomputed.push("人物能力档案引用检查");
        return;
      }

      if (input.action === "create") {
        const profile: ActorCapabilityProfile = {
          id: createId("actor_capability"),
          provider: ensureProvider(input.provider),
          label: requireText(input.label, "人物能力档案名称"),
          workflowId: requireText(input.workflowId, "人物 Provider 工作流 ID"),
          inputModes: normalizeAvatarInputModes(input.inputModes ?? []),
          maskModes: normalizeActorMaskModes(input.maskModes ?? []),
          supportsReferenceImage: input.supportsReferenceImage ?? false,
          supportsReferenceVideo: input.supportsReferenceVideo ?? false,
          supportsAudioDrivenLipSync: input.supportsAudioDrivenLipSync ?? false,
          supportsGazeControl: input.supportsGazeControl ?? false,
          supportsGestureControl: input.supportsGestureControl ?? false,
          supportsPartialRegeneration: input.supportsPartialRegeneration ?? false,
          maxDurationSeconds: ensureDuration(input.maxDurationSeconds),
          privacyNote: requireText(input.privacyNote, "人物 Provider 隐私说明"),
          createdAt: now(),
          updatedAt: now()
        };
        profiles.push(profile);
        impact.changed.push(profile.id);
        impact.recomputed.push("人物 Provider 能力与表演规划边界");
        return;
      }

      const profileId = input.profileId;
      if (!profileId) throw new DomainError("更新人物能力档案必须指定 profileId", "ACTOR_CAPABILITY_ID_REQUIRED");
      const profile = profiles.find((candidate) => candidate.id === profileId);
      if (!profile) throw new DomainError("要更新的人物能力档案不存在", "ACTOR_CAPABILITY_NOT_FOUND");
      if (input.provider !== undefined) profile.provider = ensureProvider(input.provider);
      if (input.label !== undefined) profile.label = requireText(input.label, "人物能力档案名称");
      if (input.workflowId !== undefined) profile.workflowId = requireText(input.workflowId, "人物 Provider 工作流 ID");
      if (input.inputModes !== undefined) profile.inputModes = normalizeAvatarInputModes(input.inputModes);
      if (input.maskModes !== undefined) profile.maskModes = normalizeActorMaskModes(input.maskModes);
      if (input.supportsReferenceImage !== undefined) profile.supportsReferenceImage = input.supportsReferenceImage;
      if (input.supportsReferenceVideo !== undefined) profile.supportsReferenceVideo = input.supportsReferenceVideo;
      if (input.supportsAudioDrivenLipSync !== undefined) profile.supportsAudioDrivenLipSync = input.supportsAudioDrivenLipSync;
      if (input.supportsGazeControl !== undefined) profile.supportsGazeControl = input.supportsGazeControl;
      if (input.supportsGestureControl !== undefined) profile.supportsGestureControl = input.supportsGestureControl;
      if (input.supportsPartialRegeneration !== undefined) profile.supportsPartialRegeneration = input.supportsPartialRegeneration;
      if (input.maxDurationSeconds !== undefined) profile.maxDurationSeconds = ensureDuration(input.maxDurationSeconds);
      if (input.privacyNote !== undefined) profile.privacyNote = requireText(input.privacyNote, "人物 Provider 隐私说明");
      profile.updatedAt = now();
      impact.changed.push(profile.id);
      impact.recomputed.push("人物 Provider 能力与表演规划边界");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  listActorCapabilityProfiles(projectId: Id): ActorCapabilityProfile[] {
    return this.readProject(projectId).snapshot.actorCapabilityProfiles;
  }

  /**
   * 将既有主画面 Item 明确登记为人物表演。Mask 只接受已就绪的本地透明图片；
   * 没有 Mask 时保留可播放的前景降级，而不伪造人物抠像。
   */
  registerActorPerformance(input: {
    projectId: Id;
    baseRevision: number;
    timelineItemId: Id;
    source: ActorPerformanceSource;
    maskMode: ActorMaskMode;
    audioMode?: ActorAudioMode;
    maskAssetId?: Id;
    speechAssetId?: Id;
    capabilityProfileId?: Id;
    layout?: ActorLayout;
    note?: string;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "登记人物表演", (snapshot, impact) => {
      const item = snapshot.timeline.items.find((candidate) => candidate.id === input.timelineItemId);
      if (!item) throw new DomainError("人物表演对应的 Timeline Item 不存在", "ACTOR_ITEM_NOT_FOUND");
      const track = snapshot.timeline.tracks.find((candidate) => candidate.id === item.trackId);
      if (track?.name !== "Actor / A-roll") throw new DomainError("人物表演必须绑定 Actor / A-roll 主画面 Item", "INVALID_ACTOR_TRACK");
      if (!item.sceneId) throw new DomainError("人物表演必须先归属一个 PresenterScene", "ACTOR_SCENE_REQUIRED");
      const actorAsset = assetById(snapshot, item.assetId);
      if (actorAsset.status !== "ready" || !actorAsset.metadata?.videoCodec) throw new DomainError("人物视频尚未就绪或不是有效视频", "ACTOR_ASSET_NOT_READY");
      const layout = input.layout === undefined ? undefined : normalizeActorLayout(input.layout);

      if (input.maskMode === "alpha_asset") {
        if (!input.maskAssetId) throw new DomainError("alpha_asset 模式必须指定透明 Mask 素材", "MASK_REQUIRED");
        const mask = assetById(snapshot, input.maskAssetId);
        if (mask.status !== "ready" || !["image", "derived"].includes(mask.kind) || mask.role !== "actor_mask") {
          throw new DomainError("静态 Mask 必须是已就绪且角色为 actor_mask 的图片或派生素材", "INVALID_MASK_ASSET");
        }
        if (!mask.metadata?.hasAlpha) {
          throw new DomainError("静态 Mask 必须经媒体分析确认包含 Alpha，普通图片不能冒充透明遮挡", "ACTOR_MASK_ALPHA_REQUIRED");
        }
        if (!actorAsset.metadata.width || !actorAsset.metadata.height || !mask.metadata.width || !mask.metadata.height) {
          throw new DomainError("人物视频与静态 Mask 都必须有已分析的尺寸，才能确认遮挡对齐", "ACTOR_MASK_DIMENSIONS_REQUIRED");
        }
        if (actorAsset.metadata.width !== mask.metadata.width || actorAsset.metadata.height !== mask.metadata.height) {
          throw new DomainError("静态 Mask 尺寸必须与人物视频完全一致，不能靠 CSS 拉伸伪造对齐", "ACTOR_MASK_DIMENSIONS_MISMATCH");
        }
        if (!layout) {
          throw new DomainError("静态 Mask 只允许已明确登记人工静态布局的人物；动态动作请保持无 Mask 降级或导入匹配 Alpha 视频", "STATIC_MASK_LAYOUT_REQUIRED");
        }
      } else if (input.maskAssetId) {
        throw new DomainError("仅 alpha_asset 模式允许指定独立 Mask 素材", "UNEXPECTED_MASK_ASSET");
      }
      if (input.maskMode === "embedded_alpha" && !actorAsset.metadata.hasAlpha) {
        throw new DomainError("embedded_alpha 必须经媒体分析确认人物视频本身包含 Alpha，不能只靠模式字段声明", "EMBEDDED_ALPHA_REQUIRED");
      }
      if (input.capabilityProfileId && !snapshot.actorCapabilityProfiles.some((profile) => profile.id === input.capabilityProfileId)) {
        throw new DomainError("人物表演引用的能力档案不存在", "ACTOR_CAPABILITY_NOT_FOUND");
      }

      let speechAssetId = input.speechAssetId;
      let scriptRevision: number | undefined;
      if (input.source === "generated") {
        const speech = snapshot.speechAsset;
        if (!speech || speech.status !== "ready") throw new DomainError("生成型人物表演必须绑定已就绪 SpeechAsset", "SPEECH_ASSET_REQUIRED");
        if (speechAssetId && speechAssetId !== speech.id) throw new DomainError("人物表演引用的 SpeechAsset 不是当前项目版本", "STALE_ACTOR_SPEECH");
        speechAssetId = speech.id;
        scriptRevision = speech.scriptRevision;
      }

      // 有已就绪 Dialogue 时默认由它承担旁白，避免旧工作流把人物原声与 OmniVoice 一起播放。
      const audioMode = input.audioMode ?? (snapshot.speechAsset?.status === "ready" ? "use_dialogue_track" : "use_source_audio");
      if (audioMode === "use_dialogue_track" && !snapshot.speechAsset) {
        impact.warnings.push("人物表演选择了 Dialogue 声音，但当前尚未组装 SpeechAsset；导出前需要补齐声音或改为原声。");
      }

      const existing = snapshot.actorPerformances.find((candidate) => candidate.timelineItemId === item.id);
      const performance = existing ?? createActorPerformance({
        timelineItemId: item.id,
        source: input.source,
        maskMode: input.maskMode,
        maskAssetId: input.maskAssetId,
        speechAssetId,
        scriptRevision,
        audioMode,
        capabilityProfileId: input.capabilityProfileId,
        layout,
        note: input.note
      });
      if (existing) {
        existing.source = input.source;
        existing.maskMode = input.maskMode;
        existing.maskAssetId = input.maskAssetId;
        existing.speechAssetId = speechAssetId;
        existing.scriptRevision = scriptRevision;
        existing.audioMode = audioMode;
        if (input.capabilityProfileId !== undefined) existing.capabilityProfileId = input.capabilityProfileId;
        if (layout !== undefined) existing.layout = layout;
        existing.status = "ready";
        existing.note = input.note ?? existing.note;
      } else {
        snapshot.actorPerformances.push(performance);
      }
      actorAsset.kind = "actor_video";
      impact.changed.push(performance.id, actorAsset.id);
      impact.dirtyRanges.push({ startFrame: item.startFrame, endFrame: item.endFrame, reason: "人物表演或 Mask 更新" });
      if (input.maskMode === "none") impact.warnings.push("人物表演未提供 Mask，后景效果会降级为前景显示，需在预览中复核。");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** NarrativeMap 复用 Story 的 Beat，只补充观众知识状态，不另建叙事真相。 */
  readNarrativeMap(input: { projectId: Id }): { revision: number; narrativeMap?: NarrativeMap } {
    const state = this.readProject(input.projectId);
    return { revision: state.revision.number, narrativeMap: state.snapshot.narrativeMap };
  }

  manageNarrativeMap(input: {
    projectId: Id;
    baseRevision: number;
    viewerQuestion: string;
    promisedModel: string;
    conclusion: string;
    beats: Array<{
      narrativeBeatId: Id;
      enteringKnowledge: string;
      question: string;
      newKnowledge: string;
      deferredInformation: string;
      claim?: string;
      evidenceCaptureIds?: Id[];
      sceneIds?: Id[];
    }>;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "更新视觉解释 NarrativeMap", (snapshot, impact) => {
      if (input.beats.length === 0) throw new DomainError("NarrativeMap 至少需要一个与 Story Beat 对应的认知步骤", "NARRATIVE_MAP_BEAT_REQUIRED");
      const previous = snapshot.narrativeMap;
      const previousByStoryBeat = new Map((previous?.beats ?? []).map((beat) => [beat.narrativeBeatId, beat]));
      const seenStoryBeatIds = new Set<Id>();
      const beats: NarrativeMapBeat[] = input.beats.map((draft) => {
        if (seenStoryBeatIds.has(draft.narrativeBeatId)) throw new DomainError("NarrativeMap 不能重复引用同一个 Story Beat", "NARRATIVE_MAP_BEAT_DUPLICATED");
        seenStoryBeatIds.add(draft.narrativeBeatId);
        if (!snapshot.story.beats.some((beat) => beat.id === draft.narrativeBeatId)) throw new DomainError("NarrativeMap 引用了不存在的 Story Beat", "NARRATIVE_MAP_STORY_BEAT_NOT_FOUND");
        const existing = previousByStoryBeat.get(draft.narrativeBeatId);
        const evidenceCaptureIds = [...new Set(draft.evidenceCaptureIds ?? existing?.evidenceCaptureIds ?? [])];
        for (const evidenceCaptureId of evidenceCaptureIds) {
          if (!snapshot.evidenceCaptures.some((capture) => capture.id === evidenceCaptureId)) {
            throw new DomainError("NarrativeMap 引用了不存在的 EvidenceCapture", "NARRATIVE_MAP_EVIDENCE_NOT_FOUND");
          }
        }
        const sceneIds = [...new Set(draft.sceneIds ?? existing?.sceneIds ?? [])];
        for (const sceneId of sceneIds) {
          if (!snapshot.scenes.some((scene) => scene.id === sceneId)) throw new DomainError("NarrativeMap 引用了不存在的 Scene", "NARRATIVE_MAP_SCENE_NOT_FOUND");
        }
        return {
          id: existing?.id ?? createId("narrative_map_beat"),
          narrativeBeatId: draft.narrativeBeatId,
          enteringKnowledge: requireText(draft.enteringKnowledge, "进入场景前观众已知信息"),
          question: requireText(draft.question, "当前观众问题"),
          newKnowledge: requireText(draft.newKnowledge, "本拍新增理解"),
          deferredInformation: requireText(draft.deferredInformation, "延后披露的信息"),
          claim: draft.claim?.trim() || undefined,
          evidenceCaptureIds,
          sceneIds
        };
      });
      const next: NarrativeMap = {
        id: previous?.id ?? createId("narrative_map"),
        viewerQuestion: requireText(input.viewerQuestion, "观众核心问题"),
        promisedModel: requireText(input.promisedModel, "视频承诺的理解模型"),
        conclusion: requireText(input.conclusion, "NarrativeMap 结论"),
        beats,
        updatedAt: now()
      };
      const validMapBeatIds = new Set(next.beats.map((beat) => beat.id));
      snapshot.narrativeMap = next;
      for (const program of snapshot.explainerPrograms) {
        if (!program.narrativeMapBeatId) continue;
        const previousBeat = previous?.beats.find((beat) => beat.id === program.narrativeMapBeatId);
        const nextBeat = next.beats.find((beat) => beat.id === program.narrativeMapBeatId);
        if (!nextBeat) {
          this.markExplainerProgramStale(snapshot, impact, program, "NarrativeMap 结构已变化");
        } else if (!previousBeat || stableJson(previousBeat) !== stableJson(nextBeat)
          || previous?.viewerQuestion !== next.viewerQuestion
          || previous.promisedModel !== next.promisedModel
          || previous.conclusion !== next.conclusion) {
          // Scene 视觉语法依赖“观众此刻应理解什么”，因此 Map 文案或证据绑定变更不能继续复用旧 Program。
          this.markExplainerProgramStale(snapshot, impact, program, "NarrativeMap 的观众问题、知识状态或结论已变化");
        }
      }
      impact.changed.push(next.id, ...next.beats.map((beat) => beat.id));
      impact.recomputed.push("NarrativeMap 观众知识状态与 Explainer 失效范围");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** EvidenceCapture 接受已本地化的原始来源与真实页面快照；不会用网页标题或生成图冒充证据。 */
  manageEvidenceCapture(input: {
    projectId: Id;
    baseRevision: number;
    action: "create" | "update" | "remove";
    evidenceCaptureId?: Id;
    sourceAssetId?: Id;
    snapshotAssetId?: Id;
    sourceTitle?: string;
    publisher?: string;
    sourceUrl?: string;
    capturedAt?: string;
    pageOrRange?: string;
    excerpt?: string;
    claim?: string;
    limitation?: string;
    highlights?: EvidenceHighlight[];
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, input.action === "create" ? "登记证据快照" : input.action === "update" ? "更新证据快照" : "移除证据快照", (snapshot, impact) => {
      if (input.action === "remove") {
        const captureId = requireText(input.evidenceCaptureId, "EvidenceCapture ID");
        if (!snapshot.evidenceCaptures.some((capture) => capture.id === captureId)) throw new NotFoundError("EvidenceCapture 不存在");
        const referencedByMap = snapshot.narrativeMap?.beats.some((beat) => beat.evidenceCaptureIds.includes(captureId));
        const referencedByProgram = snapshot.explainerPrograms.some((program) => program.evidenceCaptureId === captureId);
        if (referencedByMap || referencedByProgram) throw new DomainError("EvidenceCapture 仍被 NarrativeMap 或 Explainer Scene 使用，不能直接移除", "EVIDENCE_CAPTURE_IN_USE");
        snapshot.evidenceCaptures = snapshot.evidenceCaptures.filter((capture) => capture.id !== captureId);
        impact.changed.push(captureId);
        return;
      }

      const existing = input.evidenceCaptureId ? snapshot.evidenceCaptures.find((capture) => capture.id === input.evidenceCaptureId) : undefined;
      if (input.action === "update" && !existing) throw new NotFoundError("要更新的 EvidenceCapture 不存在");
      const sourceAssetId = input.sourceAssetId ?? existing?.sourceAssetId;
      if (!sourceAssetId) throw new DomainError("EvidenceCapture 必须指定原始来源 Asset", "EVIDENCE_SOURCE_ASSET_REQUIRED");
      const sourceAsset = assetById(snapshot, sourceAssetId);
      if (sourceAsset.status !== "ready" || sourceAsset.provenance?.source === "generated") {
        throw new DomainError("证据原始素材必须是已就绪且非生成的真实来源", "EVIDENCE_SOURCE_ASSET_INVALID");
      }
      const snapshotAssetId = input.snapshotAssetId ?? existing?.snapshotAssetId;
      if (snapshotAssetId) {
        const snapshotAsset = assetById(snapshot, snapshotAssetId);
        if (snapshotAsset.status !== "ready" || !["image", "derived"].includes(snapshotAsset.kind) || snapshotAsset.provenance?.source === "generated") {
          throw new DomainError("证据页面快照必须是已就绪且非生成的图片素材", "EVIDENCE_SNAPSHOT_ASSET_INVALID");
        }
      }
      const capture: EvidenceCapture = {
        id: existing?.id ?? createId("evidence_capture"),
        sourceAssetId,
        snapshotAssetId,
        sourceTitle: requireText(input.sourceTitle ?? existing?.sourceTitle, "证据来源标题"),
        publisher: input.publisher?.trim() || existing?.publisher,
        sourceUrl: requireText(input.sourceUrl ?? existing?.sourceUrl, "证据来源 URL"),
        capturedAt: input.capturedAt ?? existing?.capturedAt ?? now(),
        pageOrRange: input.pageOrRange?.trim() || existing?.pageOrRange,
        excerpt: requireText(input.excerpt ?? existing?.excerpt, "证据原文摘录"),
        claim: requireText(input.claim ?? existing?.claim, "证据支持的主张"),
        limitation: requireText(input.limitation ?? existing?.limitation, "证据适用限制"),
        highlights: normalizeEvidenceHighlights(input.highlights ?? existing?.highlights),
        status: "ready",
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now()
      };
      if (existing) {
        Object.assign(existing, capture);
      } else {
        snapshot.evidenceCaptures.push(capture);
      }
      for (const program of snapshot.explainerPrograms.filter((program) => program.evidenceCaptureId === capture.id)) {
        this.markExplainerProgramStale(snapshot, impact, program, "证据截图、原文或高亮已变化");
      }
      impact.changed.push(capture.id);
      impact.recomputed.push("证据来源、页面快照、高亮和 Explainer 复核范围");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  readEvidenceCapture(input: { projectId: Id; evidenceCaptureId?: Id }): { revision: number; evidenceCaptures: EvidenceCapture[] } {
    const state = this.readProject(input.projectId);
    const captures = input.evidenceCaptureId
      ? state.snapshot.evidenceCaptures.filter((capture) => capture.id === input.evidenceCaptureId)
      : state.snapshot.evidenceCaptures;
    if (input.evidenceCaptureId && captures.length === 0) throw new NotFoundError("EvidenceCapture 不存在");
    return { revision: state.revision.number, evidenceCaptures: captures };
  }

  /** Explainer 编译原子生成 Scene、Program 与 VisualTreatment；不会将每句旁白退化成独立卡片。 */
  compileExplainerScenes(input: {
    projectId: Id;
    baseRevision: number;
    plans: Array<{
      title: string;
      purpose: string;
      startFrame: number;
      endFrame: number;
      narrativeMapBeatId: Id;
      kind: ExplainerSceneKind;
      primaryTask: string;
      assetIds?: Id[];
      evidenceCaptureId?: Id;
      states: Array<Omit<ExplainerSceneState, "id"> & { id?: Id }>;
      props?: Record<string, unknown>;
      stylePackId?: string;
      visualTreatment?: {
        mode?: VisualTreatment["mode"];
        intensity?: VisualTreatment["intensity"];
        primaryAttention?: string;
        narrativePurpose?: string;
        quietReason?: string;
        fallbackPlan?: string;
      };
    }>;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "编译视觉解释场景", (snapshot, impact) => {
      const narrativeMap = snapshot.narrativeMap;
      if (!narrativeMap) throw new DomainError("必须先建立 NarrativeMap，才能编译 Explainer Scene", "NARRATIVE_MAP_REQUIRED");
      if (input.plans.length === 0) throw new DomainError("至少需要一个 Explainer Scene 计划", "EXPLAINER_SCENE_PLAN_REQUIRED");
      const sortedPlans = [...input.plans].sort((left, right) => left.startFrame - right.startFrame);
      for (let index = 0; index < sortedPlans.length; index += 1) {
        const plan = sortedPlans[index]!;
        if (!Number.isInteger(plan.startFrame) || !Number.isInteger(plan.endFrame) || plan.startFrame < 0 || plan.endFrame <= plan.startFrame) {
          throw new DomainError("Explainer Scene 的帧范围无效", "INVALID_EXPLAINER_SCENE_RANGE");
        }
        if (index > 0 && sortedPlans[index - 1]!.endFrame > plan.startFrame) throw new DomainError("主视觉 Explainer Scene 不能重叠", "EXPLAINER_SCENE_OVERLAP");
      }

      const previousPrograms = [...snapshot.explainerPrograms];
      const previousSceneIds = new Set(previousPrograms.map((program) => program.sceneId));
      this.removeCutawaysForHostScenes(snapshot, previousSceneIds, impact);
      const removedCueIds = snapshot.effectCues.filter((cue) => previousSceneIds.has(cue.sceneId)).map((cue) => cue.id);
      const removedItemIds = snapshot.timeline.items.filter((item) => item.sceneId && previousSceneIds.has(item.sceneId)).map((item) => item.id);
      snapshot.effectCues = snapshot.effectCues.filter((cue) => !previousSceneIds.has(cue.sceneId));
      snapshot.timeline.items = snapshot.timeline.items.filter((item) => !previousSceneIds.has(item.sceneId ?? ""));
      snapshot.scenes = snapshot.scenes.filter((scene) => !previousSceneIds.has(scene.id));
      snapshot.explainerPrograms = [];
      for (const storyBeat of snapshot.story.beats) storyBeat.sceneIds = storyBeat.sceneIds.filter((sceneId) => !previousSceneIds.has(sceneId));
      for (const mapBeat of narrativeMap.beats) mapBeat.sceneIds = mapBeat.sceneIds.filter((sceneId) => !previousSceneIds.has(sceneId));
      const treatmentIdsToRemove = new Set<Id>();
      for (const treatment of snapshot.visualTreatments) {
        if (!treatment.sceneId || !previousSceneIds.has(treatment.sceneId)) continue;
        if (treatment.narrativeBeatId) {
          treatment.sceneId = undefined;
          treatment.status = "stale";
          treatment.updatedAt = now();
          impact.stale.push(treatment.id);
        } else {
          treatmentIdsToRemove.add(treatment.id);
        }
      }
      snapshot.visualTreatments = snapshot.visualTreatments.filter((treatment) => !treatmentIdsToRemove.has(treatment.id));
      impact.stale.push(...previousPrograms.map((program) => program.id), ...previousSceneIds, ...removedCueIds, ...removedItemIds, ...treatmentIdsToRemove);

      for (const plan of sortedPlans) {
        const mapBeat = narrativeMap.beats.find((beat) => beat.id === plan.narrativeMapBeatId);
        if (!mapBeat) throw new DomainError("Explainer Scene 引用了不存在的 NarrativeMap Beat", "EXPLAINER_MAP_BEAT_NOT_FOUND");
        const storyBeat = snapshot.story.beats.find((beat) => beat.id === mapBeat.narrativeBeatId);
        if (!storyBeat) throw new DomainError("NarrativeMap Beat 缺少对应 Story Beat", "EXPLAINER_STORY_BEAT_NOT_FOUND");
        const kind = requireExplainerKind(plan.kind);
        const duration = plan.endFrame - plan.startFrame;
        const states = normalizeExplainerStates(plan.states.map((state) => ({ ...state, id: state.id ?? createId("explainer_state") })) as ExplainerSceneState[], duration);
        const props = structuredClone(plan.props ?? {});
        const evidence = plan.evidenceCaptureId ? snapshot.evidenceCaptures.find((capture) => capture.id === plan.evidenceCaptureId) : undefined;
        if (plan.evidenceCaptureId && !evidence) throw new DomainError("Explainer Scene 引用了不存在的 EvidenceCapture", "EXPLAINER_EVIDENCE_NOT_FOUND");
        if (kind === "EvidenceDocument" && !evidence) throw new DomainError("EvidenceDocument 必须绑定真实 EvidenceCapture", "EVIDENCE_DOCUMENT_CAPTURE_REQUIRED");
        // 引语卡只能明确呈现“谁说了什么”，不能借用 EvidenceCapture 把观点包装成已完成事实举证。
        if (kind === "QuotePortrait" && evidence) {
          throw new DomainError("QuotePortrait 不能绑定 EvidenceCapture；请分别建立原文证据场景或明确引用来源", "QUOTE_PORTRAIT_EVIDENCE_CAPTURE_BLOCKED");
        }
        if (kind === "RealityBroll" && evidence) {
          throw new DomainError("RealityBroll 不应绑定 EvidenceCapture；现实素材与文档举证必须保持可审查的不同职责", "REALITY_BROLL_EVIDENCE_CAPTURE_BLOCKED");
        }
        if (kind === "EvidenceDocument" && evidence) {
          const visualAssetId = evidence.snapshotAssetId ?? evidence.sourceAssetId;
          const visualAsset = assetById(snapshot, visualAssetId);
          if (visualAsset.kind !== "image" && visualAsset.kind !== "derived") {
            throw new DomainError("EvidenceDocument 必须绑定真实页面截图，或以图片作为来源本体", "EVIDENCE_DOCUMENT_SNAPSHOT_REQUIRED");
          }
        }
        const sourceAssetIds = [...new Set([...(plan.assetIds ?? []), ...(evidence ? [evidence.sourceAssetId, ...(evidence.snapshotAssetId ? [evidence.snapshotAssetId] : [])] : [])])];
        for (const assetId of sourceAssetIds) {
          const asset = assetById(snapshot, assetId);
          if (asset.status !== "ready") throw new DomainError("Explainer Scene 只能绑定已就绪的项目素材", "EXPLAINER_ASSET_NOT_READY");
        }
        if (kind === "UIWalkthrough") {
          if (sourceAssetIds.length === 0) throw new DomainError("UIWalkthrough 必须绑定真实界面截图或录屏", "UI_WALKTHROUGH_ASSET_REQUIRED");
          if (sourceAssetIds.some((assetId) => assetById(snapshot, assetId).provenance?.source === "generated")) {
            throw new DomainError("UIWalkthrough 不能把生成画面冒充真实产品界面", "UI_WALKTHROUGH_GENERATED_ASSET_BLOCKED");
          }
        }
        if (kind === "DataConclusion") {
          const values = Array.isArray(props.values) ? props.values : [];
          const labels = Array.isArray(props.labels) ? props.labels : [];
          if (values.length === 0 || values.some((value) => typeof value !== "number" || !Number.isFinite(value)) || labels.length !== values.length
            || !asRequiredString(props.source) || !asRequiredString(props.unit) || !asRequiredString(props.baseline)) {
            throw new DomainError("DataConclusion 必须提供同长度数据/标签、来源、单位和基线", "DATA_CONCLUSION_FACTS_REQUIRED");
          }
        }
        if (kind === "ProgressiveClassification" && asStringList(props.items).length < 2) {
          throw new DomainError("ProgressiveClassification 至少需要两项真实分类", "CLASSIFICATION_ITEMS_REQUIRED");
        }
        if (kind === "RouteAndFlow" && asStringList(props.nodes).length < 2) {
          throw new DomainError("RouteAndFlow 至少需要两个持续存在的流程节点", "FLOW_NODES_REQUIRED");
        }
        if (kind === "Comparison" && (!asRequiredString(props.leftLabel) || !asRequiredString(props.rightLabel) || !asRequiredString(props.dimension))) {
          throw new DomainError("Comparison 必须明确双方和比较维度", "COMPARISON_FACTS_REQUIRED");
        }
        if (kind === "HeroReveal" && !asRequiredString(props.metric)) {
          throw new DomainError("HeroReveal 必须提供可核对的核心数字或对象", "HERO_REVEAL_METRIC_REQUIRED");
        }
        if (kind === "PeopleGrouping" && (asStringList(props.groups).length < 2 || !asRequiredString(props.dimension))) {
          throw new DomainError("PeopleGrouping 至少需要两个人群及其分组维度", "PEOPLE_GROUPING_FACTS_REQUIRED");
        }
        if (kind === "LayerStack" && (asStringList(props.layers).length < 2 || !asRequiredString(props.relationship))) {
          throw new DomainError("LayerStack 至少需要两层结构及层间关系说明", "LAYER_STACK_FACTS_REQUIRED");
        }
        if (kind === "HistoryTimeline" && (asHistoryEvents(props.events).length < 2 || !asRequiredString(props.source))) {
          throw new DomainError("HistoryTimeline 至少需要两个含日期的历史节点和可追溯来源", "HISTORY_TIMELINE_FACTS_REQUIRED");
        }
        if (kind === "QuotePortrait") {
          if (!asRequiredString(props.quote) || !asRequiredString(props.attribution) || !asRequiredString(props.source)) {
            throw new DomainError("QuotePortrait 必须说明引语、归属与来源，不能把观点写成无主断言", "QUOTE_PORTRAIT_FACTS_REQUIRED");
          }
          if (sourceAssetIds.length === 0 || sourceAssetIds.some((assetId) => {
            const asset = assetById(snapshot, assetId);
            return !["image", "video"].includes(asset.kind) || asset.provenance?.source === "generated";
          })) {
            throw new DomainError("QuotePortrait 必须绑定已就绪、非生成的真实人物或机构视觉素材", "QUOTE_PORTRAIT_ASSET_REQUIRED");
          }
        }
        if (kind === "RealityBroll" && (sourceAssetIds.length === 0 || sourceAssetIds.some((assetId) => {
          const asset = assetById(snapshot, assetId);
          return !["image", "video"].includes(asset.kind) || asset.provenance?.source === "generated";
        }))) {
          throw new DomainError("RealityBroll 必须绑定已就绪、非生成的本地图片或视频素材", "REALITY_BROLL_ASSET_REQUIRED");
        }

        const stylePackId = plan.stylePackId?.trim() || snapshot.project.stylePackId;
        const scene = createScene({ type: "ExplainerScene", title: requireText(plan.title, "Explainer 场景标题"), purpose: requireText(plan.purpose, "Explainer 场景目的"), startFrame: plan.startFrame, endFrame: plan.endFrame, assetIds: sourceAssetIds });
        scene.narrativeBeatIds = [storyBeat.id];
        scene.status = "ready";
        scene.stylePackId = stylePackId;
        const cacheKey = explainerCacheKey({
          kind,
          primaryTask: requireText(plan.primaryTask, "Explainer 主认知任务"),
          assetHashes: sourceAssetIds.map((assetId) => assetById(snapshot, assetId).sourceHash ?? assetId),
          states,
          props,
          stylePackId,
          renderTarget: {
            fps: snapshot.timeline.fps,
            width: snapshot.timeline.width,
            height: snapshot.timeline.height
          },
          runtimeVersion: EXPLAINER_SCENE_RUNTIME_VERSION,
          // Map / Evidence 是视觉解释的事实输入，纳入缓存键，重编后不会把旧解释画面误复用。
          narrativeMapBeat: mapBeat,
          evidence: evidence ? {
            id: evidence.id,
            sourceAssetId: evidence.sourceAssetId,
            snapshotAssetId: evidence.snapshotAssetId,
            excerpt: evidence.excerpt,
            claim: evidence.claim,
            limitation: evidence.limitation,
            highlights: evidence.highlights
          } : undefined
        });
        const program: ExplainerSceneProgram = {
          id: createId("explainer_program"),
          sceneId: scene.id,
          kind,
          narrativeMapBeatId: mapBeat.id,
          primaryTask: requireText(plan.primaryTask, "Explainer 主认知任务"),
          assetIds: sourceAssetIds,
          evidenceCaptureId: evidence?.id,
          states,
          props,
          cacheKey,
          status: "ready",
          createdAt: now(),
          updatedAt: now()
        };
        snapshot.scenes.push(scene);
        snapshot.explainerPrograms.push(program);
        storyBeat.sceneIds.push(scene.id);
        mapBeat.sceneIds.push(scene.id);
        const treatment = plan.visualTreatment;
        snapshot.visualTreatments.push(createVisualTreatment({
          sceneId: scene.id,
          mode: treatment?.mode ?? (kind === "EvidenceDocument" ? "evidence" : "remotion"),
          primaryAttention: treatment?.primaryAttention?.trim() || program.primaryTask,
          narrativePurpose: treatment?.narrativePurpose?.trim() || scene.purpose,
          intensity: treatment?.intensity ?? "medium",
          quietReason: treatment?.quietReason?.trim() || undefined,
          fallbackPlan: treatment?.fallbackPlan?.trim() || undefined
        }));
        impact.changed.push(scene.id, program.id);
        impact.dirtyRanges.push({ startFrame: scene.startFrame, endFrame: scene.endFrame, reason: `编译 ${kind} 解释场景` });
      }
      impact.recomputed.push("Explainer Scene Registry、VisualTreatment 与场景级缓存键");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 局部退出旧主视觉；不能借此重编 Scene 或重置字幕、音效和其它效果。 */
  setExplainerProgramEnabled(input: { projectId: Id; baseRevision: number; programId: Id; enabled: boolean }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, input.enabled ? "启用场景主视觉" : "停用场景主视觉", (snapshot, impact) => {
      if (typeof input.enabled !== "boolean") throw new DomainError("必须明确主视觉是否启用", "INVALID_EXPLAINER_ENABLED");
      const program = snapshot.explainerPrograms.find((candidate) => candidate.id === input.programId);
      if (!program) throw new NotFoundError("Explainer Scene Program 不存在");
      const scene = snapshot.scenes.find((candidate) => candidate.id === program.sceneId);
      if (!scene || scene.type !== "ExplainerScene") throw new DomainError("Program 没有绑定有效的解释场景", "EXPLAINER_PROGRAM_SCENE_INVALID");
      // 启用不是修复上游事实，不能把 stale Program 或 Scene 变成 ready。
      if (input.enabled && (program.status !== "ready" || scene.status !== "ready")) {
        throw new DomainError("场景主视觉已失效或未就绪，不能直接重新启用", "EXPLAINER_PROGRAM_NOT_READY");
      }
      program.disabled = !input.enabled;
      program.updatedAt = now();
      impact.changed.push(program.id);
      impact.dirtyRanges.push({ startFrame: scene.startFrame, endFrame: scene.endFrame, reason: input.enabled ? "重新启用场景主视觉" : "停用旧场景主视觉，复查底层画面与替代效果" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  readExplainerScenePrograms(input: { projectId: Id; sceneId?: Id }): { revision: number; programs: ExplainerSceneProgram[] } {
    const state = this.readProject(input.projectId);
    const programs = input.sceneId ? state.snapshot.explainerPrograms.filter((program) => program.sceneId === input.sceneId) : state.snapshot.explainerPrograms;
    if (input.sceneId && programs.length === 0) throw new NotFoundError("Explainer Scene Program 不存在");
    return { revision: state.revision.number, programs };
  }

  /** 上游 Map 或证据改变时，保留旧 Program 供审查，但不允许它继续作为 ready 成片渲染。 */
  private markExplainerProgramStale(snapshot: ProjectSnapshot, impact: ImpactReport, program: ExplainerSceneProgram, reason: string): void {
    const scene = snapshot.scenes.find((candidate) => candidate.id === program.sceneId);
    if (program.status !== "stale") {
      program.status = "stale";
      program.updatedAt = now();
      impact.changed.push(program.id);
      impact.stale.push(program.id);
    }
    if (scene && scene.status !== "stale") {
      scene.status = "stale";
      impact.changed.push(scene.id);
      impact.stale.push(scene.id);
    }
    impact.warnings.push(`Explainer Scene「${program.kind}」${reason}，已标记为需重新编译。`);
  }

  createScene(input: { projectId: Id; baseRevision: number; type: SceneType; title: string; purpose: string; startFrame: number; endFrame: number; assetIds?: Id[] }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, `创建场景：${input.title}`, (snapshot, impact) => {
      const scene = createScene(input);
      scene.assetIds.forEach((assetId) => assetById(snapshot, assetId));
      snapshot.scenes.push(scene);
      impact.changed.push(scene.id);
      impact.dirtyRanges.push({ startFrame: scene.startFrame, endFrame: scene.endFrame, reason: "新增场景" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  trimScene(input: { projectId: Id; baseRevision: number; sceneId: Id; endFrame: number }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "缩短场景终点", (snapshot, impact) => {
      const scene = snapshot.scenes.find((candidate) => candidate.id === input.sceneId);
      if (!scene) throw new DomainError("Scene 不存在", "SCENE_NOT_FOUND");
      if (!Number.isInteger(input.endFrame) || input.endFrame <= scene.startFrame || input.endFrame > scene.endFrame) {
        throw new DomainError("只能将 Scene 终点缩短到起点之后", "INVALID_SCENE_RANGE");
      }
      const outside = (start: number, end: number) => start < scene.startFrame || end > input.endFrame;
      // 已放置的画面与效果不得被裁成悬空对象；先调整依赖，再缩短场景。
      if (snapshot.timeline.items.some((item) => item.sceneId === scene.id && outside(item.startFrame, item.endFrame))
        || snapshot.effectCues.some((cue) => cue.sceneId === scene.id && outside(cue.startFrame, cue.endFrame))
        || (snapshot.explainerPrograms ?? []).some((program) => program.sceneId === scene.id
          && program.states.some((phase) => phase.endFrame > input.endFrame - scene.startFrame))
        || (snapshot.cutaways ?? []).some((cutaway) => (cutaway.hostSceneId === scene.id || cutaway.cutawaySceneId === scene.id)
          && outside(cutaway.startFrame, cutaway.endFrame))) {
        throw new DomainError("Scene 终点之后仍有绑定内容，请先调整依赖范围", "SCENE_TRIM_DEPENDENCY_OUT_OF_RANGE");
      }
      const oldEnd = scene.endFrame;
      scene.endFrame = input.endFrame;
      impact.changed.push(scene.id);
      impact.dirtyRanges.push({ startFrame: scene.startFrame, endFrame: oldEnd, reason: "缩短场景终点" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 保存主线稳定后做出的视觉选择。它不直接生成卡片或 B-roll，避免导演意图和物理播放重复存储。
   */
  manageVisualTreatment(input: {
    projectId: Id;
    baseRevision: number;
    action: "upsert" | "remove";
    visualTreatmentId?: Id;
    narrativeBeatId?: Id;
    sceneId?: Id;
    mode?: VisualTreatmentMode;
    primaryAttention?: string;
    narrativePurpose?: string;
    intensity?: VisualTreatmentIntensity;
    quietReason?: string;
    fallbackPlan?: string;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, input.action === "remove" ? "移除视觉处理计划" : "更新视觉处理计划", (snapshot, impact) => {
      if (input.action === "remove") {
        const treatment = visualTreatmentById(snapshot, requireText(input.visualTreatmentId, "VisualTreatment ID"));
        snapshot.visualTreatments = snapshot.visualTreatments.filter((candidate) => candidate.id !== treatment.id);
        for (const cutaway of snapshot.cutaways.filter((candidate) => candidate.visualTreatmentId === treatment.id)) {
          cutaway.visualTreatmentId = undefined;
          this.markCutawayStale(snapshot, cutaway, impact, "失去了原有 VisualTreatment 依据");
        }
        impact.changed.push(treatment.id);
        impact.stale.push(treatment.id);
        return;
      }

      const mode = input.mode;
      const intensity = input.intensity;
      if (!mode || !intensity) throw new DomainError("VisualTreatment 必须指定处理模式和注意力强度", "VISUAL_TREATMENT_REQUIRED");
      if (!input.narrativeBeatId && !input.sceneId) {
        throw new DomainError("VisualTreatment 至少需要关联一个 Story Beat 或 Scene", "VISUAL_TREATMENT_TARGET_REQUIRED");
      }
      if (input.narrativeBeatId && !snapshot.story.beats.some((beat) => beat.id === input.narrativeBeatId)) {
        throw new DomainError("VisualTreatment 引用的 Story Beat 不存在", "VISUAL_TREATMENT_BEAT_NOT_FOUND");
      }
      if (input.sceneId && !snapshot.scenes.some((scene) => scene.id === input.sceneId)) {
        throw new DomainError("VisualTreatment 引用的 Scene 不存在", "VISUAL_TREATMENT_SCENE_NOT_FOUND");
      }

      const existing = input.visualTreatmentId ? visualTreatmentById(snapshot, input.visualTreatmentId) : undefined;
      const primaryAttention = requireText(input.primaryAttention, "第一注意目标");
      const narrativePurpose = requireText(input.narrativePurpose, "视觉叙事目的");
      if (existing) {
        existing.narrativeBeatId = input.narrativeBeatId;
        existing.sceneId = input.sceneId;
        existing.mode = mode;
        existing.primaryAttention = primaryAttention;
        existing.narrativePurpose = narrativePurpose;
        existing.intensity = intensity;
        existing.quietReason = input.quietReason?.trim() || undefined;
        existing.fallbackPlan = input.fallbackPlan?.trim() || undefined;
        existing.status = "ready";
        existing.updatedAt = now();
        impact.changed.push(existing.id);
      } else {
        const treatment = createVisualTreatment({
          narrativeBeatId: input.narrativeBeatId,
          sceneId: input.sceneId,
          mode,
          primaryAttention,
          narrativePurpose,
          intensity,
          quietReason: input.quietReason?.trim() || undefined,
          fallbackPlan: input.fallbackPlan?.trim() || undefined
        });
        snapshot.visualTreatments.push(treatment);
        impact.changed.push(treatment.id);
      }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 创建、调整或移除 Cutaway。每次写入同时维护 CutawayScene 和顶层 Timeline Item，
   * 从而让 Renderer 只消费同一 Revision 的本地 Asset。
   */
  manageCutaway(input: {
    projectId: Id;
    baseRevision: number;
    action: "create" | "update" | "remove";
    cutawayId?: Id;
    hostSceneId?: Id;
    assetId?: Id;
    visualTreatmentId?: Id;
    title?: string;
    mode?: CutawayMode;
    fit?: CutawayFit;
    pipAnchor?: SpatialAnchor;
    pipScale?: number;
    audioMode?: CutawayAudioMode;
    purpose?: string;
    audienceTask?: string;
    sourceStartFrame?: number;
    sourceEndFrame?: number;
    startFrame?: number;
    endFrame?: number;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, input.action === "create" ? "创建 Cutaway" : input.action === "update" ? "调整 Cutaway" : "移除 Cutaway", (snapshot, impact) => {
      if (input.action === "remove") {
        const cutaway = cutawayById(snapshot, requireText(input.cutawayId, "Cutaway ID"));
        const sceneIds = new Set([cutaway.cutawaySceneId]);
        const cueIds = snapshot.effectCues.filter((cue) => sceneIds.has(cue.sceneId)).map((cue) => cue.id);
        snapshot.cutaways = snapshot.cutaways.filter((candidate) => candidate.id !== cutaway.id);
        snapshot.timeline.items = snapshot.timeline.items.filter((item) => item.id !== cutaway.timelineItemId);
        snapshot.effectCues = snapshot.effectCues.filter((cue) => !sceneIds.has(cue.sceneId));
        snapshot.scenes = snapshot.scenes.filter((scene) => !sceneIds.has(scene.id));
        for (const beat of snapshot.story.beats) {
          beat.sceneIds = beat.sceneIds.filter((sceneId) => !sceneIds.has(sceneId));
        }
        const removedTreatmentIds = new Set<Id>();
        for (const treatment of snapshot.visualTreatments) {
          if (treatment.sceneId !== cutaway.cutawaySceneId) continue;
          if (treatment.narrativeBeatId) {
            treatment.sceneId = undefined;
            treatment.status = "stale";
            treatment.updatedAt = now();
            impact.changed.push(treatment.id);
            impact.stale.push(treatment.id);
          } else {
            removedTreatmentIds.add(treatment.id);
          }
        }
        if (removedTreatmentIds.size > 0) {
          snapshot.visualTreatments = snapshot.visualTreatments.filter((treatment) => !removedTreatmentIds.has(treatment.id));
          impact.stale.push(...removedTreatmentIds);
        }
        impact.changed.push(cutaway.id, cutaway.timelineItemId, cutaway.cutawaySceneId);
        impact.stale.push(...cueIds);
        impact.dirtyRanges.push({ startFrame: cutaway.startFrame, endFrame: cutaway.endFrame, reason: "移除 Cutaway" });
        return;
      }

      const topTrack = trackByName(snapshot, "Cutaway / Fullscreen");
      if (topTrack.locked) throw new DomainError("Cutaway / Fullscreen 轨已锁定", "TRACK_LOCKED");

      if (input.action === "create") {
        const hostSceneId = requireText(input.hostSceneId, "Cutaway 主场景 ID");
        const assetId = requireText(input.assetId, "Cutaway 素材 ID");
        const mode = input.mode;
        const fit = input.fit;
        const audioMode = input.audioMode;
        if (!mode || !fit || !audioMode || input.sourceStartFrame === undefined || input.sourceEndFrame === undefined || input.startFrame === undefined || input.endFrame === undefined) {
          throw new DomainError("创建 Cutaway 必须提供模式、适配方式、声音策略及完整源/目标范围", "CUTAWAY_FIELDS_REQUIRED");
        }
        const purpose = requireText(input.purpose, "Cutaway 叙事目的");
        const audienceTask = requireText(input.audienceTask, "Cutaway 观众任务");
        const plan = this.resolveCutawayPlan(snapshot, {
          hostSceneId,
          assetId,
          visualTreatmentId: input.visualTreatmentId,
          mode,
          fit,
          pipAnchor: input.pipAnchor,
          pipScale: input.pipScale,
          sourceStartFrame: input.sourceStartFrame,
          sourceEndFrame: input.sourceEndFrame,
          startFrame: input.startFrame,
          endFrame: input.endFrame
        });
        const cutawayScene = createScene({
          type: "CutawayScene",
          title: input.title?.trim() || `Cutaway：${plan.asset.name}`,
          purpose,
          startFrame: input.startFrame,
          endFrame: input.endFrame,
          assetIds: [plan.asset.id]
        });
        cutawayScene.status = "ready";
        cutawayScene.stylePackId = plan.hostScene.stylePackId;
        const item = createTimelineItem({
          trackId: topTrack.id,
          sceneId: cutawayScene.id,
          assetId: plan.asset.id,
          startFrame: input.startFrame,
          endFrame: input.endFrame,
          sourceStartFrame: input.sourceStartFrame,
          sourceEndFrame: input.sourceEndFrame,
          gainDb: 0
        });
        const cutaway = createCutaway({
          hostSceneId,
          cutawaySceneId: cutawayScene.id,
          timelineItemId: item.id,
          assetId: plan.asset.id,
          visualTreatmentId: input.visualTreatmentId,
          mode,
          fit,
          pipAnchor: mode === "pip" ? input.pipAnchor : undefined,
          pipScale: mode === "pip" ? input.pipScale : undefined,
          audioMode,
          purpose,
          audienceTask,
          sourceStartFrame: input.sourceStartFrame,
          sourceEndFrame: input.sourceEndFrame,
          startFrame: input.startFrame,
          endFrame: input.endFrame
        });
        snapshot.scenes.push(cutawayScene);
        snapshot.timeline.items.push(item);
        snapshot.cutaways.push(cutaway);
        impact.changed.push(cutaway.id, cutawayScene.id, item.id);
        impact.dirtyRanges.push({ startFrame: cutaway.startFrame, endFrame: cutaway.endFrame, reason: "新增 Cutaway" });
        return;
      }

      const cutaway = cutawayById(snapshot, requireText(input.cutawayId, "Cutaway ID"));
      if (input.assetId && input.assetId !== cutaway.assetId) {
        throw new DomainError("替换 Cutaway 素材请使用 replaceSceneAsset，避免漏改 Source Range", "USE_REPLACE_SCENE_ASSET");
      }
      const mode = input.mode ?? cutaway.mode;
      const plan = this.resolveCutawayPlan(snapshot, {
        hostSceneId: input.hostSceneId ?? cutaway.hostSceneId,
        assetId: cutaway.assetId,
        visualTreatmentId: input.visualTreatmentId ?? cutaway.visualTreatmentId,
        mode,
        fit: input.fit ?? cutaway.fit,
        pipAnchor: mode === "pip" ? input.pipAnchor ?? cutaway.pipAnchor : undefined,
        pipScale: mode === "pip" ? input.pipScale ?? cutaway.pipScale : undefined,
        sourceStartFrame: input.sourceStartFrame ?? cutaway.sourceStartFrame,
        sourceEndFrame: input.sourceEndFrame ?? cutaway.sourceEndFrame,
        startFrame: input.startFrame ?? cutaway.startFrame,
        endFrame: input.endFrame ?? cutaway.endFrame
      });
      const cutawayScene = snapshot.scenes.find((scene) => scene.id === cutaway.cutawaySceneId);
      const item = snapshot.timeline.items.find((candidate) => candidate.id === cutaway.timelineItemId);
      if (!cutawayScene || !item) throw new DomainError("Cutaway 缺少可编辑的 Scene 或 Timeline Item", "CUTAWAY_STRUCTURE_MISSING");
      const oldRange = { startFrame: cutaway.startFrame, endFrame: cutaway.endFrame };
      cutaway.hostSceneId = plan.hostScene.id;
      cutaway.visualTreatmentId = input.visualTreatmentId ?? cutaway.visualTreatmentId;
      cutaway.mode = mode;
      cutaway.fit = input.fit ?? cutaway.fit;
      cutaway.pipAnchor = mode === "pip" ? input.pipAnchor ?? cutaway.pipAnchor : undefined;
      cutaway.pipScale = mode === "pip" ? input.pipScale ?? cutaway.pipScale : undefined;
      cutaway.audioMode = input.audioMode ?? cutaway.audioMode;
      cutaway.purpose = input.purpose ? requireText(input.purpose, "Cutaway 叙事目的") : cutaway.purpose;
      cutaway.audienceTask = input.audienceTask ? requireText(input.audienceTask, "Cutaway 观众任务") : cutaway.audienceTask;
      cutaway.sourceStartFrame = input.sourceStartFrame ?? cutaway.sourceStartFrame;
      cutaway.sourceEndFrame = input.sourceEndFrame ?? cutaway.sourceEndFrame;
      cutaway.startFrame = input.startFrame ?? cutaway.startFrame;
      cutaway.endFrame = input.endFrame ?? cutaway.endFrame;
      cutaway.status = "ready";
      cutaway.updatedAt = now();
      cutawayScene.title = input.title?.trim() || cutawayScene.title;
      cutawayScene.purpose = cutaway.purpose;
      cutawayScene.startFrame = cutaway.startFrame;
      cutawayScene.endFrame = cutaway.endFrame;
      cutawayScene.assetIds = [cutaway.assetId];
      cutawayScene.status = "ready";
      item.startFrame = cutaway.startFrame;
      item.endFrame = cutaway.endFrame;
      item.sourceStartFrame = cutaway.sourceStartFrame;
      item.sourceEndFrame = cutaway.sourceEndFrame;
      item.disabled = false;
      impact.changed.push(cutaway.id, cutawayScene.id, item.id);
      impact.dirtyRanges.push({ startFrame: Math.min(oldRange.startFrame, cutaway.startFrame), endFrame: Math.max(oldRange.endFrame, cutaway.endFrame), reason: "调整 Cutaway" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 只替换某一个 Cutaway 的本地源素材和源范围，不触碰主场景或该场景中的 Cue。 */
  replaceSceneAsset(input: {
    projectId: Id;
    baseRevision: number;
    cutawayId: Id;
    assetId: Id;
    sourceStartFrame: number;
    sourceEndFrame: number;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "替换 Cutaway 素材", (snapshot, impact) => {
      const cutaway = cutawayById(snapshot, input.cutawayId);
      const item = snapshot.timeline.items.find((candidate) => candidate.id === cutaway.timelineItemId);
      const scene = snapshot.scenes.find((candidate) => candidate.id === cutaway.cutawaySceneId);
      if (!item || !scene) throw new DomainError("Cutaway 缺少可替换的 Scene 或 Timeline Item", "CUTAWAY_STRUCTURE_MISSING");
      const track = snapshot.timeline.tracks.find((candidate) => candidate.id === item.trackId);
      if (!track || track.locked) throw new DomainError("Cutaway 所在轨道不存在或已锁定", "TRACK_LOCKED");
      this.resolveCutawayPlan(snapshot, {
        hostSceneId: cutaway.hostSceneId,
        assetId: input.assetId,
        visualTreatmentId: cutaway.visualTreatmentId,
        mode: cutaway.mode,
        fit: cutaway.fit,
        pipAnchor: cutaway.pipAnchor,
        pipScale: cutaway.pipScale,
        sourceStartFrame: input.sourceStartFrame,
        sourceEndFrame: input.sourceEndFrame,
        startFrame: cutaway.startFrame,
        endFrame: cutaway.endFrame
      });
      cutaway.assetId = input.assetId;
      cutaway.sourceStartFrame = input.sourceStartFrame;
      cutaway.sourceEndFrame = input.sourceEndFrame;
      cutaway.status = "ready";
      cutaway.updatedAt = now();
      scene.assetIds = [input.assetId];
      scene.status = "ready";
      item.assetId = input.assetId;
      item.sourceStartFrame = input.sourceStartFrame;
      item.sourceEndFrame = input.sourceEndFrame;
      item.disabled = false;
      impact.changed.push(cutaway.id, scene.id, item.id);
      impact.dirtyRanges.push({ startFrame: cutaway.startFrame, endFrame: cutaway.endFrame, reason: "替换 Cutaway 素材" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  createEffectCue(input: {
    projectId: Id;
    baseRevision: number;
    sceneId: Id;
    type: EffectType;
    layer: "rear" | "actor" | "front" | "fullscreen";
    startFrame: number;
    endFrame: number;
    anchorTargetId?: Id;
    note?: string;
    narrativePurpose?: string;
    audienceTask?: string;
    semanticAnchor?: EffectCue["semanticAnchor"];
    coveredNarrativeBeatIds?: Id[];
    spatialAnchor?: EffectCue["spatialAnchor"];
    assetBindings?: EffectAssetBinding[];
    props?: Record<string, unknown>;
    motion?: Partial<EffectMotion>;
    stylePackId?: string;
    qualityRules?: string[];
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, `添加视觉效果：${input.type}`, (snapshot, impact) => {
      const scene = snapshot.scenes.find((candidate) => candidate.id === input.sceneId);
      if (!scene) throw new DomainError("效果所属场景不存在", "SCENE_NOT_FOUND");
      assertEffectCueRange(scene, { startFrame: input.startFrame, endFrame: input.endFrame }, "create");
      // 有结构化语义锚点时，旧字段不再参与校验或持久化。否则一个遗留值会把
      // NarrativeBeat / Scene 锚点误判为不存在的 SpeechSegment。
      const legacyAnchorTargetId = input.semanticAnchor ? undefined : input.anchorTargetId;
      if (legacyAnchorTargetId && !snapshot.speechSegments.some((segment) => segment.id === legacyAnchorTargetId)) {
        throw new DomainError("效果锚点 SpeechSegment 不存在", "ANCHOR_NOT_FOUND");
      }
      const semanticAnchor = input.semanticAnchor;
      if (semanticAnchor?.type === "speech_segment" && semanticAnchor.targetId && !snapshot.speechSegments.some((segment) => segment.id === semanticAnchor.targetId)) {
        throw new DomainError("效果语义锚点 SpeechSegment 不存在", "ANCHOR_NOT_FOUND");
      }
      if (semanticAnchor?.type === "narrative_beat" && semanticAnchor.targetId && !snapshot.story.beats.some((beat) => beat.id === semanticAnchor.targetId)) {
        throw new DomainError("效果语义锚点 Story Beat 不存在", "ANCHOR_NOT_FOUND");
      }
      if (semanticAnchor?.type === "scene" && semanticAnchor.targetId && !snapshot.scenes.some((candidate) => candidate.id === semanticAnchor.targetId)) {
        throw new DomainError("效果语义锚点 Scene 不存在", "ANCHOR_NOT_FOUND");
      }
      for (const binding of input.assetBindings ?? []) {
        const asset = assetById(snapshot, binding.assetId);
        if (asset.status !== "ready") throw new DomainError(`效果素材尚未就绪：${asset.name}`, "EFFECT_ASSET_NOT_READY");
      }
      const cue = createEffectCue({ ...input, anchorTargetId: legacyAnchorTargetId });
      assertEffectCoverage(snapshot, cue);
      this.assertManagedMotionCue(snapshot, cue);
      snapshot.effectCues.push(cue);
      impact.changed.push(cue.id);
      impact.dirtyRanges.push({ startFrame: cue.startFrame, endFrame: cue.endFrame, reason: "新增视觉效果" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  updateEffectCue(input: {
    projectId: Id;
    baseRevision: number;
    cueId: Id;
    startFrame?: number;
    endFrame?: number;
    intensity?: number;
    note?: string;
    narrativePurpose?: string;
    audienceTask?: string;
    semanticAnchor?: EffectCue["semanticAnchor"];
    coveredNarrativeBeatIds?: Id[];
    spatialAnchor?: EffectCue["spatialAnchor"];
    assetBindings?: EffectAssetBinding[];
    props?: Record<string, unknown>;
    motion?: Partial<EffectMotion>;
    stylePackId?: string;
    qualityRules?: string[];
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "调整视觉效果", (snapshot, impact) => {
      const cue = snapshot.effectCues.find((candidate) => candidate.id === input.cueId);
      if (!cue) throw new DomainError("效果不存在", "CUE_NOT_FOUND");
      const scene = snapshot.scenes.find((candidate) => candidate.id === cue.sceneId);
      if (!scene) throw new DomainError("效果所属场景不存在", "SCENE_NOT_FOUND");
      // 先核对合并后的范围，再修改副本；冲突和保存异常不获得参数纠正许可。
      assertEffectCueRange(scene, { startFrame: input.startFrame ?? cue.startFrame, endFrame: input.endFrame ?? cue.endFrame }, "update");
      const previousRange = { startFrame: cue.startFrame, endFrame: cue.endFrame, reason: "清理效果原位置" };
      cue.startFrame = input.startFrame ?? cue.startFrame;
      cue.endFrame = input.endFrame ?? cue.endFrame;
      cue.holdFrame = Math.max(cue.startFrame + 1, Math.floor((cue.startFrame + cue.endFrame) / 2));
      cue.intensity = input.intensity ?? cue.intensity;
      cue.note = input.note ?? cue.note;
      cue.narrativePurpose = input.narrativePurpose?.trim() || cue.narrativePurpose;
      cue.audienceTask = input.audienceTask?.trim() || cue.audienceTask;
      cue.spatialAnchor = input.spatialAnchor ?? cue.spatialAnchor;
      cue.props = input.props ?? cue.props;
      cue.stylePackId = input.stylePackId?.trim() || cue.stylePackId;
      cue.qualityRules = input.qualityRules ?? cue.qualityRules;
      if (input.coveredNarrativeBeatIds !== undefined) cue.coveredNarrativeBeatIds = [...new Set(input.coveredNarrativeBeatIds)];
      if (input.semanticAnchor) {
        const anchor = input.semanticAnchor;
        if (anchor.type === "speech_segment" && anchor.targetId && !snapshot.speechSegments.some((segment) => segment.id === anchor.targetId)) {
          throw new DomainError("效果语义锚点 SpeechSegment 不存在", "ANCHOR_NOT_FOUND");
        }
        if (anchor.type === "narrative_beat" && anchor.targetId && !snapshot.story.beats.some((beat) => beat.id === anchor.targetId)) {
          throw new DomainError("效果语义锚点 Story Beat 不存在", "ANCHOR_NOT_FOUND");
        }
        if (anchor.type === "scene" && anchor.targetId && !snapshot.scenes.some((candidate) => candidate.id === anchor.targetId)) {
          throw new DomainError("效果语义锚点 Scene 不存在", "ANCHOR_NOT_FOUND");
        }
        cue.semanticAnchor = anchor;
        // 历史 Cue 从旧字段升级到结构化锚点后，不能继续让旧 SpeechSegment
        // 参与 Script stale 检测或图校验。
        cue.anchorTargetId = undefined;
      }
      if (input.assetBindings) {
        for (const binding of input.assetBindings) {
          const asset = assetById(snapshot, binding.assetId);
          if (asset.status !== "ready") throw new DomainError(`效果素材尚未就绪：${asset.name}`, "EFFECT_ASSET_NOT_READY");
        }
        cue.assetBindings = input.assetBindings;
      }
      if (input.motion) {
        cue.motion = {
          ...cue.motion,
          ...input.motion,
          enterFrames: Math.max(cue.type === "ManagedMotion" ? 0 : 1, input.motion.enterFrames ?? cue.motion.enterFrames),
          holdFrames: Math.max(0, input.motion.holdFrames ?? cue.motion.holdFrames),
          exitFrames: Math.max(cue.type === "ManagedMotion" ? 0 : 1, input.motion.exitFrames ?? cue.motion.exitFrames)
        };
      }
      assertEffectCoverage(snapshot, cue);
      this.assertManagedMotionCue(snapshot, cue);
      if (cue.type !== "ManagedMotion" && cue.coveredNarrativeBeatIds === undefined
        || input.coveredNarrativeBeatIds !== undefined || input.assetBindings !== undefined) cue.status = "ready";
      impact.changed.push(cue.id);
      impact.dirtyRanges.push(previousRange);
      impact.dirtyRanges.push({ startFrame: cue.startFrame, endFrame: cue.endFrame, reason: "调整视觉效果" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 只移除当前 Cue，保留源码 Asset 和历史 Revision，不能用整片回退替代局部编辑。 */
  removeEffectCue(input: { projectId: Id; baseRevision: number; cueId: Id }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "移除单个视觉效果", (snapshot, impact) => {
      const cue = snapshot.effectCues.find((candidate) => candidate.id === input.cueId);
      if (!cue) throw new DomainError("效果不存在", "CUE_NOT_FOUND");
      snapshot.effectCues = snapshot.effectCues.filter((candidate) => candidate.id !== cue.id);
      impact.changed.push(cue.id);
      impact.dirtyRanges.push({ startFrame: cue.startFrame, endFrame: cue.endFrame, reason: "移除视觉效果" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * Timeline 变化后优先按语义锚点重新定位 Cue；不能安全推导的位置明确标 stale，
   * 而不是保留一个看似有效、实际已经漂移的绝对帧范围。
   */
  private recompileCueFromAnchor(snapshot: ProjectSnapshot, cue: EffectCue, previousScene: { startFrame: number; endFrame: number }, scene: { startFrame: number; endFrame: number }, impact: ImpactReport): void {
    const oldStart = cue.startFrame;
    const oldEnd = cue.endFrame;
    const duration = oldEnd - oldStart;
    if (cue.status === "stale" && (cue.type === "ManagedMotion" || cue.coveredNarrativeBeatIds !== undefined)) return;
    const fit = (startFrame: number, desiredDuration = duration) => {
      if (cue.type === "ManagedMotion") {
        if (desiredDuration !== duration || startFrame < scene.startFrame || startFrame + duration > scene.endFrame
          || scene.endFrame - scene.startFrame !== previousScene.endFrame - previousScene.startFrame) return undefined;
        return { start: startFrame, end: startFrame + duration };
      }
      const start = Math.max(scene.startFrame, Math.min(startFrame, scene.endFrame - 1));
      const end = Math.min(scene.endFrame, start + Math.max(1, desiredDuration));
      if (end <= start) return undefined;
      return { start, end };
    };
    let next: { start: number; end: number } | undefined;
    // 未升级的旧 Revision 没有 semanticAnchor；仅在这种情况下回退解释旧字段。
    const anchor = cue.semanticAnchor ?? {
      type: cue.anchorTargetId ? "speech_segment" as const : "scene" as const,
      targetId: cue.anchorTargetId ?? cue.sceneId,
      relation: "land_on" as const
    };
    if (cue.type === "ManagedMotion" && anchor.type !== "absolute"
      && scene.endFrame - scene.startFrame === previousScene.endFrame - previousScene.startFrame) {
      next = fit(oldStart + scene.startFrame - previousScene.startFrame);
    } else if (anchor.type === "scene") {
      const relativeStart = oldStart - previousScene.startFrame;
      next = fit(scene.startFrame + relativeStart);
    } else if (anchor.type === "speech_segment" && anchor.targetId) {
      const timing = snapshot.speechAsset?.timing.segments.find((segment) => segment.speechSegmentId === anchor.targetId);
      if (timing) {
        if (anchor.relation === "anticipate") next = fit(timing.startFrame - duration);
        else if (anchor.relation === "react_after") next = fit(timing.endFrame);
        else if (anchor.relation === "hold_through") next = fit(timing.startFrame, timing.endFrame - timing.startFrame);
        else next = fit(timing.startFrame);
      }
    } else if (anchor.type === "narrative_beat" && anchor.targetId) {
      const beat = snapshot.story.beats.find((candidate) => candidate.id === anchor.targetId);
      const anchorScene = beat?.sceneIds.map((sceneId) => snapshot.scenes.find((candidate) => candidate.id === sceneId)).find((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
      if (anchorScene) next = fit(anchor.relation === "react_after" ? anchorScene.endFrame - duration : anchorScene.startFrame);
    } else if (anchor.type === "absolute") {
      next = oldStart >= scene.startFrame && oldEnd <= scene.endFrame ? { start: oldStart, end: oldEnd } : undefined;
    }
    if (!next) {
      cue.status = "stale";
      impact.stale.push(cue.id);
      impact.warnings.push(`效果 ${cue.type} 无法根据 ${anchor.type} 锚点安全重算，已标记为需复核。`);
      return;
    }
    cue.startFrame = next.start;
    cue.endFrame = next.end;
    cue.holdFrame = Math.max(cue.startFrame + 1, Math.floor((cue.startFrame + cue.endFrame) / 2));
    cue.status = "ready";
    if (cue.startFrame !== oldStart || cue.endFrame !== oldEnd) {
      impact.changed.push(cue.id);
      impact.dirtyRanges.push({ startFrame: Math.min(oldStart, cue.startFrame), endFrame: Math.max(oldEnd, cue.endFrame), reason: "按语义锚点重算 EffectCue" });
    }
  }

  /**
   * 手工移动顶层 Cutaway 时同步其导演记录；移动主场景时则不擅自猜测 B-roll 是否仍相关。
   */
  private reconcileCutawaysAfterTimelineMove(snapshot: ProjectSnapshot, affectedItemIds: Set<Id>, affectedSceneIds: Set<Id>, impact: ImpactReport): void {
    for (const cutaway of snapshot.cutaways) {
      const item = snapshot.timeline.items.find((candidate) => candidate.id === cutaway.timelineItemId);
      const cutawayScene = snapshot.scenes.find((candidate) => candidate.id === cutaway.cutawaySceneId);
      const hostScene = snapshot.scenes.find((candidate) => candidate.id === cutaway.hostSceneId);
      if (!item || !cutawayScene || !hostScene) continue;

      if (affectedItemIds.has(item.id)) {
        cutaway.startFrame = item.startFrame;
        cutaway.endFrame = item.endFrame;
        cutaway.sourceStartFrame = item.sourceStartFrame;
        cutaway.sourceEndFrame = item.sourceEndFrame;
        cutaway.updatedAt = now();
        if (item.startFrame < hostScene.startFrame || item.endFrame > hostScene.endFrame) {
          this.markCutawayStale(snapshot, cutaway, impact, "移动后已超出主场景范围");
        } else {
          cutaway.status = "ready";
          cutawayScene.status = "ready";
          impact.changed.push(cutaway.id, cutawayScene.id);
        }
      } else if (affectedSceneIds.has(hostScene.id)) {
        this.markCutawayStale(snapshot, cutaway, impact, "主线时间或场景边界已变化");
      }
    }
  }

  /** Timeline Item 的移动会收口关联 Scene，并按 Cue 的语义锚点重编译可推导的视觉时序。 */
  private propagateTimelineMove(snapshot: ProjectSnapshot, affectedItemIds: Set<Id>, impact: ImpactReport): void {
    const affectedSceneIds = new Set(snapshot.timeline.items.filter((item) => affectedItemIds.has(item.id) && item.sceneId).map((item) => item.sceneId as Id));
    for (const sceneId of affectedSceneIds) {
      const scene = snapshot.scenes.find((candidate) => candidate.id === sceneId);
      if (!scene) continue;
      const previousScene = { startFrame: scene.startFrame, endFrame: scene.endFrame };
      const items = snapshot.timeline.items.filter((item) => item.sceneId === scene.id && !item.disabled).sort((left, right) => left.startFrame - right.startFrame);
      if (items.length === 0) {
        scene.status = "stale";
        impact.stale.push(scene.id);
        continue;
      }
      scene.startFrame = items[0]!.startFrame;
      scene.endFrame = items.reduce((latest, item) => Math.max(latest, item.endFrame), scene.startFrame + 1);
      scene.assetIds = [...new Set(items.map((item) => item.assetId))];
      impact.changed.push(scene.id);
      for (const cue of snapshot.effectCues.filter((candidate) => candidate.sceneId === scene.id)) {
        this.recompileCueFromAnchor(snapshot, cue, previousScene, scene, impact);
      }
    }
    this.reconcileCutawaysAfterTimelineMove(snapshot, affectedItemIds, affectedSceneIds, impact);
    if (affectedSceneIds.size > 0) {
      impact.recomputed.push("Scene 范围、EffectCue 语义锚点、Cutaway stale；字幕继续服从 SpeechTiming");
    }
  }

  moveItem(input: { projectId: Id; baseRevision: number; itemId: Id; startFrame: number; ripple?: boolean }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "移动时间线片段", (snapshot, impact) => {
      const item = snapshot.timeline.items.find((candidate) => candidate.id === input.itemId);
      if (!item) throw new DomainError("时间线片段不存在", "ITEM_NOT_FOUND");
      if (snapshot.audioCues.some((cue) => cue.timelineItemId === item.id)) {
        throw new DomainError("BGM / SFX 必须通过 manage_audio 修改，不能直接移动后丢失事件与 Duck 关系", "MANAGED_AUDIO_ITEM_DIRECT_MOVE");
      }
      const movedCutaway = snapshot.cutaways.find((cutaway) => cutaway.timelineItemId === item.id);
      if (movedCutaway?.status === "stale") {
        throw new DomainError("该 Cutaway 已因主线变化失效，请先通过 manage_cutaways 重新确认范围", "CUTAWAY_STALE_NEEDS_REVIEW");
      }
      const track = snapshot.timeline.tracks.find((candidate) => candidate.id === item.trackId);
      if (!track || track.locked) throw new DomainError("轨道不存在或已锁定", "TRACK_LOCKED");
      const oldStart = item.startFrame;
      const duration = item.endFrame - item.startFrame;
      const delta = input.startFrame - oldStart;
      const affectedItemIds = new Set<Id>([item.id]);
      if (input.startFrame < 0) throw new DomainError("片段不能移动到时间线起点之前", "INVALID_ITEM_RANGE");
      item.startFrame = input.startFrame;
      item.endFrame = input.startFrame + duration;
      impact.changed.push(item.id);
      if (input.ripple && delta !== 0) {
        for (const sibling of snapshot.timeline.items) {
          if (sibling.trackId === item.trackId && sibling.id !== item.id && sibling.startFrame >= oldStart) {
            sibling.startFrame += delta;
            sibling.endFrame += delta;
            impact.moved.push(sibling.id);
            affectedItemIds.add(sibling.id);
          }
        }
      }
      this.propagateTimelineMove(snapshot, affectedItemIds, impact);
      if (track.kind === "video" || track.name === "Dialogue") {
        this.staleAudioCuesForMainline(snapshot, impact, "主线 Timeline Item 已移动");
      }
      impact.dirtyRanges.push({ startFrame: Math.min(oldStart, item.startFrame), endFrame: Math.max(oldStart + duration, item.endFrame), reason: "移动时间线片段" });
      if (!input.ripple) impact.warnings.push("未启用 ripple；请检查独立轨道和主轨之间是否留下空隙。");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  submitVoiceSynthesis(input: { projectId: Id; voiceReferenceId?: Id; voiceReferenceAssetId?: Id; speechSegmentIds?: Id[]; idempotencyKey?: string }): JobRecord {
    const state = this.readProject(input.projectId);
    const reference = input.voiceReferenceId
      ? state.snapshot.voiceReferences.find((candidate) => candidate.id === input.voiceReferenceId)
      : state.snapshot.voiceReferences.find((candidate) => candidate.assetId === input.voiceReferenceAssetId);
    if ((input.voiceReferenceId || input.voiceReferenceAssetId) && !reference) throw new DomainError("指定的 VoiceReference 未登记", "VOICE_REFERENCE_NOT_FOUND");
    if (reference && !reference.usable) throw new DomainError("VoiceReference 当前不可用于 OmniVoice，请先更换或重新分析参考音频", "VOICE_REFERENCE_UNUSABLE");
    const voiceReference = reference ? assetById(state.snapshot, reference.assetId) : undefined;
    if (voiceReference && (voiceReference.kind !== "audio" || voiceReference.status !== "ready")) {
      throw new DomainError("VoiceReference 必须是已就绪的音频素材", "INVALID_VOICE_REFERENCE");
    }
    const changedSegments = state.snapshot.speechSegments.filter((segment) => segment.status !== "ready").map((segment) => segment.id);
    const hasCachedAssetsForAllSegments = state.snapshot.speechSegments.every((segment) => state.snapshot.speechSegmentAssets.some((asset) => asset.speechSegmentId === segment.id));
    // Script 只发生重排时可复用所有 SegmentAsset，只重新组装 SpeechAsset；不浪费调用 OmniVoice 的成本。
    const segments = input.speechSegmentIds ?? changedSegments;
    if (segments.length === 0 && (state.snapshot.speechAsset || !hasCachedAssetsForAllSegments)) {
      throw new DomainError("没有需要生成或可重新组装的 SpeechSegment", "NO_SPEECH_SEGMENTS");
    }
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "voice_synthesis",
      // 省略参考参数时使用服务端配置；不能把默认音色伪造为项目里的 Asset。
      payload: { voiceReferenceId: reference?.id, voiceReferenceAssetId: reference?.assetId, speechSegmentIds: segments, scriptRevision: state.snapshot.script.revision, workflowId: reference ? "ba6238d0-3ee4-41d5-a1f4-a2aefc3933ce" : "omnivoice-default-reference-v1" },
      idempotencyKey: input.idempotencyKey ?? `voice:${reference?.id ?? "server-default"}:${state.snapshot.script.revision}:${segments.join(",")}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /** 只复用已就绪的段音频；先验证完整顺序与画幅边界，再交媒体 Worker 生成新的可播放总轨。 */
  submitSpeechPlacement(input: { projectId: Id; baseRevision: number; placements: Array<{ speechSegmentId: Id; startFrame: number }>; durationFrames?: number; idempotencyKey: string }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, state.revision.number);
    const speech = state.snapshot.speechAsset;
    if (!speech || speech.status !== "ready" || speech.scriptRevision !== state.snapshot.script.revision) throw new DomainError("当前旁白未就绪或与 Script 不一致", "SPEECH_ASSET_NOT_READY");
    const ordered = state.snapshot.speechSegments.slice().sort((a, b) => a.order - b.order);
    if (input.placements.length !== ordered.length || input.placements.some((p, i) => p.speechSegmentId !== ordered[i]?.id)) throw new DomainError("必须按 Script 顺序提供全部 SpeechSegment", "SPEECH_PLACEMENT_INCOMPLETE");
    const frameLimit = Math.max(...state.snapshot.scenes.map((scene) => scene.endFrame), state.snapshot.timeline.durationInFrames);
    let previousEnd = 0;
    for (const placement of input.placements) {
      const segmentAsset = state.snapshot.speechSegmentAssets.find((a) => a.speechSegmentId === placement.speechSegmentId && speech.segmentAssetIds.includes(a.id));
      if (!segmentAsset || !state.snapshot.assets.some((a) => a.id === segmentAsset.assetId && a.status === "ready")) throw new DomainError("段音频未就绪", "SPEECH_SEGMENT_ASSET_NOT_READY");
      const durationFrames = millisecondsToFrames(segmentAsset.durationMs, state.snapshot.timeline.fps);
      if (!Number.isInteger(placement.startFrame) || placement.startFrame < previousEnd || placement.startFrame + durationFrames > frameLimit) throw new DomainError("段起点重叠或超出场景", "INVALID_SPEECH_PLACEMENT");
      previousEnd = placement.startFrame + durationFrames;
    }
    if (input.durationFrames !== undefined && (!Number.isInteger(input.durationFrames) || input.durationFrames < previousEnd || input.durationFrames > frameLimit)) throw new DomainError("旁白总轨时长小于末段或超出场景", "INVALID_SPEECH_PLACEMENT_DURATION");
    const job = this.repository.createJob({ projectId: input.projectId, kind: "speech_assembly", payload: { requestedRevision: input.baseRevision, speechAssetId: speech.id, scriptRevision: speech.scriptRevision, placements: input.placements, durationFrames: input.durationFrames }, idempotencyKey: input.idempotencyKey });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /** Worker 的新总轨与精确段时间在同一 Revision 提交，避免声音和字幕分离。 */
  completeSpeechPlacement(input: { projectId: Id; requestedRevision: number; previousSpeechAssetId: Id; speechFile: Asset; speechAsset: SpeechAsset }): ProjectState {
    const state = this.repository.commit(input.projectId, input.requestedRevision, "按指定帧重排旁白", (snapshot, impact) => {
      if (snapshot.speechAsset?.id !== input.previousSpeechAssetId || snapshot.script.revision !== input.speechAsset.scriptRevision) throw new DomainError("旁白或 Script 已变化", "STALE_SPEECH_PLACEMENT");
      snapshot.assets.push(input.speechFile);
      if (snapshot.speechAlignment) { markSpeechAlignmentStale(snapshot, impact, "旁白总轨已重排"); snapshot.speechAlignment = undefined; }
      const synced = this.syncSpeechAssetTimeline(snapshot, input.speechAsset);
      this.staleAudioCuesForMainline(snapshot, impact, "旁白段级时序已变化");
      impact.changed.push(input.speechFile.id, input.speechAsset.id, synced.dialogueItem.id, ...synced.replacedItemIds);
      impact.recomputed.push("SpeechTiming、Dialogue 总轨和稳定字幕");
      impact.dirtyRanges.push({ startFrame: 0, endFrame: Math.max(snapshot.timeline.durationInFrames, synced.durationFrames), reason: "旁白段级重排" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 提交当前完整 Dialogue 的候选处理。这里不写 Revision、更不自动替换旁白：
   * “参数达标”不是“声音更好”，必须先由操作者真实试听三种版本。
   */
  submitDialogueProcessing(input: {
    projectId: Id;
    baseRevision: number;
    issueTypes: DialogueProcessingIssue[];
    evidenceNote: string;
    idempotencyKey?: string;
  }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, state.revision.number);
    const issueTypes = [...new Set(input.issueTypes)];
    if (issueTypes.length === 0 || issueTypes.length > DIALOGUE_PROCESSING_ISSUES.size
      || issueTypes.some((issue) => !DIALOGUE_PROCESSING_ISSUES.has(issue))) {
      throw new DomainError("Dialogue Processing 必须明确选择至少一个实际待解决的噪声、低频、齿音、响度或峰值问题", "DIALOGUE_PROCESSING_ISSUES_REQUIRED");
    }
    const evidenceNote = requireText(input.evidenceNote, "Dialogue Processing 审阅依据");
    if (evidenceNote.length > 2_000) throw new DomainError("Dialogue Processing 审阅依据不能超过 2000 个字符", "DIALOGUE_PROCESSING_EVIDENCE_TOO_LONG");
    const speechAsset = state.snapshot.speechAsset;
    if (!speechAsset || speechAsset.status !== "ready" || speechAsset.scriptRevision !== state.snapshot.script.revision) {
      throw new DomainError("必须先得到与当前 Script 一致的 SpeechAsset，才能处理 Dialogue", "DIALOGUE_SPEECH_ASSET_NOT_READY");
    }
    const source = readySpeechFile(state.snapshot, speechAsset);
    currentDialogueItem(state.snapshot, speechAsset);
    const payload: DialogueProcessingJobPayload = {
      requestedRevision: state.revision.number,
      speechAssetId: speechAsset.id,
      sourceAssetId: source.id,
      scriptRevision: speechAsset.scriptRevision,
      sourceDurationMs: source.metadata!.durationMs,
      issueTypes,
      evidenceNote,
      processingVersion: "v1"
    };
    const requestHash = createHash("sha256").update(stableJson(payload)).digest("hex").slice(0, 24);
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "dialogue_processing",
      payload,
      idempotencyKey: input.idempotencyKey ?? `dialogue_processing:${state.revision.number}:${requestHash}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /**
   * Worker 只负责生成与验证本地 WAV；Application 才可将候选登记到当前 SpeechAsset。
   * 完成后仍保留原声作为 active Dialogue，选择操作另行产生 Revision。
   */
  completeDialogueProcessing(input: {
    projectId: Id;
    jobId: Id;
    variants: CompletedDialogueProcessingVariant[];
  }): { state: ProjectState; processing: DialogueProcessing; duplicate: boolean } {
    const job = this.repository.getJob(input.jobId);
    if (job.projectId !== input.projectId || job.kind !== "dialogue_processing") {
      throw new DomainError("该任务不是当前项目的 Dialogue Processing 任务", "DIALOGUE_PROCESSING_JOB_NOT_FOUND");
    }
    const currentAtStart = this.readProject(input.projectId);
    const existing = currentAtStart.snapshot.speechAsset?.dialogueProcessing;
    // 项目快照先于 Job 回执持久化时，进程若恰在两者之间中断，下一次调用应恢复同一结果，
    // 而不是把已登记候选当成过期输入并再次生成或标记失败。
    if (existing?.jobId === job.id) {
      if (typeof job.result?.dialogueProcessingJobId !== "string") {
        this.repository.updateJob(job.id, {
          status: job.status,
          result: {
            ...(job.result ?? {}),
            dialogueProcessingJobId: job.id,
            speechAssetId: currentAtStart.snapshot.speechAsset!.id,
            sourceAssetId: existing.sourceAssetId,
            revision: currentAtStart.revision.number
          }
        });
      }
      return { state: currentAtStart, processing: existing, duplicate: true };
    }
    if (typeof job.result?.dialogueProcessingJobId === "string") {
      throw new DomainError("Dialogue Processing Job 已有完成回执，但当前 SpeechAsset 缺少对应候选", "DIALOGUE_PROCESSING_COMPLETION_CORRUPTED");
    }
    const payload = job.payload as Partial<DialogueProcessingJobPayload>;
    const issueTypes = Array.isArray(payload.issueTypes) ? payload.issueTypes : [];
    if (!Number.isInteger(payload.requestedRevision) || !payload.speechAssetId?.trim() || !payload.sourceAssetId?.trim()
      || !Number.isInteger(payload.scriptRevision) || !Number.isInteger(payload.sourceDurationMs) || (payload.sourceDurationMs ?? 0) <= 0
      || !payload.evidenceNote?.trim() || payload.processingVersion !== "v1" || issueTypes.length === 0
      || issueTypes.some((issue) => typeof issue !== "string" || !DIALOGUE_PROCESSING_ISSUES.has(issue as DialogueProcessingIssue))) {
      throw new DomainError("Dialogue Processing Job 缺少受管的旁白来源、问题或审阅依据", "DIALOGUE_PROCESSING_JOB_PAYLOAD_INVALID");
    }
    const normalizedIssues = [...new Set(issueTypes as DialogueProcessingIssue[])];
    const profiles = ["minimal", "strong"] as const;
    const variantsByProfile = new Map(input.variants.map((variant) => [variant.profile, variant]));
    if (variantsByProfile.size !== profiles.length || profiles.some((profile) => !variantsByProfile.has(profile))) {
      throw new DomainError("Dialogue Processing Worker 必须同时交付最小处理和强处理两个候选", "DIALOGUE_PROCESSING_VARIANTS_INCOMPLETE");
    }
    const current = this.readProject(input.projectId);
    if (current.revision.number !== payload.requestedRevision) {
      throw new DomainError("Dialogue Processing 期间项目 Revision 已变化；不能把旧旁白候选写入当前版本", "STALE_DIALOGUE_PROCESSING_REQUEST");
    }
    const speechAsset = current.snapshot.speechAsset;
    if (!speechAsset || speechAsset.id !== payload.speechAssetId || speechAsset.assetId !== payload.sourceAssetId
      || speechAsset.scriptRevision !== payload.scriptRevision) {
      throw new DomainError("Dialogue Processing 的 SpeechAsset、原声文件或 Script 已变化，不能自动登记旧候选", "STALE_DIALOGUE_PROCESSING_SOURCE");
    }
    const source = readySpeechFile(current.snapshot, speechAsset);
    const dialogueItem = currentDialogueItem(current.snapshot, speechAsset);
    if (source.metadata!.durationMs !== payload.sourceDurationMs) {
      throw new DomainError("Dialogue Processing 的原声音频时长已变化，不能继续登记候选", "STALE_DIALOGUE_PROCESSING_DURATION");
    }
    const expectedFrames = dialogueItem.endFrame - dialogueItem.startFrame;
    const projectRoot = resolve(current.snapshot.project.rootPath);
    for (const profile of profiles) {
      const variant = variantsByProfile.get(profile)!;
      const outputPath = resolve(variant.path);
      const relativeOutput = relative(projectRoot, outputPath).replace(/\\/gu, "/");
      if (!isAbsolute(variant.path) || !relativeOutput || relativeOutput === ".." || relativeOutput.startsWith("../")
        || !relativeOutput.startsWith(`assets/speech/processed/${job.id}/`) || !existsSync(outputPath)
        || variant.relativePath.replace(/\\/gu, "/") !== relativeOutput) {
        throw new DomainError("Dialogue Processing Worker 输出不在当前项目的受管 Speech 目录中或文件不存在", "DIALOGUE_PROCESSING_OUTPUT_PATH_INVALID");
      }
      if (!variant.contentHash || !Number.isInteger(variant.durationMs) || variant.durationMs <= 0
        || variant.metadata?.durationMs !== variant.durationMs || !variant.metadata?.hasAudio || !variant.metadata.audioCodec
        || !Array.isArray(variant.filters) || variant.filters.length === 0
        || millisecondsToFrames(variant.durationMs, current.snapshot.timeline.fps) !== expectedFrames
        || Math.abs(variant.durationMs - payload.sourceDurationMs) > DIALOGUE_PROCESSING_MAX_DURATION_DRIFT_MS) {
        throw new DomainError("Dialogue Processing 候选缺少有效哈希、音轨、滤镜或与原 Dialogue 一致的帧时长", "DIALOGUE_PROCESSING_OUTPUT_INVALID");
      }
    }
    let processing!: DialogueProcessing;
    const state = this.repository.commit(input.projectId, current.revision.number, "登记 Dialogue Processing 候选", (snapshot, impact) => {
      const activeSpeech = snapshot.speechAsset;
      if (!activeSpeech || activeSpeech.id !== payload.speechAssetId || activeSpeech.assetId !== payload.sourceAssetId
        || activeSpeech.scriptRevision !== payload.scriptRevision) {
        throw new DomainError("提交期间当前 SpeechAsset 已变化，不能登记 Dialogue Processing 候选", "STALE_DIALOGUE_PROCESSING_SOURCE");
      }
      const sourceAsset = readySpeechFile(snapshot, activeSpeech);
      const activeDialogueItem = currentDialogueItem(snapshot, activeSpeech);
      if (activeDialogueItem.endFrame - activeDialogueItem.startFrame !== expectedFrames) {
        throw new DomainError("提交期间 Dialogue 时长已变化，不能登记 Dialogue Processing 候选", "STALE_DIALOGUE_PROCESSING_DURATION");
      }
      const createdAssets = new Map<Exclude<DialogueProcessingProfile, "original">, Asset>();
      for (const profile of profiles) {
        const variant = variantsByProfile.get(profile)!;
        const asset = createMediaAsset({
          name: `${sourceAsset.name} · ${profile === "minimal" ? "最小处理" : "强处理"}`,
          kind: "speech",
          managedPath: variant.relativePath,
          sourceHash: variant.contentHash,
          tags: ["dialogue-processing", profile],
          provenance: {
            ...structuredClone(sourceAsset.provenance ?? { source: "local_import" as const, acquiredAt: now() }),
            originalAssetId: sourceAsset.id,
            acquiredAt: now()
          }
        });
        asset.status = "ready";
        asset.metadata = structuredClone(variant.metadata);
        snapshot.assets.push(asset);
        createdAssets.set(profile, asset);
        impact.changed.push(asset.id);
      }
      processing = {
        jobId: job.id,
        requestedRevision: payload.requestedRevision!,
        sourceAssetId: sourceAsset.id,
        sourceDurationMs: sourceAsset.metadata!.durationMs,
        issueTypes: normalizedIssues,
        evidenceNote: payload.evidenceNote!.trim(),
        processingVersion: "v1",
        variants: [
          { profile: "original", assetId: sourceAsset.id, filters: [], durationMs: sourceAsset.metadata!.durationMs, contentHash: sourceAsset.sourceHash },
          ...profiles.map((profile): DialogueProcessingVariant => {
            const variant = variantsByProfile.get(profile)!;
            return { profile, assetId: createdAssets.get(profile)!.id, filters: [...variant.filters], durationMs: variant.durationMs, contentHash: variant.contentHash };
          })
        ],
        createdAt: now()
      };
      activeSpeech.dialogueProcessing = processing;
      impact.changed.push(activeSpeech.id);
      impact.recomputed.push("Dialogue 原声、最小处理与强处理试听候选；当前仍保留原声，等待人工选择");
      impact.warnings.push("处理参数和技术读数不能代替试听；请比较原声、最小处理与强处理后再显式选择当前 Dialogue。");
    });
    const updatedJob = this.repository.updateJob(job.id, {
      status: job.status,
      result: { ...(job.result ?? {}), dialogueProcessingJobId: job.id, speechAssetId: payload.speechAssetId, sourceAssetId: payload.sourceAssetId, revision: state.revision.number }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    this.publish({ projectId: updatedJob.projectId, revision: state.revision.number, type: "job" });
    return { state, processing, duplicate: false };
  }

  /** 只有真实试听后的显式选择才会替换当前 Dialogue Item；候选生成本身不改成片。 */
  selectDialogueProcessingVariant(input: {
    projectId: Id;
    baseRevision: number;
    profile: DialogueProcessingProfile;
  }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "选择 Dialogue Processing 候选", (snapshot, impact) => {
      const speechAsset = snapshot.speechAsset;
      const processing = speechAsset?.dialogueProcessing;
      if (!speechAsset || !processing) throw new DomainError("当前 SpeechAsset 没有可选择的 Dialogue Processing 候选", "DIALOGUE_PROCESSING_NOT_FOUND");
      const variant = processing.variants.find((candidate) => candidate.profile === input.profile);
      if (!variant) throw new DomainError("请求的 Dialogue Processing 候选不存在", "DIALOGUE_PROCESSING_VARIANT_NOT_FOUND");
      const dialogueItem = currentDialogueItem(snapshot, speechAsset);
      const asset = assetById(snapshot, variant.assetId);
      if (asset.kind !== "speech" || asset.status !== "ready" || !asset.metadata?.hasAudio || asset.metadata.durationMs <= 0) {
        throw new DomainError("选择的 Dialogue Processing 候选尚不可播放", "DIALOGUE_PROCESSING_VARIANT_NOT_READY");
      }
      const sourceFrames = millisecondsToFrames(asset.metadata.durationMs, snapshot.timeline.fps);
      if (sourceFrames !== dialogueItem.endFrame - dialogueItem.startFrame) {
        throw new DomainError("候选音频帧时长与当前 Dialogue 不一致；不能悄悄改变字幕、镜头或节奏", "DIALOGUE_PROCESSING_DURATION_MISMATCH");
      }
      const previousAssetId = speechAsset.assetId;
      speechAsset.assetId = asset.id;
      processing.selectedProfile = input.profile;
      dialogueItem.assetId = asset.id;
      dialogueItem.sourceStartFrame = 0;
      dialogueItem.sourceEndFrame = sourceFrames;
      impact.changed.push(speechAsset.id, dialogueItem.id, asset.id);
      if (previousAssetId !== asset.id) {
        markSpeechAlignmentStale(snapshot, impact, "Dialogue Processing 切换了实际可播放音频");
        // 音频处理不会改变帧长，但滤镜延迟和音色变化仍不能沿用 word_exact 或旧口型结果。
        speechAsset.timing = {
          ...speechAsset.timing,
          precision: "segment_exact",
          source: `${speechAsset.timing.source}；Dialogue Processing 已切换为 ${input.profile}，词级对齐需重新验证`
        };
        for (const performance of snapshot.actorPerformances) {
          if (performance.source !== "generated" || performance.speechAssetId !== speechAsset.id || performance.status === "stale") continue;
          performance.status = "stale";
          impact.stale.push(performance.id);
        }
        impact.dirtyRanges.push({ startFrame: dialogueItem.startFrame, endFrame: dialogueItem.endFrame, reason: "切换 Dialogue Processing 候选，需要重新试听、对齐和人物口型复核" });
        impact.recomputed.push("当前 Dialogue 音频来源；词级对齐回退到 segment_exact；生成型人物表演标记 stale");
      }
      impact.warnings.push("已切换当前 Dialogue；请先完整只听声音，再复看声画与最终导出，处理参数不等于审美通过。");
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 音乐生成只固定一个已确认的 Bridge workflow、提示词和精确时长；Worker 会在付费调用前
   * 动态读取 Schema。生成成功只登记素材，是否进入 BGM 仍由后续音频决定判断。
   */
  submitMusicGeneration(input: {
    projectId: Id;
    baseRevision: number;
    workflowId: string;
    prompt: string;
    durationSeconds: number;
    outputSlotId?: string;
    idempotencyKey?: string;
  }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, state.revision.number);
    const workflowId = requireText(input.workflowId, "音乐 Bridge workflowId");
    const prompt = requireText(input.prompt, "音乐提示词");
    if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 1_800) {
      throw new DomainError("音乐生成时长必须是 1 到 1800 秒的整数", "INVALID_MUSIC_DURATION");
    }
    const outputSlotId = input.outputSlotId?.trim() || undefined;
    const payload: MusicGenerationJobPayload = {
      requestedRevision: state.revision.number,
      workflowId,
      prompt,
      durationSeconds: input.durationSeconds,
      outputSlotId
    };
    const promptHash = createHash("sha256").update(`${workflowId}\n${prompt}\n${input.durationSeconds}\n${outputSlotId ?? ""}`).digest("hex").slice(0, 24);
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "music_generation",
      payload,
      idempotencyKey: input.idempotencyKey ?? `music_generation:${state.revision.number}:${promptHash}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /**
   * Worker 已完成下载、解码与哈希核验后，才在同一 Revision 中登记生成音乐。这里不自动放到 BGM 轨，
   * 因为“拿到一首音乐”不等于它适合当前叙事、长度、Duck。
   */
  completeMusicGeneration(input: {
    projectId: Id;
    jobId: Id;
    musicAudio: CompletedMusicAudio;
    bridgeAudit: BridgeRunAudit;
  }): { state: ProjectState; asset: Asset; duplicate: boolean } {
    const job = this.repository.getJob(input.jobId);
    if (job.projectId !== input.projectId || job.kind !== "music_generation") {
      throw new DomainError("该任务不是当前项目的音乐生成任务", "MUSIC_JOB_NOT_FOUND");
    }
    const currentAtStart = this.readProject(input.projectId);
    const completedAssetId = typeof job.result?.musicAssetId === "string" ? job.result.musicAssetId : undefined;
    if (completedAssetId) {
      const existing = currentAtStart.snapshot.assets.find((asset) => asset.id === completedAssetId);
      if (!existing) throw new DomainError("音乐 Job 已有完成回执，但对应素材不存在", "MUSIC_COMPLETION_CORRUPTED");
      return { state: currentAtStart, asset: existing, duplicate: true };
    }
    const payload = job.payload as Partial<MusicGenerationJobPayload>;
    const payloadDuration = payload.durationSeconds;
    if (!Number.isInteger(payload.requestedRevision) || !payload.workflowId?.trim() || !payload.prompt?.trim()
      || !Number.isInteger(payloadDuration) || payloadDuration === undefined || payloadDuration < 1 || payloadDuration > 1_800) {
      throw new DomainError("音乐 Job 缺少受管提交合同，不能将远端输出写入项目", "MUSIC_JOB_PAYLOAD_INVALID");
    }
    if (!input.bridgeAudit || input.bridgeAudit.workflowId !== payload.workflowId || !input.bridgeAudit.runId || !input.bridgeAudit.schemaVersion) {
      throw new DomainError("音乐 Worker 没有提供与提交 workflow 一致的 Bridge 审计", "MUSIC_BRIDGE_AUDIT_INVALID");
    }
    const current = this.readProject(input.projectId);
    if (current.revision.number !== payload.requestedRevision) {
      throw new DomainError("音乐生成期间项目 Revision 已变化；不能自动把旧主线的音乐写入当前版本", "STALE_MUSIC_REQUEST");
    }
    const projectRoot = resolve(current.snapshot.project.rootPath);
    const outputPath = resolve(input.musicAudio.path);
    const relativeOutput = relative(projectRoot, outputPath).replace(/\\/gu, "/");
    if (!isAbsolute(input.musicAudio.path) || !relativeOutput || relativeOutput === ".." || relativeOutput.startsWith("../")
      || !relativeOutput.startsWith("assets/music/") || !existsSync(outputPath)
      || input.musicAudio.relativePath.replace(/\\/gu, "/") !== relativeOutput) {
      throw new DomainError("音乐 Worker 输出不在当前项目的受管 assets/music 目录中或文件不存在", "MUSIC_OUTPUT_PATH_INVALID");
    }
    if (!input.musicAudio.name.trim() || !input.musicAudio.contentHash || input.musicAudio.contentHash !== input.musicAudio.sourceHash
      || !Number.isFinite(input.musicAudio.durationMs) || input.musicAudio.durationMs <= 0 || !input.musicAudio.metadata?.hasAudio
      || !input.musicAudio.metadata.audioCodec) {
      throw new DomainError("音乐 Worker 输出缺少有效哈希、时长、音轨或编码信息", "MUSIC_OUTPUT_INVALID");
    }
    let asset!: Asset;
    let duplicate = false;
    const state = this.repository.commit(input.projectId, current.revision.number, "登记生成音乐素材", (snapshot, impact) => {
      const existing = snapshot.assets.find((candidate) => candidate.sourceHash === input.musicAudio.sourceHash);
      if (existing) {
        asset = existing;
        duplicate = true;
        return;
      }
      asset = createMediaAsset({
        name: input.musicAudio.name.trim(),
        kind: "audio",
        managedPath: input.musicAudio.relativePath,
        sourceHash: input.musicAudio.sourceHash,
        tags: ["generated-music"],
        provenance: {
          source: "generated",
          provider: `bridge:${payload.workflowId}`,
          acquiredAt: now()
        }
      });
      asset.status = "ready";
      asset.metadata = structuredClone(input.musicAudio.metadata);
      snapshot.assets.push(asset);
      impact.changed.push(asset.id);
      impact.recomputed.push("生成音乐素材");
    });
    const updatedJob = this.repository.updateJob(job.id, {
      status: job.status,
      result: { ...(job.result ?? {}), musicAssetId: asset.id, revision: state.revision.number, duplicate }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    this.publish({ projectId: updatedJob.projectId, revision: state.revision.number, type: "job" });
    return { state, asset, duplicate };
  }

  /**
   * 提交生成画面只创建可追踪 Job，不直接把远端 URL、临时预览或未核验的二进制放进 Timeline。
   * 四种 mode 的媒体槽匹配由 Worker 根据每次读取到的 Bridge Schema 完成，这里只固定创作意图。
   */
  submitVideoGeneration(input: {
    projectId: Id;
    baseRevision: number;
    workflowId: string;
    mode: VideoGenerationMode;
    inputAssetIds?: Id[];
    prompt: string;
    durationSeconds: number;
    aspectRatio?: ProjectSnapshot["project"]["brief"]["aspectRatio"];
    outputSlotId?: string;
    seed?: number;
    megapixels?: number;
    initialSeed?: number;
    finalSeed?: number;
    initialMegapixels?: number;
    finalMegapixels?: number;
    assetRequestId?: Id;
    idempotencyKey?: string;
  }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, state.revision.number);
    if (!["text_to_video", "image_to_video", "first_last_frame", "multi_reference"].includes(input.mode)) {
      throw new DomainError("视频生成 mode 必须是文生、图生、首尾帧或多参考之一", "VIDEO_GENERATION_MODE_INVALID");
    }
    const workflowId = requireText(input.workflowId, "视频 Bridge workflowId");
    const prompt = requireText(input.prompt, "视频生成提示词");
    if (prompt.length > 4_000) throw new DomainError("视频生成提示词不能超过 4000 个字符", "VIDEO_GENERATION_PROMPT_TOO_LONG");
    if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 1_800) {
      throw new DomainError("视频生成时长必须是 1 到 1800 秒的整数", "VIDEO_GENERATION_DURATION_INVALID");
    }
    const inputAssetIds = [...(input.inputAssetIds ?? [])];
    if (new Set(inputAssetIds).size !== inputAssetIds.length || inputAssetIds.some((assetId) => !assetId.trim()) || inputAssetIds.length > 10) {
      throw new DomainError("视频生成输入素材必须为不重复的 0 到 10 个 Asset ID", "VIDEO_GENERATION_INPUTS_INVALID");
    }
    const inputAssets = inputAssetIds.map((assetId) => assetById(state.snapshot, assetId));
    for (const asset of inputAssets) {
      if (asset.status !== "ready") throw new DomainError(`视频生成输入“${asset.name}”尚未就绪`, "VIDEO_GENERATION_INPUT_NOT_READY");
    }
    const imageInput = (asset: Asset) => asset.kind === "image" || asset.kind === "derived";
    if (input.mode === "text_to_video" && inputAssets.length !== 0) {
      throw new DomainError("文生视频不能提交参考素材", "VIDEO_GENERATION_TEXT_INPUTS_FORBIDDEN");
    }
    if (input.mode === "image_to_video" && (inputAssets.length !== 1 || !imageInput(inputAssets[0]!))) {
      throw new DomainError("图生视频必须且只能提交一张已就绪图片", "VIDEO_GENERATION_IMAGE_INPUT_REQUIRED");
    }
    if (input.mode === "first_last_frame" && (inputAssets.length !== 2 || inputAssets.some((asset) => !imageInput(asset)))) {
      throw new DomainError("首尾帧生视频必须依次提交两张已就绪图片", "VIDEO_GENERATION_FIRST_LAST_INPUT_REQUIRED");
    }
    if (input.mode === "multi_reference") {
      const images = inputAssets.filter(imageInput).length;
      const videos = inputAssets.filter((asset) => asset.kind === "video" || asset.kind === "actor_video").length;
      const audio = inputAssets.filter((asset) => asset.kind === "audio" || asset.kind === "speech").length;
      if (images + videos + audio !== inputAssets.length || images > 6 || videos > 1 || audio > 3) {
        throw new DomainError("多参考视频只接受最多 6 张图片、1 条视频和 3 条音频", "VIDEO_GENERATION_MULTI_REFERENCE_LIMIT");
      }
    }
    const aspectRatio = input.aspectRatio ?? state.snapshot.project.brief.aspectRatio;
    if (aspectRatio !== state.snapshot.project.brief.aspectRatio) {
      throw new DomainError("生成画面比例必须与当前 Project Brief 一致", "VIDEO_GENERATION_ASPECT_RATIO_MISMATCH");
    }
    const optionalInteger = (value: number | undefined, label: string) => {
      if (value === undefined) return undefined;
      if (!Number.isInteger(value) || value < 0) throw new DomainError(`${label}必须是非负整数`, "VIDEO_GENERATION_OPTION_INVALID");
      return value;
    };
    const optionalMegapixels = (value: number | undefined, label: string) => {
      if (value === undefined) return undefined;
      if (!Number.isFinite(value) || value < 0.1 || value > 16) throw new DomainError(`${label}必须在 0.1 到 16 百万像素之间`, "VIDEO_GENERATION_OPTION_INVALID");
      return value;
    };
    const assetRequestId = input.assetRequestId?.trim() || undefined;
    if (assetRequestId) {
      const request = assetRequestById(state.snapshot, assetRequestId);
      if (request.status === "closed") throw new DomainError("已关闭的素材需求不能再提交生成任务", "ASSET_REQUEST_CLOSED");
      if (request.role === "evidence") {
        throw new DomainError("证据类素材不能由生成视频替代，请使用原始来源或证据截图", "VIDEO_GENERATION_EVIDENCE_FORBIDDEN");
      }
    }
    const payload: VideoGenerationJobPayload = {
      requestedRevision: state.revision.number,
      workflowId,
      mode: input.mode,
      inputAssetIds,
      prompt,
      durationSeconds: input.durationSeconds,
      aspectRatio,
      outputSlotId: input.outputSlotId?.trim() || undefined,
      seed: optionalInteger(input.seed, "随机种子"),
      megapixels: optionalMegapixels(input.megapixels, "清晰度"),
      initialSeed: optionalInteger(input.initialSeed, "初采随机种子"),
      finalSeed: optionalInteger(input.finalSeed, "二采随机种子"),
      initialMegapixels: optionalMegapixels(input.initialMegapixels, "初采清晰度"),
      finalMegapixels: optionalMegapixels(input.finalMegapixels, "最终清晰度"),
      assetRequestId
    };
    const requestHash = createHash("sha256").update(stableJson(payload)).digest("hex").slice(0, 24);
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "video_generation",
      payload,
      idempotencyKey: input.idempotencyKey ?? `video_generation:${state.revision.number}:${requestHash}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /**
   * 已经由 Worker 本地化且核验通过的生成视频，才可成为当前 Revision 的 Asset。
   * 生成成功不等于创作采用：这里不创建 Cutaway、Scene 或 Timeline Item。
   */
  completeVideoGeneration(input: {
    projectId: Id;
    jobId: Id;
    generatedVideo: CompletedGeneratedVideo;
    bridgeAudit: BridgeRunAudit;
  }): { state: ProjectState; asset: Asset; duplicate: boolean } {
    const job = this.repository.getJob(input.jobId);
    if (job.projectId !== input.projectId || job.kind !== "video_generation") {
      throw new DomainError("该任务不是当前项目的视频生成任务", "VIDEO_GENERATION_JOB_NOT_FOUND");
    }
    const currentAtStart = this.readProject(input.projectId);
    const completedAssetId = typeof job.result?.generatedVideoAssetId === "string" ? job.result.generatedVideoAssetId : undefined;
    const completedAsset = currentAtStart.snapshot.assets.find((asset) => (
      completedAssetId ? asset.id === completedAssetId : asset.provenance?.generationJobId === job.id
    ));
    if (completedAsset) {
      if (completedAsset.kind !== "video" || completedAsset.status !== "ready") {
        throw new DomainError("视频生成 Job 已有完成回执，但对应素材不可用", "VIDEO_GENERATION_COMPLETION_CORRUPTED");
      }
      this.repository.updateJob(job.id, {
        status: job.status,
        result: { ...(job.result ?? {}), generatedVideoAssetId: completedAsset.id, revision: currentAtStart.revision.number }
      });
      return { state: currentAtStart, asset: completedAsset, duplicate: true };
    }
    const payload = job.payload as Partial<VideoGenerationJobPayload>;
    if (!Number.isInteger(payload.requestedRevision) || !payload.workflowId?.trim() || !payload.prompt?.trim()
      || !["text_to_video", "image_to_video", "first_last_frame", "multi_reference"].includes(payload.mode ?? "")
      || !Array.isArray(payload.inputAssetIds) || !Number.isInteger(payload.durationSeconds) || (payload.durationSeconds ?? 0) < 1) {
      throw new DomainError("视频生成 Job 缺少受管提交合同，不能将外部输出写入项目", "VIDEO_GENERATION_JOB_PAYLOAD_INVALID");
    }
    if (!input.bridgeAudit || input.bridgeAudit.workflowId !== payload.workflowId || !input.bridgeAudit.runId?.trim() || !input.bridgeAudit.schemaVersion?.trim()) {
      throw new DomainError("视频 Worker 没有提供与提交 workflow 一致的 Bridge 审计", "VIDEO_GENERATION_BRIDGE_AUDIT_INVALID");
    }
    // 上面的完整性检查已确认这些字段存在；收窄到局部常量，避免后续 Revision 回写把可选 Job payload 当成有效事实。
    const workflowId = payload.workflowId!;
    const mode = payload.mode!;
    const inputAssetIds = payload.inputAssetIds!;
    const prompt = payload.prompt!;
    const durationSeconds = payload.durationSeconds!;
    const current = this.readProject(input.projectId);
    if (current.revision.number !== payload.requestedRevision) {
      throw new DomainError("视频生成期间项目 Revision 已变化；不能自动把旧画面写入当前版本", "STALE_VIDEO_GENERATION_REQUEST");
    }
    const projectRoot = resolve(current.snapshot.project.rootPath);
    const outputPath = resolve(input.generatedVideo.path);
    const relativeOutput = relative(projectRoot, outputPath).replace(/\\/gu, "/");
    if (!isAbsolute(input.generatedVideo.path) || !relativeOutput || relativeOutput === ".." || relativeOutput.startsWith("../")
      || !relativeOutput.startsWith("assets/generated/") || !existsSync(outputPath)
      || input.generatedVideo.relativePath.replace(/\\/gu, "/") !== relativeOutput) {
      throw new DomainError("视频 Worker 输出不在当前项目的受管 assets/generated 目录中或文件不存在", "VIDEO_GENERATION_OUTPUT_PATH_INVALID");
    }
    if (!input.generatedVideo.name.trim() || !input.generatedVideo.contentHash || input.generatedVideo.contentHash !== input.generatedVideo.sourceHash
      || !Number.isFinite(input.generatedVideo.durationMs) || input.generatedVideo.durationMs <= 0 || !input.generatedVideo.metadata?.videoCodec
      || input.generatedVideo.metadata.videoCodec.toLocaleLowerCase() !== "h264"
      || (input.generatedVideo.metadata.audioCodec !== undefined && input.generatedVideo.metadata.audioCodec.toLocaleLowerCase() !== "aac")) {
      throw new DomainError("视频 Worker 输出缺少可播放的 H.264 视频、有效哈希或时长", "VIDEO_GENERATION_OUTPUT_INVALID");
    }
    let asset!: Asset;
    const state = this.repository.commit(input.projectId, current.revision.number, "登记生成视频素材", (snapshot, impact) => {
      if (payload.assetRequestId) {
        const request = assetRequestById(snapshot, payload.assetRequestId);
        if (request.status === "closed" || request.role === "evidence") {
          throw new DomainError("关联的素材需求已关闭或不允许生成替代", "STALE_VIDEO_GENERATION_REQUEST");
        }
        request.status = "fulfilled";
        request.updatedAt = now();
        impact.changed.push(request.id);
      }
      asset = createMediaAsset({
        name: input.generatedVideo.name.trim(),
        kind: "video",
        managedPath: input.generatedVideo.relativePath,
        sourceHash: input.generatedVideo.sourceHash,
        role: "generated_visual",
        tags: ["generated", "video-generation", payload.mode!],
        provenance: {
          source: "generated",
          provider: `bridge:${workflowId}`,
          sourceUrl: `bridge-run:${input.bridgeAudit.runId}`,
          generationJobId: job.id,
          generation: {
            jobId: job.id,
            workflowId,
            mode,
            inputAssetIds: [...inputAssetIds],
            prompt,
            durationSeconds,
            aspectRatio: payload.aspectRatio ?? snapshot.project.brief.aspectRatio
          },
          acquiredAt: now()
        }
      });
      asset.status = "ready";
      asset.metadata = structuredClone(input.generatedVideo.metadata);
      snapshot.assets.push(asset);
      impact.changed.push(asset.id);
      impact.recomputed.push("生成视频素材与来源参数");
    });
    const updatedJob = this.repository.updateJob(job.id, {
      status: job.status,
      result: { ...(job.result ?? {}), generatedVideoAssetId: asset.id, revision: state.revision.number }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    this.publish({ projectId: updatedJob.projectId, revision: state.revision.number, type: "job" });
    return { state, asset, duplicate: false };
  }

  /**
   * 词级精度是可选的扩展能力。提交时固定当前 SpeechAsset、Script Revision 和显式对齐 workflow，
   * 不能把普通 ASR、按字数估时或历史旁白误当成当前强制对齐。
   */
  submitSpeechAlignment(input: {
    projectId: Id;
    baseRevision: number;
    workflowId: string;
    speechAssetId?: Id;
    outputSlotId?: string;
    idempotencyKey?: string;
  }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) throw new RevisionConflictError(input.baseRevision, state.revision.number);
    const speechAsset = state.snapshot.speechAsset;
    if (!speechAsset || speechAsset.status !== "ready" || speechAsset.scriptRevision !== state.snapshot.script.revision) {
      throw new DomainError("词级对齐只能使用当前已就绪且与 Script 一致的 SpeechAsset", "SPEECH_ALIGNMENT_SPEECH_STALE");
    }
    if (input.speechAssetId && input.speechAssetId !== speechAsset.id) {
      throw new DomainError("提交的 SpeechAsset 不是当前旁白版本", "SPEECH_ALIGNMENT_SPEECH_MISMATCH");
    }
    const speechFile = assetById(state.snapshot, speechAsset.assetId);
    if (speechFile.status !== "ready" || speechFile.kind !== "speech" || !speechFile.metadata?.hasAudio
      || typeof speechFile.metadata.durationMs !== "number" || speechFile.metadata.durationMs <= 0) {
      throw new DomainError("当前 SpeechAsset 的本地音频尚未就绪或缺少真实时长", "SPEECH_ALIGNMENT_AUDIO_NOT_READY");
    }
    const existingAlignment = state.snapshot.speechAlignment;
    if (speechAsset.timing.precision === "word_exact" && existingAlignment?.status === "ready"
      && existingAlignment.speechAssetId === speechAsset.id && existingAlignment.scriptRevision === speechAsset.scriptRevision) {
      const existingJob = this.repository.getJob(existingAlignment.generationJobId);
      if (existingJob.kind !== "speech_alignment" || existingJob.projectId !== input.projectId) {
        throw new DomainError("当前词级对齐缺少对应 Job，无法安全复用", "SPEECH_ALIGNMENT_COMPLETION_CORRUPTED");
      }
      return existingJob;
    }
    const workflowId = requireText(input.workflowId, "词级对齐 Bridge workflowId");
    const outputSlotId = input.outputSlotId?.trim() || undefined;
    const payload: SpeechAlignmentJobPayload = {
      requestedRevision: state.revision.number,
      speechAssetId: speechAsset.id,
      scriptRevision: speechAsset.scriptRevision,
      workflowId,
      outputSlotId
    };
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "speech_alignment",
      payload,
      idempotencyKey: input.idempotencyKey ?? `speech_alignment:${state.revision.number}:${speechAsset.id}:${workflowId}:${outputSlotId ?? ""}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /** 当前 Revision 只读取可用的对齐对象；旧 Revision 的审计保存在其历史快照中。 */
  readSpeechAlignment(projectId: Id): SpeechAlignment | undefined {
    return this.readProject(projectId).snapshot.speechAlignment;
  }

  /**
   * Worker 只能提交可追溯的真实 token 时间戳。Application 在 Revision 事务内再次核对音频范围、
   * 段边界、文字和帧换算，成功后才允许当前 SpeechTiming 升级为 word_exact。
   */
  completeSpeechAlignment(input: {
    projectId: Id;
    jobId: Id;
    alignment: CompletedSpeechAlignment;
    bridgeAudit: BridgeRunAudit;
  }): { state: ProjectState; alignment: SpeechAlignment; duplicate: boolean } {
    const job = this.repository.getJob(input.jobId);
    if (job.projectId !== input.projectId || job.kind !== "speech_alignment") {
      throw new DomainError("该任务不是当前项目的词级对齐任务", "SPEECH_ALIGNMENT_JOB_NOT_FOUND");
    }
    const currentAtStart = this.readProject(input.projectId);
    const existingAlignment = currentAtStart.snapshot.speechAlignment;
    if (existingAlignment?.generationJobId === job.id) {
      return { state: currentAtStart, alignment: existingAlignment, duplicate: true };
    }
    if (typeof job.result?.speechAlignmentId === "string") {
      throw new DomainError("词级对齐 Job 已有完成回执，但当前 Revision 缺少对应对齐对象", "SPEECH_ALIGNMENT_COMPLETION_CORRUPTED");
    }
    const payload = job.payload as Partial<SpeechAlignmentJobPayload>;
    if (!Number.isInteger(payload.requestedRevision) || !payload.speechAssetId?.trim()
      || !Number.isInteger(payload.scriptRevision) || !payload.workflowId?.trim()) {
      throw new DomainError("词级对齐 Job 缺少受管提交合同，不能写入外部输出", "SPEECH_ALIGNMENT_JOB_PAYLOAD_INVALID");
    }
    if (!input.bridgeAudit || input.bridgeAudit.workflowId !== payload.workflowId || !input.bridgeAudit.runId?.trim()
      || !input.bridgeAudit.schemaVersion?.trim() || !input.bridgeAudit.completedAt || input.bridgeAudit.response?.status !== "succeeded") {
      throw new DomainError("词级对齐 Worker 没有提供已完成且与提交 workflow 一致的 Bridge 审计", "SPEECH_ALIGNMENT_BRIDGE_AUDIT_INVALID");
    }
    const source = requireText(input.alignment.source, "词级对齐来源");
    const current = this.readProject(input.projectId);
    if (current.revision.number !== payload.requestedRevision) {
      throw new DomainError("词级对齐期间项目 Revision 已变化；不能将旧旁白的时间戳写入当前版本", "STALE_SPEECH_ALIGNMENT_REQUEST");
    }
    const currentSpeechAsset = current.snapshot.speechAsset;
    if (!currentSpeechAsset || currentSpeechAsset.status !== "ready" || currentSpeechAsset.id !== payload.speechAssetId
      || currentSpeechAsset.scriptRevision !== payload.scriptRevision || current.snapshot.script.revision !== payload.scriptRevision) {
      throw new DomainError("词级对齐对应的 SpeechAsset 或 Script 已过期", "STALE_SPEECH_ALIGNMENT_REQUEST");
    }
    let alignment!: SpeechAlignment;
    const state = this.repository.commit(input.projectId, current.revision.number, "写入真实词级对齐", (snapshot, impact) => {
      const speechAsset = snapshot.speechAsset;
      if (!speechAsset || speechAsset.id !== payload.speechAssetId || speechAsset.scriptRevision !== payload.scriptRevision) {
        throw new DomainError("词级对齐提交时当前 SpeechAsset 已变化", "STALE_SPEECH_ALIGNMENT_REQUEST");
      }
      const words = validateCompletedSpeechAlignment(snapshot, speechAsset, input.alignment.words);
      alignment = {
        id: createId("speech_alignment"),
        generationJobId: job.id,
        speechAssetId: speechAsset.id,
        scriptRevision: speechAsset.scriptRevision,
        status: "ready",
        words,
        source,
        audit: structuredClone(input.bridgeAudit),
        createdAt: now()
      };
      snapshot.speechAlignment = alignment;
      speechAsset.timing = {
        ...speechAsset.timing,
        precision: "word_exact",
        source: `真实词级强制对齐：${source}（${input.bridgeAudit.workflowId}/${input.bridgeAudit.runId}）`
      };
      // 音频派生 Card 的边界仍来自自己的 Alignment，不能因 SpeechTiming 升级而篡改其精度。
      for (const caption of snapshot.timeline.captions) if (caption.sourceKind !== "source_audio") caption.precision = "word_exact";
      impact.changed.push(alignment.id, speechAsset.id, ...snapshot.timeline.captions.map((caption) => caption.id));
      impact.recomputed.push("真实词级时间戳、SpeechTiming、Caption Program 精度");
      impact.dirtyRanges.push({ startFrame: 0, endFrame: Math.max(1, snapshot.timeline.durationInFrames), reason: "词级对齐已写入，需在真实预览中复核逐词高亮或节奏效果" });
    });
    const updatedJob = this.repository.updateJob(job.id, {
      status: job.status,
      result: { ...(job.result ?? {}), speechAlignmentId: alignment.id, revision: state.revision.number }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    this.publish({ projectId: updatedJob.projectId, revision: state.revision.number, type: "job" });
    return { state, alignment, duplicate: false };
  }

  /**
   * 提交 Avatar 不直接改写 Timeline。先把当时已确认的 Speech、Scene、人物参考和范围
   * 固定进 Job，避免长时间生成完成后错误套用到新的 Script 或新的 PresenterScene。
   */
  submitAvatarGeneration(input: {
    projectId: Id;
    baseRevision: number;
    capabilityProfileId: Id;
    referenceImageAssetId: Id;
    speechAssetId?: Id;
    replaceActorPerformanceId?: Id;
    generationRange: ActorGenerationRange;
    placement: AvatarGenerationPlacement;
    prompt?: string;
    maskMode?: "none";
    audioMode?: "use_dialogue_track" | "muted";
    layout?: ActorLayout;
    note?: string;
    idempotencyKey?: string;
  }): JobRecord {
    const state = this.readProject(input.projectId);
    if (state.revision.number !== input.baseRevision) {
      throw new DomainError("项目版本已变化；请重新读取人物、SpeechAsset 与 Scene 后再提交生成", "REVISION_CONFLICT");
    }
    const snapshot = state.snapshot;
    const profile = snapshot.actorCapabilityProfiles.find((candidate) => candidate.id === input.capabilityProfileId);
    if (!profile) throw new DomainError("人物能力档案不存在", "ACTOR_CAPABILITY_NOT_FOUND");
    if (!profile.supportsReferenceImage) {
      throw new DomainError("当前人物 Provider 未声明支持肖像图参考，不能提交该生成任务", "AVATAR_REFERENCE_IMAGE_UNSUPPORTED");
    }
    if (!profile.inputModes.includes("audio")) {
      throw new DomainError("当前人物 Provider 未声明接受最终旁白音频，不能生成与 SpeechAsset 对齐的人物", "AVATAR_AUDIO_INPUT_UNSUPPORTED");
    }
    if (!profile.supportsAudioDrivenLipSync) {
      throw new DomainError("当前人物 Provider 尚未明确声明音频驱动口型同步能力，不能将其作为 SpeechAsset 对齐的数字人口播提交", "AVATAR_LIP_SYNC_CAPABILITY_UNSUPPORTED");
    }
    if (input.maskMode !== undefined && input.maskMode !== "none") {
      throw new DomainError("当前 Avatar Bridge 尚未验证可输出人物 Mask；生成任务只能使用 none，独立 Mask 请在结果后单独登记", "AVATAR_MASK_GENERATION_UNSUPPORTED");
    }
    if (!profile.maskModes.includes("none")) {
      throw new DomainError("人物能力档案没有声明无 Mask 降级，当前生成链无法安全执行", "AVATAR_MASK_MODE_UNSUPPORTED");
    }

    const reference = assetById(snapshot, input.referenceImageAssetId);
    if (!reference.status || reference.status !== "ready" || !["image", "derived"].includes(reference.kind)) {
      throw new DomainError("肖像参考必须是已就绪的图片或派生图片素材", "AVATAR_REFERENCE_IMAGE_NOT_READY");
    }

    const speech = snapshot.speechAsset;
    if (!speech || speech.status !== "ready" || (input.speechAssetId && input.speechAssetId !== speech.id)) {
      throw new DomainError("Avatar 只能使用当前已就绪的 SpeechAsset，不能将旧旁白交给 Provider", "STALE_AVATAR_SPEECH");
    }
    const speechFile = assetById(snapshot, speech.assetId);
    if (speechFile.status !== "ready" || speechFile.kind !== "speech" || !speechFile.metadata?.hasAudio) {
      throw new DomainError("当前 SpeechAsset 的本地音频尚未就绪", "SPEECH_ASSET_NOT_READY");
    }

    const range = input.generationRange;
    if (!Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame) || range.startFrame < 0 || range.endFrame <= range.startFrame || range.endFrame > snapshot.timeline.durationInFrames) {
      throw new DomainError("人物局部生成范围无效", "INVALID_ACTOR_GENERATION_RANGE");
    }
    const requestedSegmentIds = [...new Set(range.speechSegmentIds)];
    if (requestedSegmentIds.length === 0 || requestedSegmentIds.length !== range.speechSegmentIds.length) {
      throw new DomainError("人物生成范围必须包含不重复的 SpeechSegment", "INVALID_ACTOR_GENERATION_SEGMENTS");
    }
    const currentSegmentIds = new Set(speech.timing.segments.map((segment) => segment.speechSegmentId));
    if (requestedSegmentIds.some((segmentId) => !currentSegmentIds.has(segmentId))) {
      throw new DomainError("人物生成范围引用了不属于当前 SpeechAsset 的 SpeechSegment", "STALE_ACTOR_GENERATION_SEGMENT");
    }
    const selectedTiming = speech.timing.segments.filter((segment) => requestedSegmentIds.includes(segment.speechSegmentId));
    const selectedStartFrame = Math.min(...selectedTiming.map((segment) => segment.startFrame));
    const selectedEndFrame = Math.max(...selectedTiming.map((segment) => segment.endFrame));
    if (range.startFrame > selectedStartFrame || range.endFrame < selectedEndFrame) {
      throw new DomainError("人物生成范围必须完整覆盖所选 SpeechSegment 的真实时序", "ACTOR_GENERATION_TIMING_MISMATCH");
    }
    if (!profile.supportsPartialRegeneration && (
      requestedSegmentIds.length !== currentSegmentIds.size
      || range.startFrame !== selectedStartFrame
      || range.endFrame !== selectedEndFrame
    )) {
      throw new DomainError("当前 Provider 未声明支持局部重生成；必须选择当前 SpeechAsset 的全部 SpeechSegment", "AVATAR_PARTIAL_REGEN_UNSUPPORTED");
    }
    const requestedSeconds = (range.endFrame - range.startFrame) / snapshot.timeline.fps;
    if (requestedSeconds > profile.maxDurationSeconds) {
      throw new DomainError(`人物生成范围为 ${requestedSeconds.toFixed(2)} 秒，超过 Provider 声明的 ${profile.maxDurationSeconds} 秒上限`, "AVATAR_DURATION_EXCEEDED");
    }

    const placement = input.placement;
    if (!Number.isInteger(placement.startFrame) || !Number.isInteger(placement.endFrame) || placement.startFrame !== range.startFrame || placement.endFrame !== range.endFrame) {
      throw new DomainError("人物播放位置必须与对应的 SpeechSegment 生成范围完全对齐", "ACTOR_PLACEMENT_RANGE_MISMATCH");
    }
    const scene = snapshot.scenes.find((candidate) => candidate.id === placement.sceneId);
    if (!scene || scene.type !== "PresenterScene" || placement.startFrame < scene.startFrame || placement.endFrame > scene.endFrame) {
      throw new DomainError("人物生成位置必须完全落在已有 PresenterScene 内", "ACTOR_PLACEMENT_SCENE_INVALID");
    }
    const layout = input.layout === undefined ? undefined : normalizeActorLayout(input.layout);
    const replacement = input.replaceActorPerformanceId
      ? snapshot.actorPerformances.find((candidate) => candidate.id === input.replaceActorPerformanceId)
      : undefined;
    if (input.replaceActorPerformanceId && !replacement) throw new DomainError("待局部重生的人物表演不存在", "ACTOR_PERFORMANCE_NOT_FOUND");
    if (replacement && replacement.source !== "generated") throw new DomainError("只能替换既有的生成型人物表演，导入人物请通过 registerActorPerformance 更新", "ACTOR_REPLACEMENT_SOURCE_INVALID");

    const payload: AvatarGenerationJobPayload = {
      requestedRevision: state.revision.number,
      capabilityProfileId: profile.id,
      workflowId: profile.workflowId,
      referenceImageAssetId: reference.id,
      speechAssetId: speech.id,
      generationRange: { startFrame: range.startFrame, endFrame: range.endFrame, speechSegmentIds: requestedSegmentIds },
      placement: { sceneId: placement.sceneId, startFrame: placement.startFrame, endFrame: placement.endFrame },
      replaceActorPerformanceId: replacement?.id,
      prompt: input.prompt?.trim() || undefined,
      maskMode: "none",
      audioMode: input.audioMode ?? "use_dialogue_track",
      layout,
      note: input.note?.trim() || undefined
    };
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "avatar_generation",
      payload,
      idempotencyKey: input.idempotencyKey ?? [
        "avatar",
        payload.requestedRevision,
        payload.capabilityProfileId,
        payload.referenceImageAssetId,
        payload.speechAssetId,
        `${range.startFrame}-${range.endFrame}`,
        requestedSegmentIds.join(","),
        `${placement.sceneId}:${placement.startFrame}-${placement.endFrame}`,
        payload.replaceActorPerformanceId ?? "new",
      ].join(":")
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /**
   * Avatar Worker 下载并验证二进制后，才由 Application 在同一 Revision 中登记 Asset、
   * Actor / A-roll Item 与 ActorPerformance。重复领取 Job 时优先复用已写入的结果。
   */
  completeAvatarGeneration(input: {
    projectId: Id;
    jobId: Id;
    actorVideo: CompletedAvatarVideo;
    bridgeAudit: BridgeRunAudit;
  }): { state: ProjectState; asset: Asset; timelineItem: TimelineItem; actorPerformance: ReturnType<typeof createActorPerformance>; duplicate: boolean } {
    const job = this.repository.getJob(input.jobId);
    if (job.projectId !== input.projectId || job.kind !== "avatar_generation") {
      throw new DomainError("该任务不是当前项目的 Avatar 生成任务", "AVATAR_JOB_NOT_FOUND");
    }
    const currentAtStart = this.readProject(input.projectId);
    const completedPerformanceId = typeof job.result?.actorPerformanceId === "string" ? job.result.actorPerformanceId : undefined;
    // Revision 写入和 Job 状态更新之间若进程中断，Job.result 可能尚未来得及落盘。
    // generationJobId 是同一项目事实中的稳定回执，允许安全重领而不会再次调用外部 Provider。
    const alreadyCompleted = currentAtStart.snapshot.actorPerformances.find((candidate) => (
      candidate.generationJobId === job.id && (!completedPerformanceId || candidate.id === completedPerformanceId)
    ));
    if (alreadyCompleted) {
      const snapshot = currentAtStart.snapshot;
      const item = snapshot.timeline.items.find((candidate) => candidate.id === alreadyCompleted.timelineItemId);
      const asset = item ? snapshot.assets.find((candidate) => candidate.id === item.assetId) : undefined;
      if (!item || !asset) throw new DomainError("Avatar Job 已有结果，但其人物素材或 Timeline Item 不存在", "AVATAR_COMPLETION_CORRUPTED");
      this.repository.updateJob(job.id, {
        status: job.status,
        result: {
          ...(job.result ?? {}),
          actorAssetId: asset.id,
          timelineItemId: item.id,
          actorPerformanceId: alreadyCompleted.id,
          revision: currentAtStart.revision.number
        }
      });
      return { state: currentAtStart, asset, timelineItem: item, actorPerformance: alreadyCompleted, duplicate: true };
    }

    const payload = job.payload as Partial<AvatarGenerationJobPayload>;
    if (
      !Number.isInteger(payload.requestedRevision)
      || typeof payload.capabilityProfileId !== "string"
      || typeof payload.referenceImageAssetId !== "string"
      || typeof payload.speechAssetId !== "string"
      || !payload.generationRange
      || !payload.placement
      || payload.maskMode !== "none"
      || (payload.audioMode !== "use_dialogue_track" && payload.audioMode !== "muted")
    ) {
      throw new DomainError("Avatar Job 缺少受管的提交合同，不能将外部结果写入项目", "AVATAR_JOB_PAYLOAD_INVALID");
    }
    const current = this.readProject(input.projectId);
    if (current.revision.number !== payload.requestedRevision) {
      throw new DomainError("Avatar 生成期间项目 Revision 已变化；结果保留在 Job 审计中，不能自动写入新版本", "STALE_AVATAR_REQUEST");
    }
    const projectRoot = resolve(current.snapshot.project.rootPath);
    const outputPath = resolve(input.actorVideo.path);
    const relativeOutputPath = relative(projectRoot, outputPath);
    if (!isAbsolute(input.actorVideo.path) || !relativeOutputPath || relativeOutputPath === ".." || relativeOutputPath.startsWith(`..${String.fromCharCode(92)}`) || relativeOutputPath.startsWith("../") || !existsSync(outputPath)) {
      throw new DomainError("Avatar Worker 输出不在当前项目受管目录中或文件不存在", "AVATAR_OUTPUT_PATH_INVALID");
    }
    if (!input.actorVideo.contentHash || input.actorVideo.contentHash !== input.actorVideo.sourceHash || !Number.isFinite(input.actorVideo.durationMs) || input.actorVideo.durationMs <= 0 || !input.actorVideo.metadata?.videoCodec) {
      throw new DomainError("Avatar Worker 输出缺少有效哈希、时长或视频轨信息", "INVALID_AVATAR_OUTPUT");
    }
    // 当前 Remotion Composition 只承诺播放 MP4/H.264，音轨若存在也必须为 AAC。
    // Actor 默认静音，因此无音轨合法；不能让 ffprobe 可读但浏览器无法解码的文件进入 Timeline。
    if (input.actorVideo.metadata.videoCodec.toLowerCase() !== "h264"
      || (input.actorVideo.metadata.audioCodec !== undefined && input.actorVideo.metadata.audioCodec.toLowerCase() !== "aac")) {
      throw new DomainError("Avatar 输出必须为 Remotion 可播放的 MP4/H.264（音轨存在时为 AAC）", "AVATAR_OUTPUT_CODEC_UNSUPPORTED");
    }

    let asset!: Asset;
    let timelineItem!: TimelineItem;
    let actorPerformance!: ReturnType<typeof createActorPerformance>;
    let duplicate = false;
    const state = this.repository.commit(input.projectId, payload.requestedRevision, "应用 Avatar 生成人物", (snapshot, impact) => {
      const profile = snapshot.actorCapabilityProfiles.find((candidate) => candidate.id === payload.capabilityProfileId);
      if (!profile || profile.workflowId !== payload.workflowId) throw new DomainError("Avatar Job 对应的人物能力档案已变更", "STALE_ACTOR_CAPABILITY_PROFILE");
      if (!profile.supportsReferenceImage || !profile.inputModes.includes("audio") || !profile.supportsAudioDrivenLipSync || !profile.maskModes.includes("none")) {
        throw new DomainError("人物能力档案不再满足当前 Avatar Job 的输入与降级合同", "STALE_ACTOR_CAPABILITY_PROFILE");
      }
      const speech = snapshot.speechAsset;
      if (!speech || speech.status !== "ready" || speech.id !== payload.speechAssetId) {
        throw new DomainError("Avatar Job 对应的 SpeechAsset 已失效", "STALE_AVATAR_SPEECH");
      }
      const scene = snapshot.scenes.find((candidate) => candidate.id === payload.placement!.sceneId && candidate.type === "PresenterScene");
      if (!scene || payload.placement!.startFrame < scene.startFrame || payload.placement!.endFrame > scene.endFrame) {
        throw new DomainError("Avatar Job 对应的 PresenterScene 已失效", "STALE_AVATAR_PLACEMENT");
      }
      const range = payload.generationRange!;
      if (payload.placement!.startFrame !== range.startFrame || payload.placement!.endFrame !== range.endFrame) {
        throw new DomainError("Avatar Job 的人物位置与生成范围不一致", "ACTOR_PLACEMENT_RANGE_MISMATCH");
      }
      const knownSegmentIds = new Set(speech.timing.segments.map((segment) => segment.speechSegmentId));
      if (!range.speechSegmentIds?.length || range.speechSegmentIds.some((segmentId) => !knownSegmentIds.has(segmentId))) {
        throw new DomainError("Avatar Job 的 SpeechSegment 已不属于当前 SpeechAsset", "STALE_ACTOR_GENERATION_SEGMENT");
      }
      const requiredFrames = payload.placement!.endFrame - payload.placement!.startFrame;
      const outputFrames = millisecondsToFrames(input.actorVideo.durationMs, snapshot.timeline.fps);
      if (outputFrames < requiredFrames) {
        throw new DomainError("Avatar 输出视频短于需要覆盖的人物范围，不能通过拉伸伪造口型时长", "AVATAR_OUTPUT_TOO_SHORT");
      }

      // Avatar 结果即使哈希碰巧等于已有 B-roll/参考素材，也必须创建独立 Asset。
      // 不能为了二进制去重改写已有素材的角色、来源或 Timeline 语义。
      asset = createMediaAsset({
        name: input.actorVideo.name.trim() || `生成数字人 ${job.id}`,
        kind: "actor_video",
        managedPath: relativeOutputPath,
        sourceHash: input.actorVideo.sourceHash,
        role: "a_roll",
        provenance: {
          source: "generated",
          provider: profile.provider,
          sourceUrl: `bridge-run:${input.bridgeAudit.runId}`,
          originalAssetId: payload.referenceImageAssetId,
          acquiredAt: now()
        },
        tags: ["avatar", "generated", profile.provider]
      });
      asset.status = "ready";
      asset.metadata = input.actorVideo.metadata;
      snapshot.assets.push(asset);

      const replace = payload.replaceActorPerformanceId
        ? snapshot.actorPerformances.find((candidate) => candidate.id === payload.replaceActorPerformanceId)
        : undefined;
      if (payload.replaceActorPerformanceId && (!replace || replace.source !== "generated")) {
        throw new DomainError("待替换的人物表演已变更或不再是生成型人物", "STALE_ACTOR_PERFORMANCE");
      }
      if (replace) {
        const existingItem = snapshot.timeline.items.find((candidate) => candidate.id === replace.timelineItemId);
        if (!existingItem) throw new DomainError("待替换人物缺少 Timeline Item", "ACTOR_ITEM_NOT_FOUND");
        timelineItem = existingItem;
        timelineItem.assetId = asset.id;
        timelineItem.sceneId = payload.placement!.sceneId;
        timelineItem.startFrame = payload.placement!.startFrame;
        timelineItem.endFrame = payload.placement!.endFrame;
        timelineItem.sourceStartFrame = 0;
        timelineItem.sourceEndFrame = requiredFrames;
        replace.source = "generated";
        replace.maskMode = "none";
        replace.maskAssetId = undefined;
        replace.speechAssetId = speech.id;
        replace.scriptRevision = speech.scriptRevision;
        replace.audioMode = payload.audioMode!;
        replace.capabilityProfileId = profile.id;
        replace.generationJobId = job.id;
        replace.generationRange = { startFrame: range.startFrame, endFrame: range.endFrame, speechSegmentIds: [...range.speechSegmentIds] };
        replace.layout = payload.layout;
        replace.bridgeAudit = input.bridgeAudit;
        replace.status = "ready";
        replace.note = payload.note ?? replace.note;
        actorPerformance = replace;
      } else {
        const actorTrack = trackByName(snapshot, "Actor / A-roll");
        if (actorTrack.locked) throw new DomainError("Actor / A-roll 轨已锁定", "TRACK_LOCKED");
        timelineItem = createTimelineItem({
          trackId: actorTrack.id,
          sceneId: payload.placement!.sceneId,
          assetId: asset.id,
          startFrame: payload.placement!.startFrame,
          endFrame: payload.placement!.endFrame,
          sourceStartFrame: 0,
          sourceEndFrame: requiredFrames,
          gainDb: -96
        });
        snapshot.timeline.items.push(timelineItem);
        actorPerformance = createActorPerformance({
          timelineItemId: timelineItem.id,
          source: "generated",
          maskMode: "none",
          speechAssetId: speech.id,
          scriptRevision: speech.scriptRevision,
          audioMode: payload.audioMode!,
          capabilityProfileId: profile.id,
          generationJobId: job.id,
          generationRange: { startFrame: range.startFrame, endFrame: range.endFrame, speechSegmentIds: [...range.speechSegmentIds] },
          layout: payload.layout,
          bridgeAudit: input.bridgeAudit,
          note: payload.note
        });
        snapshot.actorPerformances.push(actorPerformance);
      }
      impact.changed.push(asset.id, timelineItem.id, actorPerformance.id);
      impact.recomputed.push("Avatar 人物主画面、声音所有权与人物空间锚点");
      impact.dirtyRanges.push({ startFrame: timelineItem.startFrame, endFrame: timelineItem.endFrame, reason: "Avatar 生成人物已写入，需连续预览口型、边缘和段间连续性" });
      impact.warnings.push("生成型人物必须通过静音、只听声音和声画同步三种审片；当前 Provider 的口型能力以 Actor Capability Profile 为准。");
    });
    const updatedJob = this.repository.updateJob(job.id, {
      status: job.status,
      result: {
        ...(job.result ?? {}),
        actorAssetId: asset.id,
        timelineItemId: timelineItem.id,
        actorPerformanceId: actorPerformance.id,
        revision: state.revision.number,
        actorVideo: {
          relativePath: relativeOutputPath,
          contentHash: input.actorVideo.contentHash,
          durationMs: input.actorVideo.durationMs
        }
      }
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    this.publish({ projectId: updatedJob.projectId, revision: state.revision.number, type: "job" });
    return { state, asset, timelineItem, actorPerformance, duplicate };
  }

  /**
   * 外部 Run 一创建就写回本地 Job。即使 ComfyUI 重启导致 run_id 不可查，
   * 也能从 Job 读出 workflow、schema 和请求摘要并决定是否重试。
   */
  recordBridgeRun(jobId: Id, audit: BridgeRunAudit): JobRecord {
    const job = this.repository.getJob(jobId);
    const previous = job.result ?? {};
    const existingRuns = Array.isArray(previous.bridgeRuns) ? previous.bridgeRuns : [];
    const nextRuns = [...existingRuns.filter((entry) => !(entry && typeof entry === "object" && "runId" in entry && (entry as { runId?: unknown }).runId === audit.runId)), audit];
    const updated = this.repository.updateJob(jobId, {
      status: job.status,
      result: { ...previous, bridgeRuns: nextRuns }
    });
    this.publish({ projectId: updated.projectId, revision: this.readProject(updated.projectId).revision.number, type: "job" });
    return updated;
  }

  /**
   * 异步媒体任务在触发外部副作用前保存可恢复的非敏感检查点。
   * 这只更新 Job，不写入 Project Revision；因此不会把运行时恢复细节混进剪辑事实。
   */
  recordJobCheckpoint(jobId: Id, checkpoint: Record<string, unknown>): JobRecord {
    const job = this.repository.getJob(jobId);
    const updated = this.repository.updateJob(jobId, {
      status: job.status,
      result: { ...(job.result ?? {}), ...checkpoint }
    });
    this.publish({ projectId: updated.projectId, revision: this.readProject(updated.projectId).revision.number, type: "job" });
    return updated;
  }

  submitPreview(input: { projectId: Id; revision?: number; fromFrame?: number; toFrame?: number; idempotencyKey?: string }): JobRecord {
    const current = this.readProject(input.projectId);
    const revision = input.revision ?? current.revision.number;
    const target = this.repository.getRevision(input.projectId, revision);
    const fromFrame = input.fromFrame ?? 0;
    const toFrame = input.toFrame ?? target.snapshot.timeline.durationInFrames;
    if (!Number.isInteger(fromFrame) || !Number.isInteger(toFrame) || fromFrame < 0 || toFrame <= fromFrame || toFrame > target.snapshot.timeline.durationInFrames) {
      throw new DomainError("局部预览范围无效", "INVALID_PREVIEW_RANGE");
    }
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "preview",
      payload: { revision, fromFrame, toFrame },
      idempotencyKey: input.idempotencyKey ?? `preview:${revision}:${fromFrame}:${toFrame}`
    });
    this.publish({ projectId: input.projectId, revision: current.revision.number, type: "job" });
    return job;
  }

  /**
   * 将 inspect_composed_frames 的真实产物回写到对应 Preview Job。
   * MCP 是唯一调用入口；此处仍重复校验 Job、帧范围和项目内文件，避免审片报告依赖自由文本。
   */
  async recordPreviewInspection(input: {
    projectId: Id;
    previewJobId: Id;
    revision: number;
    frames: Array<{ frame: number; relativePath: string }>;
  }): Promise<JobRecord> {
    const job = this.repository.getJob(input.previewJobId);
    if (job.projectId !== input.projectId || job.kind !== "preview") {
      throw new DomainError("该任务不是当前项目的局部预览", "PREVIEW_JOB_NOT_FOUND");
    }
    if (job.status !== "succeeded" || !job.result) {
      throw new DomainError("局部预览尚未成功，不能登记合成帧", "PREVIEW_NOT_READY");
    }
    const revision = Number(job.result.revision ?? job.payload.revision);
    const fromFrame = Number(job.result.fromFrame ?? job.payload.fromFrame);
    const toFrame = Number(job.result.toFrame ?? job.payload.toFrame);
    if (revision !== input.revision || !Number.isInteger(fromFrame) || !Number.isInteger(toFrame) || fromFrame < 0 || toFrame <= fromFrame) {
      throw new DomainError("Preview Job 的 Revision 或帧范围无效", "INVALID_PREVIEW_INSPECTION");
    }
    const previewPath = typeof job.result.path === "string" ? this.resolveProjectEvidencePath(input.projectId, job.result.path) : undefined;
    if (!previewPath || !existsSync(previewPath)) {
      throw new DomainError("局部预览文件不存在，不能登记合成帧", "PREVIEW_NOT_FOUND");
    }
    const uniqueFrames = new Map<number, string>();
    for (const artifact of input.frames) {
      if (!Number.isInteger(artifact.frame) || artifact.frame < fromFrame || artifact.frame >= toFrame || !artifact.relativePath?.trim()) {
        throw new DomainError("合成帧不在该 Preview 的有效范围内", "PREVIEW_FRAME_OUT_OF_RANGE");
      }
      if (uniqueFrames.has(artifact.frame)) throw new DomainError("合成帧不能重复登记同一帧", "DUPLICATE_COMPOSED_FRAME");
      const artifactPath = this.resolveProjectEvidencePath(input.projectId, artifact.relativePath);
      if (!artifactPath || !existsSync(artifactPath)) throw new DomainError("合成帧文件不存在或超出项目目录", "COMPOSED_FRAME_EXTRACTION_FAILED");
      const artifactStat = await stat(artifactPath);
      if (!artifactStat.isFile() || artifactStat.size === 0) throw new DomainError("合成帧文件为空，不能作为审片证据", "COMPOSED_FRAME_EXTRACTION_FAILED");
      uniqueFrames.set(artifact.frame, artifact.relativePath);
    }
    if (uniqueFrames.size === 0) throw new DomainError("至少需要一帧真实合成画面", "COMPOSED_FRAME_EVIDENCE_REQUIRED");
    const inspection: PreviewInspectionEvidence = {
      revision,
      sourcePreviewJobId: job.id,
      inspectedAt: now(),
      frames: [...uniqueFrames.entries()].sort(([left], [right]) => left - right).map(([frame, relativePath]) => ({ frame, relativePath }))
    };
    return this.updateJob(job.id, { status: "succeeded", result: { ...job.result, inspection } });
  }

  /** 将当前 SpeechAsset 的最终音频、字幕和真实段级时序同步到可播放 Timeline。 */
  private syncSpeechAssetTimeline(snapshot: ProjectSnapshot, speechAsset: SpeechAsset): { dialogueItem: TimelineItem; replacedItemIds: Id[]; durationFrames: number } {
    const dialogueTrack = trackByName(snapshot, "Dialogue");
    // Dialogue 轨只替换系统生成的 Speech Asset；用户手工放入的其它音频保持不动。
    const replacedItemIds = snapshot.timeline.items
      .filter((item) => item.trackId === dialogueTrack.id && snapshot.assets.find((asset) => asset.id === item.assetId)?.kind === "speech")
      .map((item) => item.id);
    const replacedItemIdSet = new Set(replacedItemIds);
    snapshot.timeline.items = snapshot.timeline.items.filter((item) => !replacedItemIdSet.has(item.id));
    const speechFile = assetById(snapshot, speechAsset.assetId);
    if (speechFile.status !== "ready" || !speechFile.metadata?.hasAudio || speechFile.metadata.durationMs <= 0) {
      throw new DomainError("SpeechAsset 对应音频未就绪，不能写入 Dialogue 轨", "SPEECH_ASSET_NOT_READY");
    }
    const durationFrames = millisecondsToFrames(speechFile.metadata.durationMs, snapshot.timeline.fps);
    if (durationFrames <= 0) throw new DomainError("SpeechAsset 时长无效", "INVALID_SPEECH_DURATION");
    const dialogueItem = createTimelineItem({
      trackId: dialogueTrack.id,
      assetId: speechFile.id,
      startFrame: 0,
      endFrame: durationFrames,
      sourceStartFrame: 0,
      sourceEndFrame: durationFrames,
      gainDb: 0
    });
    snapshot.timeline.items.push(dialogueItem);
    snapshot.speechAsset = speechAsset;
    const sourceAudioCaptions = snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio");
    const previousCaptions = new Map(snapshot.timeline.captions
      .filter((caption) => caption.sourceKind !== "source_audio" && caption.speechSegmentId)
      .map((caption) => [caption.speechSegmentId!, caption]));
    snapshot.timeline.captions = [...sourceAudioCaptions, ...speechAsset.timing.segments.map((timing) => {
      const segment = snapshot.speechSegments.find((candidate) => candidate.id === timing.speechSegmentId);
      if (!segment) throw new DomainError("SpeechTiming 引用了不存在的 SpeechSegment", "SPEECH_TIMING_SEGMENT_MISSING");
      const previous = previousCaptions.get(segment.id);
      const sourceUnchanged = previous && (previous.sourceText ?? previous.text) === segment.text;
      if (previous) {
        // 重新组装同一段语音时保留用户已确认的屏幕文案与排版；原文变化则回到语音事实，避免旧强调悄悄错位。
        return {
          ...previous,
          speechSegmentId: segment.id,
          sourceText: segment.text,
          text: sourceUnchanged ? previous.text : segment.text,
          textMode: sourceUnchanged ? previous.textMode ?? (previous.text === segment.text ? "derived" : "manual") : "derived",
          startFrame: timing.startFrame,
          endFrame: timing.endFrame,
          style: "stable" as const,
          format: previous.format ?? { ...DEFAULT_CAPTION_FORMAT },
          emphasis: sourceUnchanged ? previous.emphasis : undefined,
          display: sourceUnchanged && previous.startFrame === timing.startFrame && previous.endFrame === timing.endFrame ? previous.display : undefined,
          precision: speechAsset.timing.precision
        };
      }
      return {
        id: createId("caption"),
        sourceKind: "speech_asset" as const,
        speechSegmentId: segment.id,
        sourceText: segment.text,
        text: segment.text,
        textMode: "derived" as const,
        startFrame: timing.startFrame,
        endFrame: timing.endFrame,
        style: "stable" as const,
        format: { ...DEFAULT_CAPTION_FORMAT },
        precision: speechAsset.timing.precision
      };
    })];
    return { dialogueItem, replacedItemIds, durationFrames };
  }

  applySpeechAssembly(input: { projectId: Id; generatedAssets: Asset[]; segmentAssets: SpeechSegmentAsset[]; speechAsset?: SpeechAsset }): ProjectState {
    const current = this.readProject(input.projectId);
    const state = this.repository.commit(input.projectId, current.revision.number, "组装旁白与段级时序", (snapshot, impact) => {
      const knownSegmentIds = new Set(snapshot.speechSegments.map((segment) => segment.id));
      for (const segmentAsset of input.segmentAssets) {
        if (!knownSegmentIds.has(segmentAsset.speechSegmentId)) throw new DomainError("SpeechSegment 已过期，不能写入旧语音", "STALE_SPEECH_SEGMENT");
      }
      const replacing = new Set(input.segmentAssets.map((segmentAsset) => segmentAsset.speechSegmentId));
      snapshot.speechSegmentAssets = snapshot.speechSegmentAssets.filter((segmentAsset) => !replacing.has(segmentAsset.speechSegmentId));
      snapshot.speechSegmentAssets.push(...input.segmentAssets);
      for (const generatedAsset of input.generatedAssets) {
        const existing = snapshot.assets.find((asset) => asset.id === generatedAsset.id);
        if (!existing) snapshot.assets.push(generatedAsset);
      }
      for (const segment of snapshot.speechSegments) {
        if (replacing.has(segment.id)) segment.status = "ready";
      }
      if (!input.speechAsset) {
        impact.changed.push(...input.segmentAssets.map((segmentAsset) => segmentAsset.id));
        impact.recomputed.push("局部 SpeechSegmentAsset");
        return;
      }
      const speechAsset = input.speechAsset;
      const previousSpeechAssetId = snapshot.speechAsset?.assetId;
      // 即使 Script 没变，重新合成后的 SpeechAsset 也可能改变发音和时长。
      // 旧对齐属于旧二进制，先写入 Impact 再从当前快照移除，避免旧 token 被误当成当前 word_exact。
      if (snapshot.speechAlignment) {
        markSpeechAlignmentStale(snapshot, impact, "SpeechAsset 已重新组装");
        snapshot.speechAlignment = undefined;
      }
      const dialogueTrack = trackByName(snapshot, "Dialogue");
      const previousDialogueDuration = snapshot.timeline.items.find((item) => item.trackId === dialogueTrack.id && item.assetId === previousSpeechAssetId && !item.disabled);
      const synced = this.syncSpeechAssetTimeline(snapshot, speechAsset);
      if (previousSpeechAssetId && (previousSpeechAssetId !== speechAsset.assetId || previousDialogueDuration?.endFrame !== synced.durationFrames)) {
        this.staleAudioCuesForMainline(snapshot, impact, "SpeechAsset 时长或旁白文件已变化");
      }
      // 人物口型依赖具体的 SpeechAsset 文件而非仅依赖 Script Revision。
      // 即使文字没变，重新合成后的发音与时长也可能变化，因此先明确标记可局部重生成的范围。
      for (const performance of snapshot.actorPerformances) {
        if (performance.source !== "generated" || performance.speechAssetId === speechAsset.id) continue;
        performance.status = "stale";
        impact.stale.push(performance.id);
        const range = performance.generationRange;
        if (range) {
          impact.dirtyRanges.push({ startFrame: range.startFrame, endFrame: range.endFrame, reason: "SpeechAsset 已变化，生成型人物需要复核或局部重生成" });
        }
      }
      impact.changed.push(speechAsset.id, synced.dialogueItem.id, ...synced.replacedItemIds, ...input.segmentAssets.map((segmentAsset) => segmentAsset.id));
      impact.recomputed.push("Dialogue 旁白轨、segment_exact SpeechTiming、稳定短句字幕");
      impact.dirtyRanges.push({ startFrame: 0, endFrame: Math.max(snapshot.timeline.durationInFrames, synced.durationFrames), reason: "旁白时序更新" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 为旧 Revision 补回遗漏的 Dialogue Item 与稳定字幕，不重新调用 OmniVoice。 */
  rebuildSpeechAssetTimeline(input: { projectId: Id; baseRevision: number }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "修复 SpeechAsset 的 Dialogue 与字幕", (snapshot, impact) => {
      const speechAsset = snapshot.speechAsset;
      if (!speechAsset || speechAsset.status !== "ready") throw new DomainError("当前项目没有可修复的 SpeechAsset", "SPEECH_ASSET_NOT_FOUND");
      if (speechAsset.scriptRevision !== snapshot.script.revision) {
        throw new DomainError("SpeechAsset 与当前 Script 不一致，必须先重新生成或组装旁白", "SPEECH_SCRIPT_STALE");
      }
      const synced = this.syncSpeechAssetTimeline(snapshot, speechAsset);
      impact.changed.push(speechAsset.id, synced.dialogueItem.id, ...synced.replacedItemIds);
      impact.recomputed.push("修复 Dialogue 旁白轨、稳定短句字幕");
      impact.dirtyRanges.push({ startFrame: 0, endFrame: Math.max(snapshot.timeline.durationInFrames, synced.durationFrames), reason: "修复旧 SpeechAsset Timeline" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * 字幕是对可播放声音的独立屏幕呈现：可微调单卡文案，或原子统一原声 Card 的版式；
   * 不允许在这里修改 Script、语音文件、新增/拆分 Card 或猜测段级时间范围。
   */
  editCaptions(input: {
    projectId: Id;
    baseRevision: number;
    captionId?: Id;
    /** bulk_source_format 只接受同一来源使用（sourceTimelineItemId）的明确 Card 集合。 */
    captionIds?: Id[];
    action: "update" | "reset" | "bulk_source_format";
    text?: string;
    format?: CaptionFormatPatch;
    emphasis?: CaptionEmphasis | null;
    sourceTextReview?: SourceCaptionTextReviewInput;
    display?: CaptionDisplay | null;
  }): ProjectState {
    const isBulkSourceFormat = input.action === "bulk_source_format";
    if (isBulkSourceFormat) {
      if (input.captionId !== undefined || !input.captionIds?.length || input.captionIds.length > 200 || !input.format
        || input.text !== undefined || input.emphasis !== undefined || input.sourceTextReview !== undefined || input.display !== undefined) {
        throw new DomainError("批量原声字幕版式需要明确 Card 列表和 format，且不能同时改文案或强调", "INVALID_SOURCE_CAPTION_BULK_FORMAT");
      }
      if (new Set(input.captionIds).size !== input.captionIds.length) {
        throw new DomainError("批量原声字幕 Card 列表不能包含重复项", "DUPLICATE_SOURCE_CAPTION_ID");
      }
    } else if (!input.captionId?.trim()) {
      throw new DomainError("单卡字幕编辑必须提供 captionId", "CAPTION_ID_REQUIRED");
    }
    if (input.action === "update" && input.text === undefined && input.format === undefined && input.emphasis === undefined && input.display === undefined) {
      throw new DomainError("更新字幕至少需要文案、排版或强调之一", "EMPTY_CAPTION_UPDATE");
    }
    const state = this.repository.commit(input.projectId, input.baseRevision,
      input.action === "reset" ? "恢复字幕语音原文" : isBulkSourceFormat ? "批量调整原声字幕版式" : "编辑字幕卡",
      (snapshot, impact) => {
      if (isBulkSourceFormat) {
        const captions = input.captionIds!.map((captionId) => {
          const caption = snapshot.timeline.captions.find((candidate) => candidate.id === captionId);
          if (!caption) throw new DomainError(`未找到要编辑的字幕卡：${captionId}`, "CAPTION_NOT_FOUND");
          return caption;
        });
        const sourceTimelineItemId = captions[0]!.sourceTimelineItemId;
        // 统一样式只能落到同一来源使用上，避免一次调用跨 A-roll 产生不可预期的视觉覆盖。
        if (!sourceTimelineItemId || captions.some((caption) => caption.sourceKind !== "source_audio" || caption.sourceTimelineItemId !== sourceTimelineItemId)) {
          throw new DomainError("批量版式只能作用于同一原声 A-roll 的 source_audio 字幕卡", "SOURCE_CAPTION_BULK_SCOPE_INVALID");
        }
        for (const caption of captions) {
          assertCurrentSourceAudioCaption(snapshot, caption);
          caption.format = applyCaptionFormat(caption.format, input.format!);
          impact.changed.push(caption.id);
          impact.dirtyRanges.push({ startFrame: caption.startFrame, endFrame: caption.endFrame, reason: "批量调整原声字幕版式" });
        }
        impact.recomputed.push("原声稳定字幕统一有限排版");
        return;
      }
      const caption = snapshot.timeline.captions.find((candidate) => candidate.id === input.captionId);
      if (!caption) throw new DomainError("未找到要编辑的字幕卡", "CAPTION_NOT_FOUND");
      if (input.action === "reset" || input.display === null) delete caption.display;
      else if (input.display !== undefined) {
        caption.display = captionDisplaySchema.parse(input.display);
        if (!validCaptionDisplay(caption)) throw new DomainError("显示范围必须有序、不重叠且位于原卡内；隐藏卡不带范围", "CAPTION_DISPLAY_INVALID");
      }
      if (input.sourceTextReview !== undefined && (input.action !== "update" || input.text === undefined
        || caption.sourceKind !== "source_audio" || !caption.sourceAlignmentId)) {
        throw new DomainError("显示纠错依据只能与同源对齐字幕的新文案一起提交", "CAPTION_SOURCE_TEXT_REVIEW_INVALID");
      }
      if (caption.sourceKind === "source_audio") {
        assertCurrentSourceAudioCaption(snapshot, caption);
        const sourceText = normalizeCaptionText(caption.sourceText ?? caption.text, "原声字幕来源文案");
        if (input.action === "reset") {
          caption.sourceText = sourceText;
          caption.text = sourceText;
          caption.textMode = "derived";
          caption.format = { ...DEFAULT_CAPTION_FORMAT };
          caption.emphasis = undefined;
          caption.sourceTextReview = undefined;
        } else {
          const nextText = input.text === undefined ? caption.text : normalizeCaptionText(input.text);
          const textChanged = nextText !== caption.text;
          if (input.sourceTextReview !== undefined) {
            const review = sourceCaptionTextReviewSchema.safeParse(input.sourceTextReview);
            if (!review.success) throw new DomainError("字幕纠错依据不完整或包含无效字段", "CAPTION_SOURCE_TEXT_REVIEW_INVALID");
            caption.sourceTextReview = { ...review.data, sourceText, text: nextText, reviewedAt: now() };
          } else if (textChanged) {
            // 只改换行、标点或空白时沿用原实义纠错依据，不要求用户重复确认同一文字。
            caption.sourceTextReview = caption.sourceTextReview && normalizeCaptionComparisonText(nextText) === normalizeCaptionComparisonText(caption.text)
              ? { ...caption.sourceTextReview, text: nextText } : undefined;
          }
          if (caption.sourceAlignmentId && normalizeCaptionComparisonText(nextText) !== normalizeCaptionComparisonText(sourceText)
            && !caption.sourceTextReview) {
            throw new DomainError("修改识别实义文字需要提交回听、已确认原稿或明确用户指令的 sourceTextReview 依据；不改变原始时间或声音", "CAPTION_SOURCE_TEXT_REVIEW_REQUIRED");
          }
          caption.sourceText = sourceText;
          caption.text = nextText;
          caption.textMode = nextText === sourceText ? "derived" : "manual";
          if (!sourceCaptionDisplayTextIsValid(caption, snapshot)) throw new DomainError("字幕纠错依据与当前旁白、脚本版本、片段或新文案不一致", "CAPTION_SOURCE_TEXT_REVIEW_INVALID");
          if (input.format !== undefined) caption.format = applyCaptionFormat(caption.format, input.format);
          else caption.format ??= { ...DEFAULT_CAPTION_FORMAT };
          if (input.emphasis === null || (textChanged && input.emphasis === undefined)) caption.emphasis = undefined;
          else if (input.emphasis !== undefined) caption.emphasis = normalizeCaptionEmphasis(input.emphasis, nextText);
          else if (caption.emphasis) caption.emphasis = normalizeCaptionEmphasis(caption.emphasis, nextText);
        }
        impact.changed.push(caption.id);
        impact.recomputed.push("原声稳定字幕文案、有限排版与 Card 级强调");
        impact.dirtyRanges.push({ startFrame: caption.startFrame, endFrame: caption.endFrame, reason: "原声字幕卡编辑" });
        return;
      }
      const speechAsset = snapshot.speechAsset;
      if (!speechAsset || speechAsset.status !== "ready" || speechAsset.scriptRevision !== snapshot.script.revision) {
        throw new DomainError("当前没有与 Script 一致的 SpeechAsset，不能编辑字幕", "CAPTION_SOURCE_NOT_READY");
      }
      const segment = snapshot.speechSegments.find((candidate) => candidate.id === caption.speechSegmentId);
      const timing = speechAsset.timing.segments.find((candidate) => candidate.speechSegmentId === caption.speechSegmentId);
      if (!segment || !timing || caption.startFrame !== timing.startFrame || caption.endFrame !== timing.endFrame) {
        throw new DomainError("字幕时序已不再对应当前 SpeechAsset；请先重建字幕", "CAPTION_TIMING_STALE");
      }
      if ((caption.sourceText ?? caption.text) !== segment.text) {
        throw new DomainError("字幕来源文字已变化；请先重建字幕，再进行屏幕文案微调", "CAPTION_SOURCE_STALE");
      }

      if (input.action === "reset") {
        caption.sourceText = segment.text;
        caption.text = segment.text;
        caption.textMode = "derived";
        caption.format = { ...DEFAULT_CAPTION_FORMAT };
        caption.emphasis = undefined;
      } else {
        const nextText = input.text === undefined ? caption.text : normalizeCaptionText(input.text);
        const textChanged = nextText !== caption.text;
        caption.sourceText = segment.text;
        caption.text = nextText;
        caption.textMode = nextText === segment.text ? "derived" : "manual";
        if (input.format !== undefined) caption.format = applyCaptionFormat(caption.format, input.format);
        else caption.format ??= { ...DEFAULT_CAPTION_FORMAT };

        if (input.emphasis === null || (textChanged && input.emphasis === undefined)) {
          // 改文案后旧短语不再可信，默认移除；调用方可在同一原子写入中提供新的强调。
          caption.emphasis = undefined;
        } else if (input.emphasis !== undefined) {
          caption.emphasis = normalizeCaptionEmphasis(input.emphasis, nextText);
        } else if (caption.emphasis) {
          caption.emphasis = normalizeCaptionEmphasis(caption.emphasis, nextText);
        }
      }
      impact.changed.push(caption.id);
      impact.recomputed.push("稳定字幕文案、有限排版与 Card 级强调");
      impact.dirtyRanges.push({ startFrame: caption.startFrame, endFrame: caption.endFrame, reason: "字幕卡编辑" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /**
   * BGM / SFX 的最小包装入口：用 AudioCue 记录编辑意图，再同步写入专用声音轨。
   * 不在这里生成音乐、猜测 onset 或实现通用 DAW；所有精确事件均由调用方显式给出。
   */
  manageAudio(input: {
    projectId: Id;
    baseRevision: number;
    action: "create" | "update" | "remove";
    audioCueId?: Id;
    kind?: AudioCueKind;
    assetId?: Id;
    purpose?: string;
    startFrame?: number;
    endFrame?: number;
    sourceStartFrame?: number;
    sourceEndFrame?: number;
    loop?: boolean;
    gainDb?: number;
    fadeInFrames?: number;
    fadeOutFrames?: number;
    eventFrame?: number;
    onsetOffsetFrames?: number;
    onsetReview?: { status: "confirmed" | "inconclusive"; note: string };
    effectEvent?: EffectAudioEventInput | null;
    ducking?: AudioDuckingPatch;
    design?: AudioDesignInput;
  }): ProjectState {
    const summary = input.action === "create" ? "添加 BGM / SFX" : input.action === "remove" ? "移除 BGM / SFX" : "调整 BGM / SFX";
    const state = this.repository.commit(input.projectId, input.baseRevision, summary, (snapshot, impact) => this.applyAudioEdit(snapshot, impact, input));
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  /** 正式写入与候选试听使用同一计算；试听只修改内存副本。 */
  applyAudioEdit(snapshot: ProjectSnapshot, impact: ImpactReport, input: Parameters<EditingApplication["manageAudio"]>[0]): void {
      const onsetReview = (previous?: AudioCue["onsetReview"]): NonNullable<AudioCue["onsetReview"]> => {
        if (input.onsetReview) {
          if (!["confirmed", "inconclusive"].includes(input.onsetReview.status) || input.onsetReview.note.trim().length < 16 || input.onsetReview.note.length > 2400) {
            throw new DomainError("请提供有效的起音审阅状态、实际依据或待复听原因", "SFX_ONSET_REVIEW_INVALID");
          }
          return { ...input.onsetReview, note: input.onsetReview.note.trim(), recordedAt: now() };
        }
        // 缺省或源范围改变后只保存待审事实，不把检测候选自动升级为听觉确认。
        return previous ?? { status: "inconclusive", note: "尚未记录当前所选源范围起音的实际复听依据，仅供待审草稿。", recordedAt: now() };
      };
      const managedAudioItemIds = new Set((snapshot.audioCues ?? []).map((cue) => cue.timelineItemId));
      // 声音包装不能悄悄拉长成片；目标范围始终以当前非 AudioCue 主线为准。
      const programEndFrame = snapshot.timeline.items
        .filter((item) => !item.disabled && !managedAudioItemIds.has(item.id))
        .reduce((maximum, item) => Math.max(maximum, item.endFrame), 0);

      const validateGain = (value: number): number => {
        if (!Number.isFinite(value) || value < -48 || value > 12) {
          throw new DomainError("声音增益必须在 -48 到 12 dB 之间", "INVALID_AUDIO_GAIN");
        }
        return value;
      };
      const validateFades = (fadeInFrames: number, fadeOutFrames: number, duration: number) => {
        requireAudioFrame(fadeInFrames, "淡入时长", 0, 480);
        requireAudioFrame(fadeOutFrames, "淡出时长", 0, 480);
        if (fadeInFrames + fadeOutFrames > duration) {
          throw new DomainError("淡入和淡出总时长不能超过声音片段时长", "INVALID_AUDIO_FADE");
        }
      };
      const sourceRangeFor = (asset: Asset, defaultStart: number, defaultEnd: number) => {
        const assetDuration = millisecondsToFrames(asset.metadata!.durationMs, snapshot.timeline.fps);
        if (assetDuration <= 0) throw new DomainError("声音素材时长无效", "INVALID_AUDIO_SOURCE_RANGE");
        const sourceStartFrame = input.sourceStartFrame ?? defaultStart;
        const sourceEndFrame = input.sourceEndFrame ?? defaultEnd;
        requireAudioFrame(sourceStartFrame, "声音源起点", 0, assetDuration - 1);
        requireAudioFrame(sourceEndFrame, "声音源终点", 1, assetDuration);
        if (sourceEndFrame <= sourceStartFrame) {
          throw new DomainError("声音源范围必须至少包含一帧", "INVALID_AUDIO_SOURCE_RANGE");
        }
        return { sourceStartFrame, sourceEndFrame };
      };
      const requireProgramRange = (startFrame: number, endFrame: number) => {
        if (programEndFrame <= 0) throw new DomainError("必须先建立可播放主线，才能添加 BGM 或 SFX", "AUDIO_PROGRAM_NOT_READY");
        requireAudioFrame(startFrame, "声音起点", 0, Math.max(0, programEndFrame - 1));
        requireAudioFrame(endFrame, "声音终点", 1, programEndFrame);
        if (endFrame <= startFrame) throw new DomainError("声音目标范围无效", "INVALID_AUDIO_RANGE");
      };
      const createOrUpdateItem = (cue: AudioCue | undefined, trackName: "BGM" | "SFX", assetId: Id, startFrame: number, endFrame: number, sourceStartFrame: number, sourceEndFrame: number, gainDb: number) => {
        const track = trackByName(snapshot, trackName);
        if (track.locked) throw new DomainError(`${trackName} 轨已锁定`, "TRACK_LOCKED");
        if (!cue) {
          const item = createTimelineItem({ trackId: track.id, assetId, startFrame, endFrame, sourceStartFrame, sourceEndFrame, gainDb });
          snapshot.timeline.items.push(item);
          return item;
        }
        const item = snapshot.timeline.items.find((candidate) => candidate.id === cue.timelineItemId);
        if (!item) throw new DomainError("AudioCue 缺少关联 Timeline Item", "AUDIO_ITEM_MISSING");
        if (item.trackId !== track.id) throw new DomainError("AudioCue 不在对应声音轨", "AUDIO_TRACK_MISMATCH");
        item.assetId = assetId;
        item.startFrame = startFrame;
        item.endFrame = endFrame;
        item.sourceStartFrame = sourceStartFrame;
        item.sourceEndFrame = sourceEndFrame;
        item.gainDb = gainDb;
        item.disabled = false;
        return item;
      };

      if (input.action === "remove") {
        if (!input.audioCueId) throw new DomainError("移除声音需要 audioCueId", "AUDIO_CUE_REQUIRED");
        const cue = snapshot.audioCues.find((candidate) => candidate.id === input.audioCueId);
        if (!cue) throw new NotFoundError("AudioCue 不存在");
        const item = snapshot.timeline.items.find((candidate) => candidate.id === cue.timelineItemId);
        snapshot.audioCues = snapshot.audioCues.filter((candidate) => candidate.id !== cue.id);
        snapshot.timeline.items = snapshot.timeline.items.filter((candidate) => candidate.id !== cue.timelineItemId);
        impact.changed.push(cue.id, cue.timelineItemId);
        if (item) impact.dirtyRanges.push({ startFrame: item.startFrame, endFrame: item.endFrame, reason: "移除声音包装" });
        impact.recomputed.push("移除 BGM / SFX Timeline Item");
        return;
      }

      if (input.action === "create") {
        if (!input.kind || !input.assetId) throw new DomainError("添加声音必须指定 kind 和 assetId", "AUDIO_CREATE_FIELDS_REQUIRED");
        const asset = requireReadyAudioAsset(snapshot, input.assetId);
        const purpose = requireText(input.purpose, "声音用途");
        const kind = input.kind;
        const assetDuration = millisecondsToFrames(asset.metadata!.durationMs, snapshot.timeline.fps);
        const loop = input.loop ?? false;
        const gainDb = validateGain(input.gainDb ?? (kind === "bgm" ? -18 : -6));
        let startFrame: number;
        let endFrame: number;
        let sourceStartFrame: number;
        let sourceEndFrame: number;
        let fadeInFrames: number;
        let fadeOutFrames: number;
        let eventFrame: number | undefined;
        let onsetOffsetFrames: number | undefined;
        let ducking: AudioDucking | undefined;

        if (kind === "bgm") {
          if (input.eventFrame !== undefined || input.onsetOffsetFrames !== undefined || input.onsetReview !== undefined || input.effectEvent) {
            throw new DomainError("BGM 使用整片范围，不接受 SFX 事件与 onsetOffset", "UNEXPECTED_AUDIO_EVENT");
          }
          startFrame = input.startFrame ?? 0;
          endFrame = input.endFrame ?? programEndFrame;
          requireProgramRange(startFrame, endFrame);
          ({ sourceStartFrame, sourceEndFrame } = sourceRangeFor(asset, 0, assetDuration));
          if (!loop && sourceEndFrame - sourceStartFrame < endFrame - startFrame) {
            throw new DomainError("BGM 源范围不足以覆盖目标范围；请裁短、开启循环或更换音乐", "BGM_SOURCE_TOO_SHORT");
          }
          fadeInFrames = input.fadeInFrames ?? Math.min(12, Math.floor((endFrame - startFrame) / 2));
          fadeOutFrames = input.fadeOutFrames ?? Math.min(24, Math.floor((endFrame - startFrame) / 2));
          validateFades(fadeInFrames, fadeOutFrames, endFrame - startFrame);
          ducking = normalizeAudioDucking(input.ducking);
        } else {
          if (loop && !input.design?.durationFrames) throw new DomainError("持续 SFX 循环必须声明目标时长与接缝", "SFX_LOOP_UNSUPPORTED");
          if (input.startFrame !== undefined || input.endFrame !== undefined || input.ducking !== undefined && !input.design) {
            throw new DomainError("SFX 的位置由 eventFrame 与 onsetOffset 决定，不能混用 BGM 范围或 Duck", "SFX_EVENT_FIELDS_REQUIRED");
          }
          if (input.eventFrame === undefined) throw new DomainError("SFX 必须提供计划同步的 eventFrame；未复听须保留待审状态", "SFX_EVENT_REQUIRED");
          eventFrame = input.eventFrame;
          requireAudioFrame(eventFrame, "SFX 事件帧", 0, Math.max(0, programEndFrame - 1));
          onsetOffsetFrames = input.onsetOffsetFrames ?? 0;
          requireAudioFrame(onsetOffsetFrames, "SFX onsetOffset", 0, assetDuration - 1);
          ({ sourceStartFrame, sourceEndFrame } = sourceRangeFor(asset, 0, assetDuration));
          if (onsetOffsetFrames >= sourceEndFrame - sourceStartFrame) {
            throw new DomainError("SFX onsetOffset 必须落在当前源范围内", "INVALID_SFX_ONSET");
          }
          startFrame = eventFrame - onsetOffsetFrames;
          endFrame = startFrame + (input.design?.durationFrames ?? sourceEndFrame - sourceStartFrame);
          if (!loop && endFrame - startFrame > sourceEndFrame - sourceStartFrame) throw new DomainError("持续声音源范围不足，不能自动拉伸", "SOUND_SOURCE_TOO_SHORT");
          if (input.design) ducking = normalizeAudioDucking(input.ducking ?? { enabled: input.design.role !== "demonstration" });
          requireProgramRange(startFrame, endFrame);
          fadeInFrames = input.fadeInFrames ?? 0;
          fadeOutFrames = input.fadeOutFrames ?? 0;
          validateFades(fadeInFrames, fadeOutFrames, endFrame - startFrame);
        }

        const item = createOrUpdateItem(undefined, kind === "bgm" ? "BGM" : "SFX", asset.id, startFrame, endFrame, sourceStartFrame, sourceEndFrame, gainDb);
        const cue = createAudioCue({
          kind,
          assetId: asset.id,
          timelineItemId: item.id,
          purpose,
          anchor: kind === "bgm" ? "sequence_global" : "media_event",
          eventFrame,
          onsetOffsetFrames,
          onsetReview: kind === "sfx" ? onsetReview() : undefined,
          fadeInFrames,
          fadeOutFrames,
          loop,
          ducking
        });
        if (input.effectEvent) cue.effectEvent = bindEffectAudioEvent(snapshot, input.effectEvent, eventFrame!);
        cue.sustained = input.design?.durationFrames !== undefined;
        if (input.design) applyAudioDesign(snapshot, cue, input.design);
        snapshot.audioCues.push(cue);
        impact.changed.push(cue.id, item.id, asset.id);
        impact.dirtyRanges.push({ startFrame, endFrame, reason: `添加 ${kind === "bgm" ? "BGM" : "SFX"}` });
        impact.recomputed.push(kind === "bgm" ? "BGM 淡入淡出与 Dialogue Duck" : "SFX onset 与声音事件落点");
        return;
      }

      if (!input.audioCueId) throw new DomainError("更新声音需要 audioCueId", "AUDIO_CUE_REQUIRED");
      const cue = snapshot.audioCues.find((candidate) => candidate.id === input.audioCueId);
      if (!cue) throw new NotFoundError("AudioCue 不存在");
      if (input.kind && input.kind !== cue.kind) throw new DomainError("不能把既有 BGM 直接改成 SFX，或反向修改", "AUDIO_KIND_IMMUTABLE");
      const existingItem = snapshot.timeline.items.find((candidate) => candidate.id === cue.timelineItemId);
      if (!existingItem) throw new DomainError("AudioCue 缺少关联 Timeline Item", "AUDIO_ITEM_MISSING");
      const assetChanged = input.assetId !== undefined && input.assetId !== cue.assetId;
      if (cue.kind === "sfx" && (assetChanged || input.sourceStartFrame !== undefined && input.sourceStartFrame !== existingItem.sourceStartFrame) && input.onsetOffsetFrames === undefined) {
        throw new DomainError("更换音效或源起点后必须重新确认 onset 偏移，不能沿用旧文件测量", "SFX_ONSET_REVIEW_REQUIRED");
      }
      if (cue.effectEvent && cue.status === "stale" && input.effectEvent === undefined) {
        throw new DomainError("动效关联已失效，须显式重新确认 effectEvent，或传 null 解除关联", "SFX_EFFECT_REVIEW_REQUIRED");
      }
      const asset = requireReadyAudioAsset(snapshot, input.assetId ?? cue.assetId);
      const assetDuration = millisecondsToFrames(asset.metadata!.durationMs, snapshot.timeline.fps);
      const sourceDefaults = assetChanged ? { start: 0, end: assetDuration } : { start: existingItem.sourceStartFrame, end: existingItem.sourceEndFrame };
      const { sourceStartFrame, sourceEndFrame } = sourceRangeFor(asset, sourceDefaults.start, sourceDefaults.end);
      const gainDb = validateGain(input.gainDb ?? existingItem.gainDb ?? (cue.kind === "bgm" ? -18 : -6));
      const purpose = input.purpose === undefined ? cue.purpose : requireText(input.purpose, "声音用途");
      let startFrame: number;
      let endFrame: number;
      let eventFrame: number | undefined;
      let onsetOffsetFrames: number | undefined;
      let ducking: AudioDucking | undefined;
      let loop = false;

      if (cue.kind === "bgm") {
        if (input.eventFrame !== undefined || input.onsetOffsetFrames !== undefined || input.onsetReview !== undefined || input.effectEvent) {
          throw new DomainError("BGM 使用整片范围，不接受 SFX 事件与 onsetOffset", "UNEXPECTED_AUDIO_EVENT");
        }
        startFrame = input.startFrame ?? existingItem.startFrame;
        endFrame = input.endFrame ?? existingItem.endFrame;
        requireProgramRange(startFrame, endFrame);
        loop = input.loop ?? cue.loop;
        if (!loop && sourceEndFrame - sourceStartFrame < endFrame - startFrame) {
          throw new DomainError("BGM 源范围不足以覆盖目标范围；请裁短、开启循环或更换音乐", "BGM_SOURCE_TOO_SHORT");
        }
        ducking = normalizeAudioDucking(input.ducking, cue.ducking);
      } else {
        if (input.startFrame !== undefined || input.endFrame !== undefined || input.ducking !== undefined && !input.design || input.loop === true && !input.design?.durationFrames) {
          throw new DomainError("SFX 的位置由 eventFrame 与 onsetOffset 决定，不能混用 BGM 范围、Duck 或循环", "SFX_EVENT_FIELDS_REQUIRED");
        }
        eventFrame = input.eventFrame ?? cue.eventFrame;
        if (eventFrame === undefined) throw new DomainError("SFX 缺少计划同步的 eventFrame", "SFX_EVENT_REQUIRED");
        requireAudioFrame(eventFrame, "SFX 事件帧", 0, Math.max(0, programEndFrame - 1));
        onsetOffsetFrames = input.onsetOffsetFrames ?? cue.onsetOffsetFrames ?? 0;
        requireAudioFrame(onsetOffsetFrames, "SFX onsetOffset", 0, assetDuration - 1);
        if (onsetOffsetFrames >= sourceEndFrame - sourceStartFrame) {
          throw new DomainError("SFX onsetOffset 必须落在当前源范围内", "INVALID_SFX_ONSET");
        }
        startFrame = eventFrame - onsetOffsetFrames;
        loop = input.loop ?? cue.loop;
        endFrame = startFrame + (input.design?.durationFrames ?? (cue.sustained ? existingItem.endFrame - existingItem.startFrame : sourceEndFrame - sourceStartFrame));
        if (!loop && endFrame - startFrame > sourceEndFrame - sourceStartFrame) throw new DomainError("持续声音源范围不足，不能自动拉伸", "SOUND_SOURCE_TOO_SHORT");
        if (input.design || cue.role) ducking = normalizeAudioDucking(input.ducking ?? cue.ducking ?? { enabled: (input.design?.role ?? cue.role) !== "demonstration" });
        requireProgramRange(startFrame, endFrame);
      }
      const fadeInFrames = input.fadeInFrames ?? cue.fadeInFrames;
      const fadeOutFrames = input.fadeOutFrames ?? cue.fadeOutFrames;
      validateFades(fadeInFrames, fadeOutFrames, endFrame - startFrame);
      const oldStartFrame = existingItem.startFrame;
      const oldEndFrame = existingItem.endFrame;
      const nextBinding = input.effectEvent === null ? undefined : input.effectEvent ?? cue.effectEvent;
      // 活跃关联不能通过只移动绝对帧而悄悄脱离；重新绑定才会固定新的视觉版本。
      const effectEvent = nextBinding ? bindEffectAudioEvent(snapshot, nextBinding, eventFrame!) : undefined;
      const sourceOnsetUnchanged = !assetChanged && sourceStartFrame === existingItem.sourceStartFrame && sourceEndFrame === existingItem.sourceEndFrame && onsetOffsetFrames === cue.onsetOffsetFrames;
      const nextOnsetReview = cue.kind === "sfx" ? onsetReview(sourceOnsetUnchanged ? cue.onsetReview : undefined) : undefined;
      if ((!sourceOnsetUnchanged || input.design?.loopCrossfadeFrames !== undefined && input.design.loopCrossfadeFrames !== cue.loopCrossfadeFrames) && !input.design?.loopReview) cue.loopReview = undefined;
      const item = createOrUpdateItem(cue, cue.kind === "bgm" ? "BGM" : "SFX", asset.id, startFrame, endFrame, sourceStartFrame, sourceEndFrame, gainDb);
      cue.assetId = asset.id;
      cue.purpose = purpose;
      cue.anchor = cue.kind === "bgm" ? "sequence_global" : "media_event";
      cue.eventFrame = eventFrame;
      cue.onsetOffsetFrames = onsetOffsetFrames;
      cue.onsetReview = nextOnsetReview;
      cue.effectEvent = effectEvent;
      cue.fadeInFrames = fadeInFrames;
      cue.fadeOutFrames = fadeOutFrames;
      cue.loop = loop;
      cue.ducking = ducking;
      cue.sustained = input.design?.durationFrames !== undefined || cue.sustained;
      if (input.design || cue.role) applyAudioDesign(snapshot, cue, input.design ?? {});
      cue.status = "ready";
      cue.updatedAt = now();
      impact.changed.push(cue.id, item.id, asset.id);
      impact.dirtyRanges.push({ startFrame: Math.min(oldStartFrame, startFrame), endFrame: Math.max(oldEndFrame, endFrame), reason: `调整 ${cue.kind === "bgm" ? "BGM" : "SFX"}` });
      impact.recomputed.push(cue.kind === "bgm" ? "BGM 淡入淡出与 Dialogue Duck" : "SFX onset 与声音事件落点");

  }

  /**
   * 旁白是当前 Presenter 主线的节奏基准时，将未被手工覆盖的 A-roll 收齐到最终 SpeechAsset。
   * 只允许裁短已有素材；若需要补画面或会碰到既有 Cue，则拒绝自动改写，交回导演层决定。
   */
  alignPresenterToSpeech(input: { projectId: Id; baseRevision: number }): ProjectState {
    const state = this.repository.commit(input.projectId, input.baseRevision, "按旁白时长收齐 Presenter 主线", (snapshot, impact) => {
      const speechAsset = snapshot.speechAsset;
      if (!speechAsset || speechAsset.status !== "ready" || speechAsset.scriptRevision !== snapshot.script.revision) {
        throw new DomainError("必须先生成与当前 Script 一致的 SpeechAsset", "SPEECH_ASSET_NOT_READY");
      }
      const dialogueTrack = trackByName(snapshot, "Dialogue");
      const dialogueItem = snapshot.timeline.items.find((item) => item.trackId === dialogueTrack.id && item.assetId === speechAsset.assetId && !item.disabled);
      if (!dialogueItem) throw new DomainError("SpeechAsset 尚未写入 Dialogue 轨", "SPEECH_DIALOGUE_ITEM_MISSING");
      const actorTrack = trackByName(snapshot, "Actor / A-roll");
      if (actorTrack.locked) throw new DomainError("Actor / A-roll 轨已锁定，不能自动收齐", "TRACK_LOCKED");
      const actorItems = snapshot.timeline.items
        .filter((item) => item.trackId === actorTrack.id && !item.disabled)
        .sort((left, right) => left.startFrame - right.startFrame);
      if (actorItems.length === 0) throw new DomainError("没有可收齐的 Presenter 主画面", "MISSING_PRIMARY_VIDEO");

      const targetEndFrame = dialogueItem.endFrame;
      const currentEndFrame = actorItems[actorItems.length - 1]!.endFrame;
      if (targetEndFrame > currentEndFrame) {
        throw new DomainError("旁白长于现有 Presenter 主画面；请先补充可播放视频，系统不会凭空延长素材", "PRESENTER_VISUAL_TOO_SHORT");
      }
      if (targetEndFrame === currentEndFrame) return;

      const affectedItems = actorItems.filter((item) => item.endFrame > targetEndFrame);
      if (affectedItems.some((item) => item.directOverride)) {
        throw new DomainError("待收齐的主画面含有 direct_override，不能自动裁短", "DIRECT_OVERRIDE_PROTECTED");
      }
      const affectedSceneIds = new Set(affectedItems.map((item) => item.sceneId).filter((id): id is Id => Boolean(id)));
      const incompatibleCue = snapshot.effectCues.find((cue) => affectedSceneIds.has(cue.sceneId) && cue.endFrame > targetEndFrame);
      if (incompatibleCue) {
        throw new DomainError("待收齐范围已有 EffectCue；请先在当前 Revision 调整 Cue，再收齐主画面", "PRESENTER_TRIM_HAS_CUES");
      }

      const removedItemIds = new Set<Id>();
      for (const item of affectedItems) {
        if (item.startFrame >= targetEndFrame) {
          removedItemIds.add(item.id);
          impact.stale.push(item.id);
          continue;
        }
        const oldEndFrame = item.endFrame;
        item.endFrame = targetEndFrame;
        item.sourceEndFrame = item.sourceStartFrame + (targetEndFrame - item.startFrame);
        impact.changed.push(item.id);
        impact.dirtyRanges.push({ startFrame: targetEndFrame, endFrame: oldEndFrame, reason: "按 SpeechAsset 裁短 Presenter 主画面" });
      }
      snapshot.timeline.items = snapshot.timeline.items.filter((item) => !removedItemIds.has(item.id));

      const removedPerformanceIds = snapshot.actorPerformances
        .filter((performance) => removedItemIds.has(performance.timelineItemId))
        .map((performance) => performance.id);
      snapshot.actorPerformances = snapshot.actorPerformances.filter((performance) => !removedItemIds.has(performance.timelineItemId));
      impact.stale.push(...removedPerformanceIds);

      for (const scene of snapshot.scenes.filter((candidate) => candidate.type === "PresenterScene")) {
        const sceneItems = snapshot.timeline.items
          .filter((item) => item.sceneId === scene.id && item.trackId === actorTrack.id && !item.disabled)
          .sort((left, right) => left.startFrame - right.startFrame);
        if (sceneItems.length === 0) {
          throw new DomainError("收齐操作会移除整个已有 PresenterScene；请先手工调整场景边界", "PRESENTER_SCENE_REMOVAL_REQUIRED");
        }
        const nextEndFrame = sceneItems[sceneItems.length - 1]!.endFrame;
        if (nextEndFrame !== scene.endFrame) {
          scene.endFrame = nextEndFrame;
          scene.assetIds = [...new Set(sceneItems.map((item) => item.assetId))];
          impact.changed.push(scene.id);
        }
      }
      this.staleCutawaysForHostScenes(snapshot, affectedSceneIds, impact, "旁白时长收齐改变了主场景边界");
      this.staleAudioCuesForMainline(snapshot, impact, "旁白时长收齐改变了主线边界");
      impact.recomputed.push("Presenter 主画面、Scene Strip 与旁白时长对齐");
      assertTimelineValid(snapshot);
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  submitExport(input: { projectId: Id; revision?: number; purpose?: ExportPurpose; idempotencyKey?: string }): JobRecord {
    const state = this.readProject(input.projectId);
    const revision = input.revision ?? state.revision.number;
    const purpose = input.purpose ?? "delivery";
    this.repository.getRevision(input.projectId, revision);
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "export",
      payload: { revision, purpose },
      // 草稿不能复用正式交付 Job；否则一次旧草稿会绕过当前 Revision 的交付门禁。
      idempotencyKey: `${input.idempotencyKey ?? "export"}:${purpose}:${revision}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /**
   * 预检是独立异步 Job，便于用户在正式渲染前查看目标 Revision 的文件和运行时依赖问题。
   * Export Worker 仍会在真正渲染前再执行一次，避免预检通过后素材被移动或被修改。
   */
  submitRenderPreflight(input: { projectId: Id; revision?: number; purpose?: ExportPurpose; idempotencyKey?: string }): JobRecord {
    const state = this.readProject(input.projectId);
    const revision = input.revision ?? state.revision.number;
    this.repository.getRevision(input.projectId, revision);
    const job = this.repository.createJob({
      projectId: input.projectId,
      kind: "render_preflight",
      payload: { revision, purpose: input.purpose ?? "delivery" },
      // 预检与导出允许共用调用方业务键，但绝不能互相复用不同 kind 的 Job。
      idempotencyKey: `render-preflight:${input.idempotencyKey ?? "default"}:${input.purpose ?? "delivery"}:${revision}`
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  /** Render Worker 只通过 Application 登记已验证的文件，避免直接绕过项目状态中心写 SQLite。 */
  registerExportArtifact(artifact: ExportArtifact): ExportArtifact {
    const stored = this.repository.createExportArtifact(artifact);
    this.publish({ projectId: artifact.projectId, revision: artifact.revision, type: "job" });
    return stored;
  }

  readExportArtifact(input: { projectId: Id; artifactId: Id }): ExportArtifact {
    return this.repository.getExportArtifact(input.projectId, input.artifactId);
  }

  listExportArtifacts(projectId: Id): ExportArtifact[] {
    return this.repository.listExportArtifacts(projectId);
  }

  /** 只接受项目目录中的原始导出文件；复核和批准都先检查其哈希没有被替换。 */
  private async assertExportArtifactIntact(artifact: ExportArtifact): Promise<void> {
    const projectRoot = resolve(this.getProjectRoot(artifact.projectId));
    const artifactPath = resolve(projectRoot, artifact.relativePath);
    const relativePath = relative(projectRoot, artifactPath);
    if (!relativePath || /^\.\.(?:[\\/]|$)/u.test(relativePath) || isAbsolute(relativePath)) {
      throw new DomainError("ExportArtifact 文件路径不在项目目录内", "UNSAFE_EXPORT_ARTIFACT_PATH");
    }
    if (!existsSync(artifactPath)) throw new DomainError("ExportArtifact 文件已丢失，不能复核或批准", "EXPORT_ARTIFACT_MISSING");
    const file = await stat(artifactPath);
    if (!file.isFile() || file.size <= 0 || file.size !== artifact.fileSizeBytes) {
      throw new DomainError("ExportArtifact 文件大小与导出记录不一致，不能复核或批准", "EXPORT_ARTIFACT_CHANGED");
    }
    const fileHash = await sha256File(artifactPath);
    if (fileHash !== artifact.fileHash) {
      throw new DomainError("ExportArtifact 文件哈希已变化，不能把新的文件当作旧批准版本", "EXPORT_ARTIFACT_CHANGED");
    }
  }

  async recordExportArtifactReview(input: {
    projectId: Id;
    artifactId: Id;
    passes: EditorialReviewPass[];
    evidence: string[];
    findings: Array<{
      pass: EditorialReviewPass;
      severity: EditorialReviewSeverity;
      category: EditorialReviewCategory;
      summary: string;
      evidence: string;
      impact: string;
      suggestedFix?: string;
      verificationMethod?: string;
      objectId?: Id;
      frameRange?: { startFrame: number; endFrame: number };
    }>;
  }): Promise<ExportArtifact> {
    const artifact = this.readExportArtifact({ projectId: input.projectId, artifactId: input.artifactId });
    if (artifact.purpose !== "delivery") throw new DomainError("只有 delivery ExportArtifact 可以登记正式成片复核", "EXPORT_ARTIFACT_REVIEW_PURPOSE_INVALID");
    await this.assertExportArtifactIntact(artifact);
    const passes = [...new Set(input.passes)];
    if (!passes.length || passes.some(pass => !["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"].includes(pass))) {
      throw new DomainError("只登记实际执行的文件复核轮次，至少提供一项", "EXPORT_ARTIFACT_REVIEW_INCOMPLETE");
    }
    const evidence = [...new Set(input.evidence.map((value) => value.trim()).filter(Boolean))];
    if (evidence.length === 0) throw new DomainError("成片复核必须说明实际播放或试听最终文件的证据", "EXPORT_ARTIFACT_EVIDENCE_REQUIRED");
    const findings: EditorialReviewFinding[] = input.findings.map((finding) => {
      if (!passes.includes(finding.pass)) throw new DomainError("成片复核问题引用了未执行的审片轮次", "EXPORT_ARTIFACT_REVIEW_PASS_MISSING");
      const summary = finding.summary.trim();
      const evidenceText = finding.evidence.trim();
      const impact = finding.impact.trim();
      if (!summary || !evidenceText || !impact) throw new DomainError("成片复核问题必须说明现象、证据和影响", "INVALID_EXPORT_ARTIFACT_FINDING");
      if (finding.frameRange && (finding.frameRange.startFrame < 0 || finding.frameRange.endFrame <= finding.frameRange.startFrame)) {
        throw new DomainError("成片复核问题的帧范围无效", "INVALID_EXPORT_ARTIFACT_FRAME_RANGE");
      }
      return {
        id: createId("export_artifact_finding"),
        pass: finding.pass,
        severity: finding.severity,
        category: finding.category,
        summary,
        evidence: evidenceText,
        impact,
        suggestedFix: finding.suggestedFix?.trim() || undefined,
        verificationMethod: finding.verificationMethod?.trim() || undefined,
        objectId: finding.objectId,
        frameRange: finding.frameRange
      };
    });
    const review: ExportArtifactReview = { passes, evidence, findings, reviewedAt: now() };
    const updated = this.repository.updateExportArtifact(input.projectId, input.artifactId, (stored) => {
      if (stored.approval) throw new DomainError("已批准的 ExportArtifact 不能覆盖成片复核记录", "EXPORT_ARTIFACT_APPROVED");
      // 固定文件没有发生修复时，空的新报告不能抹掉该文件已有的问题；修片后导出新 Artifact。
      stored.artifactReview = { ...review, findings: [...(stored.artifactReview?.findings ?? []), ...review.findings] };
    });
    this.publish({ projectId: input.projectId, revision: artifact.revision, type: "job" });
    return updated;
  }

  async approveExportArtifact(input: { projectId: Id; artifactId: Id; confirmedByUser?: true; fileHash?: string; note?: string }): Promise<ExportArtifact> {
    const artifact = this.readExportArtifact({ projectId: input.projectId, artifactId: input.artifactId });
    if (artifact.purpose !== "delivery") throw new DomainError("只能批准 delivery ExportArtifact，draft 仍是内部审片文件", "EXPORT_ARTIFACT_APPROVAL_PURPOSE_INVALID");
    await this.assertExportArtifactIntact(artifact);
    const confirmation = exportApprovalSchema.safeParse({ confirmedByUser: input.confirmedByUser, fileHash: input.fileHash, note: input.note });
    if (!confirmation.success) throw new DomainError("人工定稿需要用户对指定文件的明确确认及完整哈希；导出成功或 AI 审阅不能代替", "EXPORT_ARTIFACT_USER_CONFIRMATION_REQUIRED");
    if (confirmation.data.fileHash !== artifact.fileHash) throw new DomainError("用户确认的文件哈希与此产物不一致", "EXPORT_ARTIFACT_CONFIRMATION_MISMATCH");
    const note = confirmation.data.note;
    const updated = this.repository.updateExportArtifact(input.projectId, input.artifactId, (stored) => {
      // 已批准记录不可被后续同名请求改写，保证“用户批准的是哪个文件”可以稳定读回。
      if (!stored.approval) stored.approval = { approvedAt: now(), confirmedByUser: true, fileHash: artifact.fileHash, note: note || undefined };
    });
    this.publish({ projectId: input.projectId, revision: artifact.revision, type: "job" });
    return updated;
  }

  rollbackToRevision(input: { projectId: Id; baseRevision: number; targetRevision: number }): ProjectState {
    const target = this.repository.getRevision(input.projectId, input.targetRevision);
    const state = this.repository.commit(input.projectId, input.baseRevision, `回退到 Revision ${input.targetRevision}`, (snapshot, impact) => {
      const restored = cloneSnapshot(target.snapshot);
      Object.assign(snapshot, restored);
      snapshot.project.updatedAt = now();
      impact.changed.push(snapshot.project.id);
      impact.recomputed.push("从不可变快照恢复全部项目对象");
      impact.dirtyRanges.push({ startFrame: 0, endFrame: snapshot.timeline.durationInFrames, reason: "Revision 回退" });
    });
    this.publish({ projectId: input.projectId, revision: state.revision.number, type: "revision" });
    return state;
  }

  trackJob(jobId: Id): JobRecord {
    return this.repository.getJob(jobId);
  }

  listJobs(projectId: Id): JobRecord[] {
    return this.repository.listJobs(projectId);
  }

  updateJob(jobId: Id, input: { status: JobStatus; result?: Record<string, unknown>; error?: string; leaseUntil?: string }): JobRecord {
    const job = this.repository.updateJob(jobId, input);
    const project = this.readProject(job.projectId);
    this.publish({ projectId: job.projectId, revision: project.revision.number, type: "job" });
    return job;
  }

  claimNextJob(kinds?: JobKind[], leaseMilliseconds?: number): JobRecord | undefined {
    return this.repository.claimNextJob(kinds, leaseMilliseconds);
  }

  renewJobLease(jobId: Id, leaseMilliseconds?: number): JobRecord {
    return this.repository.renewJobLease(jobId, leaseMilliseconds);
  }
}

export function createApplication(workspaceRoot = readRuntimeConfig().workspace.root): EditingApplication {
  return new EditingApplication(new ProjectRepository(workspaceRoot));
}

// 高层五阶段入口单独放置，避免日常阅读时先进入庞大的具体业务命令实现。
export * from "./production-flow";

export function resolveItemDuration(item: TimelineItem): number {
  return item.endFrame - item.startFrame;
}

export function durationMsForItem(item: TimelineItem, fps: number): number {
  return framesToMilliseconds(resolveItemDuration(item), fps);
}
