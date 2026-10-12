import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareRenderBrowser } from "./prepare-render-browser.mjs";
import {
  pluginRootFromModule,
  readOption,
  releaseNodePath,
  resolveReleaseRuntime,
  resolveRepoRoot,
  resolveWorkspaceRoot
} from "./repo-root.mjs";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3100;
const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 8_000;
// 仅记录本次启动器进程亲自创建的 ChildProcess；不能把磁盘状态里的 PID 当作终止授权。
const locallyStartedRuntimes = new Map();
// 只记本进程已经结束业务、却暂未删除成功的锁；不凭 PID 回收仍在执行的操作。
const completedOperationLocks = new Map();

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function runtimePaths(workspaceRoot, port = DEFAULT_PORT) {
  const directory = join(workspaceRoot, ".videoflowcut-runtime");
  const suffix = port === DEFAULT_PORT ? "runtime" : `runtime-${port}`;
  return {
    directory,
    state: join(directory, `${suffix}.json`),
    lock: join(directory, "launch.lock"),
    log: join(directory, `${suffix}.log`)
  };
}

function apiUrl(port) {
  return `http://${HOST}:${port}`;
}

function normalizePort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("VIDEOFLOWCUT_PORT 必须是 1024 到 65535 之间的整数。");
  }
  return port;
}

/**
 * Bridge 地址也属于 Runtime 的实际执行环境。候选环境变更 Bridge 时必须重新
 * 拉起 Worker，不能复用仍指向旧 ComfyUI 队列的 Runtime。
 */
function normalizeBridgeUrl(rawBridgeUrl) {
  if (rawBridgeUrl === undefined || rawBridgeUrl === null) return undefined;
  const bridgeUrl = String(rawBridgeUrl).trim();
  return bridgeUrl || undefined;
}

function normalizeOptions(options = {}) {
  const pluginRoot = options.pluginRoot ?? pluginRootFromModule(import.meta.url);
  const repoRoot = resolve(options.repoRoot ?? resolveRepoRoot({ pluginRoot }));
  const workspaceRoot = resolveWorkspaceRoot(repoRoot, options.workspaceRoot);
  const port = normalizePort(options.port ?? process.env.VIDEOFLOWCUT_PORT ?? DEFAULT_PORT);
  const bridgeUrl = normalizeBridgeUrl(options.bridgeUrl ?? process.env.COMFYUI_BRIDGE_URL);
  const downloaderSetting = process.env.VIDEOCUT_YT_DLP_PATH?.trim();
  const youtubeDownloaderPath = downloaderSetting ? resolve(downloaderSetting) : undefined;
  return { pluginRoot, repoRoot, workspaceRoot, port, bridgeUrl, youtubeDownloaderPath, apiUrl: apiUrl(port) };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** 基础剪辑就绪只依赖 API 和静态 Web；可选 Bridge 不会成为启动门槛。 */
async function isApiAndWebReady(url) {
  try {
    const projects = await fetchWithTimeout(`${url}/api/projects`);
    if (!projects.ok || !Array.isArray(await projects.json())) return false;
    const web = await fetchWithTimeout(`${url}/`);
    return web.ok && (await web.text()).includes("id=\"root\"");
  } catch {
    return false;
  }
}

async function readInternalStatus(url, controlToken) {
  if (!controlToken) return undefined;
  try {
    const response = await fetchWithTimeout(`${url}/internal/runtime/status`, {
      headers: { "x-videoflowcut-runtime-token": controlToken }
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 发行版本不同也可能是同一启动器此前创建的 Runtime。只有环境、实例标识和控制令牌
 * 都可供后续 HTTP 认证时，才允许把它当作“可安全切换”的旧版，而非未知监听进程。
 */
function isManagedStateForOptions(state, options) {
  return state
    && state.schemaVersion === 3
    && state.repoRoot === options.repoRoot
    && state.workspaceRoot === options.workspaceRoot
    && state.apiUrl === options.apiUrl
    && typeof state.controlToken === "string"
    && typeof state.runtimeId === "string"
    && typeof state.runtimeEntry === "string"
    && typeof state.distributionRoot === "string"
    && typeof state.releaseId === "string"
    // schemaVersion 3 的旧状态尚未记录 Bridge；仍可被安全识别和停止，
    // 但绝不能在显式指定候选 Bridge 时被复用。
    && (state.bridgeUrl === undefined || typeof state.bridgeUrl === "string")
    && (state.youtubeDownloaderPath === undefined || typeof state.youtubeDownloaderPath === "string");
}

function isMatchingState(state, options, release) {
  return isManagedStateForOptions(state, options)
    // schema 3 明确绑定构建内容；路径相同但发行物已更新时绝不能复用旧 Runtime。
    && (!release || (
      state.runtimeEntry === release.runtimeEntry
      && state.distributionRoot === release.root
      && state.releaseId === release.releaseId
      && state.bridgeUrl === options.bridgeUrl
      // 下载器由 Runtime 子进程继承；旧进程缺少新配置时不能复用。
      && state.youtubeDownloaderPath === options.youtubeDownloaderPath
    ));
}

async function readState(options) {
  return readJson(runtimePaths(options.workspaceRoot, options.port).state);
}

/** MCP 只跟随通过控制令牌认证的运行实例，不因旧插件启动而回滚 Runtime。 */
export async function readActiveMcpDeployment(rawOptions = {}, previousDeployment) {
  const options = normalizeOptions(rawOptions);
  const state = await readState(options);
  if (!isManagedStateForOptions(state, options) || state.bridgeUrl !== options.bridgeUrl || state.youtubeDownloaderPath !== options.youtubeDownloaderPath) {
    throw new Error("找不到与当前工作区、端口、Bridge 和下载器配置一致的受管 Runtime");
  }
  const internal = await readInternalStatus(options.apiUrl, state.controlToken);
  if (!internal) throw new Error("Runtime 状态接口超时或不可达，MCP 暂不执行；不会重放已提交调用");
  if (internal?.runtimeId !== state.runtimeId || internal?.releaseId !== state.releaseId
    || internal.status !== "ready" || !internal.workers?.media || !internal.workers?.render) {
    throw new Error("Runtime 尚未同版健康，MCP 暂不执行；不会重放已提交调用");
  }
  if (previousDeployment?.runtimeId === state.runtimeId && previousDeployment.releaseId === state.releaseId
    && previousDeployment.root === state.distributionRoot) return previousDeployment;
  const activePluginRoot = resolve(state.distributionRoot, "..", "..");
  const release = resolveReleaseRuntime(activePluginRoot);
  if (release.releaseId !== state.releaseId || release.runtimeEntry !== state.runtimeEntry
    || release.root !== state.distributionRoot) throw new Error("运行实例与实际发行摘要不一致");
  return { ...release, pluginRoot: activePluginRoot, runtimeId: state.runtimeId, apiUrl: options.apiUrl };
}

/** 调用方必须持有 Runtime 操作锁；只恢复已部署版本，不让旧插件执行隐式升级或回滚。 */
export async function recoverMcpDeployment(rawOptions = {}, previousDeployment) {
  let options = normalizeOptions(rawOptions);
  const paths = runtimePaths(options.workspaceRoot, options.port);
  const state = await readState(options);
  if (!state && (existsSync(paths.state) || previousDeployment)) {
    throw new Error("Runtime 状态已移除或损坏；不自动覆盖或重启已停止的服务");
  }
  let release;
  if (state) {
    if (!isManagedStateForOptions(state, options) || state.bridgeUrl !== options.bridgeUrl || state.youtubeDownloaderPath !== options.youtubeDownloaderPath) {
      throw new Error("Runtime 状态不属于当前工作区、端口、Bridge 或下载器配置；未自动恢复");
    }
    // 活进程或被占用端口必须通过原有认证，不能因健康探测失败就重启或杀进程。
    if (isProcessAlive(state.pid) || await isPortInUse(options.port)) {
      return readActiveMcpDeployment(options, previousDeployment);
    }
    options = { ...options, pluginRoot: resolve(state.distributionRoot, "..", "..") };
    release = resolveReleaseRuntime(options.pluginRoot);
    if (release.releaseId !== state.releaseId || release.runtimeEntry !== state.runtimeEntry
      || release.root !== state.distributionRoot) throw new Error("恢复被拒绝：已部署发行物摘要或入口不匹配");
  } else {
    release = resolveReleaseRuntime(options.pluginRoot);
  }
  const browserExecutable = await prepareRenderBrowser({ repoRoot: options.repoRoot });
  await ensureRuntimeUnlocked(options, release, browserExecutable);
  return readActiveMcpDeployment(options);
}

/**
 * 只探测本机回环地址是否还能绑定，不终止、也不接管任何未知监听进程。
 */
async function isPortInUse(port) {
  return new Promise((resolveProbe, rejectProbe) => {
    const probe = createTcpServer();
    probe.once("error", (error) => {
      // 无法绑定也一律视为不可安全使用，避免在权限或网络异常时覆盖未知服务。
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") return resolveProbe(true);
      return resolveProbe(true);
    });
    probe.listen({ host: HOST, port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) rejectProbe(error);
        else resolveProbe(false);
      });
    });
  });
}

/**
 * E2E 使用临时工作区和临时端口，避免因用户正常运行的 3100 工作台而相互影响。
 * 端口在释放到 Runtime 真正监听之间仍可能发生竞争，调用方应保留启动失败处理。
 */
export async function findAvailablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const reservation = createTcpServer();
    reservation.once("error", rejectPort);
    reservation.listen({ host: HOST, port: 0, exclusive: true }, () => {
      const address = reservation.address();
      if (!address || typeof address === "string" || !Number.isInteger(address.port)) {
        reservation.close(() => rejectPort(new Error("无法分配 VideoFlowCut E2E 端口。")));
        return;
      }
      reservation.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function releaseCompletedLock(path, lockId) {
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      const owner = JSON.parse(await readFile(path, "utf8"));
      if (owner?.lockId !== lockId || owner?.pid !== process.pid) {
        completedOperationLocks.delete(path);
        return;
      }
      await rm(path, { force: true });
      completedOperationLocks.delete(path);
      return;
    } catch (error) {
      if (error?.code === "ENOENT") {
        completedOperationLocks.delete(path);
        return;
      }
      // Windows 的短暂文件占用可以恢复；持续失败必须保留身份和明确错误，不能静默留死锁。
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || Date.now() >= deadline) {
        throw Object.assign(new Error("Runtime操作已结束，但释放操作锁失败；结果可能已落地，请先读回状态，禁止重放"), { code: "RUNTIME_LOCK_RELEASE_FAILED", cause: error });
      }
      await sleep(100);
    }
  }
}

async function withLaunchLock(options, operation, { waitTimeoutMs = STARTUP_TIMEOUT_MS, signal, operationName = "Runtime启动或部署" } = {}) {
  const paths = runtimePaths(options.workspaceRoot, options.port);
  await mkdir(paths.directory, { recursive: true });
  const deadline = Date.now() + waitTimeoutMs;
  const checkWaiting = () => {
    if (signal?.aborted) throw Object.assign(new Error("等待Runtime操作锁时请求已取消，本次未执行"), { code: "RUNTIME_LOCK_CANCELLED" });
    if (Date.now() >= deadline) throw Object.assign(new Error(`等待Runtime操作锁超过${waitTimeoutMs}毫秒，本次未执行；当前可能有正常调用或部署正在持锁`), { code: "RUNTIME_LOCK_TIMEOUT" });
  };
  while (true) {
    checkWaiting();
    const completedId = completedOperationLocks.get(paths.lock);
    if (completedId) await releaseCompletedLock(paths.lock, completedId);
    let handle;
    try {
      handle = await open(paths.lock, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = await stat(paths.lock).catch(() => undefined);
      const owner = await readJson(paths.lock);
      if (lockStat && Date.now() - lockStat.mtimeMs > STARTUP_TIMEOUT_MS * 2 && !isLaunchLockOwnerCurrent(owner)) {
        await rm(paths.lock, { force: true }).catch(() => undefined);
      } else {
        await sleep(Math.max(1, Math.min(250, deadline - Date.now())));
      }
      continue;
    }
    // 只重试抢锁冲突；业务内部的 EEXIST 也不能导致已执行操作被自动重放。
    const lockId = randomUUID();
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, lockId, createdAt: new Date().toISOString(), operation: operationName }));
      checkWaiting();
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      completedOperationLocks.set(paths.lock, lockId);
      await releaseCompletedLock(paths.lock, lockId);
    }
  }
}

/** PID 会被系统复用：后来出生的同号进程不可能持有更早创建的锁，且绝不能被终止。 */
export function isLaunchLockOwnerCurrent(owner) {
  if (!isProcessAlive(owner?.pid)) return false;
  const createdAt = Date.parse(owner?.createdAt);
  if (!Number.isFinite(createdAt)) return true;
  // 只在过期锁恢复时查询进程出生时间；查不到时保守保留，不按固定超时抢活跃操作的锁。
  const result = process.platform === "win32"
    ? spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", `try { (Get-Process -Id ${Number(owner.pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { exit 1 }`], { encoding: "utf8", windowsHide: true, timeout: 5000 })
    : spawnSync("ps", ["-p", String(owner.pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
  const processStartedAt = result.status === 0 ? Date.parse(result.stdout.trim()) : NaN;
  return !Number.isFinite(processStartedAt) || processStartedAt <= createdAt + 1500;
}

/** 与部署共用同一互斥锁，避免一个 MCP 仍在写入时另一个进程已经切换 Runtime。 */
export function withRuntimeOperationLock(rawOptions, operation, lockOptions = {}) {
  // MCP允许180秒业务调用；不能用25秒抢锁循环误判仍在正常运行的持锁者。
  return withLaunchLock(normalizeOptions(rawOptions), operation, { waitTimeoutMs: 180_000, ...lockOptions });
}

async function tailLog(path) {
  try {
    return (await readFile(path, "utf8")).slice(-4_000);
  } catch {
    return "（尚未写入运行日志）";
  }
}

function spawnRuntime(options, state, release) {
  const paths = runtimePaths(options.workspaceRoot, options.port);
  const descriptor = openSync(paths.log, "a");
  try {
    const child = spawn(process.execPath, [release.runtimeEntry], {
      // 工作目录不能占用可替换的插件安装槽；发行文件仍只按绝对路径/__dirname 定位，不执行源码。
      cwd: options.repoRoot,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", descriptor, descriptor],
      env: {
        ...process.env,
        NODE_PATH: releaseNodePath(options.repoRoot),
        VIDEOFLOWCUT_NODE_MODULES: join(options.repoRoot, "node_modules"),
        VIDEOFLOWCUT_BROWSER_EXECUTABLE: state.browserExecutable,
        HOST,
        PORT: String(options.port),
        WEB_ORIGIN: options.apiUrl,
        VIDEOCUT_WORKSPACE: options.workspaceRoot,
        // 候选启动器会显式传入独立 Bridge；这里覆盖继承环境，确保媒体 Worker
        // 与状态文件使用同一个端点，而不是误连生产 ComfyUI。
        ...(options.bridgeUrl ? { COMFYUI_BRIDGE_URL: options.bridgeUrl } : {}),
        VIDEOFLOWCUT_RUNTIME_DIST: release.root,
        VIDEOFLOWCUT_RUNTIME_ID: state.runtimeId,
        VIDEOFLOWCUT_RUNTIME_TOKEN: state.controlToken,
        VIDEOFLOWCUT_RELEASE_ID: release.releaseId
      }
    });
    child.unref();
    return child;
  } finally {
    closeSync(descriptor);
  }
}

async function waitUntilReady(options, state) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) break;
    if (await isApiAndWebReady(options.apiUrl)) {
      const internal = await readInternalStatus(options.apiUrl, state.controlToken);
      if (internal?.status === "ready" && internal.runtimeId === state.runtimeId
        && internal.releaseId === state.releaseId
        && internal.workers?.media === true && internal.workers?.render === true) {
        return;
      }
    }
    await sleep(250);
  }
  throw new Error(`Runtime 未能在 ${STARTUP_TIMEOUT_MS / 1_000} 秒内就绪。\n${await tailLog(runtimePaths(options.workspaceRoot, options.port).log)}`);
}

export async function getRuntimeStatus(rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const release = resolveReleaseRuntime(options.pluginRoot);
  const state = await readState(options);
  if (!isManagedStateForOptions(state, options)) {
    return {
      configured: Boolean(state),
      ready: false,
      reason: state ? "状态文件不属于当前发行 Runtime、仓库或工作区" : "未启动"
    };
  }
  if (!isMatchingState(state, options, release)) {
    return {
      configured: true,
      ready: false,
      processAlive: isProcessAlive(state.pid),
      apiUrl: options.apiUrl,
      webUrl: `${options.apiUrl}/`,
      port: options.port,
      pid: state.pid,
      startedAt: state.startedAt,
      releaseId: state.releaseId,
      reason: "检测到可认证的旧发行 Runtime；运行 ensure 将执行受控切换。"
    };
  }
  const [apiReady, internal] = await Promise.all([
    isApiAndWebReady(options.apiUrl),
    readInternalStatus(options.apiUrl, state.controlToken)
  ]);
  const processAlive = isProcessAlive(state.pid);
  const ready = apiReady && processAlive && internal?.status === "ready" && internal.runtimeId === state.runtimeId
    && internal.releaseId === state.releaseId
    && internal.workers?.media === true && internal.workers?.render === true;
  return {
    configured: true,
    ready,
    processAlive,
    apiUrl: options.apiUrl,
    webUrl: `${options.apiUrl}/`,
    port: options.port,
    pid: state.pid,
    startedAt: state.startedAt,
    releaseId: state.releaseId,
    bridge: "可选服务；不可用不会阻断基础剪辑"
  };
}

export async function ensureRuntime(rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  // 先验证发行物，绝不在缺少 dist 时退回到 tsx 或仓库源码入口。
  const release = resolveReleaseRuntime(options.pluginRoot);
  // 升级依赖失败必须发生在获取切换锁、停止旧服务之前；实例复用仍在锁内对账。
  const browserExecutable = await prepareRenderBrowser({ repoRoot: options.repoRoot });
  return withLaunchLock(options, () => ensureRuntimeUnlocked(options, release, browserExecutable));
}

/** 与显式发布共用启动实现；恢复路径已经持锁，不能再次获取同一把锁。 */
async function ensureRuntimeUnlocked(options, release, browserExecutable) {
    const paths = runtimePaths(options.workspaceRoot, options.port);
    const state = await readState(options);
    if (isMatchingState(state, options, release)) {
      const current = await getRuntimeStatus(options);
      if (current.ready) return { ...current, reused: true };
      if (await isPortInUse(options.port)) {
        throw new Error(`端口 ${options.port} 上的服务与当前 Runtime 状态不一致。为避免误杀其它进程，未自动覆盖；请先执行 runtime-launcher.mjs status 或 stop。`);
      }
      if (isProcessAlive(state.pid)) {
        throw new Error("已有 VideoFlowCut Runtime 进程仍在启动或异常退出，请先执行 runtime-launcher.mjs stop 后重试。");
      }
      await rm(paths.state, { force: true });
    } else if (state && isManagedStateForOptions(state, options)) {
      // 命令行遗漏下载器配置时不能把已配置的生产进程降级为系统旧版。
      if (state.youtubeDownloaderPath && !options.youtubeDownloaderPath) {
        throw new Error("当前启动环境缺少 VIDEOCUT_YT_DLP_PATH；保留现有 Runtime，请从已配置的 MCP 环境执行受控切换。");
      }
      // 旧 Release 不能被复用，但可先用控制令牌认证后停止，完成从 A 到 B 的受控切换。
      const stopped = await stopRuntimeUnlocked(options, { force: true, requireIdle: true });
      if (!stopped.stopped) {
        throw new Error(`发现旧发行 Runtime，但无法安全停止：${stopped.reason ?? "控制令牌认证失败"}`);
      }
      if (await isPortInUse(options.port)) {
        throw new Error(`旧发行 Runtime 停止后端口 ${options.port} 仍被占用；未覆盖未知进程。`);
      }
    } else if (await isPortInUse(options.port)) {
      throw new Error(`端口 ${options.port} 已被未知服务占用。VideoFlowCut 不会自动终止未知进程。`);
    } else if (state) {
      await rm(paths.state, { force: true });
    }

    const nextState = {
      schemaVersion: 3,
      runtimeId: randomUUID(),
      controlToken: randomUUID(),
      repoRoot: options.repoRoot,
      workspaceRoot: options.workspaceRoot,
      port: options.port,
      apiUrl: options.apiUrl,
      bridgeUrl: options.bridgeUrl,
      youtubeDownloaderPath: options.youtubeDownloaderPath,
      browserExecutable,
      runtimeEntry: release.runtimeEntry,
      distributionRoot: release.root,
      releaseId: release.releaseId,
      startedAt: new Date().toISOString(),
      pid: 0
    };
    const runtimeChild = spawnRuntime(options, nextState, release);
    nextState.pid = runtimeChild.pid;
    if (!nextState.pid) throw new Error("无法启动 VideoFlowCut Runtime 进程。");
    locallyStartedRuntimes.set(nextState.pid, runtimeChild);
    await writeJsonAtomically(paths.state, nextState);
    try {
      await waitUntilReady(options, nextState);
      return { ...(await getRuntimeStatus(options)), reused: false };
    } catch (error) {
      await stopRuntimeUnlocked(options, { force: true });
      throw error;
    }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(200);
  return !isProcessAlive(pid);
}

function terminateProcessTree(pid) {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  process.kill(pid, "SIGTERM");
}

export async function stopRuntime(rawOptions = {}, stopOptions = {}) {
  const options = normalizeOptions(rawOptions);
  return withLaunchLock(options, () => stopRuntimeUnlocked(options, stopOptions));
}

async function stopRuntimeUnlocked(rawOptions = {}, { force = false, requireIdle = false } = {}) {
  const options = normalizeOptions(rawOptions);
  const paths = runtimePaths(options.workspaceRoot, options.port);
  const state = await readState(options);
  if (!isManagedStateForOptions(state, options)) return { stopped: false, reason: "未找到当前 Runtime 的受管状态" };

  let graceful = false;
  const internal = await readInternalStatus(options.apiUrl, state.controlToken);
  const ownsRuntime = internal?.runtimeId === state.runtimeId;
  const locallyStartedRuntime = locallyStartedRuntimes.get(state.pid);
  const startedByThisLauncher = locallyStartedRuntime?.pid === state.pid
    && locallyStartedRuntime.exitCode === null
    && locallyStartedRuntime.signalCode === null;
  if (!ownsRuntime && !startedByThisLauncher) {
    if (!isProcessAlive(state.pid)) {
      await rm(paths.state, { force: true });
      return { stopped: true, graceful: false, reason: "已清理没有存活进程的陈旧 Runtime 状态。" };
    }
    return {
      stopped: false,
      graceful: false,
      reason: "Runtime 未能通过控制令牌确认归属，未终止任何进程，也保留状态文件供人工诊断。"
    };
  }
  if (ownsRuntime) {
    if (requireIdle) {
      // 异步 Job 不占用 MCP 调用锁。切换前单独确认队列清空，不能为更新强杀在途生成或渲染。
      const projectsResponse = await fetchWithTimeout(`${options.apiUrl}/api/projects`);
      if (!projectsResponse.ok) throw new Error("无法核对异步队列，未切换 Runtime");
      for (const project of await projectsResponse.json()) {
        const jobsResponse = await fetchWithTimeout(`${options.apiUrl}/api/projects/${encodeURIComponent(project.id)}/jobs`);
        if (!jobsResponse.ok) throw new Error("无法核对项目 Job，未切换 Runtime");
        const jobs = await jobsResponse.json();
        if (jobs.some((job) => ["queued", "running", "unknown"].includes(job.status))) {
          return { stopped: false, reason: "仍有排队、运行中或结果未知的 Job；待其完成或对账后再部署，未强制中断。" };
        }
      }
    }
    try {
      const response = await fetchWithTimeout(`${options.apiUrl}/internal/runtime/shutdown`, {
        method: "POST",
        headers: { "x-videoflowcut-runtime-token": state.controlToken }
      });
      graceful = response.ok;
    } catch {
      // 服务可能已在退出，随后按记录 PID 检查即可。
    }
  }
  const stopped = await waitForExit(state.pid, STOP_TIMEOUT_MS);
  if (!stopped && ownsRuntime) {
    // 已通过控制令牌认证，才允许按 PID 终止整个 Runtime 进程树。
    terminateProcessTree(state.pid);
  } else if (!stopped && startedByThisLauncher) {
    // 启动尚未完成时没有可认证的 HTTP 状态；只通过仍存活的 ChildProcess 句柄停止它，
    // 不对磁盘状态中的 PID 直接执行 taskkill，避免 PID 复用误杀。
    locallyStartedRuntime.kill();
  }
  await waitForExit(state.pid, 2_000);
  const isStopped = !isProcessAlive(state.pid);
  if (isStopped) {
    locallyStartedRuntimes.delete(state.pid);
    await rm(paths.state, { force: true });
    return { stopped: true, graceful };
  }
  return {
    stopped: false,
    graceful,
    reason: force
      ? "已确认 Runtime 归属但强制停止失败；已保留状态文件供人工诊断。"
      : "已确认 Runtime 归属但未能停止；已保留状态文件供人工诊断。"
  };
}

async function main() {
  const [command = "ensure", ...args] = process.argv.slice(2);
  const pluginRoot = pluginRootFromModule(import.meta.url);
  const repoRoot = readOption(args, "--repo-root") ?? process.env.VIDEOFLOWCUT_REPO_ROOT;
  const workspaceRoot = readOption(args, "--workspace") ?? process.env.VIDEOCUT_WORKSPACE;
  const port = readOption(args, "--port") ?? process.env.VIDEOFLOWCUT_PORT;
  const options = { pluginRoot, repoRoot, workspaceRoot, port };
  if (command === "ensure" || command === "start" || command === "open") {
    const runtime = await ensureRuntime(options);
    console.log(JSON.stringify(command === "open" ? { ...runtime, url: runtime.webUrl } : runtime, null, 2));
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(await getRuntimeStatus(options), null, 2));
    return;
  }
  if (command === "stop") {
    console.log(JSON.stringify(await stopRuntime(options, { force: true }), null, 2));
    return;
  }
  throw new Error("用法：runtime-launcher.mjs <ensure|start|open|status|stop> [--repo-root 路径] [--workspace 路径] [--port 端口]");
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
