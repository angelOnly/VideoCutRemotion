import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { resolveCompositionReachability } from "@videocut/remotion";
import { evaluateQuality } from "@videocut/quality";

async function addReadyVideo(application: ReturnType<typeof createApplication>, projectId: string, name: string): Promise<string> {
  const imported = application.registerImportedAsset({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    name,
    kind: "video",
    managedPath: `assets/source/${name}`,
    sourceHash: `${name}-hash`,
    provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
  });
  application.applyMediaAnalysis({
    projectId,
    assetId: imported.asset.id,
    metadata: { durationMs: 2_000, hasAudio: true, videoCodec: "h264", audioCodec: "aac", width: 720, height: 1280 }
  });
  return imported.asset.id;
}

function markAsProviderUnknown(application: ReturnType<typeof createApplication>, projectId: string, assetId: string): void {
  application.updateAssetEditorialMetadata({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    assetId,
    provenance: {
      source: "provider",
      provider: "可达性测试素材库",
      sourceUrl: `https://example.test/${assetId}`,
      acquiredAt: new Date().toISOString()
    }
  });
}

test("Composition Reachability 只收集当前真正渲染的素材", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-reachability-"));
  const application = createApplication(workspaceRoot);
  try {
    const created = application.createProject({ name: "Composition Reachability" });
    const primaryAssetId = await addReadyVideo(application, created.snapshot.project.id, "primary.mp4");
    const cueAssetId = await addReadyVideo(application, created.snapshot.project.id, "cue.mp4");
    const timeline = application.buildPresenterTimeline({
      projectId: created.snapshot.project.id,
      baseRevision: application.readProject(created.snapshot.project.id).revision.number,
      assetIds: [primaryAssetId],
      sceneSize: 1
    });
    const scene = timeline.snapshot.scenes[0]!;
    const withCue = application.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: timeline.revision.number,
      sceneId: scene.id,
      type: "ProductFan",
      layer: "front",
      startFrame: scene.startFrame,
      endFrame: scene.startFrame + 12,
      assetBindings: [{ slot: "primary", assetId: cueAssetId }]
    });
    const snapshot = structuredClone(withCue.snapshot);
    const rendered = resolveCompositionReachability(snapshot);
    assert.ok(rendered.assetIds.has(primaryAssetId));
    assert.ok(rendered.assetIds.has(cueAssetId), "已就绪且内容完整的 Cue 绑定必须成为成片依赖");

    snapshot.effectCues[0]!.status = "stale";
    const staleCue = resolveCompositionReachability(snapshot);
    assert.ok(!staleCue.assetIds.has(cueAssetId), "stale Cue 不能继续污染预检和 Artifact 依赖");

    snapshot.scenes.push({ ...structuredClone(scene), id: "stale-scene", status: "stale", assetIds: [cueAssetId] });
    const staleScene = resolveCompositionReachability(snapshot);
    assert.ok(!staleScene.assetIds.has(cueAssetId), "未参与 Composition 的 stale Scene 不能仅因保存过 assetIds 就成为依赖");
  } finally {
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("质量中的素材门禁只阻断当前 Composition 实际可达的外部素材", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-reachability-quality-"));
  const application = createApplication(workspaceRoot);
  try {
    const created = application.createProject({ name: "Composition Reachability Quality" });
    const primaryAssetId = await addReadyVideo(application, created.snapshot.project.id, "primary.mp4");
    const hiddenAssetId = await addReadyVideo(application, created.snapshot.project.id, "hidden.mp4");
    const staleCueAssetId = await addReadyVideo(application, created.snapshot.project.id, "stale-cue.mp4");
    const incompleteCueAssetId = await addReadyVideo(application, created.snapshot.project.id, "incomplete-cue.mp4");
    const activeCueAssetId = await addReadyVideo(application, created.snapshot.project.id, "active-cue.mp4");
    for (const assetId of [hiddenAssetId, staleCueAssetId, incompleteCueAssetId, activeCueAssetId]) {
      markAsProviderUnknown(application, created.snapshot.project.id, assetId);
    }
    const timeline = application.buildPresenterTimeline({
      projectId: created.snapshot.project.id,
      baseRevision: application.readProject(created.snapshot.project.id).revision.number,
      assetIds: [primaryAssetId],
      sceneSize: 1
    });
    const scene = timeline.snapshot.scenes[0]!;
    const staleCue = application.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: timeline.revision.number,
      sceneId: scene.id,
      type: "ProductFan",
      layer: "front",
      startFrame: scene.startFrame,
      endFrame: scene.startFrame + 12,
      assetBindings: [{ slot: "primary", assetId: staleCueAssetId }]
    });
    const incompleteCue = application.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: staleCue.revision.number,
      sceneId: scene.id,
      type: "EvidenceCard",
      layer: "front",
      startFrame: scene.startFrame + 12,
      endFrame: scene.startFrame + 24,
      assetBindings: [{ slot: "primary", assetId: incompleteCueAssetId }]
      // 故意省略证据说明，使其不进入 Composition。
    });
    const activeCue = application.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: incompleteCue.revision.number,
      sceneId: scene.id,
      type: "ProductFan",
      layer: "front",
      startFrame: scene.startFrame + 24,
      endFrame: scene.startFrame + 36,
      assetBindings: [{ slot: "primary", assetId: activeCueAssetId }]
    });
    const snapshot = structuredClone(activeCue.snapshot);
    const hiddenItem = snapshot.timeline.items.find((item) => item.assetId === primaryAssetId);
    const hiddenTrack = snapshot.timeline.tracks.find((track) => track.id === hiddenItem?.trackId);
    assert.ok(hiddenTrack && hiddenItem, "测试项目必须存在可隐藏的主画面 Item");
    hiddenTrack.hidden = true;
    hiddenItem.assetId = hiddenAssetId;
    snapshot.assets.find((asset) => asset.id === hiddenAssetId)!.status = "missing";
    snapshot.assets.find((asset) => asset.id === hiddenAssetId)!.failureReason = "仅验证隐藏素材不应阻断交付";
    snapshot.effectCues.find((cue) => cue.assetBindings.some((binding) => binding.assetId === staleCueAssetId))!.status = "stale";

    const reachability = resolveCompositionReachability(snapshot);
    assert.ok(!reachability.assetIds.has(hiddenAssetId));
    assert.ok(!reachability.assetIds.has(staleCueAssetId));
    assert.ok(!reachability.assetIds.has(incompleteCueAssetId));
    assert.ok(reachability.assetIds.has(activeCueAssetId));

    const report = evaluateQuality(snapshot, activeCue.revision.number);
    const externalBlockingIds = report.issues
      .filter((issue) => issue.level === "blocking" && issue.code === "ASSET_NOT_READY")
      .map((issue) => issue.objectId);
    assert.ok(!externalBlockingIds.includes(hiddenAssetId), "隐藏且不可用的素材不应被当成成片依赖");
    assert.ok(!externalBlockingIds.includes(staleCueAssetId), "stale Cue 的素材不应被当成成片依赖");
    assert.ok(!externalBlockingIds.includes(incompleteCueAssetId), "内容合同未完成的 Cue 素材不应被当成成片依赖");
    assert.equal(externalBlockingIds.includes(activeCueAssetId), false, "已就绪素材不因权利信息阻断交付");
  } finally {
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
