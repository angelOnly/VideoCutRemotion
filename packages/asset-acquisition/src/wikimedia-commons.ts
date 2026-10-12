import { decodeSearchCursor, encodeSearchCursor } from "./cursor.js";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AssetCandidate, AssetRequest } from "@videocut/contracts";
import { readRuntimeConfig } from "@videocut/project-overview";
import { AssetProviderError, assertDownloadedProviderMedia, type AssetProvider, type ProviderDownload, type ProviderSearchCandidate, type ProviderSearchInput, type ProviderSearchResult } from "./index.js";
import { assetFetch, assetDownloadFetch, retryAfterMilliseconds } from "./http.js";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const DEFAULT_MAX_RESULTS = 12;
const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

type CommonsExtMetadataValue = { value?: unknown };

type CommonsImageInfo = {
  url?: unknown;
  thumburl?: unknown;
  mime?: unknown;
  width?: unknown;
  height?: unknown;
  size?: unknown;
  duration?: unknown;
  extmetadata?: Record<string, CommonsExtMetadataValue | undefined>;
};

type CommonsPage = {
  title?: unknown;
  missing?: unknown;
  canonicalurl?: unknown;
  fullurl?: unknown;
  imageinfo?: CommonsImageInfo[];
};

type CommonsSearchResponse = {
  continue?: { sroffset?: number; continue?: string };
  error?: { code?: unknown; info?: unknown };
  query?: { search?: Array<{ title?: unknown }> };
};

type CommonsFileResponse = {
  error?: { code?: unknown; info?: unknown };
  query?: { pages?: CommonsPage[] };
};

type WikimediaMediaKind = AssetCandidate["kind"];

/**
 * Commons 的每个候选都带真实 MIME、媒介类型和来源页；Application 会将这些字段
 * 写入 Candidate / Provenance，不能把静态图片降级伪装为视频素材。
 */
export interface WikimediaCommonsSearchCandidate extends ProviderSearchCandidate {
  kind: WikimediaMediaKind;
  mimeType: string;
}

export interface WikimediaCommonsProviderOptions {
  /** 测试可注入本地 API；生产默认连接 Wikimedia Commons 公共 API。 */
  apiEndpoint?: string;
  fetchImpl?: typeof fetch;
  maxResults?: number;
  maxDownloadBytes?: number;
  userAgent?: string;
}

type CommonsFileDetails = {
  title: string;
  sourceUrl: string;
  info: CommonsImageInfo;
};

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = positiveNumber(value);
  return number === undefined ? undefined : Math.floor(number);
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum?: number): number {
  const integer = positiveInteger(value) ?? fallback;
  return maximum === undefined ? integer : Math.min(maximum, integer);
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Commons extmetadata 中很多文字是 HTML；这里只提取人可读字段，不把标记写进项目来源记录。 */
function htmlToText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const decodeCodePoint = (value: string, radix: number): string => {
    const codePoint = Number.parseInt(value, radix);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
  };
  const decoded = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => ({
      nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'"
    })[entity.toLocaleLowerCase()] ?? " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => decodeCodePoint(hex, 16))
    .replace(/&#(\d+);/g, (_match, decimal: string) => decodeCodePoint(decimal, 10))
    .replace(/\s+/g, " ")
    .trim();
  return decoded || undefined;
}

function metadataText(metadata: CommonsImageInfo["extmetadata"], key: string): string | undefined {
  return htmlToText(nonEmptyText(metadata?.[key]?.value));
}

function mediaKindFromMime(mime: string | undefined): WikimediaMediaKind | undefined {
  if (!mime) return undefined;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return undefined;
}

function normalizedMime(value: string | undefined): string | undefined {
  const mime = value?.split(";", 1)[0]?.trim().toLocaleLowerCase();
  return mime || undefined;
}

function safeFileName(value: string): string {
  return basename(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") || "wikimedia-asset";
}

function sourcePageUrl(title: string): string {
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function mediaFileName(title: string, mediaUrl: string, mime: string): string {
  const fromTitle = title.replace(/^File:/iu, "").trim();
  const titleExtension = extname(fromTitle);
  if (/^\.[a-z0-9]{1,12}$/iu.test(titleExtension)) return safeFileName(fromTitle);

  let urlExtension = "";
  try {
    urlExtension = extname(basename(new URL(mediaUrl).pathname));
  } catch {
    // URL 已在下载前检查；此处保底，不让无扩展名破坏本地化流程。
  }
  if (/^\.[a-z0-9]{1,12}$/iu.test(urlExtension)) return safeFileName(`${fromTitle || "wikimedia-asset"}${urlExtension}`);

  const extensionByMime: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/ogg": ".ogv"
  };
  return safeFileName(`${fromTitle || "wikimedia-asset"}${extensionByMime[mime] ?? ""}`);
}

/**
 * 通过 Commons API 发现媒体，并对每个 File 页面重新读取 imageinfo/extmetadata。
 * 搜索结果只描述候选；下载仍会再次读取元数据，避免把短时直链放进 Revision。
 */
export class WikimediaCommonsProvider implements AssetProvider {
  readonly name = "wikimedia-commons";
  // Commons 的原文件与缩略图由两个精确主机提供；不放开其他子域名。
  readonly previewHosts = ["upload.wikimedia.org", "thumb.wikimedia.org"];
  private readonly apiEndpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResults: number;
  private readonly maxDownloadBytes: number;
  private readonly userAgent: string;

  constructor(options: WikimediaCommonsProviderOptions = {}) {
    this.apiEndpoint = options.apiEndpoint ?? COMMONS_API;
    this.fetchImpl = options.fetchImpl ?? assetFetch;
    this.downloadFetch = options.fetchImpl ?? assetDownloadFetch;
    this.maxResults = boundedPositiveInteger(options.maxResults, DEFAULT_MAX_RESULTS, 30);
    this.maxDownloadBytes = boundedPositiveInteger(
      options.maxDownloadBytes ?? readRuntimeConfig().downloads.maxWikimediaBytes,
      DEFAULT_MAX_DOWNLOAD_BYTES
    );
    this.userAgent = options.userAgent?.trim() || "VideoFlowCut/0.1 (Wikimedia Commons asset provider)";
  }

  private readonly downloadFetch: typeof fetch;

  private async request<T extends { error?: { code?: unknown; info?: unknown } }>(parameters: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const url = new URL(this.apiEndpoint);
    const query = new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", ...parameters });
    url.search = query.toString();
    const response = await this.fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": this.userAgent }, signal });
    if (response.status === 429) {
      const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
      await response.body?.cancel();
      throw new AssetProviderError("Wikimedia Commons 请求过于频繁，请按返回等待时间稍后再试", "WIKIMEDIA_RATE_LIMITED", { retryAfterMs, recovery: "retry_search" });
    }
    if (!response.ok) throw new AssetProviderError(`Wikimedia Commons 查询失败：HTTP ${response.status}`, "WIKIMEDIA_API_FAILED");
    let decoded: T;
    try {
      decoded = await response.json() as T;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) {
        throw new AssetProviderError("Wikimedia Commons 响应正文读取超时", "ASSET_NETWORK_TIMEOUT", { recovery: "repair" });
      }
      throw new AssetProviderError("Wikimedia Commons 返回了无法解析的响应", "WIKIMEDIA_API_INVALID_RESPONSE");
    }
    if (decoded.error) {
      const code = nonEmptyText(decoded.error.code) ?? "unknown";
      const info = nonEmptyText(decoded.error.info) ?? "未知错误";
      throw new AssetProviderError(`Wikimedia Commons API 错误（${code}）：${info}`, "WIKIMEDIA_API_ERROR");
    }
    return decoded;
  }

  private async readFileDetails(title: string, signal?: AbortSignal): Promise<CommonsFileDetails | undefined> {
    return (await this.readFilesDetails([title], signal))[0];
  }

  private async readFilesDetails(titles: string[], signal?: AbortSignal): Promise<CommonsFileDetails[]> {
    const response = await this.request<CommonsFileResponse>({
      titles: titles.join("|"),
      prop: "imageinfo|info",
      inprop: "url",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: "640"
    }, signal);
    return (response.query?.pages ?? []).flatMap((page) => {
      const info = page.imageinfo?.[0];
      const title = nonEmptyText(page.title);
      if (page.missing || !info || !title) return [];
      const canonicalUrl = nonEmptyText(page.canonicalurl) ?? nonEmptyText(page.fullurl);
      return [{ title, sourceUrl: isHttpUrl(canonicalUrl) ? canonicalUrl : sourcePageUrl(title), info }];
    });
  }

  private candidateFromDetails(details: CommonsFileDetails, request: AssetRequest): WikimediaCommonsSearchCandidate | undefined {
    const mimeType = normalizedMime(nonEmptyText(details.info.mime));
    const kind = mediaKindFromMime(mimeType);
    const mediaUrl = nonEmptyText(details.info.url);
    if (!kind || !mimeType || !isHttpUrl(mediaUrl)) return undefined;

    const creator = metadataText(details.info.extmetadata, "Artist");
    const durationSeconds = positiveNumber(details.info.duration);

    return {
      originalAssetId: details.title,
      name: details.title.replace(/^File:/iu, ""),
      kind,
      mimeType,
      sourceUrl: details.sourceUrl,
      // 视频缩略图通常是 JPEG，不能把静态封面交给视频分析器。
      previewUrl: kind === "video" ? mediaUrl : nonEmptyText(details.info.thumburl) ?? mediaUrl,
      width: positiveInteger(details.info.width),
      height: positiveInteger(details.info.height),
      durationMs: kind === "video" && durationSeconds !== undefined ? Math.round(durationSeconds * 1_000) : undefined,
      creator,
      tags: ["wikimedia-commons", kind, ...request.queryHints]
    };
  }

  async search(input: ProviderSearchInput): Promise<WikimediaCommonsSearchCandidate[]> {
    return (await this.searchDetailed(input)).candidates as WikimediaCommonsSearchCandidate[];
  }

  async searchDetailed(input: ProviderSearchInput): Promise<ProviderSearchResult> {
    if (input.mediaType === "audio") throw new AssetProviderError("Commons 视觉入口仅支持图片或视频", "ASSET_MEDIA_TYPE_UNSUPPORTED", { recovery: "change_media_type", stage: "provider" });
    const offset = decodeSearchCursor(this.name, input);
    let query = input.query.trim();
    if (!query) return { candidates: [], complete: true, warnings: [] };
    // 显式类型优先于关键词里的 filetype，返回后还会复核真实 MIME。
    // CirrusSearch 的同一字段多值用 |；括号内 OR 会让这个过滤表达式返回零结果。
    if (input.mediaType) query = `${query.replace(/\bfiletype:\S+/giu, "").trim()} ${input.mediaType === "image" ? "filetype:bitmap|drawing" : "filetype:video"}`;
    const signal = AbortSignal.timeout(45_000);
    let response: CommonsSearchResponse;
    try { response = await this.request<CommonsSearchResponse>({
      list: "search",
      srnamespace: "6",
      srlimit: String(this.maxResults),
      srsearch: query,
      ...(offset !== undefined ? { sroffset: String(offset) } : {})
    }, signal); } catch (error) { throw this.stageError(error, "search"); }
    const titles = [...new Set((response.query?.search ?? []).map((entry) => nonEmptyText(entry.title)).filter((title): title is string => Boolean(title)))];
    const next = response.continue?.sroffset;
    const continuation = Number.isSafeInteger(next) && next! > (offset ?? 0) ? { nextCursor: encodeSearchCursor(this.name, input, next!) } : {};
    if (!titles.length) return { candidates: [], complete: true, warnings: [], ...continuation };
    // MediaWiki 支持一次读取至多 50 个标题，各页保留独立来源。避免连续详情请求触发限流。
    let details: CommonsFileDetails[];
    try { details = await this.readFilesDetails(titles, signal); }
    catch (error) { throw this.stageError(error, "metadata"); }
    const candidates = details.flatMap(detail => {
      const candidate = this.candidateFromDetails(detail, input.request);
      return candidate && (!input.mediaType || candidate.kind === input.mediaType) ? [candidate] : [];
    });
    return { candidates, complete: true, warnings: [], ...continuation };
  }

  private stageError(error: unknown, stage: "search" | "metadata"): AssetProviderError {
    if (error instanceof AssetProviderError) return new AssetProviderError(error.message, error.code, { ...error.details, stage, provider: this.name });
    return new AssetProviderError("Commons 请求未完成，请检查网络连接", "ASSET_NETWORK_FAILED", { stage, provider: this.name, recovery: "repair" });
  }

  async download(input: { candidate: AssetCandidate; temporaryDirectory: string }): Promise<ProviderDownload> {
    const details = await this.readFileDetails(input.candidate.originalAssetId);
    if (!details) throw new AssetProviderError("Wikimedia Commons 候选已不存在或缺少媒体元数据", "WIKIMEDIA_FILE_METADATA_MISSING");
    const mimeType = normalizedMime(nonEmptyText(details.info.mime));
    const mediaUrl = nonEmptyText(details.info.url);
    const actualKind = mediaKindFromMime(mimeType);
    if (!actualKind || !mimeType || !isHttpUrl(mediaUrl)) {
      throw new AssetProviderError("Wikimedia Commons 候选不是可下载的图片或视频媒体", "WIKIMEDIA_FILE_MIME_INVALID");
    }
    // 下载前再次核验远端文件类型，避免搜索后媒体被替换时仍按旧 Candidate 的 Asset kind 入库。
    if (input.candidate.kind && input.candidate.kind !== actualKind) {
      throw new AssetProviderError(`Wikimedia Commons 当前媒体类型与候选不一致：${actualKind} / ${input.candidate.kind}`, "WIKIMEDIA_DOWNLOAD_KIND_MISMATCH");
    }
    const candidateMimeType = normalizedMime(input.candidate.mimeType);
    if (candidateMimeType && candidateMimeType !== mimeType) {
      throw new AssetProviderError(`Wikimedia Commons 当前 MIME 与候选不一致：${mimeType} / ${candidateMimeType}`, "WIKIMEDIA_DOWNLOAD_MIME_MISMATCH");
    }
    const knownSize = positiveInteger(details.info.size);
    if (knownSize !== undefined && knownSize > this.maxDownloadBytes) {
      throw new AssetProviderError(`素材文件超过 ${Math.floor(this.maxDownloadBytes / 1024 / 1024)}MB 下载上限`, "WIKIMEDIA_DOWNLOAD_TOO_LARGE");
    }

    const response = await this.downloadFetch(mediaUrl, { redirect: "follow", headers: { Accept: "image/*,video/*;q=0.9" } });
    if (!response.ok) throw new AssetProviderError(`Wikimedia Commons 下载失败：HTTP ${response.status}`, "WIKIMEDIA_DOWNLOAD_HTTP_ERROR");
    const contentType = normalizedMime(response.headers.get("content-type") ?? undefined);
    if (!mediaKindFromMime(contentType)) {
      throw new AssetProviderError(`下载内容不是图片或视频媒体：${contentType || "未知 MIME"}`, "WIKIMEDIA_DOWNLOAD_MIME_INVALID");
    }
    if (contentType !== mimeType) {
      throw new AssetProviderError(`下载内容 MIME 与 Commons 元数据不一致：${contentType} / ${mimeType}`, "WIKIMEDIA_DOWNLOAD_MIME_MISMATCH");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxDownloadBytes) {
      throw new AssetProviderError(`素材文件超过 ${Math.floor(this.maxDownloadBytes / 1024 / 1024)}MB 下载上限`, "WIKIMEDIA_DOWNLOAD_TOO_LARGE");
    }
    if (!response.body) throw new AssetProviderError("Wikimedia Commons 下载响应缺少媒体正文", "WIKIMEDIA_DOWNLOAD_BODY_MISSING");

    await mkdir(input.temporaryDirectory, { recursive: true });
    const fileName = mediaFileName(details.title, mediaUrl, mimeType);
    const targetPath = join(input.temporaryDirectory, fileName);
    const maxDownloadBytes = this.maxDownloadBytes;
    let downloadedBytes = 0;
    const byteLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        if (downloadedBytes > maxDownloadBytes) {
          callback(new AssetProviderError(`素材文件超过 ${Math.floor(maxDownloadBytes / 1024 / 1024)}MB 下载上限`, "WIKIMEDIA_DOWNLOAD_TOO_LARGE"));
          return;
        }
        callback(null, chunk);
      }
    });
    try {
      await pipeline(Readable.fromWeb(response.body as never), byteLimit, createWriteStream(targetPath));
      await assertDownloadedProviderMedia({
        filePath: targetPath,
        contentType,
        expectedKind: actualKind,
        expectedMimeType: mimeType
      });
    } catch (error) {
      await rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { filePath: targetPath, fileName, contentType };
  }
}
