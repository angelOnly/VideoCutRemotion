/**
 * Web、MCP、Worker 共用的契约。这里仅描述数据，不放业务规则，避免形成第二套状态。
 */
export type Id = string;
export type * from "./source-review.js";
export * from "./frame-rate.js";
import { motionDurationAtFps } from "./frame-rate.js";
export type * from "./media-intelligence.js";
import type { MediaAdoption, SoundPlan, AudioRole, AudioEnvelopePoint, MotionEventMap, SourceTimeRange } from "./media-intelligence.js";

export type ProductionProfile =
  | "presenter_motion"
  | "visual_explainer"
  | "vlog"
  | "hybrid";

export type AssetKind =
  | "video"
  | "audio"
  | "image"
  | "document"
  | "actor_video"
  | "speech"
  | "derived";

/**
 * 素材在当前成片中的明确职责。未分类素材不能被 Presenter 主线自动选中，
 * 避免把 B-roll、证据或参考图误当成 A-roll。
 */
export type AssetRole =
  | "a_roll"
  | "b_roll"
  /** 实拍事件驱动主线的原始素材；不等同于 Presenter 的 A-roll。 */
  | "vlog_source"
  | "actor_mask"
  | "voice_reference"
  | "sfx"
  | "bgm"
  | "evidence"
  | "cutaway"
  | "style_reference"
  | "generated_visual";

/**
 * 素材来源记录。保存实际来源与取得信息；二进制去重使用 Asset.sourceHash。
 */
export interface AssetProvenance {
  source: "local_import" | "generated" | "provider";
  provider?: string;
  sourceUrl?: string;
  originalAssetId?: string;
  creator?: string;
  /**
   * 生成视频的可追溯提交事实。它只记录已经写入本项目的 Job、工作流和输入，
   * 不保存 Provider 的临时下载地址或任何二进制数据。
   */
  generationJobId?: Id;
  generation?: GeneratedVideoProvenance;
  /** 从本项目已入库视频提取音频时，保留源身份与精确半开源范围。 */
  derivedFrom?: { assetId: Id; sourceHash: string; startMs: number; endMs: number };
  /** 本地零点对应原片 sourceRange.startMs；省略范围表示整文件。 */
  acquisition?: AssetAcquisitionOptions & { candidateId: Id; candidateIds?: Id[] };
  acquiredAt: string;
}

/** 当前 Bridge 已接入的四类 MiniMax 视频生成输入合同。 */
export type VideoGenerationMode =
  | "text_to_video"
  | "image_to_video"
  | "first_last_frame"
  | "multi_reference";

/** 生成视频进入 Asset 后仍能解释它来自哪次受管任务，而非把 Prompt 藏在 Worker 内存里。 */
export interface GeneratedVideoProvenance {
  jobId: Id;
  workflowId: string;
  mode: VideoGenerationMode;
  inputAssetIds: Id[];
  prompt: string;
  durationSeconds: number;
  aspectRatio: "9:16" | "16:9" | "1:1";
}

/**
 * 素材需求、搜索意图和候选都属于同一个 Project Revision。
 * 候选不是 Asset，未完成本地化、技术校验前绝不能被 Scene 或 Timeline 引用。
 */
export type AssetRequestStatus = "open" | "candidates_ready" | "acquiring" | "fulfilled" | "closed";
export type AssetCandidateStatus = "available" | "rejected" | "acquisition_queued" | "acquiring" | "acquired" | "failed";

export interface AssetAcquisitionOptions {
  qualityHeight?: number;
  sourceRange?: SourceTimeRange;
}

export interface AssetRequest {
  id: Id;
  title: string;
  purpose: string;
  /** 历史需求省略时按视觉处理；音频不需要伪造画幅或画面说明。 */
  mediaKind?: "visual" | "audio";
  visualBrief?: string;
  audioBrief?: string;
  sound?: { soundPlanId: string; soundIntentId: string; material?: string; attack?: string; tail?: string; energy?: string; excludeSpeech: boolean; excludeMusic: boolean; maxDurationMs?: number };
  role: AssetRole;
  queryHints: string[];
  excludedTerms: string[];
  targetAspectRatio?: "9:16" | "16:9" | "1:1";
  /** 选段时的连续长度要求，不作为搜索或下载准入条件。 */
  minDurationMs?: number;
  fallbackPlan: "keep_presenter" | "remotion" | "minimax" | "ask_user" | "local_audio" | "omit_audio";
  status: AssetRequestStatus;
  closeReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** Provider 已归一化的查询，不泄露 API Key、下载 URL 或 Provider 私有字段。 */
export interface SearchIntent {
  cursor?: string;
  id: Id;
  assetRequestId: Id;
  provider: string;
  query: string;
  mediaType?: "image" | "video" | "audio";
  createdAt: string;
}

/** 搜索是否完整独立保存；少量候选不代表已经检索完全部结果。 */
export interface AssetSearchDiagnostics {
  complete: boolean;
  warnings: { code: string; message: string; source?: string; stage?: string; retryAfterMs?: number }[];
}

export interface AssetCandidate {
  id: Id;
  assetRequestId: Id;
  searchIntentId: Id;
  provider: string;
  originalAssetId: string;
  name: string;
  /** 候选的真实媒介类型；音频与视觉需求不能混用。 */
  kind: "video" | "image" | "audio";
  sourceUrl: string;
  previewUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  creator?: string;
  tags: string[];
  hardFilterPassed: boolean;
  filterReasons: string[];
  status: AssetCandidateStatus;
  rejectionReason?: string;
  acquisitionError?: string;
  acquiredAssetId?: Id;
  acquisition?: AssetAcquisitionOptions;
  createdAt: string;
  updatedAt: string;
}

export type AssetStatus = "queued" | "analyzing" | "ready" | "failed" | "missing";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
/** 草稿只用于内部审片；交付版必须经过当前 Revision 的完整审片。 */
export type ExportPurpose = "draft" | "delivery";
export type JobKind =
  | "media_analysis"
  | "media_understanding"
  | "media_search"
  | "sound_comparison" | "sound_ranking"
  /** 对已就绪实拍素材做基础镜头边界和现场声可用性分析。 */
  | "vlog_analysis"
  /** 只在可验证的共同音轨上估计固定机位偏移；证据不足时必须失败并等待人工同步点。 */
  | "multicam_sync"
  | "asset_acquisition"
  | "source_material_acquisition"
  | "transcription"
  /** 历史 VAD 分块 Job；只为读取旧记录保留，新的 Worker 绝不能执行或创建。 */
  | "source_caption_generation"
  /** 历史 token-only Job；只为读取旧记录保留。 */
  | "source_caption_sentence_alignment"
  /** 原声 A-roll 的正式段级字幕对齐：Provider segment、默认 Program 与 Caption 在同一提交中写入。 */
  | "source_caption_alignment"
  | "voice_synthesis"
  /** 保留原声并生成最小 / 强处理候选；选择候选是独立的 Revision 写入。 */
  | "dialogue_processing"
  /** 对已组装的 SpeechAsset 执行真实强制对齐；没有真实输出时不能把精度标为 word_exact。 */
  | "speech_alignment"
  /** 受控音乐 Provider 的异步生成；运行前必须动态读取其最新 Schema。 */
  | "music_generation"
  /** 文生、图生、首尾帧和多参考视频均走同一受管的 Bridge 视频生成 Job。 */
  | "video_generation"
  | "motion_generation"
  | "avatar_generation"
  | "speech_assembly"
  | "preview"
  | "render_preflight"
  | "export";

export type TrackKind = "video" | "audio" | "caption";
/** 当前阶段只把独立 BGM / SFX 作为可编辑声音包装；主 Dialogue 仍由 SpeechAsset 管理。 */
export type AudioCueKind = "bgm" | "sfx";
export type AudioCueStatus = "ready" | "stale";
export type SceneType =
  | "PresenterScene"
  | "ExplainerScene"
  | "VlogMontageScene"
  | "CutawayScene"
  | "EndCardScene";

export type EffectType =
  | "MetricBackdrop"
  | "ProductFan"
  | "GlowCTA"
  | "PortfolioWall"
  | "CommentCloud"
  | "EvidenceCard"
  | "CameraPunch"
  | "FullScreenMeme"
  | "DeviceShowcase"
  | "ContentCarousel"
  | "EndCard"
  | "ManagedMotion";

/**
 * `source_token_anchored` 表示原声字幕卡的起止来自 Provider 明确返回的 token 时间。
 * token 可以是汉字、词或子词，不能把它误读成适用于逐词动画的 `word_exact`。
 * `sentence_exact` 可表示 Provider 直接给出、但没有可验证 token 细节的原声字幕段时间。
 */
export type TimingPrecision = "segment_exact" | "sentence_exact" | "chunk_coarse" | "source_token_anchored" | "word_exact" | "unavailable";

export interface CreativeBrief {
  platform: string;
  aspectRatio: "9:16" | "16:9" | "1:1";
  targetDurationSeconds: number;
  audience: string;
  tone: string;
  captionMode: "stable" | "none";
  allowHighDensityMotion: boolean;
}

export interface MediaMetadata {
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
  videoCodec?: string;
  /** ffprobe 返回的像素格式；仅用于保守判断是否实际带 Alpha。 */
  pixelFormat?: string;
  /** 由媒体分析从已知 Alpha 像素格式得出，不能由客户端自由声称。 */
  hasAlpha?: boolean;
  thumbnailPath?: string;
  waveformPath?: string;
  mime?: string;
}

export type MotionReviewOutcome = "passed" | "failed" | "inconclusive";
export interface MotionReviewEvidenceInput {
  kind: "work_proxy" | "project_preview";
  previewJobId?: Id;
  startFrame: number;
  endFrame: number;
  method: "frames" | "continuous_video" | "audio" | "audiovisual";
}
export interface MotionReviewEvidence extends MotionReviewEvidenceInput {
  relativePath: string;
  contentHash: string;
  revision: number;
  workStartFrame: number;
  workEndFrame: number;
  recordedAt: string;
}

/** 统一解释新旧审阅；旧参考记录只适用于没有创作说明的历史作品。 */
export function managedMotionReviewOutcome(motion: Asset["motion"]): MotionReviewOutcome | undefined {
  const review = motion?.review;
  if (!review || !motion) return undefined;
  if (review.outcome !== undefined) {
    if (review.version !== motion.version) return undefined;
    if (review.outcome === "passed" && (!review.evidence || !["continuous_video", "audiovisual"].includes(review.evidence.method)
      || review.evidence.workStartFrame !== 0 || review.evidence.workEndFrame !== motion.frameCount)) return undefined;
    return review.outcome;
  }
  return !motion.creativeBrief && motion.referenceUrl ? review.referenceMatch : undefined;
}

export interface Asset {
  id: Id;
  name: string;
  kind: AssetKind;
  status: AssetStatus;
  managedPath: string;
  originalPath?: string;
  sourceHash?: string;
  role?: AssetRole;
  provenance?: AssetProvenance;
  tags: string[];
  metadata?: MediaMetadata;
  createdAt: string;
  failureReason?: string;
  /** 受管作品保留源码来源和透明帧缓存；审阅代理不能替代正式 Alpha 合成。 */
  motion?: {
    jobId: Id;
    version: string;
    engineVersion: string;
    previousAssetId?: Id;
    /** 平台登记的实际派生来源。 */
    sourceAssetIds?: Id[];
    /** 固定图片槽位与原图身份，供具体采用关系核验。 */
    imageSources?: Array<{ slot: string; assetId: Id; sourceHash: string }>;
    /** 至多四个固定视频槽位，仅由完成 Job 生成。 */
    videoSources?: Array<{ slot: string; assetId: Id; sourceHash: string; sourceStartMs: number; sourceEndMs: number; startFrame?: number; endFrame?: number }>;
    /** 字体随发行固定，不作为视频素材；保存实际文件身份便于追溯。 */
    fontSources?: Array<{ slot: string; fontId: string; sourceHash: string; weight: number; style: "normal" | "italic" }>;
    sourcePath: string;
    framesDirectory: string;
    frameCount: number;
    fps: number;
    width: number;
    height: number;
    referenceUrl?: string;
    creativeBrief?: string;
    eventMap?: MotionEventMap;
    review?: { referenceMatch?: MotionReviewOutcome; outcome?: MotionReviewOutcome; version?: string; evidence?: MotionReviewEvidence; note: string; reviewedAt: string };
  };
}

/**
 * Vlog 的 Shot 证据只描述可由 Worker 或人工确认的源片段，不把“人物在做什么”伪装成视觉模型结论。
 * 第一版的 ffmpeg_scene 仅提供场景变化边界、变化分数和音轨存在性；事件意义仍由导演层写入 VlogEvent。
 */
export type VlogShotAnalysisSource = "ffmpeg_scene" | "manual";
export interface VlogShotAnalysis {
  id: Id;
  assetId: Id;
  analysisJobId?: Id;
  sourceStartFrame: number;
  sourceEndFrame: number;
  source: VlogShotAnalysisSource;
  /** ffmpeg scene filter 的原始变化分数；手工边界可以不填写。 */
  sceneChangeScore?: number;
  /** 仅是技术可用性评分，不能替代事件价值、表演或叙事判断。 */
  technicalScore: number;
  hasAudio: boolean;
  evidenceNote: string;
  status: "ready" | "stale";
  createdAt: string;
  updatedAt: string;
}

/** Event Map 保存导演从真实 Shot 证据中发现的事件，不会从文件名或画质自动推断故事。 */
export interface VlogEvent {
  id: Id;
  order: number;
  title: string;
  summary: string;
  shotAnalysisIds: Id[];
  goal?: string;
  action?: string;
  change?: string;
  reaction?: string;
  outcome?: string;
  locationNote?: string;
  continuityNote?: string;
  status: "draft" | "ready" | "stale";
  createdAt: string;
  updatedAt: string;
}

export type VlogShotFunction = "establish" | "action" | "detail" | "reaction" | "transition" | "atmosphere";
export type VlogSourceAudioMode = "keep" | "mute";

/**
 * ShotSelect 是唯一可进入 Vlog Timeline 的镜头选择。程序时长暂时等于源范围时长；
 * 未实现变速、补帧或自动节拍剪辑前，不允许通过伪造 programDuration 改变这个事实。
 */
export interface VlogShotSelect {
  id: Id;
  eventId: Id;
  shotAnalysisId: Id;
  order: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
  function: VlogShotFunction;
  selectionReason: string;
  continuityNote: string;
  sourceAudioMode: VlogSourceAudioMode;
  sceneId?: Id;
  timelineItemId?: Id;
  ambientTimelineItemId?: Id;
  status: "planned" | "ready" | "stale";
  createdAt: string;
  updatedAt: string;
}

/**
 * Ambient 使用同一条受管视频的音轨，但在独立 Ambient 轨播放，避免视频层与环境声层重复输出。
 * 它保留“这段现场声来自哪个真实 Shot”的追溯，而不是用一条 BGM 冒充现场感。
 */
export interface VlogAmbientCue {
  id: Id;
  shotSelectId: Id;
  assetId: Id;
  timelineItemId: Id;
  purpose: string;
  status: "ready" | "stale";
  createdAt: string;
  updatedAt: string;
}

/** 手工确认的音乐拍点，供 Vlog 导演对照切点；它不声称系统已自动完成节拍检测。 */
export interface VlogMusicBeat {
  id: Id;
  audioCueId: Id;
  frame: number;
  note: string;
  source: "manual_verified";
  status: "ready" | "stale";
  createdAt: string;
}

/**
 * 多机位同步先保存“同一真实时刻”怎样映射到每台相机的源帧，而不是只把若干视频并排放进 Timeline。
 * sessionOffsetFrames 的定义为：sessionFrame = sourceFrame + sessionOffsetFrames；参考机位始终为 0。
 */
export type MulticamSyncMethod = "audio_correlation" | "manual_marker";
/** 自动相关只产出 candidate；必须经过连续预览或人工同一事件确认后才能用于编译。 */
export type MulticamSyncEvidenceStatus = "candidate" | "verified" | "rejected" | "insufficient";
/**
 * 本次多机位同步实际验证过的原始素材区间，统一使用项目 Timeline FPS 的半开帧区间。
 * 它不是物理裁片：Timeline 仍直接引用完整受管素材，再由 Cut 的 source 范围取用。
 */
export interface MulticamSourceRange {
  startFrame: number;
  endFrame: number;
}
export interface MulticamSyncEvidence {
  /** 参考机位和目标机位中确实被比较/确认的同一事件帧，均归一化到项目 Timeline FPS。 */
  referenceSourceFrame: number;
  angleSourceFrame: number;
  windowFrames: number;
  analysisVersion: string;
  referenceSourceHash: string;
  angleSourceHash: string;
  /** 人工确认或 Worker 分析的简洁可读说明；文件名和 creation_time 只能作为提示，不能成为同步结论。 */
  note: string;
  verifiedAt?: string;
}
export interface MulticamAngleSync {
  assetId: Id;
  /** 由操作者显式命名（如 A 机、B 机），绝不从文件名、路径或 creation_time 猜测。 */
  label: string;
  sessionOffsetFrames: number;
  method: MulticamSyncMethod;
  /** 自动音频相关的归一化置信度；人工同步点固定为 1，但仍须保留其依据。 */
  confidence: number;
  /** 最优峰和次优峰的差值过小时，不能把偶然的环境声当作唯一同步事实。 */
  peakMargin?: number;
  /** 双窗口检测到的偏移差；第一版不做变速补偿，超过阈值只能拆短段或人工重同步。 */
  driftFrames?: number;
  /**
   * 自动同步只在此源区间内建立和复核固定偏移。旧项目缺失时兼容解释为整条素材，
   * 但新自动同步 Group 必须写入该字段，避免跨会话原片被误用于切机位。
   */
  sourceRange?: MulticamSourceRange;
  status: MulticamSyncEvidenceStatus;
  evidence: MulticamSyncEvidence;
}

/**
 * 自动共同音轨同步生成的受管连续预览。它仅证明选定会话范围内的声画对齐，
 * 不等同于正式 Timeline Preview，也不替代人工核对说明。
 */
export interface MulticamSyncPreview {
  /** 相对项目根目录的 MP4 路径，不能引用项目外任意文件。 */
  relativePath: string;
  contentHash: string;
  durationMs: number;
  fps: number;
  sessionStartFrame: number;
  sessionEndFrame: number;
  /** 每个角度实际进入并排预览的原片源范围，统一为项目 Timeline FPS。 */
  sourceWindows: Record<Id, MulticamSourceRange>;
}

/**
 * 一个 Group 只描述同步事实和主声音来源，不替代剪辑决定。
 * 音频相关无法得出唯一高置信偏移时不创建 ready Group，改由人工同一事件标记兜底。
 */
export interface MulticamGroup {
  id: Id;
  title: string;
  referenceAssetId: Id;
  masterAudioAssetId: Id;
  angleAssetIds: Id[];
  angleSyncs: MulticamAngleSync[];
  syncJobId?: Id;
  status: "candidate" | "ready" | "stale";
  /** 当前一次编译产物；重编时旧 Timeline Item 会被停用而不是覆盖历史 Revision。 */
  sceneId?: Id;
  masterAudioTimelineItemId?: Id;
  programStartFrame?: number;
  programEndFrame?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Cut 是导演选定的机位和已同步的会话范围。source 范围由 Group 的同步偏移计算并固化，
 * 因此绝不允许调用方按猜测直接写入某个机位的源时间。
 */
export interface MulticamCut {
  id: Id;
  groupId: Id;
  order: number;
  angleAssetId: Id;
  sessionStartFrame: number;
  sessionEndFrame: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
  reason: string;
  continuityNote: string;
  sceneId?: Id;
  timelineItemId?: Id;
  status: "planned" | "ready" | "stale";
  createdAt: string;
  updatedAt: string;
}

/**
 * Bridge 请求只保存公开字段和值摘要，不保存媒体二进制；这样 Bridge 重启后仍能诊断一次任务。
 */
export interface BridgeRequestSummary {
  fieldValues: Record<string, unknown>;
  fileSlots: Array<{ id: string; kind: string; fileName: string }>;
  /** 受控 Worker 可补充不含二进制或秘密的请求定位信息，用于安全恢复同一次外部 Run。 */
  metadata?: Record<string, string | number | boolean>;
}

/** Bridge Run 的可持久化响应子集，避免项目长期依赖 Bridge 进程内的临时状态。 */
export interface BridgeResponseSummary {
  status: "queued" | "running" | "succeeded" | "failed";
  error?: string | null;
  outputs: Array<{
    outputSlotId: string;
    displayName: string;
    kind: string;
    fileName?: string;
    mime?: string;
    outputId?: string;
    downloadUrl?: string;
    text?: string;
  }>;
}

/**
 * 每次外部工作流均留下可读的运行审计。Run 丢失时至少能看到本地 Job、请求摘要和最后的 run_id。
 */
export interface BridgeRunAudit {
  workflowId: string;
  runId: string;
  schemaVersion: string;
  schemaRetryCount: number;
  submittedAt: string;
  completedAt?: string;
  request: BridgeRequestSummary;
  response?: BridgeResponseSummary;
}

export interface TranscriptText {
  id: Id;
  assetId: Id;
  text: string;
  source: "funasr" | "manual";
  bridgeRunId?: string;
  schemaVersion?: string;
  bridgeAudit?: BridgeRunAudit;
  createdAt: string;
}

/**
 * FunASR 返回全文后，代码只按标点生成候选句，供专业 Skill 审阅；
 * 它不是可直接用于剪辑或 TTS 的语义结论。
 */
export interface TranscriptSentenceCandidate {
  id: Id;
  transcriptId: Id;
  text: string;
  order: number;
  sourceAssetId: Id;
}

export type SemanticUnitKind =
  | "statement"
  | "question"
  | "answer"
  | "cause"
  | "conclusion"
  | "contrast"
  | "list_item"
  | "setup"
  | "payoff"
  | "retake"
  | "intentional_repetition";

export interface SpeechPause {
  durationMs: number;
  reason: "sentence" | "contrast" | "emotion" | "breath" | "chapter";
}

export interface SemanticUnit {
  id: Id;
  /** 旧数据未填写时仍表示转写；原创语义不虚构音频或候选来源。 */
  sourceKind?: "transcript" | "authored";
  sourceNote?: string;
  transcriptId?: Id;
  text: string;
  order: number;
  sourceAssetId?: Id;
  status: "included" | "deleted";
  /** 该语义单元由哪些标点候选组合而来，保持可追溯性。 */
  candidateIds: Id[];
  kind: SemanticUnitKind;
  dependencies: Id[];
  precedingContext: string;
  followingContext: string;
  retakeGroupId?: Id;
  confidence: number;
  pauseBefore?: SpeechPause;
}

export interface SpeechSegment {
  id: Id;
  semanticUnitIds: Id[];
  text: string;
  order: number;
  /** 最终节奏由语义判断显式提供，而不是对所有句子套固定停顿。 */
  pauseBefore: SpeechPause;
  pauseAfter?: SpeechPause;
  /** 旧 Revision 兼容字段；新代码应使用 pauseBefore / pauseAfter。 */
  prePauseMs?: number;
  postPauseMs?: number;
  status: "pending" | "ready" | "stale" | "failed";
}

export interface SpeechSegmentTiming {
  speechSegmentId: Id;
  startMs: number;
  endMs: number;
  startFrame: number;
  endFrame: number;
}

export interface SpeechTiming {
  precision: TimingPrecision;
  source: string;
  segments: SpeechSegmentTiming[];
}

/**
 * 对齐器实际返回的词、字或其它最小可读 token 的时序。
 * `normalizedText` 由本地校验器生成，用来证明这些 token 仍对应当前可播放 Script，
 * 绝不由按字数估算的算法生成。
 */
export interface WordTiming {
  speechSegmentId: Id;
  text: string;
  normalizedText: string;
  startMs: number;
  endMs: number;
  startFrame: number;
  endFrame: number;
  /** Provider 未公开置信度时保持 undefined，不能伪造一个分数。 */
  confidence?: number;
}

/**
 * 可选的真实词级对齐结果。它与当前 SpeechAsset、Script Revision 和 Bridge Run 绑定；
 * 主声音或文字变化后必须 stale，不能让旧时间戳继续被当成 word_exact。
 */
export interface SpeechAlignment {
  id: Id;
  generationJobId: Id;
  speechAssetId: Id;
  scriptRevision: number;
  status: "ready" | "stale";
  words: WordTiming[];
  source: string;
  audit: BridgeRunAudit;
  createdAt: string;
}

export interface SpeechSegmentAsset {
  id: Id;
  speechSegmentId: Id;
  voiceReferenceAssetId?: Id;
  voiceReferenceId?: Id;
  assetId: Id;
  durationMs: number;
  bridgeRunId: string;
  schemaVersion: string;
  bridgeAudit?: BridgeRunAudit;
  quality: "passed" | "warning" | "failed";
}

export interface SpeechAsset {
  id: Id;
  assetId: Id;
  scriptRevision: number;
  segmentAssetIds: Id[];
  timing: SpeechTiming;
  /**
   * 对当前旁白总轨的受控处理记录。候选生成不会替换 assetId，只有人工试听后
   * 显式选择 variant 才会切换 Dialogue 轨，避免“更干净”被自动当成更好。
   */
  dialogueProcessing?: DialogueProcessing;
  status: "ready" | "failed";
}

/** 首版只处理完整 SpeechAsset，不把源素材、Room Tone 或局部拼接伪装成已经支持。 */
export type DialogueProcessingIssue = "noise" | "low_frequency" | "sibilance" | "loudness" | "true_peak";
export type DialogueProcessingProfile = "original" | "minimal" | "strong";

export interface DialogueProcessingVariant {
  profile: DialogueProcessingProfile;
  /** original 直接引用未改写的源 Asset；其它 profile 是 Worker 生成并核验的本地 WAV。 */
  assetId: Id;
  /** 实际启用的 FFmpeg 滤镜摘要，供试听与问题追溯，不能把它当成审美通过结论。 */
  filters: string[];
  durationMs: number;
  contentHash?: string;
}

/**
 * Job 是异步执行审计；该对象保存当前 SpeechAsset 可试听候选与已选版本，
 * 因而随 Revision 可回读，且不会滥用仅属于 BGM / SFX 的 AudioCue。
 */
export interface DialogueProcessing {
  jobId: Id;
  requestedRevision: number;
  sourceAssetId: Id;
  sourceDurationMs: number;
  issueTypes: DialogueProcessingIssue[];
  evidenceNote: string;
  processingVersion: "v1";
  variants: DialogueProcessingVariant[];
  selectedProfile?: DialogueProcessingProfile;
  createdAt: string;
}

/** VoiceReference 只记录本地参考音频 Asset，不保存或伪造远端 Voice ID。 */
export interface VoiceReference {
  id: Id;
  assetId: Id;
  label: string;
  /** 仅表示项目内的本地来源；绝不对应外部供应商的 Voice ID。 */
  source: "local_asset";
  usageNote: string;
  recommendedRange: { startMs: number; endMs: number };
  quality: "passed" | "warning" | "failed";
  usable: boolean;
  createdAt: string;
}

/** Story 保存叙事意图；Timeline 仍保存最终播放结构，二者同属同一 Revision。 */
export interface StoryBeat {
  id: Id;
  order: number;
  title: string;
  purpose: string;
  semanticUnitIds: Id[];
  sceneIds: Id[];
}

export interface StoryDocument {
  id: Id;
  title: string;
  summary: string;
  beats: StoryBeat[];
  updatedAt: string;
}

/**
 * NarrativeMap 不是第二份 Story：它把既有 StoryBeat 转换成观众问题、已知信息和延迟披露，
 * 供视觉解释片决定何时建立或切换认知模型。
 */
export interface NarrativeMapBeat {
  id: Id;
  narrativeBeatId: Id;
  enteringKnowledge: string;
  question: string;
  newKnowledge: string;
  deferredInformation: string;
  claim?: string;
  evidenceCaptureIds: Id[];
  sceneIds: Id[];
}

export interface NarrativeMap {
  id: Id;
  viewerQuestion: string;
  promisedModel: string;
  conclusion: string;
  beats: NarrativeMapBeat[];
  updatedAt: string;
}

/** EvidenceCapture 保存真实文件/截图及它支持的主张，不能把项目自己的结论伪装成原文。 */
export interface EvidenceHighlight {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

export interface EvidenceCapture {
  id: Id;
  /** 原始页面、文档或原图；截图可只作为预览入口，不能替代来源本体。 */
  sourceAssetId: Id;
  /** 实际可视的页面快照，可与原始 PDF / 文档不同。 */
  snapshotAssetId?: Id;
  sourceTitle: string;
  publisher?: string;
  sourceUrl: string;
  capturedAt: string;
  pageOrRange?: string;
  excerpt: string;
  claim: string;
  limitation: string;
  highlights: EvidenceHighlight[];
  status: "ready" | "stale";
  createdAt: string;
  updatedAt: string;
}

/** 第一版 Registry 覆盖架构 9.1 固定解释样片所需的通用视觉语法。 */
export type ExplainerSceneKind =
  | "HeroReveal"
  | "Comparison"
  | "ProgressiveClassification"
  | "RouteAndFlow"
  | "EvidenceDocument"
  | "UIWalkthrough"
  | "DataConclusion"
  | "PeopleGrouping"
  | "LayerStack"
  | "HistoryTimeline"
  | "QuotePortrait"
  | "RealityBroll";

/** 状态使用 Scene 内局部帧，避免 Scene 移动后把渐进揭示错误固定在整片绝对帧。 */
export interface ExplainerSceneState {
  id: Id;
  phase: "entry" | "progressive" | "settled" | "exit";
  startFrame: number;
  endFrame: number;
  label: string;
  detail?: string;
}

/**
 * Program 是 ExplainerScene 的可渲染合同。props 只承载该 Registry 类型的展示数据；
 * 原始证据、素材、NarrativeMap 和 Scene 均以 ID 显式关联，避免自由文本变成第二份工程状态。
 */
export interface ExplainerSceneProgram {
  id: Id;
  sceneId: Id;
  kind: ExplainerSceneKind;
  narrativeMapBeatId?: Id;
  primaryTask: string;
  assetIds: Id[];
  evidenceCaptureId?: Id;
  states: ExplainerSceneState[];
  props: Record<string, unknown>;
  /** 同一输入得到稳定键；输入或素材哈希变化后 Application 会让它失效。 */
  cacheKey: string;
  status: "ready" | "stale";
  /** 只停用本 Program 的渲染，不删除宿主 Scene 或附属 Cue；旧 Revision 缺省启用。 */
  disabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 第一阶段只管理已导入或已生成的人物成片；外部数字人 Provider 的能力协商留到阶段 2。
 * 人物表演绑定既有 Timeline Item，避免另建一条脱离时间线的播放真相。
 */
export type ActorPerformanceSource = "imported" | "generated";
export type ActorMaskMode = "alpha_asset" | "embedded_alpha" | "none";
export type ActorAudioMode = "use_source_audio" | "use_dialogue_track" | "muted";

/**
 * 这是 Provider 实际可用能力的项目内记录，不是营销页能力的复制。
 * Worker 在真正提交前仍会读取 Bridge 的最新 workflow schema；Profile 用于让导演知道可规划什么。
 */
export type AvatarProviderKind = "minimax_h3_multi_reference";
export type AvatarInputMode = "audio" | "text";

export interface ActorCapabilityProfile {
  id: Id;
  provider: AvatarProviderKind;
  label: string;
  workflowId: string;
  inputModes: AvatarInputMode[];
  maskModes: ActorMaskMode[];
  supportsReferenceImage: boolean;
  supportsReferenceVideo: boolean;
  /** 只有经 Provider 实测确认后才可声明；“可上传参考音频”本身不等于可口型同步。 */
  supportsAudioDrivenLipSync: boolean;
  supportsGazeControl: boolean;
  supportsGestureControl: boolean;
  /** 仅表示可按范围重新提交生成任务，不暗示 Provider 有逐帧无缝修补能力。 */
  supportsPartialRegeneration: boolean;
  maxDurationSeconds: number;
  privacyNote: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 目前只支持人工确认的静态位置，不把一张图或一次生成伪装成逐帧人体追踪。
 * x/y 采用 0 到 1 的画布归一化坐标，供 Cue 在真实预览中继续复核。
 */
export interface ActorAnchorPoint {
  x: number;
  y: number;
  source: "manual_static";
}

export interface ActorLayout {
  actorHead?: ActorAnchorPoint;
  actorHands?: ActorAnchorPoint;
}

export interface ActorGenerationRange {
  startFrame: number;
  endFrame: number;
  speechSegmentIds: Id[];
}

export interface ActorPerformance {
  id: Id;
  timelineItemId: Id;
  source: ActorPerformanceSource;
  maskMode: ActorMaskMode;
  maskAssetId?: Id;
  speechAssetId?: Id;
  scriptRevision?: number;
  /** 人物画面的声音所有权，防止视频原声与 Dialogue 同时输出。 */
  audioMode: ActorAudioMode;
  /** 已生成的人物必须能追溯到真实 Provider 能力、Job、SpeechAsset 和局部范围。 */
  capabilityProfileId?: Id;
  generationJobId?: Id;
  generationRange?: ActorGenerationRange;
  layout?: ActorLayout;
  bridgeAudit?: BridgeRunAudit;
  status: "ready" | "stale" | "failed";
  note: string;
  createdAt: string;
}

export interface ScriptDocument {
  semanticUnitIds: Id[];
  speechSegmentIds: Id[];
  revision: number;
}

export interface Scene {
  id: Id;
  type: SceneType;
  title: string;
  purpose: string;
  startFrame: number;
  endFrame: number;
  assetIds: Id[];
  narrativeBeatIds: Id[];
  status: "draft" | "ready" | "stale";
  stylePackId: string;
}

/** 主线稳定后保存的视觉决定；它解释为什么保持人物、进入解释或使用现实 Cutaway。 */
export type VisualTreatmentMode = "keep_presenter" | "quiet" | "light_overlay" | "remotion" | "b_roll" | "cutaway" | "evidence";
export type VisualTreatmentIntensity = "quiet" | "low" | "medium" | "high";

export interface VisualTreatment {
  id: Id;
  narrativeBeatId?: Id;
  sceneId?: Id;
  mode: VisualTreatmentMode;
  primaryAttention: string;
  narrativePurpose: string;
  intensity: VisualTreatmentIntensity;
  quietReason?: string;
  fallbackPlan?: string;
  status: "ready" | "stale";
  createdAt: string;
  updatedAt: string;
}

export type EffectSemanticAnchorType = "speech_segment" | "narrative_beat" | "scene" | "absolute";
export type EffectAnchorRelation = "anticipate" | "land_on" | "react_after" | "hold_through";
export type SpatialAnchor =
  | "top_left"
  | "top_right"
  | "middle_left"
  | "middle_right"
  | "bottom_left"
  | "bottom_right"
  | "center"
  | "full_frame"
  | "safe_left"
  | "safe_right"
  | "actor_head"
  | "actor_hands"
  | "behind_actor";

/**
 * 第一阶段可由 QualityReport 确定性执行的 Cue 级规则。
 * 旧项目中保存的自由文本仍会被保留并在质量报告中提示，但不会被误当成已执行的规则。
 */
export const EFFECT_QUALITY_RULES = [
  "semantic_anchor_required",
  "asset_binding_required",
  "settled_frame_required",
  "no_competing_visual",
  "actor_mask_required"
] as const;
export type EffectQualityRule = typeof EFFECT_QUALITY_RULES[number];

export interface EffectSemanticAnchor {
  type: EffectSemanticAnchorType;
  targetId?: Id;
  relation: EffectAnchorRelation;
}

/** 具名插槽使效果消费真实项目素材，而不是在 Remotion 中伪造示意卡。 */
export interface EffectAssetBinding {
  slot: string;
  assetId: Id;
}

export interface EffectMotion {
  enterPreset: string;
  settlePreset: string;
  exitPreset: string;
  enterFrames: number;
  holdFrames: number;
  exitFrames: number;
}

export interface EffectCue {
  /** 本次放置兑现的叙事点，与决定位置的单一时间锚点分开。 */
  coveredNarrativeBeatIds?: Id[];
  id: Id;
  sceneId: Id;
  type: EffectType;
  layer: "rear" | "actor" | "front" | "fullscreen";
  anchor: "segment_start" | "segment_end" | "scene" | "timeline_absolute";
  anchorTargetId?: Id;
  startFrame: number;
  holdFrame: number;
  endFrame: number;
  intensity: number;
  status: "ready" | "stale";
  note: string;
  narrativePurpose: string;
  audienceTask: string;
  semanticAnchor: EffectSemanticAnchor;
  spatialAnchor: SpatialAnchor;
  assetBindings: EffectAssetBinding[];
  props: Record<string, unknown>;
  motion: EffectMotion;
  stylePackId: string;
  qualityRules: string[];
}

/**
 * EffectCue 的内容完整性是派生事实：它只读取当前 Revision 中的 Cue、Props 与正式素材，
 * 不单独写回项目状态。这样 Renderer、质量门禁和 Web 可以共享同一条“能否正式出现”的边界。
 */
export interface EffectContentContractResult {
  ready: boolean;
  /** 面向操作者的最小缺失项；不包含任何调试占位文案。 */
  missing: string[];
}

const nonEmptyEffectText = (value: unknown): boolean => typeof value === "string" && Boolean(value.trim());
const finiteEffectNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

/**
 * 每种 Registry 效果都必须消费项目真实内容。此函数不评价动效好不好，
 * 只阻止缺素材、缺文案时把“示例卡/默认口号”渲染进 Preview 或成片。
 */
export function inspectEffectContentContract(cue: EffectCue, assets: readonly Asset[], canvas?: { width: number; height: number; fps: number }): EffectContentContractResult {
  const readyAssetIds = new Set(assets.filter((asset) => asset.status === "ready").map((asset) => asset.id));
  const boundAssetCount = (cue.assetBindings ?? []).filter((binding) => readyAssetIds.has(binding.assetId)).length;
  const props = cue.props ?? {};
  const text = (...keys: string[]) => keys.some((key) => nonEmptyEffectText(props[key]));
  // note 是剪辑理由与审计备注，不是可直接进成片的文案；正式可视文字必须明确写进 props。
  const headline = text("headline", "title", "label", "text");
  const missing: string[] = [];

  switch (cue.type) {
    case "ManagedMotion": {
      const binding = cue.assetBindings.find((item) => item.slot === "motion");
      const asset = assets.find((item) => item.id === binding?.assetId && item.status === "ready");
      if (!asset?.motion) missing.push("已渲染的受管 Remotion 作品");
      else {
        if (motionDurationAtFps(asset.motion.frameCount, asset.motion.fps, canvas?.fps ?? asset.motion.fps) !== cue.endFrame - cue.startFrame) missing.push("作品完整时长（不可隐式裁切或拉伸）");
        // 审阅状态独立于技术就绪；未审或有观感问题的作品仍可放置和修订。
        if (canvas && (asset.motion.width !== canvas.width || asset.motion.height !== canvas.height)) missing.push("与当前画布匹配的作品版本");
      }
      if (cue.assetBindings.length !== 1) missing.push("唯一的 motion 素材绑定；图片在作品内绑定");
      if (Object.keys(props).length || cue.spatialAnchor !== "full_frame" || cue.stylePackId !== "managed-source" || cue.intensity !== 1
        || cue.motion.enterPreset !== "none" || cue.motion.settlePreset !== "hold" || cue.motion.exitPreset !== "none"
        || cue.motion.enterFrames !== 0 || cue.motion.exitFrames !== 0 || cue.motion.holdFrames !== cue.endFrame - cue.startFrame) missing.push("固定作品参数；布局、样式和运动修改须生成新版本");
      break;
    }
    case "MetricBackdrop":
      if (!(text("metric", "value") || finiteEffectNumber(props.metric) || finiteEffectNumber(props.value) || headline)) missing.push("可核对的指标或标题");
      break;
    case "ProductFan":
      if (boundAssetCount < 1) missing.push("至少一个已就绪的产品素材绑定");
      break;
    case "GlowCTA":
      if (!headline) missing.push("行动文案");
      break;
    case "PortfolioWall":
      if (boundAssetCount < 1) missing.push("至少一个已就绪的案例素材绑定");
      break;
    case "CommentCloud": {
      const comments = Array.isArray(props.comments)
        ? props.comments.filter((entry) => nonEmptyEffectText(entry))
        : [];
      if (comments.length === 0) missing.push("至少一条真实评论文本");
      break;
    }
    case "EvidenceCard":
      if (boundAssetCount < 1) missing.push("已就绪的证据素材绑定");
      if (!(headline || text("source", "caption", "claim"))) missing.push("证据说明");
      break;
    case "CameraPunch":
      break;
    case "FullScreenMeme":
      if (!headline) missing.push("全屏表达文案");
      break;
    case "DeviceShowcase":
      if (boundAssetCount < 1) missing.push("已就绪的设备或界面素材绑定");
      break;
    case "ContentCarousel":
      if (boundAssetCount < 1) missing.push("至少一个已就绪的内容素材绑定");
      break;
    case "EndCard":
      if (!text("brand", "brandName")) missing.push("项目品牌");
      if (!(headline || text("headline", "title"))) missing.push("结束主文案");
      if (!text("cta", "ctaText")) missing.push("行动文案");
      break;
  }
  return { ready: missing.length === 0, missing };
}

export interface TimelineTrack {
  id: Id;
  name: string;
  kind: TrackKind;
  order: number;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
}

export interface TimelineItem {
  id: Id;
  trackId: Id;
  sceneId?: Id;
  assetId: Id;
  startFrame: number;
  endFrame: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
  disabled: boolean;
  directOverride?: boolean;
  gainDb?: number;
  /** 将采用策略落实到实际播放，独立于音量旋钮。 */
  mediaAudioPolicy?: "mute" | "retain";
}

/**
 * Duck 是 BGM 相对自身基础增益的附加衰减，不保存一个与 Dialogue 脱节的固定音量。
 * 这样 Player 和正式 Render 能以同一份 Timeline 计算进出场与旁白重叠。
 */
export interface AudioDucking {
  enabled: boolean;
  reductionDb: number;
  attackFrames: number;
  releaseFrames: number;
  holdFrames?: number;
}

/**
 * AudioCue 保存声音为什么出现在这里；物理播放、源裁切和基础增益仍由关联 TimelineItem 保存。
 * SFX 只接受显式 media_event 与 onsetOffset，首版不会猜测文件内能量峰值。
 */
export interface AudioCue {
  id: Id;
  kind: AudioCueKind;
  assetId: Id;
  timelineItemId: Id;
  purpose: string;
  anchor: "sequence_global" | "media_event";
  /** SFX 计划同步的编辑事件帧；是否实际复听由 onsetReview 和成片审片分别记录。 */
  eventFrame?: number;
  /** 当前 SFX 源片段起点到目标声音事件的偏移；候选值不代表已听过，0 表示所选片段开头。 */
  onsetOffsetFrames?: number;
  /** 只确认所选源范围的起音，不替代混合声画审片；旧数据缺省视为未确认。 */
  onsetReview?: { status: "confirmed" | "inconclusive"; note: string; recordedAt: string };
  /** 绑定当前视觉版本内的明确动作，不把声音烘焙进 Remotion。 */
  effectEvent?: EffectAudioEvent;
  soundPlanId?: Id;
  soundIntentId?: Id;
  planVersion?: number;
  role?: AudioRole;
  envelope?: AudioEnvelopePoint[];
  adoptionId?: Id;
  loopCrossfadeFrames?: number;
  sustained?: boolean;
  loopReview?: { status: "confirmed" | "inconclusive"; note: string };
  mixReview?: "needs_review" | "reviewed";
  fadeInFrames: number;
  fadeOutFrames: number;
  /** 持续 SFX 循环另需明确交叉淡化及接缝复核。 */
  loop: boolean;
  ducking?: AudioDucking;
  status: AudioCueStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EffectAudioEvent {
  effectCueId: Id;
  eventName: string;
  /** 相对 Cue 起点的视觉动作帧。 */
  localFrame: number;
  endLocalFrame?: number;
  eventId?: string;
  workVersion?: string;
  meaning?: string;
  /** 可听起音相对视觉动作的偏移，可为负；不是源文件 onset。 */
  syncOffsetFrames: number;
  /** 由平台从视觉内容、作品版本与内部时序计算，不接受调用方伪造。 */
  cueSignature: string;
}

/**
 * Cutaway 同时保存导演决定和物理播放范围。它引用由 Application 创建的顶层 TimelineItem，
 * 不能把未本地化的 Candidate 或远程 URL 直接写进 Renderer。
 */
export type CutawayMode = "fullscreen" | "pip";
export type CutawayFit = "cover" | "contain";
export type CutawayAudioMode = "continue_dialogue" | "include_source_audio" | "mute_source_audio";

export interface Cutaway {
  id: Id;
  hostSceneId: Id;
  cutawaySceneId: Id;
  timelineItemId: Id;
  assetId: Id;
  visualTreatmentId?: Id;
  mode: CutawayMode;
  fit: CutawayFit;
  pipAnchor?: SpatialAnchor;
  pipScale?: number;
  audioMode: CutawayAudioMode;
  purpose: string;
  audienceTask: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  startFrame: number;
  endFrame: number;
  status: "ready" | "stale";
  createdAt: string;
  updatedAt: string;
}

/** speech_asset 是语音段派生；source_audio 是真实音频对齐派生，音频也可来自已合成旁白。 */
export type CaptionSourceKind = "speech_asset" | "source_audio";

/** FunASR / 强制对齐 Provider 同源返回的最小 token 时间证据，不允许由应用层估算。 */
export interface SourceAudioAlignmentToken {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

/** Provider 的自动标点只作为候选边界，不能直接等同于最终视觉字幕。 */
export interface SourceAudioAlignmentSentence {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  /** 左闭右开 token 区间。 */
  tokenStartIndex: number;
  tokenEndIndex: number;
}

/**
 * Provider 直接返回的正式字幕段。一个 segment 就是一屏字幕，而非 token 或逐字动画。
 * token 区间只在 Provider 能严格给出时保存；没有它仍可使用 Provider 真实的段级时间。
 */
export interface SourceAudioAlignmentSegment {
  displayText: string;
  startMs: number;
  endMs: number;
  /** 左闭右开 token 区间；可选，且不进入正常渲染流程。 */
  tokenStartIndex?: number;
  tokenEndIndex?: number;
}

/** token 是否具备可验证的逐项时间；不可用时不能为编辑重分段猜测时间。 */
export type SourceAudioAlignmentTokenPrecision = "provider_token_timed" | "unavailable";

/** 原始 token 对齐可选择完全不生成 Provider 句子候选，避免把标点模型误读为剪辑决策。 */
export type SourceAudioAlignmentSentenceCandidateMode = "provider_punctuation" | "none";

/**
 * 原声 A-roll 的真实对齐证据。它与一次明确的素材使用、源范围、Revision 和 Bridge Run 绑定；
 * `segments` 是 Provider 给出的默认一屏字幕。`tokens` 只在严格可验证时保留作例外重分段；
 * token 不可用不降低 Provider 段自身的真实 startMs/endMs，也不阻塞默认字幕。
 */
export interface SourceAudioAlignment {
  id: Id;
  /** 最终旁白的真实音频字幕明确绑定语音版本，不伪造 A-roll 或人物表演。缺省仍为原声 A-roll。 */
  speechSource?: { speechAssetId: Id; scriptRevision: number; scriptText: string };
  sourceAssetId: Id;
  sourceAssetHash?: string;
  sourceTimelineItemId: Id;
  sourceStartFrame: number;
  sourceEndFrame: number;
  timelineStartFrame: number;
  timelineEndFrame: number;
  requestedRevision: number;
  transcriptText: string;
  tokenPrecision: SourceAudioAlignmentTokenPrecision;
  tokens?: SourceAudioAlignmentToken[];
  segments: SourceAudioAlignmentSegment[];
  /** 旧 v2/v3 快照的自动标点候选；正式 v4 段级链不再读取它。 */
  sentenceCandidateMode: SourceAudioAlignmentSentenceCandidateMode;
  sentences: SourceAudioAlignmentSentence[];
  bridgeAudit: BridgeRunAudit;
  /** 裁剪只截取既有时间证据；保留其原点，避免 24fps 等帧率在毫秒往返换算时漂移。 */
  sourceEdit?: { parentAlignmentId: Id; originSourceFrame: number; parentTokenStartIndex?: number };
  status: "ready" | "stale";
  createdAt: string;
}

/** Provider 毫秒时间的源坐标原点；剪辑派生仍使用原始时间，不伪造一次新的 Provider Run。 */
export function sourceAudioTimeOrigin(alignment: SourceAudioAlignment): number {
  return alignment.sourceEdit?.originSourceFrame ?? alignment.sourceStartFrame;
}

/** 当前 A-roll 的最终字幕分屏记录；默认由 Provider segments 自动生成，也可被明确编辑覆盖。 */
export interface SourceCaptionProgram {
  id: Id;
  alignmentId: Id;
  sourceAssetId: Id;
  sourceTimelineItemId: Id;
  captionIds: Id[];
  source: "provider_segments" | "editorial_override";
  createdAt: string;
}

export interface CaptionCard {
  /** 仅控制屏幕显示；省略沿用整卡显示，语音与源 token 始终保留。 */
  display?: import("./caption-presentation.js").CaptionDisplay;
  id: Id;
  /** TTS / SpeechAsset 字幕才绑定 SpeechSegment；原声分块字幕没有伪造的 SpeechSegment。 */
  speechSegmentId?: Id;
  /** 缺省值兼容历史 SpeechAsset 字幕。 */
  sourceKind?: CaptionSourceKind;
  /** source_audio 字幕必须可追溯到原始 A-roll 与它在当前 Timeline 的一次使用。 */
  sourceAssetId?: Id;
  sourceTimelineItemId?: Id;
  sourceStartFrame?: number;
  sourceEndFrame?: number;
  sourceBridgeRunId?: string;
  /** 只有语义 Program 编译出的原声字幕才拥有这些 token 锚点。 */
  sourceAlignmentId?: Id;
  sourceCaptionProgramId?: Id;
  sourceTokenStartIndex?: number;
  sourceTokenEndIndex?: number;
  /** 由剪辑 Agent 记录该卡承担的完整阅读/语义任务，便于复核而非仅按标点切分。 */
  sourceCaptionRationale?: string;
  /** 当前 SpeechSegment 的原始可播放文字；手工改屏幕文案时仍可回到语音事实。 */
  sourceText?: string;
  text: string;
  /** derived 表示仍显示语音原文，manual 仅表示屏幕文案被单独编辑，不会改写 Script。 */
  textMode?: "derived" | "manual";
  /** 回听后的显示纠错；保留 Provider 原文和时间，不冒充强制对齐或修改声音。 */
  sourceTextReview?: SourceCaptionTextReviewInput & { sourceText: string; text: string; reviewedAt: string };
  startFrame: number;
  endFrame: number;
  style: "stable";
  /** 稳定字幕允许有限的排版与强调，不开放任意 CSS 或伪造词级时间。 */
  format?: CaptionFormat;
  emphasis?: CaptionEmphasis;
  precision: TimingPrecision;
}

export interface CaptionFormat {
  /** 百分比静态框，锚定左上角；存在时优先于旧底部布局。 */
  placement?: import("./caption-presentation.js").CaptionPlacement;
  fontSize: number;
  fontWeight: number;
  color: string;
  backgroundColor?: string;
  /** 背景与文字分层渲染；只允许受限透明度，避免把任意 CSS 写入项目。 */
  backgroundOpacity?: number;
  bottomPercent: number;
  horizontalInsetPercent: number;
  textAlign: "left" | "center" | "right";
}

/** 第一版只支持一个连续短语强调；它始终在 Card 级时序内，不声称具备逐词时间。 */
export interface CaptionEmphasis {
  text: string;
  occurrence: number;
  color?: string;
  backgroundColor?: string;
  fontWeight?: number;
  scale?: number;
}

export const DEFAULT_CAPTION_FORMAT: CaptionFormat = {
  fontSize: 32,
  fontWeight: 750,
  color: "#ffffff",
  bottomPercent: 7,
  horizontalInsetPercent: 8,
  textAlign: "center"
};

export interface TimelineDocument {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  tracks: TimelineTrack[];
  items: TimelineItem[];
  captions: CaptionCard[];
}

export interface Marker {
  id: Id;
  frame: number;
  label: string;
  level: "info" | "warning" | "blocking";
}

/** 兼容旧的仅 note 回听记录；其它依据必须明确来源，不能冒充听审。 */
export type SourceCaptionTextReviewInput =
  | { basis?: "listening"; note: string }
  | { basis: "confirmed_script"; note: string; scriptRevision: number; speechSegmentIds: Id[] }
  | { basis: "user_instruction"; note: string; instruction: string; source: string };

export interface QualityIssue {
  id: Id;
  level: "blocking" | "warning";
  code: string;
  message: string;
  objectId?: Id;
  frameRange?: { startFrame: number; endFrame: number };
  /** 保留人工判断来源，不冒充自动检测。 */
  editorialFindingId?: Id;
  editorialSeverity?: EditorialReviewSeverity;
  /** 仅用于技术阻挡；缺省同时适用于两种导出用途。 */
  blockingPurposes?: ExportPurpose[];
}

/** 质量 Skill 的四轮审片及模式专项检查，必须说明实际看过的范围。 */
export type EditorialReviewPass = "audio_only" | "mute_visual" | "audiovisual" | "first_viewer" | "mode_specific";
export type EditorialReviewSeverity = "blocking" | "warning" | "major" | "minor" | "suggestion" | "inconclusive";
export type EditorialReviewCategory = "semantic" | "pacing" | "attention" | "motion" | "typography" | "audio" | "mode_specific";

export interface EditorialReviewFinding {
  id: Id;
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
  revision?: number;
  recordedAt?: string;
}

/** 范围使用成片坐标、endFrame 排他；抽帧不能充当连续声画审阅。 */
export interface EditorialReviewObservation {
  pass: EditorialReviewPass;
  previewJobId: Id;
  startFrame: number;
  endFrame: number;
  method: "frames" | "continuous_video" | "audio" | "audiovisual";
  observation: string;
}

export interface EditorialReviewEvidence extends EditorialReviewObservation {
  id: Id;
  revision: number;
  relativePath: string;
  contentHash: string;
  recordedAt: string;
}

export interface EditorialFindingResolution {
  findingId: Id;
  revision: number;
  evidenceIds: Id[];
  note: string;
  resolvedAt: string;
  frameRange: { startFrame: number; endFrame: number };
  /** 只确认字幕卡的文字显示，不代表声音、阅读节奏或连续画面通过。 */
  scope?: "caption_text";
}

/**
 * 这不是自动审美结论，而是 Skill 在真实预览后留下的可追溯审片记录。
 * 记录可分阶段累积；问题必须显式复核关闭，旧文字记录不自动获得连续审阅资格。
 */
export interface EditorialQualityReview {
  revision: number;
  passes: EditorialReviewPass[];
  previewEvidence: string[];
  findings: EditorialReviewFinding[];
  reviewedAt: string;
  evidenceRecords?: EditorialReviewEvidence[];
  resolutions?: EditorialFindingResolution[];
}

export interface QualityReport {
  revision: number;
  generatedAt: string;
  /** 可由代码确定的结构与媒体规则。 */
  technical: QualityIssue[];
  /** 生成文件的条件独立于辅助审阅状态。 */
  exportReadiness: Record<ExportPurpose, { allowed: boolean; blockers: QualityIssue[] }>;
  /** 由 Skill + 真实预览补充的编辑判断；未评审时保持空数组而不是伪造通过。 */
  editorial: {
    status: "not_recorded" | "partial" | "reviewed" | "stale";
    /** 仅在当前 Revision 已有真实审片记录时返回，供交付门禁确认审片覆盖范围。 */
    passes: EditorialReviewPass[];
    semantic: QualityIssue[];
    pacing: QualityIssue[];
    attention: QualityIssue[];
    motion: QualityIssue[];
    typography: QualityIssue[];
    audio: QualityIssue[];
    modeSpecific: QualityIssue[];
    previewEvidence: string[];
    coverage?: Array<{ pass: EditorialReviewPass; complete: boolean; missingRanges: Array<{ startFrame: number; endFrame: number }> }>;
    openFindings?: EditorialReviewFinding[];
  };
  /** 从当前对象推导的对账，不保存第二份时间线，也不对审美自动打分。 */
  productionReconciliation?: Array<{
    beatId: Id;
    title: string;
    treatmentIds: Id[];
    staleTreatmentIds: Id[];
    linkedEffectCueIds: Id[];
    linkedCutawayIds: Id[];
    linkedExplainerProgramIds: Id[];
    /** 仅为场景内的实际使用线索，不表示完成了该 Beat 的声音/字幕设计。 */
    sceneAudioCueIds: Id[];
    sceneCaptionIds: Id[];
    sceneIds: Id[];
    needs: string[];
  }>;
  requiredFixes: QualityIssue[];
  /** 兼容现有 Web / API 的扁平视图。 */
  issues: QualityIssue[];
}

/** incomplete 表示已经尝试收口，但缺少阶段 1 的必需证据；仍可继续补充同一 Run。 */
export type ProductionRunStatus = "active" | "incomplete" | "completed" | "abandoned";

/** 协调者记录的子代理来源，只用于追溯，不认证宿主身份或代替实际调用证据。 */
export interface CreativeDelegation {
  agentId: string;
  assignmentId: string;
  role: "director" | "specialist" | "reviewer";
  /** 子代理实际使用的历史版本；记录审计时不得替换成当前版本。 */
  inputRevision: number;
}

export interface CreativeDecision {
  id: Id;
  category: "story" | "semantic" | "scene" | "visual" | "audio" | "quality";
  decision: string;
  rationale: string;
  objectIds: Id[];
  evidence: string[];
  alternatives?: string[];
  /** 旧报告及用户已明确指定的操作可以省略；对象和产物沿用 objectIds、evidence。 */
  delegation?: CreativeDelegation;
  createdAt: string;
}

/**
 * ProductionRun 是任务审计，不是 Project Snapshot 的副本；它持久化在项目 reports 目录，
 * 用于回答“这次为什么这样剪”。
 */
export interface SkillExecutionReport {
  id: Id;
  projectId: Id;
  status: ProductionRunStatus;
  baseRevision: number;
  finalRevision?: number;
  loadedSkills: string[];
  loadedReferences: string[];
  creativeDecisions: CreativeDecision[];
  quietRanges: Array<{ startFrame: number; endFrame: number; reason: string }>;
  effectDecisions: string[];
  rejectedAlternatives: string[];
  mcpCommands: Array<{ name: string; revision?: number; createdAt: string }>;
  previewEvidence: string[];
  /** inspect_composed_frames 真正产出的当前 Revision 帧文件，不接受人工字符串冒充。 */
  composedFrameEvidence: string[];
  qualityReview: string[];
  editorialReview?: EditorialQualityReview;
  /** 旧 Revision 的审片保留，不能因继续编辑覆盖尚未解决的问题。 */
  editorialReviewHistory?: EditorialQualityReview[];
  /** 调用 complete 时未满足的条件；完成后为空。 */
  completionBlockers: string[];
  createdAt: string;
  completedAt?: string;
}

/**
 * Web 用户提交给 Codex 的可审计工作单。它只保存意图与项目对象引用，
 * 不复制 Scene、Timeline 或任何媒体状态；真实编辑结果始终由 Revision 快照保存。
 */
export type AgentWorkOrderStatus = "open" | "claimed" | "completed" | "cancelled";
export type AgentWorkOrderCompletionKind = "edited" | "reviewed_no_change";

/** 工作单完成时固化的 Revision 影响，避免把聊天摘要误当成实际剪辑证据。 */
export interface AgentWorkOrderResultImpact {
  fromRevision: number;
  toRevision: number;
  revisions: Array<{
    revision: number;
    summary: string;
    changedObjectIds: Id[];
    movedObjectIds: Id[];
    staleObjectIds: Id[];
    dirtyRanges: DirtyRange[];
    warnings: string[];
  }>;
}

/** 关联对象在接手或完成时的可执行性提示；缺失会阻止操作，stale 会被明确留痕。 */
export interface AgentWorkOrderRelatedObjectIssue {
  objectId: Id;
  kind: "stale";
  message: string;
}

export interface AgentWorkOrder {
  id: Id;
  title: string;
  intent: string;
  /** 创建时已在该 Revision 中存在的对象 ID；后续对象被删除时仍保留这条历史引用。 */
  relatedObjectIds: Id[];
  status: AgentWorkOrderStatus;
  /** 保存该工作单的 Revision。 */
  createdRevision: number;
  claimedBy?: string;
  /** 接手状态写入的 Revision。 */
  claimedRevision?: number;
  /** 已接手的工作单可被原 Codex 释放回 open；释放不删除审计事实。 */
  releasedRevision?: number;
  releaseReason?: string;
  /** Web 用户只能取消尚未接手的工作单，避免撤销正在执行的真实任务。 */
  cancelledRevision?: number;
  cancellationReason?: string;
  /** Codex 实际完成编辑后、回写完成状态前的当前 Revision。 */
  resultRevision?: number;
  /** 保存完成回写本身的 Revision。 */
  completedRevision?: number;
  /** edited 必须有真实项目改动；reviewed_no_change 是显式审查结论，不能伪装为编辑。 */
  completionKind?: AgentWorkOrderCompletionKind;
  /** edited 时从接手后到结果 Revision 聚合出的实际对象变化。 */
  resultChangedObjectIds?: Id[];
  resultImpact?: AgentWorkOrderResultImpact;
  relatedObjectIssues?: AgentWorkOrderRelatedObjectIssue[];
  completionSummary?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 修复工单不属于视频创作 Revision：它记录 Agent 协作中的能力缺口、修复和版本切换，
 * 不能因为报告一个 MCP 故障而改写 Timeline、素材或 Story。
 */
export type RepairTicketCategory = "tool_missing" | "tool_error" | "runtime_failure" | "workflow_blocker";
export type RepairTicketStatus = "open" | "claimed" | "ready_for_cutover" | "deployed" | "acknowledged" | "resolved_without_deployment";
export type RepairTicketResolutionKind = "invalid_input" | "duplicate" | "external_recovery";

export interface RepairTicket {
  id: Id;
  projectId: Id;
  /** 剪辑 Agent 报告问题时所见的不可变视频 Revision，仅用于复现与交接。 */
  reportedRevision: number;
  category: RepairTicketCategory;
  summary: string;
  detail?: string;
  toolName?: string;
  jobId?: Id;
  reporterId: string;
  /** 报告问题的 MCP/Runtime 发行版本，避免用“最新版”这种不可验证的描述。 */
  reportedReleaseId: string;
  idempotencyKey: string;
  status: RepairTicketStatus;
  repairerId?: string;
  releasedBy?: string;
  releaseReason?: string;
  candidateReleaseId?: string;
  validationSummary?: string;
  deployedReleaseId?: string;
  deploymentEvidence?: string;
  acknowledgedBy?: string;
  acknowledgedReleaseId?: string;
  /** 剪辑 Agent 重新连接新 MCP 后读到的当前视频 Revision。 */
  acknowledgedRevision?: number;
  /** 非部署收口必须记录可复核原因；不会冒充平台代码已修复。 */
  resolutionKind?: RepairTicketResolutionKind;
  resolutionEvidence?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSnapshot {
  project: {
    id: Id;
    name: string;
    rootPath: string;
    profile: ProductionProfile;
    brief: CreativeBrief;
    stylePackId: string;
    createdAt: string;
    updatedAt: string;
  };
  story: StoryDocument;
  assets: Asset[];
  assetRequests: AssetRequest[];
  searchIntents: SearchIntent[];
  assetCandidates: AssetCandidate[];
  narrativeMap?: NarrativeMap;
  evidenceCaptures: EvidenceCapture[];
  explainerPrograms: ExplainerSceneProgram[];
  vlogShotAnalyses: VlogShotAnalysis[];
  vlogEvents: VlogEvent[];
  vlogShotSelects: VlogShotSelect[];
  vlogAmbientCues: VlogAmbientCue[];
  vlogMusicBeats: VlogMusicBeat[];
  multicamGroups: MulticamGroup[];
  multicamCuts: MulticamCut[];
  agentWorkOrders: AgentWorkOrder[];
  visualTreatments: VisualTreatment[];
  cutaways: Cutaway[];
  audioCues: AudioCue[];
  /** 只保存正式声音意图及采用依据；模型原文、分窗与索引不进入快照。 */
  soundPlans?: SoundPlan[];
  audioOutputTarget?: { targetLufs: number; toleranceLu: number; maxTruePeakDbfs: number };
  /** 最终混合的绝对增益；旧版本缺省为 0 dB，不改各轨音量。 */
  audioMixGainDb?: number;
  soundReviews?: Array<{ baseRevision: number; previewJobId: string; previewHash?: string; outcome: "passed" | "failed" | "inconclusive"; method: "audio" | "audiovisual"; note: string; signature: string; fromFrame: number; toFrame: number; recordedAt: string }>;
  mediaAdoptions?: MediaAdoption[];
  voiceReferences: VoiceReference[];
  /** 原声时间证据与最终视觉字幕 Program 分离保存，避免自动标点直接成为成片字幕。 */
  sourceAudioAlignments: SourceAudioAlignment[];
  sourceCaptionPrograms: SourceCaptionProgram[];
  transcripts: TranscriptText[];
  transcriptSentenceCandidates: TranscriptSentenceCandidate[];
  semanticUnits: SemanticUnit[];
  script: ScriptDocument;
  speechSegments: SpeechSegment[];
  speechSegmentAssets: SpeechSegmentAsset[];
  speechAsset?: SpeechAsset;
  speechAlignment?: SpeechAlignment;
  actorCapabilityProfiles: ActorCapabilityProfile[];
  actorPerformances: ActorPerformance[];
  scenes: Scene[];
  effectCues: EffectCue[];
  timeline: TimelineDocument;
  markers: Marker[];
}

export interface DirtyRange {
  startFrame: number;
  endFrame: number;
  reason: string;
}

export interface ImpactReport {
  changed: Id[];
  moved: Id[];
  recomputed: string[];
  stale: Id[];
  conflicts: string[];
  dirtyRanges: DirtyRange[];
  warnings: string[];
}

export interface RevisionRecord {
  id: Id;
  projectId: Id;
  number: number;
  parentId?: Id;
  summary: string;
  snapshot: ProjectSnapshot;
  impact: ImpactReport;
  createdAt: string;
}

export interface JobRecord {
  id: Id;
  projectId: Id;
  kind: JobKind;
  status: JobStatus;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  idempotencyKey: string;
  attempt: number;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Render Preflight 只检查目标 Revision 在当前运行环境是否具备渲染前提；
 * 它不替代真实渲染、最终文件校验或人的完整声画审片。
 */
export type RenderPreflightCheckStatus = "passed" | "warning" | "failed";

export interface RenderPreflightCheck {
  code: string;
  status: RenderPreflightCheckStatus;
  message: string;
  objectId?: Id;
}

export interface RenderPreflight {
  id: Id;
  projectId: Id;
  revision: number;
  /** 旧记录缺省为 delivery。 */
  purpose?: ExportPurpose;
  status: "passed" | "failed";
  checks: RenderPreflightCheck[];
  checkedAt: string;
}

/** 每次导出都保存实际使用外部/生成素材的来源快照，避免后续 Revision 覆盖历史交付依据。 */
export interface SourceManifestEntry {
  assetId: Id;
  name: string;
  sourceHash?: string;
  source: AssetProvenance["source"];
  provider?: string;
  sourceUrl?: string;
  creator?: string;
  originalAssetId?: string;
  acquiredAt: string;
}

export interface SourceManifest {
  relativePath: string;
  generatedAt: string;
  entries: SourceManifestEntry[];
}

/** 最终文件校验只描述可确定的媒体事实，不把审美判断伪装成技术结果。 */
export interface ExportTechnicalValidation {
  durationMs: number;
  fps?: number;
  frameCount?: number;
  hasAudio: boolean;
  blackSegments: Array<{ startSeconds: number; endSeconds: number; durationSeconds: number }>;
  audio?: { decoded: boolean; integratedLufs: number | null; truePeakDbfs: number | null; loudnessRangeLu: number | null; silence: Array<{ startSeconds: number; endSeconds: number }>; trailingSilenceStartSeconds?: number; method: string; rawSummary: string };
}

/** 成片复核绑定一个真实文件，而不是泛指“当前项目”。 */
export interface ExportArtifactReview {
  passes: EditorialReviewPass[];
  evidence: string[];
  findings: EditorialReviewFinding[];
  reviewedAt: string;
}

export interface ExportArtifactApproval {
  approvedAt: string;
  note?: string;
  /** 新批准显式记录人工确认及文件身份，旧记录不补造确认来源。 */
  confirmedByUser?: true;
  fileHash?: string;
}

/**
 * ExportArtifact 与 Project Revision 分开持久化：后续继续编辑只会产生新 Revision，
 * 不会改写曾经导出的文件、校验、来源或批准记录。
 */
export interface ExportArtifact {
  id: Id;
  projectId: Id;
  revision: number;
  jobId: Id;
  purpose: ExportPurpose;
  relativePath: string;
  fileHash: string;
  fileSizeBytes: number;
  preflight: RenderPreflight;
  validation: ExportTechnicalValidation;
  sourceManifest: SourceManifest;
  createdAt: string;
  artifactReview?: ExportArtifactReview;
  approval?: ExportArtifactApproval;
}

export interface ProjectSummary {
  id: Id;
  name: string;
  profile: ProductionProfile;
  currentRevision: number;
  updatedAt: string;
  durationInFrames: number;
  assetCount: number;
}

export interface CommandResult {
  revision: RevisionRecord;
  impact: ImpactReport;
}

export interface EditorFocus {
  projectId: Id;
  revision: number;
  sceneId?: Id;
  itemId?: Id;
  effectCueId?: Id;
  frame?: number;
}

export const EFFECT_TYPES: EffectType[] = [
  "MetricBackdrop",
  "ProductFan",
  "GlowCTA",
  "PortfolioWall",
  "CommentCloud",
  "EvidenceCard",
  "CameraPunch",
  "FullScreenMeme",
  "DeviceShowcase",
  "ContentCarousel",
  "EndCard",
  "ManagedMotion"
];

export const DEFAULT_TRACKS: Array<Pick<TimelineTrack, "name" | "kind">> = [
  { name: "Cutaway / Fullscreen", kind: "video" },
  { name: "Front FX", kind: "video" },
  { name: "Actor FX", kind: "video" },
  { name: "Actor / A-roll", kind: "video" },
  { name: "Rear FX", kind: "video" },
  { name: "Background", kind: "video" },
  { name: "Captions", kind: "caption" },
  { name: "Dialogue", kind: "audio" },
  { name: "Ambient", kind: "audio" },
  { name: "SFX", kind: "audio" },
  { name: "BGM", kind: "audio" }
];
