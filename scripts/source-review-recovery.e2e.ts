import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import puppeteer from "puppeteer-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveRenderBrowser } from "../packages/remotion-runtime/src/browser.js";
import { runProcess } from "@videocut/speech";

// 生产仅作只读身份对账；导入、故障夹具、审阅缓存全部在独立候选工作区。
const require = createRequire(import.meta.url);
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
const { findAvailablePort } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const repo = resolve(import.meta.dirname, ".."), pluginRoot = join(repo, "plugins/videoflowcut");
const production = join(repo, "workspace");
const sourceFile = process.argv[2];
assert.ok(sourceFile, "请传入只读复现原件的绝对路径");
assert.ok(resolve(sourceFile) === sourceFile.replaceAll("/", "\\") || resolve(sourceFile) === sourceFile);
const hashFile = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
function formalFacts() {
  const db = new DatabaseSync(join(production, "app.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT project_id, revision_number, snapshot_json FROM revisions ORDER BY project_id, revision_number").all()
      .map(row => ({ projectId: row.project_id, revision: row.revision_number, hash: createHash("sha256").update(String(row.snapshot_json)).digest("hex") }));
  } finally { db.close(); }
}
const before = formalFacts(), sourceHash = await hashFile(sourceFile);
await mkdir(join(repo, ".repair-validation"), { recursive: true });
const root = await mkdtemp(join(repo, ".repair-validation/source-review-")), port = await findAvailablePort();
const copied = join(root, "原问题视频.mp4");
await copyFile(sourceFile, copied);
assert.equal(await hashFile(copied), sourceHash);
const origin = `http://127.0.0.1:${port}`;
const args = ["--repo-root", repo, "--workspace", root, "--port", String(port), "--comfyui-bridge-url", "http://127.0.0.1:18199"];
await runCandidateRuntime("ensure", args);
const spec = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.videoflowcut;
const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: pluginRoot, stderr: "pipe",
  env: { ...getDefaultEnvironment(), ...spec.env, VIDEOCUT_WORKSPACE: root, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: "http://127.0.0.1:18199" } });
const client = new Client({ name: "素材审阅容错候选验证", version: "1" });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
async function call(name: string, input: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: input }, undefined, { timeout: 240_000 });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const text = (response.content as { type: string; text?: string }[]).find(entry => entry.type === "text")!.text!;
  return JSON.parse(text);
}
async function importFixture(path: string, name: string) {
  const created = await call("create_project", { name, profile: "visual_explainer", fps: 30 });
  const projectId = created.snapshot.project.id;
  const imported = await call("import_media", { project_id: projectId, base_revision_id: created.revision.number, file_path: path, role: "b_roll" });
  const deadline = Date.now() + 180_000;
  let job;
  do {
    job = await call("track_job", { job_id: imported.job.id });
    if (["succeeded", "failed"].includes(job.status)) break;
    await new Promise(done => setTimeout(done, 400));
  } while (Date.now() < deadline);
  assert.equal(job.status, "succeeded", JSON.stringify(job));
  const state = await call("read_project", { project_id: projectId });
  return { projectId, assetId: imported.asset.id, state };
}
try {
  await client.connect(transport);
  const schema = (await client.listTools()).tools.find(tool => tool.name === "inspect_asset")!;
  assert.match(schema.description!, /diagnostics.*select_another_candidate.*report_platform_failure/u);
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  const original = await importFixture(copied, "原问题视频审阅候选夹具");
  console.log(JSON.stringify({ 阶段: "原问题视频副本已就绪", root, port }));
  const overview = await call("inspect_asset", { project_id: original.projectId, asset_id: original.assetId, mode: "overview", contact_sheet_frames: 12 });
  assert.equal(overview.diagnostics.status, "partial");
  assert.equal(overview.diagnostics.generatedFrames, 11);
  assert.equal(overview.diagnostics.requestedFrames, 12);
  assert.equal(overview.diagnostics.recovery, "inspect_available_evidence");
  assert.equal(overview.diagnostics.issues[0].code, "SOURCE_REVIEW_OUTPUT_EMPTY");
  console.log(JSON.stringify({ 阶段: "原问题已复现且返回有效预览", diagnostics: overview.diagnostics }));
  const http = await fetch(`${origin}/api/projects/${original.projectId}/assets/${original.assetId}/inspect`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "overview", contactSheetFrames: 12 }) });
  assert.equal(http.status, 200);
  const httpOverview = await http.json();
  assert.deepEqual(httpOverview.diagnostics, overview.diagnostics);
  const range = await call("inspect_asset", { project_id: original.projectId, asset_id: original.assetId, mode: "range", source_start_frame: 0, source_end_frame: 60, contact_sheet_frames: 3 });
  assert.equal(range.diagnostics.status, "complete");
  assert.equal(range.diagnostics.continuousReview, "available");
  assert.ok(range.proxy && range.audio.waveform);
  assert.deepEqual(await call("read_project", { project_id: original.projectId }), original.state);
  assert.equal((await call("list_repair_tickets", { project_id: original.projectId })).repairTickets.length, 0);
  browser = await puppeteer.launch({ executablePath: await resolveRenderBrowser(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000 });
  const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(String(error)));
  await page.goto(`${origin}/?projectId=${original.projectId}&panel=assets`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-testid="asset-${original.assetId}"]`);
  await page.click(`[data-testid="asset-${original.assetId}"]`);
  await page.waitForSelector(".source-review-actions");
  await page.click(".source-review-actions button:first-child");
  await page.waitForSelector('[data-testid="source-review-diagnostics"]', { timeout: 240_000 });
  const message = await page.$eval('[data-testid="source-review-diagnostics"]', element => element.textContent!);
  // 工作台概览默认请求20张；MCP前面的12张请求独立核验同一缺口。
  assert.match(message, /部分预览可用.*19\/20.*缺失位置尚未核验/u);
  assert.equal(await page.$$eval(".source-review-contact-sheet img", images => images.length), 19);
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".source-review-contact-sheet img")).every(image => (image as HTMLImageElement).naturalWidth > 0));
  await (await page.$('[data-testid="source-review-diagnostics"]'))!.screenshot({ path: join(root, "部分预览正常展示.png") });
  const goodFile = join(root, "正常候选.mp4");
  await runProcess("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=96x72:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", goodFile]);
  const broken = await importFixture(goodFile, "坏文件分类隔离夹具");
  const asset = broken.state.snapshot.assets.find((entry: { id: string }) => entry.id === broken.assetId);
  const brokenPath = resolve(broken.state.snapshot.project.rootPath, asset.managedPath);
  assert.ok(!relative(root, brokenPath).startsWith(".."), "故障夹具只能写候选目录");
  await writeFile(brokenPath, "<html>不可播放的候选夹具</html>");
  const unusable = await call("inspect_asset", { project_id: broken.projectId, asset_id: broken.assetId, contact_sheet_frames: 3 });
  assert.equal(unusable.diagnostics.status, "unavailable");
  assert.equal(unusable.diagnostics.recovery, "select_another_candidate");
  assert.equal(unusable.diagnostics.issues.every((issue: { owner: string }) => issue.owner === "source"), true);
  await page.goto(`${origin}/?projectId=${broken.projectId}&panel=assets`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-testid="asset-${broken.assetId}"]`); await page.click(`[data-testid="asset-${broken.assetId}"]`);
  await page.waitForSelector(".source-review-actions"); await page.click(".source-review-actions button:first-child");
  await page.waitForSelector('[data-testid="source-review-diagnostics"]');
  assert.match(await page.$eval('[data-testid="source-review-diagnostics"]', element => element.textContent!), /当前素材暂不采用.*其他候选/u);
  await (await page.$('[data-testid="source-review-diagnostics"]'))!.screenshot({ path: join(root, "不可用候选提示.png") });
  assert.deepEqual(await call("read_project", { project_id: broken.projectId }), broken.state);
  const alternative = await importFixture(goodFile, "替代候选隔离夹具");
  const usable = await call("inspect_asset", { project_id: alternative.projectId, asset_id: alternative.assetId, contact_sheet_frames: 3 });
  assert.equal(usable.diagnostics.status, "complete", "坏文件不妨碍新的正常候选审阅");
  assert.equal((await call("list_repair_tickets", { project_id: broken.projectId })).repairTickets.length, 0);
  assert.deepEqual(pageErrors, []);
  assert.equal(await hashFile(sourceFile), sourceHash);
  assert.deepEqual(formalFacts(), before, "正式视频 Revision 及其持久化内容保持不变");
  await writeFile(join(root, "素材审阅容错候选验证.json"), JSON.stringify({ 已验证: true, root, port, release, 原件哈希: sourceHash,
    原问题: overview.diagnostics, 局部连续审阅: range.diagnostics, 坏文件: unusable.diagnostics, 替代候选: usable.diagnostics,
    浏览器提示: message, 正式版本数量: before.length, 正式内容未修改: true, 原件未修改: true, 浏览器错误: pageErrors }, null, 2));
  console.log(JSON.stringify({ 已验证: true, root, port, releaseId: release.runtime.releaseId }));
} finally {
  await browser?.close(); await client.close(); await runCandidateRuntime("stop", args);
}
