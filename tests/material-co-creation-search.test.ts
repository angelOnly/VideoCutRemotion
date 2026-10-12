import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApplication } from "@videocut/application";
import { AssetProviderRegistry, type ProviderSearchInput } from "@videocut/acquisition";
import { registerMediaSearchTool } from "../apps/server/src/media-search-tool.js";
import { encodeSearchCursor } from "../packages/asset-acquisition/src/cursor.js";

test("真实搜索入口允许旧版本，固定在途需求并保留关闭后的结果，正式写入仍拒绝过期版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-co-creation-"));
  const application = createApplication(root);
  const projectId = application.createProject({ name: "独立搜索验证" }).snapshot.project.id;
  const created = application.manageAssetRequirement({ projectId, baseRevision: 1, action: "create", title: "首轮材料", purpose: "原始内容", visualBrief: "初始材料" });
  const requestId = created.snapshot.assetRequests[0].id;
  const inputs: ProviderSearchInput[] = [];
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const providers = new AssetProviderRegistry([{
    name: "wikimedia-commons",
    async search(input) {
      inputs.push(structuredClone(input));
      if (input.query === "在途原查询") {
        const waiting = new Promise<void>(resolve => { release = resolve; });
        entered!(); await waiting;
      }
      return [{ originalAssetId: input.query, name: "材料", kind: "image", sourceUrl: "https://example.test/material.png" }];
    },
    async download() { throw new Error("此测试不下载"); }
  }]);
  const server = new McpServer({ name: "独立搜索入口", version: "1" });
  registerMediaSearchTool(server, application, providers, id => id ?? projectId);
  const client = new Client({ name: "共创测试", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote); await client.connect(local);
  const call = (extra: Record<string, unknown>) => client.callTool({ name: "search_media_candidates", arguments: {
    project_id: projectId, asset_request_id: requestId, provider: "wikimedia-commons", media_type: "image", query: "主题", ...extra
  } });
  const parse = (result: Awaited<ReturnType<typeof call>>) => {
    const raw = JSON.stringify(result.content);
    assert.notEqual(result.isError, true, raw);
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };
  try {
    const schema = (await client.listTools()).tools[0].inputSchema;
    assert.ok(!schema.required?.includes("base_revision_id"));
    const advanced = application.updateCreativeBrief({ projectId, baseRevision: created.revision.number, brief: { tone: "亲近" } });
    const found = parse(await call({ base_revision_id: 1 }));
    assert.equal(inputs.length, 1);
    assert.equal(found.state.revision.number, advanced.revision.number);
    assert.equal(found.intent.query, "主题");
    assert.throws(() => application.acquireAssetCandidate({ projectId, baseRevision: 1, assetCandidateId: found.candidates[0].id }), /Revision/);
    assert.equal(parse(await call({ query: "省略版本" })).state.revision.number, advanced.revision.number);

    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = call({ query: "在途原查询", base_revision_id: 1 });
    await started;
    const changed = application.manageAssetRequirement({ projectId, baseRevision: advanced.revision.number, action: "update", assetRequestId: requestId, purpose: "新的内容", visualBrief: "新的画面" });
    const closed = application.manageAssetRequirement({ projectId, baseRevision: changed.revision.number, action: "close", assetRequestId: requestId, closeOutcome: "cancelled", closeReason: "用途结束" });
    release!();
    const late = parse(await pending);
    assert.equal(late.state.revision.number, closed.revision.number);
    assert.equal(late.state.snapshot.assetRequests[0].status, "closed");
    const saved = application.repository.mediaIntelligence.searches(projectId).find(session => session.id === late.sessionId)!;
    assert.equal(saved.requestSnapshot?.purpose, "原始内容");
    assert.equal(saved.intent.query, "在途原查询");
    assert.equal(inputs.at(-1)?.request.purpose, "原始内容");
    assert.equal(application.readAssetCandidate({ projectId, assetCandidateId: late.candidates[0].id }).candidate.id, late.candidates[0].id);
    assert.match(JSON.stringify((await call({})).content), /ASSET_REQUEST_CLOSED/);

    const another = application.manageAssetRequirement({ projectId, baseRevision: closed.revision.number, action: "create", title: "游标检查", purpose: "保持身份", visualBrief: "独立材料" });
    const openId = another.snapshot.assetRequests.at(-1)!.id;
    const count = inputs.length;
    const cursor = encodeSearchCursor("wikimedia-commons", { query: "其他查询", mediaType: "image" }, 10);
    assert.match(JSON.stringify((await call({ asset_request_id: openId, cursor })).content), /ASSET_CURSOR_INVALID/);
    assert.match(JSON.stringify((await call({ asset_request_id: "不存在" })).content), /ASSET_REQUEST_NOT_FOUND/);
    assert.equal(inputs.length, count, "无效需求与游标必须在 Provider 执行前拒绝");
  } finally {
    release?.(); await client.close(); await server.close(); application.close(); await rm(root, { recursive: true, force: true });
  }
});
