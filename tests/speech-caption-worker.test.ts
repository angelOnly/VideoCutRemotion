import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { ComfyUIBridgeClient, FUNASR_SOURCE_CAPTION_WORKFLOW_ID } from "@videocut/bridge";
import { assertProjectGraphValid } from "@videocut/domain";
import { evaluateQuality } from "@videocut/quality";
import { probeMedia, runProcess } from "@videocut/speech";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { createServer } from "../apps/server/src/app.js";
import type { ProjectSnapshot } from "@videocut/contracts";

const text = "流量总量并不等于下载速度，网络拥挤时还要看资源怎样分。";
const phrases = ["流量总量并不等于下载速度，", "网络拥挤时还要看资源怎样分。"];

test("旧项目真实MCP拒绝透明度0且不写Revision；旁白同源批量null取消背景，非法Card整批拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-caption-format-contract-"));
  const f = await fixture(root);
  f.app.repository.commit(f.projectId, f.assembled.revision.number, "模拟旧项目同源字幕版式", (snapshot) => {
    delete snapshot.timeline.captionFormat;
  });
  const provider = mockProvider();
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(), env: { ...process.env as Record<string, string>, VIDEOCUT_WORKSPACE: root }, stderr: "pipe" });
  const client = new Client({ name: "字幕版式拒绝回归", version: "1.0.0" });
  try {
    f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: f.app.readProject(f.projectId).revision.number });
    await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
    const before = f.app.readProject(f.projectId);
    const ids = before.snapshot.timeline.captions.map(card => card.id);
    await client.connect(transport);
    const args = { project_id: f.projectId, base_revision_id: before.revision.number, caption_ids: ids, action: "bulk_source_format" };
    const rejected = await client.callTool({ name: "edit_captions", arguments: { ...args, format: { background_color: null, background_opacity: 0 } } });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /background_opacity|0\.1/u);
    assert.equal(f.app.readProject(f.projectId).revision.number, before.revision.number);
    const shadowRejected = await client.callTool({ name: "edit_captions", arguments: { ...args, format: { text_shadow: "none" } } });
    assert.equal(shadowRejected.isError, true);
    assert.equal(f.app.readProject(f.projectId).revision.number, before.revision.number);
    const accepted = await client.callTool({ name: "edit_captions", arguments: { ...args, format: { background_color: null, color: "#151917", text_shadow: null } } });
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    const after = f.app.readProject(f.projectId);
    for (const card of after.snapshot.timeline.captions) assert.equal(card.format?.textShadow, null, "MCP批量关闭阴影必须真实保存");
    for (const card of after.snapshot.timeline.captions) { assert.equal(card.format?.backgroundColor, undefined); assert.equal(card.format?.backgroundOpacity, undefined); assert.equal(card.format?.color, "#151917"); }
    assert.deepEqual(after.snapshot.timeline.items, before.snapshot.timeline.items);
    assert.throws(() => f.app.editCaptions({ projectId: f.projectId, baseRevision: after.revision.number, captionIds: [...ids, "异源或不存在的Card"], action: "bulk_source_format", format: { color: "#ffffff" } }));
    // 同时经过真实协议验证业务拒绝，防止统一错误封装只在单测中成立。
    const businessRejected = await client.callTool({ name: "edit_captions", arguments: { ...args, base_revision_id: after.revision.number, caption_ids: [...ids, "异源或不存在的Card"], format: { color: "#ffffff" } } });
    assert.equal(businessRejected.isError, true);
    const businessError = JSON.parse((businessRejected.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")!.text!);
    assert.equal(businessError.sideEffects, "unknown");
    assert.equal(businessError.safeToRetry, false);
    assert.equal(businessError.message, businessError.error);
    assert.ok(businessError.code);
    const readRejected = await client.callTool({ name: "read_project", arguments: { project_id: "project_missing_protocol_fixture" } });
    assert.equal(readRejected.isError, true);
    const readError = JSON.parse((readRejected.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")!.text!);
    assert.equal(readError.sideEffects, "unknown");
    assert.equal(readError.safeToRetry, false);
    assert.equal(readError.message, readError.error);
    assert.ok(readError.code);
    assert.equal(f.app.readProject(f.projectId).revision.number, after.revision.number);
  } finally { await client.close(); await transport.close(); provider.restore(); f.app.close(); await rm(root, { recursive: true, force: true }); }
});

test("旧项目字幕美术阴影经HTTP编辑读回；局部更新保留选择，非法值不写版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-caption-shadow-"));
  const f = await fixture(root);
  f.app.repository.commit(f.projectId, f.assembled.revision.number, "模拟旧项目单卡阴影", (snapshot) => {
    delete snapshot.timeline.captionFormat;
  });
  const server = await createServer({ workspaceRoot: root });
  try {
    const before = f.app.readProject(f.projectId);
    const card = before.snapshot.timeline.captions[0]!;
    const patch = (format: unknown) => server.app.inject({ method: "PATCH", url: `/api/projects/${f.projectId}/captions/${card.id}`, payload: { baseRevision: f.app.readProject(f.projectId).revision.number, action: "update", format } });
    const shadow = { offsetX: -2, offsetY: 3, blur: 6, color: "#123456", opacity: 0.4 };
    for (const value of ["none", { ...shadow, blur: 41 }, { ...shadow, offsetX: -21 }, { ...shadow, color: "red" }, { ...shadow, opacity: 2 }, { ...shadow, extra: true }]) {
      assert.equal((await patch({ textShadow: value })).statusCode, 400);
    }
    assert.equal(f.app.readProject(f.projectId).revision.number, before.revision.number);
    assert.equal((await patch({ textShadow: shadow })).statusCode, 200);
    assert.deepEqual(f.app.readProject(f.projectId).snapshot.timeline.captions[0]!.format?.textShadow, shadow);
    assert.equal((await patch({ color: "#151917" })).statusCode, 200);
    assert.deepEqual(f.app.readProject(f.projectId).snapshot.timeline.captions[0]!.format?.textShadow, shadow);
    assert.equal((await patch({ textShadow: null })).statusCode, 200);
    assert.equal((await patch({ fontSize: 36 })).statusCode, 200);
    const after = f.app.readProject(f.projectId);
    assert.equal(after.snapshot.timeline.captions[0]!.format?.textShadow, null);
    assert.deepEqual(after.snapshot.speechAsset, before.snapshot.speechAsset);
    assert.deepEqual(after.snapshot.script, before.snapshot.script);
    assert.deepEqual([after.snapshot.timeline.captions[0]!.startFrame, after.snapshot.timeline.captions[0]!.endFrame, after.snapshot.timeline.captions[0]!.sourceText], [card.startFrame, card.endFrame, card.sourceText]);
    assert.throws(() => f.app.editCaptions({ projectId: f.projectId, baseRevision: after.revision.number, captionId: card.id, action: "update", format: { textShadow: { ...shadow, blur: -1 } } }));
    assert.equal(f.app.readProject(f.projectId).revision.number, after.revision.number);
  } finally { await server.app.close(); server.application.close(); f.app.close(); await rm(root, { recursive: true, force: true }); }
});

test("旧项目字幕显隐和静态位置经HTTP原子读回，保留语音原文与对齐，越界不写版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-caption-presentation-"));
  const f = await fixture(root);
  f.app.repository.commit(f.projectId, f.assembled.revision.number, "模拟旧项目单卡位置", (snapshot) => {
    delete snapshot.timeline.captionFormat;
  });
  const server = await createServer({ workspaceRoot: root });
  try {
    const before = f.app.readProject(f.projectId);
    const card = before.snapshot.timeline.captions[0]!;
    assert.ok(card);
    const patch = (payload: Record<string, unknown>) => server.app.inject({ method: "PATCH", url: `/api/projects/${f.projectId}/captions/${card.id}`, payload: { baseRevision: f.app.readProject(f.projectId).revision.number, action: "update", ...payload } });
    for (const display of [{ mode: "shown", ranges: [{ startFrame: -1, endFrame: 12 }] }, { mode: "shown", ranges: [{ startFrame: 0, endFrame: 193 }] }, { mode: "hidden", ranges: [{ startFrame: 0, endFrame: 12 }] }, { mode: "shown", ranges: [{ startFrame: 0, endFrame: 12 }, { startFrame: 10, endFrame: 20 }] }]) assert.equal((await patch({ display })).statusCode, 400);
    assert.equal(f.app.readProject(f.projectId).revision.number, before.revision.number);
    const display = { mode: "shown", ranges: [{ startFrame: 12, endFrame: 36 }, { startFrame: 96, endFrame: 150 }] };
    const placement = { leftPercent: 50, topPercent: 15, widthPercent: 45 };
    const updated = await patch({ display, format: { placement } });
    assert.equal(updated.statusCode, 200, updated.body);
    const after = f.app.readProject(f.projectId);
    assert.deepEqual(after.snapshot.timeline.captions[0]!.display, display);
    assert.deepEqual(after.snapshot.timeline.captions[0]!.format!.placement, placement);
    assert.deepEqual(after.snapshot.speechAsset, before.snapshot.speechAsset);
    assert.deepEqual(after.snapshot.script, before.snapshot.script);
    assert.deepEqual([after.snapshot.timeline.captions[0]!.sourceText, after.snapshot.timeline.captions[0]!.startFrame, after.snapshot.timeline.captions[0]!.endFrame], [card.sourceText, card.startFrame, card.endFrame]);
    assert.equal((await patch({ format: { placement: { ...placement, widthPercent: 80 } } })).statusCode, 400);
    assert.equal((await patch({ display: { mode: "hidden" } })).statusCode, 200);
    assert.equal((await patch({ display: null, format: { placement: null } })).statusCode, 200);
    const reset = f.app.readProject(f.projectId).snapshot.timeline.captions[0]!;
    assert.equal(reset.display, undefined); assert.equal(reset.format!.placement, undefined);
  } finally { await server.app.close(); server.application.close(); f.app.close(); await rm(root, { recursive: true, force: true }); }
});

test("HTTP 按当前原稿或明确用户指令纠正显示，错误版本/片段/依据拒绝且不改声音和时间", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-caption-basis-"));
  const f = await fixture(root);
  const wrongPhrases = [phrases[0]!.replace("流量", "留量"), phrases[1]!];
  const provider = mockProvider({ phrases: wrongPhrases, transcript: wrongPhrases.join("") });
  const server = await createServer({ workspaceRoot: root });
  try {
    const projectId = f.projectId;
    f.app.generateSpeechCaptions({ projectId, baseRevision: f.app.readProject(projectId).revision.number });
    await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
    const before = f.app.readProject(projectId);
    const card = before.snapshot.timeline.captions[0]!;
    assert.equal(card.text, wrongPhrases[0]);
    const review = { basis: "confirmed_script", note: "测试模拟已确认原稿正字，不代表回听", scriptRevision: before.snapshot.script.revision, speechSegmentIds: before.snapshot.speechSegments.map(s => s.id) };
    const patch = (sourceTextReview: unknown, text = phrases[0], baseRevision = before.revision.number) => server.app.inject({ method: "PATCH", url: `/api/projects/${projectId}/captions/${card.id}`, payload: { baseRevision, action: "update", text, sourceTextReview } });
    for (const invalid of [undefined, { ...review, scriptRevision: review.scriptRevision + 1 }, { ...review, speechSegmentIds: ["other"] }, { ...review, speechSegmentIds: [...review.speechSegmentIds, ...review.speechSegmentIds] }, { basis: "user_instruction", note: "没有真实指令来源" }]) {
      assert.equal((await patch(invalid)).statusCode, 400);
      assert.equal(f.app.readProject(projectId).revision.number, before.revision.number);
    }
    assert.equal((await patch(review, "不在所指原稿中的新内容")).statusCode, 400);
    const response = await patch(review);
    assert.equal(response.statusCode, 200, response.body);
    const corrected = f.app.readProject(projectId);
    assert.equal(corrected.snapshot.timeline.captions[0]!.text, phrases[0]);
    assert.equal(corrected.snapshot.timeline.captions[0]!.sourceText, wrongPhrases[0]);
    assert.equal(corrected.snapshot.timeline.captions[0]!.sourceTextReview!.basis, "confirmed_script");
    const formatted = await patch(undefined, "流量总量\n并不等于下载速度，", corrected.revision.number);
    assert.equal(formatted.statusCode, 200, formatted.body);
    const formattedState = f.app.readProject(projectId);
    assert.equal(formattedState.snapshot.timeline.captions[0]!.sourceTextReview!.reviewedAt, corrected.snapshot.timeline.captions[0]!.sourceTextReview!.reviewedAt);
    assert.equal((await patch(undefined, "再次改变实义内容", formattedState.revision.number)).statusCode, 400);
    const human = await patch({ basis: "user_instruction", note: "测试模拟显示修改授权", instruction: "将字幕写为“流量不代表下载速度”", source: "测试会话的明确用户反馈" }, "流量不代表下载速度", formattedState.revision.number);
    assert.equal(human.statusCode, 200, human.body);
    const after = f.app.readProject(projectId);
    for (const key of ["sourceAudioAlignments", "script", "speechSegments", "speechAsset", "assets"] as const) assert.deepEqual(after.snapshot[key], before.snapshot[key], key);
    assert.deepEqual(after.snapshot.timeline.items, before.snapshot.timeline.items);
    const changed = after.snapshot.timeline.captions[0]!;
    assert.deepEqual([changed.startFrame, changed.endFrame], [card.startFrame, card.endFrame]);
    assertProjectGraphValid(after.snapshot);
  } finally { provider.restore(); await server.app.close(); server.application.close(); f.app.close(); await rm(root, { recursive: true, force: true }); }
});

async function fixture(root: string) {
  const app = createApplication(root);
  const projectId = app.createProject({ name: "完整旁白独立字幕回归", profile: "visual_explainer" }).snapshot.project.id;
  const authored = app.applyAuthoredScript({ projectId, baseRevision: 1, sourceNote: "合约测试，不代表真实发音", units: [{ text, kind: "statement" }] });
  const imported = app.registerImportedAsset({ projectId, baseRevision: authored.revision.number, name: "speech.wav", kind: "speech", managedPath: "assets/speech/speech.wav", sourceHash: "speech-caption-fixture", provenance: { source: "generated", acquiredAt: new Date().toISOString() } });
  const file = join(authored.snapshot.project.rootPath, imported.asset.managedPath);
  await mkdir(dirname(file), { recursive: true });
  await runProcess("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=8:sample_rate=24000", file]);
  app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(file) });
  for (const job of app.listJobs(projectId)) app.updateJob(job.id, { status: "succeeded" });
  const segment = authored.snapshot.speechSegments[0]!;
  const segmentAsset = { id: "segment-asset", speechSegmentId: segment.id, voiceReferenceAssetId: imported.asset.id, assetId: imported.asset.id, durationMs: 8000, bridgeRunId: "tts-fixture", schemaVersion: "fixture", quality: "passed" as const };
  const assembled = app.applySpeechAssembly({ projectId, generatedAssets: [], segmentAssets: [segmentAsset], speechAsset: { id: "speech-fixture", assetId: imported.asset.id, scriptRevision: authored.snapshot.script.revision, segmentAssetIds: [segmentAsset.id], status: "ready", timing: { precision: "segment_exact", source: "测试夹具", segments: [{ speechSegmentId: segment.id, startMs: 0, endMs: 8000, startFrame: 0, endFrame: 192 }] } } });
  return { app, projectId, assembled, file };
}

test("旁白字幕回听纠错保留 Provider 原文与时间，未确认和篡改均拒绝", async () => {
  for (const tokenTimed of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "videocut-caption-review-"));
    const f = await fixture(root);
    const provider = mockProvider({ tokenTimed });
    try {
      const job = f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: f.app.readProject(f.projectId).revision.number });
      await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
      const before = f.app.readProject(f.projectId);
      const card = before.snapshot.timeline.captions[0]!;
      const input = { projectId: f.projectId, baseRevision: before.revision.number, captionId: card.id, action: "update" as const, text: "流量总量并不等于网速。" };
      assert.throws(() => f.app.editCaptions(input), { code: "CAPTION_SOURCE_TEXT_REVIEW_REQUIRED" });
      assert.equal(f.app.readProject(f.projectId).revision.number, before.revision.number);
      const reviewed = f.app.editCaptions({ ...input, sourceTextReview: { note: "合约夹具：模拟实际回听确认识别错词；不代表真实语音验收。" } });
      const changed = reviewed.snapshot.timeline.captions[0]!;
      assert.equal(changed.sourceText, card.sourceText);
      assert.equal(changed.startFrame, card.startFrame);
      assert.equal(changed.endFrame, card.endFrame);
      assert.deepEqual(reviewed.snapshot.sourceAudioAlignments, before.snapshot.sourceAudioAlignments);
      assert.deepEqual(reviewed.snapshot.speechAsset, before.snapshot.speechAsset);
      assertProjectGraphValid(reviewed.snapshot);
      assert.ok(!evaluateQuality(reviewed.snapshot, reviewed.revision.number).issues.some(issue => /SOURCE_.*(INVALID|MISMATCH)/.test(issue.code)));
      const forged = structuredClone(reviewed.snapshot);
      forged.timeline.captions[0]!.text = "偷偷换了文案";
      assert.throws(() => assertProjectGraphValid(forged));
      if (tokenTimed) assert.throws(() => f.app.applySourceCaptionProgram({ projectId: f.projectId, baseRevision: reviewed.revision.number, alignmentId: reviewed.snapshot.sourceAudioAlignments[0]!.id, cards: [{ tokenStartIndex: 0, tokenEndIndex: 2, rationale: "不应静默丢失纠错" }] }), { code: "SOURCE_CAPTION_REVIEW_RESEGMENT_CONFLICT" });
      const reset = f.app.editCaptions({ projectId: f.projectId, baseRevision: reviewed.revision.number, captionId: card.id, action: "reset" });
      assert.equal(reset.snapshot.timeline.captions[0]!.sourceTextReview, undefined);
      assert.equal(reset.snapshot.timeline.captions[0]!.text, card.sourceText);
      assert.equal(f.app.trackJob(job.id).status, "succeeded");
    } finally { provider.restore(); f.app.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("异步字幕期间修改 Revision 不覆盖新状态，同一次回执只能恢复同一旁白", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-caption-concurrent-"));
  const f = await fixture(root);
  let altered = false;
  const provider = mockProvider({ onRead: () => {
    if (altered) return;
    altered = true;
    f.app.createScene({ projectId: f.projectId, baseRevision: f.app.readProject(f.projectId).revision.number, type: "ExplainerScene", title: "并发画面", purpose: "不能被旧字幕作业覆盖", startFrame: 0, endFrame: 192 });
  } });
  try {
    const job = f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: f.app.readProject(f.projectId).revision.number });
    await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
    assert.equal(f.app.trackJob(job.id).status, "failed");
    assert.equal(f.app.readProject(f.projectId).snapshot.sourceAudioAlignments.length, 0);
    const nextJob = f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: f.app.readProject(f.projectId).revision.number });
    await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
    assert.equal(f.app.trackJob(nextJob.id).status, "succeeded");
    const state = f.app.readProject(f.projectId);
    const a = state.snapshot.sourceAudioAlignments[0]!;
    const receipt = { projectId: f.projectId, requestedRevision: a.requestedRevision, assetId: a.sourceAssetId, timelineItemId: a.sourceTimelineItemId, sourceStartFrame: a.sourceStartFrame, sourceEndFrame: a.sourceEndFrame, timelineStartFrame: a.timelineStartFrame, timelineEndFrame: a.timelineEndFrame, transcriptText: a.transcriptText, bridgeAudit: a.bridgeAudit, speechSource: a.speechSource, tokenPrecision: a.tokenPrecision, tokens: a.tokens, segments: a.segments };
    assert.equal(f.app.completeSourceAudioCaptionAlignment(receipt).revision.number, state.revision.number);
    assert.throws(() => f.app.completeSourceAudioCaptionAlignment({ ...receipt, speechSource: undefined }));
    assert.equal(f.app.readProject(f.projectId).revision.number, state.revision.number);
    const wordJob = f.app.submitSpeechAlignment({ projectId: f.projectId, baseRevision: state.revision.number, speechAssetId: state.snapshot.speechAsset!.id, workflowId: "test-real-alignment-contract", idempotencyKey: "separate-word-timing" });
    const aligned = f.app.completeSpeechAlignment({ projectId: f.projectId, jobId: wordJob.id,
      alignment: { source: "合约夹具，不代表真实音频词级验收", words: [{ speechSegmentId: state.snapshot.speechSegments[0]!.id, text, normalizedText: text.replace(/[\p{P}\s]/gu, ""), startMs: 0, endMs: 8000, startFrame: 0, endFrame: 192 }] },
      bridgeAudit: { workflowId: "test-real-alignment-contract", runId: "fixture-word-run", schemaVersion: "fixture", schemaRetryCount: 0, submittedAt: new Date().toISOString(), completedAt: new Date().toISOString(), request: { fieldValues: {}, fileSlots: [] }, response: { status: "succeeded", outputs: [] } }
    });
    assert.equal(aligned.state.snapshot.speechAsset!.timing.precision, "word_exact");
    assert.deepEqual(aligned.state.snapshot.timeline.captions, state.snapshot.timeline.captions, "独立字幕时间不被词级 SpeechTiming 偷换");
    assertProjectGraphValid(aligned.state.snapshot);
  } finally { provider.restore(); f.app.close(); await rm(root, { recursive: true, force: true }); }
});

test("HTTP 与实时 MCP 均通过正式入口提交旁白字幕和显示纠错", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-caption-entries-"));
  const f = await fixture(root);
  const server = await createServer({ workspaceRoot: root });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(), env: { ...process.env as Record<string, string>, VIDEOCUT_WORKSPACE: root, COMFYUI_BRIDGE_URL: "http://127.0.0.1:1" }, stderr: "pipe" });
  const client = new Client({ name: "旁白字幕入口回归", version: "1.0.0" });
  const provider = mockProvider();
  try {
    const revision = f.app.readProject(f.projectId).revision.number;
    const response = await server.app.inject({ method: "POST", url: `/api/projects/${f.projectId}/speech-captions`, payload: { baseRevision: revision, idempotencyKey: "entry-test" } });
    assert.equal(response.statusCode, 202, response.body);
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.ok(catalog.tools.find(tool => tool.name === "generate_speech_captions")?.inputSchema.properties?.base_revision_id);
    assert.ok(catalog.tools.find(tool => tool.name === "edit_captions")?.inputSchema.properties?.source_text_review);
    const same = await client.callTool({ name: "generate_speech_captions", arguments: { project_id: f.projectId, base_revision_id: revision, idempotency_key: "entry-test" } });
    assert.ok(!same.isError, JSON.stringify(same));
    assert.equal(f.app.listJobs(f.projectId).filter(job => job.kind === "source_caption_alignment").length, 1);
    await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
    const state = f.app.readProject(f.projectId);
    const result = await client.callTool({ name: "edit_captions", arguments: { project_id: f.projectId, base_revision_id: state.revision.number, caption_id: state.snapshot.timeline.captions[0]!.id, action: "update", text: "流量总量并不等于网速。", source_text_review: { note: "入口合约模拟回听纠错" } } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(f.app.readProject(f.projectId).snapshot.timeline.captions[0]!.sourceTextReview?.text, "流量总量并不等于网速。");
  } finally { provider.restore(); await client.close(); await transport.close(); await server.app.close(); server.application.close(); f.app.close(); await rm(root, { recursive: true, force: true }); }
});

function mockProvider(options: { tokenTimed?: boolean; transcript?: string; phrases?: string[]; onRead?: () => void } = {}) {
  const savedFetch = globalThis.fetch;
  let submissions = 0;
  const tokens = (options.phrases ?? phrases).map((value, i) => ({ text: value, startMs: 100 + i * 4000, endMs: 3900 + i * 4000 }));
  const timed = options.tokenTimed !== false;
  const output = { version: 4, precision: "provider_segment_timed", text: options.transcript ?? text, alignment: { tokenEvidence: timed ? "verified" : "unavailable", tokenPrecision: timed ? "provider_token_timed" : "unavailable", tokens: timed ? tokens : [] }, segments: tokens.map((token, i) => ({ displayText: token.text, startMs: token.startMs, endMs: token.endMs, ...(timed ? { tokenStart: i, tokenEnd: i + 1 } : {}) })) };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/health")) return Response.json({ status: "ready", queueModes: ["foreground"] });
    if (url.endsWith(`/workflows/${FUNASR_SOURCE_CAPTION_WORKFLOW_ID}`)) return Response.json({ id: FUNASR_SOURCE_CAPTION_WORKFLOW_ID, name: "真实音频字幕", available: true, schemaVersion: "v4-test", fields: [], itemSlots: [{ id: "audio", label: "音频", kind: "audio", required: true }], outputs: [{ id: "transcript-text", label: "全文", kind: "text" }, { id: "caption-alignment-json", label: "时间", kind: "text" }] });
    if (url.endsWith(`/workflows/${FUNASR_SOURCE_CAPTION_WORKFLOW_ID}/runs`)) {
      assert.equal(init?.method, "POST");
      assert.ok(init?.body instanceof FormData);
      submissions++;
      return Response.json({ id: "speech-caption-provider", status: "queued", outputs: [] });
    }
    if (url.endsWith("/runs/speech-caption-provider")) {
      options.onRead?.();
      return Response.json({ id: "speech-caption-provider", status: "succeeded", outputs: [{ outputSlotId: "transcript-text", kind: "text", text: options.transcript ?? text }, { outputSlotId: "caption-alignment-json", kind: "text", text: JSON.stringify(output) }] });
    }
    throw new Error(`未预期请求 ${url}`);
  };
  return { restore: () => { globalThis.fetch = savedFetch; }, submissions: () => submissions };
}

test("完整旁白复用 Provider 分屏且不修改语义、音频和画面，严格 token 可重分屏", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-speech-captions-"));
  const f = await fixture(root);
  const provider = mockProvider();
  try {
    const before = f.app.readProject(f.projectId);
    const job = f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: before.revision.number });
    assert.equal(f.app.readProject(f.projectId).revision.number, before.revision.number);
    assert.ok(job.payload.speechSource);
    await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
    const completed = f.app.trackJob(job.id);
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    let after = f.app.readProject(f.projectId);
    assert.equal(after.snapshot.timeline.captions.length, 2);
    assert.equal(after.snapshot.sourceCaptionPrograms.length, 1);
    assert.equal(after.snapshot.sourceAudioAlignments[0]!.speechSource?.speechAssetId, "speech-fixture");
    for (const key of ["script", "semanticUnits", "speechSegments", "speechAsset", "speechSegmentAssets", "scenes", "effectCues", "actorPerformances", "transcripts"] as const) assert.deepEqual(after.snapshot[key], before.snapshot[key], key);
    assert.deepEqual(after.snapshot.timeline.items, before.snapshot.timeline.items);
    assert.equal(after.snapshot.timeline.items.length, 1, "只有原 Dialogue，不创建伪 A-roll");
    assert.ok(!evaluateQuality(after.snapshot, after.revision.number).issues.some(issue => /SOURCE_.*(INVALID|MISMATCH)|CAPTION_LAYOUT_OVERFLOW/.test(issue.code)));
    assert.throws(() => f.app.generateSourceAudioCaptions({ projectId: f.projectId, baseRevision: after.revision.number, timelineItemId: after.snapshot.timeline.items[0]!.id }), /A-roll/);
    assert.throws(() => f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: after.revision.number }), { code: "SOURCE_CAPTION_ALIGNMENT_COARSE_CAPTIONS_INELIGIBLE" });
    const alignment = after.snapshot.sourceAudioAlignments[0]!;
    after = f.app.applySourceCaptionProgram({ projectId: f.projectId, baseRevision: after.revision.number, alignmentId: alignment.id, cards: [{ tokenStartIndex: 0, tokenEndIndex: 1, rationale: "完整对比前项" }, { tokenStartIndex: 1, tokenEndIndex: 2, rationale: "完整条件与结论" }] });
    assertProjectGraphValid(after.snapshot);
    assert.equal(provider.submissions(), 1, "重分屏不重新合成或识别");
    const rebuilt = f.app.rebuildSpeechAssetTimeline({ projectId: f.projectId, baseRevision: after.revision.number });
    assert.equal(rebuilt.snapshot.sourceAudioAlignments[0]!.status, "stale");
    assert.equal(rebuilt.snapshot.sourceCaptionPrograms.length, 0);
    assert.equal(rebuilt.snapshot.timeline.captions.length, 1);
    assertProjectGraphValid(rebuilt.snapshot);
  } finally { provider.restore(); f.app.close(); await rm(root, { recursive: true, force: true }); }
});

test("只有句级时间也能生成旁白字幕，但不能伪造新的切点；新稿使旧字幕完整失效", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-speech-caption-segments-"));
  const f = await fixture(root);
  const provider = mockProvider({ tokenTimed: false });
  try {
    const job = f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: f.app.readProject(f.projectId).revision.number });
    await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
    assert.equal(f.app.trackJob(job.id).status, "succeeded");
    const after = f.app.readProject(f.projectId);
    assert.ok(after.snapshot.timeline.captions.every(card => card.precision === "sentence_exact"));
    assert.throws(() => f.app.applySourceCaptionProgram({ projectId: f.projectId, baseRevision: after.revision.number, alignmentId: after.snapshot.sourceAudioAlignments[0]!.id, cards: [{ tokenStartIndex: 0, tokenEndIndex: 1, rationale: "不能猜时间" }] }), /token/);
    const rewritten = f.app.applyAuthoredScript({ projectId: f.projectId, baseRevision: after.revision.number, sourceNote: "修订", units: [{ text: "改稿后须重新配音。", kind: "statement" }] });
    assert.equal(rewritten.snapshot.timeline.captions.length, 0);
    assert.equal(rewritten.snapshot.sourceCaptionPrograms.length, 0);
    assert.equal(rewritten.snapshot.sourceAudioAlignments[0]!.status, "stale");
    assertProjectGraphValid(rewritten.snapshot);
  } finally { provider.restore(); f.app.close(); await rm(root, { recursive: true, force: true }); }
});

test("完整旁白 Program 满足字幕门禁，缺卡、过期、错来源和破损证据仍阻挡", async () => {
  for (const tokenTimed of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "videocut-speech-caption-quality-"));
    const f = await fixture(root);
    const provider = mockProvider({ tokenTimed });
    try {
      const before = f.app.readProject(f.projectId);
      assert.ok(!evaluateQuality(before.snapshot, before.revision.number).issues.some(issue => issue.code === "PRESENTER_CAPTION_MISSING"), "旧段级字幕仍受支持");
      f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: before.revision.number });
      await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
      const state = f.app.readProject(f.projectId);
      for (const profile of ["visual_explainer", "presenter_motion"] as const) {
        const snapshot = structuredClone(state.snapshot);
        snapshot.project.profile = profile;
        assert.ok(snapshot.timeline.captions.every(card => card.speechSegmentId === undefined));
        assert.ok(!evaluateQuality(snapshot, state.revision.number).issues.some(issue => issue.code === "PRESENTER_CAPTION_MISSING"), `${profile} 应认可真实旁白完整字幕，静音间隙不用补卡`);
        const cases: Array<[string, (broken: ProjectSnapshot) => void]> = [
          ["缺卡", broken => { broken.timeline.captions.pop(); }],
          ["缺 Program", broken => { broken.sourceCaptionPrograms = []; }],
          ["过期对齐", broken => { broken.sourceAudioAlignments[0]!.status = "stale"; }],
          ["错误旁白", broken => { broken.sourceAudioAlignments[0]!.speechSource!.speechAssetId = "另一份旁白"; }],
          ["错误原稿", broken => { broken.sourceAudioAlignments[0]!.speechSource!.scriptRevision++; }],
          ["错误原稿内容", broken => { broken.sourceAudioAlignments[0]!.speechSource!.scriptText = "别的内容"; }],
          ["错误音频哈希", broken => { broken.sourceAudioAlignments[0]!.sourceAssetHash = "另一份声音"; }],
          ["禁用声音", broken => { broken.timeline.items[0]!.disabled = true; }],
          ["破损审计", broken => { broken.sourceAudioAlignments[0]!.bridgeAudit.runId = ""; }],
          ["错误卡时间", broken => { broken.timeline.captions[0]!.startFrame++; }],
          ["未确认改文案", broken => { broken.timeline.captions[0]!.text = "伪造内容"; }],
          ["省略末段", broken => { broken.sourceCaptionPrograms[0]!.captionIds.pop(); broken.timeline.captions.pop(); }]
        ];
        for (const [name, mutate] of cases) {
          const broken = structuredClone(snapshot);
          mutate(broken);
          assert.ok(evaluateQuality(broken, state.revision.number).issues.some(issue => issue.code === "PRESENTER_CAPTION_MISSING"), `${profile}/${tokenTimed}/${name} 不能当作完整旁白字幕`);
        }
      }
      if (tokenTimed) {
        const resegmented = f.app.applySourceCaptionProgram({ projectId: f.projectId, baseRevision: state.revision.number, alignmentId: state.snapshot.sourceAudioAlignments[0]!.id, cards: [{ tokenStartIndex: 0, tokenEndIndex: 1, rationale: "合约测试：前项" }, { tokenStartIndex: 1, tokenEndIndex: 2, rationale: "合约测试：后项" }] });
        assert.ok(!evaluateQuality(resegmented.snapshot, resegmented.revision.number).issues.some(issue => issue.code === "PRESENTER_CAPTION_MISSING"));
      }
      const current = f.app.readProject(f.projectId);
      const reviewed = f.app.editCaptions({ projectId: f.projectId, baseRevision: current.revision.number, captionId: current.snapshot.timeline.captions[0]!.id, action: "update", text: "流量总量并不等于网速。", sourceTextReview: { note: "合约测试的模拟回听，不代表真实试听通过。" } });
      assert.ok(!evaluateQuality(reviewed.snapshot, reviewed.revision.number).issues.some(issue => issue.code === "PRESENTER_CAPTION_MISSING"), "有审计显示纠错不丢失字幕资格");
    } finally { provider.restore(); f.app.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("旁白字幕拒绝过期任务与人工覆盖，不用空字幕掩盖 Provider 文本错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-speech-caption-fail-"));
  const f = await fixture(root);
  const provider = mockProvider({ transcript: "错误的全文" });
  try {
    const before = f.app.readProject(f.projectId);
    assert.throws(() => f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: 1 }), /Revision|版本|过期/);
    const job = f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: before.revision.number });
    await runOneJob(f.app, createMediaJobProcessor(f.app, new ComfyUIBridgeClient("http://bridge.test/v1")));
    assert.equal(f.app.trackJob(job.id).status, "failed");
    assert.equal(f.app.readProject(f.projectId).revision.number, before.revision.number);
    const edited = f.app.editCaptions({ projectId: f.projectId, baseRevision: before.revision.number, captionId: before.snapshot.timeline.captions[0]!.id, action: "update", text: "人工确认的屏幕文案" });
    assert.throws(() => f.app.generateSpeechCaptions({ projectId: f.projectId, baseRevision: edited.revision.number }), /人工/);
  } finally { provider.restore(); f.app.close(); await rm(root, { recursive: true, force: true }); }
});
