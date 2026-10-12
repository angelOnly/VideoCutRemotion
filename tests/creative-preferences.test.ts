import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../apps/server/src/app.js";
import { createApplication } from "@videocut/application";

test("默认设置主动保存、跨连接持久化、只在建项继承，API 与 MCP 共用明确偏好合同", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-preferences-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  const client = new Client({ name: "创作偏好回归", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(),
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), VIDEOCUT_WORKSPACE: root }, stderr: "pipe" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return JSON.parse((result.content as Array<{ text: string }>)[0].text);
  };
  try {
    const original = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "没有偏好也能开始" } })).json();
    assert.equal(original.snapshot.project.brief.explicitCreativePreferences, undefined);
    const defaults = { dimensions: { narration: "温暖陪伴", visual: "材料共场" }, notes: "保留源声" };
    assert.equal((await app.inject({ method: "PUT", url: "/api/settings/creative-defaults", payload: defaults })).statusCode, 200);
    const reopened = createApplication(root);
    assert.deepEqual(reopened.readCreativeDefaults(), defaults); reopened.close();
    await client.connect(transport);
    const created = await call("create_project", { name: "一维覆盖", brief: { explicitCreativePreferences: { dimensions: { narration: "理性爽快" } } } });
    const projectId = created.snapshot.project.id;
    assert.deepEqual(created.snapshot.project.brief.explicitCreativePreferences, { dimensions: { narration: "理性爽快", visual: "材料共场" }, notes: "保留源声" });
    assert.equal(created.snapshot.project.brief.tone, "理性爽快");
    assert.equal(created.snapshot.project.brief.allowHighDensityMotion, false);
    const job = application.repository.createJob({ projectId, kind: "preview", payload: { revision: 1, brief: created.snapshot.project.brief }, idempotencyKey: "原输入" });
    await app.inject({ method: "PUT", url: "/api/settings/creative-defaults", payload: { dimensions: { visual: "新的默认" } } });
    assert.deepEqual(application.readProject(projectId).snapshot.project.brief, created.snapshot.project.brief);
    assert.deepEqual(application.trackJob(job.id).payload, job.payload);
    assert.equal(application.readProject(original.snapshot.project.id).revision.number, 1);
    const next = await call("create_project", { name: "后续项目" });
    assert.deepEqual(next.snapshot.project.brief.explicitCreativePreferences, { dimensions: { visual: "新的默认" } });

    const changed = await call("update_creative_brief", { project_id: projectId, base_revision_id: 1, brief: { tone: "直接", explicitCreativePreferences: { dimensions: { motion: "有准备与收势" } } } });
    assert.equal(changed.snapshot.project.brief.tone, "直接");
    assert.equal(changed.snapshot.project.brief.explicitCreativePreferences.dimensions.narration, "直接");
    assert.equal(changed.snapshot.project.brief.explicitCreativePreferences.dimensions.visual, "材料共场");
    assert.deepEqual(application.readCreativeDefaults(), { dimensions: { visual: "新的默认" } });
    assert.deepEqual(application.trackJob(job.id).payload, job.payload);
    const stale = await client.callTool({ name: "update_creative_brief", arguments: { project_id: projectId, base_revision_id: 1, brief: { tone: "过期" } } });
    assert.equal(stale.isError, true); assert.match(JSON.stringify(stale.content), /Revision 已过期/);
    const invalid = { dimensions: { invented: "未知维度" } };
    assert.equal((await app.inject({ method: "PUT", url: "/api/settings/creative-defaults", payload: invalid })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/projects", payload: { name: "无效", brief: { explicitCreativePreferences: invalid } } })).statusCode, 400);
    assert.equal((await client.callTool({ name: "create_project", arguments: { name: "无效", brief: { explicitCreativePreferences: invalid } } })).isError, true);
    const cleared = (await app.inject({ method: "PATCH", url: `/api/projects/${projectId}/brief`, payload: { baseRevision: changed.revision.number, brief: { explicitCreativePreferences: null } } })).json();
    assert.equal(cleared.snapshot.project.brief.explicitCreativePreferences, undefined);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/settings/creative-defaults", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode, 200);
    assert.deepEqual(application.readCreativeDefaults(), {});
    const clean = await call("create_project", { name: "清空后" });
    assert.equal(clean.snapshot.project.brief.explicitCreativePreferences, undefined);
    const legacy = await call("create_project", { name: "兼容口吻", brief: { tone: "直接" } });
    assert.equal(legacy.snapshot.project.brief.explicitCreativePreferences.dimensions.narration, "直接");
  } finally {
    await client.close(); await transport.close(); await app.close(); application.close(); await rm(root, { recursive: true, force: true });
  }
});
