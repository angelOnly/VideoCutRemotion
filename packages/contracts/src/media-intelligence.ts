/** 源事实和分析操作独立于创作 Revision；采用时只固定必要依据。 */
export type MediaModality = "visual" | "audio" | "speech" | "text";
export type AnalysisDepth = "discovery" | "index" | "review";
export interface SourceTimeRange { startMs: number; endMs: number }
export interface SourceRegion { page?: number; x: number; y: number; width: number; height: number }
export type MediaTarget =
  | { assetId: string; candidateId?: never; exportArtifactId?: never; previewJobId?: never }
  | { candidateId: string; assetId?: never; exportArtifactId?: never; previewJobId?: never }
  | { exportArtifactId: string; assetId?: never; candidateId?: never; previewJobId?: never }
  | { previewJobId: string; assetId?: never; candidateId?: never; exportArtifactId?: never };

export interface MediaSource {
  id: string;
  projectId: string;
  target: MediaTarget;
  identity: "original" | "preview" | "derived";
  hash: string;
  path: string;
  kind: "video" | "audio" | "image" | "document";
  durationMs: number;
  hasAudio: boolean;
  startSeconds?: number;
  pageCount?: number;
  width?: number;
  height?: number;
  streams: Array<{ index: number; kind: string; timeBase?: string; startSeconds: number; sampleRate?: number; rotation?: number }>;
  /** 成片分析以文件起点计毫秒，映射回原时间线时加 fromFrame。 */
  composition?: { revision: number; fromFrame: number; toFrame: number; fps: number };
  /** 派生文件从源起点开始的偏移；预览没有可靠映射时不填写。 */
  parent?: { sourceId: string; offsetMs: number; rate: number; region?: SourceRegion };
  createdAt: string;
}

export interface MediaFact {
  modality: MediaModality;
  text: string;
  range?: SourceTimeRange;
  region?: SourceRegion;
  basis: "model" | "measurement" | "transcript" | "human";
  precision: "sampled" | "model_estimated" | "provider_timed" | "measured" | "reviewed";
  /** 排除条件只读取明确观察，不从文字缺词推断不存在。 */
  speechPresence?: "present" | "absent" | "unknown";
  musicPresence?: "present" | "absent" | "unknown";
  keywords: string[];
}

export interface MediaObservation {
  id: string;
  projectId: string;
  sourceId: string;
  sourceHash: string;
  range?: SourceTimeRange;
  region?: SourceRegion;
  depth: AnalysisDepth;
  modalities: MediaModality[];
  facts: MediaFact[];
  unknowns: string[];
  context: string;
  rawText: string;
  /** 实际发给模型的指令，区别于仅保存的用途上下文。 */
  promptText?: string;
  audioMeasurements?: { range: SourceTimeRange; sampleRate: number; sampleOriginMs: number; hopSamples: number; firstAudibleSample: number | null; effectiveEndSample: number | null; attackCandidates: Array<{ sample: number; strength: number }>; rms: number[]; peaks: number[]; thresholdDb: number; precision: "measurement_candidate"; reviewStatus: "unreviewed" };
  speechEvidence?: { rawText: string; runId: string; schemaVersion: string; tokenPrecision: string };
  version: { workflowId: string; schemaVersion: string; model: string; prompt: string; preprocessing: string; samplingFps?: number };
  jobId: string;
  runId?: string;
  inputEvidence?: { hash: string; path: string; mapping: Record<string, unknown> };
  reusedFromObservationId?: string;
  supersedes?: string;
  correction?: { reason: string; author: string };
  createdAt: string;
}

export interface MediaAnalysisWindow {
  id: string;
  range?: SourceTimeRange;
  region?: SourceRegion;
  status: "pending" | "submitting" | "running" | "succeeded" | "failed" | "unknown";
  runId?: string;
  schemaVersion?: string;
  workflowId?: string;
  observationId?: string;
  modalityStatus?: Partial<Record<MediaModality, "observed" | "unknown" | "failed" | "unavailable">>;
  error?: string;
}

export interface MediaAnalysisRecord {
  id: string;
  projectId: string;
  sourceId: string;
  key: string;
  depth: AnalysisDepth;
  modalities: MediaModality[];
  targetRange?: SourceTimeRange;
  context: string;
  windows: MediaAnalysisWindow[];
  shotRanges: SourceTimeRange[];
  status: "pending" | "running" | "partial" | "succeeded" | "failed" | "unknown";
  updatedAt: string;
}

export interface MediaSearchQuery {
  query: string;
  modality: MediaModality;
  assetIds?: string[];
  candidateIds?: string[];
  minDurationMs?: number;
  excludeSpeech?: boolean;
  excludeMusic?: boolean;
  excludedTerms?: string[];
  allowMute?: boolean;
  limit?: number;
  offset?: number;
}

export interface MediaMatch {
  source: MediaSource;
  observationId: string;
  range?: SourceTimeRange;
  region?: SourceRegion;
  text: string;
  score: number;
  lexicalScore: number;
  semanticScore?: number;
  status: "usable" | "conditional" | "insufficient" | "rejected";
  reasons: string[];
  conditions: string[];
}

export type MediaUsageTarget =
  | { timelineItemId: string; effectCueId?: never; slot?: never; motionVideoSlot?: never; motionImageSlot?: never }
  | { effectCueId: string; slot: string; timelineItemId?: never; motionVideoSlot?: never; motionImageSlot?: never }
  | { effectCueId: string; motionVideoSlot: string; timelineItemId?: never; slot?: never; motionImageSlot?: never }
  | { effectCueId: string; motionImageSlot: string; timelineItemId?: never; slot?: never; motionVideoSlot?: never };

/** @deprecated 仅保留旧快照的历史资料；不参与生产资格与失效判定。 */
export interface MediaAdoption {
  id: string;
  assetId: string;
  sourceHash: string;
  observationIds: string[];
  /** 候选观察零点在原片中的位置；原观察保留原身份，不伪造成本地复核。 */
  candidateSourceStartMs?: number;
  requestId?: string;
  requestVersion?: string;
  range?: SourceTimeRange;
  region?: SourceRegion;
  purpose: string;
  audioPolicy: "mute" | "retain" | "not_applicable";
  conditions: string[];
  status: "current" | "needs_review";
  reviewReason?: string;
  /** 正式放置的具体用途，保存当时范围与上下文签名。 */
  uses?: Array<{ target: MediaUsageTarget; signature: string }>;
  createdAt: string;
}

export interface SoundIntent {
  id: string;
  function: "anticipation" | "settle" | "reaction" | "connection" | "ambience" | "music" | "silence" | "demonstration";
  brief: string;
  requestId?: string;
  motionEventId?: string;
}
export interface SoundPlan {
  id: string;
  startFrame: number;
  endFrame: number;
  narrationDirection: string;
  dominantRole: AudioRole;
  musicDirection: string;
  intents: SoundIntent[];
  dominantRanges?: Array<{ startFrame: number; endFrame: number; role: AudioRole; reason: string }>;
  version: number;
  status: "current" | "needs_review";
  updatedAt: string;
}
export type AudioRole = "narration" | "source_speech" | "demonstration" | "sfx" | "ambience" | "music";
export interface AudioEnvelopePoint { frame: number; gainDb: number }
export interface MotionEvent {
  id: string;
  meaning: string;
  startFrame: number;
  endFrame?: number;
}
export interface MotionEventMap {
  version: string;
  fps: number;
  frameCount: number;
  events: MotionEvent[];
}
