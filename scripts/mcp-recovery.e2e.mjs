import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensureRuntime, stopRuntime, findAvailablePort } from "../plugins/videoflowcut/scripts/runtime-launcher.mjs";
import { resolveReleaseRuntime } from "../plugins/videoflowcut/scripts/repo-root.mjs";

// 只使用 mkdtemp 工作区和独立端口；生产项目、队列和状态文件均不进入此验收。
const repoRoot = resolve(import.meta.dirname, "..");
const launcherRoot = resolve(process.argv[2] ?? join(repoRoot, "plugins/videoflowcut"));
const deployedRoot = resolve(process.argv[3] ?? join(repoRoot, "plugins/videoflowcut"));
const mcpSpec = JSON.parse(await readFile(join(launcherRoot, ".mcp.json"), "utf8")).mcpServers.videoflowcut;
const release = resolveReleaseRuntime(deployedRoot);
const workspaceRoot = await mkdtemp(join(tmpdir(), "videoflowcut-mcp-recovery-"));
const port = await findAvailablePort();
const options = { repoRoot, pluginRoot: deployedRoot, workspaceRoot, port };
const statePath = join(workspaceRoot, ".videoflowcut-runtime", `runtime-${port}.json`);
let transport;
let client;
let closed = false;
let catalogChanges = 0;
async function connect() {
  // 命令、相对路径与环境来自安装声明；测试仅覆盖端口和工作区以隔离生产数据。
  // 不注入仓库定位变量，否则缺失的发行指针会被测试环境掩盖。
  transport = new StdioClientTransport({ command: mcpSpec.command,
    args: mcpSpec.args, cwd: resolve(launcherRoot, mcpSpec.cwd ?? "."), stderr: "pipe",
    env: { ...getDefaultEnvironment(), ...mcpSpec.env, VIDEOCUT_WORKSPACE: workspaceRoot, VIDEOFLOWCUT_PORT: String(port) } });
  transport.stderr?.on("data", (data) => process.stderr.write(data));
  client = new Client({ name: "mcp-recovery-regression", version: "1.0.0" });
  client.onclose = () => { closed = true; };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { catalogChanges++; });
  await client.connect(transport);
}
const call = () => client.callTool({ name: "read_runtime_release", arguments: {} });
try {
  // 模拟宿主仍持有已清理旧安装槽的命令；新发行目录存在也不能修复该旧路径。
  const removedInstallation = join(workspaceRoot, "removed-plugin-installation");
  await mkdir(removedInstallation);
  const staleTransport = new StdioClientTransport({ command: mcpSpec.command,
    args: mcpSpec.args, cwd: removedInstallation, stderr: "pipe", env: getDefaultEnvironment() });
  const staleClient = new Client({ name: "stale-installation-regression", version: "1.0.0" });
  let startupError = "";
  staleTransport.stderr?.on("data", (data) => { startupError += data.toString(); });
  try {
    await assert.rejects(() => staleClient.connect(staleTransport), /closed/i);
    assert.match(startupError, /Cannot find module[\s\S]*mcp-launcher\.mjs/);
  } finally {
    await staleClient.close();
    await staleTransport.close();
  }

  await ensureRuntime(options);
  const recorded = await readFile(statePath, "utf8");
  await stopRuntime(options);
  await writeFile(statePath, recorded);
  await connect();
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "read_runtime_release"), "陈旧状态必须恢复真实业务工具");
  let status = await call();
  assert.notEqual(status.isError, true, JSON.stringify(status));
  assert.equal(JSON.parse(status.content[0].text).mcpReleaseId, release.releaseId, "启动器必须跟随已部署发行版，不得回滚");
  assert.equal(closed, false);

  const recoveredState = await readFile(statePath, "utf8");
  await stopRuntime(options);
  status = await call();
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /MCP_RUNTIME_UNAVAILABLE/);
  assert.equal(closed, false, "服务明确停止不应关闭宿主 MCP");
  await writeFile(statePath, recoveredState);
  await client.listTools();
  assert.notEqual((await call()).isError, true, "同一连接应恢复已部署服务，不重放失败调用");
  await client.close();
  await stopRuntime(options);

  // 受管文件若指向仍存活的未知进程，只报错，不杀进程或抢占端口。
  await writeFile(statePath, JSON.stringify({ ...JSON.parse(recoveredState), pid: process.pid }));
  closed = false;
  await connect();
  const initialTools = (await client.listTools()).tools;
  assert.ok(initialTools.some((tool) => tool.name === "read_runtime_release"));
  assert.ok(initialTools.some((tool) => tool.name === "report_editing_blocker"));
  assert.equal((await call()).isError, true);
  assert.equal(closed, false, "初始依赖故障仍须完成外层握手");
  await writeFile(statePath, recoveredState);
  // 模拟宿主缓存首次目录、不响应通知；修复后直接调用已发现的工具。
  assert.notEqual((await call()).isError, true);
  assert.equal(catalogChanges, 0, "同一发行恢复无需工具变更通知");
  await client.close();
  console.log(JSON.stringify({ verified: true, releaseId: release.releaseId, staleStateRecovered: true,
    sameConnectionRecovered: true, unknownProcessProtected: true, initialFailureHandshakeSurvived: true,
    installedManifestCommandUsed: true, removedInstallationRejected: true, desktopConnectionVerified: false }));
} finally {
  await transport?.close().catch(() => {});
  await stopRuntime(options).catch(() => {});
  await rm(workspaceRoot, { recursive: true, force: true });
}
