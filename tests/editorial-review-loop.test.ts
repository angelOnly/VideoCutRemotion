import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { canExport, evaluateQuality } from "@videocut/quality";
import { DomainError } from "@videocut/domain";
import { runProcess } from "@videocut/speech";
import type { EditorialReviewObservation, EditorialReviewPass } from "@videocut/contracts";
import { openEditorialFindings, productionReconciliation } from "../packages/quality-system/src/editorial-review.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const passes: EditorialReviewPass[] = ["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"];

test("并发追加不会丢失问题，损坏审计不得静默放行", async () => {
  const f = await fixture();
  try {
    await Promise.all([0, 1].map((index) => f.app.recordEditorialQualityReview({ ...f.base, passes: ["mute_visual"], previewEvidence: ["观察"], findings: [{ pass: "mute_visual", category: "motion", severity: "major", summary: `问题 ${index}`, impact: "损害观看", evidence: "回归输入" }] })));
    const review = await f.app.readEditorialQualityReview(f.base);
    assert.equal(review!.findings.length, 2);
    assert.equal(new Set(evaluateQuality(f.state.snapshot, f.base.revision, review).editorial.motion.map((entry) => entry.id)).size, 2, "同类别不同问题保持独立身份");
    await writeFile(join(f.state.snapshot.project.rootPath, "reports", `production-run-${f.run.id}.json`), "corrupted");
    await assert.rejects(() => f.app.readEditorialQualityReview(f.base), (error: unknown) => error instanceof DomainError && error.code === "EDITORIAL_REVIEW_READ_FAILED");
  } finally { await f.dispose(); }
});

test("真实 MCP Schema 支持阶段审片并把结构化证据和对账返回主流程", async () => {
  const f = await fixture();
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(), env: { ...environment, VIDEOCUT_WORKSPACE: f.root }, stderr: "pipe" });
  const client = new Client({ name: "editorial-loop-regression", version: "1.0.0" });
  try {
    const preview = await f.preview();
    await client.connect(transport);
    const schema = (await client.listTools()).tools.find((tool) => tool.name === "record_editorial_quality_review")!.inputSchema;
    assert.ok(schema.properties?.observations && schema.properties?.resolutions);
    const recorded = await client.callTool({ name: "record_editorial_quality_review", arguments: { project_id: f.projectId, run_id: f.run.id, revision: f.base.revision, passes: ["mute_visual"], findings: [], observations: [{ pass: "mute_visual", preview_job_id: preview.id, start_frame: 5, end_frame: 12, method: "continuous_video", observation: "MCP 回归模拟观察声明" }] } });
    assert.ok(!recorded.isError, JSON.stringify(recorded));
    const quality = await client.callTool({ name: "read_quality_report", arguments: { project_id: f.projectId } });
    assert.ok(!quality.isError);
    const content = quality.content as Array<{ type: string; text?: string }>;
    const report = JSON.parse(content.find((entry) => entry.type === "text")!.text!);
    assert.equal(report.editorial.status, "partial");
    assert.equal(report.editorial.coverage.length, 5);
    assert.ok(Array.isArray(report.productionReconciliation));
    assert.equal(f.app.readProject(f.projectId).revision.number, f.base.revision);
  } finally { await transport.close(); await f.dispose(); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editorial-evidence-"));
  const app = createApplication(root);
  const created = app.createProject({ name: "结构化审片测试" });
  const projectId = created.snapshot.project.id;
  const imported = app.registerImportedAsset({ projectId, baseRevision: created.revision.number, name: "source.mp4", kind: "video", managedPath: "assets/source/source.mp4", sourceHash: "fixture", provenance: { source: "local_import", acquiredAt: new Date().toISOString() } });
  app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: { durationMs: 2_000, hasAudio: true, width: 64, height: 64, fps: 24, videoCodec: "h264", audioCodec: "aac" } });
  const state = app.buildPresenterTimeline({ projectId, baseRevision: app.readProject(projectId).revision.number, assetIds: [imported.asset.id] });
  const previewRoot = join(created.snapshot.project.rootPath, "previews");
  await mkdir(previewRoot, { recursive: true });
  const source = join(root, "sound.mp4");
  await runProcess("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000:duration=2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", source]);
  const run = await app.startProductionRun({ projectId, loadedSkills: ["quality-verification"] });
  async function preview(revision = state.revision.number, from = 0, to = 48, silent = false) {
    const job = app.submitPreview({ projectId, revision, fromFrame: from, toFrame: to, idempotencyKey: `${revision}:${from}:${to}:${silent}` });
    const path = join(previewRoot, `${job.id}.mp4`);
    if (from === 0 && to === 48 && !silent) await copyFile(source, path);
    else await runProcess("ffmpeg", ["-y", "-i", source, "-ss", String(from / 24), "-t", String((to - from) / 24), ...(silent ? ["-an"] : []), "-c:v", "mpeg4", path]);
    app.updateJob(job.id, { status: "succeeded", result: { revision, fromFrame: from, toFrame: to, path } });
    return { ...job, path };
  }
  const base = { projectId, runId: run.id, revision: state.revision.number, previewEvidence: [], findings: [] };
  const observe = (previewJobId: string, startFrame = 0, endFrame = 48, selected = passes): EditorialReviewObservation[] => selected.map((pass) => ({ pass, previewJobId, startFrame, endFrame, method: pass === "audio_only" ? "audio" : pass === "mute_visual" ? "continuous_video" : "audiovisual", observation: "测试观察声明，不代表真人或模型实际审美判断" }));
  return { root, app, projectId, state, run, base, preview, observe, dispose: async () => { app.close(); await rm(root, { recursive: true, force: true }); } };
}

test("字幕文字单帧复核只关闭对应文字问题，不关闭动态也不补全连续覆盖", async () => {
  const f = await fixture();
  try {
    const state = f.app.repository.commit(f.projectId, f.base.revision, "测试字幕", (snapshot) => {
      snapshot.speechSegments.push({ id: "static-speech-test", text: "情况", semanticUnitIds: [], scriptRevision: 0, order: 0 } as any);
      snapshot.timeline.captions.push({ speechSegmentId: "static-speech-test", id: "caption-static-test", startFrame: 5, endFrame: 20, text: "情况" } as any);
    });
    const base = { ...f.base, revision: state.revision.number, passes: ["mute_visual"] as EditorialReviewPass[] };
    const finding = { pass: "mute_visual" as const, severity: "major" as const, category: "semantic" as const, summary: "显示错字", evidence: "测试观察", impact: "影响字义", objectId: "caption-static-test", frameRange: { startFrame: 6, endFrame: 7 } };
    const first = await f.app.recordEditorialQualityReview({ ...base, previewEvidence: ["发现文字及动态问题"], findings: [finding, { ...finding, category: "motion", summary: "换卡闪烁" }] });
    const ids = first.editorialReview!.findings.map((entry) => entry.id);
    const next = f.app.updateStory({ projectId: f.projectId, baseRevision: base.revision, title: "新版" });
    base.revision = next.revision.number;
    const preview = await f.preview(base.revision);
    const checked = await f.app.recordEditorialQualityReview({ ...base, observations: [{ pass: "mute_visual", previewJobId: preview.id, startFrame: 6, endFrame: 7, method: "frames", observation: "只看到该帧文字正确" }] });
    const evidenceIds = [checked.editorialReview!.evidenceRecords!.at(-1)!.id];
    const resolve = (findingId: string, scope?: "caption_text") => f.app.recordEditorialQualityReview({ ...base, resolutions: [{ findingId, evidenceIds, note: "仅字面显示复核", scope }] });
    await assert.rejects(resolve(ids[0]), /连续证据/u);
    await assert.rejects(resolve(ids[1], "caption_text"), /不能关闭声音或运动/u);
    // 已结束的旧Run保持不可追加；新Run可引用仍有效的旧Run当前版本证据。
    checked.status = "completed";
    await writeFile(join(f.state.snapshot.project.rootPath, "reports", `production-run-${base.runId}.json`), JSON.stringify(checked));
    await assert.rejects(resolve(ids[0], "caption_text"), /已结束/u);
    const followup = await f.app.startProductionRun({ projectId: f.projectId, loadedSkills: ["quality-verification"] });
    base.runId = followup.id;
    await resolve(ids[0], "caption_text");
    const review = await f.app.readEditorialQualityReview(base);
    assert.deepEqual(openEditorialFindings(review).map((entry) => entry.id), [ids[1]]);
    assert.equal(evaluateQuality(next.snapshot, base.revision, review).editorial.coverage!.find((entry) => entry.pass === "mute_visual")!.complete, false);
    await writeFile(preview.path, "替换证据");
    assert.equal(openEditorialFindings(await f.app.readEditorialQualityReview(base)).length, 2);
  } finally { await f.dispose(); }
});

test("局部和抽帧证据不等于全片，逐阶段累积并保留真实哈希", async () => {
  const f = await fixture();
  try {
    const local = await f.preview(f.base.revision, 0, 24);
    await f.app.recordEditorialQualityReview({ ...f.base, passes: ["mute_visual"], observations: [{ ...f.observe(local.id, 0, 24, ["mute_visual"])[0]!, method: "frames" }] });
    let review = await f.app.readEditorialQualityReview(f.base);
    assert.equal(evaluateQuality(f.state.snapshot, f.base.revision, review).editorial.coverage!.find((entry) => entry.pass === "mute_visual")!.complete, false);
    await f.app.recordEditorialQualityReview({ ...f.base, passes, observations: f.observe(local.id, 0, 24) });
    review = await f.app.readEditorialQualityReview(f.base);
    let quality = evaluateQuality(f.state.snapshot, f.base.revision, review);
    assert.equal(quality.editorial.status, "partial");
    assert.equal(canExport(quality, "delivery"), true, "未审完不阻挡生成文件");
    assert.equal(canExport(quality, "draft"), true, "未审片仍允许草稿迭代");
    assert.match(review!.evidenceRecords![0]!.contentHash, /^[a-f0-9]{64}$/);
    const tail = await f.preview(f.base.revision, 24, 48);
    await f.app.recordEditorialQualityReview({ ...f.base, passes, observations: f.observe(tail.id, 24, 48) });
    review = await f.app.readEditorialQualityReview(f.base);
    quality = evaluateQuality(f.state.snapshot, f.base.revision, review);
    assert.deepEqual(quality.editorial.coverage!.filter((entry) => !entry.complete).map((entry) => entry.pass), ["first_viewer"], "首次观众不能用两个片段拼出全片体验");
    const full = await f.preview();
    await f.app.recordEditorialQualityReview({ ...f.base, passes: ["first_viewer"], observations: f.observe(full.id, 0, 48, ["first_viewer"]) });
    review = await f.app.readEditorialQualityReview(f.base);
    quality = evaluateQuality(f.state.snapshot, f.base.revision, review);
    assert.equal(quality.editorial.status, "reviewed");
    assert.equal(canExport(quality, "delivery"), true);
    assert.equal(f.app.readProject(f.projectId).revision.number, f.base.revision, "审阅不制造视频 Revision");
    await writeFile(full.path, "changed");
    const changed = evaluateQuality(f.state.snapshot, f.base.revision, await f.app.readEditorialQualityReview(f.base));
    assert.equal(changed.editorial.status, "partial", "文件替换会使哈希证据失效");
  } finally { await f.dispose(); }
});

test("拒绝旧 Revision、范围越界、伪造媒体、无音轨和错误观察方式", async () => {
  const f = await fixture();
  try {
    const local = await f.preview(f.base.revision, 0, 24);
    const rejects = (observations: EditorialReviewObservation[], code: string, revision = f.base.revision) => assert.rejects(() => f.app.recordEditorialQualityReview({ ...f.base, revision, passes, observations }), (error: unknown) => error instanceof DomainError && error.code === code);
    await rejects(f.observe(local.id), "EDITORIAL_EVIDENCE_RANGE_INVALID");
    await rejects([{ ...f.observe(local.id, 0, 24)[0]!, method: "frames" }], "EDITORIAL_METHOD_INVALID");
    const silent = await f.preview(f.base.revision, 0, 48, true);
    await rejects(f.observe(silent.id), "EDITORIAL_AUDIO_MISSING");
    await writeFile(local.path, "not a video");
    await rejects(f.observe(local.id, 0, 24), "EDITORIAL_EVIDENCE_MEDIA_INVALID");
    const next = f.app.updateStory({ projectId: f.projectId, baseRevision: f.base.revision, title: "修订" });
    await rejects(f.observe(silent.id), "EDITORIAL_PREVIEW_MISMATCH", next.revision.number);
  } finally { await f.dispose(); }
});

test("问题跨 Run、Revision 保留，只有当前范围复核才能关闭且文件失效会重新待审", async () => {
  const f = await fixture();
  try {
    const cueState = f.app.createEffectCue({ projectId: f.projectId, baseRevision: f.base.revision, sceneId: f.state.snapshot.scenes[0]!.id, type: "CameraPunch", layer: "actor", startFrame: 5, endFrame: 10, note: "测试定位" });
    const revision = cueState.revision.number;
    const cueId = cueState.snapshot.effectCues[0]!.id;
    const first = await f.app.recordEditorialQualityReview({ ...f.base, revision, passes: ["mute_visual"], previewEvidence: ["发现局部问题"], findings: [{ pass: "mute_visual", severity: "major", category: "motion", summary: "运动入口闪烁", evidence: "测试观察", impact: "破坏连续性", objectId: cueId, frameRange: { startFrame: 5, endFrame: 10 } }] });
    const findingId = first.editorialReview!.findings[0]!.id;
    const next = f.app.updateStory({ projectId: f.projectId, baseRevision: revision, title: "下一版" });
    const secondRun = await f.app.startProductionRun({ projectId: f.projectId, loadedSkills: ["quality-verification"] });
    const base = { ...f.base, revision: next.revision.number, runId: secondRun.id, passes: ["mute_visual"] as EditorialReviewPass[] };
    await f.app.recordEditorialQualityReview({ ...base, previewEvidence: ["恢复任务"] });
    assert.equal(openEditorialFindings(await f.app.readEditorialQualityReview(base))[0]!.id, findingId);
    const preview = await f.preview(next.revision.number);
    const tooShort = await f.app.recordEditorialQualityReview({ ...base, observations: f.observe(preview.id, 5, 7, ["mute_visual"]) });
    await assert.rejects(() => f.app.recordEditorialQualityReview({ ...base, resolutions: [{ findingId, evidenceIds: [tooShort.editorialReview!.evidenceRecords![0]!.id], note: "局部不够" }] }), (error: unknown) => error instanceof DomainError && error.code === "EDITORIAL_RESOLUTION_EVIDENCE_REQUIRED");
    const checked = await f.app.recordEditorialQualityReview({ ...base, observations: f.observe(preview.id, 5, 10, ["mute_visual"]) });
    await f.app.recordEditorialQualityReview({ ...base, resolutions: [{ findingId, evidenceIds: [checked.editorialReview!.evidenceRecords!.at(-1)!.id], note: "复核当前对象完整进入退出" }] });
    let review = await f.app.readEditorialQualityReview(base);
    assert.equal(openEditorialFindings(review).length, 0);
    assert.equal(review!.findings.length, 1, "关闭保留历史而不是删除问题");
    assert.equal(openEditorialFindings(await f.app.readEditorialQualityReview({ projectId: f.projectId, revision })).length, 1, "新版本关闭不改写旧版本结论");
    await writeFile(preview.path, "replaced");
    review = await f.app.readEditorialQualityReview(base);
    assert.equal(openEditorialFindings(review).length, 1);
  } finally { await f.dispose(); }
});

test("共用长 Scene 不会把一个效果误算为每拍都实现，stale 计划不会算成主动留白", async () => {
  const f = await fixture();
  try {
    const snapshot = structuredClone(f.state.snapshot);
    snapshot.story.beats = ["a", "b"].map((id, order) => ({ id, order, title: id, purpose: "测试", semanticUnitIds: [], sceneIds: [snapshot.scenes[0]!.id] }));
    snapshot.visualTreatments = ["a", "b"].map((id) => ({ id: `t-${id}`, narrativeBeatId: id, sceneId: snapshot.scenes[0]!.id, mode: "remotion", intensity: "high", primaryAttention: "对比", narrativePurpose: "测试", status: id === "a" ? "ready" : "stale", createdAt: "", updatedAt: "" }));
    const cue = f.app.createEffectCue({ projectId: f.projectId, baseRevision: f.base.revision, sceneId: snapshot.scenes[0]!.id, type: "CameraPunch", layer: "actor", startFrame: 5, endFrame: 10, note: "测试" }).snapshot.effectCues[0]!;
    snapshot.effectCues = [{ ...cue, semanticAnchor: { type: "narrative_beat", targetId: "a", relation: "land_on" } }];
    const rows = productionReconciliation(snapshot);
    assert.equal(rows[0]!.linkedEffectCueIds.length, 1);
    assert.equal(rows[1]!.linkedEffectCueIds.length, 0);
    assert.deepEqual(rows[1]!.staleTreatmentIds, ["t-b"]);
  } finally { await f.dispose(); }
});

test("严重观感问题不得被质量门禁丢弃，空报告和新 Run 不得清除待修问题", async () => {
  const root = await mkdtemp(join(tmpdir(), "editorial-loop-"));
  const app = createApplication(root);
  try {
    const state = app.createProject({ name: "审片闭环回归" });
    const projectId = state.snapshot.project.id;
    const revision = state.revision.number;
    const run = await app.startProductionRun({ projectId, loadedSkills: ["quality-verification"] });
    const input = { projectId, runId: run.id, revision, passes, previewEvidence: ["历史文字证据（不代表连续看过）"] };
    const first = await app.recordEditorialQualityReview({ ...input, findings: [{ pass: "mute_visual", severity: "major", category: "attention", summary: "重点遮挡人物五官", evidence: "局部观察", impact: "影响阅读与人物表达" }] });
    const findingId = first.editorialReview!.findings[0]!.id;
    const quality = evaluateQuality(state.snapshot, revision, first.editorialReview);
    assert.ok(quality.editorial.attention.some((issue) => issue.message === "重点遮挡人物五官"));
    await app.recordEditorialQualityReview({ ...input, findings: [] });
    const secondRun = await app.startProductionRun({ projectId, loadedSkills: ["quality-verification"] });
    await app.recordEditorialQualityReview({ ...input, runId: secondRun.id, findings: [] });
    const review = await app.readEditorialQualityReview({ projectId, revision });
    assert.ok(review!.findings.some((finding) => finding.id === findingId));
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
