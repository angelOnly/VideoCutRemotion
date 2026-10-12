import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pluginRootFromModule, readOption, resolveReleaseRuntime, resolveRepoRoot } from "./repo-root.mjs";
import { ensureRuntime, findAvailablePort, stopRuntime } from "./runtime-launcher.mjs";

// 以两个真实发行物验收，不伪造 Release ID，也不触碰正式工作区。
const pluginRoot = pluginRootFromModule(import.meta.url);
const baselineArg = readOption(process.argv.slice(2), "--baseline-plugin-root");
if (!baselineArg) throw new Error("必须显式传入 --baseline-plugin-root，指向已有的真实发行版。");
const baselineRoot = resolve(baselineArg);
const verifyMotionReference = process.argv.includes("--verify-motion-reference");
const baseline = resolveReleaseRuntime(baselineRoot);
const candidate = resolveReleaseRuntime(pluginRoot);
assert.notEqual(baseline.releaseId, candidate.releaseId, "验收必须跨两个真实版本");
const repoRoot = resolveRepoRoot({ pluginRoot });
const require = createRequire(join(repoRoot, "package.json"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { ToolListChangedNotificationSchema } = require("@modelcontextprotocol/sdk/types.js");
const workspaceRoot = await mkdtemp(join(tmpdir(), "videoflowcut-mcp-reload-"));
const port = await findAvailablePort();
const options = { pluginRoot, repoRoot, workspaceRoot, port, bridgeUrl: "http://127.0.0.1:18199" };
let transport;
let disconnected = false;
let notifications = 0;
let motionReferenceEvidence;
try {
  await ensureRuntime({ ...options, pluginRoot: baselineRoot });
  transport = new StdioClientTransport({
    command: process.execPath,
    // 模拟真实旧会话：首次暴露的 Schema 必须也来自基线，不能把新版目录套在旧业务进程上。
    args: [join(baselineRoot, "scripts", "mcp-launcher.mjs")], cwd: repoRoot, stderr: "pipe",
    env: { ...process.env, VIDEOFLOWCUT_REPO_ROOT: repoRoot, VIDEOCUT_WORKSPACE: workspaceRoot, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: options.bridgeUrl }
  });
  const client = new Client({ name: "videoflowcut-live-reload-verification", version: "1.0.0" });
  client.onclose = () => { disconnected = true; };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.find((item) => item.type === "text")?.text;
    assert.notEqual(result.isError, true, text);
    return JSON.parse(text);
  };
  const beforeTools = await client.listTools();
  assert.equal((await call("read_runtime_release")).mcpReleaseId, baseline.releaseId);
  if (verifyMotionReference) {
    const failed = await client.callTool({ name: "inspect_motion_reference", arguments: { source_url: "https://remotionlab.com/showcase" } });
    assert.equal(failed.isError, true, "旧发行链必须真实复现问题，不能只用源码测试代替");
    assert.match(JSON.stringify(failed.content), /缺少部署前准备的浏览器路径/u);
  }
  const created = await call("create_project", { name: "持久 MCP 跨版本隔离验收", profile: "presenter_motion" });
  const projectId = created.snapshot.project.id;

  // 真实停止 A、启动 B；唯一外层 stdio 连接始终不关闭，且切换间隙不执行写入。
  await ensureRuntime(options);
  await client.listTools();
  const afterRelease = await call("read_runtime_release");
  assert.equal(afterRelease.aligned, true);
  assert.equal(afterRelease.mcpReleaseId, candidate.releaseId);
  const restored = await call("read_project");
  assert.equal(restored.snapshot.project.id, projectId, "创建项目产生的默认定位也必须恢复");
  assert.equal(restored.revision.number, created.revision.number, "切换不能产生视频 Revision");
  // 握手已切到候选版，再刷新目录后使用本次调整过说明的工具。
  const afterTools = await client.listTools();
  // 在候选发行链核验机制图文可读；只读研究不能改动视频项目。
  const mechanisms = await call("search_motion_mechanisms", { stages: ["依次填满网格", "从圆形开口推近内部"], limit: 2 });
  assert.ok(mechanisms.groups.every(group => group.cards.length > 0));
  const mechanism = await client.callTool({ name: "read_motion_mechanism", arguments: {
    id: mechanisms.groups[0].cards[0].id, source_sha256: mechanisms.source_sha256
  } });
  assert.notEqual(mechanism.isError, true, JSON.stringify(mechanism.content));
  assert.deepEqual(mechanism.content.map(item => item.type), ["text", "image"]);
  assert.equal((await call("read_project")).revision.number, created.revision.number);
  if (JSON.stringify(beforeTools.tools) !== JSON.stringify(afterTools.tools)) {
    assert.ok(notifications > 0, "Schema 变化必须真实发送标准 MCP 通知");
  }
  assert.equal(disconnected, false, "跨版本期间宿主连接不能关闭");

  if (verifyMotionReference) {
    // 同一个旧宿主连接热切新版；MCP 没有浏览器环境，实际截图由候选 Runtime 产生。
    const referenceArgs = { source_url: "https://remotionlab.com/showcase", sample_duration_ms: 1000 };
    const overview = await client.callTool({ name: "inspect_motion_reference", arguments: referenceArgs });
    assert.notEqual(overview.isError, true, JSON.stringify(overview.content));
    const metadata = JSON.parse(overview.content.find((item) => item.type === "text").text);
    assert.ok(metadata.previews.length > 0, "真实目录必须有可定位的动态预览");
    const sampled = await client.callTool({ name: "inspect_motion_reference", arguments: { ...referenceArgs, preview_index: metadata.previews[0].index } });
    assert.notEqual(sampled.isError, true, JSON.stringify(sampled.content));
    const frames = sampled.content.filter((item) => item.type === "image");
    assert.equal(frames.length, 5);
    const evidenceRoot = await mkdtemp(join(tmpdir(), "videoflowcut-mcp-motion-evidence-"));
    await writeFile(join(evidenceRoot, "overview.png"), Buffer.from(overview.content.find((item) => item.type === "image").data, "base64"));
    for (const [index, frame] of frames.entries()) await writeFile(join(evidenceRoot, `sample-${index}.png`), Buffer.from(frame.data, "base64"));
    motionReferenceEvidence = { root: evidenceRoot, metadata, samples: JSON.parse(sampled.content.find((item) => item.type === "text").text) };
    await writeFile(join(evidenceRoot, "verification.json"), JSON.stringify(motionReferenceEvidence, null, 2));
    assert.equal((await call("read_project")).revision.number, created.revision.number, "只读动效审阅不能增加视频 Revision");
    assert.equal(disconnected, false);
  }

  await call("target_project", { project_id: projectId });
  await stopRuntime(options, { force: true });
  // Runtime 停止时不能把旧业务进程成功响应冒充健康；未执行的请求可在恢复后重新判断。
  await assert.rejects(call("read_project"), /Runtime|受管/);
  await ensureRuntime(options);
  const restarted = await call("read_project");
  assert.equal(restarted.snapshot.project.id, projectId);
  assert.equal(restarted.revision.number, created.revision.number);
  assert.equal(disconnected, false);
  console.log(JSON.stringify({ verified: true, baseline: baseline.releaseId, candidate: candidate.releaseId,
    sameHostConnection: true, mechanismReadVerified: true, preservedProject: projectId, revision: restarted.revision.number,
    toolListChangeNotifications: notifications, runtimeRestartRecovered: true, motionReferenceEvidence }, null, 2));
} finally {
  await transport?.close().catch(() => {});
  await stopRuntime(options, { force: true }).catch(() => {});
  // 只清理本脚本 mkdtemp 创建的隔离验收目录。
  await rm(workspaceRoot, { recursive: true, force: true });
}
