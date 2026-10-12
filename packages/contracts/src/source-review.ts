/** 审阅证据的可用性与视频 Asset 状态分开；局部失败不会改写正式项目。 */
export type SourceReviewComponentStatus = "complete" | "partial" | "unavailable" | "not_requested" | "skipped";
export interface SourceReviewIssue {
  stage: "metadata" | "contact_sheet" | "proxy" | "waveform" | "audio_analysis";
  code: string;
  owner: "source" | "platform" | "capability" | "unknown";
  message: string;
  detail?: string;
  sourceFrame?: number;
  sourceMs?: number;
  sourceRange?: { startFrame: number; endFrame: number; fps: number };
}
export interface SourceReviewDiagnostics {
  status: "complete" | "partial" | "unavailable" | "not_ready";
  requestedFrames: number;
  generatedFrames: number;
  components: {
    contactSheet: SourceReviewComponentStatus;
    proxy: SourceReviewComponentStatus;
    waveform: SourceReviewComponentStatus;
    audioAnalysis: SourceReviewComponentStatus;
  };
  continuousReview: "available" | "unavailable" | "not_requested";
  issues: SourceReviewIssue[];
  recovery: "none" | "inspect_available_evidence" | "select_another_candidate" | "report_platform_failure" | "wait_for_media_analysis";
  sideEffects: "review_cache_only";
}
