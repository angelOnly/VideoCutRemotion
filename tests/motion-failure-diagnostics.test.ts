import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionDiagnostics } from "../apps/render-worker/src/motion-diagnostics.js";
import { errorDetail } from "../packages/job-runtime/src/error-detail.js";
import { closeMotionBrowser, renderManagedMotion, resolveMotionFontRequest } from "../apps/render-worker/src/motion-renderer.js";
import { bindMotionFonts, prepareMotionFonts } from "../packages/motion-work/src/fonts.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import { toolError } from "../apps/server/src/tool-error.js";
import { readJobDiagnostics } from "../apps/server/src/job-diagnostics.js";
import { z } from "zod";
import { motionFixture } from "./fixtures/managed-motion.js";

test("异常链保留原始堆栈，循环引用有界", () => {
  const primary = new Error("导航失败", { cause: new Error("连接断开") });
  assert.match(String(errorDetail(primary).stack), /导航失败/u);
  (primary.cause as Error).cause = primary;
  assert.ok(JSON.stringify(errorDetail(primary)).length < 10000);
});

test("诊断事件内容、stderr与进度写入均有限额，首次主动关闭原因不被覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-diagnostic-"));
  try {
    const checkpoints: unknown[] = [];
    const diagnostics = new MotionDiagnostics({ jobId: "job_test" }, state => checkpoints.push(state));
    diagnostics.stage("frame_rendering");
    diagnostics.terminate("frame_timeout"); diagnostics.terminate("normal_cleanup");
    for (let frame = 0; frame < 1000; frame++) { diagnostics.progress(frame); diagnostics.event("request_failed", { text: "x".repeat(100000) }); }
    diagnostics.browserStderr("中文".repeat(100000));
    const failure = await diagnostics.save(root, "job_test", new Error("首个错误"));
    assert.equal(failure.terminationRequestedBy, "frame_timeout");
    assert.equal(checkpoints.length, 1);
    const report = JSON.parse(await readFile(join(root, failure.reportPath), "utf8"));
    assert.equal(report.events.length, 100);
    assert.ok(JSON.stringify(report).length < 500000);
    const result = await readJobDiagnostics(root, { id: "job_test", result: { motionFailure: failure } } as any);
    assert.equal(result.available, true); assert.ok(Buffer.byteLength(result.browserStderr ?? "") <= 65536);
    await assert.rejects(readJobDiagnostics(root, { id: "job_other", result: { motionFailure: failure } } as any));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("关闭失去响应的浏览器有限时且记录主动终止", async () => {
  let killed = false;
  const diagnostics = new MotionDiagnostics({});
  await closeMotionBrowser({ close: () => new Promise(() => {}), process: () => ({ kill: () => { killed = true; } }) } as any, diagnostics, 10);
  assert.equal(killed, true); assert.equal(diagnostics.summary().terminationRequestedBy, "close_timeout");
});

test("真实页面初始化异常保留首条堆栈，失败不产生代理", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-page-error-"));
  const diagnostics = new MotionDiagnostics({ jobId: "job_test" });
  try {
    await assert.rejects(renderManagedMotion({ ...motionFixture, source: `import React from 'react';export default function Motion(){throw new Error('故障注入');}` }, root, {}, undefined, undefined, [], diagnostics), /故障注入/u);
    assert.equal(diagnostics.summary().stage, "animation_initialization");
    await assert.rejects(readFile(join(root, "preview.mp4")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("参数拒绝返回字段与无副作用，未知异常不宣称可重试", () => {
  const error = z.object({ background_opacity: z.number().min(0.1).max(1).nullable() }).safeParse({ background_opacity: 0 });
  assert.equal(error.success, false);
  if (!error.success) { const result = toolError(error.error, true); assert.equal(result.sideEffects, "none"); assert.equal("fields" in result && result.fields?.[0].field, "background_opacity"); }
  if (!error.success) assert.equal(toolError(error.error).sideEffects, "unknown");
  assert.equal(toolError(new Error("未知写入结果")).sideEffects, "unknown");
  assert.equal(toolError(new Error("未知写入结果")).safeToRetry, false);
});

test("三份大字体原件不再进入HTML，CDP响应低于管道上限，未知hash和外网拒绝", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-cdp-fonts-"));
  try {
    const work = motionSubmissionSchema.parse({ ...motionFixture, durationInFrames: 2, fontBindings: { a: "maoken-yanbo-song-black", b: "maoken-yanbo-song-semibold", c: "noto-sans-sc-bold" }, source: `import React from 'react';export default p=><div>{['a','b','c'].map(slot=><div key={slot} style={{fontFamily:p.fonts[slot].family,fontWeight:p.fonts[slot].weight,color:'white',fontSize:32}}>不能冷场</div>)}</div>` });
    const fonts = prepareMotionFonts(work, bindMotionFonts(work));
    const oldHtmlBytes = fonts.reduce((sum, font) => sum + Buffer.byteLength(font.dataUrl), 0);
    assert.ok(Math.ceil(oldHtmlBytes / 3) * 4 > 100 * 1024 * 1024, "旧字体内嵌响应会越过Chrome pipe容量");
    const diagnostics = new MotionDiagnostics({});
    const result = await renderManagedMotion(work, root, {}, undefined, undefined, fonts, diagnostics);
    assert.equal(result.frameHashes.length, 2);
    assert.ok(Number(diagnostics.summary().documentBytes) < 3 * 1024 * 1024);
    const font = fonts[0]!;
    assert.equal(resolveMotionFontRequest(`https://motion.invalid/fonts/${font.binding.hash}.${font.format}`, fonts), font);
    for (const url of [`https://motion.invalid/fonts/${"0".repeat(64)}.ttf`, `https://example.com/fonts/${font.binding.hash}.${font.format}`, `https://motion.invalid/fonts/../${font.binding.hash}.${font.format}`]) assert.equal(resolveMotionFontRequest(url, fonts), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
