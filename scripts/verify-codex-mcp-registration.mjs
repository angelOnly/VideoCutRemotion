import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyInstalledRelease } from "../plugins/videoflowcut/scripts/verify-installed-release.mjs";

function fail(message) {
  throw new Error(`Codex MCP 注册校验失败：${message}`);
}

function samePath(left, right) {
  if (typeof left !== "string" || !isAbsolute(left)) return false;
  const canonical = (value) => process.platform === "win32" ? normalize(value).toLowerCase() : normalize(value);
  return canonical(left) === canonical(right);
}

// 已安装文件正确不代表宿主启动入口正确；两项分别核验，避免旧缓存路径被遗漏。
export function assertCodexMcpRegistration(registration, { installedPluginRoot, repoRoot, mcpSpec }) {
  if (registration?.name !== "videoflowcut" || registration.enabled !== true || registration.disabled_reason) {
    fail("videoflowcut 未直接注册或未启用。");
  }
  const transport = registration.transport;
  if (transport?.type !== "stdio" || transport.command !== mcpSpec.command) fail("启动命令与已安装声明不一致。");
  const args = transport.args;
  const expectedLauncher = resolve(installedPluginRoot, mcpSpec.args[0]);
  if (!Array.isArray(args) || args.length !== mcpSpec.args.length || !samePath(args[0], expectedLauncher)
    || args.slice(1).some((value, index) => value !== mcpSpec.args[index + 1])) {
    fail("启动路径不是本次安装版的绝对入口；更新注册后重新载入空闲剪辑任务，不能只报告安装成功。");
  }
  if (!samePath(transport.cwd, repoRoot)) fail("工作目录必须是稳定仓库目录，不能绑定可被升级清理的安装槽。");
  const environment = transport.env ?? {};
  const expectedEnvironment = mcpSpec.env ?? {};
  if (Object.keys(environment).length !== Object.keys(expectedEnvironment).length
    || Object.entries(expectedEnvironment).some(([key, value]) => environment[key] !== value)
    || (transport.env_vars ?? []).length) fail("运行环境与安装声明不同，需独立验证，不能静默改变工作区或端口。");
  if (registration.startup_timeout_sec !== mcpSpec.startup_timeout_sec
    || registration.tool_timeout_sec !== mcpSpec.tool_timeout_sec) fail("超时设置与安装声明不同。");
  if (registration.enabled_tools != null || registration.disabled_tools != null) fail("检测到额外工具过滤，不能将残缺工具表视为发布完成。");
  return { hostRegistrationVerified: true, launcher: expectedLauncher, desktopConnectionVerified: false };
}

export function verifyCodexMcpRegistration(args) {
  const cliIndex = args.indexOf("--codex-cli");
  const codexCli = args[cliIndex + 1];
  if (cliIndex < 0 || args.lastIndexOf("--codex-cli") !== cliIndex || !codexCli || !isAbsolute(codexCli)) {
    fail("必须提供 --codex-cli <当前宿主 Codex 可执行文件绝对路径>。");
  }
  const release = verifyInstalledRelease(args);
  const installedPluginRoot = resolve(args[args.indexOf("--installed-plugin-root") + 1]);
  const repoRoot = resolve(import.meta.dirname, "..");
  const mcpSpec = JSON.parse(readFileSync(join(installedPluginRoot, ".mcp.json"), "utf8")).mcpServers.videoflowcut;
  // 只调用官方只读配置查询，不启动独立剪辑任务、不访问正式视频对象、不改变审批规则。
  const registration = JSON.parse(execFileSync(codexCli, ["mcp", "get", "videoflowcut", "--json"], {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024
  }));
  const host = assertCodexMcpRegistration(registration, { installedPluginRoot, repoRoot, mcpSpec });
  return {
    installedReleaseVerified: release.verified,
    releaseId: release.installed.releaseId,
    ...host,
    pendingVerification: "仍需现有剪辑任务真实调用 read_runtime_release；本命令不证明桌面会话已连接。"
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(verifyCodexMcpRegistration(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
