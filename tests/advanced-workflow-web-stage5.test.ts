import assert from "node:assert/strict";
import test from "node:test";
import type { Asset, JobRecord, ProjectSnapshot } from "@videocut/contracts";
import {
  getAdvancedWorkflowStatus,
  multicamSyncCandidates,
  validateMulticamSubmission,
  validateVideoGenerationInputs,
  videoGenerationCandidates,
  vlogAnalysisCandidates
} from "../apps/web/src/advanced-workflow-state.js";

const now = "2026-09-02T00:00:00.000Z";

function readyAsset(input: Partial<Asset> & Pick<Asset, "id" | "name" | "kind">): Asset {
  const { id, name, kind, ...overrides } = input;
  return {
    id,
    name,
    kind,
    status: "ready",
    managedPath: `assets/source/${name}`,
    tags: [],
    createdAt: now,
    metadata: { durationMs: 20_000, hasAudio: true, videoCodec: "h264", audioCodec: "aac", width: 1280, height: 720 },
    ...overrides
  };
}

/** 状态单元测试只构造高级面板实际读取的字段，不引入 SQLite 生命周期。 */
function emptySnapshot(): ProjectSnapshot {
  return {
    project: { id: "advanced-web-project", brief: { aspectRatio: "9:16" } },
    assets: [],
    narrativeMap: undefined,
    evidenceCaptures: [],
    explainerPrograms: [],
    vlogShotAnalyses: [],
    vlogEvents: [],
    vlogShotSelects: [],
    multicamGroups: [],
    speechAlignment: undefined
  } as unknown as ProjectSnapshot;
}

test("高级 Web 入口不把候选同步或 unknown 生成资产误说成可交付状态", () => {
    const snapshot = emptySnapshot();
    const cameraA = readyAsset({ id: "camera-a", name: "camera-a.mp4", kind: "video" });
    const cameraB = readyAsset({ id: "camera-b", name: "camera-b.mp4", kind: "video" });
    const silent = readyAsset({ id: "silent", name: "silent.mp4", kind: "video", metadata: { durationMs: 20_000, hasAudio: false, videoCodec: "h264", width: 1280, height: 720 } });
    const generated = readyAsset({
      id: "generated-video",
      name: "generated.mp4",
      kind: "video",
      provenance: { source: "generated", acquiredAt: now }
    });
    snapshot.assets.push(cameraA, cameraB, silent, generated);
    snapshot.multicamGroups.push({
      id: "candidate-group",
      title: "A/B 候选",
      referenceAssetId: cameraA.id,
      masterAudioAssetId: cameraA.id,
      angleAssetIds: [cameraA.id, cameraB.id],
      angleSyncs: [
        {
          assetId: cameraA.id,
          label: "A 机",
          sessionOffsetFrames: 0,
          method: "audio_correlation",
          confidence: 1,
          status: "candidate",
          sourceRange: { startFrame: 0, endFrame: 240 },
          evidence: { referenceSourceFrame: 0, angleSourceFrame: 0, windowFrames: 120, analysisVersion: "test", referenceSourceHash: "a", angleSourceHash: "a", note: "等待连续预览确认" }
        }
      ],
      status: "candidate",
      createdAt: now,
      updatedAt: now
    });
    const jobs: JobRecord[] = [{
      id: "multicam-job",
      projectId: snapshot.project.id,
      kind: "multicam_sync",
      status: "succeeded",
      payload: {},
      idempotencyKey: "advanced-web-test",
      attempt: 1,
      createdAt: now,
      updatedAt: now
    }];

    assert.deepEqual(vlogAnalysisCandidates(snapshot).map((asset) => asset.id), [cameraA.id, cameraB.id, silent.id], "生成画面不能被误作实拍 Vlog 事件来源");
    assert.deepEqual(multicamSyncCandidates(snapshot).map((asset) => asset.id), [cameraA.id, cameraB.id], "静音或生成素材不得出现在自动同步入口");
    const status = getAdvancedWorkflowStatus(snapshot, jobs);
    assert.equal(status.multicam.candidateGroupCount, 1);
    assert.equal(status.multicam.readyGroupCount, 0);

    const candidates = multicamSyncCandidates(snapshot);
    assert.match(validateMulticamSubmission({
      assetIds: [cameraA.id, cameraB.id],
      candidates,
      drafts: {
        [cameraA.id]: { label: "", startFrame: "0", endFrame: "240" },
        [cameraB.id]: { label: "B 机", startFrame: "0", endFrame: "240" }
      },
      fps: 24,
      referenceAssetId: cameraA.id,
      masterAudioAssetId: cameraA.id
    }).error ?? "", /明确命名/);
    const valid = validateMulticamSubmission({
      assetIds: [cameraA.id, cameraB.id],
      candidates,
      drafts: {
        [cameraA.id]: { label: "A 机", startFrame: "240", endFrame: "480" },
        [cameraB.id]: { label: "B 机", startFrame: "250", endFrame: "480" }
      },
      fps: 24,
      referenceAssetId: cameraA.id,
      masterAudioAssetId: cameraA.id
    });
    assert.deepEqual(valid.submission?.sourceRanges, {
      [cameraA.id]: { startFrame: 240, endFrame: 480 },
      [cameraB.id]: { startFrame: 250, endFrame: 480 }
    });
});

test("高级 Web 视频生成表单在提交前保持模式对应的输入约束", async () => {
  const image = readyAsset({ id: "image", name: "reference.png", kind: "image", metadata: { durationMs: 0, hasAudio: false, width: 1280, height: 720 } });
  const imageTwo = readyAsset({ id: "image-two", name: "end.png", kind: "image", metadata: { durationMs: 0, hasAudio: false, width: 1280, height: 720 } });
  const video = readyAsset({ id: "video", name: "reference.mp4", kind: "video" });
  assert.match(validateVideoGenerationInputs("text_to_video", [image]) ?? "", /不能提交参考素材/);
  assert.match(validateVideoGenerationInputs("image_to_video", [video]) ?? "", /必须且只能选择一张/);
  assert.equal(validateVideoGenerationInputs("image_to_video", [image]), undefined);
  assert.equal(validateVideoGenerationInputs("first_last_frame", [image, imageTwo]), undefined);
  assert.match(validateVideoGenerationInputs("first_last_frame", [image]) ?? "", /两张/);
  assert.equal(validateVideoGenerationInputs("multi_reference", [image, video]), undefined);

  const snapshot = emptySnapshot();
  const restricted = readyAsset({ id: "restricted", name: "restricted.png", kind: "image", provenance: { source: "local_import", acquiredAt: now } });
  snapshot.assets.push(image, restricted);
  assert.deepEqual(videoGenerationCandidates(snapshot, "image_to_video").map((asset) => asset.id), [image.id, restricted.id], "已就绪素材都可选择");
});
