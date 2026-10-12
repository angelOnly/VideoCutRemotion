import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { createId, createMediaAsset } from "@videocut/domain";
import { assemblePlacedSpeech, probeMedia, runProcess } from "@videocut/speech";

test("已生成的两段旁白按指定帧重排，同步总轨和字幕；重叠与旧版本拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-speech-placement-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "段级编排回归", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const authored = app.applyAuthoredScript({ projectId, baseRevision: 1, sourceNote: "测试原稿", units: [{ text: "第一句。", kind: "statement" }, { text: "第二句。", kind: "statement" }] });
    const segments = authored.snapshot.speechSegments.slice().sort((a, b) => a.order - b.order);
    const projectRoot = authored.snapshot.project.rootPath;
    await mkdir(join(projectRoot, "assets", "speech"), { recursive: true });
    const assets = [];
    const segmentAssets = [];
    for (let index = 0; index < segments.length; index++) {
      const relativePath = join("assets", "speech", `segment-${index}.wav`);
      const path = join(projectRoot, relativePath);
      await runProcess("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=${440 + index * 100}:duration=1:sample_rate=24000`, path]);
      const asset = createMediaAsset({ name: `测试片段 ${index}`, kind: "speech", managedPath: relativePath });
      asset.status = "ready"; asset.metadata = await probeMedia(path); assets.push(asset);
      segmentAssets.push({ id: createId("segment_asset"), speechSegmentId: segments[index]!.id, assetId: asset.id, durationMs: 1000, bridgeRunId: "fixture", schemaVersion: "fixture", quality: "passed" as const });
    }
    const totalPath = join(projectRoot, "assets", "speech", "total.wav");
    await runProcess("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=24000", totalPath]);
    const total = createMediaAsset({ name: "初始总轨", kind: "speech", managedPath: join("assets", "speech", "total.wav") });
    total.status = "ready"; total.metadata = await probeMedia(totalPath); assets.push(total);
    const assembled = app.applySpeechAssembly({ projectId, generatedAssets: assets, segmentAssets, speechAsset: { id: createId("speech_asset"), assetId: total.id, scriptRevision: authored.snapshot.script.revision, segmentAssetIds: segmentAssets.map((s) => s.id), timing: { precision: "segment_exact", source: "测试", segments: segments.map((s, i) => ({ speechSegmentId: s.id, startMs: i * 1000, endMs: (i + 1) * 1000, startFrame: i * 24, endFrame: (i + 1) * 24 })) }, status: "ready" } });
    const scene = app.createScene({ projectId, baseRevision: assembled.revision.number, type: "ExplainerScene", title: "测试场景", purpose: "测试旁白留白", startFrame: 0, endFrame: 120 });
    const placements = [{ speechSegmentId: segments[0]!.id, startFrame: 0 }, { speechSegmentId: segments[1]!.id, startFrame: 72 }];
    assert.throws(() => app.submitSpeechPlacement({ projectId, baseRevision: scene.revision.number, placements: [{ ...placements[0]! }, { ...placements[1]!, startFrame: 12 }], idempotencyKey: "overlap" }), { code: "INVALID_SPEECH_PLACEMENT" });
    assert.throws(() => app.submitSpeechPlacement({ projectId, baseRevision: scene.revision.number, placements, durationFrames: 90, idempotencyKey: "short" }), { code: "INVALID_SPEECH_PLACEMENT_DURATION" });
    const job = app.submitSpeechPlacement({ projectId, baseRevision: scene.revision.number, placements, durationFrames: 120, idempotencyKey: "placed" });
    assert.equal(app.submitSpeechPlacement({ projectId, baseRevision: scene.revision.number, placements, durationFrames: 120, idempotencyKey: "placed" }).id, job.id);
    await assemblePlacedSpeech(app, job);
    const after = app.readProject(projectId);
    assert.deepEqual(after.snapshot.speechAsset!.timing.segments.map((s) => s.startFrame), [0, 72]);
    assert.deepEqual(after.snapshot.timeline.captions.map((c) => c.startFrame), [0, 72]);
    assert.equal(after.snapshot.timeline.items.find((i) => i.assetId === after.snapshot.speechAsset!.assetId)?.endFrame, 120);
    assert.equal(after.snapshot.timeline.durationInFrames, 120);
    const fullPreview = app.submitPreview({ projectId, revision: after.revision.number, fromFrame: 0, toFrame: 120, idempotencyKey: "full-placement-preview" });
    assert.deepEqual([fullPreview.payload.fromFrame, fullPreview.payload.toFrame], [0, 120]);
    assert.throws(() => app.submitSpeechPlacement({ projectId, baseRevision: scene.revision.number, placements, idempotencyKey: "stale" }), /Revision 已过期/);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
