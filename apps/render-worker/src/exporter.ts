import { inspectFinalAudio } from "../../../packages/media-intelligence/src/acoustics.js";
import { applyFinalAudioMixGain } from "./audio-mix-gain.js";
import { hashMediaFile } from "../../../packages/edit-application/src/media-intelligence.js";
import "../../../plugins/videoflowcut/scripts/background-processes.mjs";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, type ReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { resolveRenderBrowser } from "../../../packages/remotion-runtime/src/browser.js";
export { resolveRenderBrowser } from "../../../packages/remotion-runtime/src/browser.js";
import { withRenderNavigationRecovery } from "./navigation-recovery.js";
import type { EditingApplication } from "@videocut/application";
import { EFFECT_TYPES, inspectEffectContentContract, type SourceManifest, type ExportArtifact, type ExportPurpose, type ExportTechnicalValidation, type JobRecord, type ProjectSnapshot, type RenderPreflight, type RenderPreflightCheck } from "@videocut/contracts";
import { createId, DomainError, resolveCompositionReachability } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import { canExport, evaluateQualityWithBrowser, exportBlockingIssues } from "@videocut/quality";
import { probeMedia, runProcess } from "@videocut/speech";
import { readMotionFontFile } from "../../../packages/motion-work/src/fonts.js";

const contentTypeByExtension: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

/**
 * Render Worker 由 Remotion 的独立 Webpack 进程打包，不会读取根 tsconfig 的 paths。
 * 显式复用工作区 Contracts 源码，确保正式 Render、Web Player 与 TypeScript 类型看到同一份内容合同。
 */
/**
 * 开发态的 Remotion webpack 直接读取源码；插件发行版则读取构建时生成的
 * render-entry.cjs，不能让安装缓存重新跳回 apps/ 或 packages/ 源目录。
 */
const moduleDirectory = typeof __dirname === "string"
  ? __dirname
  : readRuntimeConfig().runtime.renderSourceRoot ?? join(process.cwd(), "apps", "render-worker", "src");

/**
 * 发行 Runtime 的 Remotion webpack 从插件缓存启动，默认只会向缓存目录寻找包。
 * 启动器显式传入宿主仓库 node_modules，避免二次打包时把 zod 等运行依赖误判为缺失。
 */
function remotionResolveModules(existingModules: string[] | undefined): string[] | undefined {
  const runtimeNodeModules = readRuntimeConfig().runtime.nodeModules;
  if (!runtimeNodeModules) return existingModules;
  return [...new Set([runtimeNodeModules, ...(existingModules ?? [])])];
}

/**
 * 只有开发态的 TSX 入口需要让 Remotion webpack 回到 Contracts 源码。插件发行的
 * render-entry.cjs 已把本地 Contracts 打进入口；若仍设 source alias，安装缓存会
 * 错误依赖仓库的 packages/ 源目录。
 */
function remotionBundleAliasFor(entryPoint: string): Record<string, string> {
  const runtimeConfig = readRuntimeConfig();
  if (runtimeConfig.runtime.distributionDirectory || /\.cjs$/iu.test(entryPoint)) return {};
  return {
    "@videocut/contracts": runtimeConfig.runtime.remotionContractsEntry
      ?? join(moduleDirectory, "../../../packages/contracts/src/index.ts")
  };
}

function assertPathWithin(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DomainError("渲染媒体路径超出项目目录", "UNSAFE_MEDIA_PATH");
  }
}

function parseRange(range: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!range) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match) return undefined;
  const [, startText, endText] = match;
  if (!startText && !endText) return undefined;
  if (!startText) {
    const suffixLength = Math.min(size, Number(endText));
    return { start: size - suffixLength, end: size - 1 };
  }
  const start = Number(startText);
  const end = Math.min(size - 1, endText ? Number(endText) : size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return undefined;
  return { start, end };
}

/** 仅在本次 Render 生命周期暴露当前项目媒体，避免 Worker 依赖常驻 HTTP Server。 */
export async function startProjectMediaServer(snapshot: ProjectSnapshot): Promise<{ mediaBaseUrl: string; close: () => Promise<void> }> {
  const projectRoot = resolve(snapshot.project.rootPath);
  const expectedPrefix = `/media/${encodeURIComponent(snapshot.project.id)}/`;
  const activeStreams = new Set<ReadStream>();
  let closing = false;
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const fontMatch = /^\/api\/motion\/fonts\/([a-z][a-z0-9-]{0,79})\/file$/u.exec(requestUrl.pathname);
      if (fontMatch) {
        // 离线合成与工作台读取同一登记原件，固定 hash 不允许字体目录更新后偷偷换字形。
        const font = readMotionFontFile(fontMatch[1]!, requestUrl.searchParams.get("sha256") ?? "");
        response.writeHead(200, { "Content-Type": font.contentType, "Content-Length": font.bytes.length, "Access-Control-Allow-Origin": "*" }).end(font.bytes);
        return;
      }
      if (!requestUrl.pathname.startsWith(expectedPrefix)) {
        response.writeHead(404).end();
        return;
      }
      const encodedRelativePath = requestUrl.pathname.slice(expectedPrefix.length);
      const relativePath = encodedRelativePath.split("/").map((segment) => decodeURIComponent(segment)).join("/");
      const targetPath = resolve(projectRoot, relativePath);
      assertPathWithin(projectRoot, targetPath);
      if (!existsSync(targetPath)) {
        response.writeHead(404).end();
        return;
      }
      const info = await stat(targetPath);
      // stat 等待期间浏览器可能已取消或服务开始关闭，不能再创建无消费者的文件流。
      if (closing || response.destroyed) return;
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const range = parseRange(request.headers.range, info.size);
      const headers = {
        "Content-Type": contentTypeByExtension[extname(targetPath).toLowerCase()] ?? "application/octet-stream",
        "Accept-Ranges": "bytes"
      };
      if (range) {
        response.writeHead(206, { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`, "Content-Length": range.end - range.start + 1 });
      } else {
        response.writeHead(200, { ...headers, "Content-Length": info.size });
      }
      // pipeline 将响应取消和异步磁盘错误传回文件流，防止 seek 后句柄无限累积。
      const stream = createReadStream(targetPath, range);
      activeStreams.add(stream);
      try { await pipeline(stream, response); }
      finally { activeStreams.delete(stream); }
    } catch {
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy();
      }
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new DomainError("无法启动本地渲染媒体服务", "MEDIA_SERVER_FAILED");
  }
  return {
    mediaBaseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      closing = true;
      // 不等待已暂停的 Range 消费者；Render 生命周期结束须收回全部连接和句柄。
      const closed = closeServer(server);
      const streams = [...activeStreams];
      const streamClosures = streams.map((stream) => stream.closed ? Promise.resolve() : new Promise<void>((done) => stream.once("close", done)));
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await Promise.all([closed, ...streamClosures]);
    }
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

function usedAssetIds(snapshot: ProjectSnapshot): Set<string> {
  // 与 ProjectComposition 共用同一推导，避免 stale Scene/Cue 或隐藏轨道被预检、来源清单误算为成片依赖。
  return new Set(resolveCompositionReachability(snapshot).assetIds);
}

/** 文件身份直接由实际渲染引用核验，不依赖已删除的素材采用资格。 */
export async function verifySourceFiles(snapshot: ProjectSnapshot): Promise<void> {
  const used = usedAssetIds(snapshot);
  for (const asset of snapshot.assets.filter(entry => used.has(entry.id))) {
    const path = resolveManagedAssetPath(snapshot, asset.managedPath);
    let file;
    try { file = await stat(path); }
    catch { throw new DomainError(`素材“${asset.name}”文件缺失`, "MEDIA_SOURCE_MISSING"); }
    if (!file.isFile() || file.size <= 0) throw new DomainError(`素材“${asset.name}”文件为空或类型无效`, "MEDIA_SOURCE_INVALID");
    if (asset.sourceHash && await hashMediaFile(path) !== asset.sourceHash) throw new DomainError(`素材“${asset.name}”文件哈希与当前绑定不符`, "MEDIA_SOURCE_CHANGED");
  }
}

/** 透明帧也是正式依赖，不能只验证审阅 MP4 存在就放行导出。 */
export async function verifyMotionFrameCaches(snapshot: ProjectSnapshot): Promise<void> {
  const used = usedAssetIds(snapshot);
  for (const cue of snapshot.effectCues.filter((cue) => cue.type === "ManagedMotion" && cue.status === "ready")) {
    const content = inspectEffectContentContract(cue, snapshot.assets, snapshot.timeline);
    if (!content.ready) throw new DomainError(content.missing.join("；"), "MOTION_CONTENT_INVALID");
  }
  const proxyItem = snapshot.timeline.items.find((item) => !item.disabled && snapshot.assets.some((asset) => asset.id === item.assetId && asset.motion));
  if (proxyItem) throw new DomainError("受管作品的审阅代理不能作为普通视频放入时间线，请使用 ManagedMotion EffectCue", "MOTION_PROXY_NOT_RENDERABLE");
  for (const asset of snapshot.assets.filter((entry) => entry.motion && used.has(entry.id))) {
    const motion = asset.motion!;
    const manifestPath = resolveManagedAssetPath(snapshot, `${motion.framesDirectory}/../manifest.json`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string; engineVersion: string; frameHashes: string[] };
    if (manifest.version !== motion.version || manifest.engineVersion !== motion.engineVersion || !Array.isArray(manifest.frameHashes) || manifest.frameHashes.length !== motion.frameCount) throw new DomainError("作品帧缓存版本不一致", "MOTION_CACHE_CORRUPT");
    for (let frame = 0; frame < motion.frameCount; frame++) {
      const framePath = resolveManagedAssetPath(snapshot, `${motion.framesDirectory}/frame-${String(frame).padStart(5, "0")}.png`);
      const hash = createHash("sha256").update(await readFile(framePath)).digest("hex");
      if (hash !== manifest.frameHashes[frame]) throw new DomainError("作品透明帧缺失或已改变，不能用代理替代", "MOTION_CACHE_CORRUPT");
    }
  }
}

function addPreflightCheck(checks: RenderPreflightCheck[], status: RenderPreflightCheck["status"], code: string, message: string, objectId?: string): void {
  checks.push({ status, code, message, objectId });
}

function resolveManagedAssetPath(snapshot: ProjectSnapshot, managedPath: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(managedPath)) {
    throw new DomainError("正式渲染不能直接引用远程临时 URL", "REMOTE_RENDER_ASSET");
  }
  const projectRoot = resolve(snapshot.project.rootPath);
  const targetPath = resolve(projectRoot, managedPath);
  assertPathWithin(projectRoot, targetPath);
  return targetPath;
}

type ExplainerScenePreviewCache = {
  cacheKey: string;
  sceneId: string;
  localFromFrame: number;
  localToFrame: number;
  relativePath: string;
};

const rangesOverlap = (leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) => (
  leftStart < rightEnd && leftEnd > rightStart
);

/**
 * 首版只缓存“独占画面”的 Explainer Scene 预览。若同一帧还有字幕、Cue、Cutaway、
 * 或任何 Timeline Item，直接重新合成，避免把其它对象的旧画面错误复用。
 */
function isolatedExplainerScenePreviewCache(
  snapshot: ProjectSnapshot,
  fromFrame: number,
  toFrame: number
): ExplainerScenePreviewCache | undefined {
  const { explainerProgramIds } = resolveCompositionReachability(snapshot);
  const candidates = snapshot.explainerPrograms.flatMap((program) => {
    if (!explainerProgramIds.has(program.id) || !/^[a-f0-9]{16,128}$/iu.test(program.cacheKey)) return [];
    const scene = snapshot.scenes.find((candidate) => candidate.id === program.sceneId);
    if (!scene || scene.type !== "ExplainerScene" || scene.status !== "ready"
      || fromFrame < scene.startFrame || toFrame > scene.endFrame) return [];
    return [{ program, scene }];
  });
  if (candidates.length !== 1) return undefined;

  const { program, scene } = candidates[0]!;
  const hasOtherVisual = snapshot.timeline.items.some((item) => !item.disabled
    && rangesOverlap(item.startFrame, item.endFrame, fromFrame, toFrame));
  const hasCaption = snapshot.timeline.captions.some((caption) => rangesOverlap(caption.startFrame, caption.endFrame, fromFrame, toFrame));
  const hasCue = snapshot.effectCues.some((cue) => cue.status === "ready"
    && rangesOverlap(cue.startFrame, cue.endFrame, fromFrame, toFrame));
  if (hasOtherVisual || hasCaption || hasCue) return undefined;

  const localFromFrame = fromFrame - scene.startFrame;
  const localToFrame = toFrame - scene.startFrame;
  return {
    cacheKey: program.cacheKey,
    sceneId: scene.id,
    localFromFrame,
    localToFrame,
    relativePath: join("cache", "explainer-scenes", program.cacheKey, `range-${localFromFrame}-${localToFrame}-gain-${snapshot.audioMixGainDb ?? 0}.mp4`)
  };
}

async function isValidScenePreviewCache(path: string, expectedDurationMs: number): Promise<boolean> {
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size <= 0) return false;
    const metadata = await probeMedia(path);
    return metadata.durationMs > 0 && Boolean(metadata.videoCodec)
      && Math.abs(metadata.durationMs - expectedDurationMs) <= 1_000;
  } catch {
    return false;
  }
}

/** 以流式方式计算最终文件哈希，避免大文件验证耗尽 Worker 内存。 */
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

/**
 * 预检只验证当前 Revision 的实际引用和当前 Renderer 可确定的依赖。
 * 它不会假装已做完整声画审片；真正的 Remotion 渲染和 Artifact 复核仍是后续独立证据。
 */
export async function runRenderPreflight(application: EditingApplication, projectId: string, revisionNumber: number, purpose: ExportPurpose = "delivery"): Promise<RenderPreflight> {
  const revision = application.repository.getRevision(projectId, revisionNumber);
  const snapshot = revision.snapshot;
  const checks: RenderPreflightCheck[] = [];
  try { await verifySourceFiles(snapshot); }
  catch (error) { addPreflightCheck(checks, "failed", error instanceof DomainError ? error.code : "MEDIA_SOURCE_INVALID", error instanceof Error ? error.message : String(error)); }
  try { await verifyMotionFrameCaches(snapshot); }
  catch (error) { addPreflightCheck(checks, "failed", "MOTION_CACHE_CORRUPT", error instanceof Error ? error.message : String(error)); }
  const review = await application.readEditorialQualityReview({ projectId, revision: revisionNumber });
  const quality = await evaluateQualityWithBrowser(snapshot, revisionNumber, review);
  for (const issue of exportBlockingIssues(quality, purpose)) {
    addPreflightCheck(checks, "failed", `QUALITY_${issue.code}`, issue.message, issue.objectId);
  }

  const assetIds = usedAssetIds(snapshot);
  const assetsById = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  for (const assetId of assetIds) {
    const asset = assetsById.get(assetId);
    if (!asset) {
      addPreflightCheck(checks, "failed", "PREFLIGHT_ASSET_MISSING", "当前 Revision 引用了不存在的素材。", assetId);
      continue;
    }
    if (asset.status !== "ready") {
      addPreflightCheck(checks, "failed", "PREFLIGHT_ASSET_NOT_READY", `素材“${asset.name}”尚未处于 render-ready 状态。`, asset.id);
      continue;
    }
    let assetPath: string;
    try {
      assetPath = resolveManagedAssetPath(snapshot, asset.managedPath);
      const file = await stat(assetPath);
      if (!file.isFile() || file.size <= 0) {
        addPreflightCheck(checks, "failed", "PREFLIGHT_ASSET_FILE_INVALID", `素材“${asset.name}”不是可读取的非空文件。`, asset.id);
        continue;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addPreflightCheck(checks, "failed", "PREFLIGHT_ASSET_FILE_MISSING", `素材“${asset.name}”当前不可被 Render Worker 读取：${message}`, asset.id);
      continue;
    }
    const requiresMediaProbe = ["video", "audio", "actor_video", "speech"].includes(asset.kind)
      || Boolean(asset.metadata?.videoCodec || asset.metadata?.audioCodec);
    if (requiresMediaProbe) {
      try {
        const metadata = await probeMedia(assetPath);
        if (metadata.durationMs <= 0) throw new DomainError("媒体时长无效", "INVALID_MEDIA_DURATION");
        addPreflightCheck(checks, "passed", "PREFLIGHT_MEDIA_DECODABLE", `素材“${asset.name}”已通过当前 Worker 的媒体探测。`, asset.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addPreflightCheck(checks, "failed", "PREFLIGHT_MEDIA_UNDECODABLE", `素材“${asset.name}”无法被当前 Worker 解码：${message}`, asset.id);
      }
    } else {
      addPreflightCheck(checks, "passed", "PREFLIGHT_ASSET_BYTES_AVAILABLE", `素材“${asset.name}”的本地文件可读取。`, asset.id);
    }

  }

  for (const cue of snapshot.effectCues.filter((candidate) => candidate.status === "ready")) {
    if (!EFFECT_TYPES.includes(cue.type)) {
      addPreflightCheck(checks, "failed", "PREFLIGHT_EFFECT_COMPONENT_MISSING", `效果“${cue.type}”没有对应的 Remotion 组件。`, cue.id);
    }
  }
  if (!checks.some((check) => check.code === "PREFLIGHT_EFFECT_COMPONENT_MISSING")) {
    addPreflightCheck(checks, "passed", "PREFLIGHT_EFFECT_COMPONENTS_AVAILABLE", "当前 Revision 的已启用效果均可由现有 Remotion Registry 解析。");
  }
  // 第一版未开放项目级自定义字体；这里明确记录依赖边界，实际字体渲染仍由正式 Render 再验证。
  addPreflightCheck(checks, "passed", "PREFLIGHT_FONT_RUNTIME", "当前首版只使用 Remotion 运行时固定字体栈，不存在额外的项目级字体文件依赖。");

  return {
    id: createId("render_preflight"),
    projectId,
    revision: revisionNumber,
    purpose,
    status: checks.some((check) => check.status === "failed") ? "failed" : "passed",
    checks,
    checkedAt: new Date().toISOString()
  };
}

function buildSourceManifest(snapshot: ProjectSnapshot, artifactId: string): SourceManifest {
  const assetIds = usedAssetIds(snapshot);
  const entries = snapshot.assets
    .filter((asset) => assetIds.has(asset.id) && asset.provenance && asset.provenance.source !== "local_import")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((asset) => ({
      assetId: asset.id,
      name: asset.name,
      sourceHash: asset.sourceHash,
      source: asset.provenance!.source,
      provider: asset.provenance!.provider,
      sourceUrl: asset.provenance!.sourceUrl,
      creator: asset.provenance!.creator,
      originalAssetId: asset.provenance!.originalAssetId,
      acquiredAt: asset.provenance!.acquiredAt,
    }));
  return {
    relativePath: join("manifests", "sources", `${artifactId}.json`),
    generatedAt: new Date().toISOString(),
    entries
  };
}

async function writeSourceManifest(snapshot: ProjectSnapshot, manifest: SourceManifest): Promise<void> {
  const targetPath = resolve(snapshot.project.rootPath, manifest.relativePath);
  assertPathWithin(resolve(snapshot.project.rootPath), targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
}

export async function verifyRenderBrowserReady(): Promise<void> {
  const browserExecutable = await resolveRenderBrowser();
  const browser = await openBrowser("chrome", { browserExecutable, logLevel: "error" });
  await browser.close({ silent: true });
}

/** 队列仅提交不可变 Snapshot；渲染实现不负责数据库或 Job 状态。 */
export interface RevisionRenderEngine {
  render(snapshot: ProjectSnapshot, targetPath: string): Promise<void>;
  renderRange(snapshot: ProjectSnapshot, fromFrame: number, toFrame: number, targetPath: string): Promise<void>;
}

/** Bundle 在 Worker 内复用，每个 Job 独立提供其不可变 Revision 的媒体资源。 */
export class RevisionRenderer implements RevisionRenderEngine {
  private bundleLocation?: Promise<string>;
  private readonly entryPoint: string;
  private readonly concurrency: string | number | null;

  constructor(
    entryPoint = readRuntimeConfig().runtime.remotionEntry
      ?? join(moduleDirectory, "render-entry.tsx"),
    concurrency: string | number | null = "50%"
  ) {
    this.entryPoint = entryPoint;
    this.concurrency = concurrency;
  }

  /** 冷启动打包会占用 Node 事件循环，必须在接收正式 Job、宣告 API 就绪之前完成。 */
  async prepare(): Promise<void> {
    await verifyRenderBrowserReady();
    await this.getBundle();
  }

  private getBundle(): Promise<string> {
    this.bundleLocation ??= bundle(this.entryPoint, undefined, {
      webpackOverride: (configuration) => {
        const existingAlias = configuration.resolve?.alias;
        const remotionBundleAlias = remotionBundleAliasFor(this.entryPoint);
        return {
          ...configuration,
          resolve: {
            ...configuration.resolve,
            // 源码按 Node ESM 写 .js 导入；开发态由 Webpack 映射到同名 TS，发行态继续使用真实 JS。
            extensionAlias: { ...configuration.resolve?.extensionAlias, ".js": [".js", ".ts", ".tsx"] },
            // Remotion 支持对象或数组两种 alias 形式；当前项目只合并对象形式，数组配置由运行时保留。
            alias: {
              ...(Array.isArray(existingAlias) ? {} : existingAlias ?? {}),
              ...remotionBundleAlias
            },
            modules: remotionResolveModules(configuration.resolve?.modules)
          }
        };
      }
    });
    return this.bundleLocation;
  }

  async render(snapshot: ProjectSnapshot, targetPath: string): Promise<void> {
    return withRenderNavigationRecovery(() => this.renderOnce(snapshot, targetPath));
  }

  private async renderOnce(snapshot: ProjectSnapshot, targetPath: string): Promise<void> {
    await verifySourceFiles(snapshot);
    await verifyMotionFrameCaches(snapshot);
    const mediaServer = await startProjectMediaServer(snapshot);
    try {
      const browserExecutable = await resolveRenderBrowser();
      const serveUrl = await this.getBundle();
      const inputProps = { snapshot, mediaBaseUrl: mediaServer.mediaBaseUrl };
      const composition = await selectComposition({ serveUrl, id: "videocut-project", inputProps, browserExecutable, logLevel: "error" });
      await renderMedia({
        browserExecutable,
        composition,
        serveUrl,
        codec: "h264",
        inputProps,
        outputLocation: targetPath,
        overwrite: true,
        crf: 20,
        x264Preset: "veryfast",
        audioCodec: "aac",
        enforceAudioTrack: true,
        concurrency: this.concurrency,
        timeoutInMilliseconds: 30 * 60_000,
        logLevel: "error"
      });
      await applyFinalAudioMixGain(snapshot, targetPath);
    } finally {
      await mediaServer.close();
    }
  }

  /** 局部预览仍从完整 Composition 的全局帧坐标渲染，避免把 Cue 和字幕错误地从第 0 帧重算。 */
  async renderRange(snapshot: ProjectSnapshot, fromFrame: number, toFrame: number, targetPath: string): Promise<void> {
    return withRenderNavigationRecovery(() => this.renderRangeOnce(snapshot, fromFrame, toFrame, targetPath));
  }

  private async renderRangeOnce(snapshot: ProjectSnapshot, fromFrame: number, toFrame: number, targetPath: string): Promise<void> {
    await verifySourceFiles(snapshot);
    await verifyMotionFrameCaches(snapshot);
    if (fromFrame < 0 || toFrame <= fromFrame || toFrame > snapshot.timeline.durationInFrames) {
      throw new DomainError("局部预览范围无效", "INVALID_PREVIEW_RANGE");
    }
    const mediaServer = await startProjectMediaServer(snapshot);
    try {
      const browserExecutable = await resolveRenderBrowser();
      const serveUrl = await this.getBundle();
      const inputProps = { snapshot, mediaBaseUrl: mediaServer.mediaBaseUrl };
      const composition = await selectComposition({ serveUrl, id: "videocut-project", inputProps, browserExecutable, logLevel: "error" });
      await renderMedia({
        browserExecutable,
        composition,
        serveUrl,
        codec: "h264",
        inputProps,
        outputLocation: targetPath,
        overwrite: true,
        frameRange: [fromFrame, toFrame - 1],
        crf: 20,
        x264Preset: "veryfast",
        audioCodec: "aac",
        enforceAudioTrack: true,
        concurrency: this.concurrency,
        timeoutInMilliseconds: 30 * 60_000,
        logLevel: "error"
      });
      await applyFinalAudioMixGain(snapshot, targetPath);
    } finally {
      await mediaServer.close();
    }
  }
}

export interface ExportValidation extends ExportTechnicalValidation {}

/** 导出后解码、探测音轨并扫描持续黑帧；任何技术异常会阻止任务被标记成功。 */
export async function validateOutputFrameRate(targetPath: string, fps: number, frameCount: number): Promise<{ fps: number; frameCount: number }> {
  const probe = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=avg_frame_rate,nb_read_frames", "-of", "json", targetPath]));
  const stream = probe.streams?.[0];
  const rate = String(stream?.avg_frame_rate).split("/").map(Number);
  const actualFps = rate[0] / rate[1], actualFrames = Number(stream?.nb_read_frames);
  if (!Number.isFinite(actualFps) || Math.abs(actualFps - fps) > 1e-7 || actualFrames !== frameCount) {
    throw new DomainError(`输出规格异常：期望${fps}fps/${frameCount}帧，实际${stream?.avg_frame_rate ?? "未知"}/${stream?.nb_read_frames ?? "未知"}帧`, "OUTPUT_FRAME_RATE_MISMATCH");
  }
  return { fps: actualFps, frameCount: actualFrames };
}

export async function validateExport(targetPath: string, expectedDurationMs: number, target?: { fps: number; frameCount: number }): Promise<ExportValidation> {
  const metadata = await probeMedia(targetPath);
  if (metadata.durationMs <= 0 || !metadata.videoCodec || !metadata.hasAudio) {
    throw new DomainError("导出文件校验失败：缺少有效视频或音频", "INVALID_EXPORT");
  }
  if (Math.abs(metadata.durationMs - expectedDurationMs) > 1_000) {
    throw new DomainError(`导出时长异常：期望约 ${expectedDurationMs}ms，实际 ${metadata.durationMs}ms`, "EXPORT_DURATION_MISMATCH");
  }
  const frameRate = target ? await validateOutputFrameRate(targetPath, target.fps, target.frameCount) : undefined;
  await runProcess("ffmpeg", ["-v", "error", "-i", targetPath, "-map", "0:v:0", "-f", "null", "-"], 30 * 60_000);
  const blackDetectOutput = await runProcess("ffmpeg", ["-hide_banner", "-i", targetPath, "-vf", "blackdetect=d=0.25:pix_th=0.10", "-an", "-f", "null", "-"], 30 * 60_000);
  const blackSegments = [...blackDetectOutput.matchAll(/black_start:([^\s]+)\s+black_end:([^\s]+)\s+black_duration:([^\s]+)/gu)].map((match) => ({
    startSeconds: Number(match[1]),
    endSeconds: Number(match[2]),
    durationSeconds: Number(match[3])
  }));
  if (blackSegments.length > 0) {
    throw new DomainError(`导出包含持续黑帧：${blackSegments.map((segment) => `${segment.startSeconds.toFixed(2)}–${segment.endSeconds.toFixed(2)}s`).join("，")}`, "BLACK_FRAME_DETECTED");
  }
  const audio = await inspectFinalAudio(targetPath);
  return { durationMs: metadata.durationMs, hasAudio: metadata.hasAudio, blackSegments, audio, ...frameRate };
}

export async function runExportJob(
  application: EditingApplication,
  job: JobRecord,
  renderer: RevisionRenderEngine = new RevisionRenderer()
): Promise<Record<string, unknown>> {
  const revisionNumber = Number(job.payload.revision);
  // 旧 Job 没有 purpose 时按 delivery 处理，避免历史队列绕过新交付门禁。
  const purpose: ExportPurpose = job.payload.purpose === "draft" ? "draft" : "delivery";
  if (!Number.isInteger(revisionNumber) || revisionNumber <= 0) throw new DomainError("导出任务缺少有效 Revision", "INVALID_EXPORT_REVISION");
  const revision = application.repository.getRevision(job.projectId, revisionNumber);
  // Worker 在写入 Artifact 后、回写 Job 前意外中断时，重领同一 Job 必须复用既有文件，不能重新覆盖它。
  const existingArtifact = application.repository.getExportArtifactForJob(job.projectId, job.id);
  if (existingArtifact) {
    const existingPath = join(revision.snapshot.project.rootPath, existingArtifact.relativePath);
    const existingFile = await stat(existingPath).catch(() => undefined);
    if (!existingFile?.isFile() || existingFile.size !== existingArtifact.fileSizeBytes) {
      throw new DomainError("已登记的 ExportArtifact 文件缺失或已变化，不能把未知结果标记为成功", "EXPORT_ARTIFACT_CHANGED");
    }
    if (await sha256File(existingPath) !== existingArtifact.fileHash) {
      throw new DomainError("已登记的 ExportArtifact 文件哈希已变化，不能把未知结果标记为成功", "EXPORT_ARTIFACT_CHANGED");
    }
    return {
      artifactId: existingArtifact.id,
      revision: existingArtifact.revision,
      purpose: existingArtifact.purpose,
      path: existingPath,
      relativePath: existingArtifact.relativePath,
      renderer: "remotion",
      preflight: existingArtifact.preflight,
      validation: existingArtifact.validation,
      sourceManifest: existingArtifact.sourceManifest,
      warnings: []
    };
  }
  const editorialReview = await application.readEditorialQualityReview({ projectId: job.projectId, revision: revisionNumber });
  const report = await evaluateQualityWithBrowser(revision.snapshot, revisionNumber, editorialReview);
  if (!canExport(report, purpose)) {
    const blockingMessages = exportBlockingIssues(report, purpose).map(entry => entry.message);
    throw new DomainError(`技术/用途条件阻止导出：${blockingMessages.join("；")}`, "QUALITY_GATE_BLOCKED");
  }
  const preflight = await runRenderPreflight(application, job.projectId, revisionNumber, purpose);
  if (preflight.status !== "passed") {
    const failures = preflight.checks.filter((check) => check.status === "failed").map((check) => check.message);
    throw new DomainError(`Render Preflight 未通过：${failures.join("；")}`, "RENDER_PREFLIGHT_FAILED");
  }
  const artifactId = createId("export_artifact");
  const relativePath = join("exports", `revision-${revisionNumber}`, `${purpose}-${artifactId}.mp4`);
  const targetPath = join(revision.snapshot.project.rootPath, relativePath);
  const temporaryPath = `${targetPath}.${job.id}.rendering.mp4`;
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await renderer.render(revision.snapshot, temporaryPath);
  } catch (renderError) {
    const reason = renderError instanceof Error ? renderError.message : String(renderError);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    // 正式交付只能来自完整 Remotion Composition；不能把缺少字幕、动效与 Dialogue 的 A-roll 当成功。
    throw new DomainError(`Remotion 正式导出失败，未生成可交付文件：${reason}`, "REMOTION_EXPORT_FAILED");
  }
  try {
    const expectedDurationMs = Math.round((revision.snapshot.timeline.durationInFrames / revision.snapshot.timeline.fps) * 1000);
    const validation = await validateExport(temporaryPath, expectedDurationMs, { fps: revision.snapshot.timeline.fps, frameCount: revision.snapshot.timeline.durationInFrames });
    const target = revision.snapshot.audioOutputTarget;
    // 保留的 SpeechAsset 不代表实际启用；静音视觉草稿不能因此被误判缺音。
    const dialoguePlanned = revision.snapshot.timeline.items.some(item => !item.disabled && item.mediaAudioPolicy !== "mute"
      && revision.snapshot.timeline.tracks.some(track => track.id === item.trackId && track.name === "Dialogue" && !track.muted));
    const audiblePlanned = revision.snapshot.audioCues.some((cue) => cue.status === "ready" && revision.snapshot.timeline.items.some((item) => item.id === cue.timelineItemId && !item.disabled && !revision.snapshot.timeline.tracks.find((track) => track.id === item.trackId)?.muted)) || dialoguePlanned;
    if (audiblePlanned && validation.audio?.truePeakDbfs === null) throw new DomainError("成片计划有声音但实际混音无有效信号", "EXPORT_AUDIO_MISSING");
    if (purpose === "delivery" && target && (validation.audio?.integratedLufs == null || validation.audio.truePeakDbfs == null || Math.abs(validation.audio.integratedLufs - target.targetLufs) > target.toleranceLu || validation.audio.truePeakDbfs > target.maxTruePeakDbfs)) throw new DomainError("实际响度或 true peak 未达到当前项目输出目标；请在混音中调整并重新预览", "EXPORT_AUDIO_TARGET_FAILED");
    await rename(temporaryPath, targetPath);
    const file = await stat(targetPath);
    const manifest = buildSourceManifest(revision.snapshot, artifactId);
    try {
      await writeSourceManifest(revision.snapshot, manifest);
      const artifact: ExportArtifact = {
        id: artifactId,
        projectId: job.projectId,
        revision: revisionNumber,
        jobId: job.id,
        purpose,
        relativePath,
        fileHash: await sha256File(targetPath),
        fileSizeBytes: file.size,
        preflight,
        validation,
        sourceManifest: manifest,
        createdAt: new Date().toISOString()
      };
      application.registerExportArtifact(artifact);
      return {
        artifactId: artifact.id,
        revision: revisionNumber,
        purpose,
        path: targetPath,
        relativePath,
        renderer: "remotion",
        preflight,
        validation,
        sourceManifest: manifest,
        warnings: []
      };
    } catch (error) {
      // 路径带有新的 Artifact ID，清理失败提交的候选不会影响任何历史交付文件。
      await rm(targetPath, { force: true }).catch(() => undefined);
      await rm(join(revision.snapshot.project.rootPath, manifest.relativePath), { force: true }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 预检 Job 完成表示“检查已执行”；status=failed 说明不应进入 Export，而不是 Job 本身异常。 */
export async function runRenderPreflightJob(application: EditingApplication, job: JobRecord): Promise<Record<string, unknown>> {
  const revisionNumber = Number(job.payload.revision);
  if (!Number.isInteger(revisionNumber) || revisionNumber <= 0) throw new DomainError("Render Preflight 任务缺少有效 Revision", "INVALID_PREFLIGHT_REVISION");
  const purpose = job.payload.purpose ?? "delivery";
  if (purpose !== "draft" && purpose !== "delivery") throw new DomainError("预检用途无效", "INVALID_PREFLIGHT_PURPOSE");
  const preflight = await runRenderPreflight(application, job.projectId, revisionNumber, purpose);
  return { revision: revisionNumber, preflight };
}

/** 预览任务只生成指定帧窗，供 Web/MCP 在结构修改后快速检查真实合成结果。 */
export async function runPreviewJob(
  application: EditingApplication,
  job: JobRecord,
  renderer: RevisionRenderEngine = new RevisionRenderer()
): Promise<Record<string, unknown>> {
  const revisionNumber = Number(job.payload.revision);
  const fromFrame = Number(job.payload.fromFrame);
  const toFrame = Number(job.payload.toFrame);
  if (!Number.isInteger(revisionNumber) || !Number.isInteger(fromFrame) || !Number.isInteger(toFrame)) {
    throw new DomainError("局部预览任务缺少有效 Revision 或帧范围", "INVALID_PREVIEW_RANGE");
  }
  const revision = application.repository.getRevision(job.projectId, revisionNumber);
  if (fromFrame < 0 || toFrame <= fromFrame || toFrame > revision.snapshot.timeline.durationInFrames) {
    throw new DomainError("局部预览范围超出指定 Revision", "INVALID_PREVIEW_RANGE");
  }
  const relativePath = join("previews", `revision-${revisionNumber}-${fromFrame}-${toFrame}.mp4`);
  const targetPath = join(revision.snapshot.project.rootPath, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });
  const expectedDurationMs = Math.round(((toFrame - fromFrame) / revision.snapshot.timeline.fps) * 1000);
  const sceneCache = isolatedExplainerScenePreviewCache(revision.snapshot, fromFrame, toFrame);
  const cachePath = sceneCache ? join(revision.snapshot.project.rootPath, sceneCache.relativePath) : undefined;
  let cacheHit = false;

  if (cachePath && await isValidScenePreviewCache(cachePath, expectedDurationMs)) {
    // 缓存永远只是可重建的优化：复制到当前 Revision 的 Preview 位置，保留 Revision 级证据边界。
    await copyFile(cachePath, targetPath);
    cacheHit = true;
  } else {
    if (cachePath) await rm(cachePath, { force: true }).catch(() => undefined);
    const renderTarget = cachePath ? `${cachePath}.${job.id}.rendering.mp4` : targetPath;
    if (cachePath) await mkdir(dirname(cachePath), { recursive: true });
    try {
      await renderer.renderRange(revision.snapshot, fromFrame, toFrame, renderTarget);
      if (cachePath) {
        // 同一 Key 的并发渲染只会产生相同输入的可替换优化文件；正式证据仍是 targetPath。
        await rename(renderTarget, cachePath);
        await copyFile(cachePath, targetPath);
      }
    } catch (error) {
      if (cachePath) await rm(renderTarget, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  const metadata = await probeMedia(targetPath);
  if (metadata.durationMs <= 0 || !metadata.videoCodec || Math.abs(metadata.durationMs - expectedDurationMs) > 1_000) {
    throw new DomainError("局部预览文件不可读或时长异常", "INVALID_PREVIEW_OUTPUT");
  }
  const frameRate = await validateOutputFrameRate(targetPath, revision.snapshot.timeline.fps, toFrame - fromFrame);
  return {
    revision: revisionNumber,
    fromFrame,
    toFrame,
    path: targetPath,
    relativePath,
    durationMs: metadata.durationMs,
    ...frameRate,
    hasAudio: metadata.hasAudio,
    audio: metadata.hasAudio ? await inspectFinalAudio(targetPath) : undefined,
    sourceHash: await hashMediaFile(targetPath),
    sceneCache: sceneCache ? {
      sceneId: sceneCache.sceneId,
      cacheKey: sceneCache.cacheKey,
      localFromFrame: sceneCache.localFromFrame,
      localToFrame: sceneCache.localToFrame,
      hit: cacheHit
    } : undefined
  };
}
