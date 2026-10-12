import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pluginRootFromModule, resolveReleaseRuntime } from "./repo-root.mjs";

const PLUGIN_NAME = "videoflowcut";
const MCP_SERVER_NAME = "videoflowcut";
const MCP_LAUNCHER_ARGUMENT = "./scripts/mcp-launcher.mjs";

function fail(message) {
  throw new Error(`已安装插件发行校验失败：${message}`);
}

function usage() {
  return "用法：verify-installed-release.mjs --installed-plugin-root <Codex 实际安装的插件绝对路径>";
}

function requiredInstalledPluginRoot(args) {
  const indexes = args.reduce((result, argument, index) => {
    if (argument === "--installed-plugin-root") result.push(index);
    return result;
  }, []);
  if (indexes.length !== 1) fail(`${usage()}；--installed-plugin-root 必须且只能提供一次。`);
  const value = args[indexes[0] + 1];
  if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
    fail("--installed-plugin-root 必须是非空绝对路径，不能回退到环境变量或缓存默认位置。");
  }
  if (!isAbsolute(value)) fail("--installed-plugin-root 必须是绝对路径。");
  return resolve(value);
}

function canonicalDirectory(path, label) {
  if (!existsSync(path)) fail(`${label}不存在：${path}`);
  if (!statSync(path).isDirectory()) fail(`${label}不是目录：${path}`);
  try {
    return realpathSync.native(path);
  } catch (error) {
    fail(`无法解析${label}真实路径：${error instanceof Error ? error.message : String(error)}`);
  }
}

function comparablePath(path) {
  // Windows 文件系统通常不区分大小写；统一后可避免通过大小写变化绕过源码目录拒绝。
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function sameDirectory(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label}不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function digestFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${label}缺失：${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inspectPluginIdentity(pluginRoot) {
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = readJson(manifestPath, "插件 manifest");
  if (manifest?.name !== PLUGIN_NAME || typeof manifest.version !== "string" || !manifest.version.trim()
    || manifest.skills !== "./skills/" || manifest.mcpServers !== "./.mcp.json") {
    fail("插件 manifest 缺少可安装身份或 MCP/Skills 声明。");
  }
  return {
    name: manifest.name,
    version: manifest.version,
    skills: manifest.skills,
    mcpServers: manifest.mcpServers,
    manifestDigest: digestFile(manifestPath, "插件 manifest")
  };
}

/**
 * 这些脚本是 .mcp.json 启动后真实导入的最小根链：MCP 启动器先解析仓库，
 * 再由 Runtime 启动器拉起已验证的 dist。它们不在 runtime/dist 摘要内，必须单列。
 */
function inspectMcpStartupChain(pluginRoot) {
  const scripts = {
    mcpLauncher: "scripts/mcp-launcher.mjs",
    mcpSession: "scripts/mcp-session.mjs",
    renderBrowser: "scripts/prepare-render-browser.mjs",
    repoRoot: "scripts/repo-root.mjs",
    runtimeLauncher: "scripts/runtime-launcher.mjs"
  };
  return Object.fromEntries(Object.entries(scripts).map(([name, path]) => [
    name,
    digestFile(join(pluginRoot, path), `MCP 启动链脚本 ${path}`)
  ]));
}

function inspectRuntimeRepoPointer(pluginRoot) {
  const pointerPath = join(pluginRoot, "runtime", "repo-root.json");
  const pointer = readJson(pointerPath, "发行仓库定位指针");
  if (pointer?.schemaVersion !== 1 || typeof pointer.repoRoot !== "string" || !pointer.repoRoot.trim()) {
    fail("发行仓库定位指针缺少合法 repoRoot。");
  }
  return digestFile(pointerPath, "发行仓库定位指针");
}

/**
 * Skill 会直接影响剪辑任务可选的 MCP 入口，因此安装快照必须保存同一棵内容树。
 * 摘要仅覆盖 plugins/videoflowcut/skills 下的正规文件，不把无关插件文件纳入发布契约。
 */
function inspectSkillsTree(pluginRoot) {
  const skillsRoot = join(pluginRoot, "skills");
  if (!existsSync(skillsRoot) || !statSync(skillsRoot).isDirectory()) fail("插件 Skills 根目录缺失。");
  const files = [];
  const collect = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        collect(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        fail(`插件 Skills 不能包含非正规文件：${path}`);
      }
    }
  };
  collect(skillsRoot);
  const hash = createHash("sha256");
  for (const path of files) {
    const pathInTree = relative(skillsRoot, path).replace(/\\/gu, "/");
    hash.update(pathInTree);
    hash.update("\u0000");
    hash.update(readFileSync(path));
    hash.update("\u0000");
  }
  return {
    fileCount: files.length,
    treeDigest: hash.digest("hex")
  };
}

/**
 * 发行摘要只覆盖 runtime/dist；MCP 启动器位于插件根目录，因此必须单独摘要，
 * 否则安装快照可能带着旧启动器连接到错误的 Runtime。
 */
function inspectMcpEntry(pluginRoot) {
  const configPath = join(pluginRoot, ".mcp.json");
  const mcp = readJson(configPath, "插件 MCP 配置");
  const server = mcp?.mcpServers?.[MCP_SERVER_NAME];
  if (server?.command !== "node" || !Array.isArray(server.args) || server.args[0] !== MCP_LAUNCHER_ARGUMENT) {
    fail("插件 MCP 入口必须是 node ./scripts/mcp-launcher.mjs。");
  }
  const launcherPath = resolve(pluginRoot, MCP_LAUNCHER_ARGUMENT);
  const relativeLauncher = relative(pluginRoot, launcherPath).replace(/\\/gu, "/");
  if (relativeLauncher !== "scripts/mcp-launcher.mjs") {
    fail("插件 MCP 启动器必须位于插件根目录的 scripts/mcp-launcher.mjs。");
  }
  return {
    command: server.command,
    args: server.args,
    launcher: MCP_LAUNCHER_ARGUMENT,
    configDigest: digestFile(configPath, "插件 MCP 配置"),
    startupChain: inspectMcpStartupChain(pluginRoot),
    runtimeRepoPointerDigest: inspectRuntimeRepoPointer(pluginRoot)
  };
}

/**
 * 每一侧都先独立调用 resolveReleaseRuntime，重新验证 manifest 与 runtime 内容摘要，
 * 再返回用于跨快照比对的最小、可审计身份。
 */
function inspectPluginRelease(pluginRoot, label) {
  const canonicalRoot = canonicalDirectory(pluginRoot, `${label}插件根目录`);
  const plugin = inspectPluginIdentity(canonicalRoot);
  let release;
  try {
    release = resolveReleaseRuntime(canonicalRoot);
  } catch (error) {
    fail(`${label}Runtime 发行物无效：${error instanceof Error ? error.message : String(error)}`);
  }
  const runtimeManifest = readJson(release.manifest, `${label}Runtime manifest`);
  const mcp = inspectMcpEntry(canonicalRoot);
  const skills = inspectSkillsTree(canonicalRoot);
  return {
    pluginRoot: canonicalRoot,
    pluginVersion: plugin.version,
    plugin,
    // resolveReleaseRuntime 已依据 runtime/dist 实际文件重算并验证这个内容摘要。
    runtimeContentHash: release.releaseId,
    releaseId: release.releaseId,
    runtimeManifest: {
      schemaVersion: runtimeManifest.schemaVersion,
      format: runtimeManifest.format,
      pluginVersion: runtimeManifest.pluginVersion,
      runtimeEntry: runtimeManifest.runtimeEntry,
      mcpEntry: runtimeManifest.mcpEntry,
      remotionEntry: runtimeManifest.remotionEntry,
      webRoot: runtimeManifest.webRoot,
      nodeRuntime: runtimeManifest.nodeRuntime
    },
    mcp,
    skills
  };
}

function requireEqual(field, source, installed) {
  if (JSON.stringify(source) !== JSON.stringify(installed)) {
    fail(`已安装快照与源码的${field}不一致。`);
  }
}

export function verifyInstalledRelease(args, { sourcePluginRoot = pluginRootFromModule(import.meta.url) } = {}) {
  const sourceRoot = canonicalDirectory(sourcePluginRoot, "源码插件根目录");
  const installedRoot = canonicalDirectory(requiredInstalledPluginRoot(args), "已安装插件根目录");
  if (sameDirectory(sourceRoot, installedRoot)) {
    fail("--installed-plugin-root 不能指向源码插件目录；必须提供 Codex 实际安装的独立快照。\n" + usage());
  }

  const source = inspectPluginRelease(sourceRoot, "源码");
  const installed = inspectPluginRelease(installedRoot, "已安装");
  requireEqual("插件版本", source.pluginVersion, installed.pluginVersion);
  requireEqual("插件 manifest 声明身份", source.plugin, installed.plugin);
  requireEqual("Runtime 内容摘要", source.runtimeContentHash, installed.runtimeContentHash);
  requireEqual("Release ID", source.releaseId, installed.releaseId);
  requireEqual("Runtime manifest", source.runtimeManifest, installed.runtimeManifest);
  requireEqual("MCP 入口", source.mcp, installed.mcp);
  requireEqual("Skills 内容树", source.skills, installed.skills);

  return {
    verified: true,
    source,
    installed
  };
}

async function main() {
  const result = verifyInstalledRelease(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
