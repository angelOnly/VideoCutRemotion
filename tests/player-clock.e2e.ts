import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";
import { runProcess } from "@videocut/speech";

// 真正播放有声音的 25fps 视频；每帧上报触发父组件重绘，复现工作台同一调用链。
const root = await mkdtemp(join(tmpdir(), "videocut-player-clock-"));
const mediaPath = join(root, "clock.mp4");
await runProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=20", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", mediaPath]);
const media = await readFile(mediaPath);
const vite = await createServer({ configFile: false, root: resolve('.'), server: { host: "127.0.0.1", port: 0 },
  esbuild: { jsx: "automatic" }, plugins: [{ name: "isolated-clock-media", configureServer(server) {
    server.middlewares.use('/clock.mp4', (req, res) => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
      res.writeHead(range ? 206 : 200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(range ? { 'content-range': `bytes ${start}-${end}/${media.length}` } : {}) });
      res.end(media.subarray(start, end + 1));
    });
  } }] });
await vite.listen();
const address = vite.httpServer!.address();
assert.ok(address && typeof address !== 'string');
const { prepareRenderBrowser } = await import(pathToFileURL(resolve('plugins/videoflowcut/scripts/prepare-render-browser.mjs')).href);
const browser = await puppeteer.launch({ executablePath: await prepareRenderBrowser({ repoRoot: process.cwd() }), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const reports: any[] = [];
try {
  for (const legacy of [true, false]) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/player-clock.html${legacy ? '?legacy=1' : ''}`);
    await page.waitForSelector('video');
    await page.waitForFunction(() => document.querySelector('video')!.readyState >= 3);
    await page.click('#play');
    const samples: Array<{ wall: number; frame: number; source: number }> = [];
    for (let i = 0; i < 120; i++) {
      samples.push(await page.evaluate(() => ({ wall: performance.now(), frame: Number(document.querySelector('#frame')!.textContent), source: document.querySelector('video')!.currentTime })));
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    await page.click('#pause');
    const rewinds = samples.flatMap((sample, index) => index > 0 && sample.source < samples[index - 1]!.source - 0.08 ? [{ before: samples[index - 1], after: sample }] : []);
    const duration = (samples.at(-1)!.wall - samples[0]!.wall) / 1000;
    const timelineDuration = (samples.at(-1)!.frame - samples[0]!.frame) / 24;
    const report = { legacy, duration, timelineDuration, drift: duration - timelineDuration, rewinds, samples };
    reports.push(report);
    console.log(JSON.stringify({ legacy, duration, timelineDuration, drift: report.drift, rewinds: rewinds.length }));
    if (!legacy) {
      assert.equal(rewinds.length, 0, '正常连续播放不得周期性回播人声');
      assert.ok(Math.abs(report.drift) < 0.25, '播放器不能因父组件逐帧重绘而丢失累计时钟');
      await page.click('#seek');
      await page.waitForFunction(() => Math.abs(document.querySelector('video')!.currentTime - 4) < 0.1);
      await page.click('#revision');
      await page.waitForSelector('[data-project="changed"]');
      await page.click('#play');
      await new Promise(resolveWait => setTimeout(resolveWait, 1000));
      assert.ok(await page.evaluate(() => document.querySelector('video')!.currentTime > 4.5), '定位和更换真实快照后仍可继续播放');
    }
    await page.close();
  }
  assert.ok(reports[0].rewinds.length > 0, '旧实现必须真实复现回跳，不能只验证新实现能播放');
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ root }));
  await browser.close();
  await vite.close();
}
