import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";

test("发行 MCP 非部署收口验证角色、分类、持久化及视频 Revision 隔离", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-repair-resolution-mcp-"));
  const seed = createApplication(root);
  const project = seed.createProject({ name: "候选工单收口验证" });
  const projectId = project.snapshot.project.id;
  const revision = project.revision.number;
  const kinds = ["invalid_input", "duplicate", "external_recovery"] as const;
  const tickets = kinds.map((kind) => {
    const ticket = seed.reportEditingBlocker({ projectId, reportedRevision: revision,
      category: "tool_error", summary: "仅用于候选工单调用链验证", reporterId: "editor",
      reportedReleaseId: `release-${"a".repeat(64)}`, idempotencyKey: kind });
    seed.claimRepairTicket({ ticketId: ticket.id, repairerId: "repairer" });
    return ticket;
  });
  seed.close();
  // 直接连接本次发行入口，只访问独立临时库，不启动生产 Runtime。
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("plugins/videoflowcut/runtime/dist/mcp.cjs")], cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: root }, stderr: "pipe" });
  const client = new Client({ name: "repair-resolution-regression", version: "1.0.0" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((entry) => entry.type === "text")?.text;
    assert.ok(text);
    return { result, value: JSON.parse(text) };
  };
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const tool = catalog.tools.find((entry) => entry.name === "resolve_repair_ticket_without_deployment");
    assert.ok(tool, "发行工具目录必须包含 Skills 指定的收口工具");
    assert.deepEqual(tool.inputSchema.required, ["ticket_id", "repairer_id", "kind", "evidence"]);
    const evidence = "已核对原始调用与当前事实，仅按明确的非部署原因收口，不宣称代码已部署。";
    const wrongRole = await call(tool.name, { ticket_id: tickets[0]!.id,
      repairer_id: "another-repairer", kind: kinds[0], evidence });
    assert.equal(wrongRole.result.isError, true);
    assert.equal(wrongRole.value.code, "REPAIR_TICKET_CLAIMER_MISMATCH");
    const untouched = await call("list_repair_tickets", { project_id: projectId, statuses: ["claimed"] });
    assert.equal(untouched.value.repairTickets.length, 3);
    for (const [index, kind] of kinds.entries()) {
      const resolved = await call(tool.name, { ticket_id: tickets[index]!.id,
        repairer_id: "repairer", kind, evidence });
      assert.notEqual(resolved.result.isError, true);
      assert.equal(resolved.value.status, "resolved_without_deployment");
      assert.equal(resolved.value.resolutionKind, kind);
      assert.equal(resolved.value.resolutionEvidence, evidence);
      assert.equal(resolved.value.deployedReleaseId, undefined);
    }
    const repeat = await call(tool.name, { ticket_id: tickets[0]!.id,
      repairer_id: "repairer", kind: kinds[0], evidence });
    assert.equal(repeat.result.isError, true);
    assert.equal(repeat.value.code, "REPAIR_TICKET_NOT_CLAIMED");
    const listed = await call("list_repair_tickets", { project_id: projectId, statuses: ["resolved_without_deployment"] });
    assert.equal(listed.value.repairTickets.length, 3);
    assert.equal(listed.value.revision, revision);
  } finally {
    await client.close();
    await transport.close();
    const reopened = createApplication(root);
    try {
      assert.equal(reopened.readRevisions(projectId).length, 1);
      const saved = reopened.readRepairTickets({ projectId }).repairTickets;
      assert.deepEqual(saved.map((ticket) => ticket.resolutionKind).sort(), [...kinds].sort());
      assert.ok(saved.every((ticket) => ticket.releaseReason === undefined && ticket.validationSummary === undefined));
    } finally { reopened.close(); await rm(root, { recursive: true, force: true }); }
  }
});
