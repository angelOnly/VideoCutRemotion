import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import type { EditingApplication } from "@videocut/application";
import type { JobRecord } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";
import { assertDownloadedProviderMedia } from "@videocut/acquisition";
import { readRuntimeConfig } from "@videocut/project-overview";
import { sourceMaterialSchema } from "../../../packages/asset-acquisition/src/source-research.js";
import { fetchPublicSource, publicSourceUrl } from "../../../packages/asset-acquisition/src/public-source.js";
import { resolveRenderBrowser } from "../../../packages/remotion-runtime/src/browser.js";
import { documentPageCount } from "../../../packages/media-intelligence/src/derive.js";

async function capturePage(url: string, fetchSource = fetchPublicSource) {
  const browser = await puppeteer.launch({ executablePath: await resolveRenderBrowser(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    let total = 0, failure: unknown;
    const warnings: Array<{ url: string; method: string; resourceType: string; code: string; message: string }> = [];
    const pending = new Set<Promise<void>>();
    const signal = AbortSignal.timeout(45000);
    page.on("request", request => { const task = (async () => {
      try {
        if (request.url().startsWith("data:")) { await request.continue(); return; }
        if (request.method() !== "GET") {
          await publicSourceUrl(request.url());
          throw new DomainError("截图不发送非 GET 请求，相关页面内容待核验", "SOURCE_CAPTURE_REQUEST_BLOCKED");
        }
        const resource = await fetchSource(request.url(), 16 * 1024 * 1024, AbortSignal.any([signal, AbortSignal.timeout(10000)]), request.headers());
        if (resource.url !== request.url()) { await request.respond({ status: 302, headers: { location: resource.url } }); return; }
        total += resource.bytes.length;
        if (total > 64 * 1024 * 1024) throw new DomainError("页面资源超过截图预算", "SOURCE_CAPTURE_BUDGET");
        await request.respond({ status: 200, contentType: resource.mime, body: resource.bytes, headers: { "content-security-policy": "connect-src http: https:; frame-src 'none'; worker-src 'none'; object-src 'none'" } });
      } catch (error) {
        const resourceUrl = new URL(request.url());
        // 保留资源身份与错误码，但不把 URL 查询凭据写入诊断。
        const diagnostic = error instanceof DomainError
          ? new DomainError(`页面资源 ${resourceUrl.origin}${resourceUrl.pathname}：${error.message}`, error.code)
          : error;
        const mainDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
        // 子资源失败保存为待核验缺口；主文档、安全限制与预算错误仍然原子拒绝。
        if (!mainDocument && error instanceof DomainError && ["SOURCE_DOWNLOAD_FAILED", "SOURCE_EMPTY", "SOURCE_REDIRECT_INVALID", "SOURCE_REDIRECT_LIMIT", "SOURCE_NETWORK_FAILED", "SOURCE_NETWORK_TIMEOUT", "SOURCE_CAPTURE_REQUEST_BLOCKED"].includes(error.code)) {
          warnings.push({ url: `${resourceUrl.origin}${resourceUrl.pathname}`, method: request.method(), resourceType: request.resourceType(), code: error.code, message: error.message });
        } else failure ??= diagnostic;
        await request.abort().catch(() => undefined);
      }
    })(); pending.add(task); void task.finally(() => pending.delete(task)); });
    // 拦截器主动中止导航时，Chromium 的 ERR_FAILED 不能覆盖实际网络或地址错误。
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(error => { throw failure ?? error; });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(error => {
      if (error.name !== "TimeoutError") throw error;
      warnings.push({ url: new URL(page.url()).origin, method: "GET", resourceType: "document", code: "SOURCE_CAPTURE_SETTLE_TIMEOUT", message: "页面持续发起请求，截图时仍需核验动态内容" });
    });
    await Promise.all(pending);
    if (failure) throw failure;
    if (!response || !response.ok()) throw new DomainError("页面未完成加载", "SOURCE_CAPTURE_INCOMPLETE");
    const content = await page.evaluate(() => ({ title: document.title, text: document.body.innerText, height: document.documentElement.scrollHeight, password: Boolean(document.querySelector('input[type="password"]')), captcha: Boolean(document.querySelector('iframe[src*="captcha"], [class*="captcha"], [id*="captcha"]')) }));
    if (content.password || content.captcha || /just a moment|verify you are human|access denied|安全验证|验证码/i.test(content.title) || content.text.trim().length < 40) throw new DomainError("页面是登录、验证码或缺少可确认正文", "SOURCE_CAPTURE_UNAVAILABLE");
    if (content.height > 12000) throw new DomainError("页面超过完整截图高度预算，请另选来源", "SOURCE_CAPTURE_BUDGET");
    const bytes = Buffer.from(await page.screenshot({ type: "png", fullPage: true }));
    await Promise.all(pending);
    if (failure) throw failure;
    return { bytes, url: page.url(), mime: "image/png", fetchedAt: new Date().toISOString(), capture: { width: 1440, height: content.height, fullPage: true, title: content.title, complete: warnings.length === 0, reviewStatus: "pending", warnings } };
  } finally { await browser.close(); }
}

export async function runSourceMaterialAcquisition(app: EditingApplication, job: JobRecord, fetchSource = fetchPublicSource): Promise<Record<string, unknown>> {
  const input = sourceMaterialSchema.parse(job.payload.input);
  const root = app.readProject(job.projectId).snapshot.project.rootPath;
  const parent = join(root, "assets", "derived", "source-material"); await mkdir(parent, { recursive: true });
  const directory = join(parent, job.id);
  if (!await stat(directory).catch(() => undefined)) {
    const temporary = await mkdtemp(join(parent, ".acquire-"));
    try {
      const fetched = input.kind === "web_snapshot" ? await capturePage(input.url, fetchSource) : await fetchSource(input.url, Math.min(readRuntimeConfig().downloads.maxAssetBytes, 128 * 1024 * 1024));
      const extension = input.kind === "pdf" ? "pdf" : ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string,string>)[fetched.mime];
      if (!extension || input.kind === "pdf" && (fetched.mime !== "application/pdf" || fetched.bytes.subarray(0,5).toString() !== "%PDF-")) throw new DomainError("来源内容类型或文件头与请求不符", "SOURCE_MIME_INVALID");
      const file = `original.${extension}`; const path = join(temporary, file); await writeFile(path, fetched.bytes);
      const files: Array<{ file: string; kind: "document" | "image"; hash: string; page?: number }> = [{ file, kind: input.kind === "pdf" ? "document" : "image", hash: createHash("sha256").update(fetched.bytes).digest("hex") }];
      if (input.kind === "pdf") {
        const count = await documentPageCount(path);
        for (const page of [...new Set(input.pages ?? [])]) {
          if (page > count) throw new DomainError("选定 PDF 页码越界", "SOURCE_PDF_PAGE_INVALID");
          const prefix = `page-${page}`;
          await runProcess("pdftoppm", ["-f",String(page),"-l",String(page),"-singlefile","-scale-to",String(input.pageWidth ?? 1600),"-png",path,join(temporary,prefix)],120000);
          const bytes = await readFile(join(temporary,`${prefix}.png`));
          files.push({ file: `${prefix}.png`, kind: "image", page, hash: createHash("sha256").update(bytes).digest("hex") });
        }
      } else {
        await assertDownloadedProviderMedia({ filePath: path, contentType: fetched.mime, expectedKind: "image", expectedMimeType: fetched.mime });
        const meta = await probeMedia(path);
        if (!meta.width || !meta.height || meta.width * meta.height > 32_000_000) throw new DomainError("来源图片没有有效尺寸或超过像素预算", "SOURCE_IMAGE_INVALID");
      }
      await writeFile(join(temporary,"manifest.json"),JSON.stringify({ url: fetched.url, fetchedAt: fetched.fetchedAt, capture: "capture" in fetched ? fetched.capture : undefined, files }));
      await rename(temporary,directory);
    } finally { await rm(temporary,{ recursive:true,force:true }); }
  }
  const manifest = JSON.parse(await readFile(join(directory,"manifest.json"),"utf8"));
  for (const file of manifest.files) {
    if (!/^(original\.(pdf|png|jpg|webp)|page-\d+\.png)$/.test(file.file)) throw new DomainError("来源缓存路径损坏", "SOURCE_CACHE_CORRUPT");
    if (createHash("sha256").update(await readFile(join(directory,file.file))).digest("hex") !== file.hash) throw new DomainError("来源固定文件哈希不符", "SOURCE_CACHE_CORRUPT");
  }
  return app.completeSourceMaterial(job.projectId,job.id,manifest);
}
