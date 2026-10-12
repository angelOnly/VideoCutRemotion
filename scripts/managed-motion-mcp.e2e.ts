import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { createTimelineItem } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";
import { observedHighlight as motionFixture } from "../tests/fixtures/observed-highlight.js";

// 只验证发行物，所有测试项目与队列均在独立 mkdtemp 工作区。
const require = createRequire(import.meta.url);
const { findAvailablePort } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
const root = await mkdtemp(join(tmpdir(), "videocut-motion-mcp-"));
const repoRoot = resolve(import.meta.dirname, "..");
const pluginRoot = join(repoRoot, "plugins", "videoflowcut");
const port = await findAvailablePort();
const args = ["--repo-root", repoRoot, "--workspace", root, "--port", String(port), "--comfyui-bridge-url", "http://127.0.0.1:18199"];
const app = createApplication(root);
const state = app.createProject({ name: "在线动效发行候选", profile: "presenter_motion" });
const projectId = state.snapshot.project.id;
const projectRoot = state.snapshot.project.rootPath;
const backgroundPath = join(projectRoot, "assets", "candidate-background.mp4");
await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x23303d:s=320x320:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", backgroundPath]);
const asset = app.registerImportedAsset({ projectId, baseRevision: 1, name: "候选主画面（非正式素材）", kind: "video", managedPath: "assets/candidate-background.mp4" }).asset;
app.applyMediaAnalysis({ projectId, assetId: asset.id, metadata: await probeMedia(backgroundPath) });
// 技术 fixture 使用固定测试音，不声称它是自然语音或通过复听的用户素材。
const audioPath = join(projectRoot, "assets", "candidate-test-tone.wav");
await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000", "-af", "volume=0.05", audioPath]);
const speech = app.registerImportedAsset({ projectId, baseRevision: app.readProject(projectId).revision.number, name: "候选测试音（非语音）", kind: "speech", managedPath: "assets/candidate-test-tone.wav" }).asset;
app.applyMediaAnalysis({ projectId, assetId: speech.id, metadata: await probeMedia(audioPath) });
const sfx = app.registerImportedAsset({ projectId, baseRevision: app.readProject(projectId).revision.number, name: "候选音效测试音", kind: "audio", managedPath: "assets/candidate-test-tone.wav" }).asset;
app.applyMediaAnalysis({ projectId, assetId: sfx.id, metadata: await probeMedia(audioPath) });
app.repository.commit(projectId, app.readProject(projectId).revision.number, "设置候选画布与主画面", (snapshot) => {
  Object.assign(snapshot.timeline, { width: 320, height: 320, fps: 30, durationInFrames: 120 });
  snapshot.timeline.items.push(createTimelineItem({ trackId: snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll")!.id, assetId: asset.id, startFrame: 0, endFrame: 120, sourceStartFrame: 0, sourceEndFrame: 120 }));
  snapshot.speechSegments.push({ id: "candidate-segment", semanticUnitIds: [], text: "测试字幕", order: 0, pauseBefore: { durationMs: 0, reason: "sentence" }, status: "ready" });
  snapshot.script = { semanticUnitIds: [], speechSegmentIds: ["candidate-segment"], revision: 0 };
  snapshot.speechSegmentAssets.push({ id: "candidate-segment-asset", speechSegmentId: "candidate-segment", voiceReferenceAssetId: speech.id, assetId: speech.id, durationMs: 4_000, bridgeRunId: "fixture-not-provider", schemaVersion: "fixture-only", quality: "passed" });
  snapshot.speechAsset = { id: "candidate-speech", assetId: speech.id, scriptRevision: 0, segmentAssetIds: ["candidate-segment-asset"], timing: { precision: "segment_exact", source: "固定技术 fixture 非真实语音", segments: [{ speechSegmentId: "candidate-segment", startMs: 0, endMs: 4_000, startFrame: 0, endFrame: 120 }] }, status: "ready" };
  snapshot.timeline.items.push(createTimelineItem({ trackId: snapshot.timeline.tracks.find((track) => track.name === "Dialogue")!.id, assetId: speech.id, startFrame: 0, endFrame: 120, sourceStartFrame: 0, sourceEndFrame: 120 }));
  snapshot.timeline.captions.push({ id: "candidate-caption", speechSegmentId: "candidate-segment", text: "测试字幕", startFrame: 0, endFrame: 120, style: "stable", precision: "segment_exact" });
});
app.repository.close();
const runtime = await runCandidateRuntime("ensure", args);
console.log(JSON.stringify({ stage: "candidate_started", root, projectId, port, releaseId: runtime.releaseId }));
const spec = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.videoflowcut;
const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: pluginRoot, stderr: "pipe", env: { ...getDefaultEnvironment(), ...spec.env, VIDEOCUT_WORKSPACE: root, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: "http://127.0.0.1:18199" } });
transport.stderr?.on("data", (data) => process.stderr.write(data));
const client = new Client({ name: "managed-motion-release-test", version: "1.0.0" });
const call = async (name: string, input: Record<string, unknown> = {}): Promise<any> => {
  const result = await client.callTool({ name, arguments: input });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((item) => item.type === "text")!.text!);
};
const revision = async () => (await call("read_project", { project_id: projectId })).revision.number;
const rejected = async (input: Record<string, unknown>) => {
  const before = await revision();
  const result = await client.callTool({ name: "manage_effect_cues", arguments: { project_id: projectId, base_revision_id: before, ...input } });
  assert.equal(result.isError, true, `应拒绝无效局部编辑：${JSON.stringify(input)}`);
  assert.equal(await revision(), before, "失败不生成 Revision");
};
const waitJob = async (id: string) => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: id });
    if (job.status === "failed") throw new Error(JSON.stringify(job));
    if (job.status === "succeeded") return job;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`候选 Job 超时：${id}`);
};
// 解码真实合成视频的中心内容区；只作旧位置清理/新位置生效的技术验证，不作审美评分。
const centerLuma = async (job: any, frame: number, crop = "200:60:60:120") => {
  const output = await runProcess("ffmpeg", ["-hide_banner", "-v", "error", "-i", join(projectRoot, job.result.relativePath), "-vf", `select=eq(n\\,${frame}),trim=end_frame=1,crop=${crop},signalstats,metadata=print:file=-`, "-an", "-f", "null", "-"]);
  const value = /lavfi\.signalstats\.YAVG=([\d.]+)/u.exec(output)?.[1];
  assert.ok(value, "必须从实际视频解码取得像素证据");
  return Number(value);
};
// 只检验候选音效是否实际进入混音，不把测量响度称为听感或起音已确认。
const audioRangeRms = async (job: any, startSeconds: number) => {
  const output = await runProcess("ffmpeg", ["-v", "error", "-i", join(projectRoot, job.result.relativePath), "-vn", "-af", `atrim=start=${startSeconds}:end=${startSeconds + 0.1},astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, "-f", "null", "-"]);
  const value = [...output.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/gu)].at(-1)?.[1];
  assert.ok(value, "必须从真实合成音轨取得候选混音测量");
  return Number(value);
};
try {
  await client.connect(transport);
  const schema = await client.listTools();
  for (const tool of ["browse_motion_sources", "inspect_motion_reference", "submit_motion_work", "read_motion_work", "review_motion_work"]) assert.ok(schema.tools.some((item) => item.name === tool));
  const cueSchema = schema.tools.find((item) => item.name === "manage_effect_cues")!.inputSchema;
  assert.ok(cueSchema.properties?.action && cueSchema.properties?.cue_id && cueSchema.properties?.covered_narrative_beat_ids);
  const submitSchema = schema.tools.find(item => item.name === "submit_motion_work")!.inputSchema.properties!.work as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(submitSchema.properties.creativeBrief);
  assert.ok(!submitSchema.required?.includes("reference"));
  const reviewSchema = schema.tools.find(item => item.name === "review_motion_work")!.inputSchema;
  assert.ok(reviewSchema.properties?.outcome && reviewSchema.properties?.evidence);
  assert.ok(!reviewSchema.required?.includes("reference_match"));
  assert.deepEqual((cueSchema.properties.action as { enum: string[] }).enum, ["create", "update", "remove"]);
  assert.equal((cueSchema.properties.quality_rules as { items: { enum: string[] } }).items.enum.includes("caption_safe_area"), false);
  await rejected({ quality_rules: ["caption_safe_area"] });
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.equal((await call("browse_motion_sources")).sources.length, 4);
  const baseRevision = await revision();
  const job = await call("submit_motion_work", { project_id: projectId, base_revision_id: baseRevision, idempotency_key: "release-motion", work: { ...motionFixture, reference: undefined } });
  await waitJob(job.id);
  const work = await call("read_motion_work", { project_id: projectId, job_id: job.id });
  assert.ok(work.asset?.motion?.version);
  assert.equal(work.asset.motion.creativeBrief, motionFixture.creativeBrief);
  assert.equal(work.asset.motion.referenceUrl, undefined);
  const missingEvidence = await client.callTool({ name: "review_motion_work", arguments: { project_id: projectId, base_revision_id: await revision(), asset_id: work.asset.id, outcome: "passed", note: "技术测试故意缺少动态证据，必须拒绝，不能让成功渲染冒充实际通过。" } });
  assert.equal(missingEvidence.isError, true);
  assert.equal(Object.hasOwn(work.asset.motion, "visibility"), false, "新作品不采集退役的安全区测量");
  assert.ok((schema.tools.find((item) => item.name === "review_motion_work")!.inputSchema.properties!.outcome as { enum: string[] }).enum.includes("inconclusive"));
  assert.ok(schema.tools.find((item) => item.name === "manage_audio")!.inputSchema.properties!.onset_review);
  await call("review_motion_work", { project_id: projectId, base_revision_id: await revision(), asset_id: work.asset.id, outcome: "inconclusive", note: "固定候选 fixture 仅验证技术闭环，未作连续动态参考对照，不能标记审美通过。" });
  const scene = await call("create_scene", { project_id: projectId, base_revision_id: await revision(), type: "PresenterScene", title: "候选透明叠加", purpose: "验证局部帧与透明度", start_frame: 0, end_frame: 120 });
  const sceneId = scene.snapshot.scenes.at(-1).id;
  const coverageStory = await call("manage_story", { project_id: projectId, base_revision_id: await revision(), beats: [
    { title: "建立重点", purpose: "技术用覆盖第一拍", scene_ids: [sceneId] },
    { title: "稳定阅读", purpose: "技术用覆盖第二拍", scene_ids: [sceneId] }
  ] });
  const coveredBeats = coverageStory.snapshot.story.beats.map((beat: any) => beat.id);
  const created = await call("manage_effect_cues", { project_id: projectId, base_revision_id: await revision(), scene_id: sceneId, type: "ManagedMotion", layer: "front", start_frame: 20, end_frame: 80, covered_narrative_beat_ids: [...coveredBeats, coveredBeats[0]], asset_bindings: [{ slot: "motion", asset_id: work.asset.id }], semantic_anchor: { type: "absolute", relation: "land_on" }, quality_rules: ["semantic_anchor_required"] });
  const cueId = created.snapshot.effectCues.at(-1).id;
  assert.deepEqual(created.snapshot.effectCues.at(-1).coveredNarrativeBeatIds, coveredBeats);
  assert.equal(created.snapshot.effectCues.length, 1);
  await rejected({ action: "update", cue_id: cueId, covered_narrative_beat_ids: ["foreign-beat"] });
  const quality = await call("read_quality_report", { project_id: projectId });
  assert.ok(quality.issues.some((issue: any) => issue.code === "EFFECT_SEMANTIC_ANCHOR_REQUIRED"));
  assert.equal(quality.issues.some((issue: any) => issue.code === "EFFECT_RULE_CAPTION_SAFE_AREA"), false);
  await rejected({ action: "update", note: "缺 ID" });
  await rejected({ action: "update", cue_id: cueId });
  await rejected({ action: "update", cue_id: cueId, type: "EvidenceCard" });
  await rejected({ action: "update", cue_id: cueId, props: { text: "无效覆盖" } });
  await rejected({ action: "update", cue_id: cueId, end_frame: 81 });
  await rejected({ action: "remove", cue_id: cueId, note: "不可忽略的多余字段" });
  await rejected({ action: "remove", cue_id: "missing" });
  const updated = await call("manage_effect_cues", { project_id: projectId, base_revision_id: await revision(), action: "update", cue_id: cueId, semantic_anchor: { type: "scene", target_id: sceneId, relation: "land_on" } });
  assert.equal(updated.snapshot.effectCues.length, 1);
  assert.equal(updated.snapshot.effectCues[0].id, cueId);
  assert.deepEqual(updated.snapshot.effectCues[0].assetBindings, created.snapshot.effectCues[0].assetBindings);
  assert.equal((await call("read_quality_report", { project_id: projectId })).issues.some((issue: any) => issue.code === "EFFECT_SEMANTIC_ANCHOR_REQUIRED"), false);
  const withPendingSound = await call("manage_audio", { project_id: projectId, base_revision_id: await revision(), action: "create", kind: "sfx", asset_id: sfx.id, purpose: "仅以技术候选测试草稿声画合成，不声称听过", event_frame: 32, onset_offset_frames: 2, source_start_frame: 0, source_end_frame: 12, gain_db: -6, onset_review: { status: "inconclusive", note: "固定测试音的候选偏移，只验证草稿混合与事件跟随，尚未作实际听觉判断。" }, effect_event: { effect_cue_id: cueId, event_name: "候选揭示动作", local_frame: 12 } });
  const pendingSoundId = withPendingSound.snapshot.audioCues.at(-1).id;
  const pendingQuality = await call("read_quality_report", { project_id: projectId });
  for (const code of ["MOTION_WORK_REVIEW_REQUIRED", "SFX_ONSET_REVIEW_REQUIRED"]) {
    assert.ok(pendingQuality.issues.some((entry: any) => entry.code === code && entry.level === "blocking"));
    assert.equal(pendingQuality.technical.some((entry: any) => entry.code === code), false, "待审不是技术错误，不能挡住草稿");
  }
  await rejected({ action: "update", base_revision_id: created.revision.number, cue_id: cueId, note: "过期写入" });
  const preview = await call("render_preview_range", { project_id: projectId, revision: await revision(), from_frame: 0, to_frame: 120, idempotency_key: "release-preview" });
  const rendered = await waitJob(preview.id);
  const observedRevision = await revision();
  const pendingEvidence = await call("review_motion_work", { project_id: projectId, base_revision_id: observedRevision, asset_id: work.asset.id, outcome: "inconclusive", note: "真实候选媒体已生成，仅验证证据身份保存；尚未作连续视觉与听觉感知，不能声称审美通过。", evidence: { kind: "project_preview", previewJobId: preview.id, startFrame: 20, endFrame: 80, method: "frames" } });
  const recordedReview = pendingEvidence.snapshot.assets.find((entry: any) => entry.id === work.asset.id).motion.review;
  assert.equal(recordedReview.version, work.asset.motion.version);
  assert.equal(recordedReview.evidence.revision, observedRevision);
  assert.match(recordedReview.evidence.contentHash, /^[a-f0-9]{64}$/u);
  const reread = await call("read_motion_work", { project_id: projectId, job_id: job.id });
  assert.deepEqual(reread.asset.motion.review, recordedReview);
  const moved = await call("manage_effect_cues", { project_id: projectId, base_revision_id: await revision(), action: "update", cue_id: cueId, start_frame: 60, end_frame: 120 });
  assert.equal(moved.snapshot.effectCues[0].id, cueId);
  for (const range of [[20, 80], [60, 120]]) assert.ok(moved.revision.impact.dirtyRanges.some((dirty: any) => dirty.startFrame <= range[0] && dirty.endFrame >= range[1]));
  const movedPreview = await waitJob((await call("render_preview_range", { project_id: projectId, revision: await revision(), from_frame: 0, to_frame: 120, idempotency_key: "release-preview-moved" })).id);
  const pixels = { before40: await centerLuma(rendered, 40), before100: await centerLuma(rendered, 100), moved40: await centerLuma(movedPreview, 40), moved100: await centerLuma(movedPreview, 100) };
  assert.ok(pixels.before40 - pixels.moved40 > 10, "移走后旧位置应实际消失");
  assert.ok(pixels.moved100 - pixels.before100 > 10, "新位置应实际显示同一作品");
  const pendingAudioPixels = { before: await audioRangeRms(rendered, 1.1), moved: await audioRangeRms(movedPreview, 1.1) };
  assert.ok(pendingAudioPixels.before - pendingAudioPixels.moved > 1, "待审音效必须实际进入原落点混音，并在随动后从原位置移走");
  const exported = await call("submit_export", { project_id: projectId, revision: await revision(), purpose: "draft", idempotency_key: "release-draft" });
  const artifact = await waitJob(exported.id);
  const delivery = await call("submit_export", { project_id: projectId, revision: await revision(), purpose: "delivery", idempotency_key: "pending-must-not-deliver" });
  let rejectedDelivery: any;
  for (let attempt = 0; attempt < 80; attempt++) {
    rejectedDelivery = await call("track_job", { job_id: delivery.id });
    if (["succeeded", "failed"].includes(rejectedDelivery.status)) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.equal(rejectedDelivery.status, "failed", "草稿生成成功不能使待审作品获得delivery");
  assert.equal((await call("read_project", { project_id: projectId })).snapshot.audioCues.find((entry: any) => entry.id === pendingSoundId).onsetReview.status, "inconclusive");
  const removed = await call("manage_effect_cues", { project_id: projectId, base_revision_id: await revision(), action: "remove", cue_id: cueId });
  assert.equal(removed.snapshot.effectCues.length, 0);
  assert.ok(removed.snapshot.assets.some((asset: any) => asset.id === work.asset.id));
  const removedPreview = await waitJob((await call("render_preview_range", { project_id: projectId, revision: await revision(), from_frame: 0, to_frame: 120, idempotency_key: "release-preview-removed" })).id);
  assert.ok(Math.abs(await centerLuma(removedPreview, 100) - pixels.before100) < 2, "移除后真实合成恢复主画面，资产仍保留");
  // 全屏 RGB → RGBA → 透明 → RGB 的真实发行链，不能要求创作者保留残影才能通过测量。
  const alphaJob = await call("submit_motion_work", { project_id: projectId, base_revision_id: await revision(), idempotency_key: "release-alpha-transition", work: {
    ...motionFixture, name: "透明退出技术回归（非创作样片）", durationInFrames: 8,
    source: `import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(){return <div style={{position:'absolute',inset:0,background:'#ffffff',opacity:[1,0.5,0,1,1,0.5,0.01,0][useCurrentFrame()]}}/>;}`,
    reference: { ...motionFixture.reference, observation: {
      layout: "全幅白色矩形，用于检查不同 PNG 颜色类型切换；不是视觉选型。",
      motion: "固定八帧在不透明、半透明、全透明状态间切换，不复制在线作品。",
      rhythm: "离散技术 fixture，用来逐帧验证透明效果与合成，不代表专业剪辑节奏。",
      adaptation: "只验证已发布能力，不作为用户视频的创作或参考对照结论。",
      evidence: "结果以候选 Worker 的真实 PNG 和合成视频像素为依据。"
    } }
  } });
  await waitJob(alphaJob.id);
  const alphaWork = await call("read_motion_work", { project_id: projectId, job_id: alphaJob.id });
  assert.equal(Object.hasOwn(alphaWork.asset.motion, "visibility"), false);
  await call("review_motion_work", { project_id: projectId, base_revision_id: await revision(), asset_id: alphaWork.asset.id, outcome: "inconclusive", note: "隔离技术 fixture 只验证透明帧和真实合成，不代表用户审美或参考匹配通过。" });
  await call("manage_effect_cues", { project_id: projectId, base_revision_id: await revision(), scene_id: sceneId, type: "ManagedMotion", layer: "front", start_frame: 20, end_frame: 28, asset_bindings: [{ slot: "motion", asset_id: alphaWork.asset.id }], semantic_anchor: { type: "scene", target_id: sceneId, relation: "land_on" } });
  const alphaPreview = await waitJob((await call("render_preview_range", { project_id: projectId, revision: await revision(), from_frame: 0, to_frame: 40, idempotency_key: "release-alpha-preview" })).id);
  const alphaPixels = { opaque: await centerLuma(alphaPreview, 20), middleClear: await centerLuma(alphaPreview, 22), lastClear: await centerLuma(alphaPreview, 27), after: await centerLuma(alphaPreview, 28) };
  assert.ok(alphaPixels.opaque - alphaPixels.after > 100, "不透明帧必须真实覆盖底层");
  assert.ok(Math.abs(alphaPixels.middleClear - alphaPixels.after) < 2 && Math.abs(alphaPixels.lastClear - alphaPixels.after) < 2, "中间与末尾完全透明帧必须露出底层，不能出现审阅代理背景或残影");
  // 在同一候选中复现：新透明作品下面仍有旧 Comparison。全部修改只通过发行版 MCP。
  const alphaCueId = (await call("read_project", { project_id: projectId })).snapshot.effectCues[0].id;
  await call("manage_effect_cues", { project_id: projectId, base_revision_id: await revision(), action: "remove", cue_id: alphaCueId });
  const story = await call("manage_story", { project_id: projectId, base_revision_id: await revision(), title: "局部主视觉技术回归", summary: "非正式视频，不评价审美。", beats: [{ title: "比较", purpose: "验证透明退出的底层归属" }] });
  const narrative = await call("manage_narrative_map", { project_id: projectId, base_revision_id: await revision(), viewer_question: "旧主视觉是否真正退出？", promised_model: "局部启停不影响其它对象", conclusion: "回到底层", beats: [{ narrative_beat_id: story.snapshot.story.beats[0].id, entering_knowledge: "已有主画面", question: "透明后显示什么？", new_knowledge: "确认渲染归属", deferred_information: "无" }] });
  const compiled = await call("compile_explainer_scenes", { project_id: projectId, base_revision_id: await revision(), plans: [{ title: "旧主视觉", purpose: "复现旧内容被遮盖的底层", start_frame: 20, end_frame: 28, narrative_map_beat_id: narrative.snapshot.narrativeMap.beats[0].id, kind: "Comparison", primary_task: "旧视觉退出验证", props: { leftLabel: "旧", rightLabel: "新", dimension: "渲染归属" }, states: [
    { phase: "entry", start_frame: 0, end_frame: 2, label: "进入" }, { phase: "progressive", start_frame: 2, end_frame: 4, label: "变化" },
    { phase: "settled", start_frame: 4, end_frame: 6, label: "停稳" }, { phase: "exit", start_frame: 6, end_frame: 8, label: "退出" }
  ] }] });
  const program = compiled.snapshot.explainerPrograms[0];
  await call("manage_effect_cues", { project_id: projectId, base_revision_id: await revision(), scene_id: program.sceneId, type: "ManagedMotion", layer: "fullscreen", start_frame: 20, end_frame: 28, asset_bindings: [{ slot: "motion", asset_id: alphaWork.asset.id }], semantic_anchor: { type: "scene", target_id: program.sceneId, relation: "land_on" } });
  await call("manage_audio", { project_id: projectId, base_revision_id: await revision(), action: "create", kind: "sfx", asset_id: sfx.id, purpose: "技术测试音效，非试听结论", event_frame: 24, onset_offset_frames: 0, source_start_frame: 0, source_end_frame: 4, gain_db: -12 });
  const withOld = await call("read_project", { project_id: projectId });
  const localPreview = async (key: string) => waitJob((await call("render_preview_range", { project_id: projectId, revision: await revision(), from_frame: 0, to_frame: 40, idempotency_key: key })).id);
  const oldPreview = await localPreview("release-old-program");
  const toggle = schema.tools.find((item) => item.name === "set_explainer_program_enabled");
  assert.ok(toggle?.inputSchema.properties?.program_id && toggle.inputSchema.properties?.enabled);
  const disabled = await call("set_explainer_program_enabled", { project_id: projectId, base_revision_id: await revision(), program_id: program.id, enabled: false });
  for (const key of ["scenes", "story", "narrativeMap", "effectCues", "timeline", "audioCues", "sourceCaptionPrograms", "assets"]) assert.deepEqual(disabled.snapshot[key], withOld.snapshot[key], `${key} 必须原样保留`);
  const disabledPreview = await localPreview("release-disabled-program");
  const enabled = await call("set_explainer_program_enabled", { project_id: projectId, base_revision_id: await revision(), program_id: program.id, enabled: true });
  assert.equal(enabled.snapshot.explainerPrograms[0].disabled, false);
  const enabledPreview = await localPreview("release-reenabled-program");
  // 采样旧标题实际所在区域；角落背景可能恰好与底层同色，不能用它代表旧内容是否消失。
  const comparisonTextArea = "240:40:40:70";
  const programPixels = { oldClear: await centerLuma(oldPreview, 27, comparisonTextArea), disabledClear: await centerLuma(disabledPreview, 27, comparisonTextArea), after: await centerLuma(disabledPreview, 28, comparisonTextArea), restoredClear: await centerLuma(enabledPreview, 27, comparisonTextArea) };
  assert.ok(Math.abs(programPixels.oldClear - programPixels.disabledClear) > 5, "必须真实复现旧底层与停用后的像素差异");
  assert.ok(Math.abs(programPixels.disabledClear - programPixels.after) < 2, "透明退出必须直接露出主画面");
  assert.ok(Math.abs(programPixels.restoredClear - programPixels.oldClear) < 2, "重新启用应恢复旧主视觉");
  const audioHash = (previewJob: any) => runProcess("ffmpeg", ["-v", "error", "-i", join(projectRoot, previewJob.result.relativePath), "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "hash", "-hash", "sha256", "-"]);
  assert.equal(await audioHash(oldPreview), await audioHash(disabledPreview), "停用纯视觉前后实际解码的对白与音效必须不变");
  const programToggle = { programId: program.id, oldPreview, disabledPreview, enabledPreview, programPixels, decodedAudioUnchanged: true };
  const report = { verified: true, root, projectId, port, release, rendered, movedPreview, removedPreview, pixels, pendingAudioPixels, pendingQuality, rejectedDelivery, artifact, asset: work.asset, alphaPreview, alphaPixels, programToggle, webUrl: `http://127.0.0.1:${port}/?project=${projectId}` };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verified: true, root, projectId, port, releaseId: runtime.releaseId, reportPath: join(root, "report.json"), artifact: artifact.result, scope: "技术链路，非真实创作或声画审美验收" }));
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  // --keep 仅保留本次候选服务供 Web 审阅；不改变生产状态。
  if (!process.argv.includes("--keep")) await runCandidateRuntime("stop", args);
}
