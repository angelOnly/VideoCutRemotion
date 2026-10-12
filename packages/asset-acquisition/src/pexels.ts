import type { AssetCandidate } from "@videocut/contracts";
import { AssetProviderError, downloadHttpFile, saveProviderMediaResponse, type AssetProvider, type ProviderSearchInput, type ProviderSearchCandidate } from "./index.js";
import { assetDownloadFetch, assetFetch } from "./http.js";

const API = "https://api.pexels.com";
type VideoFile = { link?: string; file_type?: string; width?: number; height?: number };
type Video = { id?: number; url?: string; width?: number; height?: number; duration?: number; image?: string; user?: { name?: string }; video_files?: VideoFile[] };

/** 目标尺寸选能满足画面的最接近规格；没有足够大的源时取现有最高规格。 */
export function selectPexelsVideoFile(files: VideoFile[], targetHeight?: number): VideoFile | undefined {
  const ranked = [...files].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.width ?? 0) - (a.width ?? 0));
  return (targetHeight ? ranked.filter(file => (file.height ?? 0) >= targetHeight).at(-1) : undefined) ?? ranked[0];
}

export interface PexelsProviderOptions { apiKey?: string; fetchImpl?: typeof fetch; downloadFetchImpl?: typeof fetch; apiEndpoint?: string }

/** 只接受 Pexels 的单个视频页；页面标题不参与下载地址推断。 */
export function pexelsVideoPage(value: string): { id: string; url: string } {
  let page: URL;
  try { page = new URL(value.trim()); } catch { throw new AssetProviderError("请提供 Pexels 单视频页面", "PEXELS_URL_INVALID"); }
  const match = /^\/video\/(?:[a-z0-9-]*?)(\d+)\/?$/iu.exec(page.pathname);
  if (page.protocol !== "https:" || !["pexels.com", "www.pexels.com"].includes(page.hostname) || page.port || page.username || page.password || page.search || page.hash || !match) {
    throw new AssetProviderError("只支持 HTTPS Pexels 单视频页面", "PEXELS_URL_INVALID");
  }
  return { id: match[1]!, url: `https://www.pexels.com${page.pathname.endsWith("/") ? page.pathname : `${page.pathname}/`}` };
}

function pexelsMediaUrl(value: string, id: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "videos.pexels.com" && !url.port && !url.username && !url.password &&
      url.pathname.startsWith(`/video-files/${id}/`) && url.pathname.endsWith(".mp4");
  } catch { return false; }
}

/** API Key 可用于关键词搜索；无 Key 时只根据已确认的单视频页获取公开原件。 */
export class PexelsProvider implements AssetProvider {
  readonly name = "pexels";
  readonly previewHosts = ["images.pexels.com", "videos.pexels.com"];
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  private readonly downloadFetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(options: PexelsProviderOptions = {}) {
    this.key = (options.apiKey ?? process.env.PEXELS_API_KEY ?? "").trim();
    this.fetchImpl = options.fetchImpl ?? assetFetch;
    this.downloadFetchImpl = options.downloadFetchImpl ?? assetDownloadFetch;
    this.endpoint = options.apiEndpoint ?? API;
  }

  private async request(path: string, query?: URLSearchParams): Promise<{ videos?: Video[] } & Video> {
    if (!this.key) throw new AssetProviderError("Pexels API Key 未配置", "ASSET_PROVIDER_NOT_CONFIGURED", { provider: this.name, stage: "provider", recovery: "configure_provider" });
    const url = new URL(path, this.endpoint);
    if (query) url.search = query.toString();
    const response = await this.fetchImpl(url, { headers: { Authorization: this.key, Accept: "application/json" } });
    if (response.status === 401 || response.status === 403) throw new AssetProviderError("Pexels API 凭据无效或无视频权限", "PEXELS_AUTH_FAILED", { provider: this.name, stage: "provider", recovery: "configure_provider" });
    if (response.status === 429) throw new AssetProviderError("Pexels API 已限流", "PEXELS_RATE_LIMITED", { provider: this.name, stage: "search", recovery: "repair" });
    if (!response.ok) throw new AssetProviderError(`Pexels API 请求失败：HTTP ${response.status}`, "PEXELS_API_FAILED", { provider: this.name, stage: "search", recovery: "repair" });
    try { return await response.json() as { videos?: Video[] } & Video; }
    catch { throw new AssetProviderError("Pexels API 响应无法解析", "PEXELS_API_INVALID_RESPONSE", { provider: this.name, stage: "metadata", recovery: "repair" }); }
  }

  private candidate(video: Video): ProviderSearchCandidate | undefined {
    if (!Number.isSafeInteger(video.id) || !video.url || !/^https:\/\/www\.pexels\.com\/video\//u.test(video.url) || !video.video_files?.some(file => file.file_type === "video/mp4")) return undefined;
    return { originalAssetId: String(video.id), name: `Pexels video ${video.id}`, kind: "video", sourceUrl: video.url,
      previewUrl: video.image, mimeType: "video/mp4", width: video.width, height: video.height, durationMs: typeof video.duration === "number" && Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : undefined,
      creator: video.user?.name, tags: ["pexels"] };
  }

  private async publicMediaUrl(id: string, method: "HEAD" | "GET"): Promise<string> {
    const entry = `https://www.pexels.com/download/video/${id}/`;
    const redirect = await this.downloadFetchImpl(entry, { method, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    const location = redirect.headers.get("location");
    await redirect.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(redirect.status) || !location || !pexelsMediaUrl(location, id)) {
      throw new AssetProviderError("Pexels 公开下载入口未返回该视频的可信 MP4 地址", "PEXELS_DOWNLOAD_UNAVAILABLE");
    }
    return location;
  }

  async search(input: ProviderSearchInput): Promise<ProviderSearchCandidate[]> {
    if (input.request.mediaKind !== "visual" || input.mediaType && input.mediaType !== "video") throw new AssetProviderError("Pexels 来源仅支持视频需求", "ASSET_REQUEST_KIND_MISMATCH");
    const query = input.query.trim();
    if (/^https?:\/\//iu.test(query)) {
      const page = pexelsVideoPage(query);
      // 搜索阶段只查公开入口的响应头，提前发现失效视频；URL 路径不受 API Key 状态影响。
      await this.publicMediaUrl(page.id, "HEAD");
      return [{ originalAssetId: page.id, name: `Pexels video ${page.id}`, kind: "video", sourceUrl: page.url,
        mimeType: "video/mp4", tags: ["pexels", "selected_page"] }];
    }
    if (!this.key) throw new AssetProviderError("Pexels 关键词搜索需要 API Key；无 Key 时请先在浏览器选定单视频页", "PEXELS_SINGLE_PAGE_REQUIRED", { provider: this.name, stage: "search", recovery: "select_provider" });
    const result = await this.request("/videos/search", new URLSearchParams({ query, per_page: "15" }));
    return (result.videos ?? []).flatMap(video => { const candidate = this.candidate(video); return candidate ? [candidate] : []; });
  }

  async download({ candidate, temporaryDirectory, options }: Parameters<AssetProvider["download"]>[0]) {
    if (candidate.kind !== "video" || !/^\d+$/u.test(candidate.originalAssetId)) throw new AssetProviderError("Pexels 候选身份无效", "PEXELS_CANDIDATE_INVALID");
    const page = pexelsVideoPage(candidate.sourceUrl);
    if (page.id !== candidate.originalAssetId) throw new AssetProviderError("Pexels 候选页面与视频 ID 不一致", "PEXELS_CANDIDATE_CHANGED");
    if (!this.key || candidate.tags?.includes("selected_page")) {
      // 公开下载入口只允许跳转一次到该视频自己的媒体目录，避免跟随外站或内网地址。
      const location = await this.publicMediaUrl(page.id, "GET");
      const response = await this.downloadFetchImpl(location, { redirect: "error", signal: AbortSignal.timeout(120_000) });
      return saveProviderMediaResponse(response, temporaryDirectory, `pexels-${page.id}.mp4`, "video", "video/mp4");
    }
    const video = await this.request(`/videos/videos/${candidate.originalAssetId}`);
    if (String(video.id) !== candidate.originalAssetId || video.url !== candidate.sourceUrl) throw new AssetProviderError("Pexels 候选来源已变化", "PEXELS_CANDIDATE_CHANGED");
    const files = (video.video_files ?? []).filter(file => file.file_type === "video/mp4" && file.link && (() => { try { const url = new URL(file.link); return url.protocol === "https:" && url.hostname === "videos.pexels.com" && !url.username && !url.password; } catch { return false; } })());
    const file = selectPexelsVideoFile(files, options?.qualityHeight);
    if (!file?.link) throw new AssetProviderError("Pexels API 没有提供可信 MP4 原文件", "PEXELS_DOWNLOAD_UNAVAILABLE");
    return downloadHttpFile(file.link, temporaryDirectory, `pexels-${candidate.originalAssetId}.mp4`, "video", "video/mp4", {}, { allowedHosts: ["videos.pexels.com"] });
  }
}
