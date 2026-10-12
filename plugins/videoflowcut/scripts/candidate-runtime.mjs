import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  pluginRootFromModule,
  readOption,
  resolveRepoRoot
} from "./repo-root.mjs";
import {
  ensureRuntime,
  getRuntimeStatus,
  stopRuntime
} from "./runtime-launcher.mjs";

/**
 * 这三个值是正式 Runtime A 的保守边界。候选 Runtime B 即使调用者遗漏了
 * 外部环境配置，也绝不能使用它们；实际生产若另有自定义边界，应在候选命令中
 * 继续显式传入与之不同的候选值。
 */
export const PRODUCTION_RUNTIME_PORT = 3100;
export const PRODUCTION_COMFYUI_PORT = 8188;

function fail(message) {
  throw new Error(`候选 Runtime 配置无效：${message}`);
}

function requiredOption(args, name) {
  const value = readOption(args, name);
  if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
    fail(`必须显式提供 ${name}，不能回退到环境变量或默认值。`);
  }
  return value.trim();
}

function pathsOverlap(left, right) {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return leftToRight === "" || rightToLeft === "" || (!leftToRight.startsWith("..") && !isAbsolute(leftToRight))
    || (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft));
}

function normalizePort(rawPort, label) {
  if (!/^\d+$/u.test(rawPort)) fail(`${label} 必须是 1024 到 65535 之间的整数。`);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    fail(`${label} 必须是 1024 到 65535 之间的整数。`);
  }
  return port;
}

function normalizeCandidatePort(rawPort) {
  const port = normalizePort(rawPort, "--port");
  if (port === PRODUCTION_RUNTIME_PORT) {
    fail(`--port 不能使用生产 Runtime 端口 ${PRODUCTION_RUNTIME_PORT}。`);
  }
  return port;
}

function parseBridgeUrl(rawBridgeUrl, label) {
  let bridge;
  try {
    bridge = new URL(rawBridgeUrl);
  } catch {
    fail(`${label} 必须是完整的 HTTP(S) 地址。`);
  }
  if (bridge.protocol !== "http:" && bridge.protocol !== "https:") {
    fail(`${label} 必须使用 HTTP(S) 协议。`);
  }
  return bridge;
}

function normalizeCandidateBridgeUrl(rawBridgeUrl) {
  const bridge = parseBridgeUrl(rawBridgeUrl, "--comfyui-bridge-url");
  if (bridge.username || bridge.password || bridge.hash || bridge.search) {
    fail("--comfyui-bridge-url 不能包含凭据、查询参数或片段。");
  }
  if (bridge.port === String(PRODUCTION_COMFYUI_PORT)) {
    fail(`--comfyui-bridge-url 不能指向生产 ComfyUI 端口 ${PRODUCTION_COMFYUI_PORT}。`);
  }
  // URL.toString() 会统一主机大小写和默认端口；去掉末尾 / 让实例状态可稳定比较。
  return bridge.toString().replace(/\/$/u, "");
}

/**
 * 候选绝不从环境变量取默认值；但继承环境可能正是正在服务剪辑任务的生产配置。
 * 将其视为 denylist 可避免生产采用自定义路径/端口时，候选只绕过默认值检查。
 */
function currentProductionBoundaries(repoRoot, environment) {
  const workspaceRoots = [resolve(repoRoot, "workspace")];
  if (environment.VIDEOCUT_WORKSPACE !== undefined) {
    if (!isAbsolute(environment.VIDEOCUT_WORKSPACE)) {
      fail("当前环境中的 VIDEOCUT_WORKSPACE 不是绝对路径，无法安全判断候选工作区是否隔离。");
    }
    workspaceRoots.push(resolve(environment.VIDEOCUT_WORKSPACE));
  }

  let runtimePort;
  if (environment.VIDEOFLOWCUT_PORT !== undefined) {
    runtimePort = normalizePort(environment.VIDEOFLOWCUT_PORT, "当前环境中的 VIDEOFLOWCUT_PORT");
  }

  let bridgeHost;
  if (environment.COMFYUI_BRIDGE_URL?.trim()) {
    // 同一 host:port 即使换了代理路径，仍可能落到同一 ComfyUI 队列，必须拒绝。
    bridgeHost = parseBridgeUrl(environment.COMFYUI_BRIDGE_URL, "当前环境中的 COMFYUI_BRIDGE_URL").host;
  }
  return { workspaceRoots: [...new Set(workspaceRoots)], runtimePort, bridgeHost };
}

/**
 * 仅解析和校验候选边界，不读写工作区、不探测端口，也不启动服务。
 * 该函数导出给最小回归测试，避免候选验证自身意外触碰正式 Runtime。
 */
export function resolveCandidateRuntimeOptions(
  args,
  { pluginRoot = pluginRootFromModule(import.meta.url), environment = process.env } = {}
) {
  const repoRootArgument = readOption(args, "--repo-root");
  const repoRoot = resolveRepoRoot({ pluginRoot, explicitRoot: repoRootArgument });
  const workspaceArgument = requiredOption(args, "--workspace");
  if (!isAbsolute(workspaceArgument)) fail("--workspace 必须是绝对路径。");
  const workspaceRoot = resolve(workspaceArgument);
  const production = currentProductionBoundaries(repoRoot, environment);
  const overlappingWorkspace = production.workspaceRoots.find((productionWorkspace) => pathsOverlap(workspaceRoot, productionWorkspace));
  if (overlappingWorkspace) {
    fail(`--workspace 不能与生产工作区重叠：${overlappingWorkspace}。`);
  }
  const port = normalizeCandidatePort(requiredOption(args, "--port"));
  if (port === production.runtimePort) {
    fail(`--port 不能使用当前环境中的生产 Runtime 端口 ${production.runtimePort}。`);
  }
  const bridgeUrl = normalizeCandidateBridgeUrl(requiredOption(args, "--comfyui-bridge-url"));
  if (new URL(bridgeUrl).host === production.bridgeHost) {
    fail(`--comfyui-bridge-url 不能与当前环境中的生产 ComfyUI Bridge 共用端点 ${production.bridgeHost}。`);
  }
  return {
    pluginRoot,
    repoRoot,
    workspaceRoot,
    port,
    bridgeUrl,
    apiUrl: `http://127.0.0.1:${port}`
  };
}

function usage() {
  return [
    "用法：candidate-runtime.mjs <validate|ensure|start|open|status|stop>",
    "  --workspace <独立绝对路径> --port <非 3100 端口>",
    "  --comfyui-bridge-url <非 8188 的完整 Bridge URL> [--repo-root <仓库绝对路径>]"
  ].join("\n");
}

export async function runCandidateRuntime(command, args) {
  const options = resolveCandidateRuntimeOptions(args);
  if (command === "validate") {
    return { candidate: true, validated: true, ...options };
  }
  if (command === "ensure" || command === "start" || command === "open") {
    const runtime = await ensureRuntime(options);
    return command === "open" ? { ...runtime, url: runtime.webUrl } : runtime;
  }
  if (command === "status") return getRuntimeStatus(options);
  if (command === "stop") return stopRuntime(options, { force: true });
  fail(`${usage()}\n未知命令：${command}`);
}

async function main() {
  const rawArguments = process.argv.slice(2);
  const command = rawArguments[0] && !rawArguments[0].startsWith("--")
    ? rawArguments.shift()
    : "ensure";
  const result = await runCandidateRuntime(command, rawArguments);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
