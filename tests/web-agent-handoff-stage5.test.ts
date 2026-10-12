import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { DomainError } from "@videocut/domain";
import { createServer } from "../apps/server/src/app.js";

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    assert.fail("MCP 应返回标准 content 结果");
  }
  const first = result.content[0];
  if (!first || typeof first !== "object" || !("type" in first) || first.type !== "text" || !("text" in first) || typeof first.text !== "string") {
    assert.fail("MCP 应返回文本内容");
  }
  return first.text;
}

test("Agent 工作单只保存对象引用，并经 Revision 接手和完成回写", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-agent-work-order-"));
  const application = createApplication(root);
  try {
    const created = application.createProject({ name: "工作单对象测试" });
    const projectId = created.snapshot.project.id;
    const imported = application.registerImportedAsset({
      projectId,
      baseRevision: created.revision.number,
      name: "source.mp4",
      kind: "video",
      managedPath: "assets/source/source.mp4",
      sourceHash: "agent-work-order-source"
    });
    const createdOrder = application.createAgentWorkOrder({
      projectId,
      baseRevision: imported.state.revision.number,
      title: "收紧开场",
      intent: "保留问题本身，删除重复停顿，并复核第一个转折的观看节奏。",
      relatedObjectIds: [imported.asset.id]
    });
    const workOrder = createdOrder.workOrder;
    assert.equal(createdOrder.state.revision.number, imported.state.revision.number + 1);
    assert.equal(workOrder.createdRevision, createdOrder.state.revision.number);
    assert.deepEqual(workOrder.relatedObjectIds, [imported.asset.id]);
    assert.equal("timeline" in (workOrder as unknown as Record<string, unknown>), false, "工作单不得复制 Timeline");
    assert.equal(createdOrder.state.snapshot.timeline.items.length, 0, "创建交接单不得改动 Timeline");

    const beforeInvalid = application.readProject(projectId);
    assert.throws(
      () => application.createAgentWorkOrder({
        projectId,
        baseRevision: beforeInvalid.revision.number,
        title: "错误关联",
        intent: "不能关联当前 Revision 中不存在的对象。",
        relatedObjectIds: ["missing-object"]
      }),
      DomainError
    );
    assert.equal(application.readProject(projectId).revision.number, beforeInvalid.revision.number, "失败创建不能污染 Revision");

    const cancelledOrder = application.createAgentWorkOrder({
      projectId,
      baseRevision: beforeInvalid.revision.number,
      title: "不再需要的检查",
      intent: "用户已改为自行处理，因此该工作单应可在接手前取消。"
    });
    const cancelled = application.cancelAgentWorkOrder({
      projectId,
      baseRevision: cancelledOrder.state.revision.number,
      workOrderId: cancelledOrder.workOrder.id,
      reason: "用户撤回需求"
    });
    assert.equal(cancelled.workOrder.status, "cancelled");
    assert.equal(cancelled.workOrder.cancelledRevision, cancelled.state.revision.number);

    const claimed = application.claimAgentWorkOrder({
      projectId,
      baseRevision: cancelled.state.revision.number,
      workOrderId: workOrder.id,
      agentId: "codex-stage5-test"
    });
    assert.equal(claimed.workOrder.status, "claimed");
    assert.equal(claimed.workOrder.claimedRevision, claimed.state.revision.number);
    assert.throws(() => application.claimAgentWorkOrder({
      projectId,
      baseRevision: cancelled.state.revision.number,
      workOrderId: workOrder.id,
      agentId: "concurrent-codex"
    }), "并发接手必须被 Revision 冲突拒绝");

    assert.throws(() => application.completeAgentWorkOrder({
      projectId,
      baseRevision: claimed.state.revision.number,
      workOrderId: workOrder.id,
      agentId: "codex-stage5-test",
      completionSummary: "不能把尚未编辑的工作单伪装成已完成。",
      completionKind: "edited"
    }), DomainError);
    assert.throws(() => application.releaseAgentWorkOrder({
      projectId,
      baseRevision: claimed.state.revision.number,
      workOrderId: workOrder.id,
      agentId: "another-codex",
      reason: "错误接手者不能释放"
    }), DomainError);
    const released = application.releaseAgentWorkOrder({
      projectId,
      baseRevision: claimed.state.revision.number,
      workOrderId: workOrder.id,
      agentId: "codex-stage5-test",
      reason: "需要重新读取素材上下文，交回队列。"
    });
    assert.equal(released.workOrder.status, "open");
    assert.equal(released.workOrder.releasedRevision, released.state.revision.number);
    const reclaimed = application.claimAgentWorkOrder({
      projectId,
      baseRevision: released.state.revision.number,
      workOrderId: workOrder.id,
      agentId: "codex-stage5-test"
    });

    const edited = application.updateStory({
      projectId,
      baseRevision: reclaimed.state.revision.number,
      summary: "已根据工作单收紧开场，等待完成回写。"
    });
    const completed = application.completeAgentWorkOrder({
      projectId,
      baseRevision: edited.revision.number,
      workOrderId: workOrder.id,
      agentId: "codex-stage5-test",
      completionSummary: "已更新 Story 摘要；真实剪辑改动位于结果 Revision，未创建第二份时间线。",
      completionKind: "edited"
    });
    assert.equal(completed.workOrder.status, "completed");
    assert.equal(completed.workOrder.resultRevision, edited.revision.number);
    assert.equal(completed.workOrder.completedRevision, completed.state.revision.number);
    assert.equal(completed.workOrder.completionSummary?.includes("Story 摘要"), true);
    assert.equal(completed.workOrder.resultChangedObjectIds?.includes(completed.state.snapshot.story.id), true);
    assert.equal(completed.workOrder.resultImpact?.revisions.length, 1);
    assert.equal(completed.state.snapshot.story.summary, "已根据工作单收紧开场，等待完成回写。");
    assert.equal(completed.state.snapshot.timeline.items.length, 0, "完成回写不得复制或改写 Timeline");

    const reviewOrder = application.createAgentWorkOrder({
      projectId,
      baseRevision: completed.state.revision.number,
      title: "审查后无需修改",
      intent: "确认当前开场已经满足要求，若无需改动必须明确写回审查结论。"
    });
    const reviewClaimed = application.claimAgentWorkOrder({
      projectId,
      baseRevision: reviewOrder.state.revision.number,
      workOrderId: reviewOrder.workOrder.id,
      agentId: "codex-stage5-test"
    });
    const reviewed = application.completeAgentWorkOrder({
      projectId,
      baseRevision: reviewClaimed.state.revision.number,
      workOrderId: reviewOrder.workOrder.id,
      agentId: "codex-stage5-test",
      completionSummary: "已完整审查开场；无需改变当前 Revision。",
      completionKind: "reviewed_no_change"
    });
    assert.equal(reviewed.workOrder.completionKind, "reviewed_no_change");
    assert.equal(reviewed.workOrder.resultChangedObjectIds, undefined);

    const staleOrder = application.createAgentWorkOrder({
      projectId,
      baseRevision: reviewed.state.revision.number,
      title: "关联对象消失",
      intent: "对象从当前 Revision 移除后，接手必须被阻止。",
      relatedObjectIds: [imported.asset.id]
    });
    const removed = application.repository.commit(projectId, staleOrder.state.revision.number, "测试移除关联素材", (snapshot, impact) => {
      snapshot.assets = snapshot.assets.filter((asset) => asset.id !== imported.asset.id);
      impact.changed.push(imported.asset.id);
    });
    assert.throws(() => application.claimAgentWorkOrder({
      projectId,
      baseRevision: removed.revision.number,
      workOrderId: staleOrder.workOrder.id,
      agentId: "codex-stage5-test"
    }), DomainError);
  } finally {
    application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Web 创建的 Agent 工作单可由 MCP 读取、接手、编辑后完成", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-agent-web-mcp-"));
  const { app: server, application } = await createServer({ workspaceRoot });
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: workspaceRoot },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-agent-work-order-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const createdResponse = await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Web 到 Codex 交接" } });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json() as { revision: { number: number }; snapshot: { project: { id: string } } };
    const projectId = created.snapshot.project.id;

    const webCreatedResponse = await server.inject({
      method: "POST",
      url: `/api/projects/${projectId}/agent-work-orders`,
      payload: {
        baseRevision: created.revision.number,
        title: "为开场建立可执行方案",
        intent: "检查 Story 的开场承诺，保留完整论点，并回写本次实际 Revision。",
        relatedObjectIds: [projectId]
      }
    });
    assert.equal(webCreatedResponse.statusCode, 201);
    const webCreated = webCreatedResponse.json() as { state: { revision: { number: number } }; workOrder: { id: string; status: string } };
    assert.equal(webCreated.workOrder.status, "open");

    const webCancelCreatedResponse = await server.inject({
      method: "POST",
      url: `/api/projects/${projectId}/agent-work-orders`,
      payload: {
        baseRevision: webCreated.state.revision.number,
        title: "Web 取消测试",
        intent: "未被 Codex 接手前，用户应可撤回这条工作单。"
      }
    });
    assert.equal(webCancelCreatedResponse.statusCode, 201);
    const webCancelCreated = webCancelCreatedResponse.json() as { state: { revision: { number: number } }; workOrder: { id: string } };
    const webCancelledResponse = await server.inject({
      method: "POST",
      url: `/api/projects/${projectId}/agent-work-orders/${webCancelCreated.workOrder.id}/cancel`,
      payload: { baseRevision: webCancelCreated.state.revision.number, reason: "用户已经自行处理" }
    });
    assert.equal(webCancelledResponse.statusCode, 200);
    const webCancelled = webCancelledResponse.json() as { state: { revision: { number: number } }; workOrder: { status: string } };
    assert.equal(webCancelled.workOrder.status, "cancelled");

    await client.callTool({ name: "target_project", arguments: { project_id: projectId } });
    const readable = JSON.parse(textFromToolResult(await client.callTool({ name: "read_agent_work_orders", arguments: {} }))) as {
      revision: number;
      agentWorkOrders: Array<{ id: string; status: string; relatedObjectIds: string[] }>;
    };
    assert.equal(readable.revision, webCancelled.state.revision.number);
    assert.deepEqual(readable.agentWorkOrders[0]?.relatedObjectIds, [projectId]);

    const claimed = JSON.parse(textFromToolResult(await client.callTool({ name: "claim_agent_work_order", arguments: {
      base_revision_id: readable.revision,
      work_order_id: webCreated.workOrder.id,
      agent_id: "codex-mcp-test"
    } }))) as { state: { revision: { number: number } }; workOrder: { status: string } };
    assert.equal(claimed.workOrder.status, "claimed");

    const released = JSON.parse(textFromToolResult(await client.callTool({ name: "release_agent_work_order", arguments: {
      base_revision_id: claimed.state.revision.number,
      work_order_id: webCreated.workOrder.id,
      agent_id: "codex-mcp-test",
      reason: "需要让另一轮 Codex 重新接手。"
    } }))) as { state: { revision: { number: number } }; workOrder: { status: string; releaseReason: string } };
    assert.equal(released.workOrder.status, "open");
    assert.match(released.workOrder.releaseReason, /重新接手/u);
    const reclaimed = JSON.parse(textFromToolResult(await client.callTool({ name: "claim_agent_work_order", arguments: {
      base_revision_id: released.state.revision.number,
      work_order_id: webCreated.workOrder.id,
      agent_id: "codex-mcp-test"
    } }))) as { state: { revision: { number: number } }; workOrder: { status: string } };
    assert.equal(reclaimed.workOrder.status, "claimed");

    const edited = JSON.parse(textFromToolResult(await client.callTool({ name: "manage_story", arguments: {
      base_revision_id: reclaimed.state.revision.number,
      summary: "Codex 已完成工作单要求的开场承诺复核。"
    } }))) as { revision: { number: number } };

    const completed = JSON.parse(textFromToolResult(await client.callTool({ name: "complete_agent_work_order", arguments: {
      base_revision_id: edited.revision.number,
      work_order_id: webCreated.workOrder.id,
      agent_id: "codex-mcp-test",
      completion_summary: "已在实际 Revision 更新 Story 开场承诺；完成状态另存为新的审计 Revision。",
      completion_kind: "edited"
    } }))) as { state: { revision: { number: number } }; workOrder: { status: string; resultRevision: number; completedRevision: number } };
    assert.equal(completed.workOrder.status, "completed");
    assert.equal(completed.workOrder.resultRevision, edited.revision.number);
    assert.equal(completed.workOrder.completedRevision, completed.state.revision.number);

    const webReadResponse = await server.inject({ method: "GET", url: `/api/projects/${projectId}/agent-work-orders` });
    assert.equal(webReadResponse.statusCode, 200);
    const webRead = webReadResponse.json() as { revision: number; agentWorkOrders: Array<{ status: string; completionSummary?: string }> };
    assert.equal(webRead.revision, completed.state.revision.number);
    assert.equal(webRead.agentWorkOrders[0]?.status, "completed");
    assert.match(webRead.agentWorkOrders[0]?.completionSummary ?? "", /实际 Revision/u);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close();
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
