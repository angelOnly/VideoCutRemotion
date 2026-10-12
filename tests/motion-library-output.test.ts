import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import type { JobRecord } from "@videocut/contracts";
import { projectMotionJob, projectMotionSearchResult } from "../apps/server/src/motion-library-output.js";

const privateData = "内部请求与向量不得进入创作返回";
const assertCompact = (value: unknown) => assert.ok(!JSON.stringify(value).includes(privateData), JSON.stringify(value));

test("机制分阶段出口明确投影，保留动作关系、连接和分页，拒绝新增内部字段", () => {
  const card = {
    id: "001-m01", title: "持续前景后逐项累积", relation: "旧对象保持，新对象从内部接管", start_state: "整体", end_state: "集合",
    retrieval: { entry: ["前景"], holds: ["内部连续"], privateData },
    clip: { path: "m01.mp4", start_ms: 50, end_ms: 2000, boundary_note: "原片连续范围", privateData },
    difference: { source_relation: "整体保持", candidate_relation: "局部展开", privateData },
    connection: { from: "002-m01", to: "001-m01", gap: "需核对位置", continuous_verified: false, privateData },
    search_text: privateData, retrieval_evidence: { privateData }, futureInternalField: privateData
  };
  const page = { stage: "从整体接入局部", total: 8, offset: 3, next_offset: 6, exhausted: false, cards: [card], privateData };
  const raw = {
    source_sha256: "a".repeat(64), groups: [page], externalRuns: { privateData }, futureInternalField: privateData,
    selection: { ids: ["001-m01"], adopted: ["001-m01"], unknown_ids: [], stale: false, privateData },
    connections: [card.connection], taxonomy: { states: [["整体", "完整主体"]], privateData },
    diagnostics: { semantic_used: true, encoded_texts: 123, privateData }
  };
  const result = projectMotionSearchResult(raw) as any;
  assertCompact(result);
  assert.deepEqual(result.groups[0], {
    stage: page.stage, total: 8, offset: 3, next_offset: 6, exhausted: false, cards: result.groups[0].cards
  });
  assert.equal(result.groups[0].cards[0].relation, card.relation);
  assert.deepEqual(result.groups[0].cards[0].retrieval.holds, ["内部连续"]);
  assert.equal(result.groups[0].cards[0].clip.boundary_note, card.clip.boundary_note);
  assert.equal(result.connections[0].continuous_verified, false);
  assert.deepEqual(result.selection.adopted, ["001-m01"]);
  assert.equal(raw.groups[0].cards[0].search_text, privateData, "投影不改后台原件");
});

test("原片分析保留真实描述、来源和采样边界，其他任务保持原合同", () => {
  const job: JobRecord = {
    id: "analysis", projectId: "project", kind: "motion_reference_analysis", status: "succeeded", attempt: 1,
    idempotencyKey: privateData, createdAt: "now", updatedAt: "now",
    payload: { id: "001-m01", source_sha256: "a".repeat(64), range: { startMs: 20, endMs: 2000 }, modelConfig: { privateData } },
    result: {
      id: "001-m01", description: "主体保持，背景从左侧接入", source_hash: "b".repeat(64), run_id: "original-run",
      range: { startMs: 20, endMs: 2000, privateData }, externalRuns: { privateData },
      sampling: { model_frame_density: "unknown", limitation: "快速交叠未知", privateData },
      input: { path: privateData, mapping: { parentHash: "b".repeat(64), offsetMs: 20, rate: 1, privateData }, streams: [{ nb_read_frames: "60", avg_frame_rate: "30/1", privateData }] }
    }
  };
  const result = projectMotionJob(job) as any;
  assertCompact(result);
  assert.equal(result.result.description, job.result!.description);
  assert.equal(result.result.input.mapping.offsetMs, 20);
  assert.equal(result.result.sampling.model_frame_density, "unknown");
  assert.equal(result.result.run_id, "original-run");
  assert.equal(result.recovery, undefined);
  const other = { ...job, kind: "preview" as const };
  assert.equal(projectMotionJob(other), other);
});

test("正式 MCP 搜索、核读、track_job 与恢复均精简出口，完整记录仍可供 Worker 续接", async () => {
  const directory = await mkdtemp(join(tmpdir(), "motion-output-mcp-"));
  const app = createApplication(directory);
  const projectId = app.createProject({ name: "机制返回隔离测试" }).snapshot.project.id;
  const client = new Client({ name: "机制返回协议回归", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(),
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), VIDEOCUT_WORKSPACE: directory }, stderr: "pipe" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    return JSON.parse((response.content as Array<{ text: string }>)[0].text);
  };
  try {
    await client.connect(transport);
    const request = { project_id: projectId, query: "保持前景，后层逐项建立", limit: 2 };
    const first = await call("search_motion_mechanisms", request);
    const jobId = first.diagnostics.job_id;
    assert.ok(jobId);
    assert.equal(first.cards.length, 2);
    assert.equal(first.cards[0].search_text, undefined);
    assert.ok(first.cards[0].relation);
    const pending = await call("track_job", { job_id: jobId });
    assert.equal(pending.status, "queued");
    assert.equal(pending.payload, undefined);
    const raw = { ...first, cards: first.cards.map((card: object) => ({ ...card, search_text: privateData, futureInternalField: privateData })),
      diagnostics: { mode: "hybrid", semantic_used: true, source_sha256: first.source_sha256, privateData },
      externalRuns: { finished: { status: "succeeded", runId: "finished", text: privateData, textOutputs: [{ text: privateData }] } }, futureInternalField: privateData };
    app.updateJob(jobId, { status: "succeeded", result: raw });
    for (const result of [await call("search_motion_mechanisms", request), await call("track_job", { job_id: jobId })]) assertCompact(result);
    assert.deepEqual(app.trackJob(jobId).result, raw);
    const read = await call("read_motion_mechanism", { id: first.cards[0].id, source_sha256: first.source_sha256, include_storyboard: false });
    assert.ok(read.body.includes("运动指令"));
    assert.ok(read.card.storyboard && read.card.clip.path && read.video_path);
    assert.equal(read.card.search_text, undefined);
    const failedResult = { ...raw, diagnostic: { code: "BRIDGE_RUN_FAILED", message: "服务运行失败", stack: privateData }, externalRuns: {
      ...raw.externalRuns, active: { status: "failed", runId: "recoverable-run", workflowId: "embedding", schemaVersion: "1", text: privateData }
    } };
    for (const status of ["failed", "cancelled", "unknown"] as const) {
      app.updateJob(jobId, { status, error: "服务运行失败", result: failedResult });
      const search = await call("search_motion_mechanisms", request), tracked = await call("track_job", { job_id: jobId });
      assertCompact(search); assertCompact(tracked);
      assert.equal(search.diagnostics.status, status);
      assert.equal(search.diagnostics.failure.code, "BRIDGE_RUN_FAILED");
      assert.deepEqual(tracked.recovery.runs.map((run: any) => run.runId), ["recoverable-run"]);
      assert.equal(tracked.recovery.action, status === "unknown" ? "reconcile" : "retry");
      assert.equal(app.listJobs(projectId).length, 1, "失败与未知查询不创建新任务");
    }
    app.updateJob(jobId, { status: "failed", result: { diagnostic: { code: "MOTION_LIBRARY_STALE", message: "来源已变化" } } });
    assert.equal((await call("track_job", { job_id: jobId })).recovery.action, "refresh_search");
    app.updateJob(jobId, { status: "failed", result: failedResult });
    const retry = await call("retry_media_job", { project_id: projectId, job_id: jobId });
    assert.equal(retry.retryOfJobId, jobId);
    assert.equal(retry.payload, undefined);
    assert.equal((await call("search_motion_mechanisms", request)).diagnostics.job_id, retry.id);
    assert.deepEqual(app.trackJob(jobId).result, failedResult);
    const analyzed = await call("analyze_motion_reference", { project_id: projectId, id: first.cards[0].id, source_sha256: first.source_sha256, range: { startMs: 0, endMs: 1000 } });
    assert.equal(analyzed.kind, "motion_reference_analysis");
    assert.equal(analyzed.payload, undefined);
    assert.deepEqual(analyzed.range, { startMs: 0, endMs: 1000 });
    assert.equal(app.readProject(projectId).revision.number, 1);
  } finally {
    await client.close(); await transport.close(); app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
