import type { SourceReviewDiagnostics, SourceReviewIssue } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { MediaProcessError } from "@videocut/speech";

export class SourceReviewOutputEmptyError extends DomainError {
  constructor(public readonly output = "") { super("素材审阅派生文件为空", "SOURCE_REVIEW_CACHE_EMPTY"); }
}

/** 只依据明确证据分类；空输出和超时不能证明原视频损坏。 */
export function classifySourceReviewFailure(error: unknown, stage: SourceReviewIssue["stage"]): SourceReviewIssue {
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof MediaProcessError || error instanceof SourceReviewOutputEmptyError ? error.output.slice(-2_000) : undefined;
  const systemCode = error instanceof MediaProcessError ? error.details?.systemCode : (error as { code?: string })?.code;
  let owner: SourceReviewIssue["owner"] = "unknown", code = "SOURCE_REVIEW_UNDETERMINED";
  if (["ENOSPC", "EACCES", "EPERM", "ENOENT", "EIO", "EMFILE"].includes(systemCode ?? "")
    || /no space left on device|permission denied|too many open files|unknown encoder|error opening output.*(?:invalid argument|input\/output error)/iu.test(detail ?? "")
    || (error instanceof DomainError && ["SOURCE_REVIEW_SOURCE_MISSING", "SOURCE_REVIEW_PROXY_INVALID"].includes(error.code))) {
    owner = "platform"; code = "SOURCE_REVIEW_PLATFORM_FAILURE";
  } else if (error instanceof MediaProcessError && /unknown decoder|decoder .*not found|decoding requested, but no decoder|unsupported codec/iu.test(detail ?? "")) {
    owner = "capability"; code = "SOURCE_REVIEW_CODEC_UNSUPPORTED";
  } else if (error instanceof MediaProcessError && /moov atom not found|invalid data found when processing input|invalid NAL unit|error while decoding|corrupt decoded frame/iu.test(detail ?? "")) {
    owner = "source"; code = "SOURCE_REVIEW_SOURCE_UNUSABLE";
  } else if (error instanceof DomainError && error.code === "SOURCE_REVIEW_CACHE_EMPTY") {
    code = "SOURCE_REVIEW_OUTPUT_EMPTY";
  } else if (error instanceof DomainError && error.code === "SOURCE_REVIEW_PROXY_INCOMPLETE") {
    code = error.code;
  } else if (error instanceof MediaProcessError && error.details?.timedOut) {
    code = "SOURCE_REVIEW_TIMEOUT";
  } else if (!(error instanceof MediaProcessError) && !(error instanceof DomainError)) {
    // 未识别的程序异常不能被素材容错吞掉。
    owner = "platform"; code = "SOURCE_REVIEW_PLATFORM_FAILURE";
  }
  return { stage, code, owner, message, ...(detail ? { detail } : {}) };
}

export function createSourceReviewDiagnostics(): SourceReviewDiagnostics {
  return {
    status: "complete", requestedFrames: 0, generatedFrames: 0,
    components: { contactSheet: "not_requested", proxy: "not_requested", waveform: "not_requested", audioAnalysis: "not_requested" },
    continuousReview: "not_requested", issues: [], recovery: "none", sideEffects: "review_cache_only"
  };
}

export function finishSourceReviewDiagnostics(result: SourceReviewDiagnostics): SourceReviewDiagnostics {
  if (result.status === "not_ready") { result.recovery = "wait_for_media_analysis"; return result; }
  const available = result.generatedFrames > 0 || result.components.proxy === "complete"
    || result.components.waveform === "complete" || result.components.audioAnalysis === "complete";
  result.status = result.issues.length ? (available ? "partial" : "unavailable") : "complete";
  result.recovery = result.issues.some(issue => issue.owner === "platform") ? "report_platform_failure"
    : result.issues.length ? (available ? "inspect_available_evidence" : "select_another_candidate") : "none";
  return result;
}
