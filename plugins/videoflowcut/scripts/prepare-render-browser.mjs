import "./background-processes.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stat } from "node:fs/promises";

/** 下载只发生在切换前的受控子进程，超时不会留下占用生产 Job 的下载任务。 */
export function prepareRenderBrowser({ repoRoot, timeoutMs = 120_000 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("浏览器准备时限必须为正数");
  return new Promise((resolvePrepared, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", resolve(repoRoot)], {
      cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let errors = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-16_384); });
    child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-4_096); });
    const timer = setTimeout(() => {
      timedOut = true;
      // PID 来自本次亲自创建的 ChildProcess，不从磁盘猜测进程归属。
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", async (code) => {
      clearTimeout(timer);
      try {
        if (timedOut) throw new Error(`渲染浏览器准备超过 ${timeoutMs}ms，已终止本次准备；未切换旧 Runtime`);
        if (code !== 0) throw new Error(`渲染浏览器准备失败：${errors || code}`);
        const result = JSON.parse(output.trim());
        if (!isAbsolute(result.browserExecutable) || !(await stat(result.browserExecutable)).isFile()) {
          throw new Error("浏览器准备未返回有效的绝对路径");
        }
        resolvePrepared(result.browserExecutable);
      } catch (error) { reject(error); }
    });
  });
}

async function prepareInDependencyRoot(repoRoot) {
  // 使用与发行 Runtime 相同的宿主依赖，缓存位置不随 Codex 插件版本目录变化。
  const requireFromRepo = createRequire(join(repoRoot, "package.json"));
  const { ensureBrowser, openBrowser } = requireFromRepo("@remotion/renderer");
  const browser = await ensureBrowser({ logLevel: "error" });
  if (!browser.path) throw new Error("Remotion 未准备好受支持的浏览器");
  const instance = await openBrowser("chrome", { browserExecutable: browser.path, logLevel: "error" });
  await instance.close({ silent: true });
  process.stdout.write(JSON.stringify({ browserExecutable: browser.path }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === "--worker") {
  prepareInDependencyRoot(resolve(process.argv[3])).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
