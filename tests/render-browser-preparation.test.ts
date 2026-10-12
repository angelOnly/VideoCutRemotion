import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveRenderBrowser } from "../apps/render-worker/src/exporter.js";

const { prepareRenderBrowser } = await import(pathToFileURL(resolve("plugins/videoflowcut/scripts/prepare-render-browser.mjs")).href);

async function withFakeDependency(source: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "videoflowcut-browser-test-"));
  try {
    const dependency = join(root, "node_modules", "@remotion", "renderer");
    await mkdir(dependency, { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(dependency, "index.js"), source);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("浏览器准备使用宿主依赖根，真实启动关闭后才返回绝对路径", async () => {
  await withFakeDependency(`
    const fs = require('node:fs'); const path = require('node:path');
    exports.ensureBrowser = async () => ({path: path.join(process.cwd(), 'package.json')});
    exports.openBrowser = async (_type, options) => {
      if (options.browserExecutable !== path.join(process.cwd(), 'package.json')) throw Error('路径漂移');
      return {close: async () => fs.writeFileSync('closed.txt', '已验证')};
    };
  `, async (repoRoot) => {
    assert.equal(await prepareRenderBrowser({ repoRoot }), join(repoRoot, "package.json"));
    assert.equal(await readFile(join(repoRoot, "closed.txt"), "utf8"), "已验证");
  });
});

test("下载或启动无进展时有总截止时间，准备进程退出而非遗留后台下载", async () => {
  await withFakeDependency(`exports.ensureBrowser = () => new Promise(() => setInterval(() => {}, 1000));`, async (repoRoot) => {
    await assert.rejects(prepareRenderBrowser({ repoRoot, timeoutMs: 200 }), /超过.*未切换旧 Runtime/u);
  });
});

test("浏览器存在但不能启动时准备失败，不能宣告部署就绪", async () => {
  await withFakeDependency(`
    exports.ensureBrowser = async () => ({path: require('node:path').join(process.cwd(), 'package.json')});
    exports.openBrowser = async () => { throw Error('浏览器无法启动'); };
  `, async (repoRoot) => {
    await assert.rejects(prepareRenderBrowser({ repoRoot }), /浏览器无法启动/u);
  });
});

test("发行 Runtime 未准备或路径失效时直接失败，不进入业务 Job 自动下载", async () => {
  const previousDist = process.env.VIDEOFLOWCUT_RUNTIME_DIST;
  const previousBrowser = process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE;
  try {
    process.env.VIDEOFLOWCUT_RUNTIME_DIST = resolve("plugins/videoflowcut/runtime/dist");
    delete process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE;
    await assert.rejects(resolveRenderBrowser(), /缺少部署前准备/u);
    process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE = "relative/chrome.exe";
    await assert.rejects(resolveRenderBrowser(), /路径无效/u);
    process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE = join(tmpdir(), "videoflowcut-browser-does-not-exist.exe");
    await assert.rejects(resolveRenderBrowser(), /路径无效/u);
  } finally {
    if (previousDist === undefined) delete process.env.VIDEOFLOWCUT_RUNTIME_DIST;
    else process.env.VIDEOFLOWCUT_RUNTIME_DIST = previousDist;
    if (previousBrowser === undefined) delete process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE;
    else process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE = previousBrowser;
  }
});
