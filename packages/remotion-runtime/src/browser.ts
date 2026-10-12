import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ensureBrowser } from "@remotion/renderer";
import { DomainError } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";

/** 渲染与字幕测量复用同一已部署浏览器；发行环境不能在检查时临时下载依赖。 */
export async function resolveRenderBrowser(): Promise<string> {
  const config = readRuntimeConfig().runtime;
  const browserExecutable = config.browserExecutable;
  if (config.distributionDirectory && !browserExecutable) {
    throw new DomainError("发行 Runtime 缺少部署前准备的浏览器路径", "RENDER_BROWSER_NOT_PREPARED");
  }
  if (browserExecutable && (!isAbsolute(browserExecutable) || !existsSync(browserExecutable))) {
    throw new DomainError("已配置的渲染浏览器路径无效，必须重新准备部署依赖", "RENDER_BROWSER_NOT_PREPARED");
  }
  const browser = await ensureBrowser({ browserExecutable, logLevel: "error" });
  if (!("path" in browser)) throw new DomainError("渲染浏览器未就绪", "RENDER_BROWSER_NOT_PREPARED");
  return browser.path;
}
