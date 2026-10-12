import type { AssetCandidate, AssetRequest } from "@videocut/contracts";
import { assetSingleAttemptFetch } from "./http.js";
import { AssetProviderError, downloadHttpFile, type AssetProvider, type ProviderSearchCandidate } from "./index.js";
import { MIXKIT_SOUND_CATEGORIES, MIXKIT_MUSIC_CATEGORIES, mixkitCategory } from "./sound-catalog.js";

const origin = "https://mixkit.co";
const plain = (value: string) => value.replace(/<[^>]*>/gu, " ").replace(/&amp;/gu, "&").replace(/&#39;/gu, "'").replace(/&quot;/gu, '"').replace(/\s+/gu, " ").trim();

/** 分类公开页不是搜索 API；明确限制单页，不能递归抓取或批量镜像。 */
export function parseMixkitSoundPage(html: string, sourceUrl: string): ProviderSearchCandidate[] {
  const candidates: ProviderSearchCandidate[] = [];
  for (const block of html.split('data-test-id="audio-player"').slice(1, 31)) {
    const id = block.match(/data-audio-player-item-id-value="(\d+)"/u)?.[1];
    const preview = block.match(/data-audio-player-preview-url-value="([^"]+)"/u)?.[1];
    const name = block.match(/<h2[^>]*class="item-grid-card__title"[^>]*>([\s\S]*?)<\/h2>/u)?.[1];
    const duration = block.match(/data-test-id="duration"[^>]*>\s*(\d+):(\d+)\s*</u);
    if (!id || !name || !preview || !new RegExp(`^https://assets\\.mixkit\\.co/active_storage/sfx/${id}/${id}-preview\\.mp3$`, "u").test(preview)) continue;
    candidates.push({ originalAssetId: id, name: plain(name), kind: "audio", sourceUrl,
      previewUrl: preview, durationMs: duration ? (Number(duration[1]) * 60 + Number(duration[2])) * 1000 : undefined,
      tags: ["mixkit", "sfx", ...Array.from(block.matchAll(/href="\/free-sound-effects\/([a-z-]+)\/"/gu), (match) => match[1])].slice(0, 10) });
  }
  if (!candidates.length) throw new AssetProviderError("Mixkit 页面没有可识别音效，可能结构已变化；不猜测下载链接", "MIXKIT_PAGE_CHANGED");
  return candidates;
}

export async function mixkitPage(path: string): Promise<string> {
  // 分类页偶尔迁到 discover/；只跟随有限的站内公开页，不把任意跳转当成可信来源。
  let page = new URL(path, origin);
  let response: Response | undefined;
  const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (page.origin !== origin || page.username || page.password || page.search || page.hash
      || !/^\/(?:free-sound-effects\/|free-stock-music\/)/u.test(page.pathname)) {
      throw new AssetProviderError("Mixkit 页面跳转超出已核验的公开目录", "MIXKIT_REDIRECT_REJECTED");
    }
    response = await assetSingleAttemptFetch(page, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location || redirects === 3) throw new AssetProviderError("Mixkit 页面跳转缺失或次数过多", "MIXKIT_REDIRECT_REJECTED");
    try { page = new URL(location, page); }
    catch { throw new AssetProviderError("Mixkit 页面跳转地址无效", "MIXKIT_REDIRECT_REJECTED"); }
  }
  if (!response) throw new AssetProviderError("Mixkit 页面响应缺失", "MIXKIT_PAGE_FAILED");
  if (response.status === 429) throw new AssetProviderError("Mixkit 限流，停止请求；不自动重试或更换身份", "MIXKIT_RATE_LIMITED");
  if (!response.ok) throw new AssetProviderError(`Mixkit 页面 HTTP ${response.status}`, "MIXKIT_PAGE_FAILED");
  if (!response.headers.get("content-type")?.includes("text/html")) throw new AssetProviderError("Mixkit 未返回正常公开页面", "MIXKIT_PAGE_CHANGED");
  const reader = response.body?.getReader();
  if (!reader) throw new AssetProviderError("Mixkit 页面正文缺失", "MIXKIT_PAGE_CHANGED");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 2_000_000) throw new AssetProviderError("Mixkit 页面超过单页读取上限", "MIXKIT_PAGE_TOO_LARGE");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

export class MixkitSoundProvider implements AssetProvider {
  readonly name = "mixkit";
  readonly previewHosts = ["assets.mixkit.co"];
  async search({ request, query }: { request: AssetRequest; query: string }) {
    if (request.mediaKind !== "audio") throw new AssetProviderError("Mixkit 音效只接受 audio 素材需求", "ASSET_REQUEST_KIND_MISMATCH");
    if (request.role === "bgm") throw new AssetProviderError("音乐请使用 mixkit_music 来源", "ASSET_REQUEST_KIND_MISMATCH");
    const category = mixkitCategory(query);
    if (!category || !(MIXKIT_SOUND_CATEGORIES as readonly string[]).includes(category)) {
      throw new AssetProviderError(`当前按单个公开分类浏览，query 可选：${MIXKIT_SOUND_CATEGORIES.join("、")}`, "MIXKIT_CATEGORY_REQUIRED");
    }
    const path = `/free-sound-effects/${category}/`;
    return parseMixkitSoundPage(await mixkitPage(path), `${origin}${path}`);
  }
  async download({ candidate, temporaryDirectory }: { candidate: AssetCandidate; temporaryDirectory: string }) {
    const id = candidate.originalAssetId;
    if (candidate.kind !== "audio" || !/^\d+$/u.test(id)) throw new AssetProviderError("无效的 Mixkit 音效身份", "MIXKIT_CANDIDATE_INVALID");
    const html = await mixkitPage(`/free-sound-effects/download/${id}/`);
    const url = html.match(/data-download--modal-url-value="([^"]+)"/u)?.[1];
    if (!url || !new RegExp(`^https://assets\\.mixkit\\.co/active_storage/sfx/${id}/${id}\\.wav$`, "u").test(url)) {
      throw new AssetProviderError("原站未提供对应 WAV 下载；不使用试听压缩版替代", "MIXKIT_DOWNLOAD_UNCONFIRMED");
    }
    return downloadHttpFile(url, temporaryDirectory, `mixkit-${id}.wav`, "audio", undefined, {}, { allowedHosts: ["assets.mixkit.co"] });
  }
}

export function parseMixkitMusicPage(html: string, sourceUrl: string): ProviderSearchCandidate[] {
  const candidates: ProviderSearchCandidate[] = [];
  for (const block of html.split('data-test-id="audio-player"').slice(1, 31)) {
    const id = block.match(/data-audio-player-item-id-value="(\d+)"/u)?.[1];
    const preview = block.match(/data-audio-player-preview-url-value="([^"]+)"/u)?.[1];
    const title = block.match(/<h2[^>]*class="item-grid-card__title"[^>]*>([\s\S]*?)<\/h2>/u)?.[1];
    const duration = block.match(/data-test-id="duration"[^>]*>\s*(\d+):(\d+)\s*</u);
    if (!id || !preview || !title || preview !== `https://assets.mixkit.co/music/${id}/${id}.mp3`) continue;
    const creator = block.match(/class="item-grid-music-preview__author"[^>]*>([\s\S]*?)<\/p>/u)?.[1];
    candidates.push({ originalAssetId: id, kind: "audio", name: plain(title), creator: creator && plain(creator), sourceUrl, previewUrl: preview,
      durationMs: duration ? (Number(duration[1]) * 60 + Number(duration[2])) * 1000 : undefined, tags: ["mixkit", "music", "online-video", ...Array.from(block.matchAll(/href="\/free-stock-music\/([a-z/-]+)\/"/gu), (match) => match[1])].slice(0, 15) });
  }
  if (!candidates.length) throw new AssetProviderError("音乐页面结构变化或没有可识别曲目", "MIXKIT_PAGE_CHANGED");
  return candidates;
}

export class MixkitMusicProvider implements AssetProvider {
  readonly name = "mixkit_music";
  readonly previewHosts = ["assets.mixkit.co"];
  async search({ request, query }: { request: AssetRequest; query: string }) {
    if (request.mediaKind !== "audio" || request.role !== "bgm") throw new AssetProviderError("音乐来源仅处理 BGM 需求", "ASSET_REQUEST_KIND_MISMATCH");
    const category = mixkitCategory(query, true);
    if (!category) throw new AssetProviderError(`请选择音乐分类：${MIXKIT_MUSIC_CATEGORIES.join("、")}`, "MIXKIT_CATEGORY_REQUIRED");
    // 音乐风格位于 tag/，情绪位于 mood/；分类迁移由有限同站跳转处理。
    const path = `/free-stock-music/${category.includes("/") ? category : `tag/${category}`}/`;
    return parseMixkitMusicPage(await mixkitPage(path), `${origin}${path}`);
  }
  async download({ candidate, temporaryDirectory }: { candidate: AssetCandidate; temporaryDirectory: string }) {
    const id = candidate.originalAssetId;
    if (!/^\d+$/u.test(id) || candidate.kind !== "audio") throw new AssetProviderError("音乐身份无效", "MIXKIT_CANDIDATE_INVALID");
    const html = await mixkitPage(`/free-stock-music/download/${id}/`);
    const url = html.match(/data-download--modal-url-value="([^"]+)"/u)?.[1];
    // 原站正式提供的音乐文件就是 MP3；重新读取下载页，不从试听路径推算原文件。
    if (url !== `https://assets.mixkit.co/music/${id}/${id}.mp3`) throw new AssetProviderError("音乐原文件获取地址无法确认", "MIXKIT_DOWNLOAD_UNCONFIRMED");
    return downloadHttpFile(url, temporaryDirectory, `mixkit-music-${id}.mp3`, "audio", undefined, {}, { allowedHosts: this.previewHosts });
  }
}
