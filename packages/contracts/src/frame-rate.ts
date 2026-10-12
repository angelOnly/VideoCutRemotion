import { z } from "zod";

/** 项目与作品共用已验证规格；分数帧率须另做完整链路验证。 */
export const projectFrameRateSchema = z.number().int().min(15).max(60);

export function convertFrameRate(frame: number, fromFps: number, toFps: number): number {
  return Math.round(frame * toFps / fromFps);
}

export function motionDurationAtFps(frameCount: number, workFps: number, projectFps: number): number {
  return convertFrameRate(frameCount, workFps, projectFps);
}

/** 固定透明帧按时间采样；重复取帧是正常升采样，不生成运动细节。 */
export function motionFrameAtProjectFrame(localFrame: number, workFps: number, projectFps: number, frameCount: number): number {
  const frame = Math.floor(localFrame * workFps / projectFps + 1e-9);
  if (!Number.isInteger(localFrame) || localFrame < 0 || frame < 0 || frame >= frameCount) {
    throw new Error("MOTION_FRAME_OUT_OF_RANGE: 作品时间采样越界");
  }
  return frame;
}

export interface FrameRateChangeReport {
  revision: number;
  fromFps: number;
  toFps: number;
  changed: boolean;
  canApply: boolean;
  affectedObjectIds: string[];
  durationBeforeSeconds: number;
  durationAfterSeconds: number;
  maxBoundaryErrorMs: number;
  blockers: Array<{ code: string; objectId?: string; message: string }>;
  warnings: string[];
  rebuild: string[];
}
