import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "@videocut/application";
import { createMediaAsset, createTimelineItem, createScene } from "@videocut/domain";
import { ComfyUIBridgeClient, BridgeError, type BridgeWorkflow } from "@videocut/bridge";
import { AssetProviderRegistry } from "@videocut/acquisition";
import { readRuntimeConfig } from "@videocut/project-overview";
import { runProcess, probeMedia } from "@videocut/speech";
import { evaluateQuality } from "@videocut/quality";
import { manageSoundPlan } from "../packages/edit-application/src/sound-design.js";
import { soundDependencySignature, reviewSoundMix } from "../packages/edit-application/src/sound-review.js";
import { audioCueVolumeAt } from "../packages/remotion-runtime/src/index.js";
import { modelText, restoreModelCheckpoints } from "../apps/job-worker/src/model-http.js";
import { runSoundComparison } from "../apps/render-worker/src/sound-comparison.js";
import { runExportJob, runPreviewJob } from "../apps/render-worker/src/exporter.js";
import { hashMediaFile } from "../packages/edit-application/src/media-intelligence.js";
import { assetRequestVersion } from "../packages/media-intelligence/src/index.js";
import { measureAudioWindow } from "../packages/media-intelligence/src/acoustics.js";
import { deriveMediaInput } from "../packages/media-intelligence/src/derive.js";
import { motionHash, motionHashEngine } from "../packages/motion-work/src/compiler.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import type { MediaSource } from "@videocut/contracts";
import { plannedVoiceVolumeAt, resolveVideoSourceVolume } from "../packages/remotion-runtime/src/index.js";
import { runMediaUnderstanding } from "../apps/job-worker/src/media-understanding.js";

async function fixture(real = false) {
  const root = await mkdtemp(join(tmpdir(), "vfc-sound-")), app = createApplication(root);
  const created = app.createProject({ name: "隔离声音链路回归", profile: "presenter_motion" });
  const id = created.snapshot.project.id, rev = () => app.readProject(id).revision.number;
  const directory = join(created.snapshot.project.rootPath, "assets");
  await mkdir(directory, { recursive: true });
  const sound = createMediaAsset({ name: "技术正弦音", kind: "audio", managedPath: "assets/tone.wav", sourceHash: "fixture", role: "sfx" });
  const visual = createMediaAsset({ name: "技术色块", kind: "video", managedPath: "assets/visual.mp4", sourceHash: "visual", role: "a_roll" });
  if (real) {
    await runProcess("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "48000", join(directory, "tone.wav")]);
    await runProcess("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=3", "-c:v", "libx264", join(directory, "visual.mp4")]);
    sound.sourceHash = await hashMediaFile(join(directory, "tone.wav"));
    visual.sourceHash = await hashMediaFile(join(directory, "visual.mp4"));
  }
  Object.assign(sound, { status: "ready", metadata: { durationMs: 1000, hasAudio: true, audioCodec: "pcm_s16le", sampleRate: 48000, channels: 1 } });
  Object.assign(visual, { status: "ready", metadata: { durationMs: 3000, hasAudio: false, videoCodec: "h264", width: 320, height: 180, fps: 30 } });
  app.repository.commit(id, rev(), "测试输入", (snapshot) => {
    snapshot.timeline.width = 320; snapshot.timeline.height = 180; snapshot.timeline.fps = 30;
    snapshot.assets.push(sound, visual);
    snapshot.timeline.items.push(createTimelineItem({ trackId: snapshot.timeline.tracks.find((t) => t.name === "Actor / A-roll")!.id, assetId: visual.id, startFrame: 0, endFrame: 90, sourceStartFrame: 0, sourceEndFrame: 90 }));
    snapshot.scenes.push(createScene({ type: "PresenterScene", title: "声音测试", purpose: "测试领域规则", startFrame: 0, endFrame: 90 }));
  });
  const add = (extra: Partial<Parameters<typeof app.manageAudio>[0]> = {}) => app.manageAudio({ projectId: id, baseRevision: rev(), action: "create", assetId: sound.id, kind: "sfx", purpose: "连续动作测试", eventFrame: 12, onsetOffsetFrames: 2, sourceStartFrame: 0, sourceEndFrame: 30, gainDb: -6, design: { role: "sfx" }, ...extra });
  return { root, app, id, rev, sound, visual, add, close: async () => { app.repository.close(); await rm(root, { recursive: true, force: true }); } };
}

test("专项声音复核确实透传问题并隔离不同问题缓存，初看仍保持盲观察", async () => {
  const f = await fixture(true);
  try {
    const bridge = new ComfyUIBridgeClient(readRuntimeConfig().bridge.apiBaseUrl);
    const schema = (id: string): BridgeWorkflow => ({ id, schemaVersion: "review-fixture", name: "复核协议", available: true, fields: ["prompt", "start_seconds", "duration_seconds"].map((id) => ({ id, label: id, kind: "text", required: false })), itemSlots: [{ id: "audio", kind: "audio", label: "声音", required: true }], outputs: [] });
    const prompts: string[] = [];
    bridge.getWorkflow = async (id) => schema(id);
    bridge.createRunWithSchemaRetry = async (id, build) => {
      const workflow = schema(id), request = await build(workflow);
      prompts.push(String(request.fieldValues.prompt));
      assert.equal(request.files?.[0].mime, "audio/wav");
      assert.equal((await probeMedia(request.files![0].path)).sampleRate, 16000);
      return { workflow, request, schemaRetryCount: 0, run: { id: `review-${prompts.length}`, status: "queued", outputs: [] } };
    };
    bridge.waitForRun = async (id) => ({ id, status: "succeeded", outputs: [{ outputSlotId: "result", kind: "text", displayName: "观察", text: JSON.stringify({ facts: [{ modality: "audio", text: "协议测试：持续纯音", startMs: 0, endMs: 1000 }], unknowns: ["不是人工听审"] }) }] });
    const revision = f.rev();
    for (const context of ["核查起音是否有爆点", "核查尾部是否突然截断"]) {
      const job = await f.app.intelligence.submitAnalysis(f.id, { assetId: f.sound.id, depth: "review", modalities: ["audio"], context });
      await runMediaUnderstanding(f.app, job, bridge, new AssetProviderRegistry());
      assert.ok(prompts.at(-1)!.includes(context));
      assert.equal(f.app.intelligence.store.observations(f.id).at(-1)!.promptText, prompts.at(-1));
    }
    assert.equal(prompts.length, 2, "不同复核问题不能误复用旧回答");
    assert.equal(f.rev(), revision);
  } finally { await f.close(); }
});

test("持续声必须有足够源范围或明确循环接缝，源变更使循环与起音复核失效", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.add({ design: { role: "sfx", durationFrames: 60 } }), /源范围不足/u);
    assert.throws(() => f.add({ loop: true, design: { role: "sfx", durationFrames: 60 } }), /接缝/u);
    const state = f.add({ loop: true, design: { role: "sfx", durationFrames: 60, loopCrossfadeFrames: 3, loopReview: { status: "confirmed", note: "此处为协议测试的模拟听审记录，不代表声音审美已通过。" }, envelope: [{ frame: 0, gainDb: -12 }, { frame: 30, gainDb: 0 }, { frame: 60, gainDb: -18 }] } });
    const cue = state.snapshot.audioCues[0], item = state.snapshot.timeline.items.find((i) => i.id === cue.timelineItemId)!;
    assert.equal(item.endFrame, 70); assert.equal(cue.mixReview, "needs_review");
    const volume = (frame: number) => audioCueVolumeAt(state.snapshot, item, state.snapshot.timeline.tracks.find((t) => t.id === item.trackId)!, cue, frame);
    assert.ok(volume(30) > volume(0) * 3);
    const changed = f.app.manageAudio({ projectId: f.id, baseRevision: f.rev(), action: "update", audioCueId: cue.id, sourceStartFrame: 1, onsetOffsetFrames: 1 });
    assert.equal(changed.snapshot.audioCues[0].loopReview, undefined);
    assert.equal(changed.snapshot.audioCues[0].onsetReview?.status, "inconclusive");
  } finally { await f.close(); }
});

test("计划不允许重复意图、旧版本采用或删除后继续发声", async () => {
  const f = await fixture();
  try {
    let state = manageSoundPlan(f.app, f.id, f.rev(), { action: "create", startFrame: 0, endFrame: 90, narrationDirection: "讲清因果", musicDirection: "轻铺底，结论退让", dominantRole: "narration", intents: [{ id: "settle", function: "settle", brief: "动作落定" }] });
    const plan = state.snapshot.soundPlans![0];
    state = f.add({ design: { role: "sfx", soundPlanId: plan.id, soundIntentId: "settle", planVersion: plan.version } });
    assert.throws(() => f.add({ design: { role: "sfx", soundPlanId: plan.id, soundIntentId: "settle", planVersion: plan.version } }), /已有 Cue/u);
    manageSoundPlan(f.app, f.id, f.rev(), { action: "update", soundPlanId: plan.id, musicDirection: "结论前留白" });
    assert.throws(() => f.app.manageAudio({ projectId: f.id, baseRevision: f.rev(), action: "update", audioCueId: state.snapshot.audioCues[0].id, gainDb: -4 }), /计划版本/u);
    state = manageSoundPlan(f.app, f.id, f.rev(), { action: "remove", soundPlanId: plan.id });
    assert.equal(state.snapshot.audioCues[0].status, "stale");
    assert.equal(state.snapshot.timeline.items.find((i) => i.id === state.snapshot.audioCues[0].timelineItemId)?.disabled, true);
  } finally { await f.close(); }
});

test("声音计划保留采用待复核提示但可导出，错误依据仍原子拒绝", async () => {
  const f = await fixture(true);
  try {
    let state = manageSoundPlan(f.app, f.id, f.rev(), { action: "create", startFrame: 0, endFrame: 90, narrationDirection: "协议验证", musicDirection: "保持主声音", dominantRole: "narration", intents: [{ id: "paper", function: "connection", brief: "待审声音" }] });
    const plan = state.snapshot.soundPlans![0];
    state = f.app.manageAssetRequirement({ projectId: f.id, baseRevision: f.rev(), action: "create", title: "关联声音需求", purpose: "试听原文件后判断", mediaKind: "audio", audioBrief: "短声", role: "sfx", sound: { soundPlanId: plan.id, soundIntentId: "paper", excludeSpeech: true, excludeMusic: true } });
    const design = { role: "sfx" as const, soundPlanId: plan.id, soundIntentId: "paper", planVersion: plan.version };
    const revisionBefore = f.rev();
    const comparison = f.app.repository.createJob({ projectId: f.id, kind: "sound_comparison", idempotencyKey: "planned-draft", payload: { revision: revisionBefore, fromFrame: 0, toFrame: 45, includeWithout: true, dependencySignature: soundDependencySignature(state.snapshot), alternatives: [{ name: "未采用声音候选", assetId: f.sound.id, kind: "sfx", purpose: "协议试听", eventFrame: 12, onsetOffsetFrames: 2, sourceStartFrame: 0, sourceEndFrame: 30, gainDb: -12, fadeInFrames: 0, fadeOutFrames: 3, loop: false, design }] } });
    const compared = await runSoundComparison(f.app, comparison);
    assert.equal(compared.adopted, false); assert.equal(f.rev(), revisionBefore); assert.equal(compared.outputs.length, 2);
    state = f.add({ design });
    const cue = state.snapshot.audioCues[0];
    assert.equal(cue.soundPlanId, plan.id); assert.equal(cue.soundIntentId, "paper"); assert.equal(cue.adoptionId, undefined); assert.equal(cue.status, "ready");
    const report = evaluateQuality(state.snapshot, state.revision.number);
    assert.ok(!report.editorial.audio.some((entry) => entry.code === "SOUND_ADOPTION_REQUIRED"));
    assert.ok(!report.technical.some((entry) => entry.code === "SOUND_ADOPTION_REQUIRED"));
    const draft = f.app.submitExport({ projectId: f.id, revision: f.rev(), purpose: "draft" });
    assert.equal(draft.kind, "export");
    const artifact = await runExportJob(f.app, draft);
    assert.equal((await probeMedia(String(artifact.path))).hasAudio, true);
    // 仅在测试快照中模拟其他感知项通过，采用门禁仍必须独立保留。
    const simulated = structuredClone(state.snapshot);
    simulated.audioCues[0].onsetReview = { status: "confirmed", note: "仅测试字段独立性", recordedAt: "test" };
    simulated.audioCues[0].mixReview = "reviewed";
    simulated.soundReviews = [{ baseRevision: state.revision.number, previewJobId: "模拟混合复核", previewHash: "模拟文件哈希", outcome: "passed", method: "audio", note: "只验证采用门禁独立性，不代表真实听审", signature: soundDependencySignature(simulated), fromFrame: 0, toFrame: 90, recordedAt: "test" }];
    const simulatedReport = evaluateQuality(simulated, state.revision.number);
    assert.ok(!simulatedReport.editorial.audio.some((entry) => entry.code === "SOUND_ADOPTION_REQUIRED"));
    assert.ok(!simulatedReport.editorial.audio.some((entry) => ["SFX_ONSET_REVIEW_REQUIRED", "SOUND_MIX_REVIEW_REQUIRED"].includes(entry.code)));
    const delivery = await runExportJob(f.app, f.app.submitExport({ projectId: f.id, revision: f.rev(), purpose: "delivery" }));
    assert.equal(f.app.readExportArtifact({ projectId: f.id, artifactId: String(delivery.artifactId) }).approval, undefined);
    assert.equal(f.app.readProject(f.id).snapshot.mediaAdoptions?.length ?? 0, 0, "试听和草稿不能自动制造采用记录");
  } finally { await f.close(); }
});

test("历史声音采用状态与范围不再阻塞当前正常放置", async () => {
  const f = await fixture();
  try {
    let state = manageSoundPlan(f.app, f.id, f.rev(), { action: "create", startFrame: 0, endFrame: 90, narrationDirection: "协议验证", musicDirection: "保持主声音", dominantRole: "narration", intents: [{ id: "paper", function: "connection", brief: "待审声音" }] });
    const plan = state.snapshot.soundPlans![0];
    state = f.app.manageAssetRequirement({ projectId: f.id, baseRevision: f.rev(), action: "create", title: "关联声音需求", purpose: "只验证采用绑定协议", mediaKind: "audio", audioBrief: "短声", role: "sfx", sound: { soundPlanId: plan.id, soundIntentId: "paper", excludeSpeech: true, excludeMusic: true } });
    const requirement = state.snapshot.assetRequests[0];
    const design = { role: "sfx" as const, soundPlanId: plan.id, soundIntentId: "paper", planVersion: plan.version };
    state = f.add({ design });
    const cue = state.snapshot.audioCues[0];
    // 只在隔离夹具预置采用证据，不能把本测试写成实际原声或混合复核。
    state = f.app.repository.commit(f.id, f.rev(), "模拟采用绑定协议", (snapshot) => {
      const valid = { id: "valid", assetId: f.sound.id, sourceHash: f.sound.sourceHash!, observationIds: ["模拟原文件范围观察"], requestId: requirement.id, requestVersion: assetRequestVersion(requirement), range: { startMs: 0, endMs: 1000 }, purpose: "隔离协议测试", audioPolicy: "retain" as const, conditions: [], status: "current" as const, createdAt: "test" };
      snapshot.mediaAdoptions = [valid, { ...valid, id: "other-request", requestId: "另一个需求" }, { ...valid, id: "stale", status: "needs_review" }, { ...valid, id: "short-range", range: { startMs: 0, endMs: 100 } }];
    });
    // 历史字段原样保留；过期或范围不足的旧资格不影响正常声音编辑。
    state = f.app.repository.commit(f.id, f.rev(), "读取历史声音关联", snapshot => { snapshot.audioCues[0].adoptionId = "stale"; });
    const history = structuredClone(state.snapshot.mediaAdoptions);
    state = f.app.manageAudio({ projectId: f.id, baseRevision: f.rev(), action: "update", audioCueId: cue.id, design });
    assert.deepEqual(state.snapshot.mediaAdoptions, history);
    assert.ok(!evaluateQuality(state.snapshot, state.revision.number).technical.some(entry => entry.code === "SOUND_SELECTION_STALE"));
    const report = evaluateQuality(state.snapshot, state.revision.number);
    assert.equal(state.snapshot.audioCues[0].adoptionId, "stale");
    assert.ok(!report.issues.some((entry) => entry.code === "SOUND_ADOPTION_REQUIRED"));
    assert.ok(report.editorial.audio.some((entry) => entry.code === "SFX_ONSET_REVIEW_REQUIRED"));
    assert.ok(report.editorial.audio.some((entry) => entry.code === "SOUND_MIX_REVIEW_REQUIRED"));
  } finally { await f.close(); }
});

test("声音意图或计划取消后仍可关闭历史需求，创建和更新继续校验有效关联", async () => {
  for (const removal of ["intent", "plan"] as const) {
    const f = await fixture();
    try {
      let state = manageSoundPlan(f.app, f.id, f.rev(), { action: "create", startFrame: 0, endFrame: 90, narrationDirection: "协议验证", musicDirection: "保持主声音", dominantRole: "narration", intents: [{ id: "discarded", function: "settle", brief: "已取消用声" }] });
      const plan = state.snapshot.soundPlans![0];
      const sound = { soundPlanId: plan.id, soundIntentId: "discarded", excludeSpeech: true, excludeMusic: true };
      state = f.app.manageAssetRequirement({ projectId: f.id, baseRevision: f.rev(), action: "create", title: "历史声音需求", purpose: "独立关闭合同回归", mediaKind: "audio", audioBrief: "旧候选", role: "sfx", sound });
      const original = structuredClone(state.snapshot.assetRequests[0]);
      manageSoundPlan(f.app, f.id, f.rev(), removal === "intent" ? { action: "update", soundPlanId: plan.id, intents: [] } : { action: "remove", soundPlanId: plan.id });
      const before = f.rev();
      assert.throws(() => f.app.manageAssetRequirement({ projectId: f.id, baseRevision: before, action: "update", assetRequestId: original.id, audioBrief: "仍在寻找声音" }), /有效段落意图/u);
      assert.throws(() => f.app.manageAssetRequirement({ projectId: f.id, baseRevision: before, action: "create", title: "不能创建的需求", purpose: "失效关联仍须拒绝", mediaKind: "audio", audioBrief: "候选", role: "sfx", sound }), /有效段落意图/u);
      assert.equal(f.rev(), before);
      state = f.app.manageAssetRequirement({ projectId: f.id, baseRevision: before, action: "close", assetRequestId: original.id, closeReason: "声音意图已取消，保留历史记录" });
      const closed = state.snapshot.assetRequests.find((entry) => entry.id === original.id)!;
      assert.equal(state.revision.number, before + 1);
      assert.equal(closed.status, "closed"); assert.equal(closed.closeReason, "声音意图已取消，保留历史记录");
      assert.deepEqual(closed.sound, original.sound); assert.equal(closed.audioBrief, original.audioBrief);
      assert.equal(closed.createdAt, original.createdAt); assert.equal(state.snapshot.audioCues.length, 0);
      assert.throws(() => f.app.manageAssetRequirement({ projectId: f.id, baseRevision: f.rev(), action: "update", assetRequestId: original.id, audioBrief: "不能重开" }), /已关闭/u);
      assert.equal(f.rev(), before + 1);
    } finally { await f.close(); }
  }
});

test("外部提交结果未知不重放 POST，有 run ID 的读取中断可恢复", async () => {
  const f = await fixture();
  try {
    const bridge = new ComfyUIBridgeClient("http://127.0.0.1:1"), schema = { id: "workflow", schemaVersion: "v1", name: "测试", available: true, fields: [], itemSlots: [], outputs: [] };
    let submissions = 0;
    bridge.createRunWithSchemaRetry = async (_id, build) => { submissions++; await build(schema); throw new BridgeError("模拟断线", undefined, undefined, "BRIDGE_UNAVAILABLE"); };
    const job = f.app.repository.createJob({ projectId: f.id, kind: "media_understanding", payload: {}, idempotencyKey: "unknown" });
    await assert.rejects(modelText(f.app, job, bridge, "window", "workflow", async () => ({ fieldValues: {} })), /结果未知/u);
    await assert.rejects(modelText(f.app, job, bridge, "window", "workflow", async () => ({ fieldValues: {} })), /不能重复/u);
    assert.equal(submissions, 1);
    const known = f.app.repository.createJob({ projectId: f.id, kind: "media_understanding", payload: {}, idempotencyKey: "known" });
    f.app.recordJobCheckpoint(known.id, { externalRuns: { window: { status: "running", workflowId: "workflow", schemaVersion: "v1", runId: "actual-run" } } });
    bridge.waitForRun = async (id) => { assert.equal(id, "actual-run"); return { id, status: "succeeded", outputs: [{ outputSlotId: "result", kind: "text", displayName: "结果", text: "实际响应" }] }; };
    assert.equal((await modelText(f.app, known, bridge, "window", "workflow", async () => ({ fieldValues: {} }))).text, "实际响应");
    assert.equal(submissions, 1);
    const cyclic = f.app.repository.createJob({ projectId: f.id, kind: "media_understanding", payload: {}, idempotencyKey: "cycle" });
    const cyclicRecord = { ...cyclic, payload: { retryOfJobId: cyclic.id } };
    const originalTrack = f.app.trackJob.bind(f.app);
    f.app.trackJob = (id) => id === cyclic.id ? cyclicRecord : originalTrack(id);
    assert.throws(() => restoreModelCheckpoints(f.app, cyclicRecord), /循环/u);
  } finally { await f.close(); }
});

test("ASR 多输出按槽读取，部分失败恢复补回独立观察且不重复 POST", async () => {
  const f = await fixture(true);
  try {
    const bridge = new ComfyUIBridgeClient(readRuntimeConfig().bridge.apiBaseUrl);
    const schema = (id: string): BridgeWorkflow => ({ id, schemaVersion: "fixture-v1", name: "协议测试", available: true, fields: ["prompt", "start_seconds", "duration_seconds"].map((id) => ({ id, label: id, kind: "text", required: false })), itemSlots: [{ id: "audio", kind: "audio", label: "声音", required: true }], outputs: [] });
    let posts = 0, interrupted = true;
    bridge.getWorkflow = async (id) => schema(id);
    bridge.createRunWithSchemaRetry = async (id, build) => { posts++; const workflow = schema(id), request = await build(workflow); return { workflow, request, schemaRetryCount: 0, run: { id, status: "queued", outputs: [] } }; };
    const aligned = JSON.stringify({ version: 4, precision: "provider_segment_timed", text: "协议转写", alignment: { tokenPrecision: "unavailable" }, segments: [{ displayText: "协议转写", startMs: 100, endMs: 900 }] });
    bridge.waitForRun = async (id) => {
      if (id.includes("funasr") && interrupted) throw new BridgeError("模拟读取中断", undefined, undefined, "BRIDGE_UNAVAILABLE");
      return { id, status: "succeeded", outputs: id.includes("funasr") ? [
        { outputSlotId: "transcript-text", kind: "text", displayName: "全文", text: "协议转写" },
        { outputSlotId: "caption-alignment-json", kind: "text", displayName: "时间", text: aligned }
      ] : [{ outputSlotId: "result", kind: "text", displayName: "观察", text: JSON.stringify({ facts: [{ modality: "audio", text: "协议测试音", startMs: 0, endMs: 1000 }] }) }] };
    };
    const job = await f.app.intelligence.submitAnalysis(f.id, { assetId: f.sound.id, depth: "review", modalities: ["audio", "speech"], range: { startMs: 0, endMs: 1000 }, context: "测试恢复协议，文本不代表测试音的真实语义" });
    await assert.rejects(runMediaUnderstanding(f.app, job, bridge, new AssetProviderRegistry()), /完成|失败/u);
    f.app.updateJob(job.id, { status: "failed", error: "模拟读取中断" });
    const before = f.app.intelligence.store.observations(f.id);
    assert.equal(before.length, 1); assert.ok(!before[0].speechEvidence);
    const retry = f.app.intelligence.retry(f.id, job.id);
    assert.equal(f.app.intelligence.retry(f.id, job.id).id, retry.id);
    interrupted = false;
    await runMediaUnderstanding(f.app, retry, bridge, new AssetProviderRegistry());
    const after = f.app.intelligence.store.observations(f.id);
    assert.equal(after.length, 2); assert.equal(posts, 2, "只恢复原来的两个 run");
    const recovered = after.find((entry) => entry.speechEvidence)!;
    assert.notEqual(recovered.id, before[0].id);
    assert.equal(recovered.speechEvidence!.rawText, aligned);
    assert.deepEqual(recovered.facts.find((entry) => entry.modality === "speech")!.range, { startMs: 100, endMs: 900 });
  } finally { await f.close(); }
});

test("原声观察不接收用途答案，语义无效的成功 Run 在显式重试中重新分析且保留原始证据", async () => {
  const f = await fixture(true);
  try {
    const bridge = new ComfyUIBridgeClient(readRuntimeConfig().bridge.apiBaseUrl);
    const schema = (id: string): BridgeWorkflow => ({ id, schemaVersion: "fixture-v1", name: "协议测试", available: true, fields: ["prompt", "start_seconds", "duration_seconds"].map((id) => ({ id, label: id, kind: "text", required: false })), itemSlots: [{ id: "audio", kind: "audio", label: "声音", required: true }], outputs: [] });
    const context = "需求答案：必须是翻纸、时长0.2至1.2秒。不可将这段话当原声。";
    const prompts: string[] = [];
    let posts = 0;
    bridge.getWorkflow = async (id) => schema(id);
    bridge.createRunWithSchemaRetry = async (id, build) => {
      const workflow = schema(id), request = await build(workflow);
      prompts.push(String(request.fieldValues.prompt));
      assert.equal(request.files?.[0].mime, "audio/wav");
      assert.equal((await probeMedia(request.files![0].path)).sampleRate, 16000);
      posts++;
      return { workflow, request, schemaRetryCount: 0, run: { id: `actual-run-${posts}`, status: "queued", outputs: [] } };
    };
    bridge.waitForRun = async (id) => ({ id, status: "succeeded", outputs: [{ outputSlotId: "result", kind: "text", displayName: "观察", text: id.endsWith("-1") ? "结构损坏，不能恢复成事实" : JSON.stringify({ facts: [{ modality: "audio", text: "协议测试的持续音", startMs: 0, endMs: 1000, speechPresence: "unknown", musicPresence: "unknown" }], unknowns: ["仅验证协议"] }) }] });
    const revision = f.rev();
    const job = await f.app.intelligence.submitAnalysis(f.id, { assetId: f.sound.id, depth: "index", modalities: ["audio"], context });
    await assert.rejects(runMediaUnderstanding(f.app, job, bridge, new AssetProviderRegistry()), /校验|完成/u);
    assert.equal(prompts[0].includes(context), false, "用途和标题不能进入原声观察提示");
    f.app.updateJob(job.id, { status: "failed", error: "结构无效" });
    const retry = f.app.intelligence.retry(f.id, job.id);
    await runMediaUnderstanding(f.app, retry, bridge, new AssetProviderRegistry());
    assert.equal(posts, 2, "明确解析失败后须取得新响应，不能复用坏原文");
    await runMediaUnderstanding(f.app, retry, bridge, new AssetProviderRegistry());
    assert.equal(posts, 2, "同一次重试恢复不会再次发送 POST");
    const observations = f.app.intelligence.store.observations(f.id);
    assert.equal(observations.length, 2);
    assert.equal(observations.find((entry) => entry.jobId === job.id)!.rawText, "结构损坏，不能恢复成事实");
    assert.equal(observations.find((entry) => entry.jobId === retry.id)!.facts[0].speechPresence, "unknown");
    assert.equal(f.rev(), revision);
  } finally { await f.close(); }
});

test("恢复旧版模型检查点不会把旧提示响应标成新版，已知运行必须先等结束", async () => {
  const f = await fixture();
  try {
    const bridge = new ComfyUIBridgeClient("http://127.0.0.1:1");
    const schema = { id: "workflow", schemaVersion: "v1", name: "版本恢复", available: true, fields: [], itemSlots: [], outputs: [] };
    let posts = 0, gets = 0;
    bridge.createRunWithSchemaRetry = async (_id, build) => { posts++; return { workflow: schema, request: await build(schema), schemaRetryCount: 0, run: { id: "new-run", status: "queued", outputs: [] } }; };
    bridge.waitForRun = async (id) => { gets++; return { id, status: "succeeded", outputs: [{ outputSlotId: "result", kind: "text", displayName: "结果", text: id === "old-run" ? "旧提示原文" : "新观察" }] }; };
    const parent = f.app.repository.createJob({ projectId: f.id, kind: "media_understanding", payload: {}, idempotencyKey: "old-running" });
    f.app.recordJobCheckpoint(parent.id, { externalRuns: { window: { status: "running", workflowId: "workflow", schemaVersion: "v1", runId: "old-run" } } });
    f.app.updateJob(parent.id, { status: "failed", error: "读取中断" });
    const resumed = f.app.intelligence.retry(f.id, parent.id);
    await assert.rejects(modelText(f.app, resumed, bridge, "window", "workflow", async () => ({ fieldValues: {} }), undefined, "blind-v4"), /旧版外部运行已完成/u);
    assert.equal(posts, 0); assert.equal(gets, 1);
    assert.equal((f.app.trackJob(resumed.id).result!.externalRuns as Record<string, { text: string }>).window.text, "旧提示原文");
    f.app.updateJob(resumed.id, { status: "failed", error: "需要新观察版本" });
    const next = f.app.intelligence.retry(f.id, resumed.id);
    assert.equal((await modelText(f.app, next, bridge, "window", "workflow", async () => ({ fieldValues: {} }), undefined, "blind-v4")).text, "新观察");
    assert.equal((await modelText(f.app, next, bridge, "window", "workflow", async () => ({ fieldValues: {} }), undefined, "blind-v4")).text, "新观察");
    assert.equal(posts, 1, "新版本只提交一次");
    assert.equal((f.app.trackJob(resumed.id).result!.externalRuns as Record<string, { text: string }>).window.text, "旧提示原文");
  } finally { await f.close(); }
});

test("角色音效的 Duck 实际参与混音，显式携带 design 可以关闭且保留计划关联", async () => {
  const f = await fixture();
  try {
    f.app.repository.commit(f.id, f.rev(), "模拟可听原声", (snapshot) => { snapshot.assets.find((entry) => entry.id === f.visual.id)!.metadata!.hasAudio = true; });
    let state = manageSoundPlan(f.app, f.id, f.rev(), { action: "create", startFrame: 0, endFrame: 90, narrationDirection: "保护原声", musicDirection: "保持主声音", dominantRole: "narration", intents: [{ id: "paper", function: "connection", brief: "测试角色退让" }] });
    const plan = state.snapshot.soundPlans![0];
    const design = { role: "sfx" as const, soundPlanId: plan.id, soundIntentId: "paper", planVersion: plan.version };
    state = f.add({ gainDb: -18, design });
    const cue = state.snapshot.audioCues[0];
    const volume = (currentState: typeof state) => {
      const current = currentState.snapshot.audioCues[0], item = currentState.snapshot.timeline.items.find((entry) => entry.id === current.timelineItemId)!;
      return audioCueVolumeAt(currentState.snapshot, item, currentState.snapshot.timeline.tracks.find((entry) => entry.id === item.trackId)!, current, 10);
    };
    assert.equal(cue.ducking?.enabled, true);
    assert.ok(Math.abs(20 * Math.log10(volume(state)) + 32) < 0.001, "-18 dB 基础增益在原声覆盖处再退让 14 dB");
    const before = f.rev();
    assert.throws(() => f.app.manageAudio({ projectId: f.id, baseRevision: before, action: "update", audioCueId: cue.id, ducking: { enabled: false } }), /Duck/u);
    assert.equal(f.rev(), before);
    state = f.app.manageAudio({ projectId: f.id, baseRevision: before, action: "update", audioCueId: cue.id, design: { role: "sfx" }, ducking: { enabled: false } });
    assert.equal(state.snapshot.audioCues[0].ducking?.enabled, false);
    assert.equal(state.snapshot.audioCues[0].soundPlanId, plan.id);
    assert.equal(state.snapshot.audioCues[0].soundIntentId, "paper");
    assert.equal(state.snapshot.audioCues[0].planVersion, plan.version);
    assert.equal(state.snapshot.audioCues[0].mixReview, "needs_review");
    assert.ok(Math.abs(20 * Math.log10(volume(state)) + 18) < 0.001);
  } finally { await f.close(); }
});

test("演示主导同时保护演示声并降低真实旁白，静音原声不触发音乐 Duck", async () => {
  const f = await fixture();
  try {
    const initial = f.add({ ducking: { enabled: true, reductionDb: -14 }, design: { role: "demonstration" } });
    const cue = initial.snapshot.audioCues[0], cueItem = initial.snapshot.timeline.items.find((entry) => entry.id === cue.timelineItemId)!;
    const snapshot = structuredClone(initial.snapshot), narrationTrack = snapshot.timeline.tracks.find((entry) => entry.name === "Dialogue")!;
    const narration = createTimelineItem({ trackId: narrationTrack.id, assetId: f.sound.id, startFrame: 0, endFrame: 90, sourceStartFrame: 0, sourceEndFrame: 90 });
    snapshot.timeline.items.push(narration);
    snapshot.soundPlans = [{ id: "plan", startFrame: 0, endFrame: 90, dominantRole: "demonstration", dominantRanges: [], intents: [], narrationDirection: "让操作声音被听清", musicDirection: "同步退让", version: 1, status: "current", updatedAt: "test" }];
    assert.ok(audioCueVolumeAt(snapshot, narration, narrationTrack, undefined, 20) < 0.21);
    assert.equal(audioCueVolumeAt(snapshot, cueItem, snapshot.timeline.tracks.find((entry) => entry.id === cueItem.trackId)!, cue, 10), Math.pow(10, cueItem.gainDb! / 20));
    snapshot.soundPlans[0].dominantRanges = [{ startFrame: 0, endFrame: 10, role: "narration", reason: "先讲完操作要求，再听实际声音" }];
    assert.equal(plannedVoiceVolumeAt(snapshot, narration, "narration", 5), 1);
    assert.ok(plannedVoiceVolumeAt(snapshot, narration, "narration", 20) < 0.21, "局部例外外仍采用段落默认主声音");
    snapshot.timeline.items.find((entry) => entry.id === cueItem.id)!.disabled = true;
    assert.equal(plannedVoiceVolumeAt(snapshot, narration, "narration", 20), 1, "主声音实际停用时不压低旁白");
    snapshot.soundPlans = []; snapshot.timeline.items = snapshot.timeline.items.filter((entry) => entry.id !== narration.id);
    snapshot.assets.find((entry) => entry.id === f.visual.id)!.metadata!.hasAudio = true;
    const sourceItem = snapshot.timeline.items.find((entry) => entry.assetId === f.visual.id)!;
    const music = { ...cue, role: "music" as const };
    const track = snapshot.timeline.tracks.find((entry) => entry.id === cueItem.trackId)!;
    assert.ok(audioCueVolumeAt(snapshot, cueItem, track, music, 10) < 0.11);
    sourceItem.mediaAudioPolicy = "mute";
    assert.equal(audioCueVolumeAt(snapshot, cueItem, track, music, 10), Math.pow(10, cueItem.gainDb! / 20));
  } finally { await f.close(); }
});

test("三种声画比较只渲染副本，正式预览固定文件哈希，旁白时序变化使审阅失效", { timeout: 120000 }, async () => {
  const f = await fixture(true);
  try {
    const state = f.add(), cue = state.snapshot.audioCues[0], before = f.rev();
    // 普通未关联需求不能误触发声音意图的原文件采用门禁。
    f.app.manageAssetRequirement({ projectId: f.id, baseRevision: f.rev(), action: "create", mediaKind: "audio", role: "sfx", title: "无关联声音需求", purpose: "验证独立对比不被无关需求阻断", audioBrief: "协议测试" });
    const revision = f.rev();
    const comparison = f.app.repository.createJob({ projectId: f.id, kind: "sound_comparison", idempotencyKey: "compare", payload: { revision, fromFrame: 0, toFrame: 90, replaceCueId: cue.id, alternatives: [-6, -12].map((gainDb) => ({ name: `${gainDb}dB`, assetId: f.sound.id, kind: "sfx", purpose: "技术比较", eventFrame: 12, onsetOffsetFrames: 2, sourceStartFrame: 0, sourceEndFrame: 30, gainDb, design: { role: "sfx" } })), includeWithout: true, dependencySignature: soundDependencySignature(f.app.readProject(f.id).snapshot) } });
    const result = await runSoundComparison(f.app, comparison);
    assert.equal(result.outputs.length, 3); assert.equal(f.rev(), revision);
    const peaks = result.outputs.slice(0, 2).map((output) => (output.audio as { truePeakDbfs: number }).truePeakDbfs);
    assert.ok(peaks[0] - peaks[1] > 5, `实际文件增益差应可测：${peaks}`);
    const preview = f.app.submitPreview({ projectId: f.id, revision, fromFrame: 0, toFrame: 90 });
    f.app.updateJob(preview.id, { status: "succeeded", result: await runPreviewJob(f.app, preview) });
    const exportJob = f.app.submitExport({ projectId: f.id, revision, purpose: "draft" });
    const artifact = await runExportJob(f.app, exportJob);
    assert.ok(artifact.path); assert.equal((await probeMedia(String(artifact.path))).hasAudio, true);
    const reviewed = await reviewSoundMix(f.app, f.id, { baseRevision: f.rev(), previewJobId: preview.id, outcome: "passed", method: "audiovisual", note: "这是模拟审阅协议的自动回归记录，不能当作人工实际听审或审美结论。" });
    assert.equal(reviewed.snapshot.audioCues[0].mixReview, "reviewed");
    assert.equal(evaluateQuality(reviewed.snapshot, reviewed.revision.number).issues.some((i) => i.code === "SOUND_MIX_REVIEW_REQUIRED"), false);
    f.app.repository.commit(f.id, f.rev(), "更改声音上下文", (snapshot) => { snapshot.timeline.items.find((i) => i.assetId === f.visual.id)!.gainDb = -12; });
    assert.equal(f.app.readProject(f.id).snapshot.audioCues[0].mixReview, "needs_review");
    await assert.rejects(reviewSoundMix(f.app, f.id, { baseRevision: f.rev(), previewJobId: preview.id, outcome: "passed", method: "audio", note: "旧预览不能确认新的时间线混合，模拟请求应当被拒绝。" }), /已改变/u);
    await writeFile(String(f.app.trackJob(preview.id).result!.path), "被替换的文件");
    await assert.rejects(reviewSoundMix(f.app, f.id, { baseRevision: f.rev(), previewJobId: preview.id, outcome: "passed", method: "audio", note: "文件已经发生变化，不能继续采用旧的审阅证据。" }), /文件已改变/u);
  } finally { await f.close(); }
});

test("真实迟入音轨派生保留 0.7 秒偏移，原声候选测量不自动确认", async () => {
  const f = await fixture(true);
  try {
    const path = join(f.root, "offset.mp4"), directory = join(f.root, "derived");
    await runProcess("ffmpeg", ["-hide_banner", "-y", "-i", join(f.app.readProject(f.id).snapshot.project.rootPath, f.visual.managedPath), "-itsoffset", "0.7", "-i", join(f.app.readProject(f.id).snapshot.project.rootPath, f.sound.managedPath), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-t", "3", path]);
    const source: MediaSource = { id: "offset", projectId: f.id, target: { assetId: f.visual.id }, hash: "fixture", identity: "original", path, kind: "video", hasAudio: true, durationMs: 3000, streams: [], createdAt: "test" };
    const evidence = await measureAudioWindow(source, { startMs: 0, endMs: 3000 }, directory);
    assert.ok(evidence.firstAudibleSample! / evidence.sampleRate > 0.65 && evidence.firstAudibleSample! / evidence.sampleRate < 0.75);
    assert.equal(evidence.reviewStatus, "unreviewed");
    const derived = await deriveMediaInput(source, directory, { startMs: 200, endMs: 2000 }, undefined, true);
    assert.equal(derived.mapping.offsetMs, 200);
    assert.equal((await probeMedia(derived.path)).durationMs, 1800);
  } finally { await f.close(); }
});

test("新版动作引擎隔离版本哈希，同时识别旧已冻结任务", () => {
  const work = motionSubmissionSchema.parse({ name: "测试", source: "export default function M(){return null}", width: 320, height: 180, fps: 30, durationInFrames: 30, });
  const legacy = motionHash(work, [], "managed-motion-3");
  assert.notEqual(motionHash(work), legacy); assert.equal(motionHashEngine(work, [], legacy), "managed-motion-3");
  assert.throws(() => motionHashEngine(work, [], legacy, "managed-motion-4"), /MISMATCH/u);
});

test("旧采用资格不影响源范围编辑，静音仍从实际时间线读取", async () => {
  const f = await fixture();
  try {
    const state = f.app.repository.commit(f.id, f.rev(), "历史资格与实际静音分离", snapshot => {
      snapshot.mediaAdoptions = [{ id: "old", assetId: f.visual.id, sourceHash: "old", observationIds: [], range: { startMs: 0, endMs: 10 }, purpose: "历史资料", audioPolicy: "mute", conditions: [], status: "needs_review", createdAt: "test" }];
      snapshot.timeline.items[0].mediaAudioPolicy = "mute";
    });
    const item = state.snapshot.timeline.items[0];
    assert.equal(resolveVideoSourceVolume(state.snapshot, item, state.snapshot.timeline.tracks.find(track => track.id === item.trackId)!), 0);
    assert.ok(!evaluateQuality(state.snapshot, state.revision.number).issues.some(entry => entry.code === "MEDIA_USAGE_REVIEW_REQUIRED"));
    const changed = f.app.repository.commit(f.id, f.rev(), "修改实际范围", snapshot => { snapshot.timeline.items[0].sourceStartFrame = 1; });
    assert.equal(changed.snapshot.mediaAdoptions![0].status, "needs_review");
    assert.ok(!evaluateQuality(changed.snapshot, changed.revision.number).issues.some(entry => entry.code === "MEDIA_USAGE_REVIEW_REQUIRED"));
  } finally { await f.close(); }
});
