import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";

// 只在独立工作区建立最小字幕夹具；不读取或写入正式项目。
const repoRoot = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "videocut-caption-release-"));
const pluginRoot = join(root, "installation", "videoflowcut");
await cp(join(repoRoot, "plugins/videoflowcut"), pluginRoot, { recursive: true });
const workspaceRoot = join(root, "workspace");
const require = createRequire(import.meta.url);
const { ensureRuntime, findAvailablePort, stopRuntime } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const port = await findAvailablePort();
assert.notEqual(port, 3100);
const options = { pluginRoot, repoRoot, workspaceRoot, port, bridgeUrl: "http://127.0.0.1:18199" };
const seed = createApplication(workspaceRoot);
const fixtures: Array<{ projectId: string; revision: number; overflow: boolean }> = [];
try {
  for (const overflow of [false, true]) {
    const created = seed.createProject({ name: overflow ? "真实溢出负例" : "实际两行的预算误报" });
    const state = seed.repository.commit(created.snapshot.project.id, 1, "建立独立发行字幕夹具", (snapshot) => {
      snapshot.timeline.width = overflow ? 400 : 768;
      snapshot.timeline.height = 1344;
      snapshot.speechSegments = [{ id: "segment", semanticUnitIds: [], text: "字幕技术夹具", order: 0,
        pauseBefore: { durationMs: 0, reason: "sentence" }, status: "ready" }];
      snapshot.scenes = [{ id: "scene", type: "PresenterScene", title: "技术字幕场景", purpose: "只验证字体测量",
        startFrame: 0, endFrame: 24, assetIds: [], narrativeBeatIds: [], status: "ready", stylePackId: "default-clean" }];
      snapshot.timeline.captions = [{ id: "caption", speechSegmentId: "segment", text: "先说流量，它更像这个月\n能用多少水，解决的是总量。",
        startFrame: 0, endFrame: 24, style: "stable", precision: "segment_exact",
        format: { fontSize: 40, fontWeight: 700, color: "#ffffff", backgroundColor: "#111111", bottomPercent: 12, horizontalInsetPercent: 10, textAlign: "center" } }];
    });
    fixtures.push({ projectId: state.snapshot.project.id, revision: state.revision.number, overflow });
  }
} finally { seed.close(); }

const transport = new StdioClientTransport({ command: process.execPath, args: [join(pluginRoot, "scripts/mcp-launcher.mjs")],
  cwd: repoRoot, stderr: "pipe", env: { ...getDefaultEnvironment(), VIDEOFLOWCUT_REPO_ROOT: repoRoot,
    VIDEOCUT_WORKSPACE: workspaceRoot, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: options.bridgeUrl } });
const client = new Client({ name: "caption-release-regression", version: "1.0.0" });
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse((result.content as { type: string; text?: string }[]).find(entry => entry.type === "text")!.text!);
};
const waitJob = async (id: string) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: id });
    if (["succeeded", "failed"].includes(job.status)) return job;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error("候选字幕任务超时");
};
try {
  // 可选使用真实旧发行复现，然后在同一隔离环境切换候选。
  const baselineRoot = process.argv[2] && resolve(process.argv[2]);
  await ensureRuntime({ ...options, pluginRoot: baselineRoot || pluginRoot });
  await client.connect(transport);
  await client.listTools();
  let baseline;
  if (baselineRoot) {
    const release = await call("read_runtime_release");
    const quality = await call("read_quality_report", { project_id: fixtures[0]!.projectId });
    assert.ok(quality.issues.some((issue: any) => issue.code === "CAPTION_LAYOUT_OVERFLOW" && issue.objectId === "caption"));
    baseline = { releaseId: release.mcpReleaseId, reproducedOverflow: true };
    await ensureRuntime(options);
    await client.listTools();
  }
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  if (baseline) assert.notEqual(release.mcpReleaseId, baseline.releaseId);
  const catalog = await client.listTools();
  assert.match(catalog.tools.find(tool => tool.name === "review_motion_work")!.description!, /project_preview使用项目全局帧.*failed\/inconclusive/u);
  const results = [];
  for (const fixture of fixtures) {
    const before = await call("read_project", { project_id: fixture.projectId });
    const quality = await call("read_quality_report", { project_id: fixture.projectId });
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/${fixture.projectId}/quality`);
    assert.equal(response.status, 200);
    const httpQuality: any = await response.json();
    for (const report of [quality, httpQuality]) {
      assert.equal(report.issues.some((issue: any) => issue.code === "CAPTION_LAYOUT_OVERFLOW"), fixture.overflow);
      assert.equal(report.issues.some((issue: any) => issue.code.startsWith("CAPTION_LAYOUT_MEASUREMENT_")), false);
    }
    assert.deepEqual(await call("read_project", { project_id: fixture.projectId }), before);
    const preflightJob = await call("run_render_preflight", { project_id: fixture.projectId, revision: fixture.revision, idempotency_key: "caption-preflight" });
    const preflight = await waitJob(preflightJob.id);
    assert.equal(preflight.status, "succeeded", JSON.stringify(preflight));
    assert.equal(JSON.stringify(preflight.result).includes("QUALITY_CAPTION_LAYOUT_OVERFLOW"), fixture.overflow);
    const previewJob = await call("render_preview_range", { project_id: fixture.projectId, revision: fixture.revision,
      from_frame: 0, to_frame: 2, idempotency_key: "caption-preview" });
    const preview = await waitJob(previewJob.id);
    assert.equal(preview.status, fixture.overflow ? "failed" : "succeeded", JSON.stringify(preview));
    if (fixture.overflow) assert.match(JSON.stringify(preview), /CAPTION_LAYOUT_OVERFLOW/u);
    assert.deepEqual(await call("read_project", { project_id: fixture.projectId }), before);
    results.push({ ...fixture, qualityCodes: quality.issues.map((issue: any) => issue.code), preflight, preview });
  }
  const reportPath = join(root, "report.json");
  await writeFile(reportPath, JSON.stringify({ verified: true, scope: "隔离发行技术验收，不代表正式字幕的专业审片", root, port, baseline, release, results }, null, 2));
  console.log(JSON.stringify({ verified: true, root, port, baseline, releaseId: release.mcpReleaseId, reportPath }));
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await stopRuntime(options, { force: true });
}
