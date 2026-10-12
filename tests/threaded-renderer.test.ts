import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import test from "node:test";
import type { ProjectSnapshot } from "@videocut/contracts";
import { ThreadedRevisionRenderer } from "../apps/render-worker/src/threaded-renderer.js";

const snapshot = { marker: "不可变渲染输入" } as unknown as ProjectSnapshot;
const fixture = (body: string) => () => new Worker(`
  const {parentPort}=require('node:worker_threads');
  parentPort.on('message', (request) => { ${body} });
`, { eval: true });

test("源码入口能在独立线程预热真实渲染依赖并正常关闭", async () => {
  const renderer = new ThreadedRevisionRenderer();
  try { await renderer.prepare(); }
  finally { await renderer.close(); }
});

test("渲染线程同步阻塞时 API 仍能在原健康检查截止时间内响应", async () => {
  const renderer = new ThreadedRevisionRenderer(fixture(`
    if(request.action==='renderRange') {
      request.snapshot.marker='仅修改线程副本';
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2200);
    }
    parentPort.postMessage({id:request.id});
  `));
  const server = createServer((_request, response) => response.end("ready"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let completed = false;
  try {
    await renderer.prepare();
    const rendering = renderer.renderRange(snapshot, 0, 1, "未写文件的技术 fixture").then(() => { completed = true; });
    for (let sample = 0; sample < 4; sample++) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(1500) });
      assert.equal(await response.text(), "ready");
      assert.equal(completed, false, "应在渲染仍然阻塞期间取得健康响应");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rendering;
    assert.equal((snapshot as unknown as { marker: string }).marker, "不可变渲染输入");
  } finally {
    await renderer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("渲染失败保留错误码；独立后续请求可继续，原请求不会重放", async () => {
  const renderer = new ThreadedRevisionRenderer(fixture(`
    if(request.action==='render') parentPort.postMessage({id:request.id,error:{code:'MOTION_CACHE_CORRUPT',message:'帧缓存损坏'}});
    else parentPort.postMessage({id:request.id});
  `));
  try {
    await assert.rejects(renderer.render(snapshot, "不会生成"), { code: "MOTION_CACHE_CORRUPT", message: "帧缓存损坏" });
    await renderer.prepare();
  } finally { await renderer.close(); }
});

test("线程异常退出拒绝在途与后续请求，只报告一次致命故障且不重新执行", async () => {
  let created = 0;
  let fatal = 0;
  const renderer = new ThreadedRevisionRenderer(() => {
    created++;
    return fixture("process.exit(17);")();
  }, () => { fatal++; });
  try {
    await assert.rejects(renderer.prepare(), { code: "RENDER_THREAD_EXITED" });
    await assert.rejects(renderer.render(snapshot, "不会生成"), { code: "RENDER_THREAD_EXITED" });
    assert.equal(created, 1);
    assert.equal(fatal, 1);
  } finally { await renderer.close(); }
});

test("受控关闭不会伪报线程崩溃，也不会遗留等待中的请求", async () => {
  let fatal = 0;
  const renderer = new ThreadedRevisionRenderer(fixture(""), () => { fatal++; });
  const pending = assert.rejects(renderer.prepare(), { code: "RENDER_THREAD_EXITED" });
  await renderer.close();
  await pending;
  assert.equal(fatal, 0);
  await assert.rejects(renderer.prepare(), /渲染线程/u);
});
