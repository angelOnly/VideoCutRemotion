import {AbsoluteFill, interpolate, useCurrentFrame} from "remotion";

export type CaptionCue = {
  text: string;
  startFrame: number;
  endFrame: number;
  left: number;
  top: number;
  width: number;
  fontSize: number;
  lineHeight: number;
  timingPrecision: "visual_proxy_without_speech_alignment";
};

export type DSimConclusionProps = {
  primaryText: string;
  inequalityText: string;
  secondaryText: string;
  renderCaption: boolean;
  captionCue: CaptionCue;
};

export const DEFAULT_CAPTION_CUE: CaptionCue = {
  text: "信号强，不等于质量好；\n只盯着格数，看不出全部情况。",
  startFrame: 61,
  endFrame: 109,
  left: 44,
  top: 1174,
  width: 680,
  fontSize: 36,
  lineHeight: 1.22,
  timingPrecision: "visual_proxy_without_speech_alignment",
};

export const defaultProps: DSimConclusionProps = {
  primaryText: "信号强",
  inequalityText: "≠",
  secondaryText: "质量好",
  renderCaption: false,
  captionCue: DEFAULT_CAPTION_CUE,
};

const W = 768;
const H = 1344;
const TRAY_W = 520;
const TRAY_H = 840;
const TRAY_SCALE_AT_REVEAL = 580 / 520;

const COLORS = {
  dark: "#08110D",
  lit: "#192A21",
  warmWhite: "#F3F1E6",
  silver: "#D7DCCF",
  gold: "#E7CF8C",
  mint: "#55F59A",
  amber: "#C99143",
  deepGold: "#725923",
  trayEdge: "#6D766D",
  traySlot: "#111A16",
};

const FONT_STACK =
  '"Noto Sans SC", "Microsoft YaHei", "SimHei", sans-serif';

type Point = {x: number; y: number};

type TrayState = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
};

type CardState = {
  position: Point;
  scale: number;
  rotation: number;
  hover: number;
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

const mix = (from: number, to: number, t: number) => from + (to - from) * t;

const phase = (frame: number, start: number, end: number) =>
  clamp((frame - start) / (end - start));

const smooth = (frame: number, start: number, end: number) => {
  const t = phase(frame, start, end);
  return t * t * (3 - 2 * t);
};

const add = (a: Point, b: Point): Point => ({x: a.x + b.x, y: a.y + b.y});

const scalePoint = (point: Point, factor: number): Point => ({
  x: point.x * factor,
  y: point.y * factor,
});

const rotate = (point: Point, degrees: number): Point => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
};

const cubicPoint = (
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point => {
  const mt = 1 - t;
  return {
    x:
      mt * mt * mt * p0.x +
      3 * mt * mt * t * p1.x +
      3 * mt * t * t * p2.x +
      t * t * t * p3.x,
    y:
      mt * mt * mt * p0.y +
      3 * mt * mt * t * p1.y +
      3 * mt * t * t * p2.y +
      t * t * t * p3.y,
  };
};

const cutCornerPath = (
  width: number,
  height: number,
  cut: number,
  corner: number,
) =>
  [
    `M ${corner} 0`,
    `H ${width - cut}`,
    `L ${width} ${cut}`,
    `V ${height - corner}`,
    `Q ${width} ${height} ${width - corner} ${height}`,
    `H ${corner}`,
    `Q 0 ${height} 0 ${height - corner}`,
    `V ${corner}`,
    `Q 0 0 ${corner} 0`,
    "Z",
  ].join(" ");

const TRAY_PATH = cutCornerPath(TRAY_W, TRAY_H, 70, 10);
const SLOT_PATH = cutCornerPath(220, 290, 30, 10);
const CARD_PATH = cutCornerPath(145, 200, 32, 5);

const trayAt = (frame: number): TrayState => {
  const retreat = smooth(frame, 18, 61);
  const settle = smooth(frame, 61, 87);

  return {
    x: mix(460, 535, retreat) + mix(0, 13, settle),
    y: mix(740, 720, retreat) + mix(0, -10, settle),
    scale:
      mix(TRAY_SCALE_AT_REVEAL, 1.075, retreat) * mix(1, 0.97, settle),
    rotation: mix(-14, 17, retreat) + mix(0, 2, settle),
    opacity: mix(1, 0.4, retreat),
  };
};

const pointOnTray = (
  tray: TrayState,
  localX: number,
  localY: number,
): Point => {
  const offset = rotate(
    {
      x: (localX - TRAY_W / 2) * tray.scale,
      y: (localY - TRAY_H / 2) * tray.scale,
    },
    tray.rotation,
  );

  return add({x: tray.x, y: tray.y}, offset);
};

const cardAt = (frame: number): CardState => {
  const revealTray = trayAt(18);
  const startSlot = pointOnTray(revealTray, 260, 285);
  const grownScale = TRAY_SCALE_AT_REVEAL * 1.07;

  if (frame <= 18) {
    return {
      position: startSlot,
      scale: TRAY_SCALE_AT_REVEAL,
      rotation: -14,
      hover: 0,
    };
  }

  const tray = trayAt(frame);

  if (frame <= 23) {
    const lift = smooth(frame, 18, 23);
    const currentSlot = pointOnTray(tray, 260, 285);
    // 抬起只沿托卡法线：屏幕横向量来自托卡的斜放投影。
    const normalLift = rotate({x: 0, y: -28 * lift}, tray.rotation);

    return {
      position: add(currentSlot, normalLift),
      scale: mix(TRAY_SCALE_AT_REVEAL, tray.scale, lift),
      rotation: tray.rotation,
      hover: lift,
    };
  }

  const liftTray = trayAt(23);
  const liftSlot = pointOnTray(liftTray, 260, 285);
  const liftEnd = add(liftSlot, rotate({x: 0, y: -28}, liftTray.rotation));
  const arcTarget = add(startSlot, {x: -70, y: -95});
  const controlA = add(liftEnd, {x: -18, y: -42});
  const controlB = add(arcTarget, {x: -26, y: -46});

  if (frame <= 40) {
    const arc = smooth(frame, 23, 40);
    return {
      position: cubicPoint(liftEnd, controlA, controlB, arcTarget, arc),
      scale: mix(TRAY_SCALE_AT_REVEAL, grownScale, arc),
      // 第 40 帧相对托卡左转约 6 度。
      rotation: tray.rotation - 6 * arc,
      hover: 1,
    };
  }

  const cardAngleAt40 = trayAt(40).rotation - 6;
  const settledCardPosition = {x: 365, y: 488};

  if (frame <= 61) {
    const settle = smooth(frame, 40, 61);
    return {
      position: {
        x: mix(arcTarget.x, settledCardPosition.x, settle),
        y: mix(arcTarget.y, settledCardPosition.y, settle),
      },
      scale: grownScale,
      // 离槽后小卡不再跟随托卡同速旋转。
      rotation: mix(cardAngleAt40, -1.5, settle),
      hover: 1,
    };
  }

  const finalSettle = smooth(frame, 61, 87);
  return {
    position: {
      x: mix(settledCardPosition.x, 359, finalSettle),
      y: mix(settledCardPosition.y, 493, finalSettle),
    },
    scale: grownScale * mix(1, 0.97, finalSettle),
    rotation: mix(-1.5, 0.5, finalSettle),
    hover: 1,
  };
};

const ContactChip = ({
  x,
  y,
  width,
  height,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => {
  const cx = x + width / 2;
  const cy = y + height / 2;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={8}
        fill="url(#d-chip-gold)"
        stroke="#806127"
        strokeWidth={2}
      />
      <rect
        x={x + 10}
        y={y + 12}
        width={width - 20}
        height={height - 24}
        rx={5}
        fill="none"
        stroke="#6F5521"
        strokeWidth={2}
        opacity={0.86}
      />
      <path
        d={[
          `M ${cx} ${y + 4} V ${y + height - 4}`,
          `M ${x + 8} ${cy} H ${x + width - 8}`,
          `M ${x + width * 0.29} ${y + 12} V ${y + height - 12}`,
          `M ${x + width * 0.72} ${y + 12} V ${y + height - 12}`,
        ].join(" ")}
        fill="none"
        stroke="#725923"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <rect
        x={x + width * 0.38}
        y={y + height * 0.36}
        width={width * 0.24}
        height={height * 0.28}
        rx={3}
        fill="#D6B96D"
        stroke="#725923"
        strokeWidth={1.6}
      />
      <path
        d={`M ${x + 10} ${y + 24} L ${x + width - 11} ${y + 12}`}
        stroke="#FFF1B9"
        strokeOpacity={0.46}
        strokeWidth={3}
        strokeLinecap="round"
      />
    </g>
  );
};

const SimTray = ({tray, frame}: {tray: TrayState; frame: number}) => {
  const lift = smooth(frame, 18, 23);
  const shadowScale = 1 + lift * 0.055;
  const transform = [
    `translate(${tray.x} ${tray.y})`,
    `rotate(${tray.rotation})`,
    `scale(${tray.scale})`,
    `translate(${-TRAY_W / 2} ${-TRAY_H / 2})`,
  ].join(" ");

  const barcodeOffsets = [0, 6, 10, 19, 25, 28, 38, 49, 54, 67, 74, 80];

  return (
    <g transform={transform} opacity={tray.opacity}>
      <path
        d={TRAY_PATH}
        transform="translate(6 7)"
        fill="#5E675F"
        stroke="#465049"
        strokeWidth={2}
      />
      <path
        d={TRAY_PATH}
        fill="url(#d-tray-face)"
        stroke="#ECF0E7"
        strokeOpacity={0.72}
        strokeWidth={2}
      />
      <path
        d="M 18 42 H 432"
        stroke="#FFFFFF"
        strokeOpacity={0.38}
        strokeWidth={3}
        strokeLinecap="round"
      />
      <path
        d="M 482 104 V 758"
        stroke="#4A544D"
        strokeOpacity={0.72}
        strokeWidth={5}
        strokeLinecap="round"
      />

      {/* 槽内阴影在小卡抬起时向右下拉开。 */}
      <path
        d={SLOT_PATH}
        transform={[
          `translate(${156 + lift * 10} ${149 + lift * 13})`,
          `scale(${shadowScale})`,
        ].join(" ")}
        fill="#020604"
        opacity={0.62}
      />
      <path
        d={SLOT_PATH}
        transform="translate(150 140)"
        fill="url(#d-slot-face)"
        stroke="#778178"
        strokeWidth={3}
      />
      <path
        d={SLOT_PATH}
        transform="translate(150 140)"
        fill="none"
        stroke="#F5F8EE"
        strokeOpacity={0.28}
        strokeWidth={2}
      />
      <path
        d="M 172 408 H 345"
        stroke="#AEB6AD"
        strokeOpacity={0.45}
        strokeWidth={2}
        strokeLinecap="round"
      />

      <g opacity={0.64} fontFamily={FONT_STACK}>
        <text
          x={54}
          y={578}
          fill="#425148"
          fontSize={18}
          fontWeight={800}
          letterSpacing={2}
        >
          SIM / EDITORIAL
        </text>
        <text
          x={54}
          y={608}
          fill="#59665E"
          fontSize={13}
          fontWeight={700}
          letterSpacing={1.2}
        >
          VISUAL SIGNATURE
        </text>
        <path
          d="M 54 631 H 234"
          stroke="#7B877E"
          strokeOpacity={0.58}
          strokeWidth={1.5}
        />
        {barcodeOffsets.map((offset, index) => (
          <line
            key={`barcode-${index}`}
            x1={54 + offset}
            y1={662}
            x2={54 + offset}
            y2={710}
            stroke="#4D5A52"
            strokeWidth={index % 3 === 0 ? 3 : 1.5}
          />
        ))}
        <text
          x={54}
          y={746}
          fill="#59665E"
          fontSize={12}
          fontWeight={700}
          letterSpacing={1.4}
        >
          FORM / 01
        </text>
      </g>
    </g>
  );
};

const SimCard = ({card}: {card: CardState}) => {
  const shadowX = 6 + card.hover * 11;
  const shadowY = 9 + card.hover * 15;
  const transform = [
    `translate(${card.position.x} ${card.position.y})`,
    `rotate(${card.rotation})`,
    `scale(${card.scale})`,
    "translate(-72.5 -100)",
  ].join(" ");

  return (
    <g transform={transform}>
      <path
        d={CARD_PATH}
        transform={`translate(${shadowX} ${shadowY})`}
        fill="#000000"
        opacity={0.35 + card.hover * 0.16}
      />
      <path
        d={CARD_PATH}
        transform="translate(5 6)"
        fill="#677067"
        stroke="#4D554E"
        strokeWidth={1.5}
      />
      <path
        d={CARD_PATH}
        fill="url(#d-card-face)"
        stroke="#F9FBF1"
        strokeWidth={1.8}
      />
      <path
        d="M 8 13 H 101"
        stroke="#FFFFFF"
        strokeOpacity={0.48}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <ContactChip x={15} y={27} width={115} height={145} />
      <text
        x={15}
        y={190}
        fill="#5A665E"
        fontFamily={FONT_STACK}
        fontSize={10}
        fontWeight={900}
        letterSpacing={1.8}
      >
        SIM
      </text>
    </g>
  );
};

const CaptionOverlay = ({
  frame,
  cue,
}: {
  frame: number;
  cue: CaptionCue;
}) => {
  if (frame < cue.startFrame || frame >= cue.endFrame) {
    return null;
  }

  const opacity = smooth(
    frame,
    cue.startFrame,
    Math.min(cue.startFrame + 6, cue.endFrame),
  );

  return (
    <div
      style={{
        position: "absolute",
        left: cue.left,
        top: cue.top,
        width: cue.width,
        boxSizing: "border-box",
        padding: "7px 12px 8px 14px",
        color: COLORS.warmWhite,
        backgroundColor: "rgba(8,17,13,0.84)",
        borderLeft: `3px solid ${COLORS.mint}`,
        borderRadius: 10,
        fontFamily: FONT_STACK,
        fontSize: cue.fontSize,
        fontWeight: 700,
        lineHeight: cue.lineHeight,
        letterSpacing: "-0.25px",
        whiteSpace: "pre-line",
        opacity,
      }}
    >
      {cue.text}
    </div>
  );
};

export const resolveMotionEvents = () => [
  {
    id: "d.entry-aperture-open",
    meaning: "中心窄金色开口扩成触点微距",
    startFrame: 0,
    endFrame: 12,
  },
  {
    id: "d.camera-pullback",
    meaning: "同一触点由微距拉远，显出嵌槽的小卡与托卡",
    startFrame: 0,
    endFrame: 18,
  },
  {
    id: "d.card-normal-lift",
    meaning: "小卡只沿托卡法线抬起，接触阴影拉开",
    startFrame: 18,
    endFrame: 23,
  },
  {
    id: "d.card-clears-slot",
    meaning: "小卡沿左上浅弧离槽，空槽成为可追踪关系",
    startFrame: 23,
    endFrame: 40,
  },
  {
    id: "d.primary-conclusion-takeover",
    meaning: "信号强在小卡仍运动时接管前景",
    startFrame: 28,
    endFrame: 49,
  },
  {
    id: "d.secondary-conclusion-settle",
    meaning: "不等号与质量好完成两行结论",
    startFrame: 43,
    endFrame: 61,
  },
  {
    id: "d.shared-retreat",
    meaning: "物体与主读共同退远并收势",
    startFrame: 61,
    endFrame: 87,
  },
  {
    id: "d.reading-hold",
    meaning: "结论、空槽与字幕稳定阅读",
    startFrame: 87,
    endFrame: 109,
  },
];

export default function DSimConclusion(props: DSimConclusionProps) {
  const frame = useCurrentFrame();
  const sceneTray = trayAt(Math.max(frame, 18));
  const card = cardAt(frame);

  const initialTray = trayAt(18);
  const worldFocus = pointOnTray(initialTray, 260, 285);
  const cameraProgress = smooth(frame, 0, 18);
  const cameraScale = mix(3.85, 1, cameraProgress);
  const cameraFocus = {
    x: mix(W / 2, worldFocus.x, cameraProgress),
    y: mix(H / 2, worldFocus.y, cameraProgress),
  };
  const cameraTransform = [
    `translate(${cameraFocus.x} ${cameraFocus.y})`,
    `scale(${cameraScale})`,
    `translate(${-worldFocus.x} ${-worldFocus.y})`,
  ].join(" ");

  /* C→D 只使用这一条窄金色几何锚点；不读取 C 的任何素材。 */
  const entryOpen = interpolate(frame, [0, 8, 12], [0, 0.82, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const clipWidth = mix(28, W, entryOpen);
  const clipHeight = mix(254, H, entryOpen);
  const clipX = (W - clipWidth) / 2;
  const clipY = (H - clipHeight) / 2;
  const clipRadius = mix(18, 0, entryOpen);

  const primaryProgress = interpolate(frame, [28, 43, 49], [0, 0.8, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const secondaryProgress = smooth(frame, 43, 61);
  const commonRetreat = mix(1, 0.97, smooth(frame, 61, 87));

  const primaryX = mix(-185, 55, primaryProgress);
  const primaryY = mix(1058, 785, primaryProgress);
  const primaryRotation = mix(-9, -2, primaryProgress);

  const secondaryX = mix(22, 55, secondaryProgress);
  const secondaryY = mix(1082, 925, secondaryProgress);
  const secondaryRotation = mix(-5, 0, secondaryProgress);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.dark,
        overflow: "hidden",
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id="d-bg-light" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={COLORS.lit} stopOpacity={0.92} />
            <stop offset="68%" stopColor={COLORS.dark} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="d-tray-face" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#F0F3E9" />
            <stop offset="42%" stopColor={COLORS.silver} />
            <stop offset="100%" stopColor="#8E978E" />
          </linearGradient>
          <linearGradient id="d-slot-face" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#424B44" />
            <stop offset="55%" stopColor={COLORS.traySlot} />
            <stop offset="100%" stopColor="#07100C" />
          </linearGradient>
          <linearGradient id="d-card-face" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FBFCF4" />
            <stop offset="50%" stopColor="#D7DCCF" />
            <stop offset="100%" stopColor="#AAB3A8" />
          </linearGradient>
          <linearGradient id="d-chip-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FFF0B2" />
            <stop offset="40%" stopColor={COLORS.gold} />
            <stop offset="100%" stopColor="#B88B39" />
          </linearGradient>
          <clipPath id="d-entry-clip">
            <rect
              x={clipX}
              y={clipY}
              width={clipWidth}
              height={clipHeight}
              rx={clipRadius}
            />
          </clipPath>
        </defs>

        <rect width={W} height={H} fill={COLORS.dark} />
        <rect width={W} height={H} fill="url(#d-bg-light)" />

        <g clipPath="url(#d-entry-clip)">
          {/* 同一世界坐标：微距与拉远不替换托卡或小卡。 */}
          <g transform={cameraTransform}>
            <SimTray tray={sceneTray} frame={frame} />
            <SimCard card={card} />
          </g>
        </g>
      </svg>

      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: W,
          height: H,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: primaryX,
            top: primaryY,
            color: COLORS.mint,
            fontFamily: FONT_STACK,
            fontSize: 112,
            fontWeight: 900,
            lineHeight: 0.95,
            letterSpacing: "-6px",
            transform: `rotate(${primaryRotation}deg) scale(${commonRetreat}) scaleX(1.16)`,
            transformOrigin: "left top",
            opacity: clamp(primaryProgress * 1.2),
            whiteSpace: "nowrap",
          }}
        >
          {props.primaryText}
        </div>

        <div
          style={{
            position: "absolute",
            left: secondaryX,
            top: secondaryY,
            fontFamily: FONT_STACK,
            fontSize: 118,
            fontWeight: 900,
            lineHeight: 0.95,
            letterSpacing: "-5px",
            transform: `rotate(${secondaryRotation}deg) scale(${commonRetreat}) scaleX(1.16)`,
            transformOrigin: "left top",
            opacity: secondaryProgress,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{color: COLORS.mint}}>{props.inequalityText}</span>
          <span style={{color: COLORS.warmWhite}}>{props.secondaryText}</span>
        </div>

        {/* 独立于主读的字幕预览层；正式 Caption Program 建立后关闭。 */}
        {props.renderCaption ? (
          <CaptionOverlay frame={frame} cue={props.captionCue} />
        ) : null}
      </div>
    </AbsoluteFill>
  );
}
