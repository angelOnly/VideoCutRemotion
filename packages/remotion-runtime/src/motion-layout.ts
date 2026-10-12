import type { CSSProperties } from "react";
import type { ActorLayout, EffectCue } from "@videocut/contracts";

export interface EffectStylePack {
  id: string;
  fontFamily: string;
  foreground: string;
  accent: string;
  accentForeground: string;
  surface: string;
  mutedSurface: string;
  radius: number;
  shadow: string;
}

export interface CompiledCueMotion {
  opacity: number;
  transform: string;
  enter: number;
  exit: number;
}

export interface MotionLayout {
  /** 由 spatialAnchor 决定的安全区位置和尺寸，不再由各组件各自猜测位置。 */
  container: CSSProperties;
  anchorTransform: string;
  motion: CompiledCueMotion;
  stylePack: EffectStylePack;
}

/** 人物推近不绘制额外卡片，而是编译为主画面的缩放进度与取景重心。 */
export interface CameraPunchLayout {
  scale: number;
  progress: number;
  transformOrigin: string;
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const stylePacks: Record<string, EffectStylePack> = {
  "default-clean": {
    id: "default-clean",
    fontFamily: "Inter, Noto Sans SC, sans-serif",
    foreground: "#ffffff",
    accent: "#5a7dff",
    accentForeground: "#ffffff",
    surface: "#10172ce8",
    mutedSurface: "#21467e",
    radius: 22,
    shadow: "0 18px 46px #0008"
  },
  "warm-editorial": {
    id: "warm-editorial",
    fontFamily: "Noto Serif SC, Source Han Serif SC, serif",
    foreground: "#2b1d15",
    accent: "#b64b2d",
    accentForeground: "#fff8ef",
    surface: "#fff5e8ef",
    mutedSurface: "#6f3e2a",
    radius: 12,
    shadow: "0 18px 42px #3b1d1260"
  },
  "evidence-paper": {
    id: "evidence-paper",
    fontFamily: "Noto Sans SC, Inter, sans-serif",
    foreground: "#183248",
    accent: "#246aa5",
    accentForeground: "#f3fbff",
    surface: "#f5f1e8f2",
    mutedSurface: "#315b7b",
    radius: 8,
    shadow: "0 13px 30px #09162455"
  }
};

export function resolveEffectStylePack(stylePackId: string | undefined): EffectStylePack {
  return stylePacks[stylePackId ?? ""] ?? stylePacks["default-clean"];
}

function dimensionsFor(cue: EffectCue): Pick<CSSProperties, "width" | "height" | "aspectRatio" | "maxWidth"> {
  switch (cue.type) {
    case "MetricBackdrop": return { width: "34%", maxWidth: 540 };
    case "ProductFan": return { width: "32%", height: "27%" };
    case "GlowCTA": return { width: "auto" };
    case "PortfolioWall": return { width: "30%", maxWidth: 480 };
    case "CommentCloud": return { width: "34%", maxWidth: 540 };
    case "EvidenceCard": return { width: "31%", maxWidth: 500 };
    case "CameraPunch": return { width: "84%", height: "72%" };
    case "DeviceShowcase": return { width: "26%", maxWidth: 360, aspectRatio: "0.53" };
    case "ContentCarousel": return { width: "90%", maxWidth: 1200 };
    case "FullScreenMeme":
    case "EndCard":
    case "ManagedMotion": return { width: "100%", height: "100%" };
  }
}

/**
 * 第一阶段没有姿态和手部锚点，因此只使用画布安全区：顶部避开平台 UI，底部避开字幕，
 * 中部两侧为人物留出脸、嘴和手势的主区域。阶段 2 可以在这里接入 ActorLayout，而不改组件。
 */
function anchorContainer(cue: EffectCue, actorLayout?: ActorLayout): { container: CSSProperties; anchorTransform: string } {
  if (cue.spatialAnchor === "full_frame" || cue.type === "FullScreenMeme" || cue.type === "EndCard") {
    return { container: { position: "absolute", inset: 0, boxSizing: "border-box" }, anchorTransform: "" };
  }
  const container: CSSProperties = { position: "absolute", boxSizing: "border-box", ...dimensionsFor(cue) };
  switch (cue.spatialAnchor) {
    case "top_left": Object.assign(container, { left: "5%", top: "8%" }); break;
    case "top_right": Object.assign(container, { right: "5%", top: "8%" }); break;
    case "middle_left": Object.assign(container, { left: "5%", top: "36%" }); break;
    case "middle_right": Object.assign(container, { right: "5%", top: "36%" }); break;
    case "bottom_left": Object.assign(container, { left: "5%", bottom: "20%" }); break;
    case "bottom_right": Object.assign(container, { right: "5%", bottom: "20%" }); break;
    case "safe_left": Object.assign(container, { left: "5%", top: "36%" }); break;
    case "safe_right": Object.assign(container, { right: "5%", top: "36%" }); break;
    case "actor_head": {
      const point = actorLayout?.actorHead;
      if (point) {
        Object.assign(container, { left: `${(point.x * 100).toFixed(2)}%`, top: `${(point.y * 100).toFixed(2)}%` });
        return { container, anchorTransform: "translate(-50%, -50%)" };
      }
      Object.assign(container, { right: "5%", top: "24%" });
      break;
    }
    case "actor_hands": {
      const point = actorLayout?.actorHands;
      if (point) {
        Object.assign(container, { left: `${(point.x * 100).toFixed(2)}%`, top: `${(point.y * 100).toFixed(2)}%` });
        return { container, anchorTransform: "translate(-50%, -50%)" };
      }
      Object.assign(container, { right: "5%", top: "56%" });
      break;
    }
    case "behind_actor": Object.assign(container, { left: "5%", top: "13%", width: "90%", height: "68%" }); break;
    case "center": Object.assign(container, { left: "50%", top: "43%" }); return { container, anchorTransform: "translate(-50%, -50%)" };
    default: Object.assign(container, { right: "5%", bottom: "20%" }); break;
  }
  return { container, anchorTransform: "" };
}

function progress(frame: number, start: number, duration: number): number {
  return clamp((frame - start) / Math.max(1, duration));
}

function smoothStep(value: number): number {
  const clamped = clamp(value);
  return clamped * clamped * (3 - 2 * clamped);
}

function cameraEnterProgress(value: number, preset: string): number {
  const linear = clamp(value);
  switch (preset) {
    case "none": return 1;
    // 轻微 overshoot 后回到 1，才会与普通 scale 形成可见但不过分的“包袱落点”。
    case "pop": {
      const shifted = linear - 1;
      return 1 + 2.70158 * shifted * shifted * shifted + 1.70158 * shifted * shifted;
    }
    case "scale": return smoothStep(linear);
    default: return 1 - Math.pow(1 - linear, 3);
  }
}

function cameraExitProgress(value: number, preset: string): number {
  const linear = clamp(value);
  if (preset === "none") return 1;
  if (preset === "scale") return 1 - smoothStep(linear);
  return 1 - (1 - Math.pow(1 - linear, 3));
}

/** 第一阶段没有 Pose 时只可选择安全的近似取景重心，不能伪造人脸或手部追踪。 */
function cameraTransformOrigin(anchor: EffectCue["spatialAnchor"], actorLayout?: ActorLayout): string {
  switch (anchor) {
    case "top_left": return "28% 26%";
    case "top_right": return "72% 26%";
    case "middle_left": return "30% 46%";
    case "middle_right": return "70% 46%";
    case "bottom_left": return "32% 66%";
    case "bottom_right": return "68% 66%";
    case "safe_left": return "28% 46%";
    case "safe_right": return "72% 46%";
    case "actor_head": return actorLayout?.actorHead ? `${(actorLayout.actorHead.x * 100).toFixed(2)}% ${(actorLayout.actorHead.y * 100).toFixed(2)}%` : "50% 30%";
    case "actor_hands": return actorLayout?.actorHands ? `${(actorLayout.actorHands.x * 100).toFixed(2)}% ${(actorLayout.actorHands.y * 100).toFixed(2)}%` : "50% 62%";
    case "behind_actor": return "50% 46%";
    case "center":
    case "full_frame":
    default: return "50% 46%";
  }
}

/**
 * CameraPunch 仍是“人物构图推近”，但进入/退出预设现在会改变实际推近曲线。
 * fade 对主画面不能真的降透明度，因此在此降级为平滑回位，避免口播突然闪断。
 */
export function compileCameraPunchLayout(cue: EffectCue, frame: number, actorLayout?: ActorLayout): CameraPunchLayout {
  const intensity = clamp(cue.intensity);
  const enter = cameraEnterProgress(progress(frame, cue.startFrame, cue.motion.enterFrames), cue.motion.enterPreset);
  const exit = cameraExitProgress(progress(frame, cue.endFrame - cue.motion.exitFrames, cue.motion.exitFrames), cue.motion.exitPreset);
  const punchProgress = Math.max(0, Math.min(1.12, Math.min(enter, exit)));
  return {
    scale: 1 + punchProgress * (0.03 + intensity * 0.045),
    progress: punchProgress,
    transformOrigin: cameraTransformOrigin(cue.spatialAnchor, actorLayout)
  };
}

/**
 * 将 Cue 的具名运动字段翻译成实际 transform。intensity 同时改变距离、缩放与运动完成速度，
 * 但不改变 Cue 的语义时长，稳定区仍留给阅读。
 */
export function compileMotionLayout(cue: EffectCue, frame: number, actorLayout?: ActorLayout): MotionLayout {
  const intensity = clamp(cue.intensity);
  const speed = 1.25 - intensity * 0.55;
  const enterFrames = Math.max(1, Math.round(cue.motion.enterFrames * speed));
  const exitFrames = Math.max(1, Math.round(cue.motion.exitFrames * speed));
  const enter = progress(frame, cue.startFrame, enterFrames);
  const exit = progress(frame, cue.endFrame - exitFrames, exitFrames);
  const distance = 14 + intensity * 42;
  const scaleDelta = 0.035 + intensity * 0.085;
  let x = 0;
  let y = 0;
  let scale = 1;
  let rotate = 0;
  let opacity = 1;

  switch (cue.motion.enterPreset) {
    case "slide_left": x -= (1 - enter) * distance; break;
    case "slide_right": x += (1 - enter) * distance; break;
    case "rise": y += (1 - enter) * distance; break;
    case "scale": scale -= (1 - enter) * scaleDelta; break;
    case "pop": scale -= (1 - enter) * (scaleDelta * 1.5); rotate -= (1 - enter) * (2 + intensity * 4); break;
    case "fade": break;
    case "none": opacity = 1; break;
    case "fade_slide":
    default: y += (1 - enter) * distance; break;
  }
  if (cue.motion.enterPreset !== "none") opacity *= enter;

  const settled = enter >= 1 && exit <= 0;
  if (settled) {
    switch (cue.motion.settlePreset) {
      case "float": y += Math.sin(frame / 8) * (1 + intensity * 4); break;
      case "pulse": scale += Math.sin(frame / 5) * (0.004 + intensity * 0.016); break;
      case "breathe": scale += Math.sin(frame / 12) * (0.003 + intensity * 0.01); break;
      default: break;
    }
  }

  switch (cue.motion.exitPreset) {
    case "slide_left": x -= exit * distance; break;
    case "slide_right": x += exit * distance; break;
    case "slide": y -= exit * distance; break;
    case "scale": scale -= exit * scaleDelta; break;
    case "none": break;
    case "fade":
    default: opacity *= 1 - exit; break;
  }

  const anchor = anchorContainer(cue, actorLayout);
  return {
    ...anchor,
    motion: {
      opacity: clamp(opacity),
      transform: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${rotate.toFixed(2)}deg) scale(${scale.toFixed(4)})`,
      enter,
      exit
    },
    stylePack: resolveEffectStylePack(cue.stylePackId)
  };
}
