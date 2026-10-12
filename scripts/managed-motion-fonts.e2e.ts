import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { motionFixture } from "../tests/fixtures/managed-motion.js";
import { verifyMotionPreviewFrames } from "../apps/render-worker/src/motion-renderer.js";
import { serifFontFixture } from "../tests/fixtures/managed-serif-fonts.js";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import { userFontIds } from "../tests/fixtures/managed-user-fonts.js";

// 只使用独立候选端口和数据库，正式项目及工单不作为生成输入。
const require = createRequire(import.meta.url);
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
const { findAvailablePort } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const repoRoot = resolve(import.meta.dirname, ".."), pluginRoot = join(repoRoot, "plugins/videoflowcut");
const validationRoot = join(repoRoot, ".repair-validation");
await mkdir(validationRoot, { recursive: true });
const root = await mkdtemp(join(validationRoot, "managed-fonts-")), port = await findAvailablePort();
const args = ["--repo-root", repoRoot, "--workspace", root, "--port", String(port), "--comfyui-bridge-url", "http://127.0.0.1:18199"];
const runtime = await runCandidateRuntime("ensure", args);
const spec = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.videoflowcut;
const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: pluginRoot, stderr: "pipe",
  env: { ...getDefaultEnvironment(), ...spec.env, VIDEOCUT_WORKSPACE: root, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: "http://127.0.0.1:18199" } });
const client = new Client({ name: "受管字体候选回归", version: "1.0.0" });
const call = async (name: string, input: Record<string, unknown> = {}, expectedError = false): Promise<any> => {
  const result = await client.callTool({ name, arguments: input });
  assert.equal(result.isError === true, expectedError, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse((result.content as { type: string; text?: string }[]).find(entry => entry.type === "text")!.text!);
};
const waitJob = async (id: string) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: id });
    if (["succeeded", "failed"].includes(job.status)) return job;
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error("候选字体任务超时");
};
console.log(JSON.stringify({ 阶段: "候选服务已启动", root, port, releaseId: runtime.releaseId }));
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const capabilitiesTool = tools.tools.find(tool => tool.name === "read_motion_capabilities")!;
  assert.equal(capabilitiesTool.annotations?.readOnlyHint, true);
  assert.ok((tools.tools.find(tool => tool.name === "submit_motion_work")!.inputSchema.properties as any).work.properties.fontBindings);
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.equal(release.runtime.releaseId, runtime.releaseId);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  const capabilities = await call("read_motion_capabilities");
  assert.equal(capabilities.engineVersion, "managed-motion-13");
  assert.equal(capabilities.fonts.length, 34);
  const fontCatalog = JSON.parse(await readFile(join(pluginRoot, "runtime/dist/fonts/catalog.json"), "utf8"));
  for (const id of userFontIds) assert.ok(capabilities.fonts.some((font: any) => font.id === id), `候选MCP缺少原件：${id}`);
  assert.equal(capabilities.fonts.some((font: any) => font.name.includes("云峰静龙行书")), false);
  assert.deepEqual(capabilities.fonts.slice(0, 4).map((font: any) => [font.id, font.weight]), [
    ["noto-sans-sc-regular",400], ["noto-sans-sc-bold",700], ["noto-serif-sc-semibold",600], ["noto-serif-sc-black",900]
  ]);
  assert.equal(capabilities.allowedImports.react.includes("useEffect"), false);
  const httpCaps = await (await fetch(`http://127.0.0.1:${port}/api/motion/capabilities`)).json();
  assert.deepEqual((httpCaps as any).fonts, capabilities.fonts);
  const created = await call("create_project", { name: "受管字体发行隔离回归", profile: "visual_explainer" });
  const projectId = created.snapshot.project.id, projectRoot = created.snapshot.project.rootPath;
  const work = { ...motionFixture, reference: undefined, durationInFrames: 12,
    fontBindings: { title: "noto-sans-sc-bold", body: "noto-sans-sc-regular" },
    source: `import React from 'react';import {useCurrentFrame} from 'remotion';
export default p=><div style={{position:'absolute',inset:0,background:'#142735',color:'white',padding:12}}>
<div style={{fontFamily:p.fonts.title.family,fontWeight:p.fonts.title.weight,fontSize:32,transform:'translateX('+useCurrentFrame()+'px)'}}>直播观看方式</div>
<div style={{fontFamily:p.fonts.body.family,fontWeight:p.fonts.body.weight,fontSize:25}}>首帧字体就绪，中文标点：！</div></div>` };
  const submitted = await call("submit_motion_work", { project_id: projectId, base_revision_id: created.revision.number, idempotency_key: "fonts", work });
  const completed = await waitJob(submitted.id);
  assert.equal(completed.status, "succeeded", JSON.stringify(completed));
  const rendered = await call("read_motion_work", { project_id: projectId, job_id: submitted.id });
  assert.equal(rendered.asset.motion.fontSources.length, 2);
  const directory = dirname(join(projectRoot, rendered.asset.motion.sourcePath));
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.ok(["exact", "tolerated"].includes(manifest.determinism.status));
  for (const font of manifest.boundFonts) assert.ok((await readFile(join(directory, "resources/font-files", `${font.hash}.otf`))).length > 0);
  const preview = join(projectRoot, rendered.asset.managedPath);
  await verifyMotionPreviewFrames(preview, 12, 30);
  const beforeFailure = await call("read_project", { project_id: projectId });
  const unknown = await call("submit_motion_work", { project_id: projectId, base_revision_id: beforeFailure.revision.number,
    idempotency_key: "unknown", work: { ...work, fontBindings: { title: "unregistered" } } }, true);
  assert.match(unknown.error, /MOTION_FONT_UNKNOWN/u);
  const rejectedHook = await call("submit_motion_work", { project_id: projectId, base_revision_id: beforeFailure.revision.number,
    idempotency_key: "hook", work: { ...work, source: "import {useEffect} from 'react';export default ()=>null" } }, true);
  assert.match(rejectedHook.error, /fontBindings/u);
  assert.deepEqual(await call("read_project", { project_id: projectId }), beforeFailure);
  // 无字体绑定的现有生成路径也经同一发行Runtime验证。
  const legacy = await call("submit_motion_work", { project_id: projectId, base_revision_id: beforeFailure.revision.number,
    idempotency_key: "without-fonts", work: { ...motionFixture, reference: undefined, durationInFrames: 4 } });
  const legacyCompleted = await waitJob(legacy.id);
  assert.equal(legacyCompleted.status, "succeeded", JSON.stringify(legacyCompleted));
  const serifState = await call("read_project", { project_id: projectId });
  const serif = await call("submit_motion_work", { project_id: projectId, base_revision_id: serifState.revision.number,
    idempotency_key: "serif-specimen", work: serifFontFixture });
  const serifCompleted = await waitJob(serif.id);
  assert.equal(serifCompleted.status, "succeeded", JSON.stringify(serifCompleted));
  const serifAsset = (await call("read_motion_work", { project_id: projectId, job_id: serif.id })).asset;
  assert.deepEqual(serifAsset.motion.fontSources.map((font: any) => font.weight), [900,600]);
  const serifDirectory = dirname(join(projectRoot, serifAsset.motion.sourcePath));
  const serifManifest = JSON.parse(await readFile(join(serifDirectory, "manifest.json"), "utf8"));
  assert.ok(["exact","tolerated"].includes(serifManifest.determinism.status));
  await verifyMotionPreviewFrames(join(projectRoot, serifAsset.managedPath), 2, 30);
  const expanded = [];
  // 每份发行原件分别走真实MCP、队列和Worker；只创建独立候选项目。
  for (const font of capabilities.fonts.slice(4)) {
    const state = await call("read_project", { project_id: projectId });
    const job = await call("submit_motion_work", { project_id: projectId, base_revision_id: state.revision.number,
      idempotency_key: `expanded-${font.id}`, work: { ...motionFixture, reference: undefined, width: 960, height: 192, durationInFrames: 2,
        fontBindings: { face: font.id }, props: { label: font.name },
        source: `import React from 'react';import {useCurrentFrame} from 'remotion';export default p=><div style={{position:'absolute',inset:0,color:'white',padding:12}}><div style={{fontSize:20}}>{p.label}</div><div style={{fontSize:64,lineHeight:'96px',fontFamily:p.fonts.face.family,fontWeight:p.fonts.face.weight,fontStyle:p.fonts.face.style,fontSynthesis:'none',transform:'translateX('+useCurrentFrame()*2+'px)'}}>时代不同不能冷场</div></div>` } });
    const completed = await waitJob(job.id);
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    const asset = (await call("read_motion_work", { project_id: projectId, job_id: job.id })).asset;
    const directory = dirname(join(projectRoot, asset.motion.sourcePath));
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.ok(["exact", "tolerated"].includes(manifest.determinism.status));
    const binding = manifest.boundFonts[0];
    assert.equal(binding.hash, font.sha256);
    assert.equal(binding.weight, font.weight);
    assert.equal(binding.style, font.style);
    const extension = fontCatalog.fonts.find((entry: any) => entry.id === font.id).file.split(".").at(-1);
    assert.equal(createHash("sha256").update(await readFile(join(directory, "resources/font-files", `${font.sha256}.${extension}`))).digest("hex"), font.sha256);
    const firstFrame = join(directory, "frames/frame-00000.png");
    const png = PNG.sync.read(await readFile(firstFrame));
    let ink = 0;
    for (let y = 48; y < 150; y++) for (let x = 0; x < png.width; x++) if (png.data[(y * png.width + x) * 4 + 3]! > 100) ink++;
    assert.ok(ink > 500, "新增细体和粗体首帧必须已有中文字形");
    await verifyMotionPreviewFrames(join(projectRoot, asset.managedPath), 2, 30);
    expanded.push({ font, jobId: job.id, firstFrame, ink, determinism: manifest.determinism.status });
    console.log(JSON.stringify({ 阶段: "新增字体候选完成", fontId: font.id, actualWeight: binding.weight }));
  }
  const report = { 已验证: true, 范围: "独立候选发行技术验证，未修改正式视频项目，未部署正式服务", root, port, release,
    字体目录: capabilities.fonts, 完成任务: completed.id, 无绑定任务: legacy.id,
    字体记录: rendered.asset.motion.fontSources, 新增字体逐份验证: expanded, 重复帧检查: manifest.determinism, preview,
    首帧: join(directory, "frames/frame-00000.png"), 未登记字体错误: unknown, 导入限制提示: rejectedHook,
    衬线字样: { jobId: serif.id, 字体记录: serifAsset.motion.fontSources, 首帧: join(serifDirectory, "frames/frame-00000.png"), preview: join(projectRoot, serifAsset.managedPath), 重复帧检查: serifManifest.determinism } };
  await writeFile(join(root, "字体候选验证.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ 阶段: "候选验证完成", reportPath: join(root, "字体候选验证.json"), preview, releaseId: runtime.releaseId }));
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await runCandidateRuntime("stop", args);
}
