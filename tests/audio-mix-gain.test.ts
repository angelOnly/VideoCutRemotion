import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../apps/server/src/app.js";
import { registerSoundTools } from "../apps/server/src/sound-tools.js";
import { createMediaAsset, createTimelineItem, createScene } from "@videocut/domain";
import { runProcess } from "@videocut/speech";
import { soundDependencySignature } from "../packages/media-intelligence/src/sound-signature.js";
import { applyFinalAudioMixGain } from "../apps/render-worker/src/audio-mix-gain.js";
import { inspectFinalAudio } from "../packages/media-intelligence/src/acoustics.js";
import type { ProjectSnapshot } from "@videocut/contracts";

test("整体增益 MCP/HTTP 设置绝对值、保护版本并使全片混合待审，不改音轨参数", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-mix-gain-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  const server = new McpServer({ name: "mix-gain-contract", version: "1.0.0" });
  const client = new Client({ name: "mix-gain-test", version: "1.0.0" });
  const created = application.createProject({ name: "总增益隔离合同" });
  const projectId = created.snapshot.project.id;
  const current = () => application.readProject(projectId);
  const source = createMediaAsset({ name: "合同音频", kind: "audio", role: "bgm", managedPath: "assets/tone.wav" });
  application.repository.commit(projectId, current().revision.number, "隔离夹具", (snapshot) => {
    snapshot.assets.push({ ...source, status: "ready", metadata: { durationMs: 2000, hasAudio: true } });
    snapshot.timeline.items.push(createTimelineItem({ trackId: snapshot.timeline.tracks.find((track) => track.name === "Dialogue")!.id, assetId: source.id, startFrame: 0, endFrame: 48, sourceStartFrame: 0, sourceEndFrame: 48 }));
    snapshot.scenes.push(createScene({ type: "PresenterScene", title: "合同场景", purpose: "隔离混合验证", startFrame: 0, endFrame: 48 }));
  });
  application.manageAudio({ projectId, baseRevision: current().revision.number, action: "create", assetId: source.id, kind: "bgm", purpose: "总增益比例验证", startFrame: 0, endFrame: 48, sourceStartFrame: 0, sourceEndFrame: 48, gainDb: -18 });
  application.repository.commit(projectId, current().revision.number, "模拟旧混合审阅", (snapshot) => { snapshot.audioCues[0].mixReview = "reviewed"; });
  const before = current();
  registerSoundTools(server, application, () => projectId);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "set_audio_mix_gain")!;
    assert.ok(tool);
    const call = (gain: number, revision = current().revision.number) => client.callTool({ name: "set_audio_mix_gain", arguments: { base_revision_id: revision, gain_db: gain } });
    assert.equal((await call(25)).isError, true);
    assert.equal((await call(9.5, before.revision.number - 1)).isError, true);
    assert.equal(current().revision.number, before.revision.number);
    assert.notEqual((await call(9.5)).isError, true);
    const after = current();
    assert.equal(after.snapshot.audioMixGainDb, 9.5);
    assert.deepEqual(after.snapshot.timeline, before.snapshot.timeline);
    assert.deepEqual(after.snapshot.assets, before.snapshot.assets);
    assert.equal(after.snapshot.audioCues[0].mixReview, "needs_review");
    assert.deepEqual(after.snapshot.audioCues.map(({ mixReview, ...rest }) => rest), before.snapshot.audioCues.map(({ mixReview, ...rest }) => rest));
    assert.notEqual(soundDependencySignature(before.snapshot), soundDependencySignature(after.snapshot));
    assert.ok(after.revision.impact.dirtyRanges.some((range) => range.startFrame === 0 && range.endFrame === 48));
    assert.notEqual((await call(9.5)).isError, true);
    assert.equal(current().snapshot.audioMixGainDb, 9.5, "不能累加成19dB");
    const post = (gainDb: unknown) => app.inject({ method: "POST", url: `/api/projects/${projectId}/audio-mix-gain`, payload: { baseRevision: current().revision.number, gainDb } });
    assert.equal((await post(-49)).statusCode, 400);
    assert.equal((await post("9.5")).statusCode, 400);
    assert.equal((await post(0)).statusCode, 200);
    assert.equal(current().snapshot.audioMixGainDb, 0);
    assert.equal(soundDependencySignature(before.snapshot), soundDependencySignature(current().snapshot), "归零兼容旧版声音身份");
  } finally { await client.close(); await server.close(); await app.close(); application.repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("最终混合只提升音轨一次、复制视频并保留旧版零增益；失败不能伪装成功", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-mix-wave-"));
  const snapshot = {} as ProjectSnapshot;
  const file = join(root, "mixed.mp4"), original = join(root, "original.mp4");
  try {
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24:d=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-af", "volume=-12dB", "-c:v", "libx264", "-c:a", "aac", "-shortest", file]);
    await copyFile(file, original);
    const before = await inspectFinalAudio(file);
    await applyFinalAudioMixGain(snapshot, file);
    assert.deepEqual(await readFile(file), await readFile(original));
    await applyFinalAudioMixGain({ ...snapshot, audioMixGainDb: 9.5 }, file);
    const after = await inspectFinalAudio(file);
    assert.ok(Math.abs(after.integratedLufs! - before.integratedLufs! - 9.5) < 0.3, JSON.stringify({ before, after }));
    assert.ok(Math.abs(after.truePeakDbfs! - before.truePeakDbfs! - 9.5) < 0.5);
    const videoHash = async (path: string) => (await runProcess("ffmpeg", ["-v", "error", "-i", path, "-map", "0:v:0", "-c", "copy", "-f", "hash", "-"])).trim();
    assert.equal(await videoHash(file), await videoHash(original));
    for (const audioMixGainDb of [NaN, Infinity, -49, 25]) await assert.rejects(applyFinalAudioMixGain({ ...snapshot, audioMixGainDb }, file), /整体混合增益/);
    await assert.rejects(applyFinalAudioMixGain({ ...snapshot, audioMixGainDb: 9.5 }, join(root, "missing.mp4")));
    assert.ok((await readFile(".agents/skills/audio-finishing/SKILL.md", "utf8")).includes("set_audio_mix_gain"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
