import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import { createApplication, type EditingApplication } from "@videocut/application";
import { DomainError } from "@videocut/domain";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { runAvatarGeneration } from "../apps/job-worker/src/avatar-generation.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluateQuality } from "@videocut/quality";
import { compileMotionLayout } from "@videocut/remotion";
import { runProcess } from "@videocut/speech";
import type { AssetKind, AssetRole } from "@videocut/contracts";

async function createTestApplication(): Promise<{ root: string; app: EditingApplication; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "videocut-avatar-test-"));
  const app = createApplication(root);
  return {
    root,
    app,
    dispose: async () => {
      app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    assert.fail("MCP 应返回标准 content 结果");
  }
  const first = result.content[0];
  if (!first || typeof first !== "object" || !("type" in first) || first.type !== "text" || !("text" in first) || typeof first.text !== "string") {
    assert.fail("MCP 应返回文本内容");
  }
  return first.text;
}

/** 这些测试只需要已完成媒体分析的项目对象，不需要真的调用外部 Avatar Provider。 */
function addReadyAsset(
  app: EditingApplication,
  projectId: string,
  name: string,
  kind: AssetKind,
  options: {
    durationMs?: number;
    video?: boolean;
    hasAudio?: boolean;
    width?: number;
    height?: number;
    hasAlpha?: boolean;
    role?: AssetRole;
    sourceHash?: string;
  } = {}
): string {
  const imported = app.registerImportedAsset({
    projectId,
    baseRevision: app.readProject(projectId).revision.number,
    name,
    kind,
    managedPath: `assets/source/${name}`,
    sourceHash: options.sourceHash ?? `${name}-hash`,
    role: options.role,
    provenance: {
      source: "local_import",
      acquiredAt: new Date().toISOString()
    }
  });
  app.applyMediaAnalysis({
    projectId,
    assetId: imported.asset.id,
    metadata: {
      durationMs: options.durationMs ?? 1_000,
      hasAudio: options.hasAudio ?? kind !== "image",
      videoCodec: options.video === false ? undefined : kind === "video" || kind === "actor_video" ? "h264" : undefined,
      audioCodec: options.hasAudio === false || kind === "image" ? undefined : "aac",
      width: options.width ?? (kind === "image" ? 720 : options.video === false ? undefined : 720),
      height: options.height ?? (kind === "image" ? 1280 : options.video === false ? undefined : 1280),
      hasAlpha: options.hasAlpha
    }
  });
  return imported.asset.id;
}

function createReadyPresenter(app: EditingApplication, projectId: string): { actorAssetId: string; itemId: string; sceneId: string } {
  const actorAssetId = addReadyAsset(app, projectId, "presenter.mp4", "video");
  const state = app.buildPresenterTimeline({
    projectId,
    baseRevision: app.readProject(projectId).revision.number,
    assetIds: [actorAssetId],
    sceneSize: 1
  });
  const item = state.snapshot.timeline.items.find((candidate) => candidate.assetId === actorAssetId);
  assert.ok(item, "Presenter 主画面必须写入 Timeline");
  assert.ok(item.sceneId, "Presenter 主画面必须属于 Scene");
  return { actorAssetId, itemId: item.id, sceneId: item.sceneId };
}

function createCapabilityProfile(app: EditingApplication, projectId: string, options: { supportsAudioDrivenLipSync?: boolean } = {}) {
  const state = app.manageActorCapabilityProfile({
    projectId,
    baseRevision: app.readProject(projectId).revision.number,
    action: "create",
    provider: "minimax_h3_multi_reference",
    label: "MiniMax H3 多参考人物",
    workflowId: "79ae27fd-bd4d-4e67-8dc3-6fcd7e8ce09d",
    inputModes: ["audio"],
    maskModes: ["none"],
    supportsReferenceImage: true,
    supportsReferenceVideo: false,
    supportsAudioDrivenLipSync: options.supportsAudioDrivenLipSync ?? false,
    supportsGazeControl: false,
    supportsGestureControl: false,
    supportsPartialRegeneration: true,
    maxDurationSeconds: 90,
    privacyNote: "提交前应向用户说明 Provider 数据处理范围。"
  });
  const profile = state.snapshot.actorCapabilityProfiles[0];
  assert.ok(profile, "能力档案必须写入当前 Revision");
  return { state, profile };
}

function applySemanticUnitsFromCandidates(app: EditingApplication, projectId: string) {
  const state = app.readProject(projectId);
  return app.applySemanticUnits({
    projectId,
    baseRevision: state.revision.number,
    units: [...state.snapshot.transcriptSentenceCandidates]
      .sort((left, right) => left.order - right.order)
      .map((candidate) => ({
        candidateIds: [candidate.id],
        text: candidate.text,
        kind: "statement" as const,
        confidence: 0.9,
        pauseBefore: { durationMs: 0, reason: "sentence" as const }
      }))
  });
}

function applySingleSpeechAsset(
  app: EditingApplication,
  projectId: string,
  referenceAssetId: string,
  fileAssetId: string,
  id: string
) {
  const state = app.readProject(projectId);
  const segment = state.snapshot.speechSegments[0];
  assert.ok(segment, "测试前必须已有 SpeechSegment");
  const segmentAssetId = `${id}_segment`;
  return app.applySpeechAssembly({
    projectId,
    generatedAssets: [],
    segmentAssets: [{
      id: segmentAssetId,
      speechSegmentId: segment.id,
      voiceReferenceAssetId: referenceAssetId,
      assetId: fileAssetId,
      durationMs: 1_000,
      bridgeRunId: `${id}_run`,
      schemaVersion: "test-schema",
      quality: "passed"
    }],
    speechAsset: {
      id,
      assetId: fileAssetId,
      scriptRevision: state.snapshot.script.revision,
      segmentAssetIds: [segmentAssetId],
      timing: {
        precision: "segment_exact",
        source: "测试用真实段级边界",
        segments: [{ speechSegmentId: segment.id, startMs: 0, endMs: 1_000, startFrame: 0, endFrame: 24 }]
      },
      status: "ready"
    }
  });
}

async function createDeterministicVideoFixture(directory: string): Promise<string> {
  const path = join(directory, "avatar-bridge-fixture.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=0x264653:s=64x64:r=24:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-shortest",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    path
  ]);
  return path;
}

/** 仅用于验证 Worker 会拒绝当前播放器不承诺的输出编码，而不是悄悄转码改变口型时长。 */
async function createIncompatibleAvatarVideoFixture(directory: string): Promise<string> {
  const path = join(directory, "avatar-incompatible-fixture.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=0xe76f51:s=64x64:r=24:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-shortest",
    "-c:v", "mpeg4", "-q:v", "5",
    "-c:a", "aac",
    "-movflags", "+faststart",
    path
  ]);
  return path;
}

async function materializeAsset(app: EditingApplication, projectId: string, assetId: string, sourcePath: string): Promise<void> {
  const state = app.readProject(projectId);
  const asset = state.snapshot.assets.find((candidate) => candidate.id === assetId);
  assert.ok(asset, "待实体化的测试 Asset 必须存在");
  const targetPath = join(state.snapshot.project.rootPath, asset.managedPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function createPortraitFixture(directory: string): Promise<string> {
  const path = join(directory, "avatar-portrait.png");
  // Worker 只负责把已受管肖像交给 Provider；这个最小 PNG 足够验证其文件交接，不充当真实人物素材。
  await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9jQKkAAAAASUVORK5CYII=", "base64"));
  return path;
}

function markSeedMediaJobsHandled(app: EditingApplication, projectId: string): void {
  for (const job of app.repository.listJobs(projectId)) {
    if (job.kind === "media_analysis" && job.status === "queued") {
      app.repository.updateJob(job.id, { status: "succeeded", result: { seeded: true } });
    }
  }
}

async function prepareAvatarJob(context: { root: string; app: EditingApplication }, label: string) {
  const created = context.app.createProject({ name: label, profile: "presenter_motion" });
  const projectId = created.snapshot.project.id;
  const referenceAudioAssetId = addReadyAsset(context.app, projectId, "avatar-reference.wav", "audio");
  context.app.applyTranscript({ projectId, assetId: referenceAudioAssetId, text: "这是供数字人物口型同步的一段完整旁白。", source: "manual" });
  applySemanticUnitsFromCandidates(context.app, projectId);

  const videoFixture = await createDeterministicVideoFixture(context.root);
  const speechFileAssetId = addReadyAsset(context.app, projectId, "avatar-speech.mp4", "speech");
  await materializeAsset(context.app, projectId, speechFileAssetId, videoFixture);
  const speechState = applySingleSpeechAsset(context.app, projectId, referenceAudioAssetId, speechFileAssetId, "avatar_speech_asset");
  const speechAsset = speechState.snapshot.speechAsset;
  const segment = speechState.snapshot.speechSegments[0];
  assert.ok(speechAsset && segment, "Avatar 测试必须有已就绪的 SpeechAsset 与 SpeechSegment");

  const sceneState = context.app.createScene({
    projectId,
    baseRevision: speechState.revision.number,
    type: "PresenterScene",
    title: "Avatar 主画面",
    purpose: "承载与旁白时序一致的生成型人物",
    startFrame: 0,
    endFrame: 24
  });
  const scene = sceneState.snapshot.scenes[0];
  assert.ok(scene, "Avatar placement 必须有 PresenterScene");

  const portraitAssetId = addReadyAsset(context.app, projectId, "avatar-portrait.png", "image", { video: false, hasAudio: false });
  await materializeAsset(context.app, projectId, portraitAssetId, await createPortraitFixture(context.root));
  const { profile } = createCapabilityProfile(context.app, projectId, { supportsAudioDrivenLipSync: true });
  return {
    projectId,
    videoFixture,
    portraitAssetId,
    profile,
    speechAsset,
    segment,
    scene
  };
}

function submitPreparedAvatarJob(
  app: EditingApplication,
  prepared: Awaited<ReturnType<typeof prepareAvatarJob>>,
  idempotencyKey: string
) {
  return app.submitAvatarGeneration({
    projectId: prepared.projectId,
    baseRevision: app.readProject(prepared.projectId).revision.number,
    capabilityProfileId: prepared.profile.id,
    referenceImageAssetId: prepared.portraitAssetId,
    speechAssetId: prepared.speechAsset.id,
    generationRange: { startFrame: 0, endFrame: 24, speechSegmentIds: [prepared.segment.id] },
    placement: { sceneId: prepared.scene.id, startFrame: 0, endFrame: 24 },
    maskMode: "none",
    audioMode: "use_dialogue_track",
    layout: { actorHead: { x: 0.5, y: 0.28, source: "manual_static" } },
    note: "测试用自然正面主持人",
    idempotencyKey
  });
}

test("ActorCapabilityProfile 只记录已确认能力，且被人物表演引用时不可删除", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Avatar 能力档案测试", profile: "presenter_motion" });
    const { profile } = createCapabilityProfile(context.app, created.snapshot.project.id);
    assert.deepEqual(profile.inputModes, ["audio"]);
    assert.equal(profile.supportsAudioDrivenLipSync, false, "Profile 必须默认保守，不凭“可上传音频”假定口型已验证");
    assert.equal(profile.supportsGestureControl, false, "不能把未验证的手势能力登记为可用");
    assert.equal(context.app.listActorCapabilityProfiles(created.snapshot.project.id)[0]?.id, profile.id);

    const updated = context.app.manageActorCapabilityProfile({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      action: "update",
      profileId: profile.id,
      label: "MiniMax H3 多参考人物（已确认音频输入）",
      supportsPartialRegeneration: false
    });
    assert.equal(updated.snapshot.actorCapabilityProfiles[0]?.supportsPartialRegeneration, false);

    const presenter = createReadyPresenter(context.app, created.snapshot.project.id);
    const registered = context.app.registerActorPerformance({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      timelineItemId: presenter.itemId,
      source: "imported",
      maskMode: "none",
      capabilityProfileId: profile.id,
      audioMode: "muted"
    });
    assert.equal(registered.snapshot.actorPerformances[0]?.capabilityProfileId, profile.id);

    await assert.rejects(
      async () => context.app.manageActorCapabilityProfile({
        projectId: created.snapshot.project.id,
        baseRevision: registered.revision.number,
        action: "remove",
        profileId: profile.id
      }),
      (error: unknown) => error instanceof DomainError && error.code === "ACTOR_CAPABILITY_IN_USE"
    );
  } finally {
    await context.dispose();
  }
});

test("人工静态人物锚点可以驱动布局，但无 Mask 的后景效果必须阻塞并显式降级", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Avatar 锚点与 Mask 降级测试", profile: "presenter_motion" });
    const presenter = createReadyPresenter(context.app, created.snapshot.project.id);
    const performanceState = context.app.registerActorPerformance({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      timelineItemId: presenter.itemId,
      source: "imported",
      maskMode: "none",
      audioMode: "muted",
      layout: {
        actorHead: { x: 0.48, y: 0.27, source: "manual_static" },
        actorHands: { x: 0.53, y: 0.64, source: "manual_static" }
      }
    });
    const headCueState = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: performanceState.revision.number,
      sceneId: presenter.sceneId,
      type: "MetricBackdrop",
      layer: "front",
      spatialAnchor: "actor_head",
      startFrame: 2,
      endFrame: 18,
      note: "人物头部附近的人工标注"
    });
    const headCue = headCueState.snapshot.effectCues[0]!;
    const layout = compileMotionLayout(headCue, 10, headCueState.snapshot.actorPerformances[0]?.layout);
    assert.equal(layout.container.left, "48.00%");
    assert.equal(layout.container.top, "27.00%");
    assert.equal(layout.anchorTransform, "translate(-50%, -50%)");

    const headQuality = evaluateQuality(headCueState.snapshot, headCueState.revision.number);
    assert.ok(headQuality.issues.some((entry) => entry.code === "ACTOR_MASK_FALLBACK" && entry.level === "warning"));
    assert.ok(headQuality.issues.some((entry) => entry.code === "EFFECT_ACTOR_ANCHOR_MANUAL_REVIEW" && entry.level === "warning"));
    assert.equal(headQuality.issues.some((entry) => entry.code === "EFFECT_ACTOR_ANCHOR_MISSING"), false);

    const rearCueState = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: headCueState.revision.number,
      sceneId: presenter.sceneId,
      type: "MetricBackdrop",
      layer: "rear",
      spatialAnchor: "behind_actor",
      startFrame: 3,
      endFrame: 17,
      note: "需要真实人物后景遮挡的图形"
    });
    const rearQuality = evaluateQuality(rearCueState.snapshot, rearCueState.revision.number);
    assert.ok(rearQuality.issues.some((entry) => entry.code === "REAR_EFFECT_FALLBACK" && entry.level === "warning"));
    assert.ok(rearQuality.issues.some((entry) => entry.code === "EFFECT_BEHIND_ACTOR_MASK_REQUIRED" && entry.level === "blocking"));

    const ordinaryImageId = addReadyAsset(context.app, created.snapshot.project.id, "ordinary-image.png", "image", { video: false, hasAudio: false, role: "actor_mask" });
    assert.throws(
      () => context.app.registerActorPerformance({
        projectId: created.snapshot.project.id,
        baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
        timelineItemId: presenter.itemId,
        source: "imported",
        maskMode: "alpha_asset",
        maskAssetId: ordinaryImageId,
        audioMode: "muted",
        layout: { actorHead: { x: 0.48, y: 0.27, source: "manual_static" } }
      }),
      (error: unknown) => error instanceof DomainError && error.code === "ACTOR_MASK_ALPHA_REQUIRED"
    );

    const maskAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter-mask.png", "image", {
      video: false,
      hasAudio: false,
      role: "actor_mask",
      hasAlpha: true
    });
    const withMask = context.app.registerActorPerformance({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      timelineItemId: presenter.itemId,
      source: "imported",
      maskMode: "alpha_asset",
      maskAssetId,
      audioMode: "muted",
      layout: { actorHead: { x: 0.48, y: 0.27, source: "manual_static" } }
    });
    const maskedQuality = evaluateQuality(withMask.snapshot, withMask.revision.number);
    assert.equal(maskedQuality.issues.some((entry) => entry.code === "REAR_EFFECT_FALLBACK"), false);
    assert.equal(maskedQuality.issues.some((entry) => entry.code === "EFFECT_BEHIND_ACTOR_MASK_REQUIRED"), false);
    assert.ok(maskedQuality.issues.some((entry) => entry.code === "ACTOR_MASK_CONTINUOUS_PREVIEW_REQUIRED" && entry.level === "blocking"));
  } finally {
    await context.dispose();
  }
});

test("SpeechAsset 替换会使生成型人物 stale，并只标出它可局部重生成的范围", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Avatar 语音失效范围测试", profile: "presenter_motion" });
    const projectId = created.snapshot.project.id;
    const referenceAssetId = addReadyAsset(context.app, projectId, "reference.wav", "audio");
    context.app.applyTranscript({ projectId, assetId: referenceAssetId, text: "这是一段需要重新口型同步的话。", source: "manual" });
    applySemanticUnitsFromCandidates(context.app, projectId);
    const firstSpeechFileId = addReadyAsset(context.app, projectId, "speech-v1.wav", "speech");
    applySingleSpeechAsset(context.app, projectId, referenceAssetId, firstSpeechFileId, "speech_asset_v1");
    const presenter = createReadyPresenter(context.app, projectId);
    const { profile } = createCapabilityProfile(context.app, projectId, { supportsAudioDrivenLipSync: true });
    const registered = context.app.registerActorPerformance({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      timelineItemId: presenter.itemId,
      source: "generated",
      maskMode: "none",
      audioMode: "use_dialogue_track",
      capabilityProfileId: profile.id
    });
    const segmentId = registered.snapshot.speechSegments[0]!.id;

    // 模拟 Worker 已把可追溯的生成结果写入上一 Revision；此处不伪造姿态或局部无缝修补能力。
    const completed = context.app.repository.commit(projectId, registered.revision.number, "模拟已完成 Avatar 生成", (snapshot, impact) => {
      const performance = snapshot.actorPerformances[0]!;
      performance.generationJobId = "avatar_job_completed";
      performance.generationRange = { startFrame: 0, endFrame: 24, speechSegmentIds: [segmentId] };
      performance.bridgeAudit = {
        workflowId: profile.workflowId,
        runId: "avatar-run-1",
        schemaVersion: "avatar-schema-v1",
        schemaRetryCount: 0,
        submittedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        request: { fieldValues: {}, fileSlots: [] },
        response: { status: "succeeded", outputs: [] }
      };
      impact.changed.push(performance.id);
    });
    assert.equal(evaluateQuality(completed.snapshot, completed.revision.number).issues.some((entry) => entry.code === "ACTOR_GENERATION_TRACE_MISSING"), false);

    const unverifiedProfile = context.app.manageActorCapabilityProfile({
      projectId,
      baseRevision: completed.revision.number,
      action: "update",
      profileId: profile.id,
      supportsAudioDrivenLipSync: false
    });
    const unverifiedQuality = evaluateQuality(unverifiedProfile.snapshot, unverifiedProfile.revision.number);
    assert.ok(unverifiedQuality.issues.some((entry) => entry.code === "ACTOR_LIP_SYNC_CAPABILITY_UNVERIFIED" && entry.level === "blocking"));
    context.app.manageActorCapabilityProfile({
      projectId,
      baseRevision: unverifiedProfile.revision.number,
      action: "update",
      profileId: profile.id,
      supportsAudioDrivenLipSync: true
    });

    const secondSpeechFileId = addReadyAsset(context.app, projectId, "speech-v2.wav", "speech");
    const replaced = applySingleSpeechAsset(context.app, projectId, referenceAssetId, secondSpeechFileId, "speech_asset_v2");
    const performance = replaced.snapshot.actorPerformances[0]!;
    assert.equal(performance.status, "stale");
    assert.ok(replaced.revision.impact.stale.includes(performance.id));
    assert.ok(replaced.revision.impact.dirtyRanges.some((range) => (
      range.startFrame === 0
      && range.endFrame === 24
      && range.reason.includes("生成型人物")
    )));
    const quality = evaluateQuality(replaced.snapshot, replaced.revision.number);
    assert.ok(quality.issues.some((entry) => entry.code === "ACTOR_PERFORMANCE_STALE" && entry.level === "blocking"));
    assert.ok(quality.issues.some((entry) => entry.code === "ACTOR_SPEECH_VERSION_MISMATCH" && entry.level === "blocking"));
  } finally {
    await context.dispose();
  }
});

test("多个 Actor / A-roll 人物同时覆盖效果时，质量门禁不能按数组顺序猜锚点", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Avatar 多人物锚点歧义测试", profile: "presenter_motion" });
    const projectId = created.snapshot.project.id;
    const presenter = createReadyPresenter(context.app, projectId);
    const registered = context.app.registerActorPerformance({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      timelineItemId: presenter.itemId,
      source: "imported",
      maskMode: "none",
      audioMode: "muted",
      layout: { actorHead: { x: 0.33, y: 0.28, source: "manual_static" } }
    });
    const alternateAssetId = addReadyAsset(context.app, projectId, "speaker-b.mp4", "video");
    const state = context.app.createEffectCue({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      sceneId: presenter.sceneId,
      type: "MetricBackdrop",
      layer: "front",
      spatialAnchor: "actor_head",
      startFrame: 2,
      endFrame: 18,
      note: "两个主持人同时出现时的锚点测试"
    });
    const actorTrack = state.snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll");
    assert.ok(actorTrack, "测试必须存在人物主画面轨");
    const actorItem = state.snapshot.timeline.items.find((item) => item.id === presenter.itemId);
    const actorPerformance = state.snapshot.actorPerformances.find((performance) => performance.timelineItemId === presenter.itemId);
    assert.ok(actorItem && actorPerformance, "测试必须有已登记的人物主画面");

    // 正常写入会禁止同一轨重叠。这里模拟旧 Revision / 外部合并造成的并行人物状态，
    // 验证质量和运行时的防御层仍会拒绝猜测“第一个”人物，而不是依赖正常写入的不变量。
    const legacySnapshot = structuredClone(state.snapshot);
    const legacyTrackId = "legacy_parallel_actor_track";
    const legacyItemId = "legacy_parallel_actor_item";
    legacySnapshot.timeline.tracks.push({ ...actorTrack, id: legacyTrackId });
    legacySnapshot.timeline.items.push({
      ...actorItem,
      id: legacyItemId,
      trackId: legacyTrackId,
      assetId: alternateAssetId
    });
    legacySnapshot.actorPerformances.push({
      ...actorPerformance,
      id: "legacy_parallel_actor_performance",
      timelineItemId: legacyItemId,
      layout: { actorHead: { x: 0.67, y: 0.28, source: "manual_static" } }
    });
    const quality = evaluateQuality(legacySnapshot, state.revision.number);
    assert.ok(quality.issues.some((entry) => entry.code === "EFFECT_ACTOR_ANCHOR_AMBIGUOUS" && entry.level === "blocking"));
    assert.equal(registered.snapshot.actorPerformances.length, 1, "正常 Application 写入仍保持单人物轨的不重叠约束");
  } finally {
    await context.dispose();
  }
});

test("Avatar Worker 会重读 Bridge Schema、在 409 后重试，并将同一 Job 的结果幂等回收", async () => {
  const context = await createTestApplication();
  const originalFetch = globalThis.fetch;
  try {
    const prepared = await prepareAvatarJob(context, "Avatar Bridge Schema 与重领测试");
    const matchingBrollHash = createHash("sha256").update(await readFile(prepared.videoFixture)).digest("hex");
    const brollAssetId = addReadyAsset(context.app, prepared.projectId, "same-binary-broll.mp4", "video", {
      role: "b_roll",
      sourceHash: matchingBrollHash
    });
    const job = submitPreparedAvatarJob(context.app, prepared, "avatar-schema-retry");
    const replayedSubmission = submitPreparedAvatarJob(context.app, prepared, "avatar-schema-retry");
    assert.equal(replayedSubmission.id, job.id, "相同幂等键不能重复创建 Avatar Job");
    markSeedMediaJobsHandled(context.app, prepared.projectId);

    let detailCalls = 0;
    let runCalls = 0;
    let runReads = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/workflows/${prepared.profile.workflowId}`)) {
        detailCalls += 1;
        const schemaVersion = detailCalls === 1 ? "avatar-v1" : "avatar-v2";
        return new Response(JSON.stringify({
          id: prepared.profile.workflowId,
          name: "MiniMax H3 多参考",
          available: true,
          schemaVersion,
          fields: [
            { id: `negative_${schemaVersion}`, label: "Negative Prompt", kind: "text", required: false },
            { id: `prompt_${schemaVersion}`, label: "Prompt", kind: "text", required: false },
            { id: `duration_${schemaVersion}`, label: "Duration Seconds", kind: "number", required: false },
            { id: `aspect_${schemaVersion}`, label: "Aspect Ratio", kind: "select", required: false, options: [{ label: "9:16", value: "vertical" }] }
          ],
          itemSlots: [
            { id: `portrait_${schemaVersion}`, label: "Portrait Reference", kind: "image", required: true },
            { id: `speech_${schemaVersion}`, label: "Speech Audio", kind: "audio", required: true }
          ],
          outputs: [{ id: "video", label: "Generated Video", kind: "video" }]
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith(`/workflows/${prepared.profile.workflowId}/runs`)) {
        runCalls += 1;
        if (runCalls === 1) {
          return new Response(JSON.stringify({ error: "schemaVersion 过期" }), { status: 409, headers: { "content-type": "application/json" } });
        }
        const body = init?.body;
        assert.ok(body instanceof FormData, "带肖像和旁白的 Avatar 请求必须采用当前 Schema 的 multipart 表单");
        const request = JSON.parse(String(body.get("request"))) as { schemaVersion: string; fieldValues: Record<string, unknown> };
        assert.equal(request.schemaVersion, "avatar-v2");
        assert.equal(request.fieldValues["prompt_avatar-v2"], "参考图片中的人物以稳定、自然的主持人口吻面对镜头说话，表情和动作克制。使用提供的音频作为表演参考；不要添加屏幕文字、无关人物或无关场景。");
        assert.equal(request.fieldValues["negative_avatar-v2"], undefined, "反向提示词即使排在最前，也不能承载正向人物表演指令");
        assert.equal(request.fieldValues["duration_avatar-v2"], 1);
        assert.equal(request.fieldValues["aspect_avatar-v2"], "vertical");
        assert.ok(body.get("file_portrait_avatar-v2") instanceof Blob, "重读 Schema 后必须使用新的肖像 Slot ID");
        assert.ok(body.get("file_speech_avatar-v2") instanceof Blob, "重读 Schema 后必须使用新的音频 Slot ID");
        return new Response(JSON.stringify({ id: "avatar-run-v2", status: "queued", outputs: [] }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/runs/avatar-run-v2")) {
        runReads += 1;
        return new Response(JSON.stringify({
          id: "avatar-run-v2",
          status: "succeeded",
          outputs: [{ outputSlotId: "video", displayName: "avatar-result.mp4", kind: "video", fileName: "avatar-result.mp4", mime: "video/mp4", downloadUrl: "/files/avatar-result.mp4" }]
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/files/avatar-result.mp4")) {
        return new Response(await readFile(prepared.videoFixture), { headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`未预期的 Avatar Bridge 请求：${url}`);
    };

    const bridge = new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1");
    assert.equal(await runOneJob(context.app, createMediaJobProcessor(context.app, bridge)), true);
    const completedJob = context.app.trackJob(job.id);
    assert.equal(completedJob.status, "succeeded");
    const audits = completedJob.result?.bridgeRuns as Array<{ runId?: string; schemaVersion?: string; schemaRetryCount?: number }> | undefined;
    assert.equal(audits?.length, 1);
    assert.equal(audits?.[0]?.runId, "avatar-run-v2");
    assert.equal(audits?.[0]?.schemaVersion, "avatar-v2");
    assert.equal(audits?.[0]?.schemaRetryCount, 1);
    assert.equal(detailCalls, 2);
    assert.equal(runCalls, 2);

    const completedState = context.app.readProject(prepared.projectId);
    const performance = completedState.snapshot.actorPerformances[0];
    assert.ok(performance, "成功 Job 必须写入可读回的 ActorPerformance");
    assert.equal(performance.source, "generated");
    assert.equal(performance.generationJobId, job.id);
    assert.equal(performance.speechAssetId, prepared.speechAsset.id);
    assert.deepEqual(performance.generationRange, { startFrame: 0, endFrame: 24, speechSegmentIds: [prepared.segment.id] });
    assert.equal(performance.layout?.actorHead?.source, "manual_static");
    const actorItem = completedState.snapshot.timeline.items.find((item) => item.id === performance.timelineItemId);
    assert.ok(actorItem);
    assert.equal(actorItem.gainDb, -96, "生成人物视频默认静音，Dialogue 才是唯一声音所有者");
    const actorAsset = completedState.snapshot.assets.find((asset) => asset.id === actorItem.assetId);
    assert.equal(actorAsset?.kind, "actor_video");

    // 即使 Provider 结果与已有 B-roll 二进制相同，也只能新建 Actor Asset；不能把旧素材改成 A-roll。
    const existingBroll = completedState.snapshot.assets.find((asset) => asset.id === brollAssetId);
    assert.ok(existingBroll, "预先登记的 B-roll 不能在 Avatar 完成后丢失");
    assert.equal(existingBroll.kind, "video");
    assert.equal(existingBroll.role, "b_roll");
    assert.equal(existingBroll.sourceHash, matchingBrollHash);
    assert.notEqual(actorAsset?.id, brollAssetId, "Avatar 必须创建独立 Asset，不能复用并覆写同哈希 B-roll");
    assert.equal(actorAsset?.sourceHash, matchingBrollHash, "测试应覆盖二进制哈希碰撞而非普通不同素材");

    // 结果已写入后再次按同一 Job 读取远端 Run，必须复用本地产物而非新增 Asset / Timeline Item。
    const beforeReplay = context.app.readProject(prepared.projectId);
    // 模拟 Application 已写入结果、但 Worker 尚未来得及把 Job 最终标成 succeeded 就崩溃的重领场景。
    // 即使 Job.result 尚未写回，Project 中 generationJobId 已经是更可靠的副作用证据，不能再次触碰 Provider。
    const reclaimed = context.app.repository.updateJob(job.id, { status: "running", result: {}, leaseUntil: new Date(Date.now() - 1_000).toISOString() });
    const replay = await runAvatarGeneration(context.app, reclaimed, bridge);
    assert.equal(replay.recoveredProjectWrite, true);
    const afterReplay = context.app.readProject(prepared.projectId);
    assert.equal(afterReplay.snapshot.assets.length, beforeReplay.snapshot.assets.length);
    assert.equal(afterReplay.snapshot.timeline.items.length, beforeReplay.snapshot.timeline.items.length);
    assert.equal(afterReplay.snapshot.actorPerformances.length, beforeReplay.snapshot.actorPerformances.length);
    assert.equal(runReads, 1, "Project 已有同一 Job 的人物结果时，重领不得再次轮询或重提 Bridge");
  } finally {
    globalThis.fetch = originalFetch;
    await context.dispose();
  }
});

test("Avatar Worker 拒绝不唯一或未明确覆盖的媒体 Slot，不向 Provider 猜测性发起付费调用", async () => {
  const context = await createTestApplication();
  const originalFetch = globalThis.fetch;
  try {
    const prepared = await prepareAvatarJob(context, "Avatar Schema 槽位歧义门禁测试");
    const schemas = [
      {
        id: prepared.profile.workflowId,
        name: "肖像槽位歧义",
        available: true,
        schemaVersion: "avatar-portrait-ambiguous",
        fields: [{ id: "prompt", label: "Prompt", kind: "text", required: false }],
        itemSlots: [
          { id: "portrait-primary", label: "Portrait Primary", kind: "image", required: true },
          { id: "portrait-backup", label: "Portrait Backup", kind: "image", required: true },
          { id: "speech", label: "Speech Audio", kind: "audio", required: true }
        ],
        outputs: [{ id: "video", label: "Generated Video", kind: "video" }]
      },
      {
        id: prepared.profile.workflowId,
        name: "旁白槽位歧义",
        available: true,
        schemaVersion: "avatar-speech-ambiguous",
        fields: [{ id: "prompt", label: "Prompt", kind: "text", required: false }],
        itemSlots: [
          { id: "portrait", label: "Portrait Reference", kind: "image", required: true },
          { id: "speech-primary", label: "Speech Audio Primary", kind: "audio", required: true },
          { id: "voice-backup", label: "Voice Audio Backup", kind: "audio", required: true }
        ],
        outputs: [{ id: "video", label: "Generated Video", kind: "video" }]
      },
      {
        id: prepared.profile.workflowId,
        name: "未覆盖必填媒体槽位",
        available: true,
        schemaVersion: "avatar-required-media-unhandled",
        fields: [{ id: "prompt", label: "Prompt", kind: "text", required: false }],
        itemSlots: [
          { id: "portrait", label: "Portrait Reference", kind: "image", required: true },
          { id: "backdrop", label: "Backdrop", kind: "image", required: true },
          { id: "speech", label: "Speech Audio", kind: "audio", required: true }
        ],
        outputs: [{ id: "video", label: "Generated Video", kind: "video" }]
      }
    ];
    let runPostCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/workflows/${prepared.profile.workflowId}`)) {
        const schema = schemas.shift();
        assert.ok(schema, "每次失败前都只能读取当前一次 Schema");
        return Response.json(schema);
      }
      if (url.endsWith(`/workflows/${prepared.profile.workflowId}/runs`) && init?.method === "POST") {
        runPostCount += 1;
        return Response.json({ id: "unexpected-avatar-run", status: "queued", outputs: [] });
      }
      throw new Error(`未预期的 Avatar Bridge 请求：${url}`);
    };
    const bridge = new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1");

    const portraitAmbiguous = submitPreparedAvatarJob(context.app, prepared, "avatar-portrait-slot-ambiguous");
    await assert.rejects(
      () => runAvatarGeneration(context.app, portraitAmbiguous, bridge),
      (error: unknown) => error instanceof DomainError && error.code === "AVATAR_PORTRAIT_SLOT_AMBIGUOUS"
    );

    const speechAmbiguous = submitPreparedAvatarJob(context.app, prepared, "avatar-speech-slot-ambiguous");
    await assert.rejects(
      () => runAvatarGeneration(context.app, speechAmbiguous, bridge),
      (error: unknown) => error instanceof DomainError && error.code === "AVATAR_SPEECH_SLOT_AMBIGUOUS"
    );

    const requiredMediaUnhandled = submitPreparedAvatarJob(context.app, prepared, "avatar-required-media-slot-unhandled");
    await assert.rejects(
      () => runAvatarGeneration(context.app, requiredMediaUnhandled, bridge),
      (error: unknown) => error instanceof DomainError && error.code === "AVATAR_REQUIRED_MEDIA_SLOT_UNHANDLED"
    );
    assert.equal(runPostCount, 0, "Schema 不明确时不能创建 Avatar Run 或消耗 Provider 额度");
  } finally {
    globalThis.fetch = originalFetch;
    await context.dispose();
  }
});

test("未验证音频驱动口型的能力档案不能提交 Avatar 任务", async () => {
  const context = await createTestApplication();
  try {
    const prepared = await prepareAvatarJob(context, "Avatar 口型能力提交门禁测试");
    const downgraded = context.app.manageActorCapabilityProfile({
      projectId: prepared.projectId,
      baseRevision: context.app.readProject(prepared.projectId).revision.number,
      action: "update",
      profileId: prepared.profile.id,
      supportsAudioDrivenLipSync: false
    });
    assert.throws(
      () => submitPreparedAvatarJob(context.app, prepared, "avatar-lipsync-unverified"),
      (error: unknown) => error instanceof DomainError && error.code === "AVATAR_LIP_SYNC_CAPABILITY_UNSUPPORTED"
    );
    assert.equal(context.app.readProject(prepared.projectId).revision.number, downgraded.revision.number, "被拒绝的提交不能创建 Job 或写入新的 Revision");
    assert.equal(context.app.repository.listJobs(prepared.projectId).some((job) => job.kind === "avatar_generation"), false);
  } finally {
    await context.dispose();
  }
});

test("Avatar Bridge 成功但没有视频输出时保留审计并把 Job 标记为失败", async () => {
  const context = await createTestApplication();
  const originalFetch = globalThis.fetch;
  try {
    const prepared = await prepareAvatarJob(context, "Avatar 输出缺失测试");
    const job = submitPreparedAvatarJob(context.app, prepared, "avatar-output-missing");
    markSeedMediaJobsHandled(context.app, prepared.projectId);
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(`/workflows/${prepared.profile.workflowId}`)) {
        return new Response(JSON.stringify({
          id: prepared.profile.workflowId,
          name: "MiniMax H3 多参考",
          available: true,
          schemaVersion: "avatar-output-v1",
          fields: [{ id: "prompt", label: "Prompt", kind: "text", required: false }],
          itemSlots: [
            { id: "portrait", label: "Portrait", kind: "image", required: true },
            { id: "speech", label: "Speech", kind: "audio", required: true }
          ],
          outputs: [{ id: "video", label: "Generated Video", kind: "video" }]
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith(`/workflows/${prepared.profile.workflowId}/runs`)) {
        return new Response(JSON.stringify({ id: "avatar-no-output", status: "queued", outputs: [] }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/runs/avatar-no-output")) {
        return new Response(JSON.stringify({ id: "avatar-no-output", status: "succeeded", outputs: [] }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`未预期的 Avatar Bridge 请求：${url}`);
    };

    const bridge = new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1");
    assert.equal(await runOneJob(context.app, createMediaJobProcessor(context.app, bridge)), true);
    const failed = context.app.trackJob(job.id);
    assert.equal(failed.status, "failed");
    const diagnostic = failed.result?.diagnostic as { code?: string; message?: string } | undefined;
    assert.equal(diagnostic?.code, "MISSING_AVATAR_OUTPUT");
    assert.match(diagnostic?.message ?? "", /没有可下载的视频输出/u);
    const audits = failed.result?.bridgeRuns as Array<{ runId?: string; response?: { outputs?: unknown[] } }> | undefined;
    assert.equal(audits?.[0]?.runId, "avatar-no-output");
    assert.deepEqual(audits?.[0]?.response?.outputs, []);
    assert.equal(context.app.readProject(prepared.projectId).snapshot.actorPerformances.length, 0, "缺输出不能伪造 ActorPerformance");
  } finally {
    globalThis.fetch = originalFetch;
    await context.dispose();
  }
});

test("Avatar Worker 拒绝非 H.264 的 Provider 输出，不隐式转码改变口型时长", async () => {
  const context = await createTestApplication();
  const originalFetch = globalThis.fetch;
  try {
    const prepared = await prepareAvatarJob(context, "Avatar 输出编码门禁测试");
    const incompatibleFixture = await createIncompatibleAvatarVideoFixture(context.root);
    const job = submitPreparedAvatarJob(context.app, prepared, "avatar-output-incompatible-codec");
    markSeedMediaJobsHandled(context.app, prepared.projectId);
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(`/workflows/${prepared.profile.workflowId}`)) {
        return new Response(JSON.stringify({
          id: prepared.profile.workflowId,
          name: "MiniMax H3 多参考",
          available: true,
          schemaVersion: "avatar-codec-v1",
          fields: [{ id: "prompt", label: "Prompt", kind: "text", required: false }],
          itemSlots: [
            { id: "portrait", label: "Portrait", kind: "image", required: true },
            { id: "speech", label: "Speech", kind: "audio", required: true }
          ],
          outputs: [{ id: "video", label: "Generated Video", kind: "video" }]
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith(`/workflows/${prepared.profile.workflowId}/runs`)) {
        return new Response(JSON.stringify({ id: "avatar-codec-run", status: "queued", outputs: [] }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/runs/avatar-codec-run")) {
        return new Response(JSON.stringify({
          id: "avatar-codec-run",
          status: "succeeded",
          outputs: [{ outputSlotId: "video", displayName: "avatar-result.mp4", kind: "video", fileName: "avatar-result.mp4", mime: "video/mp4", downloadUrl: "/files/avatar-result.mp4" }]
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/files/avatar-result.mp4")) {
        return new Response(await readFile(incompatibleFixture), { headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`未预期的 Avatar Bridge 请求：${url}`);
    };

    const bridge = new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1");
    assert.equal(await runOneJob(context.app, createMediaJobProcessor(context.app, bridge)), true);
    const failed = context.app.trackJob(job.id);
    assert.equal(failed.status, "failed");
    const diagnostic = failed.result?.diagnostic as { code?: string } | undefined;
    assert.equal(diagnostic?.code, "AVATAR_OUTPUT_CODEC_UNSUPPORTED");
    assert.equal(context.app.readProject(prepared.projectId).snapshot.actorPerformances.length, 0, "不兼容输出不能写入 ActorPerformance");
  } finally {
    globalThis.fetch = originalFetch;
    await context.dispose();
  }
});

test("MCP 的 submit_avatar_job 只提交可追溯 Job，并可通过通用读取入口复核", async () => {
  const context = await createTestApplication();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: context.root },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-avatar-mcp-contract-test", version: "1.0.0" });
  try {
    const prepared = await prepareAvatarJob(context, "Avatar MCP 提交测试");
    await client.connect(transport);
    const toolNames = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const name of ["read_actor_capabilities", "manage_actor_capabilities", "submit_avatar_job", "read_actor_performances", "track_job"]) {
      assert.ok(toolNames.has(name), `MCP 缺少 Avatar 必要工具：${name}`);
    }
    const targeted = JSON.parse(textFromToolResult(await client.callTool({ name: "target_project", arguments: { project_id: prepared.projectId } }))) as { projectId: string; revision: number };
    assert.equal(targeted.projectId, prepared.projectId);
    const capabilities = JSON.parse(textFromToolResult(await client.callTool({ name: "read_actor_capabilities", arguments: {} }))) as Array<{ id: string; supportsAudioDrivenLipSync: boolean }>;
    assert.equal(capabilities[0]?.id, prepared.profile.id);
    assert.equal(capabilities[0]?.supportsAudioDrivenLipSync, true);

    const submitted = JSON.parse(textFromToolResult(await client.callTool({ name: "submit_avatar_job", arguments: {
      base_revision_id: targeted.revision,
      capability_profile_id: prepared.profile.id,
      reference_image_asset_id: prepared.portraitAssetId,
      speech_asset_id: prepared.speechAsset.id,
      generation_range: { start_frame: 0, end_frame: 24, speech_segment_ids: [prepared.segment.id] },
      placement: { scene_id: prepared.scene.id, start_frame: 0, end_frame: 24 },
      audio_mode: "use_dialogue_track",
      mask_mode: "none",
      layout: { actor_head: { x: 0.5, y: 0.28, source: "manual_static" } },
      idempotency_key: "avatar-mcp-submit"
    } }))) as {
      id: string;
      kind: string;
      status: string;
      payload: {
        capabilityProfileId: string;
        speechAssetId: string;
        generationRange: { speechSegmentIds: string[] };
        placement: { sceneId: string };
      };
    };
    assert.equal(submitted.kind, "avatar_generation");
    assert.equal(submitted.status, "queued");
    assert.equal(submitted.payload.capabilityProfileId, prepared.profile.id);
    assert.equal(submitted.payload.speechAssetId, prepared.speechAsset.id);
    assert.deepEqual(submitted.payload.generationRange.speechSegmentIds, [prepared.segment.id]);
    assert.equal(submitted.payload.placement.sceneId, prepared.scene.id);

    const tracked = JSON.parse(textFromToolResult(await client.callTool({ name: "track_job", arguments: { job_id: submitted.id } }))) as { id: string; kind: string; status: string };
    assert.equal(tracked.id, submitted.id);
    assert.equal(tracked.kind, "avatar_generation");
    assert.equal(tracked.status, "queued");
    const performances = JSON.parse(textFromToolResult(await client.callTool({ name: "read_actor_performances", arguments: {} }))) as unknown[];
    assert.deepEqual(performances, [], "提交 Job 不能假装已经生成 ActorPerformance");
  } finally {
    await transport.close().catch(() => undefined);
    await context.dispose();
  }
});
