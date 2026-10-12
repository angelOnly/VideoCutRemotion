import type { CSSProperties } from "react";
import type { Cutaway, TimelineItem, TimelineTrack } from "@videocut/contracts";

export interface CutawayLayout {
  container: CSSProperties;
  media: CSSProperties;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * PiP 只使用现阶段已实现的画布安全区。底部留给稳定字幕，避免凭空声称有姿态或手势锚点。
 */
function pipPosition(anchor: Cutaway["pipAnchor"]): CSSProperties {
  switch (anchor) {
    case "top_left": return { left: "5%", top: "8%" };
    case "middle_left": return { left: "5%", top: "42%", transform: "translateY(-50%)" };
    case "middle_right": return { right: "5%", top: "42%", transform: "translateY(-50%)" };
    case "bottom_left": return { left: "5%", bottom: "20%" };
    case "bottom_right": return { right: "5%", bottom: "20%" };
    case "center": return { left: "50%", top: "43%", transform: "translate(-50%, -50%)" };
    case "top_right":
    default: return { right: "5%", top: "8%" };
  }
}

/** Fullscreen 与 PiP 使用相同的 Cutaway 事实，只在空间布局上分支。 */
export function compileCutawayLayout(cutaway: Cutaway, assetAspectRatio?: number): CutawayLayout {
  const media: CSSProperties = { width: "100%", height: "100%", objectFit: cutaway.fit, display: "block" };
  if (cutaway.mode === "fullscreen") {
    return {
      container: { position: "absolute", inset: 0, overflow: "hidden", background: "#000" },
      media
    };
  }
  const scale = clamp(cutaway.pipScale ?? 0.34, 0.2, 0.6);
  const aspectRatio = assetAspectRatio && Number.isFinite(assetAspectRatio) && assetAspectRatio > 0
    ? clamp(assetAspectRatio, 0.45, 2.2)
    : 16 / 9;
  return {
    container: {
      position: "absolute",
      width: `${Math.round(scale * 1000) / 10}%`,
      maxHeight: "42%",
      aspectRatio,
      overflow: "hidden",
      borderRadius: 16,
      background: "#0b1020",
      boxShadow: "0 14px 34px #0009",
      border: "1px solid #ffffff2e",
      ...pipPosition(cutaway.pipAnchor)
    },
    media
  };
}

/** B-roll 默认不抢 Dialogue；只有明确选择 include_source_audio 才输出素材原声。 */
export function cutawaySourceVolume(cutaway: Cutaway, item: TimelineItem, track: TimelineTrack): number {
  if (cutaway.audioMode !== "include_source_audio" || track.muted) return 0;
  return Math.pow(10, (item.gainDb ?? 0) / 20);
}
