import puppeteer from "puppeteer-core";
import { DomainError } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import { resolveRenderBrowser } from "../../remotion-runtime/src/browser.js";
import type { CaptionFormat } from "@videocut/contracts";
import { bindMotionFonts, readMotionFontFile } from "../../motion-work/src/fonts.js";
import { captionCanvasFont, captionMeasurementTexts, layoutCaptionWithMeasure, resolveCaptionLayoutInput, type CaptionLayoutInput, type CaptionLayoutResult } from "../../remotion-runtime/src/caption-layout.js";

export interface CaptionMeasurementRequest { font: string; texts: string[]; registeredFont?: CaptionFormat["font"]; }

/** 浏览器只接收字体声明与纯文本，不接受代码、资源路径或浏览器配置。 */
export async function measureCaptionTextInBrowser(requests: CaptionMeasurementRequest[]): Promise<number[][]> {
  if (requests.length === 0) return [];
  // 只从登记库读取身份固定的原件；调用方不能传任意 URL、系统路径或字体字节。
  const fonts = new Map<string, { dataUrl: string; identity: string; binding: NonNullable<CaptionFormat["font"]> }>();
  for (const request of requests) {
    const binding = request.registeredFont;
    if (!binding) continue;
    if (binding.family !== `VFC_${binding.hash}`) throw new DomainError("CAPTION_FONT_BINDING_INVALID: 字体 family 与固定身份不符", "CAPTION_FONT_BINDING_INVALID");
    const identity = JSON.stringify([binding.fontId, binding.hash, binding.family, binding.weight, binding.style]);
    let preparedFont = fonts.get(binding.hash);
    if (preparedFont && preparedFont.identity !== identity) throw new DomainError("CAPTION_FONT_BINDING_INVALID: 同一字体字节的绑定身份冲突", "CAPTION_FONT_BINDING_INVALID");
    if (!preparedFont) {
      const fixed = bindMotionFonts({ fontBindings: { caption: binding.fontId } })[0]!;
      if (fixed.hash !== binding.hash || fixed.family !== binding.family || fixed.weight !== binding.weight || fixed.style !== binding.style) {
        throw new DomainError("CAPTION_FONT_BINDING_INVALID: 字体身份与登记原件不符", "CAPTION_FONT_BINDING_INVALID");
      }
      const file = readMotionFontFile(binding.fontId, binding.hash);
      preparedFont = { dataUrl: `data:${file.contentType};base64,${file.bytes.toString("base64")}`, identity, binding };
      fonts.set(binding.hash, preparedFont);
    }
  }
  const browser = await puppeteer.launch({
    executablePath: await resolveRenderBrowser(), headless: true, pipe: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"],
    timeout: 30_000, protocolTimeout: 30_000
  });
  try {
    const page = await browser.newPage();
    // 字体原件在跨进程传输前去重；否则整片每卡都会重复序列化数MB字体，引发协议/HTTP超时。
    return await page.evaluate(async ({ batch, fontFiles }) => {
      for (const { binding, dataUrl } of fontFiles) {
        const face = new FontFace(binding.family, `url("${dataUrl}")`, { weight: String(binding.weight), style: binding.style });
        await face.load();
        document.fonts.add(face);
      }
      await document.fonts.ready;
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("字幕 Canvas 字宽测量不可用");
      return batch.map((request) => {
        context.font = request.font;
        return request.texts.map((text) => context.measureText(text).width);
      });
    }, { batch: requests, fontFiles: [...fonts.values()].map(({ binding, dataUrl }) => ({ binding, dataUrl })) });
  } finally {
    await browser.close();
  }
}

/** 独立 MCP 不拥有浏览器依赖；复用同版 Runtime，失败或错版均不自动重试。 */
export async function measureCaptionTextViaRuntime(requests: CaptionMeasurementRequest[], config = readRuntimeConfig()): Promise<number[][]> {
  const response = await fetch(new URL("/api/captions/measure-text", config.http.webOrigin), {
    method: "POST", headers: { "content-type": "application/json", "x-videoflowcut-release-id": config.runtime.releaseId },
    body: JSON.stringify(requests), redirect: "error", signal: AbortSignal.timeout(60_000)
  });
  const value = await response.json();
  if (!response.ok) throw new DomainError(value.message ?? `字幕测量失败（HTTP ${response.status}）`, value.error ?? "CAPTION_LAYOUT_MEASUREMENT_UNAVAILABLE");
  if (response.headers.get("x-videoflowcut-release-id") !== config.runtime.releaseId) {
    throw new DomainError("字幕测量 Runtime 版本与当前 MCP 不一致", "RUNTIME_RELEASE_MISMATCH");
  }
  if (!Array.isArray(value) || value.length !== requests.length || value.some((row, index) => !Array.isArray(row)
    || row.length !== requests[index]!.texts.length || row.some(width => typeof width !== "number" || !Number.isFinite(width) || width < 0))) {
    throw new DomainError("Runtime 未返回完整有效的字幕字宽", "CAPTION_LAYOUT_MEASUREMENT_UNAVAILABLE");
  }
  return value;
}

/** 全轨一次批量实测，随后关闭浏览器；不创建 Job、缓存文件或视频 Revision。 */
export async function measureCaptionLayouts(inputs: CaptionLayoutInput[]): Promise<CaptionLayoutResult[]> {
  if (inputs.length === 0) return [];
  const requests = inputs.map((input) => {
    if (input.format?.fontId && input.format.font?.fontId !== input.format.fontId) throw new Error("CAPTION_FONT_BINDING_INVALID: 字体选择缺少固定绑定");
    const resolved = resolveCaptionLayoutInput(input);
    return { font: resolved ? captionCanvasFont(resolved) : "normal 400 16px sans-serif", texts: captionMeasurementTexts(input), registeredFont: input.format?.font };
  });
  const config = readRuntimeConfig();
  const widths = config.runtime.distributionDirectory && !config.runtime.browserExecutable
    ? await measureCaptionTextViaRuntime(requests, config)
    : await measureCaptionTextInBrowser(requests);
  return inputs.map((input, index) => {
      const measured = new Map(requests[index]!.texts.map((text, offset) => [text, widths[index]![offset]!]));
      return layoutCaptionWithMeasure(input, (text) => {
        const width = measured.get(text);
        if (width === undefined || !Number.isFinite(width)) throw new Error("字幕字宽测量结果不完整");
        return width;
      }, "browser");
  });
}
