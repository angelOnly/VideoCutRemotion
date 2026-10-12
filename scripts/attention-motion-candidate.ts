import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// 所有写入只发生在独立技术验证项目。正式输入只读导出，不改正式Job或Revision。
const require = createRequire(import.meta.url);
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
const repoRoot = resolve(import.meta.dirname, "..");
const root = join(repoRoot, ".repair-validation", "attention-runtime");
const pluginRoot = join(repoRoot, "plugins/videoflowcut");
const dist = join(pluginRoot, "runtime/dist");
const args = ["--repo-root", repoRoot, "--workspace", root, "--port", "13107", "--comfyui-bridge-url", "http://127.0.0.1:18199"];
const runtime = await runCandidateRuntime("ensure", args);
const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
assert.equal(runtime.releaseId, manifest.releaseId);
const transport = new StdioClientTransport({ command: process.execPath, args: [join(dist, "mcp.cjs")], cwd: repoRoot, stderr: "pipe", env: { ...process.env as Record<string, string>, NODE_PATH: join(repoRoot, "node_modules"), VIDEOCUT_WORKSPACE: root, WEB_ORIGIN: "http://127.0.0.1:13107/", VIDEOFLOWCUT_RUNTIME_DIST: dist, VIDEOFLOWCUT_RELEASE_ID: manifest.releaseId, COMFYUI_BRIDGE_URL: "http://127.0.0.1:18199" } });
const client = new Client({ name: "动画修复发行候选验证", version: "1.0.0" });
const call = async (name: string, parameters: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: parameters });
  assert.notEqual(response.isError, true, `${name}：${JSON.stringify(response.content)}`);
  const block = (response.content as { type: string; text?: string }[]).find(item => item.type === "text") as { text: string };
  return JSON.parse(block.text);
};
const wait = async (jobId: string) => {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: jobId });
    if (["succeeded", "failed", "unknown", "cancelled"].includes(job.status)) { assert.equal(job.status, "succeeded", JSON.stringify(job)); return job; }
    if (job.result?.motionProgress) console.log(JSON.stringify(job.result.motionProgress));
    await new Promise(done => setTimeout(done, 5000));
  }
  throw new Error("候选验证超时；保留原Job不重放");
};
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.ok(catalog.tools.find(tool => tool.name === "read_job_diagnostics")?.annotations?.readOnlyHint);
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true); assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  console.log(JSON.stringify({ 阶段: "发行候选健康", release, root }));
  const fixed = JSON.parse(await readFile(".repair-validation/attention-motion-input.json", "utf8"));
  if (process.env.ATTENTION_VERIFY_EXISTING === "1") {
    const projectId = "project_96095a8a-755b-4442-bafc-96d0fed25479";
    const jobId = "job_a80f79a8-4b51-4940-9b7f-2de5e728ff59";
    const completed = await call("track_job", { job_id: jobId });
    assert.equal(completed.status, "succeeded");
    const readback = await call("read_motion_work", { project_id: projectId, job_id: jobId });
    assert.equal(readback.asset.motion.frameCount, 862);
    assert.deepEqual(readback.asset.motion.fontSources.map((font: any) => font.sourceHash).sort(), fixed.payload.boundFonts.map((font: any) => font.hash).sort());
    const state = await call("read_project", { project_id: projectId });
    const smoke = { ...fixed.payload.work, name: "最终发行三大字体启动冒烟验证", durationInFrames: 2, imageBindings: {}, videoBindings: {}, source: "import React from 'react';export default p=><div>{['display','serif','body'].map(slot=><div key={slot} style={{fontFamily:p.fonts[slot].family,fontWeight:p.fonts[slot].weight,color:'white',fontSize:32}}>时代不同不能冷场</div>)}</div>" };
    const smokeJob = await call("submit_motion_work", { project_id: projectId, base_revision_id: state.revision.number, idempotency_key: "final-three-font-smoke-" + manifest.releaseId, work: smoke });
    const smokeDone = await wait(smokeJob.id);
    const result = { release, root, projectId, jobId, frameCount: 862, assetId: readback.asset.id, metadata: readback.asset.metadata, fontSources: readback.asset.motion.fontSources, result: completed.result, finalReleaseSmokeJobId: smokeJob.id, finalReleaseSmokeResult: smokeDone.result };
    await writeFile(join(root, "candidate-validation.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ success: true, releaseId: manifest.releaseId, frameCount: 862, smokeJobId: smokeJob.id }));
  } else {
  const created = await call("create_project", { name: "动画修复完整固定输入技术验证", profile: "visual_explainer", fps: 30 });
  const projectId = created.snapshot.project.id;
  let revision = created.revision.number;
  const mapping = new Map<string, string>();
  for (const binding of [...fixed.payload.boundImages, ...fixed.payload.boundVideos]) {
    if (mapping.has(binding.assetId)) continue;
    const imported = await call("import_media", { project_id: projectId, base_revision_id: revision, file_path: join(root, binding.managedPath), role: "cutaway" });
    await wait(imported.job.id);
    const state = await call("read_project", { project_id: projectId });
    const asset = state.snapshot.assets.find((item: any) => item.id === imported.asset.id);
    assert.equal(asset.status, "ready"); assert.equal(asset.sourceHash, binding.hash);
    mapping.set(binding.assetId, asset.id); revision = state.revision.number;
  }
  const work = structuredClone(fixed.payload.work);
  for (const slot of Object.keys(work.imageBindings)) work.imageBindings[slot] = mapping.get(work.imageBindings[slot]);
  for (const binding of Object.values(work.videoBindings) as any[]) binding.assetId = mapping.get(binding.assetId);
  assert.equal(work.source, fixed.payload.work.source);
  const submitted = await call("submit_motion_work", { project_id: projectId, base_revision_id: revision, idempotency_key: "attention-fixed-full-release-validation", work });
  const completed = await wait(submitted.id);
  const readback = await call("read_motion_work", { project_id: projectId, job_id: submitted.id });
  assert.equal(readback.asset.motion.frameCount, 862);
  assert.deepEqual(readback.asset.motion.fontSources.map((font: any) => font.sourceHash).sort(), fixed.payload.boundFonts.map((font: any) => font.hash).sort());
  const result = { release, root, projectId, jobId: submitted.id, assetId: readback.asset.id, metadata: readback.asset.metadata, frameCount: readback.asset.motion.frameCount, fontSources: readback.asset.motion.fontSources, result: completed.result };
  await writeFile(join(root, "candidate-validation.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ success: true, releaseId: manifest.releaseId, jobId: submitted.id, frameCount: 862 }));
  }
} finally { await client.close(); await transport.close(); }
