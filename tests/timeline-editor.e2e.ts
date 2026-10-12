import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { createProjectSnapshot } from "@videocut/domain";

// 验证真实发行 Web + Player；快照只在浏览器请求拦截中提供，绝不写入任何项目或队列。
const evidenceRoot = resolve(".candidate/timeline-dev");
await mkdir(evidenceRoot, { recursive: true });
let frames = 2400;
function fixture() {
  const snapshot = createProjectSnapshot({ projectId: "timeline-ui-test", name: "时间线交互验证", rootPath: evidenceRoot });
  snapshot.timeline.durationInFrames = frames;
  snapshot.scenes = [{ id: "scene", type: "PresenterScene", title: "完整场景", purpose: "验证对齐", startFrame: 0, endFrame: frames, assetIds: [], narrativeBeatIds: [], status: "draft", stylePackId: "default-clean" }];
  const actor = snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll")!;
  snapshot.timeline.items = [{ id: "item", trackId: actor.id, assetId: "fixture-asset", startFrame: Math.floor(frames / 10), endFrame: Math.floor(frames * 0.9), sourceStartFrame: 0, sourceEndFrame: Math.floor(frames * 0.8), disabled: true }];
  snapshot.timeline.captions = frames ? Array.from({ length: frames > 2400 ? 1200 : 2 }, (_, index) => {
    const count = frames > 2400 ? 1200 : 2;
    return { id: `caption-${index}`, text: `预览第${index + 1}段`, startFrame: Math.floor(index / count * frames), endFrame: Math.floor((index + 1) / count * frames), style: "stable" as const, precision: "segment_exact" as const };
  }) : [];
  snapshot.markers = [{ id: "marker", frame: Math.floor(frames / 4), label: "定位标记", level: "warning" }];
  return { snapshot, revision: { id: "fixture-revision", number: 1 } };
}

const webRoot = resolve("apps/web/dist");
const staticServer = createServer(async (request, response) => {
  const pathname = new URL(request.url!, "http://localhost").pathname;
  const file = resolve(webRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(webRoot + sep)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch { response.writeHead(404).end(); }
});
const externalUrl = process.argv[2];
if (externalUrl) {
  const target = new URL(externalUrl);
  assert.equal(target.hostname, "127.0.0.1", "仅允许本地候选环境");
  assert.notEqual(target.port, "3100", "禁止连接正式 Runtime");
} else {
  await new Promise<void>((done) => staticServer.listen(0, "127.0.0.1", done));
}
const address = staticServer.address();
const baseUrl = externalUrl ?? `http://127.0.0.1:${address && typeof address !== "string" ? address.port : 0}`;
const { prepareRenderBrowser } = await import(pathToFileURL(resolve("plugins/videoflowcut/scripts/prepare-render-browser.mjs")).href);
const browser = await puppeteer.launch({ executablePath: await prepareRenderBrowser({ repoRoot: process.cwd() }), headless: true });
const page = await browser.newPage();
const errors: string[] = [];
const mutations: string[] = [];
const checks: string[] = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.setViewport({ width: 1600, height: 1000 });
await page.setRequestInterception(true);
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    if (request.method() !== "GET") { mutations.push(`${request.method()} ${url.pathname}`); void request.abort(); return; }
    if (url.pathname === "/api/events") { void request.respond({ status: 200, contentType: "text/event-stream", body: ": 测试快照\n\n" }); return; }
    const state = fixture();
    const result = url.pathname === "/api/projects" ? [{ id: state.snapshot.project.id, name: state.snapshot.project.name }]
      : url.pathname === "/api/projects/timeline-ui-test" ? state
      : url.pathname.endsWith("/quality") ? { issues: [], technical: [], editorial: { status: "not_recorded", passes: [], previewEvidence: [] } } : [];
    void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
    return;
  }
  void request.continue();
});

const blank = '[aria-label="轨道：Rear FX"]';
const actor = '[aria-label="轨道：Actor / A-roll"]';
const settle = () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const frame = () => page.$eval(".timeline-position", (element) => Number(element.textContent!.match(/F(\d+)/)![1]));
const box = (selector: string) => page.$eval(selector, (element) => { const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }; });
const viewportState = () => page.$eval(".timeline-scroll", (element) => ({ left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, scrollWidth: element.scrollWidth }));
async function clickAt(ratio: number, selector = blank) {
  const rect = await box(selector);
  await page.mouse.click(rect.x + rect.width * ratio, rect.y + rect.height / 2);
  await settle();
}
async function aligned() {
  const positions = await page.$$eval(".playhead", (elements) => elements.map((element) => element.getBoundingClientRect().left));
  assert.ok(Math.max(...positions) - Math.min(...positions) < 1, "场景、刻度、轨道上的指针必须保持对齐");
}
async function load() {
  await page.goto(`${baseUrl}/?projectId=timeline-ui-test`);
  await page.waitForSelector(".track-canvas");
  await settle();
}

try {
  await load();
  await clickAt(0.6);
  assert.ok(Math.abs(await frame() - 1440) <= 1, "空白轨道点击应定位到横坐标");
  await page.waitForFunction(() => document.querySelector('[data-caption-layout]')?.textContent?.includes("预览第2段"));
  checks.push("轨道点击定位并更新真实 Player 字幕");

  const head = await box(`${actor} .playhead`);
  const target = await box(blank);
  await page.mouse.move(head.x + head.width / 2 + 4, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 0.8 + 4, target.y + target.height / 2, { steps: 8 });
  await settle();
  assert.ok(Math.abs(await frame() - 1920) <= 2, "按住拖动期间也应实时更新，不能等松手才定位");
  await page.mouse.up();
  await settle();
  assert.ok(Math.abs(await frame() - 1920) <= 2, "从片段覆盖处抓住红线，跨轨道拖动时保持抓取偏移");
  assert.equal(await page.$eval('[data-testid="inspector"]', (element) => element.getAttribute("data-selected-kind")), "none");
  await page.mouse.move(target.x + target.width * 0.4, target.y + target.height / 2);
  await settle();
  assert.ok(Math.abs(await frame() - 1920) <= 2, "松手后移动鼠标不能继续定位");
  checks.push("红线跨轨道拖动，片段不误选，松手后停止");

  await clickAt(0.3, actor);
  assert.equal(await frame(), 240, "片段仍按原行为选中并跳到起点");
  assert.equal(await page.$eval('[data-testid="inspector"]', (element) => element.getAttribute("data-selected-id")), "item");
  await page.click('[data-testid="marker-marker"]');
  assert.equal(await frame(), 600);
  await page.click('[data-testid="scene-strip-scene"]');
  assert.equal(await frame(), 0);
  await clickAt(0.7);
  await page.click('[data-testid="timeline-caption-caption-0"]');
  assert.equal(await frame(), 0);
  checks.push("片段、场景、字幕、标记原有点击行为保持正常");

  await clickAt(0.4);
  const before = await box(`${blank} .playhead`);
  await page.click('[aria-label="放大时间线"]');
  await settle();
  const after = await box(`${blank} .playhead`);
  assert.ok(Math.abs(before.x - after.x) < 1, "缩放应保留可见播放指针位置");
  assert.ok((await viewportState()).left > 0);
  await aligned();
  const names = await box('[data-testid^="track-"] .track-name');
  const view = await box(".timeline-scroll");
  assert.ok(Math.abs(names.x - view.x) < 1, "横向滚动时轨道名称应固定");
  await page.$eval(".timeline-scroll", (element) => { element.scrollLeft = 500; });
  await settle();
  const canvas = await box(blank);
  const x = view.x + 120 + 300;
  await page.mouse.click(x, canvas.y + canvas.height / 2);
  await settle();
  const expected = Math.round((x - canvas.x) / canvas.width * frames);
  assert.ok(Math.abs(await frame() - expected) <= 1, "横向滚动后的坐标换算应准确");
  await aligned();
  checks.push("缩放保留锚点，固定轨道名称，滚动后仍准确定位");

  const edgeX = view.x + (await viewportState()).width - 3;
  await page.mouse.move(edgeX, canvas.y + canvas.height / 2);
  await page.mouse.down();
  const initialScroll = (await viewportState()).left;
  await page.waitForFunction((value) => document.querySelector(".timeline-scroll")!.scrollLeft > value + 60, {}, initialScroll);
  await page.mouse.up();
  assert.ok((await viewportState()).left > initialScroll + 60);
  checks.push("按住视口边缘自动横向滚动");

  await page.click('[aria-label="缩小时间线"]');
  await settle();
  assert.equal((await viewportState()).left, 0);
  const normal = await box(blank);
  await page.mouse.move(normal.x + normal.width / 2, normal.y + normal.height / 2);
  await page.mouse.down();
  await page.mouse.move(view.x + 10, normal.y + normal.height / 2);
  await page.mouse.up();
  assert.equal(await frame(), 0, "拖出时间画布左边应停在首帧");
  await page.mouse.move(normal.x + normal.width / 2, normal.y + normal.height / 2);
  await page.mouse.down();
  await page.mouse.move(1599, 450);
  await page.mouse.up();
  assert.equal(await frame(), 2399, "跨出轨道区域后松手仍应定位末帧并结束");
  assert.equal(await page.$(".is-scrubbing"), null);
  checks.push("首尾边界和拖出轨道后松手");

  await page.mouse.move(normal.x + normal.width / 2, normal.y + normal.height / 2);
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  assert.equal(await page.$(".is-scrubbing"), null);
  await page.focus(".timeline-scroll");
  await page.keyboard.press("End");
  assert.equal(await frame(), 2399);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await frame(), 2398);
  checks.push("窗口失焦结束拖动，键盘逐帧定位");

  await clickAt(0.2);
  await page.click(".preview-controls button:nth-child(2)");
  await page.waitForFunction(() => Number(document.querySelector(".timeline-position")!.textContent!.match(/F(\d+)/)![1]) > 485);
  await clickAt(0.3);
  const pausedFrame = await frame();
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(await frame(), pausedFrame, "播放中开始拖动应暂停，避免播放时钟抢走指针");
  await page.$eval(".timeline-scroll", (element) => { element.scrollTop = element.scrollHeight; });
  await settle();
  const heading = await box(".timeline-heading");
  const scrollBox = await box(".timeline-scroll");
  assert.ok(Math.abs(heading.y - scrollBox.y) < 1, "上下浏览轨道时标尺与场景条保持可见");
  await clickAt(0.65, '[aria-label="轨道：BGM"]');
  assert.ok(Math.abs(await frame() - 1560) <= 1, "下方音轨也应能定位");
  await aligned();
  checks.push("播放中拖动自动暂停，下方音轨定位和固定顶部标尺");

  frames = 24 * 3600;
  await load();
  await clickAt(0.5);
  for (let index = 0; index < 7; index++) await page.click('[aria-label="放大时间线"]');
  await settle();
  assert.ok(await page.$$eval(".ruler > span", (elements) => elements.length < 40), "长片仅生成当前视野的刻度");
  await aligned();
  await page.setViewport({ width: 1400, height: 900 });
  await settle();
  await aligned();
  await page.screenshot({ path: resolve(evidenceRoot, "timeline-zoom.png") });
  await page.$eval('[aria-label="时间线缩放"]', (element) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, Number(input.max) / 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  assert.notEqual(await page.$eval(".timeline-zoom-value", (element) => element.textContent), "128.0×", "滑杆应更新缩放比例");
  await page.click(".timeline-tools button:last-child");
  await settle();
  assert.equal((await viewportState()).left, 0);
  assert.ok((await viewportState()).scrollWidth <= (await viewportState()).width + 1);
  await page.screenshot({ path: resolve(evidenceRoot, "timeline-fit.png") });
  checks.push("一小时、1200 张字幕的缩放、窗口变化、适合窗口");

  frames = 0;
  await load();
  await clickAt(0.6);
  assert.equal(await frame(), 0);
  assert.deepEqual(errors, [], "浏览器不得发生运行错误");
  assert.deepEqual(mutations, [], "所有时间线浏览操作不得写入项目或创建 Revision");
  checks.push("空时间线边界，全部交互无项目写入");
  console.log(JSON.stringify({ checks, evidenceRoot, baseUrl }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(evidenceRoot, "timeline-failure.png") });
  console.error({ checks, errors, mutations });
  throw error;
} finally {
  await writeFile(resolve(evidenceRoot, "timeline-report.json"), JSON.stringify({ checks, errors, mutations, baseUrl }, null, 2));
  await browser.close();
  if (staticServer.listening) await new Promise<void>((done, reject) => staticServer.close((error) => error ? reject(error) : done()));
}
