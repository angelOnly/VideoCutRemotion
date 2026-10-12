import type { ExplicitCreativePreferences } from "@videocut/contracts";
import type { AgentWorkOrder, DialogueProcessingIssue, DialogueProcessingProfile, ExportArtifact, ExportPurpose, JobRecord, ProductionProfile, ProjectSnapshot, ProjectSummary, QualityReport, RevisionRecord, VideoGenerationMode } from "@videocut/contracts";
import type { FrameRateChangeReport, SourceReviewDiagnostics } from "@videocut/contracts";

/**
 * 开发服务器仍默认访问本地 API；插件 Runtime 则把静态 Web 与 API 放在同一 origin，
 * 因此可安全使用隔离端口，不会把 E2E 或第二个工作区误连到 3100。
 */
export const API_BASE = import.meta.env.VITE_API_BASE
  ?? (import.meta.env.DEV ? "http://127.0.0.1:3100" : window.location.origin);

export interface ProjectState {
  revision: RevisionRecord;
  snapshot: ProjectSnapshot;
}

/**
 * 原素材审阅是只读派生查询。这里刻意不复用 Timeline Item 的时间，所有范围均为源素材帧坐标。
 * 派生文件由服务端放在 project/cache/source-review，不能据此修改当前 Revision。
 */
export type SourceReviewMode = "overview" | "range" | "dense";

export interface SourceReviewFrame {
  sourceFrame: number;
  sourceMs: number;
  timecode: string;
  relativePath: string;
  mediaPath: string;
}

export interface SourceReviewRange {
  startFrame: number;
  endFrame: number;
  startMs: number;
  endMs: number;
  fps: number;
}

export interface SourceReviewShot {
  id: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  source?: "ffmpeg_scene" | "manual";
  sceneChangeScore?: number;
  status?: string;
  evidenceNote?: string;
  technicalScore?: number;
  hasAudio?: boolean;
}

export interface SourceReviewUsageItem {
  id: string;
  startFrame?: number;
  endFrame?: number;
  sourceStartFrame?: number;
  sourceEndFrame?: number;
  sceneId?: string;
  title?: string;
  purpose?: string;
  trackId?: string;
  trackName?: string;
  timelineItemId?: string;
  type?: string;
  status?: string;
  disabled?: boolean;
  role?: string;
  sourceTitle?: string;
}

export interface SourceReviewResult {
  diagnostics: SourceReviewDiagnostics;
  projectId: string;
  assetId: string;
  revision: number;
  mode: SourceReviewMode;
  sourceMedia: { relativePath: string; mediaPath: string };
  sourceRange?: SourceReviewRange;
  evidenceBoundaries: string[];
  contactSheet: { frames: SourceReviewFrame[] };
  proxy?: {
    relativePath: string;
    mediaPath: string;
    kind: "video" | "audio";
    sourceRange: SourceReviewRange;
  };
  audio: {
    hasAudio: boolean;
    waveform?: { relativePath: string; mediaPath: string };
    silenceRanges: Array<{ startFrame: number; endFrame: number }>;
    meanVolumeDb?: number;
    maxVolumeDb?: number;
    onsetFrames: number[];
    limitations?: string[];
  };
  transcript?: { id: string; text: string; source: "funasr" | "manual"; sentenceCandidates: Array<{ id: string; order: number; text: string }>; timingPrecision: "unavailable" };
  shots: { current?: SourceReviewShot; overlapping: SourceReviewShot[]; previous?: SourceReviewShot; next?: SourceReviewShot };
  usage: {
    timelineItems: SourceReviewUsageItem[];
    scenes: SourceReviewUsageItem[];
    cutaways: SourceReviewUsageItem[];
    effectCues: SourceReviewUsageItem[];
    actorPerformances: SourceReviewUsageItem[];
    evidenceCaptures: SourceReviewUsageItem[];
  };
  requestableRanges: Array<{ startFrame: number; endFrame: number; reason?: string }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }), ...(init?.headers ?? {}) }
  });
  const payload = await response.json().catch(() => undefined) as { message?: string } | T | undefined;
  if (!response.ok) throw new Error(typeof payload === "object" && payload && "message" in payload ? String(payload.message) : `请求失败：${response.status}`);
  return payload as T;
}

export const api = {
  creativeDefaults: () => request<ExplicitCreativePreferences>("/api/settings/creative-defaults"),
  saveCreativeDefaults: (preferences: ExplicitCreativePreferences) => request<ExplicitCreativePreferences>("/api/settings/creative-defaults", { method: "PUT", body: JSON.stringify(preferences) }),
  clearCreativeDefaults: () => request<ExplicitCreativePreferences>("/api/settings/creative-defaults", { method: "DELETE", body: "{}" }),
  fontCapabilities: (signal?: AbortSignal) => request<{ fonts: import("../../../packages/motion-work/src/font-preview").FontLibraryFace[] }>("/api/motion/capabilities", { signal }),
  listProjects: () => request<ProjectSummary[]>("/api/projects"),
  createProject: (name: string, profile: ProductionProfile, fps = 24) => request<ProjectState>("/api/projects", { method: "POST", body: JSON.stringify({ name, profile, fps }) }),
  previewFrameRateChange: (id: string, baseRevision: number, fps: number) => request<FrameRateChangeReport>(`/api/projects/${id}/frame-rate/preview`, { method: "POST", body: JSON.stringify({ baseRevision, fps }) }),
  setFrameRate: (id: string, baseRevision: number, fps: number) => request<ProjectState & { frameRateChange: FrameRateChangeReport }>(`/api/projects/${id}/frame-rate`, { method: "POST", body: JSON.stringify({ baseRevision, fps }) }),
  project: (projectId: string) => request<ProjectState>(`/api/projects/${projectId}`),
  quality: (projectId: string) => request<QualityReport>(`/api/projects/${projectId}/quality`),
  jobs: (projectId: string) => request<JobRecord[]>(`/api/projects/${projectId}/jobs`),
  revisions: (projectId: string) => request<Array<Pick<RevisionRecord, "id" | "number" | "summary" | "createdAt" | "impact">>>(`/api/projects/${projectId}/revisions`),
  agentWorkOrders: (projectId: string) => request<{ revision: number; agentWorkOrders: AgentWorkOrder[] }>(`/api/projects/${projectId}/agent-work-orders`),
  createAgentWorkOrder: (projectId: string, payload: { baseRevision: number; title: string; intent: string; relatedObjectIds: string[] }) => request<{ state: ProjectState; workOrder: AgentWorkOrder }>(`/api/projects/${projectId}/agent-work-orders`, { method: "POST", body: JSON.stringify(payload) }),
  cancelAgentWorkOrder: (projectId: string, workOrderId: string, payload: { baseRevision: number; reason: string }) => request<{ state: ProjectState; workOrder: AgentWorkOrder }>(`/api/projects/${projectId}/agent-work-orders/${workOrderId}/cancel`, { method: "POST", body: JSON.stringify(payload) }),
  importPath: (projectId: string, baseRevision: number, filePath: string) => request(`/api/projects/${projectId}/assets/import-path`, { method: "POST", body: JSON.stringify({ baseRevision, filePath }) }),
  upload: (projectId: string, baseRevision: number, files: File[]) => {
    const body = new FormData();
    files.forEach((file) => body.append("media", file));
    return request(`/api/projects/${projectId}/assets/upload?baseRevision=${baseRevision}`, { method: "POST", body });
  },
  /**
   * 只读取源素材证据；overview 不传范围，range/dense 必须传项目 fps 下的源帧范围。
   * 该请求不会创建 Job、Asset 或 Revision。
   */
  inspectAsset: (projectId: string, assetId: string, payload: {
    mode: SourceReviewMode;
    sourceStartFrame?: number;
    sourceEndFrame?: number;
    contactSheetFrames?: number;
  }) => request<SourceReviewResult>(`/api/projects/${projectId}/assets/${assetId}/inspect`, { method: "POST", body: JSON.stringify(payload) }),
  transcribe: (projectId: string, assetId: string) => request<JobRecord>(`/api/projects/${projectId}/transcription`, { method: "POST", body: JSON.stringify({ assetId }) }),
  registerVoiceReference: (projectId: string, baseRevision: number, assetId: string, label?: string) => request<ProjectState>(`/api/projects/${projectId}/voice-references`, { method: "POST", body: JSON.stringify({ baseRevision, assetId, label }) }),
  voiceSynthesis: (projectId: string, voiceReferenceId: string) => request<JobRecord>(`/api/projects/${projectId}/voice-synthesis`, { method: "POST", body: JSON.stringify({ voiceReferenceId }) }),
  /** 只提交当前整条 SpeechAsset 的可试听处理候选；不会自动替换 Dialogue。 */
  submitDialogueProcessing: (projectId: string, payload: {
    baseRevision: number;
    issueTypes: DialogueProcessingIssue[];
    evidenceNote: string;
  }) => request<JobRecord>(`/api/projects/${projectId}/dialogue-processing`, { method: "POST", body: JSON.stringify(payload) }),
  /** 试听后显式选择候选，才会创建 Revision 并替换 Dialogue Item。 */
  selectDialogueProcessingVariant: (projectId: string, payload: {
    baseRevision: number;
    profile: DialogueProcessingProfile;
  }) => request<ProjectState>(`/api/projects/${projectId}/dialogue-processing/select`, { method: "POST", body: JSON.stringify(payload) }),
  rebuildSpeechTimeline: (projectId: string, baseRevision: number) => request<ProjectState>(`/api/projects/${projectId}/speech-asset/rebuild-timeline`, { method: "POST", body: JSON.stringify({ baseRevision }) }),
  editCaption: (projectId: string, captionId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/captions/${captionId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  editCaptionGlobalFormat: (projectId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/captions/global-format`, { method: "PATCH", body: JSON.stringify(payload) }),
  bulkFormatSourceCaptions: (projectId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/captions/source-format`, { method: "PATCH", body: JSON.stringify(payload) }),
  manageAudio: (projectId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/audio`, { method: "POST", body: JSON.stringify(payload) }),
  alignPresenterToSpeech: (projectId: string, baseRevision: number) => request<ProjectState>(`/api/projects/${projectId}/timeline/align-presenter-to-speech`, { method: "POST", body: JSON.stringify({ baseRevision }) }),
  updateStory: (projectId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/story`, { method: "PATCH", body: JSON.stringify(payload) }),
  applySemanticUnits: (projectId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/semantic-units`, { method: "POST", body: JSON.stringify(payload) }),
  assemblePresenterTrack: (projectId: string, baseRevision: number, assetIds: string[]) => request<ProjectState>(`/api/projects/${projectId}/timeline/assemble-presenter`, { method: "POST", body: JSON.stringify({ baseRevision, assetIds }) }),
  buildTimeline: (projectId: string, baseRevision: number, assetIds: string[]) => request<ProjectState>(`/api/projects/${projectId}/timeline/build-presenter`, { method: "POST", body: JSON.stringify({ baseRevision, assetIds, sceneSize: 2 }) }),
  registerActorPerformance: (projectId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/actor-performances`, { method: "POST", body: JSON.stringify(payload) }),
  applyScript: (projectId: string, baseRevision: number, semanticUnitIds: string[]) => request<ProjectState>(`/api/projects/${projectId}/script`, { method: "POST", body: JSON.stringify({ baseRevision, semanticUnitIds }) }),
  manageVisualTreatment: (projectId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/visual-treatments`, { method: "POST", body: JSON.stringify(payload) }),
  manageCutaway: (projectId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/cutaways`, { method: "POST", body: JSON.stringify(payload) }),
  replaceSceneAsset: (projectId: string, cutawayId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/cutaways/${cutawayId}/replace-asset`, { method: "POST", body: JSON.stringify(payload) }),
  createEffect: (projectId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/effects`, { method: "POST", body: JSON.stringify(payload) }),
  updateEffect: (projectId: string, cueId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/effects/${cueId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  moveItem: (projectId: string, itemId: string, payload: Record<string, unknown>) => request<ProjectState>(`/api/projects/${projectId}/items/${itemId}/move`, { method: "POST", body: JSON.stringify(payload) }),
  renderPreflight: (projectId: string, revision?: number) => request<JobRecord>(`/api/projects/${projectId}/render-preflight`, { method: "POST", body: JSON.stringify({ revision }) }),
  export: (projectId: string, revision?: number, purpose: ExportPurpose = "delivery") => request<JobRecord>(`/api/projects/${projectId}/export`, { method: "POST", body: JSON.stringify({ revision, purpose }) }),
  exportArtifacts: (projectId: string) => request<ExportArtifact[]>(`/api/projects/${projectId}/export-artifacts`),
  approveExportArtifact: (projectId: string, artifactId: string, fileHash: string, note?: string) => request<ExportArtifact>(`/api/projects/${projectId}/export-artifacts/${artifactId}/approve`, { method: "POST", body: JSON.stringify({ note, fileHash, confirmedByUser: true }) }),
  preview: (projectId: string, payload: Record<string, unknown>) => request<JobRecord>(`/api/projects/${projectId}/previews`, { method: "POST", body: JSON.stringify(payload) }),
  /** 高级面板只提交可测量的 Vlog 镜头分析，不在 Web 端伪造事件或剪辑语义。 */
  submitVlogAnalysis: (projectId: string, payload: { baseRevision: number; assetIds: string[]; sceneThreshold?: number }) => request<JobRecord>(`/api/projects/${projectId}/vlog-analysis`, { method: "POST", body: JSON.stringify(payload) }),
  /** 自动同步只会生成 candidate；是否 verified 仍须由连续预览证据通过 MCP 回写。 */
  submitMulticamSync: (projectId: string, payload: {
    baseRevision: number;
    title?: string;
    assetIds: string[];
    angleLabels: Record<string, string>;
    referenceAssetId: string;
    masterAudioAssetId: string;
    sourceRanges: Record<string, { startFrame: number; endFrame: number }>;
  }) => request<JobRecord>(`/api/projects/${projectId}/multicam/sync`, { method: "POST", body: JSON.stringify(payload) }),
  /** 只能在受管并排 Preview 已生成后写入人工连续核对结论；服务端会再次校验 Preview 的哈希和范围。 */
  verifyMulticamGroup: (projectId: string, payload: { baseRevision: number; groupId: string; previewEvidence: string }) => request<unknown>(`/api/projects/${projectId}/multicam/verify`, { method: "POST", body: JSON.stringify(payload) }),
  /** workflowId 必须来自本次实时 Bridge Schema；Web 不保存 Provider 私有字段。 */
  submitVideoGeneration: (projectId: string, payload: {
    baseRevision: number;
    workflowId: string;
    mode: VideoGenerationMode;
    inputAssetIds: string[];
    prompt: string;
    durationSeconds: number;
  }) => request<JobRecord>(`/api/projects/${projectId}/video-generation`, { method: "POST", body: JSON.stringify(payload) }),
  submitMusicGeneration: (projectId: string, payload: { baseRevision: number; workflowId: string; prompt: string; durationSeconds: number }) => request<JobRecord>(`/api/projects/${projectId}/music-generation`, { method: "POST", body: JSON.stringify(payload) }),
  submitSpeechAlignment: (projectId: string, payload: { baseRevision: number; workflowId: string; speechAssetId?: string }) => request<JobRecord>(`/api/projects/${projectId}/speech-alignment`, { method: "POST", body: JSON.stringify(payload) }),
  rollback: (projectId: string, revision: number, baseRevision: number) => request<ProjectState>(`/api/projects/${projectId}/revisions/${revision}/rollback`, { method: "POST", body: JSON.stringify({ baseRevision }) }),
  retryJob: (jobId: string) => request<JobRecord>(`/api/jobs/${jobId}/retry`, { method: "POST" })
};
