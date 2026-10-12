import { DomainError } from "@videocut/domain";

type FrameRange = { startFrame: number; endFrame: number };

/** 仅在 Revision 保存前的范围检查抛出，不按错误码猜测写入是否发生。 */
export class EffectCueRangeValidationError extends DomainError {
  constructor(
    readonly sceneId: string,
    readonly sceneRange: FrameRange,
    readonly requestedRange: FrameRange,
    readonly action: "create" | "update",
    outsideScene: boolean
  ) {
    super(action === "create" ? (outsideScene ? "效果必须位于所属场景内" : "效果范围无效") : "调整后的效果范围无效",
      action === "create" && outsideScene ? "CUE_OUT_OF_SCENE" : "INVALID_CUE_RANGE");
    this.name = "EffectCueRangeValidationError";
  }
}

export function assertEffectCueRange(scene: FrameRange & { id: string }, range: FrameRange, action: "create" | "update"): void {
  const outsideScene = range.startFrame < scene.startFrame || range.endFrame > scene.endFrame;
  if (outsideScene || !Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame) || range.endFrame <= range.startFrame) {
    throw new EffectCueRangeValidationError(scene.id,
      { startFrame: scene.startFrame, endFrame: scene.endFrame }, { ...range }, action, outsideScene);
  }
}
