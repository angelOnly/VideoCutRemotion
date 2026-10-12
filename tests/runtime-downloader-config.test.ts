import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const pluginRoot = resolve(repoRoot, "plugins/videoflowcut");
const launcher = await import(pathToFileURL(resolve(pluginRoot, "scripts/runtime-launcher.mjs")).href);
const { resolveReleaseRuntime } = await import(pathToFileURL(resolve(pluginRoot, "scripts/repo-root.mjs")).href);

test("Runtime 不复用缺少当前下载器配置的旧进程", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vfc-downloader-config-"));
  const port = 3539;
  const stateDir = join(workspaceRoot, ".videoflowcut-runtime");
  const stateFile = join(stateDir, `runtime-${port}.json`);
  const previous = process.env.VIDEOCUT_YT_DLP_PATH;
  try {
    await mkdir(stateDir, { recursive: true });
    const release = resolveReleaseRuntime(pluginRoot);
    const state = {
      schemaVersion: 3, runtimeId: "previous-runtime", controlToken: "test-token",
      repoRoot, workspaceRoot, port, apiUrl: `http://127.0.0.1:${port}`,
      runtimeEntry: release.runtimeEntry, distributionRoot: release.root, releaseId: release.releaseId,
      startedAt: new Date().toISOString(), pid: process.pid
    };
    await writeFile(stateFile, JSON.stringify(state));
    process.env.VIDEOCUT_YT_DLP_PATH = resolve(workspaceRoot, "yt-dlp.exe");
    const options = { pluginRoot, repoRoot, workspaceRoot, port };
    const status = await launcher.getRuntimeStatus(options);
    assert.equal(status.ready, false);
    assert.match(status.reason, /旧发行 Runtime/);
    await assert.rejects(launcher.readActiveMcpDeployment(options), /下载器配置/);
    // Windows 上插件注册和交互式终端可能分别使用斜杠与反斜杠。
    const configuredPath = process.env.VIDEOCUT_YT_DLP_PATH!;
    await writeFile(stateFile, JSON.stringify({ ...state, youtubeDownloaderPath: configuredPath }));
    process.env.VIDEOCUT_YT_DLP_PATH = configuredPath.replaceAll("\\", "/");
    const equivalent = await launcher.getRuntimeStatus(options);
    assert.equal(equivalent.reason, undefined);
    delete process.env.VIDEOCUT_YT_DLP_PATH;
    await assert.rejects(launcher.ensureRuntime(options), /缺少 VIDEOCUT_YT_DLP_PATH/);
  } finally {
    if (previous === undefined) delete process.env.VIDEOCUT_YT_DLP_PATH;
    else process.env.VIDEOCUT_YT_DLP_PATH = previous;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
