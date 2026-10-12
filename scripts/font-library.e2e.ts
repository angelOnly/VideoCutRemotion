import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "puppeteer-core";
import { resolveRenderBrowser } from "../packages/remotion-runtime/src/browser.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { motionFixture } from "../tests/fixtures/managed-motion.js";

// 真实接口与浏览器验证只创建独立候选数据；模拟选择是技术夹具，不冒称用户批准。
const require = createRequire(import.meta.url);
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
const { findAvailablePort } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const repoRoot = resolve(import.meta.dirname, ".."), pluginRoot = join(repoRoot, "plugins/videoflowcut");
await mkdir(join(repoRoot, ".repair-validation"), { recursive: true });
const root = await mkdtemp(join(repoRoot, ".repair-validation/font-library-")), port = await findAvailablePort();
const origin = `http://127.0.0.1:${port}`;
const runtimeArgs = ["--repo-root", repoRoot, "--workspace", root, "--port", String(port), "--comfyui-bridge-url", "http://127.0.0.1:18199"];
const runtime = await runCandidateRuntime("ensure", runtimeArgs);
const spec = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.videoflowcut;
const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: pluginRoot, stderr: "pipe",
  env: { ...getDefaultEnvironment(), ...spec.env, VIDEOCUT_WORKSPACE: root, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: "http://127.0.0.1:18199" } });
const client = new Client({ name: "字体工作台候选验证", version: "1" });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
async function call(name: string, args: Record<string, unknown> = {}, error = false): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError === true, error, JSON.stringify(result.content));
  const content = (result.content as { type: string; text?: string }[]).find(entry => entry.type === "text")!.text!;
  try { return JSON.parse(content); } catch { return { error: content }; }
}
const get = async (path: string) => { const response = await fetch(origin + path); assert.equal(response.ok, true); return response.json(); };
console.log(JSON.stringify({ 阶段: "字体库候选服务就绪", root, port, releaseId: runtime.releaseId }));
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const editorTool = tools.find(tool => tool.name === "get_editor_url")!;
  assert.equal(editorTool.annotations?.readOnlyHint, true);
  assert.ok(editorTool.inputSchema.properties!.font_preview);
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true); assert.equal(release.mcpReleaseId, runtime.releaseId);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  const capabilities = await call("read_motion_capabilities");
  assert.equal(capabilities.fonts.length, 34);
  const downloaded = [];
  for (const face of capabilities.fonts) {
    const response = await fetch(`${origin}/api/motion/fonts/${face.id}/file?sha256=${face.sha256}`);
    assert.equal(response.status, 200);
    assert.equal(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"), face.sha256);
    downloaded.push(face.id);
  }
  const stale = await fetch(`${origin}/api/motion/fonts/aa-jianhao/file?sha256=${"0".repeat(64)}`);
  assert.equal(stale.status, 409);
  const created = await call("create_project", { name: "字体工作台独立候选夹具", profile: "visual_explainer" });
  const projectId = created.snapshot.project.id;
  const other = await call("create_project", { name: "字体推荐跨项目隔离夹具", profile: "visual_explainer" });
  const before = await call("read_project", { project_id: projectId });
  const work = { ...motionFixture, reference: undefined, width: 640, height: 192, durationInFrames: 2,
    fontBindings: { title: "not-registered" },
    source: `import React from 'react';export default p=><div style={{color:'white',fontSize:48,fontFamily:p.fonts.title.family,fontWeight:p.fonts.title.weight,fontStyle:p.fonts.title.style,fontSynthesis:'none'}}>把生活拍成电影</div>` };
  const unknown = await call("submit_motion_work", { project_id: projectId, base_revision_id: before.revision.number, idempotency_key: "font-selection", work }, true);
  assert.deepEqual([unknown.code, unknown.stage, unknown.sideEffects, unknown.safeToRetry, unknown.recovery, unknown.selectionRequired],
    ["MOTION_FONT_UNKNOWN", "validation", "none", true, "select_registered_font", true]);
  assert.equal((await get(`/api/projects/${projectId}/jobs`)).length, 0);
  assert.deepEqual(await call("read_project", { project_id: projectId }), before);
  const preview = { text: "把生活拍成电影", expected_font: "候选夹具中的未收录字款", purpose: "技术验证标题",
    candidates: [{ font_id: "aa-houdi-hei", reason: "验证粗体原件" }, { font_id: "canger-shuyuan-w01", reason: "验证细体原件" }, { font_id: "wd-xl-huayou-sc", reason: "验证OTF地区版本" }] };
  const editor = await call("get_editor_url", { project_id: projectId, panel: "fonts", font_preview: preview });
  assert.equal(new URL(editor.editorUrl).searchParams.get("panel"), "fonts");
  assert.deepEqual(JSON.parse(new URL(editor.editorUrl).searchParams.get("fontPreview")!), preview);
  const invalid = await call("get_editor_url", { project_id: projectId, panel: "fonts", font_preview: { ...preview, candidates: [{ font_id: "unknown", reason: "未登记" }] } }, true);
  assert.match(invalid.error, /MOTION_FONT_UNKNOWN/u);
  browser = await puppeteer.launch({ executablePath: await resolveRenderBrowser(), headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1100 });
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(String(error)));
  let maxConcurrent = 0;
  const pending = new Set<object>();
  page.on("request", request => { if (request.url().includes("/api/motion/fonts/")) { pending.add(request); maxConcurrent = Math.max(maxConcurrent, pending.size); } });
  page.on("requestfinished", request => pending.delete(request)); page.on("requestfailed", request => pending.delete(request));
  // 工作台有持续SSE订阅，网络永不完全空闲；以真实面板和字形就绪判断加载。
  await page.goto(editor.editorUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="font-library"]');
  await page.waitForFunction(() => document.querySelectorAll(".font-card").length === 3, { timeout: 30000 });
  assert.equal(await page.$$eval(".font-card", cards => cards.length), 3);
  for (const candidate of preview.candidates) {
    await page.$eval(`[data-testid="font-card-${candidate.font_id}"]`, element => element.scrollIntoView({ block: "center" }));
    await page.waitForFunction(id => document.querySelector(`[data-font-id="${id}"]`)?.getAttribute("data-font-status") === "loaded", { timeout: 30000 }, candidate.font_id);
  }
  const glyphs = await page.$$eval('.font-sample[data-font-status="loaded"]', elements => elements.map(element => ({ id: element.getAttribute("data-font-id"), family: getComputedStyle(element.firstElementChild!).fontFamily, text: element.textContent })));
  assert.equal(glyphs.length, 3); assert.ok(glyphs.every(row => row.family.startsWith("VFC_PREVIEW_") && row.text === preview.text));
  for (const name of ["Aa厚底黑", "仓耳舒圆体W01", "WD-XL_滑油字_SC"]) await page.click(`input[aria-label="对比${name}"]`);
  await page.click(".font-library-actions button:last-child");
  await page.waitForSelector("dialog[open]");
  await page.waitForFunction(() => document.querySelectorAll('dialog .font-sample[data-font-status="loaded"]').length === 3);
  const screenshot = join(root, "字体放大对比.png");
  await page.screenshot({ path: screenshot });
  await page.click(".font-comparison-heading button");
  await page.click('[data-testid="font-card-aa-houdi-hei"] .font-card-actions button');
  await page.waitForFunction(() => (document.querySelector('[aria-label="字体选择文字"]') as HTMLTextAreaElement | null)?.value.includes("aa-houdi-hei"));
  // 字样、复制、对比均未采用到视频，仍为同一Revision且没有生成任务。
  assert.deepEqual(await call("read_project", { project_id: projectId }), before);
  assert.equal((await get(`/api/projects/${projectId}/jobs`)).length, 0);
  let blockFont = true;
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (request.isInterceptResolutionHandled()) return;
    if (blockFont && request.url().includes("/api/motion/fonts/canger-yumo-w01/file")) void request.abort("failed");
    else void request.continue();
  });
  await page.click(".font-only-recommended input");
  await page.type('[aria-label="搜索字体"]', "仓耳");
  await page.waitForFunction(() => document.querySelectorAll(".font-card").length === 10);
  // 此字体尚未加载：用真实浏览器网络失败验证单卡片失败与无回退字样。
  await page.$eval('[data-testid="font-card-canger-yumo-w01"]', element => element.scrollIntoView({ block: "center" }));
  await page.waitForFunction(() => document.querySelector('[data-font-id="canger-yumo-w01"]')?.getAttribute("data-font-status") === "failed", { timeout: 30000 });
  assert.equal(await page.$eval('[data-testid="font-card-canger-yumo-w01"] .font-card-actions button', button => (button as HTMLButtonElement).disabled), true);
  assert.equal(await page.$eval('[data-font-id="canger-yumo-w01"]', element => Boolean(element.querySelector(".font-error"))), true);
  blockFont = false;
  assert.ok(maxConcurrent <= 2, `字体加载并发超限：${maxConcurrent}`);
  await page.click('[data-testid="panel-assets"]');
  await page.waitForFunction(() => [...document.fonts].filter(face => face.family.startsWith("VFC_PREVIEW_")).length === 0);
  const compactUrl = new URL(editor.editorUrl); compactUrl.searchParams.delete("fontPreview");
  await page.goto(compactUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".font-card").length === 34 && document.querySelector('.font-card .font-sample')?.getAttribute("data-font-status") === "loaded");
  const compact = await page.$eval(".font-card .font-sample", element => ({ text: element.textContent, size: getComputedStyle(element.firstElementChild!).fontSize, height: element.getBoundingClientRect().height }));
  assert.equal(compact.text, "字体 Aa"); assert.equal(compact.size, "18px"); assert.ok(compact.height <= 60);
  const cardLayout = await page.$$eval(".font-card", cards => cards.slice(0, 3).map(card => { const box = card.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, overflow: card.scrollWidth > card.clientWidth }; }));
  assert.equal(cardLayout[0]!.y, cardLayout[1]!.y, "每行两张字体卡片");
  assert.ok(cardLayout[1]!.x > cardLayout[0]!.x && cardLayout[2]!.y > cardLayout[0]!.y);
  assert.ok(cardLayout.every(card => !card.overflow), "按钮和字样不能撑破卡片");
  const compactScreenshot = join(root, "字体列表紧凑预览.png"); await page.screenshot({ path: compactScreenshot });
  await page.click('[data-testid="panel-assets"]');
  await page.select(".topbar select", other.snapshot.project.id);
  await page.waitForFunction(id => new URL(location.href).searchParams.get("projectId") === id, {}, other.snapshot.project.id);
  assert.equal(await page.evaluate(() => new URL(location.href).searchParams.get("fontPreview")), null);
  assert.deepEqual(browserErrors, []);
  const db = new DatabaseSync(join(root, "app.sqlite"), { readOnly: true });
  try { assert.equal((db.prepare("SELECT COUNT(*) AS count FROM repair_tickets").get() as { count: number }).count, 0); } finally { db.close(); }
  // 模拟已有明确聊天选择，再验证同一失败前幂等键可以提交修订方案；不重放原输入。
  const submitted = await call("submit_motion_work", { project_id: projectId, base_revision_id: before.revision.number,
    idempotency_key: "font-selection", work: { ...work, fontBindings: { title: "aa-houdi-hei" }, creativeBrief: `${work.creativeBrief}\n技术夹具模拟明确选择Aa厚底黑，不代表真实用户审批。` } });
  let completed;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { completed = await call("track_job", { job_id: submitted.id }); if (["succeeded", "failed"].includes(completed.status)) break; await new Promise(done => setTimeout(done, 1000)); }
  assert.equal(completed.status, "succeeded", JSON.stringify(completed));
  const rendered = await call("read_motion_work", { project_id: projectId, job_id: submitted.id });
  assert.equal(rendered.asset.motion.fontSources[0].fontId, "aa-houdi-hei");
  const report = { 已验证: true, 范围: "独立候选技术验证，未修改正式项目；推荐和聊天选择为机械技术夹具", root, port, release,
    字体目录: capabilities.fonts, 原件接口逐份校验: downloaded, 未登记字体拒绝: unknown, 字体预览链接: editor,
    浏览器: { 实际字样: glyphs, 最大字体并发: maxConcurrent, 三款对比: true, 复制不写项目: true, 单字款失败无回退: true, 关闭面板字体清理: true, 切项目清除推荐上下文: true, 紧凑默认字样: compact, 两列卡片布局: cardLayout, compactScreenshot, 页面异常: browserErrors, screenshot },
    无修复工单: true, 选择纠正后实际生成: { jobId: submitted.id, assetId: rendered.asset.id, fontSources: rendered.asset.motion.fontSources } };
  await writeFile(join(root, "字体工作台候选验证.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ 阶段: "字体工作台候选验证完成", reportPath: join(root, "字体工作台候选验证.json"), screenshot, releaseId: runtime.releaseId }));
} finally {
  await browser?.close().catch(() => undefined);
  await client.close().catch(() => undefined); await transport.close().catch(() => undefined);
  await runCandidateRuntime("stop", runtimeArgs);
}
