import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveCandidateRuntimeOptions, runCandidateRuntime } from "../plugins/videoflowcut/scripts/candidate-runtime.mjs";
import { findAvailablePort } from "../plugins/videoflowcut/scripts/runtime-launcher.mjs";
import { readOption, resolveReleaseRuntime } from "../plugins/videoflowcut/scripts/repo-root.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const baselineArgument = readOption(process.argv.slice(2), "--baseline-plugin-root");
assert.ok(baselineArgument, "必须提供已有发行快照以验证旧连接刷新，不能伪造旧版");
const baselineRoot = resolve(baselineArgument);
const baseline = resolveReleaseRuntime(baselineRoot);
await mkdir(join(repoRoot, ".candidate"), { recursive: true });
const workspaceRoot = await mkdtemp(join(repoRoot, ".candidate", "sound-plan-e2e-"));
const port = await findAvailablePort();
const args = ["--repo-root", repoRoot, "--workspace", workspaceRoot, "--port", String(port), "--comfyui-bridge-url", "http://127.0.0.1:18199/comfyui-bridge/v1"];
const options = resolveCandidateRuntimeOptions(args);
const candidate = resolveReleaseRuntime(options.pluginRoot);
assert.notEqual(baseline.releaseId, candidate.releaseId);
let client;
try {
  // 使用受控候选入口，独立端口、SQLite 和 Bridge 配置均先经过生产边界检查。
  const runtime = await runCandidateRuntime("start", args);
  assert.equal(runtime.ready, true);
  client = new Client({ name: "sound-plan-release-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(baselineRoot, "scripts", "mcp-launcher.mjs")], cwd: repoRoot, stderr: "pipe",
    env: { ...process.env, VIDEOFLOWCUT_REPO_ROOT: repoRoot, VIDEOCUT_WORKSPACE: workspaceRoot, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: options.bridgeUrl } });
  await client.connect(transport);
  const initialTools = await client.listTools();
  const oldPlan = initialTools.tools.find((entry) => entry.name === "manage_sound_plans");
  assert.deepEqual(oldPlan.inputSchema, JSON.parse(await readFile(join(baseline.root, "mcp-tools.json"), "utf8")).tools.find((entry) => entry.name === "manage_sound_plans").inputSchema);
  const call = async (name, arguments_ = {}) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    const text = result.content.find((item) => item.type === "text")?.text;
    assert.notEqual(result.isError, true, text);
    return JSON.parse(text);
  };
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true); assert.equal(release.mcpReleaseId, candidate.releaseId);
  assert.equal(release.runtime.status, "ready");
  assert.deepEqual(release.runtime.workers, { media: true, render: true });
  const created = await call("create_project", { name: "声音计划发行隔离验收", profile: "visual_explainer" });
  const projectId = created.snapshot.project.id;
  const read = () => call("read_project", { project_id: projectId });
  const input = { action: "create", startFrame: 0, endFrame: 240, narrationDirection: "说明因果", dominantRole: "narration", musicDirection: "结论留白", intents: [{ id: "settle", function: "settle", brief: "问题解释完成" }] };
  const rawPlan = (plan, baseRevision) => client.callTool({ name: "manage_sound_plans", arguments: { project_id: projectId, base_revision_id: baseRevision, input: plan } });
  const oldCall = await rawPlan(input, created.revision.number);
  assert.equal(oldCall.isError, true); assert.match(JSON.stringify(oldCall.content), /MCP_TOOL_SCHEMA_CHANGED/u);
  assert.equal((await read()).revision.number, created.revision.number, "旧工具表请求不能产生写入");
  const refreshed = (await client.listTools()).tools.find((entry) => entry.name === "manage_sound_plans");
  const createBranch = refreshed.inputSchema.properties.input.anyOf.find((entry) => entry.properties.action.const === "create");
  assert.ok(createBranch.required.includes("startFrame") && createBranch.required.includes("endFrame"));
  const { startFrame, endFrame, ...withoutRange } = input;
  const missing = await rawPlan(withoutRange, created.revision.number);
  assert.equal(missing.isError, true); assert.match(JSON.stringify(missing.content), /startFrame|endFrame/u);
  assert.equal((await read()).revision.number, created.revision.number);
  const saved = await call("manage_sound_plans", { project_id: projectId, base_revision_id: created.revision.number, input });
  assert.equal(saved.snapshot.timeline.durationInFrames, 0);
  const planId = saved.snapshot.soundPlans[0].id;
  const updated = await call("manage_sound_plans", { project_id: projectId, base_revision_id: saved.revision.number, input: { action: "update", soundPlanId: planId, endFrame: 216 } });
  assert.equal(updated.snapshot.soundPlans[0].startFrame, startFrame); assert.equal(updated.snapshot.soundPlans[0].endFrame, 216);
  const invalidHttp = await fetch(`${runtime.apiUrl}/api/projects/${projectId}/sound-plans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: updated.revision.number, plan: withoutRange }) });
  assert.equal(invalidHttp.status, 400); assert.equal((await read()).revision.number, updated.revision.number);
  const report = { verified: true, baselineReleaseId: baseline.releaseId, candidateReleaseId: candidate.releaseId, workspaceRoot, port, bridgeUrl: options.bridgeUrl, release, projectId, revision: updated.revision.number, schemaRefreshed: true, missingFieldsRejectedWithoutRevision: true, preVoiceEstimateUpdated: true, httpValidationStatus: invalidHttp.status };
  await writeFile(join(workspaceRoot, "verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client?.close();
  await runCandidateRuntime("stop", args);
}
