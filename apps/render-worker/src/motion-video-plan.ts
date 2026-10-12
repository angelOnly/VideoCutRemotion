import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { BoundMotionVideo, DecodedMotionVideo, MotionSubmission } from "../../../packages/motion-work/src/schema.js";
import { hashMotionFile } from "./motion-video.js";
import { motionDecodeDimensions, probeMotionVideoGeometry, type MotionVideoGeometry } from "./motion-video-geometry.js";

export interface MotionVideoSource { hash: string; path: string; bytes: number; geometry: MotionVideoGeometry }
export interface MotionVideoClip extends DecodedMotionVideo { binding: BoundMotionVideo; source: MotionVideoSource }
export interface MotionVideoPlan { sources: MotionVideoSource[]; clips: Record<string, MotionVideoClip>; sourceBytes: number }

export async function planMotionVideos(root: string, work: MotionSubmission, bindings: BoundMotionVideo[], signal?: AbortSignal): Promise<MotionVideoPlan> {
  const projectRoot = await realpath(root);
  const sources = new Map<string, MotionVideoSource>();
  const checkedPaths = new Set<string>();
  const clips: MotionVideoPlan["clips"] = {};
  for (const binding of bindings) {
    signal?.throwIfAborted();
    const path = await realpath(resolve(projectRoot, binding.managedPath));
    const rel = relative(projectRoot, path);
    if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("MOTION_VIDEO_PATH_REJECTED");
    const info = await stat(path);
    if (!info.isFile()) throw new Error("MOTION_VIDEO_SOURCE_INVALID");
    const identity = `${path}:${binding.hash}`;
    if (!checkedPaths.has(identity)) {
      if (await hashMotionFile(path, signal) !== binding.hash) throw new Error("MOTION_VIDEO_CHANGED");
      checkedPaths.add(identity);
    }
    let source = sources.get(binding.hash);
    if (!source) {
      source = { path, hash: binding.hash, bytes: info.size, geometry: await probeMotionVideoGeometry(path) };
      sources.set(binding.hash, source);
    }
    const frameCount = binding.endFrame - binding.startFrame;
    const selectedMs = binding.sourceEndMs - binding.sourceStartMs;
    if (frameCount <= 0 || binding.startFrame < 0 || binding.endFrame > work.durationInFrames || selectedMs <= 0
      || selectedMs + 1 < frameCount * 1000 / work.fps || selectedMs - frameCount * 1000 / work.fps >= 1000 / work.fps + 1
      || binding.sourceEndMs > source.geometry.durationMs + 0.01
      || binding.sourceStartMs + frameCount * 1000 / work.fps > source.geometry.durationMs + 0.01) throw new Error("MOTION_VIDEO_SOURCE_RANGE: 源范围不能提供声明的作品帧范围");
    const dimensions = motionDecodeDimensions(source.geometry, work, binding.decodeScale);
    clips[binding.slot] = { binding, source, ...dimensions, startFrame: binding.startFrame, endFrame: binding.endFrame, frameCount, geometry: source.geometry, decodeScale: binding.decodeScale };
  }
  return { sources: [...sources.values()], clips, sourceBytes: [...sources.values()].reduce((sum, source) => sum + source.bytes, 0) };
}
