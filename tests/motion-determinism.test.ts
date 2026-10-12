import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { compareMotionFrames, MotionDeterminismError, verifyMotionDeterminism } from "../apps/render-worker/src/motion-determinism.js";
import { createApplication } from "@videocut/application";
import { processClaimedJob } from "@videocut/job-runtime";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";
import { motionFixture } from "./fixtures/managed-motion.js";
import { renderManagedMotion } from "../apps/render-worker/src/motion-renderer.js";
import { motionHash, motionHashEngine } from "../packages/motion-work/src/compiler.js";

const png = (pixels: number[], width = pixels.length / 4) => {
  const image = new PNG({ width, height: pixels.length / 4 / width });
  image.data = Buffer.from(pixels);
  return PNG.sync.write(image);
};

test("图片差异区分微小色阶和明显变化，记录真实范围而非只给哈希", () => {
  const first = png([100, 100, 100, 255, 100, 100, 100, 255]);
  const small = compareMotionFrames(first, png([100, 100, 100, 255, 101, 100, 100, 255]));
  assert.equal(small.changedPixels, 1);
  assert.equal(small.maxChannelDelta, 1);
  assert.equal(small.meanChannelDelta, 1 / 6);
  assert.deepEqual(small.bounds, { x: 1, y: 0, width: 1, height: 1 });
  const large = compareMotionFrames(first, png([100, 100, 100, 255, 255, 100, 100, 255]));
  assert.equal(large.maxChannelDelta, 155);
  const diff = PNG.sync.read(small.diff);
  assert.deepEqual([...diff.data], [0, 0, 0, 255, 8, 0, 0, 255]);
});

test("SVG 默认输出使用几何精度文字，缩放与 textLength 不退回依赖字体优化的 auto 模式", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-text-precision-"));
  try {
    const source = `import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(p){const f=useCurrentFrame();return <svg width="320" height="320" style={{textRendering:p.mode}}><rect width="320" height="320" fill="white"/><g transform={'translate(25 50) rotate(-5) scale('+(1.10+f*.002)+')'}><text x="0" y="40" fontFamily="Arial" fontSize="7.4" textLength="240" lengthAdjust="spacingAndGlyphs">Quality of Service parameters and control functions</text></g></svg>;}`;
    const normal = await renderManagedMotion({ ...motionFixture, source, props: {}, durationInFrames: 3 }, join(root, "default"));
    const precise = await renderManagedMotion({ ...motionFixture, source, props: { mode: "geometricPrecision" }, durationInFrames: 3 }, join(root, "precise"));
    const automatic = await renderManagedMotion({ ...motionFixture, source, props: { mode: "auto" }, durationInFrames: 3 }, join(root, "automatic"));
    assert.deepEqual(normal.frameHashes, precise.frameHashes, "默认输出必须与独立几何精度渲染一致");
    assert.notDeepEqual(normal.frameHashes, automatic.frameHashes, "此 fixture 必须能实际识别旧 auto 字体输出");
    assert.equal(normal.determinism!.status, "exact");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("字体渲染引擎升级隔离新缓存，已冻结的第四代引擎任务仍可验证", () => {
  const legacy = motionHash(motionFixture, [], "managed-motion-4");
  assert.notEqual(motionHash(motionFixture), legacy);
  assert.equal(motionHashEngine(motionFixture, [], legacy), "managed-motion-4");
  assert.equal(motionHashEngine(motionFixture, [], legacy, "managed-motion-4"), "managed-motion-4");
  assert.throws(() => motionHashEngine(motionFixture, [], legacy, "managed-motion-5"), /MISMATCH/u);
});

test("完整栅格重绘使用新引擎缓存，仍可核验已冻结的第五代引擎任务", () => {
  const legacy = motionHash(motionFixture, [], "managed-motion-5");
  assert.notEqual(motionHash(motionFixture), legacy);
  assert.equal(motionHashEngine(motionFixture, [], legacy), "managed-motion-5");
  assert.equal(motionHashEngine(motionFixture, [], legacy, "managed-motion-5"), "managed-motion-5");
  assert.throws(() => motionHashEngine(motionFixture, [], legacy, "managed-motion-6"), /MISMATCH/u);
});

test("SVG曲线和虚线不受局部脏区历史影响，顺序渲染与跳帧复查逐像素一致", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-partial-raster-"));
  try {
    // 保留完整渲染历史：只抽末帧或固定几何不能复现局部重绘遗留的边缘像素。
    const source = await readFile(new URL("./fixtures/partial-raster-motion.tsx", import.meta.url), "utf8");
    const rendered = await renderManagedMotion({ ...motionFixture, source, props: {}, width: 768, height: 1344, fps: 24, durationInFrames: 317 }, root);
    assert.equal(rendered.frameHashes.length, 317);
    assert.equal(rendered.determinism!.status, "exact", "必须消除脏区引起的像素差异，不能用提高容差通过");
    assert.deepEqual(rendered.determinism!.sampledFrames, [0, 158, 316]);
    assert.deepEqual(rendered.determinism!.differences, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("透明帧比较不把隐藏 RGB 当故障，同时检出黑色物体的 Alpha 丢失", () => {
  const hidden = compareMotionFrames(png([255, 0, 0, 0]), png([0, 255, 0, 0]));
  assert.equal(hidden.maxChannelDelta, 0);
  assert.equal(hidden.changedPixels, 0);
  assert.equal(hidden.bounds, null);
  const alpha = compareMotionFrames(png([0, 0, 0, 255]), png([0, 0, 0, 0]));
  assert.equal(alpha.maxChannelDelta, 255);
  assert.equal(alpha.changedPixels, 1);
  assert.throws(() => compareMotionFrames(png([0, 0, 0, 0]), png([0, 0, 0, 0, 0, 0, 0, 0])), /MOTION_OUTPUT_MISMATCH/u);
  assert.throws(() => compareMotionFrames(Buffer.from("broken"), png([0, 0, 0, 0])));
});

test("半透明变换图层切换后，字幕阴影不复用顺序渲染的旧绘制状态", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-opacity-shadow-"));
  try {
    // 压缩复现历史：中帧顺序到达时背景图层已经存在，跳帧复核则重新出现。
    const source = `import React from 'react';import {AbsoluteFill,useCurrentFrame} from 'remotion';
const p=(f,a,b)=>Math.max(0,Math.min(1,(f-a)/(b-a)));const o=x=>1-Math.pow(1-x,3);
export default function Motion(){const frame=useCurrentFrame(),f=frame===0?0:frame===66?466:200+frame;
const text=f>=221&&f<268?'再贴近手机和基站这一段。\\n除了强度，还要看质量。':'人多不等于必然拥堵，\\n但满格也不保证一路畅通。';
return <AbsoluteFill style={{background:'#070a0d'}}>
{f>=216&&f<467&&<div style={{position:'absolute',inset:0,zIndex:18,opacity:o(p(f,221,248)),transform:'scale(1)'}}>
<div style={{position:'absolute',left:-92,bottom:-128,width:330,height:610,borderRadius:48,transform:'rotate(22deg)',background:'#7d8588'}}/></div>}
<div style={{position:'absolute',zIndex:80,left:0,right:0,bottom:0,height:260,background:'linear-gradient(transparent,#070a0d 64%)'}}/>
<div style={{position:'absolute',zIndex:90,left:46,right:46,top:1178,minHeight:114,display:'flex',justifyContent:'center',alignItems:'center',whiteSpace:'pre-line',textAlign:'center',fontFamily:'"Noto Sans SC","Microsoft YaHei",sans-serif',fontSize:36,lineHeight:1.38,color:'#F8F2E8',fontWeight:600,textShadow:'0 3px 20px #000',opacity:f>=221&&f<268?o(p(f,221,228)):f===0?0:1}}>{text}</div>
</AbsoluteFill>;}`;
    const result = await renderManagedMotion({ ...motionFixture, source, props: {}, width: 768, height: 1344, fps: 24, durationInFrames: 67 }, root);
    assert.equal(result.determinism!.status, "exact");
    assert.deepEqual(result.determinism!.sampledFrames, [0, 33, 66]);
    assert.deepEqual(result.determinism!.differences, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("轻微色阶差异保留警告并通过，局部明显差异失败，缓存损坏仍精确拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-difference-"));
  try {
    await mkdir(join(root, "frames"));
    const original = png([100, 100, 100, 255, 100, 100, 100, 255]);
    const hash = createHash("sha256").update(original).digest("hex");
    const path = join(root, "frames", "frame-00000.png");
    await writeFile(path, original);
    assert.equal((await verifyMotionDeterminism(root, [hash], async () => original)).status, "exact");
    const minor = await verifyMotionDeterminism(root, [hash], async () => png([100, 100, 100, 255, 102, 100, 100, 255]));
    assert.equal(minor.status, "tolerated");
    assert.equal(minor.differences[0]!.maxChannelDelta, 2);
    assert.deepEqual(await readFile(path), original, "容差不能替换第一次顺序渲染的帧");
    await assert.rejects(verifyMotionDeterminism(root, [hash], async () => png([100, 100, 100, 255, 103, 100, 100, 255])), MotionDeterminismError);
    const report = JSON.parse(await readFile(join(root, "diagnostics/report.json"), "utf8"));
    assert.equal(report.status, "failed");
    for (const file of Object.values(report.differences[0].paths)) assert.ok((await readFile(join(root, "diagnostics", String(file)))).length);
    await writeFile(path, "corrupted");
    await assert.rejects(verifyMotionDeterminism(root, [hash], async () => png([101, 100, 100, 255, 100, 100, 100, 255])), /MOTION_CACHE_CORRUPT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("真实有状态动画失败后，Job 返回持久化差异证据，不创建作品或视频 Revision", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-failure-evidence-"));
  const app = createApplication(root);
  try {
    const state = app.createProject({ name: "确定性故障隔离回归" });
    const projectId = state.snapshot.project.id;
    // 故意保留跨帧副作用；关闭字体舍入不得掩盖真正的内容变化。
    const source = `import React from 'react';import {useCurrentFrame} from 'remotion';let visited=false;export default function Motion(){const f=useCurrentFrame();if(f>0)visited=true;return <div style={{position:'absolute',inset:0,background:visited?'#ffffff':'#000000'}}/>;}`;
    const submitted = app.submitManagedMotion({ projectId, baseRevision: state.revision.number, idempotencyKey: "stateful", work: { ...motionFixture, source, durationInFrames: 4 } });
    const job = app.claimNextJob(["motion_generation"], 60_000)!;
    assert.equal(job.id, submitted.id);
    await processClaimedJob(app, job, (claimed) => runMotionJob(app, claimed));
    const result = app.trackJob(job.id);
    assert.equal(result.status, "failed");
    assert.equal((result.result!.diagnostic as { code: string }).code, "MOTION_NONDETERMINISTIC");
    const diagnostics = result.result!.motionDiagnostics as { reportPath: string; status: string };
    assert.equal(diagnostics.status, "failed");
    const reportPath = join(state.snapshot.project.rootPath, diagnostics.reportPath);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.differences[0].frame, 0);
    assert.equal(report.differences[0].maxChannelDelta, 255);
    const parent = join(state.snapshot.project.rootPath, "assets/derived/motion", job.id);
    const entries = await readdir(parent);
    assert.equal(entries.length, 1);
    assert.ok(entries[0]!.startsWith("diagnostics-"), "清理大体积临时帧，只留下诊断目录");
    const after = app.readProject(projectId);
    assert.equal(after.revision.number, state.revision.number);
    assert.equal(after.snapshot.assets.length, 0);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
