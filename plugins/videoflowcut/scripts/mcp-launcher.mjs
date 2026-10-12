import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pluginRootFromModule, releaseNodePath, resolveReleaseRuntime, resolveRepoRoot, resolveWorkspaceRoot } from "./repo-root.mjs";
import { recoverMcpDeployment, withRuntimeOperationLock } from "./runtime-launcher.mjs";
import { createReloadingMcpSession } from "./mcp-session.mjs";

const pluginRoot = pluginRootFromModule(import.meta.url);
const launcherCodeHash = createHash("sha256").update(["mcp-launcher.mjs", "mcp-session.mjs", "runtime-launcher.mjs"]
  .map(name => `${name}\n${readFileSync(join(pluginRoot, "scripts", name), "utf8")}`).join("\n")).digest("hex");
const repoRoot = resolveRepoRoot({ pluginRoot });
const workspaceRoot = resolveWorkspaceRoot(repoRoot);
// Windows 会锁住进程的工作目录。完成绝对路径定位后离开安装槽，让官方插件更新可清理旧版本。
process.chdir(repoRoot);

const require = createRequire(join(repoRoot, "package.json"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const options = { pluginRoot, repoRoot, workspaceRoot };
let activeDeployment;
let poll;
let session;
const server = new Server({ name: "video-editor-mcp", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });

try {
  const initialRelease = resolveReleaseRuntime(pluginRoot);
  const catalog = JSON.parse(readFileSync(join(initialRelease.root, "mcp-tools.json"), "utf8"));
  if (catalog.schemaVersion !== 1) throw new Error("MCP 发行工具目录版本不兼容，请重新构建并安装插件");
  session = createReloadingMcpSession({
    initialTools: catalog.tools,
    runExclusive: (action, lockOptions) => withRuntimeOperationLock(options, action, lockOptions),
    resolveDeployment: async () => {
      activeDeployment = await recoverMcpDeployment(options, activeDeployment);
      return activeDeployment;
    },
    connect: async (release) => {
      const transport = new StdioClientTransport({
        command: process.execPath, args: [release.mcpEntry], cwd: repoRoot, stderr: "pipe",
        env: {
          ...process.env, NODE_PATH: releaseNodePath(repoRoot),
          VIDEOFLOWCUT_NODE_MODULES: join(repoRoot, "node_modules"), VIDEOCUT_WORKSPACE: workspaceRoot,
          WEB_ORIGIN: `${release.apiUrl}/`, VIDEOFLOWCUT_RUNTIME_DIST: release.root, VIDEOFLOWCUT_RELEASE_ID: release.releaseId
        }
      });
      transport.stderr?.on("data", (data) => process.stderr.write(data));
      const client = new Client({ name: "videoflowcut-stable-session", version: "1.0.0" });
      let alive = true;
      client.onclose = () => { alive = false; };
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: "read_runtime_release", arguments: {} });
        const status = JSON.parse(result.content.find((item) => item.type === "text").text);
        if (result.isError || !status.aligned || status.mcpReleaseId !== release.releaseId) throw new Error("新 MCP 未通过同版握手");
        const { tools } = await client.listTools();
        return {
          releaseId: release.releaseId, runtimeId: release.runtimeId, tools, isAlive: () => alive,
          callTool: (params, requestOptions) => client.callTool(params, undefined, requestOptions),
          close: () => client.close()
        };
      } catch (error) { await transport.close(); throw error; }
    },
    onToolsChanged: () => server.sendToolListChanged()
  });
  server.setRequestHandler(ListToolsRequestSchema, () => session.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await session.callTool(request.params, { signal: extra.signal, timeout: 180_000 });
    if (request.params.name !== "read_runtime_release" || result.isError) return result;
    // 内层 MCP 可热切，外壳代码不会自动重载；部署核验必须能区分这两个版本。
    return { ...result, content: result.content.map((item) => {
      if (item.type !== "text") return item;
      return { ...item, text: JSON.stringify({ ...JSON.parse(item.text), launcherReleaseId: initialRelease.releaseId, launcherCodeHash, launcherPid: process.pid }) };
    }) };
  });
  // 先建立宿主协议连接；业务 Runtime 暂不可用不应永久毒化宿主的 MCP 启动状态。
  await server.connect(new StdioServerTransport());
  let polling = false;
  poll = setInterval(async () => {
    if (polling) return;
    polling = true;
    try { await session.refresh(); } catch { /* 发布间隙保持宿主连接，工具调用会返回实际阻断。 */ }
    finally { polling = false; }
  }, 2_000);
  const close = async () => { clearInterval(poll); await session.close(); await server.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
  console.error("VideoFlowCut 稳定 MCP 连接已启动；业务进程按已验证部署切换。");
} catch (error) {
  clearInterval(poll);
  await session?.close();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
