import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { createProjectSnapshot } from "@videocut/domain";
import { ThreadedRevisionRenderer } from "../apps/render-worker/src/threaded-renderer.js";

const run = promisify(execFile);
const policy = new URL("../plugins/videoflowcut/scripts/background-processes.mjs", import.meta.url).href;

test("候选发行线程能静默渲染视频，不访问项目数据库", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videoflowcut-silent-render-"));
  const dist = resolve("plugins/videoflowcut/runtime/dist");
  // 使用纯内存测试输入，直接调用候选发行线程，不创建正式 Project 或 Job。
  const snapshot = createProjectSnapshot({ projectId: "silent-render-fixture", name: "静默启动验证", rootPath: root });
  Object.assign(snapshot.timeline, { width: 320, height: 180, durationInFrames: 12 });
  const renderer = new ThreadedRevisionRenderer(() => new Worker(`
    const cp = require('node:child_process');
    const original = cp.spawn;
    cp.spawn = function(command, args, options) {
      if (process.platform === 'win32' && options?.windowsHide !== true) {
        throw new Error('渲染子进程未隐藏窗口：' + command);
      }
      return original.call(this, command, args, options);
    };
    // 仅此隔离测试允许浏览器自动发现；正式 Runtime 仍执行部署前准备检查。
    const {ensureBrowser} = require('@remotion/renderer');
    ensureBrowser({logLevel:'error'}).then(browser => {
      process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE = browser.path;
      require(${JSON.stringify(join(dist, "render-thread.cjs"))});
    }).catch(error => { throw error; });
  `, { eval: true, env: { ...process.env, VIDEOFLOWCUT_RUNTIME_DIST: dist,
    VIDEOFLOWCUT_NODE_MODULES: resolve("node_modules") } }));
  try {
    await renderer.prepare();
    const output = join(root, "silent.mp4");
    await renderer.render(snapshot, output);
    const result = await run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", output], { windowsHide: true });
    const metadata = JSON.parse(result.stdout);
    assert.ok(metadata.streams.some((stream: { width: number; height: number }) => stream.width === 320 && stream.height === 180));
  } finally {
    await renderer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("后台策略覆盖两种启动签名，保留参数且同步 ESM 导出", async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    const calls = [];
    for (const name of ['spawn', 'spawnSync']) {
      cp[name] = (...args) => { calls.push({name, args}); return 'child'; };
    }
    await import(${JSON.stringify(policy)});
    const esm = await import('node:child_process');
    const options = {cwd: process.cwd(), stdio: 'pipe', windowsHide: false};
    for (const name of ['spawn', 'spawnSync']) {
      assert.equal(cp[name]('tool', ['--version'], options), 'child');
      cp[name]('tool', options);
      cp[name]('tool', undefined, options);
      if (process.platform === 'win32') assert.equal(esm[name], cp[name]);
    }
    assert.equal(options.windowsHide, false);
    for (const call of calls) {
      const options = call.args[2] ?? call.args[1];
      assert.equal(options.cwd, process.cwd());
      assert.equal(options.stdio, 'pipe');
      assert.equal(options.windowsHide, process.platform === 'win32');
    }
    console.log('ok');
  `], { windowsHide: true });
  assert.match(stdout, /ok/u);
});

test("静默进程保留标准输出、错误、退出码与取消能力", async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    await import(${JSON.stringify(policy)});
    const {spawn, spawnSync} = await import('node:child_process');
    const {once} = await import('node:events');
    const result = spawnSync(process.execPath, ['-e', "console.log('输出'); console.error('错误'); process.exitCode=7"], {encoding:'utf8'});
    assert.equal(result.status, 7);
    assert.match(result.stdout, /输出/);
    assert.match(result.stderr, /错误/);
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const closed = once(child, 'close');
    assert.equal(child.kill(), true);
    await closed;
    const missing = spawn('videoflowcut-command-that-does-not-exist');
    const [error] = await once(missing, 'error');
    assert.equal(error.code, 'ENOENT');
    console.log('ok');
  `], { windowsHide: true, timeout: 15_000 });
  assert.match(stdout, /ok/u);
});

test("真实 Remotion 合成与 FFprobe 启动使用静默策略", { timeout: 60_000 }, async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import {createRequire} from 'node:module';
    import {dirname, join} from 'node:path';
    import {once} from 'node:events';
    const calls = [];
    const original = cp.spawn;
    cp.spawn = function(command, args, options) {
      calls.push({command, options});
      return original.call(this, command, args, options);
    };
    await import(${JSON.stringify(policy)});
    const require = createRequire(join(process.cwd(), 'package.json'));
    const root = dirname(require.resolve('@remotion/renderer'));
    const {startLongRunningCompositor} = require(join(root, 'compositor/compositor.js'));
    const {callFfNative} = require(join(root, 'call-ffmpeg.js'));
    const compositor = startLongRunningCompositor({maximumFrameCacheItemsInBytes: 1024*1024, logLevel:'error', indent:false, binariesDirectory:null, extraThreads:1});
    try {
      const child = callFfNative({args:['-version'], bin:'ffprobe', logLevel:'error', indent:false, binariesDirectory:null});
      let output = '';
      child.stdout.on('data', chunk => {output += chunk;});
      const [code] = await once(child, 'close');
      assert.equal(code, 0);
      assert.match(output, /ffprobe version/);
    } finally { await compositor.shutDownOrKill(); }
    assert.ok(calls.some(call => /remotion/i.test(call.command)));
    assert.ok(calls.some(call => /ffprobe/i.test(call.command)));
    if (process.platform === 'win32') assert.ok(calls.every(call => call.options.windowsHide === true));
    console.log(JSON.stringify({verified: calls.map(call => call.command)}));
  `], { windowsHide: true, timeout: 50_000 });
  assert.match(stdout, /verified/u);
});
