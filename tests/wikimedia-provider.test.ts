import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssetCandidate, AssetRequest } from "@videocut/contracts";
import { AssetProviderError, downloadHttpFile } from "@videocut/acquisition";
import { WikimediaCommonsProvider } from "../packages/asset-acquisition/src/wikimedia-commons.js";

const request = { queryHints: ["城市", "夜晚"] } as AssetRequest;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function fileDetails(input: {
  title: string;
  mime: string;
  url: string;
  thumburl?: string;
  creator?: string;
  duration?: number;
  size?: number;
}): unknown {
  return {
    query: {
      pages: [{
        title: input.title,
        canonicalurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(input.title)}`,
        imageinfo: [{
          url: input.url,
          thumburl: input.thumburl ?? `${input.url}?width=640`,
          mime: input.mime,
          width: 1920,
          height: 1080,
          duration: input.duration,
          size: input.size ?? 100,
          extmetadata: {
            Artist: { value: input.creator ?? "<a href=\"/wiki/User:Author\">Author</a>" },
          }
        }]
      }]
    }
  };
}

test("Wikimedia Commons 批量读取媒体元数据，并保留没有许可信息的图片和视频", async () => {
  const detailTitles: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input.toString());
    if (url.searchParams.get("list") === "search") {
      return json({ query: { search: [
        { title: "File:Sunset.jpg" },
        { title: "File:Street.webm" },
        { title: "File:Incomplete.png" },
        { title: "File:Audio.ogg" }
      ] } });
    }
    const title = url.searchParams.get("titles");
    assert.ok(title);
    detailTitles.push(title);
    const details: Record<string, unknown> = {
      "File:Sunset.jpg": fileDetails({
        title: "File:Sunset.jpg",
        mime: "image/jpeg",
        url: "https://upload.wikimedia.org/sunset.jpg",
        creator: "<a href=\"/wiki/User:Alice\">Alice</a>",
      }),
      "File:Street.webm": fileDetails({
        title: "File:Street.webm",
        mime: "video/webm",
        url: "https://upload.wikimedia.org/street.webm",
        duration: 5.25
      }),
      "File:Incomplete.png": fileDetails({
        title: "File:Incomplete.png",
        mime: "image/png",
        url: "https://upload.wikimedia.org/incomplete.png",
      }),
      "File:Audio.ogg": fileDetails({
        title: "File:Audio.ogg",
        mime: "audio/ogg",
        url: "https://upload.wikimedia.org/audio.ogg",
      })
    };
    return json({ query: { pages: title.split('|').flatMap(name => (details[name] as { query: { pages: unknown[] } }).query.pages) } });
  };
  const provider = new WikimediaCommonsProvider({ apiEndpoint: "https://commons.test/w/api.php", fetchImpl });

  const candidates = await provider.search({ request, query: "city at night" });

  assert.deepEqual(detailTitles, ["File:Sunset.jpg|File:Street.webm|File:Incomplete.png|File:Audio.ogg"]);
  assert.equal(candidates.length, 3);
  const image = candidates.find((candidate) => candidate.originalAssetId === "File:Sunset.jpg")!;
  assert.equal(image.kind, "image");
  assert.equal(image.creator, "Alice");
  assert.equal(Object.hasOwn(image, "attribution"), false);
  assert.match(image.sourceUrl, /commons\.wikimedia\.org/u);
  const video = candidates.find((candidate) => candidate.originalAssetId === "File:Street.webm")!;
  assert.equal(video.kind, "video");
  assert.equal(video.previewUrl, "https://upload.wikimedia.org/street.webm");
  assert.deepEqual(provider.previewHosts, ["upload.wikimedia.org", "thumb.wikimedia.org"]);
  assert.equal(video.durationMs, 5_250);
  const incomplete = candidates.find((candidate) => candidate.originalAssetId === "File:Incomplete.png")!;
});

test("Commons API 的独立缩略图主机可供候选分析，近似域名及非 HTTPS 地址仍被拒绝", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "videocut-commons-preview-"));
  const previewUrl = "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ea/Book.jpg/960px-Book.jpg?utm_source=commons.wikimedia.org";
  const provider = new WikimediaCommonsProvider({ fetchImpl: async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("list") === "search") return json({ query: { search: [{ title: "File:Book.jpg" }] } });
    return json(fileDetails({ title: "File:Book.jpg", mime: "image/jpeg", url: "https://upload.wikimedia.org/Book.jpg", thumburl: previewUrl }));
  } });
  const [candidate] = await provider.search({ request, query: "library book" });
  assert.equal(candidate.previewUrl, previewUrl);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    assert.equal(init?.redirect, "error", "缩略图下载继续禁止隐式重定向");
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } });
  });
  try {
    // 使用 Worker 同一下载入口和 Provider 声明，防止只改搜索结果却仍无法分析。
    const downloaded = await downloadHttpFile(candidate.previewUrl!, root, "preview.jpg", "image", undefined, {}, { allowedHosts: provider.previewHosts });
    assert.equal(downloaded.contentType, "image/jpeg");
    assert.deepEqual([...await readFile(downloaded.filePath)], [0xff, 0xd8, 0xff, 0xd9]);
    for (const url of ["https://thumb.wikimedia.org.evil.test/image.jpg", "https://other.wikimedia.org/image.jpg", "http://thumb.wikimedia.org/image.jpg", "https://user@thumb.wikimedia.org/image.jpg", "https://thumb.wikimedia.org:444/image.jpg"]) {
      await assert.rejects(downloadHttpFile(url, root, "preview.jpg", "image", undefined, {}, { allowedHosts: provider.previewHosts }),
        (error: unknown) => error instanceof AssetProviderError && error.code === "ASSET_DOWNLOAD_HOST_REJECTED");
    }
    assert.deepEqual(calls, [previewUrl], "拒绝地址不发起网络请求");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Wikimedia Commons 下载保留扩展名，并校验实时元数据、MIME 与字节上限", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-wikimedia-test-"));
  try {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(input.toString());
      if (url.hostname === "commons.test") {
        return json(fileDetails({
          title: "File:Street scene.webm",
          mime: "video/webm",
          url: "https://upload.wikimedia.test/Street_scene.webm",
          size: 4
        }));
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "video/webm" } });
    };
    const provider = new WikimediaCommonsProvider({ apiEndpoint: "https://commons.test/w/api.php", fetchImpl, maxDownloadBytes: 16 });
    const downloaded = await provider.download({
      candidate: { originalAssetId: "File:Street scene.webm" } as AssetCandidate,
      temporaryDirectory: root
    });
    assert.equal(downloaded.fileName, "Street scene.webm");
    assert.equal(downloaded.contentType, "video/webm");
    assert.deepEqual([...await readFile(downloaded.filePath)], [1, 2, 3, 4]);

    // Candidate 在下载前再次与 Commons 当前元数据核对，避免图片/视频类型变化后按旧类型收录。
    await assert.rejects(
      () => provider.download({
        candidate: { originalAssetId: "File:Street scene.webm", kind: "image", mimeType: "image/png" } as AssetCandidate,
        temporaryDirectory: root
      }),
      (error: unknown) => error instanceof AssetProviderError && error.code === "WIKIMEDIA_DOWNLOAD_KIND_MISMATCH"
    );

    const htmlProvider = new WikimediaCommonsProvider({
      apiEndpoint: "https://commons.test/w/api.php",
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        if (url.hostname === "commons.test") return json(fileDetails({ title: "File:Bad.webp", mime: "image/webp", url: "https://upload.wikimedia.test/bad.webp" }));
        return new Response("<html>not media</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
    });
    await assert.rejects(
      () => htmlProvider.download({ candidate: { originalAssetId: "File:Bad.webp" } as AssetCandidate, temporaryDirectory: root }),
      (error: unknown) => error instanceof AssetProviderError && error.code === "WIKIMEDIA_DOWNLOAD_MIME_INVALID"
    );

    const tooLargeProvider = new WikimediaCommonsProvider({
      apiEndpoint: "https://commons.test/w/api.php",
      maxDownloadBytes: 3,
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        if (url.hostname === "commons.test") return json(fileDetails({ title: "File:Large.png", mime: "image/png", url: "https://upload.wikimedia.test/large.png", size: 4 }));
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } });
      }
    });
    await assert.rejects(
      () => tooLargeProvider.download({ candidate: { originalAssetId: "File:Large.png" } as AssetCandidate, temporaryDirectory: root }),
      (error: unknown) => error instanceof AssetProviderError && error.code === "WIKIMEDIA_DOWNLOAD_TOO_LARGE"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
