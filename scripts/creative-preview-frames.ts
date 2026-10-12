/** 验收取样保留作者指定的动作中途；抽帧只支持状态核对，不代表连续观看。 */
export function planCreativePreviewFrames(durationInFrames: number, requestedFrames: readonly number[] = []): number[][] {
  if (!Number.isSafeInteger(durationInFrames) || durationInFrames <= 0) {
    throw new Error("预览长度必须是正整数帧数");
  }
  if (!Array.isArray(requestedFrames) || requestedFrames.some((frame) => !Number.isSafeInteger(frame) || frame < 0 || frame >= durationInFrames)) {
    throw new Error("inspection_frames 必须是当前预览范围内的整数帧，不能裁切或取整后继续");
  }
  const overview = [0, ...[0.2, 0.4, 0.6, 0.8].map((ratio) => Math.floor(durationInFrames * ratio)), durationInFrames - 1];
  const frames = [...new Set([...overview, ...requestedFrames])].sort((left, right) => left - right);
  const batches: number[][] = [];
  // inspect_composed_frames 每次最多 12 帧；不能为塞进一次请求而丢掉关键接点。
  for (let index = 0; index < frames.length; index += 12) batches.push(frames.slice(index, index + 12));
  return batches;
}
