import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { createSemanticUnit, assertProjectGraphValid } from "@videocut/domain";
import { createServer } from "../apps/server/src/app.js";

const units = [
  { text: "流量是总量，不是下载速度。", kind: "statement" as const },
  { text: "网络拥挤时，还要看资源怎样分。", kind: "conclusion" as const, pauseBefore: { durationMs: 250, reason: "contrast" as const } }
];

test("原稿无素材直接入稿，持久化不生成假候选，仍保留 Revision 与转写约束", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-authored-"));
  let app = createApplication(root);
  try {
    const created = app.createProject({ name: "原创语义回归", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const applied = app.applyAuthoredScript({ projectId, baseRevision: 1, sourceNote: "用户委托撰写的原创新稿", units });
    assert.equal(applied.snapshot.assets.length, 0);
    assert.equal(applied.snapshot.transcripts.length, 0);
    assert.equal(applied.snapshot.transcriptSentenceCandidates.length, 0);
    assert.deepEqual(applied.snapshot.speechSegments.map((segment) => segment.text), units.map((unit) => unit.text));
    assert.equal(applied.snapshot.speechSegments[1]?.pauseBefore.durationMs, 250);
    assert.equal(applied.snapshot.speechAsset, undefined);
    assert.ok(applied.snapshot.semanticUnits.every((unit) => unit.sourceKind === "authored" && unit.sourceNote && !unit.transcriptId && !unit.sourceAssetId && unit.candidateIds.length === 0));
    assert.throws(() => app.applyAuthoredScript({ projectId, baseRevision: 1, sourceNote: "过期请求", units }), /Revision|版本|过期/u);
    assert.throws(() => app.applySemanticUnits({ projectId, baseRevision: applied.revision.number, units: [{ ...units[0]!, candidateIds: [] }] }), /候选/u);
    assert.throws(() => createSemanticUnit({ ...units[0]!, order: 0, candidateIds: [], sourceKind: "authored", sourceNote: "新稿", sourceAssetId: "voice-reference" }), /冒充/u);
    const forged = structuredClone(applied.snapshot);
    forged.semanticUnits[0]!.sourceAssetId = "voice-reference";
    assert.throws(() => assertProjectGraphValid(forged), /原创新稿/u);
    app.close();
    app = createApplication(root);
    const reopened = app.readProject(projectId);
    assert.deepEqual(reopened.snapshot.semanticUnits, JSON.parse(JSON.stringify(applied.snapshot.semanticUnits)));
    assert.equal(reopened.snapshot.transcriptSentenceCandidates.length, 0, "旧数据兼容层不能给新稿伪造历史候选");
    const repeated = app.applyAuthoredScript({ projectId, baseRevision: reopened.revision.number, sourceNote: "含有意重复的新稿", units: [units[0]!, units[0]!] });
    assert.equal(new Set(repeated.snapshot.semanticUnits.map((unit) => unit.id)).size, 2);
    const reordered = app.applyScript({ projectId, baseRevision: repeated.revision.number, semanticUnitIds: repeated.snapshot.semanticUnits.map((unit) => unit.id).reverse() });
    assert.equal(reordered.snapshot.speechSegments.length, 2);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("原稿接入既有旁白组装，改稿后旧 Dialogue 和字幕失效且历史可读", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-authored-speech-"));
  const app = createApplication(root);
  try {
    const projectId = app.createProject({ name: "原稿声音失效回归", profile: "visual_explainer" }).snapshot.project.id;
    const authored = app.applyAuthoredScript({ projectId, baseRevision: 1, sourceNote: "回归原稿", units });
    const speech = app.registerImportedAsset({ projectId, baseRevision: authored.revision.number, name: "speech.wav", kind: "speech", managedPath: "assets/speech.wav", sourceHash: "isolated-fixture", provenance: { source: "generated", acquiredAt: new Date().toISOString() } });
    app.applyMediaAnalysis({ projectId, assetId: speech.asset.id, metadata: { durationMs: 2000, hasAudio: true, audioCodec: "pcm_s16le", sampleRate: 24000, channels: 1 } });
    const segmentAssets = authored.snapshot.speechSegments.map((segment, index) => ({ id: `authored-segment-${index}`, speechSegmentId: segment.id, voiceReferenceAssetId: speech.asset.id, assetId: speech.asset.id, durationMs: 1000, bridgeRunId: `fixture-${index}`, schemaVersion: "fixture", quality: "passed" as const }));
    const assembled = app.applySpeechAssembly({ projectId, generatedAssets: [], segmentAssets, speechAsset: { id: "authored-speech-fixture", assetId: speech.asset.id, scriptRevision: authored.snapshot.script.revision, segmentAssetIds: segmentAssets.map((asset) => asset.id), timing: { precision: "segment_exact", source: "合约回归夹具，不代表真实配音", segments: authored.snapshot.speechSegments.map((segment, index) => ({ speechSegmentId: segment.id, startMs: index * 1000, endMs: (index + 1) * 1000, startFrame: index * 24, endFrame: (index + 1) * 24 })) }, status: "ready" } });
    assert.equal(assembled.snapshot.timeline.captions.length, 2);
    assert.equal(assembled.snapshot.timeline.items.filter((item) => item.assetId === speech.asset.id).length, 1);
    const updated = app.applyAuthoredScript({ projectId, baseRevision: assembled.revision.number, sourceNote: "修改原稿", units: [{ text: "修改后必须重新配音。", kind: "statement" }] });
    assert.equal(updated.snapshot.speechAsset, undefined);
    assert.equal(updated.snapshot.timeline.captions.length, 0);
    assert.equal(updated.snapshot.timeline.items.filter((item) => item.assetId === speech.asset.id).length, 0);
    assert.ok(assembled.snapshot.timeline.captions.every((caption) => updated.revision.impact.stale.includes(caption.id)));
    assert.equal(app.repository.getRevision(projectId, assembled.revision.number).snapshot.speechAsset?.id, "authored-speech-fixture");
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("HTTP 原稿入口拒绝假来源与空稿，有效新稿沿同一应用链路写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-authored-http-"));
  const server = await createServer({ workspaceRoot: root });
  try {
    const projectId = server.application.createProject({ name: "HTTP 原稿回归" }).snapshot.project.id;
    const url = `/api/projects/${projectId}/script/authored`;
    for (const payload of [
      { baseRevision: 1, sourceNote: "来源", units: [] },
      { baseRevision: 1, sourceNote: "来源", units: [{ ...units[0], candidateIds: ["fake"] }] },
      { baseRevision: 1, sourceNote: "", units }
    ]) assert.equal((await server.app.inject({ method: "POST", url, payload })).statusCode, 400);
    assert.equal(server.application.readProject(projectId).revision.number, 1);
    const result = await server.app.inject({ method: "POST", url, payload: { baseRevision: 1, sourceNote: "原创说明", units } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().snapshot.semanticUnits[0].sourceKind, "authored");
  } finally { await server.app.close(); server.application.close(); await rm(root, { recursive: true, force: true }); }
});

test("实时 MCP 原稿 Schema 和调用可用，原声候选限制没有放宽", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-authored-mcp-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(), env: { ...process.env as Record<string, string>, VIDEOCUT_WORKSPACE: root, COMFYUI_BRIDGE_URL: "http://127.0.0.1:1" }, stderr: "pipe" });
  const client = new Client({ name: "原创入口回归", version: "1.0.0" });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const tool = catalog.tools.find((item) => item.name === "apply_authored_script");
    assert.ok(tool?.inputSchema.properties?.source_note);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    const created = await call("create_project", { name: "MCP 新稿", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const result = await call("apply_authored_script", { project_id: projectId, base_revision_id: 1, source_note: "测试原创新稿", units: [{ text: units[0]!.text, kind: "statement" }] });
    assert.equal(result.snapshot.semanticUnits[0].sourceKind, "authored");
    const script = await call("read_script", { project_id: projectId });
    assert.equal(script.speechSegments.length, 1);
    assert.deepEqual(script.transcriptSentenceCandidates, []);
    const legacy = catalog.tools.find((item) => item.name === "apply_semantic_units")!;
    assert.equal((legacy.inputSchema.properties?.units as any).items.properties.candidate_ids.minItems, 1);
  } finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
});
