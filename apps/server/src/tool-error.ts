import { ZodError } from "zod";
import { MotionSubmissionValidationError } from "../../../packages/edit-application/src/motion-submission-validation.js";
import { EffectCueRangeValidationError } from "../../../packages/edit-application/src/effect-cue-validation.js";

/** 未知异常不能宣称没有写入；只有明确的输入校验拒绝可纠正参数。 */
export function toolError(error: unknown, validationBeforeExecution = false) {
  if (error instanceof EffectCueRangeValidationError) {
    const { sceneId, sceneRange, requestedRange } = error;
    const message = `效果范围 [${requestedRange.startFrame}, ${requestedRange.endFrame}) 必须完整位于所属场景 [${sceneRange.startFrame}, ${sceneRange.endFrame}) 内，且结束帧大于开始帧。`;
    const suggestion = "将实际范围和当前 Revision 回交原作者修订；covered_narrative_beat_ids 只声明内容覆盖，不扩大 Scene。ManagedMotion 必须保留完整作品时长，由原作者安排能完整承载的 Scene，不能自动截短、拆件或扩大原 Scene。";
    return { error: error.message, message: error.message, code: error.code, stage: "validation", sideEffects: "none",
      safeToRetry: true, recovery: "correct_input", sceneId, sceneRange, requestedRange,
      fields: ["start_frame", "end_frame", ...(error.action === "create" ? ["scene_id"] : [])].map(field => ({ field, message, suggestion })) };
  }
  if (error instanceof MotionSubmissionValidationError) {
    const diagnostic = error.diagnostic;
    return { error: error.message, message: error.message, code: error.code, stage: "validation", sideEffects: "none",
      safeToRetry: true, recovery: "correct_input", fields: [{ field: "work.source", ...diagnostic.location,
        nodeKind: diagnostic.nodeKind, token: diagnostic.token, message: diagnostic.message, suggestion: diagnostic.suggestion }] };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "TOOL_FAILED";
  return { error: message, message, code: error instanceof ZodError ? "INVALID_TOOL_INPUT" : code,
    ...(error instanceof ZodError && validationBeforeExecution ? { stage: "validation", sideEffects: "none", safeToRetry: true, recovery: "correct_input",
      fields: error.issues.map(issue => ({ field: issue.path.join("."), message: issue.message })) } : { sideEffects: "unknown", safeToRetry: false }) };
}

export const toolErrorResult = (error: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(toolError(error), null, 2) }], isError: true });
