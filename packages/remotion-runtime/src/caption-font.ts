import type { CaptionFormat } from "@videocut/contracts";

type CaptionFont = NonNullable<CaptionFormat["font"]>;
const loadedFonts = new Map<string, Promise<void>>();
const readyFonts = new Set<string>();
const fontUrl = (font: CaptionFont, mediaBaseUrl: string) => `${mediaBaseUrl.replace(/\/$/u, "")}/api/motion/fonts/${encodeURIComponent(font.fontId)}/file?sha256=${font.hash}`;

/** 字幕空档后重新入场时直接复用已加载字形，避免先空白一帧再等待微任务。 */
export function captionFontIsLoaded(font: CaptionFont, mediaBaseUrl: string): boolean {
  return readyFonts.has(fontUrl(font, mediaBaseUrl));
}

/** 与受管动效共用登记身份和文件路由；加载失败明确失败，绝不静默换系统字体。 */
export function loadCaptionFont(font: CaptionFont, mediaBaseUrl: string): Promise<void> {
  const url = fontUrl(font, mediaBaseUrl);
  let pending = loadedFonts.get(url);
  if (!pending) {
    pending = (async () => {
      const face = new FontFace(font.family, `url("${url}")`, { weight: String(font.weight), style: font.style });
      await face.load();
      document.fonts.add(face);
      await document.fonts.load(`${font.style} ${font.weight} 32px "${font.family}"`);
      if (!document.fonts.check(`${font.style} ${font.weight} 32px "${font.family}"`)) throw new Error("字体载入后不可用");
      readyFonts.add(url);
    })().catch((error: unknown) => {
      loadedFonts.delete(url);
      throw new Error(`CAPTION_FONT_LOAD_FAILED: ${font.fontId}；${String(error)}`);
    });
    loadedFonts.set(url, pending);
  }
  return pending;
}
