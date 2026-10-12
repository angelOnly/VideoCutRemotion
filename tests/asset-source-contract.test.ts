import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sourceMaterialSchema } from "../packages/asset-acquisition/src/source-research.js";
import { motionSubmissionSchema, boundMotionImageSchema } from "../packages/motion-work/src/schema.js";
import { motionFixture } from "./fixtures/managed-motion.js";

const obsoleteFields = ["rights", "rightsStatus", "rights_status", "rightsRequirement", "rights_requirement", "usageRights", "usage_rights", "rights_confirmation", "rights_note", "license", "license_url", "attribution_text", "authorization_note"];

test("来源与动效请求只接受新合同，不接收旧权利字段", () => {
  const source = { kind: "image", url: "https://example.test/image.png", baseRevision: 1, idempotencyKey: "source" };
  assert.deepEqual(sourceMaterialSchema.parse(source), source);
  for (const field of ["basis", "purposes", "usageRights"]) assert.equal(sourceMaterialSchema.safeParse({ ...source, [field]: "旧输入" }).success, false);
  assert.equal(motionSubmissionSchema.safeParse(motionFixture).success, true);
  assert.equal(motionSubmissionSchema.safeParse({ ...motionFixture, rights: { status: "cleared", basis: "旧声明" } }).success, false);
  const binding = { slot: "image", assetId: "asset", managedPath: "assets/image.png", hash: "a".repeat(64) };
  assert.deepEqual(boundMotionImageSchema.parse(binding), binding);
  assert.equal(boundMotionImageSchema.safeParse({ ...binding, rightsStatus: "unknown" }).success, false);
});

test("真实 MCP Schema 删除权利参数，旧参数在执行前被拒绝且不改变 Revision", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vfc-source-contract-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: resolve("."), stderr: "pipe", env: { ...process.env, VIDEOCUT_WORKSPACE: workspace } });
  const client = new Client({ name: "asset-source-contract", version: "1.0.0" });
  const text = (result: unknown): string => (result as { content: { text: string }[] }).content[0].text;
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const affected = ["manage_asset_requirements", "acquire_media_asset", "import_media", "import_local_sound_effect", "update_asset_metadata", "manage_voice_references", "manage_actor_capabilities", "submit_avatar_job", "submit_motion_work", "acquire_source_material"];
    for (const name of affected) {
      const tool = tools.find(tool => tool.name === name)!;
      assert.ok(tool, name);
      const properties = JSON.stringify(tool.inputSchema);
      for (const field of obsoleteFields) assert.equal(properties.includes(`"${field}":`), false, `${name} 残留 ${field}`);
    }
    const project = JSON.parse(text(await client.callTool({ name: "create_project", arguments: { name: "新素材合同" } })));
    const projectId = project.snapshot.project.id;
    const args = { project_id: projectId, base_revision_id: 1, action: "create", title: "画面", purpose: "测试新素材需求", visual_brief: "真实画面", role: "b_roll" };
    const old = await client.callTool({ name: "manage_asset_requirements", arguments: { ...args, rights_requirement: "cleared_only" } });
    assert.equal(old.isError, true);
    assert.match(text(old), /rights_requirement|Unrecognized/);
    for (const [name, arguments_] of [
      ["acquire_media_asset", { project_id: projectId, base_revision_id: 1, asset_candidate_id: "missing", usage_rights: { basis: "旧声明", purposes: ["draft"] } }],
      ["import_media", { project_id: projectId, base_revision_id: 1, file_path: "missing.mp4", provenance: { source: "local_import", rights_status: "cleared" } }],
      ["manage_voice_references", { project_id: projectId, base_revision_id: 1, asset_id: "missing", authorization_note: "旧声明" }]
    ] as const) {
      const result = await client.callTool({ name, arguments: arguments_ });
      assert.equal(result.isError, true);
      assert.match(text(result), /Unrecognized/);
    }
    const current = JSON.parse(text(await client.callTool({ name: "read_project", arguments: { project_id: projectId } })));
    assert.equal(current.revision.number, 1);
    const created = JSON.parse(text(await client.callTool({ name: "manage_asset_requirements", arguments: args })));
    assert.equal(created.snapshot.assetRequests[0].title, "画面");
    assert.equal(Object.hasOwn(created.snapshot.assetRequests[0], "rightsRequirement"), false);
  } finally { await client.close(); await transport.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("运行代码与共享 Skill 不再保留权利门禁和旧参数说明", async () => {
  const contracts = await readFile("packages/contracts/src/index.ts", "utf8");
  for (const field of ["AssetRightsRequirement", "AvatarUsageRightsConfirmation", "rightsStatus", "usageRights", "AttributionManifest"]) assert.equal(contracts.includes(field), false, field);
  const shared = await readFile(".agents/skills/quality-verification/references/evidence-status.md", "utf8");
  assert.match(shared, /不验证素材权限、使用权、版权/);
  const execution = await readFile(".agents/skills/visual-asset-sourcing/references/acquisition-operations.md", "utf8");
  assert.equal(execution.includes("usage_rights"), false);
  assert.match(execution, /不接受权利或用途证明参数/);
});
