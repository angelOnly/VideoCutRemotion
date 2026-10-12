import assert from "node:assert/strict";
import fs, { type ReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { get } from "node:http";
import { Readable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectSnapshot } from "@videocut/contracts";
import { startProjectMediaServer } from "../apps/render-worker/src/exporter.js";

test("渲染媒体Range反复取消后关闭文件句柄，服务仍可正常读取", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "videocut-render-stream-"));
  const path = join(root, "large.mp4");
  const file = await open(path, "w");
  await file.truncate(32 * 1024 * 1024);
  await file.close();
  const streams: ReadStream[] = [];
  const original = fs.createReadStream;
  const mocked = t.mock.method(fs, "createReadStream", (...args: Parameters<typeof original>) => {
    const stream = original(...args);
    streams.push(stream);
    return stream;
  });
  syncBuiltinESMExports();
  const media = await startProjectMediaServer({ project: { id: "stream-fixture", rootPath: root } } as ProjectSnapshot);
  try {
    // 读到首块就模拟浏览器 seek/取消，文件剩余部分尚未发送，不能仅 unpipe 而不 close。
    for (let index = 0; index < 24; index++) {
      await new Promise<void>((resolve, reject) => {
        const request = get(`${media.mediaBaseUrl}/media/stream-fixture/large.mp4`, { headers: { Range: "bytes=0-" }, agent: false }, (response) => {
          response.once("data", () => { response.destroy(); resolve(); });
          response.once("error", () => {});
        });
        request.once("error", reject);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(streams.length, 24, "必须覆盖真实媒体服务创建的文件流");
    assert.equal(streams.filter((stream) => !stream.closed).length, 0, "取消请求不得遗留打开的文件流");
    const response = await fetch(`${media.mediaBaseUrl}/media/stream-fixture/large.mp4`, { headers: { Range: "bytes=10-29" } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 20);
  } finally {
    // 旧代码复现失败也必须清理fixture自己的句柄，不能影响测试进程或正式Runtime。
    for (const stream of streams) stream.destroy();
    await media.close();
    mocked.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("渲染媒体读取异步失败不会杀死服务，关闭会回收暂停的流", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "videocut-render-stream-error-"));
  const file = await open(join(root, "large.mp4"), "w");
  await file.truncate(32 * 1024 * 1024);
  await file.close();
  const original = fs.createReadStream;
  const streams: ReadStream[] = [];
  let failNext = true;
  const mocked = t.mock.method(fs, "createReadStream", (...args: Parameters<typeof original>) => {
    if (failNext) {
      failNext = false;
      return new Readable({ read() { this.destroy(new Error("模拟异步磁盘读取失败")); } }) as ReadStream;
    }
    const stream = original(...args);
    streams.push(stream);
    return stream;
  });
  syncBuiltinESMExports();
  const media = await startProjectMediaServer({ project: { id: "fixture", rootPath: root } } as ProjectSnapshot);
  let closed = false;
  try {
    await assert.rejects(fetch(`${media.mediaBaseUrl}/media/fixture/large.mp4`));
    const normal = await fetch(`${media.mediaBaseUrl}/media/fixture/large.mp4`, { headers: { Range: "bytes=4-13" } });
    assert.equal((await normal.arrayBuffer()).byteLength, 10);
    const response = await new Promise<import("node:http").IncomingMessage>((done, reject) => {
      const request = get(`${media.mediaBaseUrl}/media/fixture/large.mp4`, { agent: false }, (incoming) => { incoming.on("error", () => {}); incoming.pause(); done(incoming); });
      request.on("error", reject);
    });
    await media.close();
    closed = true;
    response.destroy();
    assert.ok(streams.every((stream) => stream.closed), "关闭服务必须等待文件流实际关闭");
  } finally {
    for (const stream of streams) stream.destroy();
    if (!closed) await media.close();
    mocked.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
