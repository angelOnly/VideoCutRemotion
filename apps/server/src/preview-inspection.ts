import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DomainError } from "@videocut/domain";
import { runProcess } from "@videocut/speech";

export interface ComposedFrameArtifact {
  frame: number;
  path: string;
  relativePath: string;
}

function assertPathWithin(projectRoot: string, candidatePath: string): void {
  const relativePath = relative(projectRoot, candidatePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DomainError("预览文件路径超出项目目录", "UNSAFE_PREVIEW_PATH");
  }
}

/**
 * 从已经完成的局部预览抽取关键帧。这里不重新执行 Remotion，确保审片看到的就是 Job 实际产物。
 */
export async function inspectComposedFrames(input: {
  projectRoot: string;
  previewPath: string;
  revision: number;
  fromFrame: number;
  toFrame: number;
  fps: number;
  frames?: number[];
}): Promise<ComposedFrameArtifact[]> {
  if (!Number.isInteger(input.revision) || input.revision <= 0 || !Number.isInteger(input.fromFrame) || !Number.isInteger(input.toFrame) || !Number.isFinite(input.fps) || input.fromFrame < 0 || input.toFrame <= input.fromFrame || input.fps <= 0) {
    throw new DomainError("预览帧检查参数无效", "INVALID_PREVIEW_INSPECTION");
  }
  const projectRoot = resolve(input.projectRoot);
  const previewPath = resolve(input.previewPath);
  assertPathWithin(projectRoot, previewPath);
  if (!existsSync(previewPath)) throw new DomainError("局部预览文件不存在，无法抽取合成帧", "PREVIEW_NOT_FOUND");
  const requested = input.frames?.length
    ? input.frames
    : [input.fromFrame, Math.floor((input.fromFrame + input.toFrame - 1) / 2), input.toFrame - 1];
  const frames = [...new Set(requested)].sort((left, right) => left - right);
  if (frames.some((frame) => !Number.isInteger(frame) || frame < input.fromFrame || frame >= input.toFrame)) {
    throw new DomainError("请求的检查帧不在该局部预览范围内", "PREVIEW_FRAME_OUT_OF_RANGE");
  }
  const outputDirectory = join(projectRoot, "previews", "frames");
  await mkdir(outputDirectory, { recursive: true });
  const artifacts: ComposedFrameArtifact[] = [];
  for (const frame of frames) {
    const relativePath = join("previews", "frames", `revision-${input.revision}-frame-${frame}.jpg`);
    const path = join(projectRoot, relativePath);
    const seekSeconds = (frame - input.fromFrame) / input.fps;
    // 先清掉同名旧证据，避免 FFmpeg 无输出时误把上一轮图片当作本次审片结果。
    await rm(path, { force: true });
    await runProcess("ffmpeg", [
      "-y",
      "-i", previewPath,
      // 输出端精确跳转，不能在输入前按毫秒快速跳转，否则 24fps 的最后一帧可能被越过。
      "-ss", seekSeconds.toFixed(6),
      "-frames:v", "1",
      "-vf", "scale=640:-2",
      "-q:v", "2",
      path
    ], 120_000);
    const artifact = await stat(path).catch(() => undefined);
    if (!artifact?.isFile() || artifact.size === 0) throw new DomainError("合成帧抽取失败", "COMPOSED_FRAME_EXTRACTION_FAILED");
    artifacts.push({ frame, path, relativePath });
  }
  return artifacts;
}
