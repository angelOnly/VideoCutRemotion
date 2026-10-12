import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createApplication } from "@videocut/application";
import { createMediaAsset, createScene, createTimelineItem } from "@videocut/domain";
import { createDefaultAssetProviderRegistry } from "@videocut/acquisition";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import { probeMedia, runProcess } from "@videocut/speech";
import { readRuntimeConfig } from "@videocut/project-overview";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";
import { runExportJob, runPreviewJob } from "../apps/render-worker/src/exporter.js";
import { runSoundComparison } from "../apps/render-worker/src/sound-comparison.js";
import { manageSoundPlan } from "../packages/edit-application/src/sound-design.js";
import { soundDependencySignature } from "../packages/edit-application/src/sound-review.js";
import { hashMediaFile } from "../packages/edit-application/src/media-intelligence.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";

const presenter = process.argv[process.argv.indexOf("--presenter") + 1];
if (!process.argv.includes("--presenter")) throw new Error("提供已有、获准用于隔离测试的人物素材 --presenter");
const candidateRoot = resolve(".candidate/media-intelligence-20260908");
const output = process.argv.includes("--resume") ? resolve(process.argv[process.argv.indexOf("--resume") + 1]) : join(candidateRoot, `presenter-sound-${Date.now()}`);
const relativeOutput = relative(candidateRoot, output);
if (!relativeOutput || relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) throw new Error("只能恢复本轮独立候选目录");
await mkdir(output, { recursive: true });
const app = createApplication(join(output, "workspace"));
const reports: Record<string, unknown> = { ...JSON.parse(await readFile(join(output, "report.json"), "utf8").catch(() => "{}")), scope: "人物原声唯一 → 最新产品扇开 v2 全屏 → 返回人物的结构回归；沿用既有人物文案，未宣称产品文案适配、口型重生成或实际听审通过" };
delete reports.error;
try {
  const saved = app.listProjects()[0];
  let state = saved ? app.readProject(saved.id) : app.createProject({ name: "人物与产品扇开声音链路隔离验收", profile: "presenter_motion" });
  const id = state.snapshot.project.id, root = state.snapshot.project.rootPath, rev = () => app.readProject(id).revision.number;
  if (!state.snapshot.timeline.items.length) {
  await mkdir(join(root, "assets"), { recursive: true });
  await runProcess("ffmpeg", ["-hide_banner", "-y", "-i", resolve(presenter), "-t", "14", "-vf", "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:color=0x19232d,fps=30", "-c:v", "libx264", "-crf", "20", "-c:a", "aac", join(root, "assets/presenter.mp4")]);
  const actor = createMediaAsset({ name: "既有人物与原声（仅结构回归）", kind: "video", managedPath: "assets/presenter.mp4", role: "a_roll", sourceHash: await hashMediaFile(join(root, "assets/presenter.mp4")) });
  Object.assign(actor, { status: "ready", metadata: await probeMedia(join(root, actor.managedPath)) });
  const scene = createScene({ type: "PresenterScene", title: "人物→动效→人物", purpose: "原声所有权与连续混合技术验收", startFrame: 0, endFrame: 420 });
  state = app.repository.commit(id, rev(), "隔离人物骨架", (snapshot) => {
    Object.assign(snapshot.timeline, { width: 960, height: 540, fps: 30 });
    snapshot.assets.push(actor); snapshot.scenes.push(scene);
    snapshot.timeline.items.push(createTimelineItem({ trackId: snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll")!.id, sceneId: scene.id, assetId: actor.id, startFrame: 0, endFrame: 420, sourceStartFrame: 0, sourceEndFrame: 420 }));
  });
  }
  const scene = state.snapshot.scenes[0];
  const work = motionSubmissionSchema.parse(JSON.parse(await readFile(resolve(".candidate/media-intelligence-20260908/selected-cases/product-fan/motion/work.json"), "utf8")));
  const motionJob = app.submitManagedMotion({ projectId: id, baseRevision: rev(), idempotencyKey: "selected-product-fan-v2", work });
  let motionResult = motionJob.result;
  if (motionJob.status !== "succeeded") {
    app.updateJob(motionJob.id, { status: "running" });
    motionResult = await runMotionJob(app, motionJob); app.updateJob(motionJob.id, { status: "succeeded", result: motionResult });
  }
  const motionAsset = app.readProject(id).snapshot.assets.find((asset) => asset.id === motionResult!.assetId)!;
  if (!state.snapshot.effectCues.length) {
  await app.reviewManagedMotion({ projectId: id, baseRevision: rev(), assetId: motionAsset.id, outcome: "inconclusive", note: "已逐帧真实渲染并验证源时序，本脚本未进行人工连续观看和实际听审。" });
  state = app.createEffectCue({ projectId: id, baseRevision: rev(), sceneId: scene.id, type: "ManagedMotion", layer: "fullscreen", startFrame: 60, endFrame: 360, assetBindings: [{ slot: "motion", assetId: motionAsset.id }], narrativePurpose: "以最新固定案例验证连续动作与声音关系", audienceTask: "核查动作包络、层级和人物返回", note: "技术样片，保留真实文案；内容适配另审" });
  }
  const effect = state.snapshot.effectCues.at(-1)!;
  if (!state.snapshot.soundPlans?.length) state = manageSoundPlan(app, id, rev(), { action: "create", startFrame: 0, endFrame: 420, narrationDirection: "人物原声贯穿，保持唯一声音所有权", dominantRole: "source_speech", musicDirection: "同段音乐持续铺底，原声出现时退让", intents: [{ id: "fan", function: "connection", brief: "群体展开用完整运动包络" }, { id: "music", function: "music", brief: "稳定音乐支撑结构" }] });
  const plan = state.snapshot.soundPlans!.at(-1)!;
  const providers = createDefaultAssetProviderRegistry(), processor = createMediaJobProcessor(app, new ComfyUIBridgeClient(readRuntimeConfig().bridge.apiBaseUrl), providers);
  async function acquire(provider: string, query: string, role: "sfx" | "bgm") {
    const existing = app.readProject(id).snapshot.assets.find((asset) => asset.status === "ready" && asset.provenance?.provider === provider);
    if (existing) return existing;
    const created = app.manageAssetRequirement({ projectId: id, baseRevision: rev(), action: "create", title: `技术样片 ${query}`, purpose: "按需取得真实网络声音验证本地渲染，不构成实际听审", mediaKind: "audio", role, audioBrief: query, fallbackPlan: "ask_user", queryHints: [], excludedTerms: [] });
    const request = created.snapshot.assetRequests.at(-1)!;
    const candidates = await providers.get(provider).search({ request, query });
    const searched = app.recordAssetSearch({ projectId: id, baseRevision: rev(), assetRequestId: request.id, provider, query, candidates });
    const candidate = [...searched.candidates].filter((entry) => entry.hardFilterPassed).sort((a, b) => Number((b.durationMs ?? 0) >= 2500) - Number((a.durationMs ?? 0) >= 2500))[0];
    assert.ok(candidate, "需要可合法取得的候选");
    const acquired = app.acquireAssetCandidate({ projectId: id, baseRevision: rev(), assetCandidateId: candidate.id });
    await runOneJob(app, processor); await runOneJob(app, processor);
    const job = app.trackJob(acquired.job.id); assert.equal(job.status, "succeeded", job.error);
    const asset = app.readProject(id).snapshot.assets.find((entry) => entry.provenance?.originalAssetId === candidate.originalAssetId && entry.provenance?.provider === provider)!;
    assert.equal(asset.status, "ready");
    reports[role] = { asset, candidate, acquisition: job }; return asset;
  }
  const sweep = await acquire("mixkit", "whoosh", "sfx"), music = await acquire("mixkit_music", "minimalism", "bgm");
  if (!app.readProject(id).snapshot.audioCues.some((cue) => cue.kind === "bgm")) app.manageAudio({ projectId: id, baseRevision: rev(), action: "create", kind: "bgm", assetId: music.id, purpose: "真实在线音乐及人声 Duck 技术验证", startFrame: 0, endFrame: 420, sourceStartFrame: 0, sourceEndFrame: 420, gainDb: -20, fadeInFrames: 18, fadeOutFrames: 30, loop: false, ducking: { enabled: true, reductionDb: -12, attackFrames: 3, releaseFrames: 15, holdFrames: 6 }, design: { role: "music", soundPlanId: plan.id, soundIntentId: "music", planVersion: plan.version } });
  const event = motionAsset.motion!.eventMap!.events.find((entry) => entry.id === "fan")!;
  const duration = event.endFrame! - event.startFrame, available = Math.floor(sweep.metadata!.durationMs / 1000 * 30), loop = available < duration;
  if (!app.readProject(id).snapshot.audioCues.some((cue) => cue.soundIntentId === "fan")) app.manageAudio({ projectId: id, baseRevision: rev(), action: "create", kind: "sfx", assetId: sweep.id, purpose: "展开过程持续包络", eventFrame: effect.startFrame + event.startFrame, onsetOffsetFrames: 0, sourceStartFrame: 0, sourceEndFrame: Math.min(available, duration), gainDb: -10, fadeInFrames: 2, fadeOutFrames: 10, loop, onsetReview: { status: "inconclusive", note: "技术候选起点，尚未人工确认可听攻击与最终遮蔽；保留待审。" }, effectEvent: { effectCueId: effect.id, eventId: event.id, workVersion: motionAsset.motion!.version, eventName: event.meaning, localFrame: event.startFrame, endLocalFrame: event.endFrame }, design: { role: "sfx", soundPlanId: plan.id, soundIntentId: "fan", planVersion: plan.version, durationFrames: duration, loopCrossfadeFrames: loop ? 3 : 0, ...(loop ? { loopReview: { status: "inconclusive", note: "仅核验显式交叉淡化；真实循环接缝效果仍需实际复听。" } } : {}), envelope: [{ frame: 0, gainDb: -12 }, { frame: 18, gainDb: 0 }, { frame: duration, gainDb: -18 }] } });
  state = app.readProject(id);
  const cue = state.snapshot.audioCues.find((entry) => entry.soundIntentId === "fan")!;
  const preview = app.submitPreview({ projectId: id, revision: rev(), fromFrame: 0, toFrame: 420 });
  app.updateJob(preview.id, { status: "succeeded", result: await runPreviewJob(app, preview) });
  const comparison = app.repository.createJob({ projectId: id, kind: "sound_comparison", payload: { revision: rev(), fromFrame: 0, toFrame: 420, replaceCueId: cue.id, alternatives: [{ name: "较轻短起势", assetId: sweep.id, kind: "sfx", purpose: "同段比较一次起势与持续声音", eventFrame: cue.eventFrame, onsetOffsetFrames: 0, sourceStartFrame: 0, sourceEndFrame: Math.min(available, 24), gainDb: -18, design: { role: "sfx" } }], includeWithout: true, dependencySignature: soundDependencySignature(app.readProject(id).snapshot) }, idempotencyKey: "actual-alternatives" });
  app.updateJob(comparison.id, { status: "succeeded", result: await runSoundComparison(app, comparison) });
  // 案例原有权利为 unknown，保留门禁；本地审阅文件不能伪称正式 ExportArtifact。
  let artifact: Record<string, unknown> | undefined;
  try {
    const exported = app.submitExport({ projectId: id, revision: rev(), purpose: "draft" });
    artifact = await runExportJob(app, exported); app.updateJob(exported.id, { status: "succeeded", result: artifact });
  } catch (error) {
    if (!String(error).includes("尚未确认授权")) throw error;
    reports.exportGate = { status: "blocked_as_expected", error: String(error), reason: "最新案例的已存权利为 unknown，没有替换或伪造许可。独立合成测试另行验证正式 draft 导出链。" };
  }
  await copyFile(String(app.trackJob(preview.id).result!.path), join(output, "人物-动效-声音结构样片.mp4"));
  Object.assign(reports, { projectId: id, revision: rev(), work: { fixture: "product-fan v2", version: motionAsset.motion!.version, eventMap: motionAsset.motion!.eventMap }, preview: app.trackJob(preview.id), comparison: app.trackJob(comparison.id), artifact, snapshot: app.readProject(id).snapshot, review: "inconclusive", note: "技术验证不代表审美采用，未生成新的口型/文案；旁白原声仅一个视频音轨参与合成" });
  console.log(`可播放结构样片：${join(output, "人物-动效-声音结构样片.mp4")}`);
} catch (error) { reports.error = String(error); process.exitCode = 1; }
finally { await writeFile(join(output, "report.json"), JSON.stringify(reports, null, 2)); app.repository.close(); }
