import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRuntimeConfig } from "@videocut/project-overview";
import { inspectMotionReferenceViaRuntime } from "../apps/server/src/motion-reference-client.js";
import { createServer } from "../apps/server/src/app.js";

const sourceUrl = "https://remotionlab.com/showcase";
const releaseId = "release-test-runtime";

async function withEndpoint(
  response: { status?: number; release?: string; body: unknown },
  run: (config: ReturnType<typeof readRuntimeConfig>, requests: Array<{ method?: string; url?: string; release?: string; body: unknown }>) => Promise<void>
) {
  const requests: Array<{ method?: string; url?: string; release?: string; body: unknown }> = [];
  const server = createHttpServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ method: request.method, url: request.url, release: request.headers["x-videoflowcut-release-id"] as string, body: JSON.parse(Buffer.concat(chunks).toString()) });
    reply.writeHead(response.status ?? 200, { "content-type": "application/json", "x-videoflowcut-release-id": response.release ?? releaseId });
    reply.end(JSON.stringify(response.body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  // 故意不给 MCP 浏览器路径；有效依赖必须来自服务端，不能依靠开发 shell 环境。
  const config = readRuntimeConfig({ environment: { WEB_ORIGIN: `http://127.0.0.1:${address.port}`, VIDEOFLOWCUT_RELEASE_ID: releaseId } });
  try { await run(config, requests); }
  finally { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
}

test("无浏览器环境的 MCP 将原始审阅参数交给同版 Runtime，保留采样证据", async () => {
  const evidence = { sourceUrl, evidenceKind: "wall_clock_motion_samples", images: [{ elapsedMs: 0, data: "fixture-png" }, { elapsedMs: 1500, data: "fixture-png-next" }] };
  await withEndpoint({ body: evidence }, async (config, requests) => {
    assert.equal(config.runtime.browserExecutable, undefined);
    assert.deepEqual(await inspectMotionReferenceViaRuntime(sourceUrl, 0, 6000, config), evidence);
    assert.deepEqual(requests, [{ method: "POST", url: "/api/motion/inspect-reference", release: releaseId, body: { sourceUrl, previewIndex: 0, sampleDurationMs: 6000 } }]);
  });
});

test("Runtime 审阅失败只返回真实故障，不在 MCP 下载浏览器或自动重试", async () => {
  await withEndpoint({ status: 400, body: { error: "RENDER_BROWSER_NOT_PREPARED", message: "部署依赖已失效" } }, async (config, requests) => {
    await assert.rejects(inspectMotionReferenceViaRuntime(sourceUrl, undefined, 6000, config), /部署依赖已失效/u);
    assert.equal(requests.length, 1);
  });
});

test("旧版 Runtime 和空采样不能被包装成审阅成功", async () => {
  await withEndpoint({ release: "release-old", body: { sourceUrl, images: [{ elapsedMs: 0, data: "fixture-png" }] } }, async (config) => {
    await assert.rejects(inspectMotionReferenceViaRuntime(sourceUrl, undefined, 6000, config), /版本.*不一致/u);
  });
  for (const images of [[], [{ elapsedMs: -1, data: "fixture" }], [{ elapsedMs: 0, data: "" }]]) {
    await withEndpoint({ body: { sourceUrl, images } }, async (config) => {
      await assert.rejects(inspectMotionReferenceViaRuntime(sourceUrl, undefined, 6000, config), /有效.*采样/u);
    });
  }
});

test("Runtime 审阅入口先检查版本和参数，不创建视频项目或 Job", async () => {
  const root = await mkdtemp(join(tmpdir(), "videoflowcut-motion-reference-api-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  try {
    const mismatched = await app.inject({ method: "POST", url: "/api/motion/inspect-reference", payload: { sourceUrl } });
    assert.equal(mismatched.statusCode, 400);
    assert.equal(mismatched.json().error, "RUNTIME_RELEASE_MISMATCH");
    const headers = { "x-videoflowcut-release-id": readRuntimeConfig().runtime.releaseId };
    for (const payload of [{ sourceUrl, sampleDurationMs: 50 }, { sourceUrl, previewIndex: -1 }, { sourceUrl, browserExecutable: "/other" }]) {
      const invalid = await app.inject({ method: "POST", url: "/api/motion/inspect-reference", headers, payload });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().error, "VALIDATION_ERROR");
    }
    assert.deepEqual(application.listProjects(), []);
  } finally { await app.close(); application.close(); await rm(root, { recursive: true, force: true }); }
});
