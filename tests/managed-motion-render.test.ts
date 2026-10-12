import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeMotionPng, renderManagedMotion, verifyMotionPreviewFrames } from "../apps/render-worker/src/motion-renderer.js";
import { runProcess } from "@videocut/speech";
import { motionFixture } from "./fixtures/managed-motion.js";
import { PNG } from "pngjs";
import { createApplication } from "@videocut/application";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";

test("新作品不保存安全区测量，带旧测量字段的缓存仍校验实际帧并复用", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-retired-safety-cache-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "退役测量缓存回归" });
    const projectId = created.snapshot.project.id;
    const job = app.submitManagedMotion({ projectId, baseRevision: 1, idempotencyKey: "retired-safety-cache", work: {
      ...motionFixture, durationInFrames: 2,
      source: "import React from 'react';export default function M(){return <div style={{position:'absolute',inset:0,background:'rgba(255,255,255,0.5)'}}/>}"
    } });
    const result = await runMotionJob(app, job);
    const state = app.readProject(projectId);
    const asset = state.snapshot.assets.find(entry => entry.id === result.assetId)!;
    assert.equal(Object.hasOwn(asset.motion!, "visibility"), false);
    const manifestPath = join(state.snapshot.project.rootPath, asset.motion!.framesDirectory, "..", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(Object.hasOwn(manifest, "visibility"), false);
    // 旧附加字段已经失去运行语义，不应引发补测或破坏合法作品缓存。
    manifest.visibility = { method: "png_alpha_bbox_v1", alphaThreshold: 1, frames: [] };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const replay = await runMotionJob(app, job, async () => { assert.fail("已有完整缓存不能再次渲染"); });
    assert.equal(replay.assetId, result.assetId);
    assert.equal(app.readProject(projectId).revision.number, state.revision.number);
    const framePath = join(state.snapshot.project.rootPath, asset.motion!.framesDirectory, "frame-00000.png");
    await writeFile(framePath, "损坏帧");
    await assert.rejects(runMotionJob(app, job, async () => { assert.fail("损坏缓存不能静默重生"); }));
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("PNG 归一化保持彩色与半透明像素，拒绝损坏文件和错误画幅", () => {
  const data = Buffer.from([188, 131, 47, 255, 27, 83, 72, 127]);
  const png = new PNG({ width: 2, height: 1 });
  png.data = data;
  const encoded = PNG.sync.write(png);
  assert.deepEqual(PNG.sync.read(normalizeMotionPng(encoded, 2, 1)).data, data);
  assert.throws(() => normalizeMotionPng(encoded, 1, 2), /MOTION_OUTPUT_MISMATCH/u);
  assert.throws(() => normalizeMotionPng(Buffer.from("invalid"), 2, 1));
});

test("深色渐变帧无损压缩后满足缓存预算，颜色与透明度不降级", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-gradient-"));
  try {
    const source = `import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(){return <div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse at 48% 40%,#182127,#0b1014 52%,#050709)',opacity:useCurrentFrame()===0?1:0.5}}/>;}`;
    await renderManagedMotion({ ...motionFixture, source, width: 768, height: 1344, fps: 24, durationInFrames: 2 }, root);
    for (let frame = 0; frame < 2; frame++) {
      const bytes = await readFile(join(root, "frames", `frame-0000${frame}.png`));
      const decoded = PNG.sync.read(bytes);
      const oldEncoding = PNG.sync.write(decoded, { colorType: 6, inputColorType: 6, bitDepth: 8, deflateLevel: 6, deflateStrategy: 3 });
      const filtered = PNG.sync.write(decoded, { colorType: 6, inputColorType: 6, bitDepth: 8, deflateLevel: 6, deflateStrategy: 0 });
      assert.deepEqual(PNG.sync.read(oldEncoding).data, decoded.data, "无损压缩不得改变任一 RGBA 像素");
      assert.deepEqual(normalizeMotionPng(oldEncoding, 768, 1344), bytes, "旧编码输入应得到相同的新编码");
      assert.equal(bytes[25], 6);
      assert.equal(decoded.data[3], frame === 0 ? 255 : 128);
      assert.ok(bytes.length < oldEncoding.length * 0.8, "不能退回使渐变膨胀的编码方式");
      assert.ok(bytes.length <= filtered.length, "选择无滤波编码不能让其它画面体积退步");
      if (frame === 0) {
        assert.ok(bytes.length < filtered.length * 0.9, "只替换 RLE 仍不足，渐变需要更合适的过滤方式");
        assert.ok(oldEncoding.length * 467 > 256 * 1024 * 1024, "复现旧编码仅背景就超预算");
        assert.ok(bytes.length * 467 < 256 * 1024 * 1024, "保持现有预算也能容纳完整背景");
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("真实 Chromium 中的外部资源、动态求值被第二层隔离拒绝", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-security-"));
  try {
    // 刻意绕开 JSX 标签扫描，证明不是只靠关键词过滤才保护宿主。
    await assert.rejects(renderManagedMotion({ ...motionFixture, source: `import React from 'react';export default ()=>React.createElement('img',{src:'https://example.com/leak'});` }, join(root, "network")), /MOTION_(?:CSP_VIOLATION|NETWORK_BLOCKED)/u);
    await assert.rejects(renderManagedMotion({ ...motionFixture, source: `import React from 'react';export default function Motion(){const f=({})['con'+'structor']['con'+'structor'];return React.createElement('div',null,f('return 1')());}` }, join(root, "eval")), /(?:MOTION_CSP_VIOLATION|unsafe-eval|EvalError)/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("多层组件传递受管图片实际出图，传入远程地址仍由沙箱拒绝", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-image-props-"));
  try {
    const source = `import React from 'react';import {Img} from 'remotion';function Crop({src}){return <Img src={src} style={{width:320,height:320}}/>;}const Paper=({src})=><Crop src={src}/>;export default p=><Paper src={p.assets.page}/>;`;
    const png = new PNG({ width: 1, height: 1 });
    png.data = Buffer.from([24, 160, 72, 255]);
    const data = `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
    const result = await renderManagedMotion({ ...motionFixture, source, durationInFrames: 2 }, join(root, "managed"), { page: data });
    const frame = PNG.sync.read(await readFile(join(root, "managed/frames/frame-00000.png")));
    assert.deepEqual([...frame.data.subarray((160 * 320 + 160) * 4, (160 * 320 + 160) * 4 + 4)], [24, 160, 72, 255]);
    assert.equal(result.determinism!.status, "exact");
    await assert.rejects(renderManagedMotion({ ...motionFixture, source, durationInFrames: 2 }, join(root, "remote"), { page: "https://example.com/image.png" }), /MOTION_(?:CSP_VIOLATION|NETWORK_BLOCKED)/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("透明帧与同帧重复寻址是真实渲染事实，源码文字仍可修改", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-render-"));
  try {
    const result = await renderManagedMotion(motionFixture, root);
    assert.equal(result.frameHashes.length, 18);
    assert.notEqual(result.frameHashes[0], result.frameHashes[10]);
    const png = await readFile(join(root, "frames/frame-00010.png"));
    assert.equal(png[25], 6);
    assert.ok((await readFile(result.previewPath)).length > 100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("帧计算失控会被终止，不阻断下一个合法作品", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-timeout-"));
  try {
    const source = `import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(){const f=useCurrentFrame();if(f>0){while(true){}}return <div>限时测试</div>;}`;
    await assert.rejects(renderManagedMotion({ ...motionFixture, durationInFrames: 2, source }, join(root, "timeout")), /MOTION_FRAME_TIMEOUT/u);
    assert.equal((await renderManagedMotion({ ...motionFixture, durationInFrames: 2 }, join(root, "recovery"))).frameHashes.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("真实 PNG 保留透明、移动和极淡像素，不依赖安全区测量", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-alpha-"));
  try {
    const source = `import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(){const f=useCurrentFrame();if(f===0)return null;if(f===3)return <div style={{position:'absolute',inset:0,background:'rgba(255,255,255,0.004)'}}/>;return <div style={{position:'absolute',left:20+f*10,top:40,width:30,height:20,background:'#ffffff'}}/>;}`;
    await renderManagedMotion({ ...motionFixture, source, durationInFrames: 4 }, root);
    const pngs = await Promise.all(Array.from({ length: 4 }, async (_, frame) => PNG.sync.read(await readFile(join(root, "frames", `frame-${String(frame).padStart(5, "0")}.png`)))));
    const alpha = (frame: number, x: number, y: number) => pngs[frame]!.data[(y * 320 + x) * 4 + 3];
    assert.equal(alpha(0, 50, 50), 0);
    assert.equal(alpha(1, 35, 45), 255);
    assert.equal(alpha(2, 35, 45), 0, "移动后原位置保持透明");
    assert.equal(alpha(2, 45, 45), 255);
    assert.equal(alpha(3, 50, 50), 1, "极淡像素不能被删除");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("全屏作品从不透明淡出到透明再显现，实际 Alpha 保持连续", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-alpha-transition-"));
  try {
    const source = `import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(){const f=useCurrentFrame();return <div style={{position:'absolute',inset:0,background:'#ffffff',opacity:[1,0.5,0,1][f]}}/>;}`;
    await renderManagedMotion({ ...motionFixture, source, durationInFrames: 4 }, root);
    const alphas = await Promise.all(Array.from({ length: 4 }, async (_, frame) => {
      const png = PNG.sync.read(await readFile(join(root, "frames", `frame-${String(frame).padStart(5, "0")}.png`)));
      return png.data[(160 * 320 + 160) * 4 + 3]!;
    }));
    assert.equal(alphas[0], 255);
    assert.ok(Math.abs(alphas[1]! - 128) <= 1);
    assert.equal(alphas[2], 0);
    assert.equal(alphas[3], 255);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RGB/RGBA 多次切换的审阅代理逐帧保留，不丢帧、不复制尾帧", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-proxy-frames-"));
  try {
    const source = `import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(){return <div style={{position:'absolute',inset:0,background:'#ffffff',opacity:[1,0.5,0,1,1,0.5,0.01,0][useCurrentFrame()]}}/>;}`;
    const result = await renderManagedMotion({ ...motionFixture, source, durationInFrames: 8 }, root);
    await verifyMotionPreviewFrames(result.previewPath, 8, 30);
    await assert.rejects(verifyMotionPreviewFrames(result.previewPath, 7, 30), /MOTION_OUTPUT_MISMATCH/u);
    await assert.rejects(verifyMotionPreviewFrames(result.previewPath, 8, 24), /MOTION_OUTPUT_MISMATCH/u);
    const decoded = await runProcess("ffmpeg", ["-v", "error", "-i", result.previewPath, "-vf", "crop=200:60:60:120,signalstats,metadata=print:file=-", "-an", "-f", "null", "-"]);
    const values = [...decoded.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/gu)].map((match) => Number(match[1]));
    assert.equal(values.length, 8);
    const expected = [235, 139, 43, 235, 235, 139, 45, 43];
    values.forEach((value, frame) => assert.ok(Math.abs(value - expected[frame]!) <= 2, `第 ${frame} 帧必须来自同序号 PNG，实际 ${value}`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("透明进入彩色全屏再退出时，代理保留每帧颜色、横向位置和 Alpha", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-proxy-color-"));
  try {
    // 先透明后不透明触发 RGBA→RGB；非灰度、非对称色块暴露像素步长误读。
    const source = `import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(){return <div style={{position:'absolute',inset:0,background:'#efe9d4',opacity:[0,0.5,1,1,0.5,0,1,0][useCurrentFrame()]}}><div style={{position:'absolute',left:20,top:40,width:60,height:80,background:'#bc832f'}}/><div style={{position:'absolute',left:160,top:140,width:100,height:60,background:'#1b5348'}}/></div>;}`;
    const result = await renderManagedMotion({ ...motionFixture, source, durationInFrames: 8 }, root);
    await verifyMotionPreviewFrames(result.previewPath, 8, 30);
    const rawPath = join(root, "decoded.rgb");
    await runProcess("ffmpeg", ["-v", "error", "-i", result.previewPath, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath]);
    const raw = await readFile(rawPath);
    assert.equal(raw.length, 8 * 320 * 320 * 3);
    for (let frame = 0; frame < 8; frame++) {
      const bytes = await readFile(join(root, "frames", `frame-${String(frame).padStart(5, "0")}.png`));
      const png = PNG.sync.read(bytes);
      for (const [x, y] of [[40, 70], [190, 165], [280, 70], [40, 240]]) {
        const pixel = (y! * 320 + x!) * 4;
        const alpha = png.data[pixel + 3]! / 255;
        for (let channel = 0; channel < 3; channel++) {
          const expected = png.data[pixel + channel]! * alpha + [23, 32, 51][channel]! * (1 - alpha);
          const actual = raw[(frame * 320 * 320 + y! * 320 + x!) * 3 + channel]!;
          assert.ok(Math.abs(actual - expected) <= 6, `F${frame} (${x},${y}) 通道${channel}：${actual}，应为${expected}`);
        }
      }
      assert.equal(bytes[25], 6, `F${frame} 必须保存 RGBA，避免下游输入格式跳变`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
