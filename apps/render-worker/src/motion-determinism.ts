import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";

export interface MotionFrameDifference {
  changedPixels: number;
  maxChannelDelta: number;
  meanChannelDelta: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

// 仅容纳 8 位合成色最多两个色阶的舍入差；不使用全图平均值掩盖小面积元素丢失。
export const MOTION_MAX_CHANNEL_DELTA = 2;
export interface MotionDeterminismReport {
  status: "exact" | "tolerated" | "failed";
  maxAllowedChannelDelta: number;
  sampledFrames: number[];
  differences: Awaited<ReturnType<typeof saveMotionFrameDifference>>[];
}

export class MotionDeterminismError extends Error {
  readonly code = "MOTION_NONDETERMINISTIC";
  constructor(public readonly report: MotionDeterminismReport) {
    const failed = report.differences.filter((entry) => entry.maxChannelDelta > report.maxAllowedChannelDelta);
    super(`MOTION_NONDETERMINISTIC: 重复定位帧 ${failed.map((entry) => entry.frame).join("、")} 的可见差异超出 ${report.maxAllowedChannelDelta} 色阶；已保存原图、复截图和差异报告`);
  }
}

/** 同时比较黑、白背景上的合成色，忽略全透明 RGB，仍检出 Alpha 与任意背景上的可见差异。 */
export function compareMotionFrames(first: Buffer, repeated: Buffer): MotionFrameDifference & { diff: Buffer } {
  const a = PNG.sync.read(first), b = PNG.sync.read(repeated);
  if (a.width !== b.width || a.height !== b.height) throw new Error("MOTION_OUTPUT_MISMATCH: 对比帧画幅不同");
  const diff = new PNG({ width: a.width, height: a.height });
  let changedPixels = 0, maxChannelDelta = 0, totalDelta = 0;
  let left = a.width, top = a.height, right = -1, bottom = -1;
  for (let offset = 0; offset < a.data.length; offset += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 3; channel++) {
      const black = (a.data[offset + channel]! * a.data[offset + 3]! - b.data[offset + channel]! * b.data[offset + 3]!) / 255;
      const white = black + b.data[offset + 3]! - a.data[offset + 3]!;
      const delta = Math.max(Math.abs(black), Math.abs(white));
      pixelDelta = Math.max(pixelDelta, delta);
      totalDelta += delta;
    }
    maxChannelDelta = Math.max(maxChannelDelta, pixelDelta);
    if (pixelDelta > 0) {
      changedPixels++;
      const x = (offset / 4) % a.width, y = Math.floor(offset / 4 / a.width);
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    // 差异图放大八倍便于定位；报告数值始终使用未经放大的实际差异。
    diff.data[offset] = Math.min(255, Math.ceil(pixelDelta * 8));
    diff.data[offset + 3] = 255;
  }
  return { changedPixels, maxChannelDelta, meanChannelDelta: totalDelta / (a.width * a.height * 3),
    bounds: changedPixels ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null,
    diff: PNG.sync.write(diff) };
}

export async function saveMotionFrameDifference(directory: string, frame: number, first: Buffer, repeated: Buffer) {
  const { diff, ...metrics } = compareMotionFrames(first, repeated);
  await mkdir(directory, { recursive: true });
  const prefix = `frame-${String(frame).padStart(5, "0")}`;
  const paths = { first: `${prefix}-first.png`, repeated: `${prefix}-repeated.png`, diff: `${prefix}-diff.png` };
  await writeFile(join(directory, paths.first), first);
  await writeFile(join(directory, paths.repeated), repeated);
  await writeFile(join(directory, paths.diff), diff);
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const report = { frame, ...metrics, firstHash: hash(first), repeatedHash: hash(repeated), paths };
  await writeFile(join(directory, `${prefix}.json`), JSON.stringify(report, null, 2));
  return report;
}

/** 哈希负责快速相等检查；不相等时比较可见像素，保留全部抽查证据后才决定是否中止。 */
export async function verifyMotionDeterminism(directory: string, frameHashes: string[], capture: (frame: number) => Promise<Buffer>): Promise<MotionDeterminismReport> {
  if (!frameHashes.length) throw new Error("MOTION_OUTPUT_MISMATCH: 缺少待核验帧");
  const sampledFrames = [...new Set([0, Math.floor(frameHashes.length / 2), frameHashes.length - 1])];
  const report: MotionDeterminismReport = { status: "exact", maxAllowedChannelDelta: MOTION_MAX_CHANNEL_DELTA, sampledFrames, differences: [] };
  const diagnostics = join(directory, "diagnostics");
  for (const frame of sampledFrames) {
    const repeated = await capture(frame);
    if (createHash("sha256").update(repeated).digest("hex") === frameHashes[frame]) continue;
    const first = await readFile(join(directory, "frames", `frame-${String(frame).padStart(5, "0")}.png`));
    // 容差只适用于重新渲染的结果；磁盘原帧的完整性校验始终精确。
    if (createHash("sha256").update(first).digest("hex") !== frameHashes[frame]) throw new Error("MOTION_CACHE_CORRUPT");
    const difference = await saveMotionFrameDifference(diagnostics, frame, first, repeated);
    report.differences.push(difference);
    if (difference.maxChannelDelta > MOTION_MAX_CHANNEL_DELTA) report.status = "failed";
    else if (report.status === "exact") report.status = "tolerated";
  }
  await mkdir(diagnostics, { recursive: true });
  await writeFile(join(diagnostics, "report.json"), JSON.stringify(report, null, 2));
  if (report.status === "failed") throw new MotionDeterminismError(report);
  return report;
}
