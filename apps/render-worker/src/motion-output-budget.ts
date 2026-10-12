import { readRuntimeConfig } from "@videocut/project-overview";
const MiB = 1024 * 1024;
export const MOTION_DISK_RESERVE_BYTES = 1024 * MiB;

/** PNG 是逐帧落盘的无损输出，不是同时驻留内存；预算应覆盖合法画幅的 RGBA 最坏体积。 */
export function motionOutputBudget(width: number, height: number, frames: number): number {
  if (![width, height, frames].every(value => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(width * height * frames * 4)) {
    throw new Error("MOTION_RENDER_BUDGET: 尺寸无效或输出体积超过安全整数范围");
  }
  // 只估算磁盘体积；累计像素帧不代表同时驻留内存。
  const budget = Math.ceil((width * 4 + 1) * height * frames * 1.01) + frames * 1024;
  if (!Number.isSafeInteger(budget)) throw new Error("MOTION_RENDER_BUDGET: 输出体积超过安全整数范围");
  return budget;
}

export function checkMotionOutputBudget(bytes: number, budget: number): void {
  if (bytes > budget) throw new Error(`MOTION_OUTPUT_BUDGET: 透明帧已用 ${bytes} 字节，预算 ${budget} 字节`);
}

export function checkMotionDiskSpace(availableBytes: number, budget: number, temporaryBytes = 0): void {
  const required = budget + temporaryBytes + readRuntimeConfig().motion.diskReserveBytes;
  if (availableBytes < required) throw new Error(`MOTION_DISK_SPACE: 可用 ${availableBytes} 字节，需要 ${required} 字节（含预览及余量）`);
}
