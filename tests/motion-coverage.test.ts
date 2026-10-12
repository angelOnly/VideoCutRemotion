import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { createTimelineItem } from "@videocut/domain";
import { productionReconciliation } from "../packages/quality-system/src/editorial-review.js";
import { runProcess } from "@videocut/speech";
import { managedMotionReviewOutcome } from "@videocut/contracts";
import { motionFixture } from "./fixtures/managed-motion.js";
import { validateMotionReviewEvidence } from "../packages/edit-application/src/motion-review.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videocut-motion-coverage-"));
  const app = createApplication(root);
  const projectId = app.createProject({ name: "多 Beat 连续作品" }).snapshot.project.id;
  const revision = () => app.readProject(projectId).revision.number;
  const main = app.registerImportedAsset({ projectId, baseRevision: revision(), name: "隔离主画面", kind: "video", managedPath: "assets/fixture.mp4" }).asset;
  app.applyMediaAnalysis({ projectId, assetId: main.id, metadata: { durationMs: 10000, width: 320, height: 320, fps: 30, hasAudio: false } });
  app.repository.commit(projectId, revision(), "测试画布", snapshot => { Object.assign(snapshot.timeline, { width: 320, height: 320, fps: 30, durationInFrames: 100 }); });
  const sceneId = app.createScene({ projectId, baseRevision: revision(), type: "PresenterScene", title: "连续段", purpose: "两个相关观点", startFrame: 0, endFrame: 60 }).snapshot.scenes.at(-1)!.id;
  let itemId = "";
  app.repository.commit(projectId, revision(), "建立当前内容与主画面", snapshot => {
    snapshot.scenes.find(scene => scene.id === sceneId)!.narrativeBeatIds = ["a", "b"];
    snapshot.story.beats = ["a", "b"].map((id, order) => ({ id, order, title: id, purpose: "解释相关内容", semanticUnitIds: [], sceneIds: [sceneId] }));
    const item = createTimelineItem({ sceneId, trackId: snapshot.timeline.tracks.find(t => t.name === "Actor / A-roll")!.id, assetId: main.id, startFrame: 0, endFrame: 60, sourceStartFrame: 0, sourceEndFrame: 60 });
    itemId = item.id;
    snapshot.timeline.items.push(item);
  });
  const job = app.submitManagedMotion({ projectId, baseRevision: revision(), idempotencyKey: "work", work: { ...motionFixture, reference: undefined } });
  const asset = app.completeManagedMotion({ projectId, jobId: job.id, sourceHash: "fixture", engineVersion: "fixture", metadata: { durationMs: 600, width: 320, height: 320, fps: 30, hasAudio: false } });
  await app.reviewManagedMotion({ projectId, baseRevision: revision(), assetId: asset.id, outcome: "inconclusive", note: "仅测试版本传播与覆盖，不将结构断言作为真实作品审美通过。" });
  const placement = { projectId, sceneId, type: "ManagedMotion" as const, layer: "front" as const, startFrame: 10, endFrame: 28,
    semanticAnchor: { type: "narrative_beat" as const, targetId: "a", relation: "land_on" as const }, assetBindings: [{ slot: "motion", assetId: asset.id }] };
  return { app, projectId, revision, sceneId, itemId, placement, close: async () => { app.close(); await rm(root, { recursive: true, force: true }); } };
}

test("一个 Cue 显式覆盖多个 Beat，旧数据仍仅按单锚点，不自动覆盖同场景", async () => {
  const f = await fixture();
  try {
    const old = f.app.createEffectCue({ ...f.placement, baseRevision: f.revision() });
    const cueId = old.snapshot.effectCues.at(-1)!.id;
    assert.deepEqual(productionReconciliation(old.snapshot).map(b => b.linkedEffectCueIds.length), [1, 0]);
    assert.throws(() => f.app.updateEffectCue({ projectId: f.projectId, baseRevision: f.revision(), cueId, coveredNarrativeBeatIds: ["a", "foreign"] }), /覆盖/u);
    const state = f.app.updateEffectCue({ projectId: f.projectId, baseRevision: f.revision(), cueId, coveredNarrativeBeatIds: ["a", "b", "b"] });
    assert.deepEqual(state.snapshot.effectCues.at(-1)!.coveredNarrativeBeatIds, ["a", "b"]);
    assert.deepEqual(productionReconciliation(f.app.readProject(f.projectId).snapshot).map(b => b.linkedEffectCueIds), [[cueId], [cueId]]);
    assert.equal(state.snapshot.effectCues.length, 1);
    const changed = f.app.repository.commit(f.projectId, f.revision(), "改变非主锚点含义", snapshot => { snapshot.story.beats[1]!.purpose = "改成另一个内容关系"; });
    assert.equal(changed.snapshot.effectCues[0]!.status, "stale");
    assert.deepEqual(productionReconciliation(changed.snapshot).map(b => b.linkedEffectCueIds.length), [0, 0]);
    f.app.moveItem({ projectId: f.projectId, baseRevision: f.revision(), itemId: f.itemId, startFrame: 5 });
    assert.equal(f.app.readProject(f.projectId).snapshot.effectCues[0]!.status, "stale", "平移不能复活内容已失效作品");
  } finally { await f.close(); }
});

test("固定作品纯平移保留局部偏移；缩短 Scene 或删除覆盖 Beat 保持帧数并失效", async () => {
  const f = await fixture();
  try {
    const state = f.app.createEffectCue({ ...f.placement, baseRevision: f.revision(), coveredNarrativeBeatIds: ["a", "b"] });
    const cueId = state.snapshot.effectCues[0]!.id;
    const moved = f.app.moveItem({ projectId: f.projectId, baseRevision: f.revision(), itemId: f.itemId, startFrame: 7 });
    assert.deepEqual([moved.snapshot.effectCues[0]!.startFrame, moved.snapshot.effectCues[0]!.endFrame, moved.snapshot.effectCues[0]!.status], [17, 35, "ready"]);
    const shortened = f.app.repository.commit(f.projectId, f.revision(), "缩短内容范围", snapshot => { snapshot.scenes[0]!.endFrame = 30; });
    assert.equal(shortened.snapshot.effectCues[0]!.endFrame - shortened.snapshot.effectCues[0]!.startFrame, 18);
    assert.equal(shortened.snapshot.effectCues[0]!.status, "stale");
    assert.throws(() => f.app.updateEffectCue({ projectId: f.projectId, baseRevision: f.revision(), cueId, coveredNarrativeBeatIds: ["a", "b"] }), /范围/u);
    const confirmed = f.app.updateEffectCue({ projectId: f.projectId, baseRevision: f.revision(), cueId, startFrame: 10, endFrame: 28, coveredNarrativeBeatIds: ["a", "b"] });
    assert.equal(confirmed.snapshot.effectCues[0]!.status, "ready");
    const removed = f.app.repository.commit(f.projectId, f.revision(), "删除被覆盖的非主锚点", snapshot => { snapshot.story.beats = snapshot.story.beats.filter(b => b.id !== "b"); snapshot.scenes[0]!.narrativeBeatIds = ["a"]; });
    assert.equal(removed.snapshot.effectCues[0]!.status, "stale");
    assert.ok(removed.revision.impact.stale.includes(cueId));
  } finally { await f.close(); }
});


test("合成审阅必须来自当前项目、版本和实际完整 Cue，单件通过不继承整片证据", async () => {
  const f = await fixture();
  try {
    const state = f.app.createEffectCue({ ...f.placement, baseRevision: f.revision(), coveredNarrativeBeatIds: ["a", "b"] });
    const assetId = f.placement.assetBindings[0]!.assetId;
    const previewRoot = join(state.snapshot.project.rootPath, "previews");
    await mkdir(previewRoot, { recursive: true });
    const makePreview = async (silent: boolean) => {
      const job = f.app.submitPreview({ projectId: f.projectId, revision: f.revision(), fromFrame: 0, toFrame: 60, idempotencyKey: `preview-${silent}` });
      const path = join(previewRoot, `${job.id}.mp4`);
      await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x320:r=30:d=2", ...(silent ? [] : ["-f", "lavfi", "-i", "sine=duration=2:sample_rate=48000"]), "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(silent ? [] : ["-c:a", "aac", "-shortest"]), path]);
      f.app.updateJob(job.id, { status: "succeeded", result: { revision: f.revision(), fromFrame: 0, toFrame: 60, path } });
      return job;
    };
    const silent = await makePreview(true);
    const sound = await makePreview(false);
    const request = () => ({ projectId: f.projectId, baseRevision: f.revision(), assetId, outcome: "passed" as const, note: "技术测试声明：仅检验证据归属与版本门禁，不代表真实内容或声画审美通过。" });
    const evidence = { kind: "project_preview" as const, previewJobId: sound.id, startFrame: 10, endFrame: 28, method: "audiovisual" as const };
    await assert.rejects(f.app.reviewManagedMotion({ ...request(), evidence: { ...evidence, previewJobId: silent.id } }), /无音轨/u);
    await assert.rejects(f.app.reviewManagedMotion({ ...request(), evidence: { ...evidence, endFrame: 27 } }), /完整覆盖/u);
    await assert.rejects(f.app.reviewManagedMotion({ ...request(), evidence: { ...evidence, startFrame: 40, endFrame: 58 } }), /完整覆盖/u);
    await assert.rejects(f.app.reviewManagedMotion({ ...request(), evidence: { ...evidence, previewJobId: "foreign-job" } }), /本项目/u);
    await assert.rejects(f.app.reviewManagedMotion({ ...request(), evidence: { ...evidence, method: "frames" } }), /静帧/u);
    // 失败或待审可记录局部静帧，但坐标仍是项目全局帧，不能冒充完整连续观看。
    const beforePartial = f.app.readProject(f.projectId);
    const target = beforePartial.snapshot.assets.find(asset => asset.id === assetId)!;
    const jobs = f.app.repository.listJobs(f.projectId);
    for (const outcome of ["failed", "inconclusive"] as const) {
      const local = await validateMotionReviewEvidence(beforePartial.snapshot, f.revision(), jobs, target, outcome,
        { ...evidence, method: "frames", startFrame: 14, endFrame: 17 });
      assert.deepEqual([local!.workStartFrame, local!.workEndFrame], [4, 7]);
      await assert.rejects(validateMotionReviewEvidence(beforePartial.snapshot, f.revision(), jobs, target, outcome,
        { ...evidence, method: "frames", startFrame: 4, endFrame: 7 }), /项目全局帧.*未与.*相交/u);
    }
    assert.deepEqual(f.app.readProject(f.projectId), beforePartial, "局部证据验证和错误拒绝没有视频写入");
    const oldRevision = f.revision();
    const passed = await f.app.reviewManagedMotion({ ...request(), evidence });
    const motion = passed.snapshot.assets.find(a => a.id === assetId)!.motion!;
    assert.equal(motion.review!.evidence!.revision, oldRevision);
    assert.equal(passed.revision.number, oldRevision + 1);
    assert.equal(managedMotionReviewOutcome(motion), "passed", "保存审阅不会因自身新增 Revision 失去单件结论");
    assert.deepEqual([motion.review!.evidence!.workStartFrame, motion.review!.evidence!.workEndFrame], [0, 18]);
    await assert.rejects(f.app.reviewManagedMotion({ ...request(), evidence }), /目标 Revision/u);
    f.app.removeEffectCue({ projectId: f.projectId, baseRevision: f.revision(), cueId: state.snapshot.effectCues[0]!.id });
    await assert.rejects(f.app.reviewManagedMotion({ ...request(), evidence }), /完整覆盖/u);
  } finally { await f.close(); }
});

test("旧 Scene 锚点作品追踪宿主内容变化，但不会扩大质量对账覆盖", async () => {
  const f = await fixture();
  try {
    const state = f.app.createEffectCue({ ...f.placement, baseRevision: f.revision(), semanticAnchor: { type: "scene", targetId: f.sceneId, relation: "hold_through" } });
    assert.deepEqual(productionReconciliation(state.snapshot).map(b => b.linkedEffectCueIds.length), [0, 0]);
    const next = f.app.repository.commit(f.projectId, f.revision(), "改变宿主解释内容", snapshot => { snapshot.story.beats[1]!.purpose = "重新解释因果"; });
    assert.equal(next.snapshot.effectCues[0]!.status, "stale");
  } finally { await f.close(); }
});


test("真实语音映射限制覆盖范围，非主锚点内部时序与语义重排传播失效", async () => {
  const f = await fixture();
  try {
    const authored = f.app.applyAuthoredScript({ projectId: f.projectId, baseRevision: f.revision(), sourceNote: "覆盖回归专用原稿", units: [{ text: "先建立参照。", kind: "statement" }, { text: "再解释条件。", kind: "conclusion" }] });
    f.app.updateStory({ projectId: f.projectId, baseRevision: f.revision(), beats: authored.snapshot.semanticUnits.map((unit, i) => ({ id: ["a", "b"][i]!, title: unit.text, purpose: "技术范围校验", semanticUnitIds: [unit.id], sceneIds: [f.sceneId] })) });
    const audio = f.app.registerImportedAsset({ projectId: f.projectId, baseRevision: f.revision(), name: "技术旁白", kind: "speech", managedPath: "assets/technical-speech.wav" }).asset;
    f.app.applyMediaAnalysis({ projectId: f.projectId, assetId: audio.id, metadata: { durationMs: 2000, hasAudio: true } });
    const segmentAssets = authored.snapshot.speechSegments.map((segment, i) => ({ id: `segment-asset-${i}`, speechSegmentId: segment.id, voiceReferenceAssetId: audio.id, assetId: audio.id, durationMs: [800, 1200][i]!, bridgeRunId: `fixture-${i}`, schemaVersion: "fixture", quality: "passed" as const }));
    f.app.applySpeechAssembly({ projectId: f.projectId, generatedAssets: [], segmentAssets, speechAsset: { id: "speech", assetId: audio.id, scriptRevision: authored.snapshot.script.revision, segmentAssetIds: segmentAssets.map(a => a.id), timing: { precision: "segment_exact", source: "范围校验数据，不作为真实配音验收", segments: authored.snapshot.speechSegments.map((segment, i) => ({ speechSegmentId: segment.id, startMs: i ? 800 : 0, endMs: i ? 2000 : 800, startFrame: i ? 24 : 0, endFrame: i ? 60 : 24 })) }, status: "ready" } });
    assert.throws(() => f.app.createEffectCue({ ...f.placement, startFrame: 0, endFrame: 18, baseRevision: f.revision(), coveredNarrativeBeatIds: ["a", "b"] }), /相交/u);
    const placed = f.app.createEffectCue({ ...f.placement, startFrame: 15, endFrame: 33, baseRevision: f.revision(), coveredNarrativeBeatIds: ["a", "b"] });
    const cueId = placed.snapshot.effectCues.at(-1)!.id;
    const retimed = f.app.repository.commit(f.projectId, f.revision(), "非主锚点语音内部重定时", snapshot => { snapshot.speechAsset!.timing.segments[1]!.startFrame = 36; snapshot.speechAsset!.timing.segments[1]!.startMs = 1200; });
    assert.equal(retimed.snapshot.effectCues[0]!.status, "stale");
    assert.throws(() => f.app.updateEffectCue({ projectId: f.projectId, baseRevision: f.revision(), cueId, coveredNarrativeBeatIds: ["a", "b"] }), /相交/u);
    const reordered = f.app.applyScript({ projectId: f.projectId, baseRevision: f.revision(), semanticUnitIds: [...authored.snapshot.script.semanticUnitIds].reverse() });
    assert.equal(reordered.snapshot.effectCues[0]!.status, "stale");
    assert.equal(reordered.snapshot.effectCues[0]!.endFrame - reordered.snapshot.effectCues[0]!.startFrame, 18);
  } finally { await f.close(); }
});


test("普通 Cue 的显式覆盖也保留删除后的失效声明，不阻止主线提交", async () => {
  const f = await fixture();
  try {
    f.app.createEffectCue({ projectId: f.projectId, baseRevision: f.revision(), sceneId: f.sceneId, type: "CameraPunch", layer: "actor", startFrame: 10, endFrame: 28, coveredNarrativeBeatIds: ["a", "b"], semanticAnchor: { type: "narrative_beat", targetId: "a", relation: "land_on" } });
    const next = f.app.updateStory({ projectId: f.projectId, baseRevision: f.revision(), beats: [{ id: "b", title: "保留的第二拍", purpose: "删除第一拍", sceneIds: [f.sceneId] }] });
    assert.equal(next.snapshot.effectCues[0]!.status, "stale");
    assert.deepEqual(next.snapshot.effectCues[0]!.coveredNarrativeBeatIds, ["a", "b"]);
    assert.equal(productionReconciliation(next.snapshot)[0]!.linkedEffectCueIds.length, 0);
  } finally { await f.close(); }
});
