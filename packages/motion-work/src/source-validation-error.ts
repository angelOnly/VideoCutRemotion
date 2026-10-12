/** 源码诊断不携带重试许可：同一校验器也会在已入队的 Worker 中运行。 */
export class MotionSourceValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly location: { line: number; column: number },
    readonly nodeKind: string,
    readonly token: string,
    readonly suggestion: string
  ) {
    super(`${code}: ${message}`);
    this.name = "MotionSourceValidationError";
  }
}
