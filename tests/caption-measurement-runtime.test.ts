import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRuntimeConfig } from "@videocut/project-overview";
import { createServer } from "../apps/server/src/app.js";
import { measureCaptionTextViaRuntime } from "../packages/quality-system/src/caption-measurement.js";
import { bindMotionFonts } from "../packages/motion-work/src/fonts.js";

const request = [{ font: "normal 700 40px Inter, Noto Sans SC, sans-serif", texts: ["能用多少水，解决的是总量。"] }];

test("无浏览器环境的MCP使用同版Runtime实测，只读且拒绝额外配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "caption-runtime-api-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const config = readRuntimeConfig({ environment: { WEB_ORIGIN: `http://127.0.0.1:${address.port}` } });
    assert.equal(config.runtime.browserExecutable, undefined);
    const measured = await measureCaptionTextViaRuntime(request, config);
    assert.ok(measured[0]![0]! > 400 && measured[0]![0]! < 588.8, "报障文本按真实字体装得下安全宽度");
    const { slot: _slot, ...registeredFont } = bindMotionFonts({ fontBindings: { caption: "noto-sans-sc-bold" } })[0]!;
    const registered = [{ font: `normal 700 40px ${registeredFont.family}`, texts: ["普通字幕"], registeredFont }];
    const fixed = await measureCaptionTextViaRuntime(registered, config);
    assert.equal(fixed[0]![0], 160, "独立 MCP 能经 Runtime 使用固定登记字体进行真实中文测量");
    await assert.rejects(measureCaptionTextViaRuntime([{ ...registered[0]!, registeredFont: { ...registeredFont, hash: "0".repeat(64) } }], config), /CAPTION_FONT_BINDING_INVALID/u);
    const wrongVersion = await app.inject({ method: "POST", url: "/api/captions/measure-text", payload: request });
    assert.equal(wrongVersion.json().error, "RUNTIME_RELEASE_MISMATCH");
    const invalid = await app.inject({ method: "POST", url: "/api/captions/measure-text",
      headers: { "x-videoflowcut-release-id": config.runtime.releaseId }, payload: [{ ...request[0], browserExecutable: "其它路径" }] });
    assert.equal(invalid.json().error, "VALIDATION_ERROR");
    assert.deepEqual(application.listProjects(), []);
  } finally { await app.close(); application.close(); await rm(root, { recursive: true, force: true }); }
});

test("测量失败、错版或不完整字宽不能作为通过，且不重试", async () => {
  let response: { status: number; release: string; body: unknown };
  let requests = 0;
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* 消费完整请求后返回可控故障。 */ }
    requests++;
    res.writeHead(response.status, { "content-type": "application/json", "x-videoflowcut-release-id": response.release });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = readRuntimeConfig({ environment: { WEB_ORIGIN: `http://127.0.0.1:${address.port}`, VIDEOFLOWCUT_RELEASE_ID: "release-test" } });
  try {
    const cases = [
      { status: 400, release: "release-test", body: { error: "RENDER_BROWSER_NOT_PREPARED", message: "部署依赖失效" } },
      { status: 200, release: "release-old", body: [[560]] },
      ...[[], [[]], [[-1]], [["560"]], [[560, 12]]].map(body => ({ status: 200, release: "release-test", body }))
    ];
    for (const item of cases) {
      response = item;
      const before = requests;
      await assert.rejects(measureCaptionTextViaRuntime(request, config));
      assert.equal(requests, before + 1);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
