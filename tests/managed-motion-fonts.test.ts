import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { bindMotionFonts, listMotionFonts, motionFontsRoot, prepareMotionFonts } from "../packages/motion-work/src/fonts.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import { motionHash, motionHashEngine, validateMotionSource } from "../packages/motion-work/src/compiler.js";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";
import { renderManagedMotion, waitMotionStartup } from "../apps/render-worker/src/motion-renderer.js";
import { motionFixture } from "./fixtures/managed-motion.js";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import { userFontIds } from "./fixtures/managed-user-fonts.js";

const fontWork = motionSubmissionSchema.parse({ ...motionFixture, durationInFrames: 4,
  fontBindings: { title: "noto-sans-sc-bold", body: "noto-sans-sc-regular" },
  source: `import React from 'react';import {useCurrentFrame} from 'remotion';
export default function M(p){const f=useCurrentFrame();return <div style={{position:'absolute',inset:0,color:'white',padding:10,transform:'translateX('+f+'px)'}}>
<div style={{fontFamily:p.fonts.title.family,fontWeight:p.fonts.title.weight,fontSize:32}}>直播观看方式</div>
<div style={{fontFamily:p.fonts.body.family,fontWeight:p.fonts.body.weight,fontSize:32}}>直播观看方式</div></div>}` });

test("初始化不就绪时明确超时，普通浏览器故障保留原错误", async () => {
  const timedOut = Object.assign(new Error("模拟浏览器等待超时"), { name: "TimeoutError" });
  const page = { waitForFunction: async (_source: unknown, options: { timeout: number }) => {
    assert.equal(options.timeout, 15_000); throw timedOut;
  }, evaluate: async () => undefined } as unknown as Parameters<typeof waitMotionStartup>[0];
  await assert.rejects(waitMotionStartup(page, true), /MOTION_FONT_LOAD_TIMEOUT/u);
  await assert.rejects(waitMotionStartup(page, false), error => error === timedOut);
  const broken = { ...page, waitForFunction: async () => { throw new Error("浏览器已断开"); } } as unknown as typeof page;
  await assert.rejects(waitMotionStartup(broken, true), /浏览器已断开/u);
});

test("目录只返回已登记本地字体，绑定固定实际字重和哈希，禁止路径与Props覆盖", () => {
  const fonts = listMotionFonts();
  assert.deepEqual(fonts.slice(0, 4).map(f => [f.id, f.weight]), [["noto-sans-sc-regular", 400], ["noto-sans-sc-bold", 700], ["noto-serif-sc-semibold", 600], ["noto-serif-sc-black", 900]]);
  assert.equal(fonts.length, 34);
  assert.equal(fonts.find(f => f.id === "smiley-sans-oblique")!.style, "italic");
  // 烟波宋R原件标注200；忠实使用真实元数据，不擅自把它改成400。
  assert.equal(fonts.find(f => f.id === "maoken-yanbo-song-regular")!.weight, 200);
  const bound = bindMotionFonts(fontWork);
  assert.equal(bound.length, 2);
  assert.equal(bound.find(f => f.slot === "title")!.weight, 700);
  assert.throws(() => bindMotionFonts({ ...fontWork, fontBindings: { title: "unknown" } }), /MOTION_FONT_UNKNOWN/u);
  for (const invalid of [{ title: "C:/Windows/Fonts/abc.ttf" }, { title: "https://example.com/a.otf" }]) {
    assert.throws(() => motionSubmissionSchema.parse({ ...fontWork, fontBindings: invalid }));
  }
  assert.throws(() => motionSubmissionSchema.parse({ ...fontWork, props: { fonts: {} } }), /Props.fonts/u);
  assert.equal(motionSubmissionSchema.parse(motionFixture).fontBindings, undefined);
  for (const hook of ["useEffect", "useState"]) assert.throws(() => validateMotionSource(`import {${hook} as hook} from 'react';export default ()=>null`), /fontBindings/u);
  assert.throws(() => validateMotionSource("import {delayRender} from 'remotion';export default ()=>null"), /fontBindings/u);
});

test("用户提供的22份原件分别登记并正确准备，地区版本与仓耳粗细不合并或合成", async () => {
  const fonts = listMotionFonts();
  const hashes = new Set<string>();
  for (const id of userFontIds) {
    const face = fonts.find(font => font.id === id)!;
    assert.ok(face, `用户选择的原件必须登记：${id}`);
    assert.equal(face.license, "用户已授权（用户提供原件）");
    assert.equal(face.licenseFile, "NOTICE-UserFonts.txt");
    assert.ok(face.sourceUrl.startsWith("file:///E:/"));
    const work = motionSubmissionSchema.parse({ ...fontWork, fontBindings: { face: id } });
    const bound = bindMotionFonts(work);
    const prepared = prepareMotionFonts(work, bound)[0]!;
    assert.equal(prepared.format, id.startsWith("wd-xl-") ? "otf" : "ttf");
    assert.equal(prepared.binding.style, "normal");
    assert.equal(prepared.binding.weight, id === "leefont-menghei" ? 900 : 400);
    const data = Buffer.from(prepared.dataUrl.split(",")[1]!, "base64");
    assert.equal(createHash("sha256").update(data).digest("hex"), face.sha256);
    hashes.add(prepared.binding.hash);
  }
  // 即使内部字重都标注400，也按独立原件保留W01-W05的真实粗细。
  assert.equal(hashes.size, 22);
  assert.equal(fonts.some(font => font.name.includes("云峰静龙行书")), false);
});

test("字体缺失、内容变更及目录逃逸明确失败，Worker不换绑定；新哈希包含字体内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-font-catalog-"));
  try {
    await cp(motionFontsRoot(), root, { recursive: true });
    const bound = bindMotionFonts(fontWork, root);
    assert.throws(() => prepareMotionFonts(fontWork, bound.map(f => ({ ...f, weight: 500 })), root), /MOTION_FONT_BINDING_MISMATCH/u);
    const version = motionHash(fontWork, [], undefined, [], bound);
    assert.equal(motionHashEngine(fontWork, [], version, undefined, [], bound), "managed-motion-13");
    assert.notEqual(version, motionHash(fontWork, [], undefined, [], bound.map(f => ({ ...f, hash: "0".repeat(64) }))));
    const legacy = motionHash(motionFixture, [], "managed-motion-12");
    assert.equal(motionHashEngine(motionFixture, [], legacy), "managed-motion-12");
    await writeFile(join(root, "NotoSansSC-Bold.otf"), "OTTOchanged");
    assert.throws(() => bindMotionFonts(fontWork, root), /MOTION_FONT_CHANGED/u);
    await unlink(join(root, "NotoSansSC-Bold.otf"));
    assert.throws(() => listMotionFonts(root), /MOTION_FONT_FILE_INVALID/u);
    const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
    catalog.fonts[0].file = "../escape.otf";
    await writeFile(join(root, "catalog.json"), JSON.stringify(catalog));
    assert.throws(() => listMotionFonts(root), /MOTION_FONT_CATALOG_INVALID/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TTF按真实格式准备；伪装扩展名、类型不匹配和超过32MiB的字体明确拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-ttf-contract-"));
  try {
    const selected = listMotionFonts().find(f => f.id === "maoken-yanbo-song-bold")!;
    const original = JSON.parse(await readFile(join(motionFontsRoot(), "catalog.json"), "utf8"));
    const face = original.fonts.find((f: { id: string }) => f.id === selected.id);
    await cp(join(motionFontsRoot(), face.file), join(root, face.file));
    await writeFile(join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, fonts: [face] }));
    const work = { ...fontWork, fontBindings: { title: selected.id } };
    const prepared = prepareMotionFonts(work, bindMotionFonts(work, root), root);
    assert.equal(prepared[0]!.format, "ttf");
    assert.ok(prepared[0]!.dataUrl.startsWith("data:font/ttf;base64,"));
    await writeFile(join(root, face.file), "OTTOinvalid");
    assert.throws(() => listMotionFonts(root), /MOTION_FONT_FORMAT/u);
    await writeFile(join(root, face.file), Buffer.alloc(32 * 1024 * 1024 + 1));
    assert.throws(() => listMotionFonts(root), /MOTION_FONT_FILE_INVALID/u);
    prepared[0] = { ...prepared[0]!, dataUrl: "data:font/otf;base64,T1RUTw==" };
    await assert.rejects(renderManagedMotion(work, root, {}, undefined, undefined, prepared), /MOTION_FONT_FORMAT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("已登记的用户授权字体不按OFL标签拦截，仍必须匹配实际文件哈希", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-authorized-font-"));
  try {
    const source = JSON.parse(await readFile(join(motionFontsRoot(), "catalog.json"), "utf8"));
    const face = { ...source.fonts.find((f: { id: string }) => f.id === "smiley-sans-oblique"), license: "用户已授权" };
    await cp(join(motionFontsRoot(), face.file), join(root, face.file));
    await writeFile(join(root, "catalog.json"), JSON.stringify({ schemaVersion: 1, fonts: [face] }));
    assert.equal(listMotionFonts(root)[0]!.license, "用户已授权");
    const work = { ...fontWork, fontBindings: { title: face.id } };
    assert.equal(prepareMotionFonts(work, bindMotionFonts(work, root), root)[0]!.binding.hash, face.sha256);
    await writeFile(join(root, face.file), "OTTOchanged");
    assert.throws(() => bindMotionFonts(work, root), /MOTION_FONT_CHANGED/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("新增得意黑与烟波宋TTF共同首帧加载；字形不同、字体副本格式正确、损坏缓存拒绝", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-requested-fonts-"));
  const app = createApplication(root);
  try {
    const state = app.createProject({ name: "新增字体隔离回归" }), projectId = state.snapshot.project.id;
    const work = motionSubmissionSchema.parse({ ...motionFixture, width: 640, height: 192, durationInFrames: 2,
      fontBindings: { a: "smiley-sans-oblique", b: "maoken-yanbo-song-bold" },
      source: `import React from 'react';export default p=><div style={{color:'white'}}>{['a','b'].map(slot=><div key={slot} style={{height:96,lineHeight:'96px',fontSize:48,fontFamily:p.fonts[slot].family,fontWeight:p.fonts[slot].weight,fontStyle:p.fonts[slot].style,fontSynthesis:'none'}}>时代不同不能冷场</div>)}</div>` });
    const job = app.submitManagedMotion({ projectId, baseRevision: 1, idempotencyKey: "request-fonts", work });
    const result = await runMotionJob(app, job);
    const asset = app.readProject(projectId).snapshot.assets.find(a => a.id === result.assetId)!;
    const directory = join(state.snapshot.project.rootPath, asset.motion!.framesDirectory, "..");
    const bound = bindMotionFonts(work);
    const png = PNG.sync.read(await readFile(join(directory, "frames/frame-00000.png")));
    const rows = [0, 96].map(top => {
      const pixels = png.data.subarray(top * 640 * 4, (top + 96) * 640 * 4);
      assert.ok(Array.from(pixels).filter((_, i) => i % 4 === 3 && pixels[i]! > 100).length > 2000, "首帧已有实际中文字形");
      return createHash("sha256").update(pixels).digest("hex");
    });
    assert.notEqual(rows[0], rows[1]);
    for (const f of prepareMotionFonts(work, bound)) {
      const bytes = await readFile(join(directory, "resources/font-files", `${f.binding.hash}.${f.format}`));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), f.binding.hash);
    }
    const cached = await runMotionJob(app, job, async () => { assert.fail("完整缓存不重复渲染"); });
    assert.equal(cached.assetId, result.assetId);
    const ttf = bound.find(f => f.slot === "b")!;
    await writeFile(join(directory, "resources/font-files", `${ttf.hash}.ttf`), "corrupt");
    await assert.rejects(runMotionJob(app, job), /MOTION_FONT_CACHE_CORRUPT/u);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("非法字体提交不创建Job或Revision，原输入幂等返回同一固定字体任务", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-font-submit-"));
  const app = createApplication(root);
  try {
    const state = app.createProject({ name: "字体提交隔离回归" }), projectId = state.snapshot.project.id;
    assert.throws(() => app.submitManagedMotion({ projectId, baseRevision: 1, idempotencyKey: "bad", work: { ...fontWork, fontBindings: { title: "missing" } } }), /MOTION_FONT_UNKNOWN/u);
    assert.equal(app.repository.listJobs(projectId).length, 0);
    assert.equal(app.readProject(projectId).revision.number, 1);
    const job = app.submitManagedMotion({ projectId, baseRevision: 1, idempotencyKey: "ok", work: fontWork });
    assert.equal((job.payload.boundFonts as unknown[]).length, 2);
    const fixed = bindMotionFonts(fontWork).map(font => ({ ...font, hash: "0".repeat(64), family: `VFC_${"0".repeat(64)}` }));
    const changedJob = { ...job, payload: { ...job.payload, boundFonts: fixed, version: motionHash(fontWork, [], undefined, [], fixed) } };
    await assert.rejects(runMotionJob(app, changedJob, async () => { assert.fail("变更字体不能进入渲染"); }), /MOTION_FONT_BINDING_MISMATCH/u);
    assert.equal(app.readProject(projectId).revision.number, 1);
    assert.equal(app.readProject(projectId).snapshot.assets.length, 0);
    assert.equal(app.submitManagedMotion({ projectId, baseRevision: 0, idempotencyKey: "ok", work: fontWork }).id, job.id);
    assert.throws(() => app.submitManagedMotion({ projectId, baseRevision: 1, idempotencyKey: "ok", work: { ...fontWork, fontBindings: { title: "noto-sans-sc-regular" } } }), /MOTION_IDEMPOTENCY_CONFLICT|幂等/u);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("中文常规与粗体首帧可见且重复定位稳定，字体副本可核验，缓存损坏不覆盖", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-font-render-"));
  const app = createApplication(root);
  try {
    const state = app.createProject({ name: "中文字体真实渲染回归" }), projectId = state.snapshot.project.id;
    // 图片槽可合法命名为fonts，字体副本不能占用相同资源路径。
    const imageBytes = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    await writeFile(join(state.snapshot.project.rootPath, "assets/font-test.png"), imageBytes);
    const image = app.registerImportedAsset({ projectId, baseRevision: 1, name: "字体并用图片回归", kind: "image", managedPath: "assets/font-test.png",
      sourceHash: createHash("sha256").update(imageBytes).digest("hex"), provenance: { source: "local_import", acquiredAt: new Date().toISOString() } }).asset;
    app.applyMediaAnalysis({ projectId, assetId: image.id, metadata: { durationMs: 0, width: 1, height: 1, hasAudio: false } });
    const job = app.submitManagedMotion({ projectId, baseRevision: app.readProject(projectId).revision.number, idempotencyKey: "render", work: { ...fontWork, imageBindings: { fonts: image.id } } });
    const result = await runMotionJob(app, job);
    const asset = app.readProject(projectId).snapshot.assets.find(a => a.id === result.assetId)!;
    assert.equal(asset.motion!.fontSources!.length, 2);
    const directory = join(state.snapshot.project.rootPath, asset.motion!.framesDirectory, "..");
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.ok(["exact", "tolerated"].includes(manifest.determinism.status));
    assert.deepEqual(manifest.boundFonts, job.payload.boundFonts);
    const frame = PNG.sync.read(await readFile(join(directory, "frames/frame-00000.png")));
    const ink = (top: number, bottom: number) => {
      let count = 0;
      for (let y = top; y < bottom; y++) for (let x = 0; x < frame.width; x++) if (frame.data[(y * frame.width + x) * 4 + 3]! > 100) count++;
      return count;
    };
    assert.ok(ink(10, 57) > 1000, "首帧标题必须已有中文字形");
    assert.ok(ink(57, 104) > 800, "首帧正文必须已有中文字形");
    assert.ok(ink(10, 57) > ink(57, 104), "实际粗体比常规有更多着墨像素");
    const revision = app.readProject(projectId).revision.number;
    const replay = await runMotionJob(app, job, async () => { assert.fail("完整缓存不可重新渲染"); });
    assert.equal(replay.assetId, result.assetId);
    const font = manifest.boundFonts[0];
    await writeFile(join(directory, "resources/font-files", `${font.hash}.otf`), "corrupt");
    await assert.rejects(runMotionJob(app, job), /MOTION_FONT_CACHE_CORRUPT/u);
    await unlink(join(directory, "resources/font-files", `${font.hash}.otf`));
    await assert.rejects(runMotionJob(app, job), /MOTION_FONT_CACHE_CORRUPT/u);
    assert.equal(app.readProject(projectId).revision.number, revision);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("浏览器拒绝损坏字体时明确加载失败，不产生代理视频或成功Asset", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-font-load-fail-"));
  try {
    const prepared = prepareMotionFonts(fontWork, bindMotionFonts(fontWork));
    prepared[0] = { ...prepared[0]!, dataUrl: `data:font/otf;base64,${Buffer.from("OTTOinvalid").toString("base64")}` };
    await assert.rejects(renderManagedMotion(fontWork, root, {}, undefined, undefined, prepared), /MOTION_FONT_LOAD_FAILED/u);
    await assert.rejects(readFile(join(root, "preview.mp4")), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("黑体与宋体四个实际字重可共同加载，宋体600与900输出不同真实字形", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-serif-four-faces-"));
  try {
    const work = motionSubmissionSchema.parse({ ...motionFixture, durationInFrames: 2,
      fontBindings: { sans: "noto-sans-sc-regular", sansBold: "noto-sans-sc-bold", serif: "noto-serif-sc-semibold", serifHeavy: "noto-serif-sc-black" },
      source: `import React from 'react';export default p=><div style={{color:'white'}}>{['sans','sansBold','serif','serifHeavy'].map(slot=><div key={slot} style={{height:48,lineHeight:'48px',fontSize:32,fontFamily:p.fonts[slot].family,fontWeight:p.fonts[slot].weight,fontSynthesis:'none'}}>时代不同不能冷场</div>)}</div>` });
    const bound = bindMotionFonts(work);
    assert.equal(new Set(bound.map(font => font.hash)).size, 4);
    const result = await renderManagedMotion(work, root, {}, undefined, undefined, prepareMotionFonts(work, bound));
    assert.ok(["exact","tolerated"].includes(result.determinism!.status));
    const png = PNG.sync.read(await readFile(join(root, "frames/frame-00000.png")));
    const ink = (row: number) => {
      let count = 0;
      for (let y = row*48; y < (row+1)*48; y++) for (let x = 0; x < 320; x++) if(png.data[(y*320+x)*4+3]! > 100) count++;
      return count;
    };
    for (let row = 0; row < 4; row++) assert.ok(ink(row) > 800);
    assert.ok(ink(3) > ink(2), "真实宋体900主干重量须区别于600，不使用字体合成");
    assert.notEqual(ink(0), ink(2), "宋体输出须区别于黑体回退");
  } finally { await rm(root, { recursive: true, force: true }); }
});
