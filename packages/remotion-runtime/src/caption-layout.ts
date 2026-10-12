import { captionBoxWidthPercent } from "../../contracts/src/caption-presentation.js";
import type { CaptionFormat } from "@videocut/contracts";

/**
 * 字幕的最终可见行数必须由 Renderer 明确控制，不能交给浏览器的默认换行。
 * Node 侧只有保守的排版预算；真正的字体宽度始终在 Remotion/Chromium 中测量。
 */
export const CAPTION_LAYOUT_OVERFLOW = "CAPTION_LAYOUT_OVERFLOW";
export const CAPTION_FONT_FAMILY = "Inter, Noto Sans SC, sans-serif";
export const CAPTION_LINE_HEIGHT = 1.36;
export const CAPTION_BACKGROUND_HORIZONTAL_PADDING_EM = 0.64;
export const CAPTION_BACKGROUND_VERTICAL_PADDING_EM = 0.26;

export const DEFAULT_RENDER_CAPTION_FORMAT = {
  fontSize: 32,
  fontWeight: 750,
  color: "#ffffff",
  bottomPercent: 7,
  horizontalInsetPercent: 8,
  textAlign: "center"
} satisfies CaptionFormat;

export interface CaptionLayoutInput {
  text: string;
  compositionWidth: number;
  compositionHeight?: number;
  format?: Partial<CaptionFormat>;
  /** 强调的视觉缩放会放大实际字形，布局必须预留这一部分宽度。 */
  emphasisScale?: number;
  emphasisFontWeight?: number;
  /** 全片规范固定预留行数；历史字幕仍按实际行数占位。 */
  fixedLineCount?: boolean;
}

export interface ResolvedCaptionLayoutInput {
  text: string;
  compositionWidth: number;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  fontStyle: string;
  lineHeight: number;
  maxLineWidth: number;
  hasBackground: boolean;
  maxLines: 1 | 2;
  paddingHorizontal: number;
  paddingVertical: number;
}

export type CaptionLayoutResult = {
  ready: true;
  /** Renderer 只消费这一到两条显式行，绝不允许浏览器继续自动折行。 */
  lines: [string] | [string, string];
  measurement: "browser" | "conservative";
} | {
  ready: false;
  code: typeof CAPTION_LAYOUT_OVERFLOW;
  /** 仅用于诊断，不作为稳定对外错误合同。 */
  reason: "TEXT_EMPTY" | "EXPLICIT_LINE_COUNT" | "LINE_TOO_WIDE" | "TWO_LINES_INSUFFICIENT" | "BROWSER_METRICS_UNAVAILABLE" | "CANVAS_VERTICAL_OVERFLOW";
  measurement: "browser" | "conservative";
};

export type CaptionTextMeasure = (text: string) => number;

/** Canvas 字体声明由正式 Renderer 和 Node 发起的浏览器测量共用。 */
export const captionCanvasFont = (input: ResolvedCaptionLayoutInput): string =>
  `${input.fontStyle} ${input.fontWeight} ${input.fontSize}px ${input.fontFamily}`;

/**
 * 这个输入归一化在质量系统和 Renderer 之间共享：两边必须用同一字幕框宽度、字号和底板内边距。
 * 不允许因 Renderer 的底板 padding 把 Node 的“通过”变成实际画面的水平溢出。
 */
export function resolveCaptionLayoutInput(input: CaptionLayoutInput): ResolvedCaptionLayoutInput | undefined {
  const format = { ...DEFAULT_RENDER_CAPTION_FORMAT, ...input.format };
  const emphasisScale = Number.isFinite(input.emphasisScale) ? Math.max(1, input.emphasisScale ?? 1) : 1;
  const fontSize = format.fontSize * emphasisScale;
  const fontWeight = Math.max(format.fontWeight, input.emphasisFontWeight ?? format.fontWeight);
  const hasBackground = Boolean(format.backgroundColor);
  const boxWidth = input.compositionWidth * captionBoxWidthPercent(format) / 100;
  const paddingHorizontal = format.paddingHorizontal ?? (hasBackground ? fontSize * CAPTION_BACKGROUND_HORIZONTAL_PADDING_EM / 2 : 0);
  const paddingVertical = format.paddingVertical ?? (hasBackground ? fontSize * CAPTION_BACKGROUND_VERTICAL_PADDING_EM / 2 : 0);
  const maxLineWidth = boxWidth - 2 * paddingHorizontal;
  if (!Number.isFinite(input.compositionWidth) || input.compositionWidth <= 0
    || !Number.isFinite(fontSize) || fontSize <= 0
    || !Number.isFinite(fontWeight) || fontWeight <= 0
    || !Number.isFinite(maxLineWidth) || maxLineWidth <= 0) return undefined;
  return {
    text: input.text.replace(/\r\n?/gu, "\n"),
    compositionWidth: input.compositionWidth,
    fontSize,
    fontWeight,
    fontFamily: format.font?.family ?? CAPTION_FONT_FAMILY,
    fontStyle: format.font?.style ?? "normal",
    lineHeight: format.lineHeight ?? CAPTION_LINE_HEIGHT,
    maxLineWidth,
    hasBackground,
    maxLines: format.maxLines ?? 2,
    paddingHorizontal,
    paddingVertical
  };
}

/** 与字宽同次核对画布边缘，不把可自由定位解释成可以越出画面。 */
export function layoutCaptionWithMeasure(input: CaptionLayoutInput, measure: CaptionTextMeasure, measurement: CaptionLayoutResult["measurement"]): CaptionLayoutResult {
  const layout = layoutCaptionRowsWithMeasure(input, measure, measurement);
  if (!layout.ready || input.compositionHeight === undefined) return layout;
  const format = { ...DEFAULT_RENDER_CAPTION_FORMAT, ...input.format };
  const resolved = resolveCaptionLayoutInput(input)!;
  const height = resolved.fontSize * resolved.lineHeight * (input.fixedLineCount ? resolved.maxLines : layout.lines.length) + resolved.paddingVertical * 2;
  const top = format.placement ? input.compositionHeight * format.placement.topPercent / 100 : input.compositionHeight * (1 - format.bottomPercent / 100) - height;
  return top < 0 || top + height > input.compositionHeight ? { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "CANVAS_VERTICAL_OVERFLOW", measurement } : layout;
}

const splitGraphemes = (text: string): string[] => {
  // Node 22 与 Chromium 都支持 Intl.Segmenter；回退不能把代理对拆开。
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
  }
  return Array.from(text);
};

const isWhitespace = (value: string) => /^\s$/u.test(value);
const isOpeningPunctuation = (value: string) => /^[\(\[\{（［｛〈《「『【〔“‘]$/u.test(value);
const isClosingPunctuation = (value: string) => /^[\)\]\}）］｝〉》」』】〕，。！？、；：”’]$/u.test(value);
const isCjkGrapheme = (value: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);

/**
 * 允许的换行点以自然语言为先：空白和标点优先，中文可在字间换行；不会把拉丁单词拆半，
 * 也不让下一行以闭合标点开头或上一行以开括号结束。
 */
function canBreakBetween(left: string, right: string): boolean {
  if (!left || !right || isOpeningPunctuation(left) || isClosingPunctuation(right)) return false;
  if (isWhitespace(left) || isWhitespace(right) || isClosingPunctuation(left)) return true;
  return isCjkGrapheme(left) && isCjkGrapheme(right);
}

function trimLineForDisplay(value: string): string {
  return value.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** 一次收集分行算法可能测量的完整字符串，保留字偶距和组合字形，不能逐字相加。 */
export function captionMeasurementTexts(input: CaptionLayoutInput): string[] {
  const resolved = resolveCaptionLayoutInput(input);
  if (!resolved) return [];
  const lines = resolved.text.split("\n");
  const texts = new Set(lines);
  if (lines.length === 1) {
    const graphemes = splitGraphemes(lines[0]!);
    for (let index = 1; index < graphemes.length; index += 1) {
      if (!canBreakBetween(graphemes[index - 1]!, graphemes[index]!)) continue;
      texts.add(trimLineForDisplay(graphemes.slice(0, index).join("")));
      texts.add(trimLineForDisplay(graphemes.slice(index).join("")));
    }
  }
  return [...texts];
}

/**
 * 根据注入的真实或保守测量函数，选择一行或两行。该函数不接触 DOM，因此可在 Node 单元测试中
 * 验证分行合同；只有 measure 的来源决定它是浏览器实测还是保守预算。
 */
function layoutCaptionRowsWithMeasure(
  input: CaptionLayoutInput,
  measure: CaptionTextMeasure,
  measurement: CaptionLayoutResult["measurement"]
): CaptionLayoutResult {
  const resolved = resolveCaptionLayoutInput(input);
  if (!resolved || !resolved.text.trim()) {
    return { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "TEXT_EMPTY", measurement };
  }
  const explicitLines = resolved.text.split("\n");
  if (explicitLines.length > resolved.maxLines) {
    return { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "EXPLICIT_LINE_COUNT", measurement };
  }
  if (explicitLines.some((line) => measure(line) > resolved.maxLineWidth)) {
    // 手工换行已经明确表达了编辑意图；不擅自重排，更不能交给浏览器继续折第三行。
    if (explicitLines.length === 2) {
      return { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "LINE_TOO_WIDE", measurement };
    }
  } else if (explicitLines.length === 2) {
    return { ready: true, lines: [explicitLines[0]!, explicitLines[1]!], measurement };
  }

  const text = explicitLines[0]!;
  if (measure(text) <= resolved.maxLineWidth) {
    return { ready: true, lines: [text], measurement };
  }
  // 单行规范不缩字号或挤字；由字幕作者按可靠时间重新分卡。
  if (resolved.maxLines === 1) return { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "LINE_TOO_WIDE", measurement };
  const graphemes = splitGraphemes(text);
  if (graphemes.length < 2) {
    return { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "LINE_TOO_WIDE", measurement };
  }

  let best: { lines: [string, string]; naturalBreakPenalty: number; imbalance: number } | undefined;
  for (let index = 1; index < graphemes.length; index += 1) {
    const leftGrapheme = graphemes[index - 1]!;
    const rightGrapheme = graphemes[index]!;
    if (!canBreakBetween(leftGrapheme, rightGrapheme)) continue;
    const first = trimLineForDisplay(graphemes.slice(0, index).join(""));
    const second = trimLineForDisplay(graphemes.slice(index).join(""));
    if (!first || !second) continue;
    const firstWidth = measure(first);
    const secondWidth = measure(second);
    if (firstWidth > resolved.maxLineWidth || secondWidth > resolved.maxLineWidth) continue;
    // 能落在空白或句读后时，优先保护自然语义边界；只有没有这类可行点才退回中文字符间换行。
    const naturalBreakPenalty = isWhitespace(leftGrapheme) || isClosingPunctuation(leftGrapheme) ? 0 : 1;
    const imbalance = Math.abs(firstWidth - secondWidth);
    if (!best || naturalBreakPenalty < best.naturalBreakPenalty
      || (naturalBreakPenalty === best.naturalBreakPenalty && imbalance < best.imbalance)) {
      best = { lines: [first, second], naturalBreakPenalty, imbalance };
    }
  }
  return best
    ? { ready: true, lines: best.lines, measurement }
    : { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "TWO_LINES_INSUFFICIENT", measurement };
}

/**
 * 只在 Remotion/浏览器里调用。Canvas 与实际 CSS 使用同一个字体栈、字号、字重和字幕框宽度；
 * 这不是在 Node 中猜测字体字宽。Renderer 后续还会读取真实 DOM 的 scrollWidth 作最终保护。
 */
export function layoutCaptionInBrowser(input: CaptionLayoutInput): CaptionLayoutResult {
  if (typeof document === "undefined") {
    return { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "BROWSER_METRICS_UNAVAILABLE", measurement: "browser" };
  }
  const resolved = resolveCaptionLayoutInput(input);
  if (!resolved) return { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "TEXT_EMPTY", measurement: "browser" };
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "BROWSER_METRICS_UNAVAILABLE", measurement: "browser" };
  context.font = captionCanvasFont(resolved);
  return layoutCaptionWithMeasure(input, (text) => context.measureText(text).width, "browser");
}

/**
 * 仅用于无浏览器的静态预算。上界超限不能证明真实溢出，正式质量报告和交付门禁必须实测。
 */
export function layoutCaptionConservatively(input: CaptionLayoutInput): CaptionLayoutResult {
  const resolved = resolveCaptionLayoutInput(input);
  if (!resolved) return { ready: false, code: CAPTION_LAYOUT_OVERFLOW, reason: "TEXT_EMPTY", measurement: "conservative" };
  const measure = (text: string) => splitGraphemes(text).reduce((total, grapheme) => {
    if (isWhitespace(grapheme)) return total + resolved.fontSize * 0.55;
    // 这是上界预算而不是字体测量：1.25em 为中日韩字、拉丁大写和常见 emoji 留出余量。
    return total + resolved.fontSize * 1.25;
  }, 0);
  return layoutCaptionWithMeasure(input, measure, "conservative");
}

export class CaptionLayoutError extends Error {
  readonly code = CAPTION_LAYOUT_OVERFLOW;

  constructor(reason: string) {
    super(`${CAPTION_LAYOUT_OVERFLOW}: ${reason}`);
    this.name = "CaptionLayoutError";
  }
}

export class CaptionTimelineOverlapError extends Error {
  readonly code = "CAPTION_TIMELINE_OVERLAP";

  constructor() {
    super("CAPTION_TIMELINE_OVERLAP: 同一帧存在多条字幕，Renderer 不会猜测或叠加显示。");
    this.name = "CaptionTimelineOverlapError";
  }
}
