import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { createTimelineItem } from "@videocut/domain";
import { runProcess, probeMedia } from "@videocut/speech";
import { inspectFinalAudio } from "../packages/media-intelligence/src/acoustics.js";

// 技术夹具只存在于独立数据库，禁止连接正式项目与 Worker 队列。
const root = resolve(".repair-validation/dialogue-muted");
const workspace = join(root, "workspace");
const app = createApplication(workspace);
const created = app.createProject({ name: "Dialogue 静音候选技术验证" });
const projectId = created.snapshot.project.id;
const current = () => app.readProject(projectId);
const sourceRoot = join(created.snapshot.project.rootPath, "assets/source");
await mkdir(sourceRoot, { recursive: true });
const video = join(sourceRoot, "fixture.mp4"), tone = join(sourceRoot, "tone.wav");
await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", tone]);
const add = async (name: string, kind: "video" | "audio", path: string) => {
  const added = app.registerImportedAsset({ projectId, baseRevision: current().revision.number, name, kind, managedPath: `assets/source/${name}`, provenance: { source: "generated", acquiredAt: new Date().toISOString() } });
  app.applyMediaAnalysis({ projectId, assetId: added.asset.id, metadata: await probeMedia(path) });
  return added.asset.id;
};
const videoId = await add("fixture.mp4", "video", video), toneId = await add("tone.wav", "audio", tone);
app.buildPresenterTimeline({ projectId, baseRevision: current().revision.number, assetIds: [videoId] });
app.repository.commit(projectId, current().revision.number, "隔离旁白夹具", snapshot => {
  snapshot.timeline.width = 320; snapshot.timeline.height = 180;
  snapshot.timeline.items.push(createTimelineItem({ trackId: snapshot.timeline.tracks.find(track => track.name === "Dialogue")!.id, assetId: toneId, startFrame: 0, endFrame: 48, sourceStartFrame: 0, sourceEndFrame: 48 }));
  snapshot.speechAsset = { id: "speech_fixture", assetId: toneId, scriptRevision: snapshot.script.revision, segmentAssetIds: [], timing: { precision: "segment_exact", source: "合成技术测试信号", segments: [] }, status: "ready" };
});
app.repository.close();
const client = new Client({ name: "dialogue-muted-candidate", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("plugins/videoflowcut/scripts/mcp-launcher.mjs")], stderr: "pipe", env: { ...process.env, VIDEOFLOWCUT_REPO_ROOT: resolve("."), VIDEOCUT_WORKSPACE: workspace, VIDEOFLOWCUT_PORT: "3523", COMFYUI_BRIDGE_URL: "http://127.0.0.1:18203" } });
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const raw = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  assert.ok(!raw.isError, JSON.stringify(raw));
  return JSON.parse((raw.content as Array<{ type: string; text: string }>).find(entry => entry.type === "text")!.text);
};
const wait = async (id: string) => {
  for (let i = 0; i < 180; i++) {
    const job = await call("track_job", { job_id: id });
    if (job.status === "succeeded") return job;
    assert.ok(!["failed", "cancelled"].includes(job.status), JSON.stringify(job));
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error("候选渲染超时");
};
try {
  await client.connect(transport);
  const schema = (await client.listTools()).tools.find(tool => tool.name === "set_dialogue_muted")!.inputSchema;
  assert.deepEqual(schema.required, ["base_revision_id", "muted"]);
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true); assert.equal(release.runtime.workers.media, true); assert.equal(release.runtime.workers.render, true);
  const preview = async () => wait((await call("render_preview_range", { project_id: projectId, from_frame: 0, to_frame: 48 })).id);
  const baseline = await preview();
  assert.ok(baseline.result.audio?.truePeakDbfs != null);
  const before = await call("read_project", { project_id: projectId });
  const muted = await call("set_dialogue_muted", { project_id: projectId, base_revision_id: before.revision.number, muted: true });
  assert.deepEqual(muted.snapshot.timeline.items, before.snapshot.timeline.items);
  assert.deepEqual(muted.snapshot.speechAsset, before.snapshot.speechAsset);
  const silent = await preview();
  assert.ok(!silent.result.hasAudio || silent.result.audio?.truePeakDbfs == null, JSON.stringify(silent));
  const exported = await wait((await call("submit_export", { project_id: projectId, revision: muted.revision.number, purpose: "draft" })).id);
  const measured = await inspectFinalAudio(exported.result.path);
  assert.equal(measured.truePeakDbfs, null, JSON.stringify(measured));
  const state = await call("read_project", { project_id: projectId });
  await call("set_dialogue_muted", { project_id: projectId, base_revision_id: state.revision.number, muted: false });
  const restored = await preview();
  assert.ok(Math.abs(restored.result.audio.truePeakDbfs - baseline.result.audio.truePeakDbfs) < 0.2);
  await writeFile(join(root, "validation.json"), JSON.stringify({ candidateOnly: true, release, schema, projectId, baseline, silent, exported, measured, restored }, null, 2));
  console.log(JSON.stringify({ verified: true, release: release.mcpReleaseId, baseline: baseline.result.audio, silent: silent.result.audio, export: measured, restored: restored.result.audio }));
} finally { await client.close(); }
