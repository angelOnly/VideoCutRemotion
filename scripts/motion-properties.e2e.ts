import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import { verifyMotionPreviewFrames } from "../apps/render-worker/src/motion-renderer.js";

// 读取报障原始参数，但只在新建的独立 SQLite 和端口中提交。
const inputPath = resolve(process.argv[2]!);
const baselineRoot = resolve(process.argv[3]!);
const work = motionSubmissionSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
assert.equal(Object.keys(work.imageBindings).length, 0, "此回归不复制正式素材");
assert.equal(work.previousAssetId, undefined, "此回归不使用正式作品 ID");
const repoRoot = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "videocut-properties-release-"));
const pluginRoot = join(root, "installation", "videoflowcut");
await cp(join(repoRoot, "plugins/videoflowcut"), pluginRoot, { recursive: true });
const workspaceRoot = join(root, "workspace");
const require = createRequire(import.meta.url);
const { ensureRuntime, findAvailablePort, stopRuntime } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const port = await findAvailablePort();
assert.notEqual(port, 3100);
const options = { pluginRoot, repoRoot, workspaceRoot, port, bridgeUrl: "http://127.0.0.1:18199" };
const transport = new StdioClientTransport({ command: process.execPath, args: [join(pluginRoot, "scripts/mcp-launcher.mjs")],
  cwd: repoRoot, stderr: "pipe", env: { ...getDefaultEnvironment(), VIDEOFLOWCUT_REPO_ROOT: repoRoot,
    VIDEOCUT_WORKSPACE: workspaceRoot, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: options.bridgeUrl } });
const client = new Client({ name: "motion-property-release-regression", version: "1.0.0" });
const rawCall = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const result = await rawCall(name, args);
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse((result.content as { type: string; text?: string }[]).find(entry => entry.type === "text")!.text!);
};
const waitJob = async (id: string) => {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: id });
    if (["succeeded", "failed"].includes(job.status)) return job;
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error("候选作品渲染超时，不视为成功");
};
try {
  await ensureRuntime({ ...options, pluginRoot: baselineRoot });
  await client.connect(transport);
  await client.listTools();
  const baseline = await call("read_runtime_release");
  const created = await call("create_project", { name: "普通数据字段误报的发行隔离回归" });
  const projectId = created.snapshot.project.id;
  const args = { project_id: projectId, base_revision_id: created.revision.number, idempotency_key: "original-work", work };
  const rejected = await rawCall("submit_motion_work", args);
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.content), /MOTION_API_REJECTED: window/u);
  assert.deepEqual(await call("read_project", { project_id: projectId }), created);
  const jobs = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/jobs`);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await jobs(), [], "原子拒绝不得留下 Job");
  await ensureRuntime(options);
  await client.listTools();
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  assert.notEqual(release.mcpReleaseId, baseline.mcpReleaseId);
  console.log(JSON.stringify({ stage: "baseline_reproduced_candidate_ready", root, port, baseline: baseline.mcpReleaseId, releaseId: release.mcpReleaseId }));
  const unsafe = [
    "window.location.href", "globalThis['window']", "this.window", "React.window",
    "({window:'窗口'}).constructor", "({window:'窗口'})['__proto__']", "fetch('https://example.com')", "Date.now()"
  ];
  for (const expression of unsafe) {
    const result = await rawCall("submit_motion_work", { ...args, idempotency_key: `blocked-${unsafe.indexOf(expression)}`,
      work: { ...work, source: `import React from 'react';export default function Motion(){return <div>{${expression}}</div>}` } });
    assert.equal(result.isError, true, expression);
    assert.match(JSON.stringify(result.content), /MOTION_API_REJECTED/u);
  }
  assert.deepEqual(await jobs(), [], "危险访问拒绝不得留下 Job");
  assert.deepEqual(await call("read_project", { project_id: projectId }), created);
  const submitted = await call("submit_motion_work", args);
  const completed = await waitJob(submitted.id);
  assert.equal(completed.status, "succeeded", JSON.stringify(completed));
  const result = await call("read_motion_work", { project_id: projectId, job_id: submitted.id });
  const preview = join(created.snapshot.project.rootPath, result.asset.managedPath);
  await verifyMotionPreviewFrames(preview, work.durationInFrames, work.fps);
  const report = { verified: true, scope: "独立发行技术回归，不代表正式作品提交或专业审片", root, port,
    sourceHash: createHash("sha256").update(work.source).digest("hex"), sourceCharacters: work.source.length,
    baselineReleaseId: baseline.mcpReleaseId, release, rejected: rejected.content, negativeCases: unsafe,
    inputFrames: work.durationInFrames, completed, preview };
  const reportPath = join(root, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verified: true, reportPath, preview, completedJob: completed.id, sourceHash: report.sourceHash }));
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await stopRuntime(options, { force: true });
}
