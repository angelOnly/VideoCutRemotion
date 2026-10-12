import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication, type CompletedMulticamAngleSync, type EditingApplication } from "@videocut/application";
import type { AssetKind, MulticamSyncPreview } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { evaluateQuality } from "@videocut/quality";
import { resolveVideoSourceVolume, resolveVlogAmbientVolume } from "@videocut/remotion";
import { MEDIA_JOB_KINDS } from "../apps/job-worker/src/index.js";

function addReadyCamera(app: EditingApplication, projectId: string, name: string, sourceHash: string): string {
  const imported = app.registerImportedAsset({
    projectId,
    baseRevision: app.readProject(projectId).revision.number,
    name,
    kind: "video" as AssetKind,
    managedPath: `assets/source/${name}`,
    sourceHash,
    provenance: {
      source: "local_import",
      acquiredAt: "2026-09-02T00:00:00.000Z"
    }
  });
  app.applyMediaAnalysis({
    projectId,
    assetId: imported.asset.id,
    metadata: {
      durationMs: 20_000,
      hasAudio: true,
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1280,
      height: 720
    }
  });
  return imported.asset.id;
}

function candidateSyncs(input: {
  referenceAssetId: string;
  secondaryAssetId: string;
  referenceHash: string;
  secondaryHash: string;
  referenceRange?: { startFrame: number; endFrame: number };
  secondaryRange?: { startFrame: number; endFrame: number };
  referenceAnchorFrame?: number;
  secondaryAnchorFrame?: number;
  secondaryOffsetFrames?: number;
}): CompletedMulticamAngleSync[] {
  const evidence = (angleHash: string, note: string, angleSourceFrame = input.referenceAnchorFrame ?? 0) => ({
    referenceSourceFrame: input.referenceAnchorFrame ?? 0,
    angleSourceFrame,
    windowFrames: 120,
    analysisVersion: "multicam-stage5-test-v1",
    referenceSourceHash: input.referenceHash,
    angleSourceHash: angleHash,
    note
  });
  return [
    {
      assetId: input.referenceAssetId,
      label: "A 机",
      sessionOffsetFrames: 0,
      method: "audio_correlation",
      confidence: 1,
      peakMargin: 1,
      driftFrames: 0,
      sourceRange: input.referenceRange ?? { startFrame: 0, endFrame: 480 },
      status: "candidate",
      evidence: evidence(input.referenceHash, "参考机位共同现场声相关候选，等待连续预览确认。")
    },
    {
      assetId: input.secondaryAssetId,
      label: "B 机",
      sessionOffsetFrames: input.secondaryOffsetFrames ?? 0,
      method: "audio_correlation",
      confidence: 0.96,
      peakMargin: 0.35,
      driftFrames: 0,
      sourceRange: input.secondaryRange ?? { startFrame: 0, endFrame: 480 },
      status: "candidate",
      evidence: evidence(input.secondaryHash, "B 机共同现场声相关候选，等待连续预览确认。", input.secondaryAnchorFrame)
    }
  ];
}

/** Application 门禁测试只需要受管文件与哈希；真实 MP4 解码由 multicam-sync-worker 测试覆盖。 */
async function createManagedSyncPreview(input: {
  app: EditingApplication;
  projectId: string;
  jobId: string;
  angleSyncs: CompletedMulticamAngleSync[];
  sessionStartFrame: number;
  sessionEndFrame: number;
}): Promise<MulticamSyncPreview> {
  const snapshot = input.app.readProject(input.projectId).snapshot;
  const relativePath = join("previews", "multicam-sync", `${input.jobId}.mp4`);
  const path = join(snapshot.project.rootPath, relativePath);
  const content = Buffer.from(`multicam-sync-preview:${input.jobId}:${input.sessionStartFrame}-${input.sessionEndFrame}`, "utf8");
  await mkdir(join(snapshot.project.rootPath, "previews", "multicam-sync"), { recursive: true });
  await writeFile(path, content);
  return {
    relativePath,
    contentHash: createHash("sha256").update(content).digest("hex"),
    durationMs: Math.round((input.sessionEndFrame - input.sessionStartFrame) / snapshot.timeline.fps * 1_000),
    fps: snapshot.timeline.fps,
    sessionStartFrame: input.sessionStartFrame,
    sessionEndFrame: input.sessionEndFrame,
    sourceWindows: Object.fromEntries(input.angleSyncs.map((sync) => [sync.assetId, {
      startFrame: input.sessionStartFrame - sync.sessionOffsetFrames,
      endFrame: input.sessionEndFrame - sync.sessionOffsetFrames
    }]))
  };
}

function markMulticamJobSucceeded(app: EditingApplication, jobId: string): void {
  const job = app.trackJob(jobId);
  app.updateJob(jobId, { status: "succeeded", result: job.result });
}

test("阶段 5 多机位只能在确认同步后切换，并以静音画面和单一主声音编译", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-multicam-stage5-"));
  const app = createApplication(root);
  try {
    assert.ok(MEDIA_JOB_KINDS.includes("multicam_sync"), "多机位同步任务必须由媒体 Worker 领取");
    const created = app.createProject({ name: "多机位阶段 5 闭环", profile: "vlog" });
    const projectId = created.snapshot.project.id;
    const cameraAHash = "multicam-camera-a-content-hash";
    const cameraBHash = "multicam-camera-b-content-hash";
    const cameraA = addReadyCamera(app, projectId, "camera-a.mp4", cameraAHash);
    const cameraB = addReadyCamera(app, projectId, "camera-b.mp4", cameraBHash);

    // 完成自动相关仍只会写 candidate，不能把相关分数当作已确认的同步事实。
    const syncJob = app.submitMulticamSync({
      projectId,
      baseRevision: app.readProject(projectId).revision.number,
      title: "A/B 机共同现场声",
      assetIds: [cameraA, cameraB],
      angleLabels: { [cameraA]: "A 机", [cameraB]: "B 机" },
      referenceAssetId: cameraA,
      masterAudioAssetId: cameraA,
      maxSearchSeconds: 20,
      idempotencyKey: "multicam-stage5-candidate"
    });
    const syncs = candidateSyncs({
      referenceAssetId: cameraA,
      secondaryAssetId: cameraB,
      referenceHash: cameraAHash,
      secondaryHash: cameraBHash
    });
    const preview = await createManagedSyncPreview({
      app,
      projectId,
      jobId: syncJob.id,
      angleSyncs: syncs,
      sessionStartFrame: 0,
      sessionEndFrame: 120
    });
    const candidate = app.completeMulticamSync({
      projectId,
      jobId: syncJob.id,
      angleSyncs: syncs,
      syncPreview: preview
    });
    assert.equal(candidate.group.status, "candidate");
    assert.throws(
      () => app.manageMulticamCuts({
        projectId,
        baseRevision: app.readProject(projectId).revision.number,
        action: "create",
        groupId: candidate.group.id,
        order: 0,
        angleAssetId: cameraA,
        sessionStartFrame: 0,
        sessionEndFrame: 120,
        reason: "开场先保持 A 机的完整表达。",
        continuityNote: "切点保留同一现场声与动作余量。"
      }),
      (error: unknown) => error instanceof DomainError && error.code === "MULTICAM_GROUP_NOT_READY",
      "candidate 不得直接建立切机位"
    );

    assert.throws(
      () => app.verifyMulticamGroup({
        projectId,
        baseRevision: app.readProject(projectId).revision.number,
        groupId: candidate.group.id,
        previewEvidence: "连续预览核对 A/B 机的口型、拍手落点和现场声，确认没有可感知偏移。"
      }),
      (error: unknown) => error instanceof DomainError && error.code === "MULTICAM_SYNC_PREVIEW_JOB_NOT_READY",
      "自动 candidate 必须等待当前同步 Job 成功后才能确认"
    );
    markMulticamJobSucceeded(app, syncJob.id);
    await rm(join(app.readProject(projectId).snapshot.project.rootPath, preview.relativePath));
    assert.throws(
      () => app.verifyMulticamGroup({
        projectId,
        baseRevision: app.readProject(projectId).revision.number,
        groupId: candidate.group.id,
        previewEvidence: "连续预览核对 A/B 机的口型、拍手落点和现场声，确认没有可感知偏移。"
      }),
      (error: unknown) => error instanceof DomainError && error.code === "MULTICAM_SYNC_PREVIEW_MISSING",
      "预览文件被删除后不能把自动 candidate 升级为 ready"
    );
    await writeFile(
      join(app.readProject(projectId).snapshot.project.rootPath, preview.relativePath),
      Buffer.from(`multicam-sync-preview:${syncJob.id}:0-120`, "utf8")
    );
    const verified = app.verifyMulticamGroup({
      projectId,
      baseRevision: app.readProject(projectId).revision.number,
      groupId: candidate.group.id,
      previewEvidence: "连续预览核对 A/B 机的口型、拍手落点和现场声，确认没有可感知偏移。"
    });
    assert.equal(verified.snapshot.multicamGroups[0]?.status, "ready");
    assert.ok(verified.snapshot.multicamGroups[0]?.angleSyncs.every((sync) => sync.status === "verified" && Boolean(sync.evidence.verifiedAt)));

    // 先故意留下会话空档，证明首版不会用黑帧或自动变速掩盖不连续。
    const firstCutState = app.manageMulticamCuts({
      projectId,
      baseRevision: app.readProject(projectId).revision.number,
      action: "create",
      groupId: candidate.group.id,
      order: 0,
      angleAssetId: cameraA,
      sessionStartFrame: 0,
      sessionEndFrame: 120,
      reason: "开场保持 A 机，先建立说话人的空间方向。",
      continuityNote: "保留动作开始前后的自然余量。"
    });
    const firstCut = firstCutState.snapshot.multicamCuts[0]!;
    const gappedCutState = app.manageMulticamCuts({
      projectId,
      baseRevision: firstCutState.revision.number,
      action: "create",
      groupId: candidate.group.id,
      order: 1,
      angleAssetId: cameraB,
      sessionStartFrame: 144,
      sessionEndFrame: 240,
      reason: "在反应信息出现时切到 B 机。",
      continuityNote: "切换仍保持同一个现场声主线。"
    });
    const secondCut = gappedCutState.snapshot.multicamCuts.find((cut) => cut.id !== firstCut.id)!;
    assert.throws(
      () => app.compileMulticamProgram({
        projectId,
        baseRevision: gappedCutState.revision.number,
        groupId: candidate.group.id,
        cutIds: [firstCut.id, secondCut.id]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "MULTICAM_SESSION_NOT_CONTIGUOUS",
      "会话有空档时不能编译多机位主线"
    );

    const contiguousCuts = app.manageMulticamCuts({
      projectId,
      baseRevision: app.readProject(projectId).revision.number,
      action: "update",
      cutId: secondCut.id,
      sessionStartFrame: 120
    });
    const compiled = app.compileMulticamProgram({
      projectId,
      baseRevision: contiguousCuts.revision.number,
      groupId: candidate.group.id,
      cutIds: [firstCut.id, secondCut.id]
    });
    const group = compiled.snapshot.multicamGroups.find((entry) => entry.id === candidate.group.id)!;
    const background = compiled.snapshot.timeline.tracks.find((track) => track.name === "Background")!;
    const ambient = compiled.snapshot.timeline.tracks.find((track) => track.name === "Ambient")!;
    const compiledCuts = compiled.snapshot.multicamCuts.filter((cut) => cut.groupId === group.id && cut.status === "ready");
    const videoItems = compiledCuts.map((cut) => compiled.snapshot.timeline.items.find((item) => item.id === cut.timelineItemId)!);
    const masterItem = compiled.snapshot.timeline.items.find((item) => item.id === group.masterAudioTimelineItemId)!;
    assert.equal(videoItems.length, 2, "确认同步后应能建立并编译两个切机位");
    assert.ok(videoItems.every((item) => item.trackId === background.id && item.gainDb === -96));
    assert.ok(videoItems.every((item) => resolveVideoSourceVolume(compiled.snapshot, item, background) === 0), "多机位画面层无论 gainDb 如何变化都不能播放源声");
    assert.equal(masterItem.trackId, ambient.id);
    assert.equal(masterItem.assetId, cameraA, "只能使用 Group 明确指定的 master audio");
    assert.equal(masterItem.gainDb, 0);
    assert.equal(resolveVlogAmbientVolume(compiled.snapshot, masterItem, ambient), 1);
    assert.equal(
      compiled.snapshot.timeline.items.filter((item) => !item.disabled && item.trackId === ambient.id && item.sceneId === group.sceneId).length,
      1,
      "每个多机位 Program 只能有一条可播放 Ambient 主声音"
    );
    const multicamBlockingIssues = evaluateQuality(compiled.snapshot, compiled.revision.number).issues
      .filter((issue) => issue.level === "blocking" && issue.code.startsWith("MULTICAM_"));
    assert.deepEqual(multicamBlockingIssues, [], "已确认且连续的 Group 不应留下多机位阻断项");

    // 修改 Cut 必须停用旧 Program，避免旧画面或旧主声音留在最终导出中。
    const oldSceneId = group.sceneId!;
    const oldProgramItemIds = [...videoItems.map((item) => item.id), masterItem.id];
    const staleProgram = app.manageMulticamCuts({
      projectId,
      baseRevision: compiled.revision.number,
      action: "update",
      cutId: firstCut.id,
      sessionEndFrame: 96
    });
    const staleGroup = staleProgram.snapshot.multicamGroups.find((entry) => entry.id === group.id)!;
    assert.equal(staleProgram.snapshot.scenes.find((scene) => scene.id === oldSceneId)?.status, "stale");
    assert.ok(staleProgram.snapshot.timeline.items.filter((item) => oldProgramItemIds.includes(item.id)).every((item) => item.disabled));
    assert.equal(staleGroup.sceneId, undefined);
    assert.equal(staleGroup.masterAudioTimelineItemId, undefined);
    assert.ok(staleProgram.snapshot.multicamCuts.filter((cut) => cut.groupId === group.id).every((cut) => cut.status === "planned"));
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("多机位 sourceRanges 只允许在指定原片区间内同步、切换和编译", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-multicam-ranges-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "多机位指定源范围", profile: "vlog" });
    const projectId = created.snapshot.project.id;
    const cameraAHash = "multicam-range-camera-a";
    const cameraBHash = "multicam-range-camera-b";
    const cameraA = addReadyCamera(app, projectId, "range-a.mp4", cameraAHash);
    const cameraB = addReadyCamera(app, projectId, "range-b.mp4", cameraBHash);
    const referenceRange = { startFrame: 96, endFrame: 336 };
    const secondaryRange = { startFrame: 144, endFrame: 384 };
    const base = app.readProject(projectId).revision.number;

    assert.throws(
      () => app.submitMulticamSync({
        projectId,
        baseRevision: base,
        assetIds: [cameraA, cameraB],
        angleLabels: { [cameraA]: "A 机", [cameraB]: "B 机" },
        sourceRanges: { [cameraA]: referenceRange }
      }),
      (error: unknown) => error instanceof DomainError && error.code === "MULTICAM_SOURCE_RANGES_INVALID",
      "一旦提供 sourceRanges，就必须明确覆盖全部机位"
    );

    const firstJob = app.submitMulticamSync({
      projectId,
      baseRevision: base,
      title: "A/B 指定会话",
      assetIds: [cameraA, cameraB],
      angleLabels: { [cameraA]: "A 机", [cameraB]: "B 机" },
      referenceAssetId: cameraA,
      masterAudioAssetId: cameraA,
      maxSearchSeconds: 20,
      sourceRanges: { [cameraA]: referenceRange, [cameraB]: secondaryRange }
    });
    const changedRangeJob = app.submitMulticamSync({
      projectId,
      baseRevision: base,
      title: "A/B 另一段范围",
      assetIds: [cameraA, cameraB],
      angleLabels: { [cameraA]: "A 机", [cameraB]: "B 机" },
      referenceAssetId: cameraA,
      masterAudioAssetId: cameraA,
      maxSearchSeconds: 20,
      sourceRanges: { [cameraA]: referenceRange, [cameraB]: { startFrame: 144, endFrame: 360 } }
    });
    assert.notEqual(firstJob.id, changedRangeJob.id, "默认幂等键必须区分相同素材的不同同步范围");

    const rangeSyncs = candidateSyncs({
      referenceAssetId: cameraA,
      secondaryAssetId: cameraB,
      referenceHash: cameraAHash,
      secondaryHash: cameraBHash,
      referenceRange,
      secondaryRange,
      referenceAnchorFrame: 144,
      secondaryAnchorFrame: 192,
      secondaryOffsetFrames: -48
    });
    const rangePreview = await createManagedSyncPreview({
      app,
      projectId,
      jobId: firstJob.id,
      angleSyncs: rangeSyncs,
      sessionStartFrame: 144,
      sessionEndFrame: 264
    });
    const candidate = app.completeMulticamSync({
      projectId,
      jobId: firstJob.id,
      angleSyncs: rangeSyncs,
      syncPreview: rangePreview
    });
    assert.deepEqual(candidate.group.angleSyncs.find((sync) => sync.assetId === cameraA)?.sourceRange, referenceRange);
    assert.deepEqual(candidate.group.angleSyncs.find((sync) => sync.assetId === cameraB)?.sourceRange, secondaryRange);
    markMulticamJobSucceeded(app, firstJob.id);
    const verified = app.verifyMulticamGroup({
      projectId,
      baseRevision: candidate.state.revision.number,
      groupId: candidate.group.id,
      previewEvidence: "连续预览确认所选原片区间内的口型、动作和主声音一致。"
    });

    assert.throws(
      () => app.manageMulticamCuts({
        projectId,
        baseRevision: verified.revision.number,
        action: "create",
        groupId: candidate.group.id,
        order: 0,
        angleAssetId: cameraA,
        sessionStartFrame: 72,
        sessionEndFrame: 96,
        reason: "故意尝试切入指定会话前的另一段原片。",
        continuityNote: "该范围不应被已确认同步关系覆盖。"
      }),
      (error: unknown) => error instanceof DomainError && error.code === "MULTICAM_CUT_OUTSIDE_SYNC_RANGE",
      "范围外 Cut 不能绕过已确认的共同会话区间"
    );

    const planned = app.manageMulticamCuts({
      projectId,
      baseRevision: verified.revision.number,
      action: "create",
      groupId: candidate.group.id,
      order: 0,
      angleAssetId: cameraB,
      sessionStartFrame: 96,
      sessionEndFrame: 216,
      reason: "在共同会话范围内选择 B 机反应画面。",
      continuityNote: "保留同一现场声和动作前后的自然余量。"
    });
    const cut = planned.snapshot.multicamCuts[0]!;
    const compiled = app.compileMulticamProgram({
      projectId,
      baseRevision: planned.revision.number,
      groupId: candidate.group.id,
      cutIds: [cut.id]
    });
    assert.equal(compiled.snapshot.multicamCuts[0]?.status, "ready", "共同范围内的 Cut 可正常编译");

    const tampered = structuredClone(compiled.snapshot);
    const tamperedCut = tampered.multicamCuts[0]!;
    tamperedCut.sessionStartFrame = 72;
    tamperedCut.sessionEndFrame = 96;
    tamperedCut.sourceStartFrame = 120;
    tamperedCut.sourceEndFrame = 144;
    const rangeIssues = evaluateQuality(tampered, compiled.revision.number).issues.filter((issue) => issue.code === "MULTICAM_CUT_OUTSIDE_SYNC_RANGE");
    assert.equal(rangeIssues.length, 1, "直接篡改 Revision 后，质量门禁仍必须阻断范围外 Cut");
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("没有共同音轨时，人工同一事件标记仍可直接形成 ready Group", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-multicam-manual-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "人工多机位同步", profile: "vlog" });
    const projectId = created.snapshot.project.id;
    const cameraA = addReadyCamera(app, projectId, "manual-a.mp4", "manual-a-hash");
    const cameraB = addReadyCamera(app, projectId, "manual-b.mp4", "manual-b-hash");
    const manual = app.createManualMulticamGroup({
      projectId,
      baseRevision: app.readProject(projectId).revision.number,
      title: "拍手同步点",
      referenceAssetId: cameraA,
      masterAudioAssetId: cameraA,
      markers: [
        { assetId: cameraA, label: "A 机", sourceFrame: 120, note: "画面中的拍手落下帧" },
        { assetId: cameraB, label: "B 机", sourceFrame: 144, note: "同一次拍手落下帧" }
      ]
    });
    assert.equal(manual.group.status, "ready");
    assert.equal(manual.group.syncJobId, undefined, "人工确认不应伪造自动同步 Job 或预览依赖");
    assert.ok(manual.group.angleSyncs.every((sync) => sync.method === "manual_marker" && sync.status === "verified"));
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
