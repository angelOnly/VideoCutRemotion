import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication, RevisionConflictError } from "@videocut/application";
import { createMediaAsset, createTimelineItem, createScene, projectFrameRateChange } from "@videocut/domain";
import { inspectEffectContentContract, motionFrameAtProjectFrame } from "@videocut/contracts";
import { createServer } from "../apps/server/src/app.js";
import { motionFixture } from "./fixtures/managed-motion.js";
import { effectAudioSignature } from "../packages/edit-application/src/effect-audio-events.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function fixture(fps = 24) {
  const root = await mkdtemp(join(tmpdir(), "vfc-project-fps-"));
  const app = createApplication(root);
  const projectId = app.createProject({ name: "帧率回归隔离项目", fps }).snapshot.project.id;
  const revision = () => app.readProject(projectId).revision.number;
  const seed = app.repository.commit(projectId, revision(), "构造源范围和共同边界", snapshot => {
    const asset = createMediaAsset({ name: "fixture.mp4", kind: "video", managedPath: "assets/test.mp4", sourceHash: "source" });
    Object.assign(asset, { status: "ready", metadata: { durationMs: 10000, width: 320, height: 320, fps: 25, hasAudio: false } });
    snapshot.assets.push(asset);
    Object.assign(snapshot.timeline, { width: 320, height: 320 });
    const scene = createScene({ type: "PresenterScene", title: "隔离场景", purpose: "验证时间投影", startFrame: 0, endFrame: fps * 4 });
    snapshot.scenes.push(scene);
    for (const startFrame of [0, fps * 2]) snapshot.timeline.items.push(createTimelineItem({ sceneId: scene.id, assetId: asset.id, trackId: snapshot.timeline.tracks.find(t => t.name === "Actor / A-roll")!.id, startFrame, endFrame: startFrame + fps * 2, sourceStartFrame: startFrame, sourceEndFrame: startFrame + fps * 2 }));
    snapshot.timeline.durationInFrames = fps * 4;
    snapshot.markers.push({ id: "marker", frame: fps * 2, label: "切口", level: "info" });
  });
  return { root, app, projectId, revision, seed, close: async () => { app.close(); await rm(root, { recursive: true, force: true }); } };
}

test("创建可选fps、变更预检查只读、相同值幂等、历史快照保留", async () => {
  const f = await fixture();
  try {
    assert.equal(f.app.createProject({ name: "默认规格" }).snapshot.timeline.fps, 24);
    assert.equal(f.app.createProject({ name: "指定规格", fps: 30 }).snapshot.timeline.fps, 30);
    for (const fps of [0, 14, 61, 29.97, NaN]) assert.throws(() => f.app.createProject({ name: "非法规格", fps }), /帧率/u);
    const before = f.app.readProject(f.projectId);
    const input = { projectId: f.projectId, baseRevision: before.revision.number, fps: 30 };
    const report = f.app.previewProjectFrameRateChange(input);
    assert.equal(report.canApply, true, JSON.stringify(report));
    assert.equal(f.revision(), before.revision.number);
    const after = f.app.setProjectFrameRate(input);
    assert.equal(after.snapshot.timeline.fps, 30);
    assert.deepEqual(after.snapshot.timeline.items.map(i => [i.startFrame, i.endFrame, i.sourceStartFrame, i.sourceEndFrame]), [[0, 60, 0, 60], [60, 120, 60, 120]]);
    assert.deepEqual(after.snapshot.assets, before.snapshot.assets);
    assert.equal(after.snapshot.markers[0].frame, 60);
    assert.equal(after.snapshot.timeline.durationInFrames, 120);
    assert.deepEqual(f.app.repository.getRevision(f.projectId, before.revision.number).snapshot, before.snapshot);
    assert.equal(f.app.setProjectFrameRate({ ...input, baseRevision: after.revision.number }).revision.number, after.revision.number);
    assert.throws(() => f.app.setProjectFrameRate(input), RevisionConflictError);
    const back = f.app.setProjectFrameRate({ ...input, baseRevision: after.revision.number, fps: 24 });
    assert.deepEqual(back.snapshot.timeline.items, before.snapshot.timeline.items);
  } finally { await f.close(); }
});

test("降采样零帧与未終态回写任务拒绝，固定历史预览不阻挡", async () => {
  const f = await fixture(60);
  try {
    const short = f.app.repository.commit(f.projectId, f.revision(), "短片段", snapshot => { snapshot.timeline.items[0].endFrame = 1; snapshot.timeline.items[0].sourceEndFrame = 1; });
    let report = f.app.previewProjectFrameRateChange({ projectId: f.projectId, baseRevision: short.revision.number, fps: 15 });
    assert.ok(report.blockers.some(b => b.code === "PROJECT_FPS_RANGE_COLLAPSED"));
    assert.throws(() => f.app.setProjectFrameRate({ projectId: f.projectId, baseRevision: short.revision.number, fps: 15 }), /不足一帧/u);
    assert.equal(f.revision(), short.revision.number);
    const pending = f.app.repository.createJob({ projectId: f.projectId, kind: "voice_synthesis", payload: {}, idempotencyKey: "pending" });
    report = f.app.previewProjectFrameRateChange({ projectId: f.projectId, baseRevision: f.revision(), fps: 30 });
    assert.ok(report.blockers.some(b => b.objectId === pending.id));
    f.app.updateJob(pending.id, { status: "unknown" });
    assert.equal(f.app.previewProjectFrameRateChange({ projectId: f.projectId, baseRevision: f.revision(), fps: 30 }).canApply, false);
    f.app.updateJob(pending.id, { status: "failed" });
    f.app.repository.createJob({ projectId: f.projectId, kind: "preview", payload: { revision: f.revision() }, idempotencyKey: "read-only" });
    assert.equal(f.app.previewProjectFrameRateChange({ projectId: f.projectId, baseRevision: f.revision(), fps: 30 }).canApply, true);
  } finally { await f.close(); }
});

test("跨fps受管作品完整放置、帧映射与声音事件保持，内容变更仍失效", async () => {
  const f = await fixture();
  try {
    const job = f.app.submitManagedMotion({ projectId: f.projectId, baseRevision: f.revision(), idempotencyKey: "motion", work: { ...motionFixture, fps: 30, durationInFrames: 60 } });
    const asset = f.app.completeManagedMotion({ projectId: f.projectId, jobId: job.id, sourceHash: "work", engineVersion: "fixture-only", metadata: { durationMs: 2000, width: 320, height: 320, fps: 30, hasAudio: false }, eventMap: { version: String(job.payload.version), fps: 30, frameCount: 60, events: [{ id: "settled", meaning: "落定", startFrame: 30 }] } });
    f.app.updateJob(job.id, { status: "succeeded" });
    const placed = f.app.createEffectCue({ projectId: f.projectId, baseRevision: f.revision(), sceneId: f.seed.snapshot.scenes[0].id, type: "ManagedMotion", layer: "front", startFrame: 0, endFrame: 48, assetBindings: [{ slot: "motion", assetId: asset.id }] });
    const cue = placed.snapshot.effectCues[0];
    assert.equal(inspectEffectContentContract(cue, placed.snapshot.assets, placed.snapshot.timeline).ready, true);
    assert.equal(placed.snapshot.timeline.durationInFrames, 96, "跨fps作品必须实际参与合成与时长计算");
    assert.equal(motionFrameAtProjectFrame(24, 30, 24, 60), 30);
    assert.equal(motionFrameAtProjectFrame(47, 30, 24, 60), 58);
    assert.throws(() => motionFrameAtProjectFrame(48, 30, 24, 60), /越界/u);
    const seeded = f.app.repository.commit(f.projectId, f.revision(), "构造音效原文件", snapshot => {
      const sound = createMediaAsset({ name: "sfx.wav", kind: "audio", managedPath: "assets/sfx.wav", sourceHash: "sound", role: "sfx" });
      Object.assign(sound, { status: "ready", metadata: { durationMs: 1000, hasAudio: true } }); snapshot.assets.push(sound);
    });
    const audio = f.app.manageAudio({ projectId: f.projectId, baseRevision: f.revision(), action: "create", kind: "sfx", assetId: seeded.snapshot.assets.at(-1)!.id, purpose: "落定事件回归", eventFrame: 24, onsetOffsetFrames: 0, effectEvent: { effectCueId: cue.id, eventName: "落定", eventId: "settled", workVersion: asset.motion!.version, localFrame: 24 } });
    const report = f.app.previewProjectFrameRateChange({ projectId: f.projectId, baseRevision: audio.revision.number, fps: 60 });
    assert.equal(report.canApply, true, JSON.stringify(report));
    const after = f.app.setProjectFrameRate({ projectId: f.projectId, baseRevision: audio.revision.number, fps: 60 });
    assert.deepEqual(after.snapshot.assets.find(a => a.id === asset.id), audio.snapshot.assets.find(a => a.id === asset.id));
    assert.deepEqual([after.snapshot.effectCues[0].status, after.snapshot.effectCues[0].endFrame], ["ready", 120]);
    const sound = after.snapshot.audioCues[0];
    assert.deepEqual([sound.status, sound.eventFrame, sound.effectEvent?.localFrame, sound.mixReview], ["ready", 60, 60, "needs_review"]);
    assert.equal(sound.effectEvent!.cueSignature, effectAudioSignature(after.snapshot, after.snapshot.effectCues[0]));
    assert.equal(after.snapshot.timeline.items.find(i => i.id === sound.timelineItemId)!.disabled, false);
    const changed = f.app.repository.commit(f.projectId, f.revision(), "修改覆盖场景时长", snapshot => { snapshot.scenes[0].endFrame -= 20; });
    assert.equal(changed.snapshot.effectCues[0].status, "stale");
    assert.equal(changed.snapshot.audioCues[0].status, "stale");
  } finally { await f.close(); }
});

test("毫秒证据、作品内部帧与源元数据保留，字幕、显示范围和负偏移明确投影", async () => {
  const f = await fixture();
  try {
    const snapshot = structuredClone(f.seed.snapshot);
    snapshot.speechAsset = { id: "speech", assetId: "speech-source", scriptRevision: 1, segmentAssetIds: [], timing: { precision: "segment_exact", source: "measured", segments: [{ speechSegmentId: "seg", startMs: 1033, endMs: 2057, startFrame: 25, endFrame: 49 }] }, status: "ready" };
    snapshot.timeline.captions.push({ id: "card", speechSegmentId: "seg", text: "真实毫秒", startFrame: 25, endFrame: 49, style: "stable", precision: "segment_exact", display: { mode: "shown", ranges: [{ startFrame: 26, endFrame: 45 }] } });
    const changed = projectFrameRateChange(snapshot, 30);
    assert.equal(changed.report.canApply, true);
    assert.deepEqual(changed.snapshot.speechAsset!.timing.segments[0], { speechSegmentId: "seg", startMs: 1033, endMs: 2057, startFrame: 31, endFrame: 62 });
    assert.deepEqual(changed.snapshot.timeline.captions[0].display?.ranges, [{ startFrame: 33, endFrame: 56 }]);
    assert.equal(changed.snapshot.timeline.captions[0].startFrame, 31);
    assert.deepEqual(changed.snapshot.assets, snapshot.assets);
  } finally { await f.close(); }
});

test("HTTP新建与修改沿用同一fps合同，预检查后版本变化拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-http-fps-"));
  const server = await createServer({ workspaceRoot: root });
  try {
    const created = await server.app.inject({ method: "POST", url: "/api/projects", payload: { name: "HTTP规格", fps: 30 } });
    assert.equal(created.statusCode, 201);
    const state = created.json(); const id = state.snapshot.project.id;
    assert.equal(state.snapshot.timeline.fps, 30);
    const check = await server.app.inject({ method: "POST", url: `/api/projects/${id}/frame-rate/preview`, payload: { baseRevision: 1, fps: 60 } });
    assert.equal(check.json().canApply, true);
    const changed = await server.app.inject({ method: "POST", url: `/api/projects/${id}/frame-rate`, payload: { baseRevision: 1, fps: 60 } });
    assert.equal(changed.json().snapshot.timeline.fps, 60);
    const stale = await server.app.inject({ method: "POST", url: `/api/projects/${id}/frame-rate`, payload: { baseRevision: 1, fps: 24 } });
    assert.equal(stale.statusCode, 409);
    const invalid = await server.app.inject({ method: "POST", url: `/api/projects/${id}/frame-rate`, payload: { baseRevision: 2, fps: 29.97 } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(server.application.readProject(id).revision.number, 2);
  } finally { await server.app.close(); server.application.close(); await rm(root, { recursive: true, force: true }); }
});

test("真实MCP表提供fps参数与只读预检查，新客户端沿正式工具完成变更", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-mcp-fps-"));
  const client = new Client({ name: "frame-rate-regression", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["node_modules/tsx/dist/cli.mjs", "apps/server/src/mcp.ts"], env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), VIDEOCUT_WORKSPACE: root } });
  const text = (result: unknown) => {
    const value = result as { content: Array<{ type: string; text?: string }> };
    return JSON.parse(value.content.find(entry => entry.type === "text")!.text!);
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.find(t => t.name === "create_project")!.inputSchema.properties?.fps);
    assert.equal(tools.find(t => t.name === "preview_project_frame_rate_change")!.annotations?.readOnlyHint, true);
    const created = text(await client.callTool({ name: "create_project", arguments: { name: "MCP隔离帧率", fps: 30 } }));
    const id = created.snapshot.project.id;
    assert.equal(created.snapshot.timeline.fps, 30);
    const report = text(await client.callTool({ name: "preview_project_frame_rate_change", arguments: { project_id: id, base_revision_id: 1, fps: 60 } }));
    assert.equal(report.revision, 1); assert.equal(report.canApply, true);
    const changed = text(await client.callTool({ name: "set_project_frame_rate", arguments: { project_id: id, base_revision_id: 1, fps: 60 } }));
    assert.equal(changed.revision.number, 2); assert.equal(changed.snapshot.timeline.fps, 60);
  } finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
});

test("非零会话起点的多机位换算保留主声音与负同步偏移", async () => {
  const f = await fixture();
  try {
    const cameras = f.app.repository.commit(f.projectId, f.revision(), "隔离多机位原件", snapshot => {
      snapshot.timeline.items = []; snapshot.scenes = [];
      const first = snapshot.assets[0]; first.metadata!.hasAudio = true; first.metadata!.videoCodec = "h264";
      const second = structuredClone(first); second.id = "camera-b"; second.sourceHash = "camera-b-hash"; snapshot.assets.push(second);
    });
    const a = cameras.snapshot.assets[0].id, b = cameras.snapshot.assets[1].id;
    const grouped = f.app.createManualMulticamGroup({ projectId: f.projectId, baseRevision: f.revision(), title: "同步回归", referenceAssetId: a, masterAudioAssetId: a, markers: [{ assetId: a, label: "A", sourceFrame: 72, note: "同一拍手" }, { assetId: b, label: "B", sourceFrame: 96, note: "同一拍手" }] });
    for (const [index, camera] of [a, b].entries()) f.app.manageMulticamCuts({ projectId: f.projectId, baseRevision: f.revision(), action: "create", groupId: grouped.group.id, order: index, angleAssetId: camera, sessionStartFrame: 24 + index * 24, sessionEndFrame: 48 + index * 24, reason: "回归切机位", continuityNote: "保持共同声音" });
    const before = f.app.compileMulticamProgram({ projectId: f.projectId, baseRevision: f.revision(), groupId: grouped.group.id, cutIds: f.app.readProject(f.projectId).snapshot.multicamCuts.map(cut => cut.id), startFrame: 48 });
    const after = f.app.setProjectFrameRate({ projectId: f.projectId, baseRevision: before.revision.number, fps: 30 });
    assert.equal(after.snapshot.multicamGroups[0].angleSyncs[1].sessionOffsetFrames, -30);
    assert.deepEqual(after.snapshot.timeline.items.filter(item => !item.disabled).map(item => [item.startFrame, item.endFrame, item.sourceStartFrame, item.sourceEndFrame]), [[60, 90, 30, 60], [90, 120, 90, 120], [60, 120, 30, 90]]);
  } finally { await f.close(); }
});

test("原声字幕从真实Provider毫秒重新投影，转写证据与字幕Program保留", async () => {
  const f = await fixture();
  try {
    f.app.repository.commit(f.projectId, f.revision(), "原声审阅fixture", snapshot => { snapshot.assets[0].metadata!.hasAudio = true; snapshot.assets[0].metadata!.videoCodec = "h264"; });
    const item = f.app.readProject(f.projectId).snapshot.timeline.items[0];
    f.app.registerActorPerformance({ projectId: f.projectId, baseRevision: f.revision(), timelineItemId: item.id, source: "imported", maskMode: "none", audioMode: "use_source_audio", note: "隔离字幕来源" });
    const aligned = f.app.completeSourceAudioCaptionAlignment({ projectId: f.projectId, requestedRevision: f.revision(), assetId: item.assetId, timelineItemId: item.id, sourceStartFrame: 0, sourceEndFrame: 48, timelineStartFrame: 0, timelineEndFrame: 48, transcriptText: "今天看视频。", tokenPrecision: "provider_token_timed", tokens: [{ text: "今天", startMs: 33, endMs: 533 }, { text: "看视频。", startMs: 533, endMs: 1933 }], segments: [{ displayText: "今天看视频。", startMs: 33, endMs: 1933, tokenStartIndex: 0, tokenEndIndex: 2 }], bridgeAudit: { workflowId: "source-caption", runId: "fixture-run", schemaVersion: "v4", schemaRetryCount: 0, submittedAt: new Date().toISOString(), completedAt: new Date().toISOString(), request: { fieldValues: {}, fileSlots: [] } } });
    const after = f.app.setProjectFrameRate({ projectId: f.projectId, baseRevision: aligned.revision.number, fps: 30 });
    assert.equal(after.snapshot.sourceAudioAlignments[0].status, "ready");
    assert.deepEqual(after.snapshot.sourceAudioAlignments[0].tokens, aligned.snapshot.sourceAudioAlignments[0].tokens);
    assert.deepEqual(after.snapshot.sourceAudioAlignments[0].bridgeAudit, aligned.snapshot.sourceAudioAlignments[0].bridgeAudit);
    assert.deepEqual(after.snapshot.sourceCaptionPrograms, aligned.snapshot.sourceCaptionPrograms);
    assert.deepEqual([after.snapshot.timeline.captions[0].startFrame, after.snapshot.timeline.captions[0].endFrame], [1, 58]);
  } finally { await f.close(); }
});
