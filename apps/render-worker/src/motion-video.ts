import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { BoundMotionVideo, MotionSubmission } from "../../../packages/motion-work/src/schema.js";
import { MOTION_ENGINE_VERSION } from "../../../packages/motion-work/src/compiler.js";
import { planMotionVideos } from "./motion-video-plan.js";
import { createMotionVideoProvider } from "./motion-video-provider.js";

export async function hashMotionFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest("hex");
}

/** 新作品只建立固定引用和有界帧服务，不复制原片，也不展开全部选段。 */
export async function prepareMotionVideos(root: string, directory: string, work: MotionSubmission, bindings: BoundMotionVideo[], engineVersion = MOTION_ENGINE_VERSION, signal?: AbortSignal) {
  if (engineVersion !== MOTION_ENGINE_VERSION) throw new Error("MOTION_ENGINE_UPGRADE_REQUIRED: 历史产物可读取；重新生成须按当前视频时间合同提交新版本");
  return createMotionVideoProvider(root, directory, work, await planMotionVideos(root, work, bindings, signal), signal);
}
