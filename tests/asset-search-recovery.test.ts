import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetProviderError, AssetProviderRegistry, createDefaultAssetProviderRegistry, soundSourceCapabilities, type ProviderSearchCandidate } from "../packages/asset-acquisition/src/index.js";
import { createAssetFetch, retryAfterMilliseconds } from "../packages/asset-acquisition/src/http.js";
import { WikimediaCommonsProvider } from "../packages/asset-acquisition/src/wikimedia-commons.js";
import { assetSearchErrorResult } from "../apps/server/src/asset-search-errors.js";
import { createApplication } from "../packages/edit-application/src/index.js";
import type { AssetRequest } from "@videocut/contracts";

const request = { queryHints: [] } as unknown as AssetRequest;
test("Pexels 无 Key 时支持单视频页，其他旧接口仍不启用", (t) => {
  const pexelsKey = process.env.PEXELS_API_KEY;
  delete process.env.PEXELS_API_KEY;
  t.after(() => { if (pexelsKey === undefined) delete process.env.PEXELS_API_KEY; else process.env.PEXELS_API_KEY = pexelsKey; });
  for (const key of ["TAVILY_API_KEY", "FREESOUND_API_KEY", "FREESOUND_OAUTH_TOKEN", "FREESOUND_COMMERCIAL_API_APPROVED"]) {
    const previous = process.env[key];
    process.env[key] = "true";
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const registry = createDefaultAssetProviderRegistry();
  assert.deepEqual(registry.names(), ["mixkit", "mixkit_music", "pexels", "wikimedia-commons", "youtube"]);
  assert.ok(registry.catalog().every(source => !source.requiresKey && source.enabled));
  assert.equal(registry.catalog().find(source => source.id === "pexels")?.queryMode, "single_video_url_or_keywords_with_key");
  assert.deepEqual(soundSourceCapabilities().map(source => source.id), ["mixkit", "mixkit_music"]);
  for (const name of ["freesound", "tavily"]) {
    assert.throws(() => registry.get(name), (error: unknown) => error instanceof AssetProviderError && error.code === "ASSET_PROVIDER_UNKNOWN");
  }
});

test("Pexels 单视频页由浏览器交 Worker 获取，Skill 与路由一致", async () => {
  const sourcing = await readFile(".agents/skills/visual-asset-sourcing/references/acquisition-operations.md", "utf8");
  const importing = await readFile(".agents/skills/asset-import/SKILL.md", "utf8");
  assert.match(sourcing, /Pexels 单视频页与 Worker 获取/);
  assert.match(sourcing, /provider="pexels"[\s\S]*query=选定页面URL[\s\S]*search_media_candidates/);
  assert.match(sourcing, /acquire_media_asset[\s\S]*track_job[\s\S]*媒体 Worker/);
  assert.equal(sourcing.includes("usage_rights"), false);
  assert.match(importing, /浏览器无需交回本地路径，也不使用 `import_media` 代替 Provider/);
  assert.equal(sourcing, await readFile("plugins/videoflowcut/skills/visual-asset-sourcing/references/acquisition-operations.md", "utf8"));
  assert.equal(importing, await readFile("plugins/videoflowcut/skills/asset-import/SKILL.md", "utf8"));
});
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const details = (title: string, mime = "video/webm") => json({ query: { pages: [{ title, imageinfo: [{ url: "https://upload.wikimedia.org/fixture.webm", mime, width: 1920, height: 1080, duration: 5, extmetadata: {} }] }] } });

test("素材搜索恢复交接规则只授权无副作用的一次纠正", async () => {
  for (const file of [".agents/skills/visual-asset-sourcing/references/acquisition-operations.md", ".agents/skills/production-coordinator/references/project-writes.md", ".agents/skills/known-errors/references/runtime-errors.md", ".agents/skills/production-coordinator/references/project-writes.md"]) {
    const content = await readFile(file, "utf8");
    assert.match(content, /sideEffects/);
    assert.match(content, /safeToRetry/);
    assert.match(content, /一次/);
    assert.match(content, /下载/);
  }
});

test("图片搜索保留矢量图，正文超时不能误报为 JSON 格式错误", async () => {
  const source = new WikimediaCommonsProvider({ fetchImpl: async url => {
    const parsed = new URL(String(url));
    if (parsed.searchParams.has("list")) {
      assert.equal(parsed.searchParams.get("srsearch"), "phone filetype:bitmap|drawing");
      return json({ query: { search: [{ title: "File:phone.svg" }] } });
    }
    return details("File:phone.svg", "image/svg+xml");
  } });
  assert.equal((await source.search({ request, query: "phone", mediaType: "image" }))[0].mimeType, "image/svg+xml");
  const timed = new WikimediaCommonsProvider({ fetchImpl: async () => {
    const response = json({});
    response.json = async () => { throw new DOMException("超时", "TimeoutError"); };
    return response;
  } });
  await assert.rejects(timed.search({ request, query: "phone" }), (error: unknown) => error instanceof AssetProviderError && error.code === "ASSET_NETWORK_TIMEOUT");
});

test("未知名称给出准确目录；缺凭据与拼写错误分开，不能把写入未知标为可重试", () => {
  const registry = new AssetProviderRegistry([new WikimediaCommonsProvider()]);
  assert.equal(registry.catalog().find(p => p.id === "wikimedia-commons")?.requiresKey, false);
  assert.equal(registry.catalog().find(p => p.id === "pexels")?.enabled, false);
  assert.throws(() => registry.get("pexels"), (error: unknown) => error instanceof AssetProviderError && error.code === "ASSET_PROVIDER_NOT_CONFIGURED");
  try { registry.get("wikimedia"); assert.fail(); } catch (error) {
    const failure = JSON.parse(assetSearchErrorResult(error, true).content[0].text);
    assert.equal(failure.code, "ASSET_PROVIDER_UNKNOWN");
    assert.equal(failure.sideEffects, "none");
    assert.equal(failure.safeToRetry, true);
    assert.deepEqual(failure.availableProviders, ["wikimedia-commons"]);
    assert.equal(JSON.parse(assetSearchErrorResult(error, false).content[0].text).safeToRetry, false);
  }
});

test("批量详情遇到限流在持久化前失败，提供一次安全重查合同", async () => {
  let sentQuery = "";
  const source = new WikimediaCommonsProvider({ fetchImpl: async url => {
    const parsed = new URL(String(url));
    if (parsed.searchParams.has("list")) { sentQuery = parsed.searchParams.get("srsearch")!; return json({ query: { search: [{ title: "File:photo.jpg" }, { title: "File:video.webm" }, { title: "File:limited.webm" }, { title: "File:unread.webm" }] } }); }
    const title = parsed.searchParams.get("titles")!;
    assert.equal(title.split('|').length, 4);
    return new Response("稍后再试", { status: 429, headers: { "retry-after": "60" } });
  } });
  await assert.rejects(source.searchDetailed({ request, query: "smartphone filetype:bitmap", mediaType: "video" }), (error: unknown) => {
    const failure = JSON.parse(assetSearchErrorResult(error, true).content[0].text);
    assert.equal(failure.code, 'WIKIMEDIA_RATE_LIMITED');
    assert.equal(failure.stage, 'metadata');
    assert.equal(failure.retryAfterMs, 60_000);
    assert.equal(failure.sideEffects, 'none');
    assert.equal(failure.safeToRetry, true);
    return true;
  });
  assert.equal(sentQuery, "smartphone filetype:video");
});

test("批量详情失败不能伪装为无搜索结果", async () => {
  const source = new WikimediaCommonsProvider({ fetchImpl: async url => {
    const parsed = new URL(String(url));
    if (parsed.searchParams.has("list")) return json({ query: { search: [{ title: "File:bad.webm" }, { title: "File:ok.webm" }] } });
    return parsed.searchParams.get("titles")?.includes("bad") ? new Response("故障", { status: 500 }) : details("File:ok.webm");
  } });
  await assert.rejects(source.searchDetailed({ request, query: "phone" }), (error: unknown) => error instanceof AssetProviderError && error.details.stage === "metadata");
  const failing = new WikimediaCommonsProvider({ fetchImpl: async () => new Response("故障", { status: 503 }) });
  await assert.rejects(failing.searchDetailed({ request, query: "phone" }), (error: unknown) => error instanceof AssetProviderError && error.details.stage === "search");
});

test("遵守 Retry-After 且有限重试；长等待不提前请求，超时保留错误码", async () => {
  const waits: number[] = []; let calls = 0;
  const fetcher = createAssetFetch({ fetchImpl: async () => ++calls === 1 ? new Response("限流", { status: 429, headers: { "retry-after": "1" } }) : json({ ok: true }), sleep: async ms => { waits.push(ms); } });
  assert.equal((await fetcher("https://example.test")).status, 200);
  assert.deepEqual(waits, [1000]); assert.equal(calls, 2);
  calls = 0;
  const limited = createAssetFetch({ fetchImpl: async () => { calls++; return new Response("限流", { status: 429, headers: { "retry-after": "60" } }); } });
  assert.equal((await limited("https://example.test")).status, 429); assert.equal(calls, 1);
  assert.equal(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:05 GMT", 0), 5000);
  const timeout = createAssetFetch({ retries: 0, timeoutMs: 10, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); }) });
  const keepAlive = setTimeout(() => undefined, 100);
  try { await assert.rejects(timeout("https://example.test"), (error: unknown) => error instanceof AssetProviderError && error.code === "ASSET_NETWORK_TIMEOUT"); } finally { clearTimeout(keepAlive); }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

test("实际 HTTP 代理承接外网地址，本地 API 自动直连，不依赖 Node 启动参数", async () => {
  const sockets = new Set<Socket>(); let tunnels = 0;
  const origin = createServer((_req, res) => res.end("媒体内容"));
  const proxy = createServer();
  for (const server of [origin, proxy]) server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const originPort = await listen(origin);
  proxy.on("connect", (_req, socket, head) => {
    tunnels++;
    const upstream = connect(originPort, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
    sockets.add(upstream); upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
  });
  const port = await listen(proxy);
  try {
    const fetcher = createAssetFetch({ environment: { HTTP_PROXY: `http://127.0.0.1:${port}`, HTTPS_PROXY: `http://127.0.0.1:${port}` }, retries: 0 });
    assert.equal(await (await fetcher(`http://external-media.invalid:${originPort}/media`)).text(), "媒体内容");
    assert.equal(tunnels, 1);
    assert.equal(await (await fetcher(`http://127.0.0.1:${originPort}/api`)).text(), "媒体内容");
    assert.equal(tunnels, 1);
  } finally { for (const socket of sockets) socket.destroy(); await Promise.all([origin, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
});

test("部分搜索与视频类型存于操作表；恢复后重搜不复用残缺结果且不产生 Revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-search-recovery-")); const app = createApplication(root);
  try {
    const created = app.createProject({ name: "搜索恢复回归", profile: "visual_explainer" });
    const state = app.manageAssetRequirement({ projectId: created.snapshot.project.id, baseRevision: created.revision.number, action: "create", title: "手机操作", purpose: "测试素材恢复", visualBrief: "手机实拍", role: "b_roll", });
    const input = { projectId: state.snapshot.project.id, baseRevision: state.revision.number, assetRequestId: state.snapshot.assetRequests[0].id, provider: "wikimedia-commons", query: "phone" };
    const candidate: ProviderSearchCandidate = { originalAssetId: "File:phone.webm", name: "手机", kind: "video", sourceUrl: "https://commons.wikimedia.org/wiki/File:phone.webm", };
    const partial = app.recordAssetSearch({ ...input, mediaType: "video", candidates: [candidate], diagnostics: { complete: false, warnings: [{ code: "WIKIMEDIA_RATE_LIMITED", message: "部分详情未读取" }] } });
    assert.equal(app.repository.mediaIntelligence.searches(input.projectId)[0].diagnostics?.complete, false);
    const recovered = app.recordAssetSearch({ ...input, mediaType: "video", candidates: [candidate, { ...candidate, originalAssetId: "File:phone2.webm" }] });
    assert.equal(recovered.reused, false); assert.equal(recovered.candidates.length, 2); assert.notEqual(recovered.sessionId, partial.sessionId);
    const image = app.recordAssetSearch({ ...input, mediaType: "image", candidates: [] });
    assert.equal(image.reused, false);
    assert.equal(app.readProject(input.projectId).revision.number, state.revision.number);
  } finally { app.repository.close(); await rm(root, { recursive: true, force: true }); }
});
