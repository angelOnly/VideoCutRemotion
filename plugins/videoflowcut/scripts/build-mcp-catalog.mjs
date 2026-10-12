import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** 从刚构建的 MCP 导出真实 Schema；临时数据库与生产目录、Worker 队列完全隔离。 */
export async function buildMcpCatalog({ repoRoot, distRoot }) {
  const candidateRoot = resolve(repoRoot, ".candidate");
  await mkdir(candidateRoot, { recursive: true });
  const workspaceRoot = await mkdtemp(join(candidateRoot, "mcp-catalog-"));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(distRoot, "mcp.cjs")], cwd: repoRoot, stderr: "pipe",
    env: { ...process.env, NODE_PATH: [join(repoRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter),
      VIDEOCUT_WORKSPACE: workspaceRoot, WEB_ORIGIN: "http://127.0.0.1:1/", VIDEOFLOWCUT_RUNTIME_DIST: distRoot }
  });
  let stderr = "";
  transport.stderr?.on("data", (data) => { stderr = (stderr + data.toString()).slice(-4000); });
  const client = new Client({ name: "videoflowcut-catalog-build", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    if (!result.tools.length || new Set(result.tools.map((tool) => tool.name)).size !== result.tools.length) {
      throw new Error("发行 MCP 未提供完整、唯一的工具目录");
    }
    await writeFile(join(distRoot, "mcp-tools.json"), JSON.stringify({ schemaVersion: 1, tools: result.tools }, null, 2) + "\n");
    return result.tools.length;
  } catch (error) {
    throw new Error(`MCP 发行目录生成失败：${error.message}\n${stderr}`);
  } finally {
    await client.close();
    await transport.close();
    // Windows 递归清理前核对绝对目标，只删除本次 mkdtemp 产生的候选目录。
    const pathInCandidate = relative(candidateRoot, resolve(workspaceRoot));
    if (!pathInCandidate.startsWith("mcp-catalog-") || pathInCandidate.includes("..") || /[\\/]/u.test(pathInCandidate)) {
      throw new Error("拒绝清理候选根目录之外的路径");
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
