import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { probeMedia, runProcess } from "@videocut/speech";
import { motionFixture } from "../tests/fixtures/managed-motion.js";
import puppeteer from "puppeteer-core";
import { resolveRenderBrowser } from "../packages/remotion-runtime/src/browser.js";

// 独立工作区中的合约夹具只验证制作链路；正弦音、合成画面和模拟确认不代表专业验收。
const repoRoot = resolve(import.meta.dirname, "..");
const baselineRoot = resolve(process.argv[2] ?? ".repair-validation/human-review-20260914/baseline-0.1.32");
const root = await mkdtemp(join(tmpdir(), "videocut-human-review-"));
const pluginRoot = join(root, "installation", "videoflowcut");
await cp(join(repoRoot, "plugins/videoflowcut"), pluginRoot, { recursive: true });
const workspaceRoot = join(root, "workspace");
const require = createRequire(import.meta.url);
const { ensureRuntime, findAvailablePort, stopRuntime } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const port = await findAvailablePort();
assert.notEqual(port, 3100);
const options = { pluginRoot, repoRoot, workspaceRoot, port, bridgeUrl: "http://127.0.0.1:18199" };
const seed = createApplication(workspaceRoot);
let projectId = "";
const expectedText = "套餐贵不代表适合你。";
try {
  projectId = seed.createProject({ name: "人工审片解耦候选技术夹具" }).snapshot.project.id;
  const rev = () => seed.readProject(projectId).revision.number;
  const projectPath = seed.readProject(projectId).snapshot.project.rootPath;
  seed.repository.commit(projectId, rev(), "设置隔离测试画布", snapshot => { Object.assign(snapshot.timeline, { width: 320, height: 320, fps: 24 }); });
  const authored = seed.applyAuthoredScript({ projectId, baseRevision: rev(), sourceNote: "技术夹具原稿，无真实朗读或审美声明", units: [{ text: expectedText, kind: "statement" }] });
  const video = join(projectPath, "assets/source/video.mp4");
  const voice = join(projectPath, "assets/speech/voice.wav");
  await mkdir(dirname(video), { recursive: true });
  await mkdir(dirname(voice), { recursive: true });
  await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x253958:s=320x320:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=3", voice]);
  const imported = seed.registerImportedAsset({ projectId, baseRevision: rev(), name: "技术背景", kind: "video", managedPath: "assets/source/video.mp4", sourceHash: createHash("sha256").update(await readFile(video)).digest("hex"), provenance: { source: "generated", acquiredAt: new Date().toISOString() } });
  seed.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(video) });
  seed.buildPresenterTimeline({ projectId, baseRevision: rev(), assetIds: [imported.asset.id] });
  const speech = seed.registerImportedAsset({ projectId, baseRevision: rev(), name: "技术正弦音", kind: "speech", managedPath: "assets/speech/voice.wav", sourceHash: createHash("sha256").update(await readFile(voice)).digest("hex"), provenance: { source: "generated", acquiredAt: new Date().toISOString() } });
  seed.applyMediaAnalysis({ projectId, assetId: speech.asset.id, metadata: await probeMedia(voice) });
  const segment = authored.snapshot.speechSegments[0]!;
  const segmentAsset = { id: "fixture-segment-asset", speechSegmentId: segment.id, voiceReferenceAssetId: speech.asset.id, assetId: speech.asset.id, durationMs: 3000, bridgeRunId: "fixture-tts", schemaVersion: "fixture", quality: "passed" as const };
  seed.applySpeechAssembly({ projectId, generatedAssets: [], segmentAssets: [segmentAsset], speechAsset: { id: "fixture-speech", assetId: speech.asset.id, scriptRevision: authored.snapshot.script.revision, segmentAssetIds: [segmentAsset.id], status: "ready", timing: { precision: "segment_exact", source: "技术夹具模拟配音元数据", segments: [{ speechSegmentId: segment.id, startMs: 0, endMs: 3000, startFrame: 0, endFrame: 72 }] } } });
  const snapshot = seed.readProject(projectId).snapshot;
  const item = snapshot.timeline.items.find(i => i.assetId === speech.asset.id)!;
  const time = new Date().toISOString();
  seed.completeSourceAudioCaptionAlignment({ projectId, requestedRevision: rev(), speechSource: { speechAssetId: "fixture-speech", scriptRevision: snapshot.script.revision, scriptText: expectedText }, assetId: speech.asset.id, timelineItemId: item.id, sourceStartFrame: 0, sourceEndFrame: 72, timelineStartFrame: 0, timelineEndFrame: 72, transcriptText: "套餐柜不代表适合你。", tokenPrecision: "unavailable", segments: [{ displayText: "套餐柜不代表适合你。", startMs: 0, endMs: 3000 }], bridgeAudit: { workflowId: "fixture-caption", runId: "fixture-caption", schemaVersion: "fixture", schemaRetryCount: 0, submittedAt: time, completedAt: time, request: { fieldValues: { fixtureOnly: true }, fileSlots: [] } } });
  for (const job of seed.listJobs(projectId)) seed.updateJob(job.id, { status: "succeeded" });
} finally { seed.close(); }

let client!: Client;
let transport!: StdioClientTransport;
async function connect(installation: string) {
  transport = new StdioClientTransport({ command: process.execPath, args: [join(installation, "scripts/mcp-launcher.mjs")], cwd: repoRoot, stderr: "pipe", env: { ...getDefaultEnvironment(), VIDEOFLOWCUT_REPO_ROOT: repoRoot, VIDEOCUT_WORKSPACE: workspaceRoot, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: options.bridgeUrl } });
  client = new Client({ name: "human-review-isolated-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client.listTools();
}
const callRaw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: { project_id: projectId, ...args } });
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const result = await callRaw(name, args);
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse((result.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")!.text!);
};
const waitJob = async (jobId: string) => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: jobId });
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise(done => setTimeout(done, 750));
  }
  throw new Error(`隔离候选 Job 超时 ${jobId}`);
};
const revision = async () => (await call("read_project")).revision.number;
const records: Record<string, unknown> = { root, port, scope: "独立技术夹具；模拟文本时间和人工确认，不代表真人审片" };
async function checkWorkbench(deliveryAllowed: boolean, screenshot: string) {
  const browser = await puppeteer.launch({ executablePath: await resolveRenderBrowser(), headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    // 工作台保持 SSE 连接；等待界面完成加载，不能等网络永远空闲。
    await page.goto(`http://127.0.0.1:${port}/?projectId=${projectId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="export-button"]');
    assert.equal(await page.$eval('[data-testid="export-button"]', el => (el as HTMLButtonElement).disabled), !deliveryAllowed);
    assert.equal(await page.$$eval('button', buttons => buttons.find(button => button.textContent?.trim() === "草稿导出")?.disabled), false);
    await page.screenshot({ path: join(root, screenshot) });
  } finally { await browser.close(); }
}
try {
  await ensureRuntime({ ...options, pluginRoot: baselineRoot });
  await connect(baselineRoot);
  const before = await call("read_project");
  const baselineRelease = await call("read_runtime_release");
  const oldQuality = await call("read_quality_report");
  assert.deepEqual(oldQuality.technical.filter((i: any) => i.level === "blocking"), [], JSON.stringify(oldQuality));
  const work = { ...motionFixture, reference: undefined, fps: 24, durationInFrames: 72, props: { text: "技术链路验证" } };
  const job = await call("submit_motion_work", { base_revision_id: before.revision.number, idempotency_key: "unreviewed-work", work });
  assert.equal((await waitJob(job.id)).status, "succeeded");
  const asset = (await call("read_motion_work", { job_id: job.id })).asset;
  assert.equal(asset.motion.review, undefined);
  const placement = { scene_id: before.snapshot.scenes[0].id, type: "ManagedMotion", layer: "front", start_frame: 0, end_frame: 72, semantic_anchor: { type: "scene", target_id: before.snapshot.scenes[0].id, relation: "hold_through" }, asset_bindings: [{ slot: "motion", asset_id: asset.id }] };
  const rejectedPlacement = await callRaw("manage_effect_cues", { ...placement, base_revision_id: await revision() });
  assert.equal(rejectedPlacement.isError, true);
  assert.match(JSON.stringify(rejectedPlacement.content), /审阅/);
  const captionId = before.snapshot.timeline.captions[0].id;
  const rejectedCaption = await callRaw("edit_captions", { base_revision_id: await revision(), caption_id: captionId, action: "update", text: expectedText });
  assert.equal(rejectedCaption.isError, true);
  assert.match(JSON.stringify(rejectedCaption.content), /回听/);
  const oldExport = await waitJob((await call("submit_export", { revision: await revision(), purpose: "delivery", idempotency_key: "baseline" })).id);
  assert.equal(oldExport.status, "failed");
  assert.match(JSON.stringify(oldExport), /审片|Editorial/);
  records.baseline = { release: baselineRelease, rejectedPlacement, rejectedCaption, export: oldExport };
  await client.close(); await transport.close();
  await ensureRuntime(options);
  const catalog = await connect(pluginRoot);
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.notEqual(release.mcpReleaseId, baselineRelease.mcpReleaseId);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  assert.match(JSON.stringify(catalog.tools.find(t => t.name === "edit_captions")!.inputSchema), /confirmed_script/);
  await call("manage_effect_cues", { ...placement, base_revision_id: await revision() });
  const corrected = await call("edit_captions", { base_revision_id: await revision(), caption_id: captionId, action: "update", text: expectedText, source_text_review: { basis: "confirmed_script", note: "夹具模拟按已确认原稿正字，不声称回听", scriptRevision: before.snapshot.script.revision, speechSegmentIds: [before.snapshot.speechSegments[0].id] } });
  const state = await call("read_project");
  assert.equal(state.snapshot.timeline.captions[0].sourceText, "套餐柜不代表适合你。");
  assert.deepEqual(state.snapshot.sourceAudioAlignments, before.snapshot.sourceAudioAlignments);
  assert.deepEqual(state.snapshot.speechAsset, before.snapshot.speechAsset);
  const quality = await call("read_quality_report");
  assert.equal(quality.editorial.status, "not_recorded");
  assert.equal(quality.exportReadiness.delivery.allowed, true, JSON.stringify(quality));
  assert.ok(quality.editorial.motion.some((i: any) => i.code === "MOTION_WORK_REVIEW_REQUIRED"));
  await checkWorkbench(true, "unreviewed-export-enabled.png");
  const preview = await waitJob((await call("render_preview_range", { revision: state.revision.number, from_frame: 0, to_frame: 72, idempotency_key: "complete" })).id);
  assert.equal(preview.status, "succeeded", JSON.stringify(preview));
  const run = await call("start_production_run", { loaded_skills: ["production-director"], base_revision_id: state.revision.number });
  for (const category of ["semantic", "story", "visual"]) await call("record_creative_decision", { run_id: run.id, category, decision: "技术夹具制作记录", rationale: "只验证记录与制作完成链路，不伪造创意子代理或观看" });
  const completed = await call("complete_production_run", { run_id: run.id, final_revision: state.revision.number });
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  assert.equal(completed.editorialReview, undefined);
  const exported = await waitJob((await call("submit_export", { revision: state.revision.number, purpose: "delivery", idempotency_key: "candidate" })).id);
  assert.equal(exported.status, "succeeded", JSON.stringify(exported));
  const artifact = await call("read_export_artifact", { artifact_id: exported.result.artifactId });
  assert.equal(artifact.approval, undefined);
  const file = join(state.snapshot.project.rootPath, artifact.relativePath);
  const metadata = await probeMedia(file);
  assert.ok(Math.abs(metadata.durationMs - 3000) < 100 && metadata.hasAudio);
  assert.deepEqual([metadata.width, metadata.height, metadata.fps], [320, 320, 24]);
  assert.equal((await stat(file)).size, artifact.fileSizeBytes);
  assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), artifact.fileHash);
  const noApproval = await callRaw("approve_export_artifact", { artifact_id: artifact.id });
  assert.equal(noApproval.isError, true);
  const approved = await call("approve_export_artifact", { artifact_id: artifact.id, file_hash: artifact.fileHash, confirmed_by_user: true, note: "仅模拟用户对指定文件的明确确认，不代表真人审美验收" });
  assert.equal(approved.approval.fileHash, artifact.fileHash);
  const updated = await call("edit_captions", { base_revision_id: await revision(), caption_id: captionId, action: "update", text: "套餐贵\n不代表适合你。" });
  assert.ok(updated.revision.number > artifact.revision);
  assert.equal((await call("read_export_artifact", { artifact_id: artifact.id })).revision, artifact.revision);
  const nextExport = await waitJob((await call("submit_export", { revision: await revision(), purpose: "delivery", idempotency_key: "edited" })).id);
  assert.equal(nextExport.status, "succeeded", JSON.stringify(nextExport));
  assert.equal((await call("read_export_artifact", { artifact_id: nextExport.result.artifactId })).approval, undefined);
  // 使用真实生成图片验证来源沿受管动效传播，并由相同 Worker 实际导出内部文件。
  const imagePath = join(root, "internal-only.png");
  await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=yellow:s=32x32", "-frames:v", "1", imagePath]);
  const imported = await call("import_media", { base_revision_id: await revision(), file_path: imagePath, provenance: { source: "generated", } });
  assert.equal((await waitJob(imported.job.id)).status, "succeeded");
  const scopedWork = { ...work, previousAssetId: asset.id, imageBindings: { test_image: imported.asset.id }, source: `import React from 'react'; import {AbsoluteFill,Img,useCurrentFrame} from 'remotion'; export default function Motion(props: {assets: {test_image:string}}) {const f=useCurrentFrame();return <AbsoluteFill><Img src={props.assets.test_image} style={{position:'absolute',left:20+f,top:20,width:32,height:32}} /></AbsoluteFill>;}` };
  const scopedJob = await call("submit_motion_work", { base_revision_id: await revision(), idempotency_key: "scoped-work", work: scopedWork });
  assert.equal((await waitJob(scopedJob.id)).status, "succeeded");
  const scopedAsset = (await call("read_motion_work", { job_id: scopedJob.id })).asset;
  assert.equal(scopedAsset.provenance.source, "generated");
  assert.deepEqual(scopedAsset.motion.sourceAssetIds, [imported.asset.id]);
  await call("manage_effect_cues", { action: "update", cue_id: state.snapshot.effectCues[0].id, base_revision_id: await revision(), asset_bindings: [{ slot: "motion", asset_id: scopedAsset.id }] });
  const scopedQuality = await call("read_quality_report");
  assert.equal(scopedQuality.exportReadiness.draft.allowed, true);
  assert.equal(scopedQuality.exportReadiness.delivery.allowed, true);
  await checkWorkbench(false, "internal-only-export.png");
  const preflights = [];
  for (const purpose of ["draft", "delivery"]) {
    const result = await waitJob((await call("run_render_preflight", { revision: await revision(), purpose, idempotency_key: "scoped" })).id);
    assert.equal(result.status, "succeeded");
    assert.equal(result.result.preflight.status, "passed");
    preflights.push(result);
  }
  const scopedExport = await waitJob((await call("submit_export", { revision: await revision(), purpose: "draft", idempotency_key: "scoped" })).id);
  assert.equal(scopedExport.status, "succeeded", JSON.stringify(scopedExport));
  assert.equal(scopedExport.kind, "export");
  assert.ok(scopedExport.result.artifactId);
  const deliveryExport = await waitJob((await call("submit_export", { revision: await revision(), purpose: "delivery", idempotency_key: "scoped" })).id);
  assert.equal(deliveryExport.status, "succeeded");
  assert.equal(deliveryExport.kind, "export");
  assert.ok(deliveryExport.result.artifactId);
  records.candidate = { release, correctedRevision: corrected.revision.number, quality, preview, completed, exported, metadata, artifact, approved, nextExport, scopedAsset, scopedQuality, preflights, scopedExport, deliveryExport };
  await writeFile(join(root, "report.json"), JSON.stringify({ verified: true, ...records }, null, 2));
  console.log(JSON.stringify({ verified: true, root, port, releaseId: release.mcpReleaseId, reportPath: join(root, "report.json") }));
} catch (error) {
  await writeFile(join(root, "failure.json"), JSON.stringify({ ...records, error: String(error) }, null, 2));
  console.error(`候选证据目录：${root}`);
  throw error;
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  await stopRuntime(options, { force: true });
}
