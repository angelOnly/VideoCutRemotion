import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@videocut/application";

test("正式 MCP Schema 接受开放需求，旧候选跨改稿获取，完成与取消关闭有明确合同", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-lifecycle-mcp-"));
  const seed = createApplication(root);
  const project = seed.createProject({ name: "生命周期协议隔离" });
  const projectId = project.snapshot.project.id;
  const created = seed.manageAssetRequirement({ projectId, baseRevision: 1, action: "create", title: "内容", purpose: "补充关系", visualBrief: "探索材料" });
  const request = created.snapshot.assetRequests[0];
  const found = seed.recordAssetSearch({ projectId, baseRevision: created.revision.number, assetRequestId: request.id, provider: "youtube", query: "https://youtu.be/abcdefghijk", candidates: [{ originalAssetId: "abcdefghijk", sourceUrl: "https://youtu.be/abcdefghijk", name: "测试来源", kind: "video" }] });
  seed.close();
  const client = new Client({ name: "生命周期协议回归", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(),
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), VIDEOCUT_WORKSPACE: root }, stderr: "pipe" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { project_id: projectId, ...args } });
    // 原始错误先判断和保存，不用 JSON 解析错误覆盖协议诊断。
    const raw = result.content as Array<{ type: string; text?: string }>;
    assert.notEqual(result.isError, true, JSON.stringify(raw));
    return JSON.parse(raw.find(block => block.type === "text")!.text!);
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const schema = tools.tools.find(tool => tool.name === "manage_asset_requirements")!.inputSchema;
    assert.ok(schema.properties?.close_outcome);
    assert.ok(!schema.required?.includes("query_hints"));
    assert.ok(!tools.tools.some(tool => ["adopt_media_fragment", "bind_media_adoption"].includes(tool.name)));
    const updated = await call("manage_asset_requirements", { action: "update", asset_request_id: request.id, base_revision_id: created.revision.number, purpose: "新的讲法", target_aspect_ratio: "1:1" });
    const read = await call("inspect_media_candidate", { asset_candidate_id: found.candidates[0].id });
    assert.equal(read.candidate.status, "available");
    const queued = await call("acquire_media_asset", { asset_candidate_id: found.candidates[0].id, base_revision_id: updated.revision.number });
    assert.equal(queued.job.status, "queued");
    const whileQueued = await call("manage_asset_requirements", { action: "update", asset_request_id: request.id, base_revision_id: queued.state.revision.number, visual_brief: "下载期间继续调整" });
    const refused = await client.callTool({ name: "manage_asset_requirements", arguments: { project_id: projectId, action: "close", asset_request_id: request.id, base_revision_id: whileQueued.revision.number, close_outcome: "completed" } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /ASSET_REQUEST_MATERIAL_REQUIRED|实际取得/);
    const closed = await call("manage_asset_requirements", { action: "close", asset_request_id: request.id, base_revision_id: whileQueued.revision.number, close_outcome: "cancelled", close_reason: "作者取消用途" });
    assert.equal(closed.snapshot.assetRequests[0].status, "closed");
    assert.equal((await call("track_job", { job_id: queued.job.id })).status, "queued");
  } finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
});
