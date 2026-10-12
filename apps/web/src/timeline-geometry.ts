export const TRACK_LABEL_WIDTH = 120;

export function clampFrame(frame: number, duration: number): number {
  return Math.max(0, Math.min(Math.round(frame), Math.max(0, duration - 1)));
}

/** 左侧名称固定，时间画布随 scrollLeft 滚动；所有轨道使用同一个坐标换算。 */
export function frameAtClientX(clientX: number, viewportLeft: number, scrollLeft: number, canvasWidth: number, duration: number): number {
  return clampFrame((clientX - viewportLeft - TRACK_LABEL_WIDTH + scrollLeft) / Math.max(1, canvasWidth) * duration, duration);
}

/** 缩放时保留可见指针的位置；指针不在视野内时，以当前视野中心为锚点。 */
export function scrollAfterZoom(oldWidth: number, newWidth: number, visibleWidth: number, scrollLeft: number, playhead: number, duration: number): number {
  const playheadX = playhead / Math.max(1, duration) * oldWidth;
  const anchor = playheadX >= scrollLeft && playheadX <= scrollLeft + visibleWidth
    ? playheadX : scrollLeft + visibleWidth / 2;
  return Math.max(0, Math.min(anchor / Math.max(1, oldWidth) * newWidth - (anchor - scrollLeft), newWidth - visibleWidth));
}

export function rulerStep(duration: number, fps: number, canvasWidth: number): number {
  const minimum = duration * 90 / Math.max(1, canvasWidth);
  if (minimum <= 1) return 1;
  if (minimum < fps) return [1, 2, 5, 10, 15, 20, fps].find((step) => step >= minimum) ?? fps;
  const seconds = minimum / fps;
  const magnitude = 10 ** Math.floor(Math.log10(seconds));
  return Math.ceil(([1, 2, 5, 10].find((step) => step * magnitude >= seconds) ?? 10) * magnitude * fps);
}

/** 返回像素/秒，避免高刷新率屏幕上的边缘滚动速度翻倍。 */
export function edgeScrollSpeed(clientX: number, left: number, right: number): number {
  const edge = Math.min(36, Math.max(0, (right - left) / 4));
  if (!edge) return 0;
  if (clientX < left + edge) return -720 * Math.min(1, (left + edge - clientX) / edge);
  if (clientX > right - edge) return 720 * Math.min(1, (clientX - right + edge) / edge);
  return 0;
}
