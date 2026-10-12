import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// 用官方安装的新启动器建立新会话；只更新独立Repair Ticket，不写正式视频对象。
const repo = resolve(import.meta.dirname, "..");
const plugin = process.env.ATTENTION_INSTALLED_PLUGIN;
if (!plugin) throw new Error("需要指定已正式安装并通过发行校验的插件目录");
const workspace = join(repo, "workspace");
const state = JSON.parse(await readFile(join(workspace, ".videoflowcut-runtime/runtime.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(plugin, "runtime/dist/manifest.json"), "utf8"));
const transport = new StdioClientTransport({ command: process.execPath, args: [join(plugin, "scripts/mcp-launcher.mjs")], cwd: repo, stderr: "pipe", env: { ...process.env as Record<string, string>, VIDEOCUT_WORKSPACE: workspace, VIDEOFLOWCUT_PORT: "3100", VIDEOCUT_YT_DLP_PATH: state.youtubeDownloaderPath, ...(state.bridgeUrl ? { COMFYUI_BRIDGE_URL: state.bridgeUrl } : {}), VIDEOFLOWCUT_SFX_ROOTS: "E:\\ai\\音效" } });
const client = new Client({ name: "平台修复新发行部署确认", version: "1.0.0" });
const call = async (name: string, parameters: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: parameters });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(((result.content as { type: string; text?: string }[]).find(item => item.type === "text")!).text!);
};
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.find(tool => tool.name === "mark_repair_deployed")?.inputSchema.properties?.ticket_id);
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true); assert.equal(release.mcpReleaseId, manifest.releaseId); assert.equal(release.launcherReleaseId, manifest.releaseId);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  console.log(JSON.stringify(release));
  const evidence = `官方codex plugin add安装0.1.69，verify-installed-release逐项通过。正式3100受控切换，新Runtime ${release.runtime.runtimeId}、新启动器会话MCP与Runtime和launcherReleaseId同为${manifest.releaseId}，API/媒体/渲染Worker健康。独立候选完整862帧成功，最终发行三执行入口与完整验证SHA256一致，最终同版三大字体smoke成功。正式项目未修改；由原报告Agent重连核Revision并ack后恢复创作。`;
  const tickets = [];
  for (const id of ["ae5d55fb-416e-43b4-8798-b2c275a210a2", "93c1f860-63b8-42ba-8025-4367086aa113", "82bd6b25-2c88-43d4-8eac-5c4f72e6b024"]) tickets.push(await call("mark_repair_deployed", { ticket_id: "repair_ticket_" + id, repairer_id: "/root/platform_repair", deployment_evidence: evidence }));
  await writeFile(join(repo, ".repair-validation/attention-deployment.json"), JSON.stringify({ release, tickets }, null, 2));
  console.log(JSON.stringify({ deployed: true, releaseId: manifest.releaseId, ticketStates: tickets.map(ticket => ticket.status) }));
} finally { await client.close(); await transport.close(); }
