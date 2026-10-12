import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import type { CreativeDelegation, SkillExecutionReport } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videocut-delegation-"));
  const app = createApplication(root);
  const created = app.createProject({ name: "子代理来源回归测试（隔离项目）" });
  const projectId = created.snapshot.project.id;
  const run = await app.startProductionRun({ projectId, loadedSkills: ["production-coordinator", "remotion-production"] });
  const reportPath = join(created.snapshot.project.rootPath, "reports", `production-run-${run.id}.json`);
  const base = { projectId, runId: run.id, category: "visual" as const, decision: "保留完整关系变化", rationale: "测试审计读回，不代表实际子代理创作或审美通过" };
  const delegation: CreativeDelegation = { agentId: "/fixture/motion", assignmentId: "motion-01", role: "specialist", inputRevision: 1 };
  return { root, app, created, projectId, run, reportPath, base, delegation, dispose: async () => {
    app.close();
    // 只清理本测试亲自创建的临时工作区，禁止扩大到共享项目目录。
    assert.ok(relative(resolve(tmpdir()), resolve(root)).startsWith("videocut-delegation-"));
    await rm(root, { recursive: true, force: true });
  } };
}

test("委派来源保存真实输入历史，不重定基、不写入视频 Revision", async () => {
  const f = await fixture();
  try {
    f.app.updateStory({ projectId: f.projectId, baseRevision: 1, title: "后续已更新到 R2" });
    const before = f.app.readProject(f.projectId);
    const history = f.app.readRevisions(f.projectId);
    const recorded = await f.app.recordCreativeDecision({ ...f.base, delegation: { ...f.delegation, agentId: " /fixture/motion ", assignmentId: " motion-01 " }, objectIds: [before.snapshot.story.id], evidence: ["fixture-only:preview-reference"] });
    assert.deepEqual(recorded.creativeDecisions[0].delegation, f.delegation);
    assert.deepEqual(recorded.creativeDecisions[0].objectIds, [before.snapshot.story.id]);
    assert.deepEqual(recorded.creativeDecisions[0].evidence, ["fixture-only:preview-reference"]);
    const readBack = await f.app.readSkillExecutionReport({ projectId: f.projectId, runId: f.run.id });
    assert.deepEqual(readBack.creativeDecisions, JSON.parse(JSON.stringify(recorded.creativeDecisions)));
    assert.equal(readBack.creativeDecisions[0].delegation!.inputRevision, 1);
    assert.deepEqual(f.app.readProject(f.projectId), before);
    assert.deepEqual(f.app.readRevisions(f.projectId), history);
    assert.equal("verified" in readBack.creativeDecisions[0].delegation!, false, "来源记录不能冒充宿主认证");
  } finally { await f.dispose(); }
});

test("无效委派来源和不存在的本项目版本在落盘前拒绝", async () => {
  const f = await fixture();
  try {
    const other = f.app.createProject({ name: "另一个隔离项目" });
    f.app.updateStory({ projectId: other.snapshot.project.id, baseRevision: 1, title: "只有另一项目有 R2" });
    const before = await readFile(f.reportPath, "utf8");
    const invalid: unknown[] = [null, [], "agent", {}, { ...f.delegation, agentId: " " }, { ...f.delegation, agentId: "a".repeat(161) }, { ...f.delegation, assignmentId: "" }, { ...f.delegation, assignmentId: "a".repeat(161) }, { ...f.delegation, role: "coordinator" }, ...[0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((inputRevision) => ({ ...f.delegation, inputRevision }))];
    for (const delegation of invalid) {
      await assert.rejects(() => f.app.recordCreativeDecision({ ...f.base, delegation: delegation as CreativeDelegation }), (error: unknown) => error instanceof DomainError && error.code === "INVALID_CREATIVE_DELEGATION");
    }
    await assert.rejects(() => f.app.recordCreativeDecision({ ...f.base, delegation: { ...f.delegation, inputRevision: 2 } }), /版本|Revision|revision/u);
    assert.equal(await readFile(f.reportPath, "utf8"), before, "拒绝后审计不能部分写入");
    assert.equal(f.app.readProject(f.projectId).revision.number, 1);
  } finally { await f.dispose(); }
});

test("旧报告和无委派来源的明确操作保持兼容，来源不足不升级交付状态", async () => {
  const f = await fixture();
  try {
    const legacy = await f.app.recordCreativeDecision(f.base);
    assert.equal("delegation" in legacy.creativeDecisions[0], false);
    const oldFile = JSON.parse(await readFile(f.reportPath, "utf8"));
    delete oldFile.composedFrameEvidence;
    delete oldFile.completionBlockers;
    await writeFile(f.reportPath, JSON.stringify(oldFile));
    const readBack = await f.app.readSkillExecutionReport({ projectId: f.projectId, runId: f.run.id });
    assert.equal("delegation" in readBack.creativeDecisions[0], false);
    await f.app.recordCreativeDecision({ ...f.base, delegation: f.delegation });
    const completed = await f.app.completeProductionRun({ projectId: f.projectId, runId: f.run.id });
    assert.equal(completed.status, "incomplete", "填写来源不能替代真实声画和审片证据");
    assert.ok(completed.completionBlockers.length > 0);
    assert.equal(f.app.readRevisions(f.projectId).length, 1);
  } finally { await f.dispose(); }
});

test("不同职责并发追加来源不丢失，允许同一次分派产生多个决定", async () => {
  const f = await fixture();
  try {
    await Promise.all((["director", "specialist", "reviewer"] as const).map((role) => f.app.recordCreativeDecision({ ...f.base, delegation: { ...f.delegation, role }, category: role === "reviewer" ? "quality" : "visual" })));
    const report = await f.app.readSkillExecutionReport({ projectId: f.projectId, runId: f.run.id });
    assert.deepEqual(report.creativeDecisions.map((entry) => entry.delegation!.role).sort(), ["director", "reviewer", "specialist"]);
    assert.equal(f.app.readRevisions(f.projectId).length, 1);
  } finally { await f.dispose(); }
});

test("实时 MCP Schema 接收可选 delegation，并原样关联输入版本与现有证据", async () => {
  const f = await fixture();
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(), env: { ...getDefaultEnvironment(), VIDEOCUT_WORKSPACE: f.root }, stderr: "pipe" });
  const client = new Client({ name: "creative-delegation-regression", version: "1.0.0" });
  const parse = (result: unknown): SkillExecutionReport => {
    const value = result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    assert.notEqual(value.isError, true, JSON.stringify(value.content));
    return JSON.parse(value.content.find((entry) => entry.type === "text")!.text!);
  };
  try {
    await client.connect(transport);
    const schema = (await client.listTools()).tools.find((tool) => tool.name === "record_creative_decision")!.inputSchema;
    const source = schema.properties!.delegation as { required: string[]; properties: Record<string, { enum?: string[] }> };
    assert.deepEqual([...source.required].sort(), ["agent_id", "assignment_id", "input_revision", "role"]);
    assert.deepEqual(source.properties.role.enum, ["director", "specialist", "reviewer"]);
    assert.ok(!schema.required?.includes("delegation"));
    const args = { project_id: f.projectId, run_id: f.run.id, category: "visual", decision: f.base.decision, rationale: f.base.rationale };
    const recorded = parse(await client.callTool({ name: "record_creative_decision", arguments: { ...args, delegation: { agent_id: f.delegation.agentId, assignment_id: f.delegation.assignmentId, role: f.delegation.role, input_revision: 1 }, evidence: ["fixture-only:host-trace-reference"] } }));
    assert.deepEqual(recorded.creativeDecisions[0].delegation, f.delegation);
    const legacy = parse(await client.callTool({ name: "record_creative_decision", arguments: args }));
    assert.equal("delegation" in legacy.creativeDecisions[1], false);
    for (const delegation of [{ agent_id: " ", assignment_id: "case", role: "specialist", input_revision: 1 }, { agent_id: "agent", assignment_id: "case", role: "coordinator", input_revision: 1 }, { agent_id: "agent", assignment_id: "case", role: "specialist", input_revision: 99 }]) {
      const result = await client.callTool({ name: "record_creative_decision", arguments: { ...args, delegation } });
      assert.equal(result.isError, true);
    }
    const readBack = parse(await client.callTool({ name: "read_skill_execution_report", arguments: { project_id: f.projectId, run_id: f.run.id } }));
    assert.equal(readBack.creativeDecisions.length, 2);
    assert.deepEqual(readBack.creativeDecisions[0].delegation, f.delegation);
    assert.equal(f.app.readRevisions(f.projectId).length, 1);
  } finally { await client.close(); await f.dispose(); }
});

test("完整声画稿走现有附件引用，MCP读回保留中途、末段与变更前后身份", async () => {
  const f = await fixture();
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(), env: { ...getDefaultEnvironment(), VIDEOCUT_WORKSPACE: f.root }, stderr: "pipe" });
  const client = new Client({ name: "full-script-handoff-regression", version: "1.0.0" });
  const parse = (result: unknown): SkillExecutionReport => {
    const raw = result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    // 先保留原始文本并检查错误；协议层拒绝不一定是 JSON。
    const original = raw.content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
    assert.notEqual(raw.isError, true, original);
    return JSON.parse(original);
  };
  try {
    await client.connect(transport);
    const schema = (await client.listTools()).tools.find(tool => tool.name === "record_creative_decision")!.inputSchema;
    assert.ok(schema.properties?.evidence);
    assert.equal(schema.properties?.fullCreativeScript, undefined, "完整稿不扩为未经采用的新接口字段");
    const script = "# 当前整片声画稿 v1\n" + "本段为开发夹具，事实与源范围尚未核验。\n".repeat(1_000)
      + "## 关键中途\n旧主体仍在场时新内容开始可读；源时钟继续。\n## 末段\n结尾只完成材料支持的认识，保留未核实条件。\n";
    const path = join(f.created.snapshot.project.rootPath, "reports", "声画稿-v1.md");
    await writeFile(path, script, "utf8");
    const checksum = createHash("sha256").update(script).digest("hex");
    // 附件和素材引用由宿主提供，平台只存已有 evidence；不冒充媒体或宿主可读性认证。
    const evidence = [path, `sha256:${checksum}`, "fixture-only:source-range-v1", "fixture-only:preview-R1-v1", "fixture-only:speech-v1:sentence-level"];
    const input = { project_id: f.projectId, run_id: f.run.id, category: "visual", decision: "采用当前全文引用，设计与动态仍待实际验证", rationale: "长稿不挤入摘要，不用历史预览为新版背书" };
    for (const role of ["director", "specialist", "reviewer"]) {
      const result = parse(await client.callTool({ name: "record_creative_decision", arguments: { ...input, evidence, delegation: { agent_id: `/fixture/${role}`, assignment_id: `handoff-${role}`, role, input_revision: 1 } } }));
      const entry = result.creativeDecisions.at(-1)!;
      assert.deepEqual(entry.evidence, evidence);
      assert.equal(await readFile(entry.evidence[0], "utf8"), script, "接收引用后全文含中途与末段，不得截断");
    }
    f.app.updateStory({ projectId: f.projectId, baseRevision: 1, title: "夹具后续版本；并未生成新媒体" });
    const updated = script.replace("声画稿 v1", "声画稿 v2").replace("源时钟继续。", "源时钟继续；新配音句群起点后移，动作与字幕重新校准。");
    const nextPath = join(f.created.snapshot.project.rootPath, "reports", "声画稿-v2.md");
    await writeFile(nextPath, updated, "utf8");
    const nextEvidence = [nextPath, "fixture-only:source-range-v1", "fixture-only:speech-v2:sentence-level", "fixture-only:preview-v2-pending"];
    await client.callTool({ name: "record_creative_decision", arguments: { ...input, evidence: nextEvidence, delegation: { agent_id: "/fixture/specialist", assignment_id: "handoff-specialist", role: "specialist", input_revision: 2 } } }).then(parse);
    const readBack = parse(await client.callTool({ name: "read_skill_execution_report", arguments: { project_id: f.projectId, run_id: f.run.id } }));
    assert.equal(readBack.creativeDecisions.length, 4);
    assert.deepEqual(readBack.creativeDecisions.slice(0, 3).map(entry => entry.evidence), [evidence, evidence, evidence]);
    assert.deepEqual(readBack.creativeDecisions[3].evidence, nextEvidence);
    assert.deepEqual(readBack.creativeDecisions.map(entry => entry.delegation?.inputRevision), [1, 1, 1, 2]);
    assert.equal(await readFile(path, "utf8"), script);
    assert.equal(await readFile(nextPath, "utf8"), updated);
    assert.equal(f.app.readRevisions(f.projectId).length, 2, "交接审计不创建视频 Revision");
  } finally { await client.close(); await f.dispose(); }
});
