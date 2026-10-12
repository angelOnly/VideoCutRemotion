import assert from "node:assert/strict";
import test from "node:test";
import { AssetProviderError } from "../packages/asset-acquisition/src/index.js";
import { PexelsProvider, pexelsVideoPage, selectPexelsVideoFile } from "../packages/asset-acquisition/src/pexels.js";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetRequest, AssetCandidate } from "@videocut/contracts";

const video = { id: 7914832, url: "https://www.pexels.com/video/a-woman-live-streaming-using-her-cellphone-7914832/", duration: 10, width: 1920, height: 1080, user: { name: "RDNE Stock project" }, video_files: [{ link: "https://videos.pexels.com/video-files/7914832/test.mp4", file_type: "video/mp4", width: 1280, height: 720 }] };
const request = { mediaKind: "visual" } as unknown as AssetRequest;

test("Pexels API 关键词候选保留来源与可核验时长", async () => {
  const provider = new PexelsProvider({ apiKey: "test-key", fetchImpl: async (url, init) => {
    assert.match(String(url), /\/videos\/search\?query=phone/u);
    assert.equal((init?.headers as Record<string, string>).Authorization, "test-key");
    return new Response(JSON.stringify({ videos: [video] }), { status: 200 });
  } });
  const candidates = await provider.search({ request, query: "phone" });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].durationMs, 10_000);
  assert.equal(candidates[0].creator, "RDNE Stock project");
});

test("Pexels 缺少时长和尺寸仍保留候选；规格按用途选择而非默认最小", async () => {
  const provider = new PexelsProvider({ apiKey: "test-key", fetchImpl: async () => new Response(JSON.stringify({ videos: [{ ...video, duration: undefined, width: undefined, height: undefined }] })) });
  const candidates = await provider.search({ request, query: "phone" });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].durationMs, undefined);
  const files = [{ height: 720, width: 1280 }, { height: 2160, width: 3840 }, { height: 1080, width: 1920 }];
  assert.equal(selectPexelsVideoFile(files)?.height, 2160);
  assert.equal(selectPexelsVideoFile(files, 1080)?.height, 1080);
  assert.equal(selectPexelsVideoFile(files, 1440)?.height, 2160);
  assert.equal(selectPexelsVideoFile(files, 4320)?.height, 2160);
});

test("Pexels 无凭据只接受单视频页，拒绝跨视频或外站地址", async () => {
  const absent = new PexelsProvider({ apiKey: "", downloadFetchImpl: async (_url, init) => {
    assert.equal(init?.method, "HEAD");
    return new Response(null, { status: 302, headers: { location: "https://videos.pexels.com/video-files/7914832/test.mp4" } });
  } });
  const candidates = await absent.search({ request, query: video.url });
  assert.equal(candidates[0].originalAssetId, "7914832");
  await assert.rejects(absent.search({ request, query: "phone" }), (error: unknown) => error instanceof AssetProviderError && error.code === "PEXELS_SINGLE_PAGE_REQUIRED");
  for (const url of ["http://www.pexels.com/video/test-7914832/", "https://pexels.com.evil.test/video/test-7914832/", "https://www.pexels.com/video/test-7914832/?x=1"]) {
    assert.throws(() => pexelsVideoPage(url), (error: unknown) => error instanceof AssetProviderError && error.code === "PEXELS_URL_INVALID");
  }
  await assert.rejects(absent.download({ candidate: { kind: "video", originalAssetId: "12", sourceUrl: video.url } as AssetCandidate, temporaryDirectory: "unused" }), (error: unknown) => error instanceof AssetProviderError && error.code === "PEXELS_CANDIDATE_CHANGED");
  const rejected = new PexelsProvider({ apiKey: "", downloadFetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://videos.pexels.com/video-files/999/test.mp4" } }) });
  await assert.rejects(rejected.search({ request, query: video.url }), (error: unknown) => error instanceof AssetProviderError && error.code === "PEXELS_DOWNLOAD_UNAVAILABLE");
  await assert.rejects(rejected.download({ candidate: { kind: "video", originalAssetId: "7914832", sourceUrl: video.url } as AssetCandidate, temporaryDirectory: "unused" }), (error: unknown) => error instanceof AssetProviderError && error.code === "PEXELS_DOWNLOAD_UNAVAILABLE");
});

test("Pexels 公开入口只获取同 ID 的 MP4 并交给媒体校验", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vfc-pexels-test-"));
  const calls: string[] = [];
  const provider = new PexelsProvider({ apiKey: "", downloadFetchImpl: async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) {
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.method, "GET");
      return new Response(null, { status: 302, headers: { location: "https://videos.pexels.com/video-files/7914832/7914832-hd.mp4" } });
    }
    assert.equal(init?.redirect, "error");
    return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), { headers: { "content-type": "video/mp4" } });
  } });
  try {
    const downloaded = await provider.download({ candidate: { kind: "video", originalAssetId: "7914832", sourceUrl: video.url } as AssetCandidate, temporaryDirectory: directory });
    assert.equal((await stat(downloaded.filePath)).size, 12);
    assert.deepEqual(calls, ["https://www.pexels.com/download/video/7914832/", "https://videos.pexels.com/video-files/7914832/7914832-hd.mp4"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Pexels API 模式拒绝不可信文件链接", async () => {
  const provider = new PexelsProvider({ apiKey: "test-key", fetchImpl: async () => new Response(JSON.stringify({ ...video, video_files: [{ link: "https://invalid.example/test.mp4", file_type: "video/mp4" }] }), { status: 200 }) });
  await assert.rejects(provider.download({ candidate: { kind: "video", originalAssetId: "7914832", sourceUrl: video.url } as AssetCandidate, temporaryDirectory: "unused" }), (error: unknown) => error instanceof AssetProviderError && error.code === "PEXELS_DOWNLOAD_UNAVAILABLE");
});
