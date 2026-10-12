import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  MCP_CAPABILITY_GROUPS,
  PLUGIN_LAUNCHER_CONFIGURATION_CATALOG,
  RUNTIME_CONFIGURATION_CATALOG,
  WEB_CONFIGURATION_CATALOG,
  getProjectOverview,
  readRuntimeConfig
} from "../packages/project-overview/src/index.js";

const repositoryRoot = process.cwd();
const mcpSourcePath = join(repositoryRoot, "apps", "server", "src", "mcp.ts");
const webApiSourcePath = join(repositoryRoot, "apps", "web", "src", "api.ts");
const viteConfigPath = join(repositoryRoot, "apps", "web", "vite.config.ts");
const launcherSourcePath = join(repositoryRoot, "plugins", "videoflowcut", "scripts", "runtime-launcher.mjs");

function registeredToolNames(source: string): string[] {
  return [...source.matchAll(/server\.registerTool\("([^"]+)"/gu)].map((match) => match[1]!);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if ([".ts", ".tsx", ".js", ".mjs"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function environmentKeys(source: string): string[] {
  // 不把 Windows 的 SystemRoot 截断识别成一个名为 S 的项目配置。
  return [...source.matchAll(/(?:process\.env|import\.meta\.env|environment)\.([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])/gu)]
    .map((match) => match[1]!);
}

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    assert.fail("MCP 应返回标准 content 结果");
  }
  const first = result.content[0];
  if (!first || typeof first !== "object" || !("type" in first) || first.type !== "text" || !("text" in first) || typeof first.text !== "string") {
    assert.fail("MCP 应返回文本内容");
  }
  return first.text;
}

test("MCP 注册工具全部归入项目总览能力目录", async () => {
  const source = (await Promise.all([mcpSourcePath, ...["motion-tools", "motion-library-tools", "media-intelligence-tools", "sound-tools", "source-research-tools"].map((name) => join(repositoryRoot, `apps/server/src/${name}.ts`))].map((path) => readFile(path, "utf8")))).join("\n");
  const registered = registeredToolNames(source);
  const catalogued = MCP_CAPABILITY_GROUPS.flatMap((group) => group.tools);
  const missing = registered.filter((name) => !catalogued.includes(name));
  const obsolete = catalogued.filter((name) => !registered.includes(name));
  const duplicate = catalogued.filter((name, index) => catalogued.indexOf(name) !== index);

  assert.ok(registered.length > 0, "MCP 源码中应存在 registerTool 调用");
  assert.deepEqual(missing, [], `新增 MCP 工具必须同时写入项目总览：${missing.join("、")}`);
  assert.deepEqual(obsolete, [], `项目总览包含未注册的 MCP 工具：${obsolete.join("、")}`);
  assert.deepEqual(duplicate, [], `同一 MCP 工具不能重复归入多个分组：${duplicate.join("、")}`);
});

test("项目总览集中读取 Node 配置且不泄漏敏感值", () => {
  const environment = {
    VIDEOCUT_WORKSPACE: "E:/workspace-demo",
    PORT: "4100",
    HOST: "0.0.0.0",
    WEB_ORIGIN: "http://127.0.0.1:5174",
    SERVE_WEB: "true",
    COMFYUI_BRIDGE_URL: "http://127.0.0.1:8188/comfyui-bridge/v1",
    PEXELS_API_KEY: "secret-do-not-return",
    VIDEOFLOWCUT_RUNTIME_TOKEN: "runtime-secret"
  };
  const config = readRuntimeConfig({ environment, cwd: "E:/ignored" });
  const overview = getProjectOverview({ environment, cwd: "E:/ignored" });

  assert.equal(config.workspace.root, "E:/workspace-demo");
  assert.equal(config.http.port, 4100);
  assert.equal(config.http.host, "0.0.0.0");
  assert.equal(config.http.serveWeb, true);
  assert.equal(overview.configuration.providers.requiresKey, false);
  assert.deepEqual(Object.keys(config.providers), ["youtubeDownloaderPath"]);
  assert.doesNotMatch(JSON.stringify(overview.configuration), /TAVILY_API_KEY|PEXELS_API_KEY|FREESOUND_/);
  assert.equal(overview.configuration.runtime.runtimeTokenConfigured, true);
  assert.doesNotMatch(JSON.stringify(overview), /secret-do-not-return|runtime-secret/u);
});

test("Web 与插件启动器配置也在项目总览中可见", async () => {
  const [webApiSource, viteSource, launcherSource] = await Promise.all([
    readFile(webApiSourcePath, "utf8"),
    readFile(viteConfigPath, "utf8"),
    readFile(launcherSourcePath, "utf8")
  ]);
  const webKeys = WEB_CONFIGURATION_CATALOG.map((entry) => entry.key);
  const launcherKeys = PLUGIN_LAUNCHER_CONFIGURATION_CATALOG.map((entry) => entry.key);

  assert.ok(webKeys.includes("VITE_API_BASE"));
  assert.ok(webKeys.includes("vite.server.host"));
  assert.ok(webKeys.includes("vite.server.port"));
  assert.match(webApiSource, /import\.meta\.env\.VITE_API_BASE/u);
  assert.match(viteSource, /host:\s*"127\.0\.0\.1"/u);
  assert.match(viteSource, /port:\s*5173/u);
  assert.deepEqual(launcherKeys, ["VIDEOFLOWCUT_REPO_ROOT", "VIDEOFLOWCUT_PORT", "NODE_PATH"]);
  assert.match(launcherSource, /VIDEOFLOWCUT_REPO_ROOT/u);
  assert.match(launcherSource, /VIDEOFLOWCUT_PORT/u);
});

test("环境变量目录扫描不截断混合大小写系统变量", () => {
  assert.deepEqual(environmentKeys("process.env.SystemRoot; process.env.VIDEOCUT_WORKSPACE; environment.PORT"), ["VIDEOCUT_WORKSPACE", "PORT"]);
});

test("显式环境变量与总览配置目录严格一致", async () => {
  const roots = [
    join(repositoryRoot, "apps"),
    join(repositoryRoot, "packages"),
    join(repositoryRoot, "plugins", "videoflowcut", "scripts"),
    join(repositoryRoot, "scripts")
  ];
  const files = (await Promise.all(roots.map((root) => sourceFiles(root)))).flat();
  const actual = new Set<string>();
  for (const file of files) {
    for (const key of environmentKeys(await readFile(file, "utf8"))) actual.add(key);
  }
  const catalogued = new Set(
    RUNTIME_CONFIGURATION_CATALOG
      .map((entry) => entry.key)
      .filter((key) => /^[A-Z][A-Z0-9_]*$/u.test(key))
  );

  assert.deepEqual([...actual].sort(), [...catalogued].sort());
});

test("项目总览 MCP 可发现并返回创作与素材操作表结构，且不泄漏密钥", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-overview-mcp-"));
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: repositoryRoot,
    env: {
      ...inheritedEnvironment,
      VIDEOCUT_WORKSPACE: workspaceRoot,
      PEXELS_API_KEY: "overview-test-pexels-secret",
      VIDEOFLOWCUT_RUNTIME_TOKEN: "overview-test-runtime-secret"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-project-overview-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "read_project_overview"));
    const overview = JSON.parse(textFromToolResult(await client.callTool({ name: "read_project_overview", arguments: {} }))) as {
      database: { engine: string; tables: Array<{ name: string }> };
    };
    assert.equal(overview.database.engine, "SQLite");
    assert.deepEqual(overview.database.tables.map((table) => table.name).sort(), ["projects", "revisions", "jobs", "export_artifacts", "repair_tickets", "media_sources", "media_analysis_records", "media_observations", "media_vectors", "media_search_sessions", "motion_library_cache"].sort());
    assert.doesNotMatch(JSON.stringify(overview), /overview-test-pexels-secret|overview-test-runtime-secret/u);
  } finally {
    await transport.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
