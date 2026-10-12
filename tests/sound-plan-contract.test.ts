import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../apps/server/src/app.js";
import { registerSoundTools } from "../apps/server/src/sound-tools.js";

const plan = { action: "create", startFrame: 0, endFrame: 240, narrationDirection: "说明当前问题", dominantRole: "narration", musicDirection: "结论处留白", intents: [{ id: "settle", function: "settle", brief: "说明完成时落定" }] };

test("声音计划的真实 MCP Schema 按操作声明必填字段，缺范围不产生 Revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-sound-plan-mcp-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  const created = application.createProject({ name: "配音前声音计划隔离回归", profile: "visual_explainer" });
  const projectId = created.snapshot.project.id;
  const revision = () => application.readProject(projectId).revision.number;
  const server = new McpServer({ name: "sound-plan-contract", version: "1.0.0" });
  const client = new Client({ name: "sound-plan-test", version: "1.0.0" });
  registerSoundTools(server, application, () => projectId);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "manage_sound_plans")!;
    const schema = tool.inputSchema.properties?.input as { anyOf: Array<{ properties: Record<string, { const?: string; enum?: string[] }>; required: string[] }> };
    const branch = (action: string) => schema.anyOf.find((entry) => entry.properties.action.const === action || entry.properties.action.enum?.includes(action))!;
    assert.deepEqual([...branch("create").required].sort(), ["action", "startFrame", "endFrame", "narrationDirection", "dominantRole", "musicDirection", "intents"].sort());
    assert.deepEqual([...branch("update").required].sort(), ["action", "soundPlanId"]);
    assert.deepEqual([...branch("remove").required].sort(), ["action", "soundPlanId"]);
    assert.match(tool.description!, /预估帧范围.*实测时长/u);
    const call = (input?: Record<string, unknown>, base = revision()) => client.callTool({ name: "manage_sound_plans", arguments: { project_id: projectId, ...(input ? { base_revision_id: base, input } : {}) } });
    const initialRevision = revision();
    for (const field of ["startFrame", "endFrame", "narrationDirection", "dominantRole", "musicDirection", "intents"]) {
      const missing: Record<string, unknown> = { ...plan }; delete missing[field];
      assert.equal((await call(missing)).isError, true, `创建时缺少 ${field} 必须拒绝`);
      assert.equal(revision(), initialRevision);
    }
    assert.equal((await call()).isError, undefined);
    assert.equal(revision(), initialRevision, "读取不得生成 Revision");
    assert.notEqual((await call(plan)).isError, true);
    let state = application.readProject(projectId);
    const saved = state.snapshot.soundPlans![0];
    assert.equal(state.snapshot.timeline.durationInFrames, 0, "配音前可保存预估范围，不伪造 Timeline 时长");
    assert.equal(saved.endFrame, 240);
    assert.notEqual((await call({ action: "update", soundPlanId: saved.id, endFrame: 216 })).isError, true);
    state = application.readProject(projectId);
    assert.equal(state.snapshot.soundPlans![0].startFrame, 0);
    assert.equal(state.snapshot.soundPlans![0].endFrame, 216);
    assert.equal(state.snapshot.soundPlans![0].narrationDirection, plan.narrationDirection);
    const beforeRejected = revision();
    assert.equal((await call({ action: "update", soundPlanId: saved.id, startFrame: 216 })).isError, true);
    assert.equal((await call({ action: "update", soundPlanId: saved.id, endFrame: 300 }, initialRevision)).isError, true);
    assert.equal(revision(), beforeRejected, "范围错误和旧 Revision 均不能落地");
    assert.notEqual((await call({ action: "remove", soundPlanId: saved.id })).isError, true);
    assert.equal(application.readProject(projectId).snapshot.soundPlans!.length, 0);
    const opening = { ...plan, endFrame: 396, dominantRanges: [
      { startFrame: 0, endFrame: 8, role: "music", reason: "轻入，不制造原片动作声" },
      { startFrame: 8, endFrame: 69, role: "narration", reason: "第一段中文讲述" },
      { startFrame: 69, endFrame: 151, role: "music", reason: "观看连续追近与交手，音乐保持低密度" },
      { startFrame: 151, endFrame: 197, role: "narration", reason: "第二段提问" },
      { startFrame: 197, endFrame: 236, role: "music", reason: "切入另一处场馆并先看见递麦" },
      { startFrame: 236, endFrame: 334, role: "narration", reason: "第三段讲述明确不同场面及结句" },
      { startFrame: 334, endFrame: 396, role: "music", reason: "只承接人物与下一句话的短收势" }
    ], intents: [{ id: "bgm_game_to_interview_minimal", function: "music", brief: "无语音、低密度器乐" }] };
    const openingResult = await call(opening);
    assert.notEqual(openingResult.isError, true, JSON.stringify(openingResult));
    assert.equal(application.readProject(projectId).snapshot.soundPlans![0].dominantRanges?.length, 7);
  } finally {
    await client.close(); await server.close(); await app.close(); application.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("声音计划 HTTP 入口沿用相同创建合同和局部更新校验", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-sound-plan-http-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  try {
    const created = application.createProject({ name: "声音计划 HTTP 隔离回归", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const state = () => application.readProject(projectId);
    const call = (value: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/projects/${projectId}/sound-plans`, payload: { baseRevision: state().revision.number, plan: value } });
    const { startFrame, endFrame, ...missingRange } = plan;
    assert.equal((await call(missingRange)).statusCode, 400);
    assert.equal(state().revision.number, created.revision.number);
    assert.equal((await call(plan)).statusCode, 200);
    const soundPlanId = state().snapshot.soundPlans![0].id;
    const beforeRejected = state().revision.number;
    assert.equal((await call({ action: "update", endFrame: 200 })).statusCode, 400);
    assert.equal((await call({ action: "update", soundPlanId, startFrame: -1 })).statusCode, 400);
    assert.equal(state().revision.number, beforeRejected);
    assert.equal((await call({ action: "update", soundPlanId, musicDirection: "全段留白" })).statusCode, 200);
    assert.equal(state().snapshot.soundPlans![0].endFrame, endFrame);
    assert.equal(state().snapshot.soundPlans![0].startFrame, startFrame);
  } finally { await app.close(); application.repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("配音前声音计划交接明确预估范围与实测更新", async () => {
  const contract = await readFile(".agents/skills/audio-finishing/references/audio-operations.md", "utf8");
  const director = await readFile(".agents/skills/visual-explainer-director/references/explanation-design.md", "utf8");
  assert.match(contract, /input.action=create.*必须提供 startFrame、endFrame/u);
  assert.match(contract, /预估秒数.*update.*实测时长/u);
  assert.match(director, /预估秒数.*startFrame\/endFrame.*soundPlanId.*实测范围/u);
});
