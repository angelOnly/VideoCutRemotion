import { MotionSourceValidationError } from "../../motion-work/src/source-validation-error.js";

/** 仅提交前的窄校验边界可以创建；不能包住创建 Job 或 Worker 执行。 */
export class MotionSubmissionValidationError extends Error {
  readonly code: string;
  constructor(readonly diagnostic: MotionSourceValidationError) {
    super(diagnostic.message, { cause: diagnostic });
    this.name = "MotionSubmissionValidationError";
    this.code = diagnostic.code;
  }
}
