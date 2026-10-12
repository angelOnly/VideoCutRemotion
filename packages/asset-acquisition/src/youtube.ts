import { execFileSync, spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { AssetProviderError, type AssetProvider, type ProviderSearchCandidate } from "./index.js";
import { readRuntimeConfig } from "@videocut/project-overview";
import { assetAcquisitionOptionsSchema } from "./options.js";

/** 只接受选中的单条页面，不支持任意站点、频道、搜索表达式或播放列表。 */
export function youtubeVideoUrl(value: string): { id: string; url: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new AssetProviderError("请提供选定的单个 YouTube 视频页面", "YOUTUBE_URL_INVALID"); }
  const host = url.hostname.toLowerCase();
  const id = host === "youtu.be" ? url.pathname.slice(1) : ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host) ? url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:shorts|embed)\/([^/]+)$/u.exec(url.pathname)?.[1] : undefined;
  if (url.protocol !== "https:" || url.username || url.password || url.port || !id || !/^[\w-]{11}$/u.test(id)) throw new AssetProviderError("只支持 HTTPS 单个 YouTube 视频页面", "YOUTUBE_URL_INVALID");
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

export type YoutubeRunner = (args: string[], options: { directory?: string; maxBytes?: number; timeoutMs: number }) => Promise<string>;

/** 参数数组直传进程；禁用用户配置和播放列表，不注入 shell、Cookie 或账号信息。 */
export const runYoutubeDownloader: YoutubeRunner = async (args, options) => {
  const configured = readRuntimeConfig().providers.youtubeDownloaderPath;
  const child = spawn(configured ?? "python", [...(configured ? [] : ["-m", "yt_dlp"]), "--ignore-config", "--no-playlist", "--no-cache-dir", "--no-warnings", "--js-runtimes", "node", "--socket-timeout", "20", "--retries", "1", "--fragment-retries", "1", ...args], { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errorText = "", failure: AssetProviderError | undefined, checking = false, closed = false;
  child.once("close", () => { closed = true; });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const fail = (message: string, code: string) => {
    if (failure) return;
    failure = new AssetProviderError(message, code);
    if (closed) return;
    // 超时/超限同时结束本次下载器的 FFmpeg 子进程，不能遗留后台写盘。
    if (child.pid) try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
      else process.kill(-child.pid, "SIGKILL");
    } catch { child.kill(); }
  };
  child.stdout.on("data", bytes => { output += String(bytes); if (output.length > 4 * 1024 * 1024) fail("下载器元数据输出超过4MB", "YOUTUBE_OUTPUT_BUDGET"); });
  child.stderr.on("data", bytes => { errorText = (errorText + String(bytes)).slice(-4000); });
  const timer = setTimeout(() => fail("YouTube 获取超时", "YOUTUBE_TIMEOUT"), options.timeoutMs);
  const monitor = options.directory && options.maxBytes ? setInterval(() => {
    if (checking) return;
    checking = true;
    void readdir(options.directory!).then(async files => {
      // HLS 分段合并后会立即删除；目录枚举与 stat 之间消失的文件不代表下载失败。
      const sizes = await Promise.all(files.map(name => stat(join(options.directory!, name)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { size: 0 };
        throw error;
      })));
      if (sizes.reduce((total, info) => total + info.size, 0) > options.maxBytes!) fail("YouTube 原文件超过下载上限", "ASSET_DOWNLOAD_TOO_LARGE");
    }).catch(() => fail("无法核对下载缓存大小", "YOUTUBE_OUTPUT_INVALID")).finally(() => { checking = false; });
  }, 250) : undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", error => reject(new AssetProviderError(`下载器不可用：${error.message}`, "YOUTUBE_DOWNLOADER_MISSING")));
      child.once("close", code => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new AssetProviderError(`YouTube 获取失败：${errorText}`, /No module named yt_dlp/u.test(errorText) ? "YOUTUBE_DOWNLOADER_MISSING" : /larger than max-filesize/u.test(errorText) ? "ASSET_DOWNLOAD_TOO_LARGE" : "YOUTUBE_DOWNLOAD_FAILED"));
      });
    });
    return output;
  } finally { clearTimeout(timer); if (monitor) clearInterval(monitor); child.kill(); }
};

export class YoutubeProvider implements AssetProvider {
  readonly name = "youtube";
  readonly previewHosts = ["i.ytimg.com", "www.youtube.com"];
  constructor(private readonly run: YoutubeRunner = runYoutubeDownloader) {}
  async search({ query }: Parameters<AssetProvider["search"]>[0]): Promise<ProviderSearchCandidate[]> {
    const selected = youtubeVideoUrl(query);
    const raw = await this.run(["--skip-download", "--dump-single-json", "--", selected.url], { timeoutMs: 60_000 });
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw); } catch { throw new AssetProviderError("下载器没有返回有效单视频元数据", "YOUTUBE_METADATA_INVALID"); }
    if (!data || typeof data !== "object" || data.id !== selected.id || data._type === "playlist" || data.is_live === true || data.live_status === "is_upcoming") throw new AssetProviderError("视频身份或直播状态不可用于当前获取", "YOUTUBE_METADATA_INVALID");
    const creator = typeof data.uploader === "string" ? data.uploader : undefined;
    return [{ originalAssetId: selected.id, sourceUrl: selected.url, name: typeof data.title === "string" ? data.title.slice(0, 240) : selected.id, kind: "video", durationMs: typeof data.duration === "number" && Number.isFinite(data.duration) && data.duration > 0 ? Math.round(data.duration * 1000) : undefined, creator, tags: ["youtube", "selected_page"] }];
  }
  async download({ candidate, temporaryDirectory, options }: Parameters<AssetProvider["download"]>[0]) {
    const acquisition = assetAcquisitionOptionsSchema.parse(options ?? {});
    const selected = youtubeVideoUrl(candidate.sourceUrl);
    if (selected.id !== candidate.originalAssetId) throw new AssetProviderError("候选页面与原视频 ID 不一致", "YOUTUBE_ID_MISMATCH");
    await mkdir(temporaryDirectory, { recursive: true });
    const maxBytes = readRuntimeConfig().downloads.maxAssetBytes;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new AssetProviderError("下载大小配置无效", "ASSET_DOWNLOAD_LIMIT_INVALID");
    // 先满足画质，再在同档格式中优先 HLS；不能因低清 HLS 存在而排除高清普通流。
    // 缺一段即失败，不能让 yt-dlp 默认跳段后把残缺原片登记为成功。
    const format = "bv*[ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=mp4]/b[ext=mp4]";
    const selection = ["-S", `${acquisition.qualityHeight ? `res:${acquisition.qualityHeight}` : "res"},proto:m3u8`];
    // 片段强制精确切口，避免关键帧前滚使本地零点错认成请求起点。
    const section = acquisition.sourceRange ? ["--download-sections", `*${acquisition.sourceRange.startMs / 1000}-${acquisition.sourceRange.endMs / 1000}`, "--force-keyframes-at-cuts"] : [];
    // 范围取得不能按整片预计字节数拒绝；实际写盘仍由缓存监控和最终大小检查约束。
    const sizeLimit = acquisition.sourceRange ? [] : ["--max-filesize", String(maxBytes)];
    await this.run(["--no-progress", "--no-part", "--restrict-filenames", "--abort-on-unavailable-fragments", "--concurrent-fragments", "4", ...sizeLimit, "-f", format, ...selection, ...section, "--merge-output-format", "mp4", "-o", join(temporaryDirectory, "source.%(ext)s"), "--", selected.url], { directory: temporaryDirectory, maxBytes: maxBytes * 2, timeoutMs: 600_000 });
    const files = (await readdir(temporaryDirectory)).filter(name => /^source\.(mp4|webm)$/u.test(name));
    if (files.length !== 1) throw new AssetProviderError("未取得单个完整视频；可能超限、不可访问或无可用整文件格式", "YOUTUBE_OUTPUT_INVALID");
    const fileName = files[0]!, filePath = join(temporaryDirectory, fileName), info = await stat(filePath);
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new AssetProviderError("视频为空或超出下载上限", "ASSET_DOWNLOAD_TOO_LARGE");
    return { filePath, fileName, contentType: fileName.endsWith(".mp4") ? "video/mp4" : "video/webm", sourceRange: acquisition.sourceRange };
  }
}
