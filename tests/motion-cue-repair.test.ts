import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { evaluateQuality, requiresEditorialReview } from "@videocut/quality";
import { motionFixture } from "./fixtures/managed-motion.js";


async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videocut-cue-repair-"));
  const app = createApplication(root);
  const created = app.createProject({ name: "透明画布与局部编辑回归", profile: "presenter_motion" });
  const projectId = created.snapshot.project.id;
  const revision = () => app.readProject(projectId).revision.number;
  app.repository.commit(projectId, revision(), "独立测试画布与字幕", (snapshot) => {
    Object.assign(snapshot.timeline, { width: 320, height: 320, fps: 30, durationInFrames: 120 });
  });
  const job = app.submitManagedMotion({ projectId, baseRevision: revision(), idempotencyKey: "fixture", work: motionFixture });
  const asset = app.completeManagedMotion({ projectId, jobId: job.id, sourceHash: "fixture", engineVersion: "fixture-only", metadata: { durationMs: 600, width: 320, height: 320, fps: 30, hasAudio: false } });
  await app.reviewManagedMotion({ projectId, baseRevision: revision(), assetId: asset.id, outcome: "inconclusive", note: "单元测试固定状态，不代表真实用户视频审片。" });
  const sceneState = app.createScene({ projectId, baseRevision: revision(), type: "PresenterScene", title: "测试", purpose: "局部编辑回归", startFrame: 0, endFrame: 120 });
  const sceneId = sceneState.snapshot.scenes.at(-1)!.id;
  const state = app.createEffectCue({ projectId, baseRevision: revision(), sceneId, type: "ManagedMotion", layer: "front", startFrame: 20, endFrame: 38, assetBindings: [{ slot: "motion", assetId: asset.id }], qualityRules: ["semantic_anchor_required"], semanticAnchor: { type: "absolute", relation: "land_on" }, note: "保留的说明" });
  const cueId = state.snapshot.effectCues.at(-1)!.id;
  return { app, projectId, revision, asset, sceneId, cueId, state, close: async () => { app.repository.close(); await rm(root, { recursive: true, force: true }); } };
}

test("退役安全区规则与旧测量数据不产生阻断或提醒，也不回写快照", async () => {
  const f = await fixture();
  try {
    const persistedBefore = f.app.readProject(f.projectId);
    const snapshot = structuredClone(f.state.snapshot);
    snapshot.timeline.captions.push({ id: "caption-fixture", text: "字幕", startFrame: 20, endFrame: 38, style: "stable", precision: "segment_exact" });
    const cue = snapshot.effectCues.at(-1)!;
    assert.equal(cue.spatialAnchor, "full_frame");
    const baseline = evaluateQuality(snapshot, f.revision());
    assert.ok(baseline.technical.some(entry => entry.code === "EFFECT_SEMANTIC_ANCHOR_REQUIRED" && entry.level === "blocking"));
    assert.equal(requiresEditorialReview(baseline, "delivery"), false);
    // 模拟历史 JSON：已退役的附加数据不要求迁移或补测，也不能改变输出门禁。
    Object.assign(snapshot.assets.find(entry => entry.id === f.asset.id)!.motion!, {
      visibility: { method: "png_alpha_bbox_v1", alphaThreshold: 1, frames: [{ x: 0, y: 0, width: 320, height: 320 }] }
    });
    cue.qualityRules.push("caption_safe_area");
    const before = structuredClone(snapshot);
    const report = evaluateQuality(snapshot, f.revision());
    assert.deepEqual(report.issues, baseline.issues);
    assert.deepEqual(report.exportReadiness, baseline.exportReadiness);
    assert.deepEqual(snapshot, before, "只读评估不清洗正式视频状态");
    assert.deepEqual(f.app.readProject(f.projectId), persistedBefore, "评估不提交新 Revision");

    cue.type = "EvidenceCard";
    const withRetired = evaluateQuality(snapshot, f.revision());
    cue.qualityRules = cue.qualityRules.filter(rule => rule !== "caption_safe_area");
    assert.deepEqual(withRetired.issues, evaluateQuality(snapshot, f.revision()).issues, "普通全画幅前景也没有安全区特殊门禁");
    cue.qualityRules.push("真实未知规则");
    assert.ok(evaluateQuality(snapshot, f.revision()).issues.some(entry => entry.code === "EFFECT_QUALITY_RULE_UNSUPPORTED"), "其他未知规则检查保持有效");
  } finally { await f.close(); }
});

test("按 ID 修改锚点与位置不复制片段，移除只动一个 Cue 且保留作品及历史", async () => {
  const f = await fixture();
  try {
    const other = f.app.createEffectCue({ projectId: f.projectId, baseRevision: f.revision(), sceneId: f.sceneId, type: "CameraPunch", layer: "actor", startFrame: 85, endFrame: 110 });
    const before = f.app.readProject(f.projectId);
    const otherCue = before.snapshot.effectCues.find((cue) => cue.id === other.snapshot.effectCues.at(-1)!.id)!;
    const identity = { projectId: f.projectId, baseRevision: f.revision(), cueId: f.cueId };
    for (const patch of [{ semanticAnchor: { type: "scene" as const, targetId: "missing", relation: "land_on" as const } }, { props: { text: "不生效的覆盖" } }, { endFrame: 39 }, { startFrame: 110, endFrame: 128 }]) {
      assert.throws(() => f.app.updateEffectCue({ ...identity, ...patch }));
      assert.deepEqual(f.app.readProject(f.projectId), before, "失败不产生 Revision 或副作用");
    }
    const updated = f.app.updateEffectCue({ ...identity, startFrame: 60, endFrame: 78, semanticAnchor: { type: "scene", targetId: f.sceneId, relation: "land_on" } });
    const cue = updated.snapshot.effectCues.find((entry) => entry.id === f.cueId)!;
    assert.equal(cue.note, "保留的说明");
    assert.equal(cue.motion.enterFrames, 0);
    assert.equal(cue.motion.exitFrames, 0);
    assert.equal(updated.snapshot.effectCues.length, 2);
    assert.deepEqual(updated.snapshot.effectCues.find((entry) => entry.id === otherCue.id), otherCue);
    assert.deepEqual(updated.snapshot.assets, before.snapshot.assets);
    for (const range of [[20, 38], [60, 78]]) assert.ok(updated.revision.impact.dirtyRanges.some((dirty) => dirty.startFrame <= range[0] && dirty.endFrame >= range[1]));
    assert.equal(evaluateQuality(updated.snapshot, updated.revision.number).issues.some((issue) => issue.code === "EFFECT_SEMANTIC_ANCHOR_REQUIRED" && issue.objectId === cue.id), false);
    assert.throws(() => f.app.removeEffectCue(identity), /Revision|版本|revision/u);
    assert.throws(() => f.app.removeEffectCue({ ...identity, baseRevision: f.revision(), cueId: "missing" }), /不存在/u);
    assert.equal(f.revision(), updated.revision.number);
    const removed = f.app.removeEffectCue({ ...identity, baseRevision: f.revision() });
    assert.deepEqual(removed.snapshot.effectCues, [otherCue]);
    assert.deepEqual(removed.snapshot.assets, before.snapshot.assets);
    assert.deepEqual(f.app.repository.getRevision(f.projectId, before.revision.number)!.snapshot.effectCues, before.snapshot.effectCues);
    assert.ok(removed.revision.impact.dirtyRanges.some((dirty) => dirty.startFrame <= 60 && dirty.endFrame >= 78));
  } finally { await f.close(); }
});

test("受管作品把通用 default-clean 规范为源码样式，仍拒绝实际外层样式覆写", async () => {
  const f = await fixture();
  try {
    const compatible = f.app.createEffectCue({
      projectId: f.projectId,
      baseRevision: f.revision(),
      sceneId: f.sceneId,
      type: "ManagedMotion",
      layer: "fullscreen",
      startFrame: 40,
      endFrame: 58,
      semanticAnchor: { type: "scene", targetId: f.sceneId, relation: "hold_through" },
      assetBindings: [{ slot: "motion", assetId: f.asset.id }],
      stylePackId: "default-clean"
    });
    const cue = compatible.snapshot.effectCues.at(-1)!;
    assert.equal(cue.stylePackId, "managed-source");

    const beforeInvalid = f.app.readProject(f.projectId);
    assert.throws(() => f.app.createEffectCue({
      projectId: f.projectId,
      baseRevision: f.revision(),
      sceneId: f.sceneId,
      type: "ManagedMotion",
      layer: "fullscreen",
      startFrame: 80,
      endFrame: 98,
      semanticAnchor: { type: "scene", targetId: f.sceneId, relation: "hold_through" },
      assetBindings: [{ slot: "motion", assetId: f.asset.id }],
      stylePackId: "warm-editorial"
    }), /固定作品参数/u);
    assert.deepEqual(f.app.readProject(f.projectId), beforeInvalid, "实际样式覆写仍无副作用地被拒绝");
  } finally { await f.close(); }
});
