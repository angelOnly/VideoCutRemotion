import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { runProcess, probeMedia } from "@videocut/speech";

// 仅创建独立候选工作区，禁止将验证指向正式 workspace。
const root = resolve(".repair-validation/audio-mix-gain-20260916");
const workspace = join(root, "workspace");
assert.notEqual(workspace, resolve("workspace"));
const plugin = join(root, "candidate/plugins/videoflowcut");
const application = createApplication(workspace);
const project = application.createProject({ name: "整体增益独立发行验证" });
const projectId = project.snapshot.project.id;
const state = () => application.readProject(projectId);
const source = join(project.snapshot.project.rootPath, "assets/source/fixture.mp4");
await mkdir(join(project.snapshot.project.rootPath, "assets/source"), { recursive: true });
await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-af", "volume=-12dB", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
const imported = application.registerImportedAsset({ projectId, baseRevision: state().revision.number, name: "技术验证声画", kind: "video", managedPath: "assets/source/fixture.mp4", provenance: { source: "generated", acquiredAt: new Date().toISOString() } });
application.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(source) });
application.buildPresenterTimeline({ projectId, baseRevision: state().revision.number, assetIds: [imported.asset.id] });
application.repository.commit(projectId, state().revision.number, "隔离小尺寸验证", (snapshot) => { snapshot.timeline.width = 320; snapshot.timeline.height = 180; });
application.repository.close();
const client = new Client({ name: "mix-gain-candidate", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(plugin, "scripts/mcp-launcher.mjs")], stderr: "pipe", env: { ...process.env, ...getDefaultEnvironment(), VIDEOCUT_WORKSPACE: workspace, VIDEOFLOWCUT_PORT: "3197" } });
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse((result.content as Array<{ type: string; text: string }>).find((entry) => entry.type === "text")!.text);
};
const awaitJob = async (id: string) => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: id });
    if (job.status === "succeeded") return job;
    assert.notEqual(job.status, "failed", JSON.stringify(job));
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`候选任务等待超时：${id}`);
};
try {
  await client.connect(transport);
  const schema = (await client.listTools()).tools.find((entry) => entry.name === "set_audio_mix_gain")!.inputSchema;
  assert.deepEqual(schema.required, ["base_revision_id", "gain_db"]);
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.ok(release.runtime.workers.media && release.runtime.workers.render);
  const before = await call("read_project", { project_id: projectId });
  const duration = before.snapshot.timeline.durationInFrames;
  const render = async (from: number, to: number) => {
    const submission = await call("render_preview_range", { project_id: projectId, from_frame: from, to_frame: to });
    return awaitJob(submission.id);
  };
  const baseline = await render(0, duration);
  console.log(JSON.stringify({ stage: "baseline", audio: baseline.result.audio }));
  const priorToGain = await call("read_project", { project_id: projectId });
  const changed = await call("set_audio_mix_gain", { project_id: projectId, base_revision_id: priorToGain.revision.number, gain_db: 9.5 });
  assert.equal(changed.snapshot.audioMixGainDb, 9.5);
  assert.deepEqual(changed.snapshot.timeline, priorToGain.snapshot.timeline);
  const preview = await render(0, duration);
  const partial = await render(0, Math.floor(duration / 2));
  const exported = await call("submit_export", { project_id: projectId, revision: changed.revision.number, purpose: "draft" });
  const output = await awaitJob(exported.id);
  for (const result of [preview.result, partial.result]) assert.ok(Math.abs(result.audio.integratedLufs - baseline.result.audio.integratedLufs - 9.5) < 0.3, JSON.stringify(result));
  const exportPath = output.result.path;
  const { inspectFinalAudio } = await import("../packages/media-intelligence/src/acoustics.js");
  const finalAudio = await inspectFinalAudio(exportPath);
  assert.ok(Math.abs(finalAudio.integratedLufs! - baseline.result.audio.integratedLufs - 9.5) < 0.3, JSON.stringify(finalAudio));
  const manifest = JSON.parse(await readFile(join(plugin, "runtime/dist/manifest.json"), "utf8"));
  await writeFile(join(root, "result.json"), JSON.stringify({ schema, release, manifest, projectId, baseline, changed, preview, partial, output, finalAudio }, null, 2));
  console.log(JSON.stringify({ stage: "complete", releaseId: release.mcpReleaseId, baseline: baseline.result.audio, preview: preview.result.audio, partial: partial.result.audio, export: finalAudio }));
} finally { await client.close(); }
