import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication, RevisionConflictError } from "@videocut/application";
import { DomainError } from "@videocut/domain";

const firstRelease = `release-${"a".repeat(64)}`;
const repairedRelease = `release-${"b".repeat(64)}`;

test("Repair Ticket 独立于视频 Revision，并用角色、版本和当前 Revision 收口", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-repair-ticket-"));
  const application = createApplication(root);
  try {
    const created = application.createProject({ name: "修复工单协调测试" });
    const projectId = created.snapshot.project.id;
    const beforeReportRevision = application.readProject(projectId).revision.number;
    const beforeReportHistory = application.readRevisions(projectId).length;

    const ticket = application.reportEditingBlocker({
      projectId,
      reportedRevision: beforeReportRevision,
      category: "tool_error",
      summary: "预览工具返回可复现错误，剪辑任务必须暂停。",
      detail: "已记录输入、当前 Revision 和脱敏错误文本；没有继续重放不确定写入。",
      toolName: "render_preview_range",
      reporterId: "editor-task-1",
      reportedReleaseId: firstRelease,
      idempotencyKey: "preview-failure-at-r1"
    });
    assert.equal(ticket.status, "open");
    assert.equal(application.readProject(projectId).revision.number, beforeReportRevision, "报告阻断不得创建视频 Revision");
    assert.equal(application.readRevisions(projectId).length, beforeReportHistory, "Repair Ticket 不得进入 Revision 历史");
    assert.equal("repairTickets" in application.readProject(projectId).snapshot, false, "Repair Ticket 不得进入 ProjectSnapshot");

    const repeated = application.reportEditingBlocker({
      projectId,
      reportedRevision: beforeReportRevision,
      category: "tool_error",
      summary: "重复请求不得产生第二张工单。",
      reporterId: "editor-task-1",
      reportedReleaseId: firstRelease,
      idempotencyKey: "preview-failure-at-r1"
    });
    assert.equal(repeated.id, ticket.id, "相同报告必须按 reporter 与幂等键返回原 Ticket");

    assert.throws(() => application.claimRepairTicket({ ticketId: ticket.id, repairerId: "editor-task-1" }), DomainError, "剪辑任务不能自行接手修复");
    const claimed = application.claimRepairTicket({ ticketId: ticket.id, repairerId: "repair-task-1" });
    assert.equal(claimed.status, "claimed");
    assert.throws(() => application.claimRepairTicket({ ticketId: ticket.id, repairerId: "repair-task-2" }), DomainError, "claimed 状态不可重复接手");
    assert.throws(() => application.markRepairTicketReadyForCutover({
      ticketId: ticket.id,
      repairerId: "repair-task-2",
      candidateReleaseId: repairedRelease,
      validationSummary: "错误角色不能提交候选版。"
    }), DomainError);

    const ready = application.markRepairTicketReadyForCutover({
      ticketId: ticket.id,
      repairerId: "repair-task-1",
      candidateReleaseId: repairedRelease,
      validationSummary: "已在独立端口和独立工作区复现根因、完成回归，并验证候选 Runtime 的 API 与两个 Worker。"
    });
    assert.equal(ready.status, "ready_for_cutover");
    assert.throws(() => application.markRepairTicketDeployed({
      ticketId: ticket.id,
      repairerId: "repair-task-1",
      releaseId: firstRelease,
      deploymentEvidence: "错误发行版本不能部署。"
    }), DomainError, "部署版本必须与候选版完全一致");

    const deployed = application.markRepairTicketDeployed({
      ticketId: ticket.id,
      repairerId: "repair-task-1",
      releaseId: repairedRelease,
      deploymentEvidence: "新版 MCP 与 Runtime 均返回同一 Release ID，API、媒体 Worker 和渲染 Worker 健康。"
    });
    assert.equal(deployed.status, "deployed");
    assert.throws(() => application.acknowledgeRepairTicketDeployment({
      ticketId: ticket.id,
      editorId: "another-editor",
      releaseId: repairedRelease,
      observedRevision: beforeReportRevision
    }), DomainError, "只有原报告者可以确认恢复");
    assert.throws(() => application.acknowledgeRepairTicketDeployment({
      ticketId: ticket.id,
      editorId: "editor-task-1",
      releaseId: firstRelease,
      observedRevision: beforeReportRevision
    }), DomainError, "确认版本必须匹配部署版本");

    const changedProject = application.updateStory({
      projectId,
      baseRevision: beforeReportRevision,
      summary: "另一个合法剪辑写入已经改变当前 Revision。"
    });
    assert.throws(() => application.acknowledgeRepairTicketDeployment({
      ticketId: ticket.id,
      editorId: "editor-task-1",
      releaseId: repairedRelease,
      observedRevision: beforeReportRevision
    }), RevisionConflictError, "重连后必须基于真正的当前 Revision 确认");
    const acknowledged = application.acknowledgeRepairTicketDeployment({
      ticketId: ticket.id,
      editorId: "editor-task-1",
      releaseId: repairedRelease,
      observedRevision: changedProject.revision.number
    });
    assert.equal(acknowledged.status, "acknowledged");
    assert.equal(acknowledged.acknowledgedRevision, changedProject.revision.number);
    assert.equal(application.readRepairTickets({ projectId }).repairTickets[0]?.id, ticket.id);
  } finally {
    application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("输入错误和重复报告可凭证据非部署收口，不能冒充已部署", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-repair-resolution-"));
  const application = createApplication(root);
  try {
    const created = application.createProject({ name: "非部署收口验证" });
    const projectId = created.snapshot.project.id;
    const revision = created.revision.number;
    const ticket = application.reportEditingBlocker({ projectId, reportedRevision: revision,
      category: "tool_error", summary: "作品超过已公布像素帧预算", reporterId: "editor-a",
      reportedReleaseId: firstRelease, idempotencyKey: "budget" });
    application.claimRepairTicket({ ticketId: ticket.id, repairerId: "repair-b" });
    assert.throws(() => application.resolveRepairTicketWithoutDeployment({ ticketId: ticket.id,
      repairerId: "editor-a", kind: "invalid_input", evidence: "已复算像素帧预算，输入超出当前公开上限。" }), /原接手/u);
    assert.throws(() => application.resolveRepairTicketWithoutDeployment({ ticketId: ticket.id,
      repairerId: "repair-b", kind: "invalid_input", evidence: "太短" }), /分类或证据无效/u);
    const resolved = application.resolveRepairTicketWithoutDeployment({ ticketId: ticket.id,
      repairerId: "repair-b", kind: "invalid_input", evidence: "画布 1080×1920、360 帧超过 650000000 像素帧，提交前拒绝且未创建 Job。" });
    assert.equal(resolved.status, "resolved_without_deployment");
    assert.equal(resolved.resolutionKind, "invalid_input");
    assert.match(resolved.resolutionEvidence!, /未创建 Job/u);
    assert.equal(resolved.deployedReleaseId, undefined);
    assert.equal(application.readRepairTickets({ projectId, statuses: ["resolved_without_deployment"] }).repairTickets.length, 1);
    assert.equal(application.readProject(projectId).revision.number, revision);
    assert.throws(() => application.resolveRepairTicketWithoutDeployment({ ticketId: ticket.id,
      repairerId: "repair-b", kind: "invalid_input", evidence: "已处理完毕且有完整的预算复算与无 Job 证据。" }), /已接手/u);
  } finally { application.close(); await rm(root, { recursive: true, force: true }); }
});
