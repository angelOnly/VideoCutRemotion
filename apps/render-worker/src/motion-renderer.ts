import { MotionDiagnostics } from "./motion-diagnostics.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { PNG } from "pngjs";
import { compileMotion, MOTION_ENGINE_VERSION } from "../../../packages/motion-work/src/compiler.js";
import type { MotionVideoProvider, MotionSubmission } from "../../../packages/motion-work/src/schema.js";
import { readRuntimeConfig } from "@videocut/project-overview";
import { resolveRenderBrowser } from "./exporter.js";
import { runProcess } from "@videocut/speech";
import { parseMotionEvents } from "../../../packages/motion-work/src/schema.js";
import type { MotionEvent } from "@videocut/contracts";
import { verifyMotionDeterminism, type MotionDeterminismReport } from "./motion-determinism.js";
import { checkMotionDiskSpace, checkMotionOutputBudget, motionOutputBudget } from "./motion-output-budget.js";
import { runMotionProcess } from "./motion-process.js";
import type { PreparedMotionFont } from "../../../packages/motion-work/src/fonts.js";

export interface MotionRenderResult { frameHashes: string[]; previewPath: string; engineVersion: string; sandbox: string; events?: MotionEvent[]; determinism?: MotionDeterminismReport; }

/** 失败关闭也有限时；否则导航已超时却被finally的关闭等待拖住。 */
export async function closeMotionBrowser(browser: Pick<Browser, "close" | "process">, diagnostics: MotionDiagnostics, timeoutMs = 3000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([browser.close(), new Promise<void>(resolve => {
      timer = setTimeout(() => {
        diagnostics.event("browser_close_timeout");
        diagnostics.terminate("close_timeout"); browser.process()?.kill(); resolve();
      }, timeoutMs);
    })]);
  } catch (error) { diagnostics.additional(error, "browser_close"); browser.process()?.kill(); }
  finally { if (timer) clearTimeout(timer); }
}

export const motionFrameName = (frame: number) => `frame-${String(frame).padStart(5, "0")}.png`;

/** 仅允许本件已校验字体的准确hash与格式，不开放路径或外部资源。 */
export function resolveMotionFontRequest(url: string, fonts: PreparedMotionFont[]) {
  const match = /^https:\/\/motion\.invalid\/fonts\/([a-f0-9]{64})\.(otf|ttf)$/u.exec(url);
  return match ? fonts.find(font => font.binding.hash === match[1] && font.format === match[2]) : undefined;
}

/** 初始化超时与字体解码错误分别报告；浏览器异常不能被当作就绪。 */
export async function waitMotionStartup(page: Pick<Page, "waitForFunction" | "evaluate">, hasFonts: boolean): Promise<void> {
  try { await page.waitForFunction("window.__motionReady === true || !!window.__motionError", { timeout: 15_000 }); }
  catch (error) { if (hasFonts && error instanceof Error && error.name === "TimeoutError") throw new Error("MOTION_FONT_LOAD_TIMEOUT: 字体或动画初始化超时", { cause: error }); throw error; }
  const error = await page.evaluate(() => (window as unknown as { __motionError?: string }).__motionError);
  if (error) throw new Error(error);
}

/** Chromium 会省略全不透明帧的 Alpha；入库前固定 RGBA，避免后续像素步长与滤镜状态跳变。 */
export function normalizeMotionPng(png: Buffer, width: number, height: number): Buffer {
  const decoded = PNG.sync.read(png);
  if (decoded.width !== width || decoded.height !== height) throw new Error("MOTION_OUTPUT_MISMATCH: PNG 画幅不匹配");
  // RLE 和最小残差滤波未必适合渐变；比较两种无损编码，保留 RGBA 与原缓存限额。
  const options = { colorType: 6, inputColorType: 6, bitDepth: 8, deflateLevel: 6, deflateStrategy: 0 } as const;
  const filtered = PNG.sync.write(decoded, options);
  const unfiltered = PNG.sync.write(decoded, { ...options, filterType: 0 });
  return unfiltered.length < filtered.length ? unfiltered : filtered;
}

/** 时长近似不能证明逐帧完整；审阅代理也必须与透明作品一帧不差。 */
export async function verifyMotionPreviewFrames(path: string, frameCount: number, fps: number): Promise<void> {
  const result = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,avg_frame_rate", "-of", "json", path]));
  const stream = result.streams?.[0];
  const rate = String(stream?.avg_frame_rate).split("/").map(Number);
  if (Number(stream?.nb_read_frames) !== frameCount || rate[0] / rate[1] !== fps) {
    throw new Error(`MOTION_OUTPUT_MISMATCH: 预期 ${frameCount} 帧 / ${fps} fps，实际 ${stream?.nb_read_frames ?? "未知"} 帧 / ${stream?.avg_frame_rate ?? "未知"}`);
  }
}

/**
 * 生成代码只在无凭据的独立 Chromium 中运行，不使用 Remotion 默认的 --no-sandbox。
 * 响应级 CSP sandbox 建立 opaque origin；所有网络请求由拦截器拒绝，只有唯一内存文档可加载。
 */
export async function renderManagedMotion(input: MotionSubmission, directory: string, imageData: Record<string, string> = {}, provider?: MotionVideoProvider, signal?: AbortSignal, fonts: PreparedMotionFont[] = [], diagnostics = new MotionDiagnostics({})): Promise<MotionRenderResult> {
  signal?.throwIfAborted();
  const limits = readRuntimeConfig().motion;
  const outputBudget = motionOutputBudget(input.width, input.height, input.durationInFrames);
  await mkdir(join(directory, "frames"), { recursive: true });
  await provider?.reserveDiskSpace(outputBudget * 2 + provider.workingSetBytes);
  const disk = await statfs(directory);
  checkMotionDiskSpace(disk.bavail * disk.bsize, outputBudget, outputBudget + (provider?.workingSetBytes ?? 0));
  const declarations = Object.entries(input.fontBindings ?? {});
  if (declarations.length !== fonts.length || fonts.some(font => input.fontBindings?.[font.binding.slot] !== font.binding.fontId)
    || new Set(fonts.map(font => font.binding.slot)).size !== fonts.length) throw new Error("MOTION_FONT_BINDING_MISMATCH");
  // 字体数据由Worker从发行目录校验后提供，CSS不接受源码给出的路径或URL。
  const fontCss = [...new Map(fonts.map(font => [font.binding.family, font])).values()].map(({ binding, dataUrl, format }) => {
    if (!["otf", "ttf"].includes(format) || !/^data:font\/(?:otf|ttf);base64,[A-Za-z0-9+/=]+$/u.test(dataUrl)
      || !dataUrl.startsWith(`data:font/${format};base64,`)) throw new Error("MOTION_FONT_FORMAT");
    return `@font-face{font-family:'${binding.family}';src:url('https://motion.invalid/fonts/${binding.hash}.${format}');font-weight:${binding.weight};font-style:${binding.style};font-display:block}`;
  }).join("");
  diagnostics.stage("source_compilation");
  const javascript = `window.addEventListener('securitypolicyviolation',e=>console.error('MOTION_CSP_VIOLATION:'+e.violatedDirective));\n${await compileMotion(input, imageData, provider?.videos, fonts.map(font => font.binding))}`.replace(/<\/script/giu, "<\\/script");
  const scriptHash = createHash("sha256").update(javascript).digest("base64");
  // Player 内部有 data: 静音音频探测；允许内嵌数据并不开放外部媒体或网络。
  const csp = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; img-src data: https://motion.invalid/video/; font-src https://motion.invalid/fonts/; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
  let allowedFrame = 0;
  // SVG 的 auto 字体模式会按缩放历史复用字形栅格；几何精度模式使文字按当前帧的变换绘制。
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:'Microsoft YaHei','Noto Sans SC',sans-serif}svg{text-rendering:geometricPrecision}</style></head><body><div id="root"></div><script>${javascript}</script></body></html>`;
  diagnostics.stage("browser_startup");
  const browser = await puppeteer.launch({
    executablePath: await resolveRenderBrowser(), headless: true, pipe: true,
    defaultViewport: { width: input.width, height: input.height, deviceScaleFactor: 1 },
    // 局部栅格重绘会让 SVG 曲线/虚线边缘受上一帧脏区影响；每帧完整重绘，保留原抗锯齿与沙箱。
    args: ["--disable-partial-raster", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--js-flags=--max-old-space-size=128"],
    timeout: 30_000
  });
  diagnostics.browser({ browserPid: browser.process()?.pid });
  browser.on("disconnected", () => { diagnostics.browser({ browserDisconnected: true }); diagnostics.event("browser_disconnected"); });
  const process = browser.process();
  process?.stderr?.on("data", chunk => diagnostics.browserStderr(String(chunk)));
  process?.on("error", error => diagnostics.additional(error, "browser_process"));
  process?.on("exit", (code, signal) => { diagnostics.browser({ browserExitCode: code, browserExitSignal: signal }); diagnostics.event("browser_exit", { code, signal }); });
  const forbiddenFlags = browser.process()?.spawnargs.filter((arg) => /--(?:no-sandbox|disable-setuid-sandbox|disable-web-security|single-process)/u.test(arg)) ?? [];

  const abort = () => { diagnostics.terminate("cancelled"); browser.process()?.kill(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const errors: string[] = [];
  try {
    diagnostics.browser({ browserVersion: await browser.version() });
    if (forbiddenFlags.length) throw new Error("MOTION_SANDBOX_DISABLED: 拒绝在降级的浏览器安全模式下执行代码");
    const page = await browser.newPage();
    page.on("error", error => diagnostics.additional(error, "page_crash"));
    page.on("close", () => diagnostics.event("page_close"));
    page.on("framedetached", frame => diagnostics.event("frame_detached", { main: frame === page.mainFrame() }));
    page.on("framenavigated", frame => diagnostics.event("frame_navigated", { main: frame === page.mainFrame() }));
    page.on("requestfailed", request => diagnostics.event("request_failed", { resourceType: request.resourceType(), reason: request.failure()?.errorText }));
    const requestError = (error: unknown) => { diagnostics.additional(error, "request_response"); errors.push(String(error)); };

    await page.setRequestInterception(true);
    let served = false;
    page.on("request", (request) => {
      if (!served && request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === "https://motion.invalid/") {
        served = true;
        void request.respond({ status: 200, headers: { "content-security-policy": csp, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: html }).catch(requestError);
      } else if (request.resourceType() === "font" && /^https:\/\/motion\.invalid\/fonts\/[a-f0-9]{64}\.(?:otf|ttf)$/u.test(request.url())) {
        // 字体按已验证hash单独响应，避免HTML再经CDP base64编码超过100MiB管道上限。
        const font = resolveMotionFontRequest(request.url(), fonts);
        if (!font) { errors.push("MOTION_FONT_BINDING_MISMATCH"); void request.abort().catch(requestError); return; }
        void request.respond({ status: 200, contentType: `font/${font.format}`, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, body: Buffer.from(font.dataUrl.split(",")[1], "base64") }).catch(requestError);
      } else if (request.resourceType() === "image" && provider && /^https:\/\/motion\.invalid\/video\/[a-z][A-Za-z0-9_]{0,39}\/\d+\.png$/u.test(request.url())) {
        // 只提供当前渲染帧的已绑定槽位；源码看不到原片路径或任意媒体请求能力。
        const match = /\/video\/([^/]+)\/(\d+)\.png$/u.exec(request.url())!;
        const frame = Number(match[2]);
        if (frame !== allowedFrame || !Object.hasOwn(provider.videos, match[1])) { errors.push("MOTION_VIDEO_RANGE"); void request.abort().catch(requestError); return; }
        void provider.getFrame(match[1], frame).then(body => request.respond({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, body })).catch(error => { requestError(error); void request.abort().catch(requestError); });
      } else if (request.url().startsWith("data:") && ["image", "font", "media"].includes(request.resourceType())) void request.continue().catch(requestError);
      else { errors.push(`MOTION_NETWORK_BLOCKED: ${request.resourceType()}`); void request.abort("blockedbyclient").catch(requestError); }
    });
    page.on("pageerror", (error) => { diagnostics.additional(error, "page_error"); errors.push(String(error)); });
    page.on("console", (message) => { if (message.type() === "error") diagnostics.event("console_error", { message: message.text().slice(0, 2000) }); if (message.text().startsWith("MOTION_CSP_VIOLATION:")) errors.push(message.text()); });
    page.on("popup", (popup) => { errors.push("MOTION_POPUP_BLOCKED"); void popup?.close().catch(requestError); });
    diagnostics.stage("page_navigation", { documentBytes: Buffer.byteLength(html) });
    await page.goto("https://motion.invalid/", { waitUntil: "load", timeout: 15_000 });
    diagnostics.stage("animation_initialization");
    await waitMotionStartup(page, fonts.length > 0);
    const readEvents = () => page.evaluate(() => (window as unknown as { __readMotionEvents: () => unknown }).__readMotionEvents());
    const rawEvents = await readEvents();
    const events = rawEvents === null ? undefined : parseMotionEvents(rawEvents, input.durationInFrames);
    const frameHashes: string[] = [];
    let totalBytes = 0;
    const capture = async (frame: number) => {
      signal?.throwIfAborted();
      allowedFrame = frame;
      diagnostics.frame(frame, "seek_and_image_decode");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            await page.evaluate(async (value) => {
              await (window as unknown as { __motionSeek: (frame: number) => Promise<void> }).__motionSeek(value);
              // 半透明变换图层的增删会复用不同的文字阴影绘制状态；每帧重建布局，保留 React 状态以继续检出真实副作用。
              document.body.style.display = "none";
              void document.body.offsetHeight;
              document.body.style.removeProperty("display");
              void document.body.offsetHeight;
              await Promise.all(Array.from(document.images).map((image) => image.decode()));
            }, frame);
            if (errors.length) throw new Error(errors.slice(0, 3).join("; "));
            diagnostics.frame(frame, "screenshot");
            const png = Buffer.from(await page.screenshot({ type: "png", omitBackground: true, captureBeyondViewport: false }));
            diagnostics.frame(frame, "png_normalization");
            return normalizeMotionPng(png, input.width, input.height);
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { diagnostics.terminate("frame_timeout"); browser.process()?.kill(); reject(new Error("MOTION_FRAME_TIMEOUT")); }, limits.frameTimeoutMs); })
        ]);
      } finally { if (timer) clearTimeout(timer); }
    };
    diagnostics.stage("frame_rendering");
    for (let frame = 0; frame < input.durationInFrames; frame++) {
      const png = await capture(frame);
      totalBytes += png.length;
      checkMotionOutputBudget(totalBytes, outputBudget);
      frameHashes.push(createHash("sha256").update(png).digest("hex"));
      diagnostics.frame(frame, "frame_write");
      await writeFile(join(directory, "frames", motionFrameName(frame)), png, { flag: "wx" });
      diagnostics.progress(frame);
      await provider?.releaseBefore(frame + 1);
      if (frame % input.fps === 0) {
        const available = await statfs(directory);
        if (available.bavail * available.bsize < limits.diskReserveBytes) throw new Error("MOTION_DISK_SPACE: 渲染中磁盘安全余量不足");
      }
    }
    diagnostics.stage("determinism_verification");
    const determinism = await verifyMotionDeterminism(directory, frameHashes, capture);
    if (JSON.stringify(await readEvents()) !== JSON.stringify(rawEvents)) throw new Error("MOTION_EVENT_NONDETERMINISTIC: 事件计算依赖渲染副作用");
    diagnostics.terminate("normal_cleanup");
    await closeMotionBrowser(browser, diagnostics);
    const previewPath = join(directory, "preview.mp4");
    // 只有审阅代理使用背景；正式合成始终读取带 Alpha 的 PNG 帧，不烧入棋盘格或安全区。
    // 输入已是同格式 RGBA；不能禁用滤镜重建后假设 format 滤镜会修正 RGB/RGBA 的步长。
    diagnostics.stage("preview_encoding");
    await runMotionProcess("ffmpeg", ["-y", "-v", "error", "-progress", "pipe:1", "-framerate", String(input.fps), "-i", join(directory, "frames", "frame-%05d.png"), "-f", "lavfi", "-i", `color=c=0x172033:s=${input.width}x${input.height}:r=${input.fps}`, "-filter_complex", "[0:v]format=rgba[fg];[1:v][fg]overlay=shortest=1:format=auto,format=yuv420p", "-frames:v", String(input.durationInFrames), "-an", "-c:v", "libx264", "-crf", "18", previewPath], signal, 120_000, diagnostics);
    await readFile(previewPath); // ffmpeg 返回成功还必须有真实输出。
    diagnostics.stage("output_validation");
    await verifyMotionPreviewFrames(previewPath, input.durationInFrames, input.fps);
    return { frameHashes, previewPath, engineVersion: MOTION_ENGINE_VERSION, sandbox: "chromium-os-sandbox+csp-opaque-origin+deny-network", events, determinism };
  } catch (error) {
    // 清理和页面附加错误不能抹掉第一条异常与原始堆栈。
    diagnostics.additional(error, "render_first_failure");
    for (const message of errors.slice(0, 3)) diagnostics.additional(message, "page_evidence");
    if (errors.length) throw new Error([...errors.slice(0, 3), error instanceof Error ? error.message : String(error)].join("; "), { cause: error });
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!diagnostics.summary().terminationRequestedBy) diagnostics.terminate("failure_cleanup");
    await closeMotionBrowser(browser, diagnostics);
  }
}
