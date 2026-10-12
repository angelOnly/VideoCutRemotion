import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import { MOTION_ENGINE_VERSION } from "../packages/motion-work/src/compiler.js";
import { motionFixture } from "../tests/fixtures/managed-motion.js";
import { verifyMotionPreviewFrames } from "../apps/render-worker/src/motion-renderer.js";

// 可传只读报障输入；正式 Project、Job 和资源均不带入独立候选工作区。
const original = process.argv[2] ? motionSubmissionSchema.parse(JSON.parse(await readFile(resolve(process.argv[2]), "utf8"))) : motionFixture;
assert.equal(Object.keys(original.imageBindings).length, 0, "此回归只接受无外部素材绑定的作品");
const { previousAssetId: _previous, ...work } = original;
const require = createRequire(import.meta.url);
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
const { findAvailablePort } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const repoRoot = resolve(import.meta.dirname, "..");
const pluginRoot = join(repoRoot, "plugins/videoflowcut");
const root = await mkdtemp(join(tmpdir(), "videocut-determinism-release-"));
const port = await findAvailablePort();
const args = ["--repo-root", repoRoot, "--workspace", root, "--port", String(port), "--comfyui-bridge-url", "http://127.0.0.1:18199"];
const runtime = await runCandidateRuntime("ensure", args);
console.log(JSON.stringify({ stage: "candidate_started", root, port, releaseId: runtime.releaseId }));
const spec = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.videoflowcut;
const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: pluginRoot, stderr: "pipe",
  env: { ...getDefaultEnvironment(), ...spec.env, VIDEOCUT_WORKSPACE: root, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: "http://127.0.0.1:18199" } });
const client = new Client({ name: "motion-determinism-regression", version: "1.0.0" });
const call = async (name: string, input: Record<string, unknown> = {}): Promise<any> => {
  const result = await client.callTool({ name, arguments: input });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse((result.content as { type: string; text?: string }[]).find((entry) => entry.type === "text")!.text!);
};
const waitJob = async (id: string) => {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: id });
    if (job.status === "succeeded" || job.status === "failed") return job;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error("候选任务超时，不能视为成功");
};
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  for (const name of ["read_runtime_release", "create_project", "read_project", "submit_motion_work", "track_job", "read_motion_work"]) assert.ok(catalog.tools.some((tool) => tool.name === name));
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.equal(release.runtime.releaseId, runtime.releaseId);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  const created = await call("create_project", { name: "重复帧检查的发行隔离回归" });
  const projectId = created.snapshot.project.id;
  const projectRoot = created.snapshot.project.rootPath;
  const submitted = await call("submit_motion_work", { project_id: projectId, base_revision_id: created.revision.number, idempotency_key: "determinism-complete", work });
  const completed = await waitJob(submitted.id);
  assert.equal(completed.status, "succeeded", JSON.stringify(completed));
  assert.ok(["exact", "tolerated"].includes(completed.result.motionDiagnostics.status));
  const rendered = await call("read_motion_work", { project_id: projectId, job_id: submitted.id });
  assert.equal(rendered.asset.motion.engineVersion, MOTION_ENGINE_VERSION);
  const preview = join(projectRoot, rendered.asset.managedPath);
  await verifyMotionPreviewFrames(preview, work.durationInFrames, work.fps);
  const stable = await call("read_project", { project_id: projectId });
  const badSource = `import React from 'react';import {useCurrentFrame} from 'remotion';let visited=false;export default function Motion(){if(useCurrentFrame()>0)visited=true;return <div style={{position:'absolute',inset:0,background:visited?'white':'black'}}/>;}`;
  const bad = await call("submit_motion_work", { project_id: projectId, base_revision_id: stable.revision.number, idempotency_key: "determinism-negative", work: { ...motionFixture, source: badSource, durationInFrames: 4 } });
  const failed = await waitJob(bad.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.result.diagnostic.code, "MOTION_NONDETERMINISTIC");
  const reportPath = join(projectRoot, failed.result.motionDiagnostics.reportPath);
  const failure = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(failure.status, "failed");
  for (const entry of failure.differences) for (const path of Object.values(entry.paths)) assert.ok((await readFile(join(dirname(reportPath), String(path)))).length);
  const after = await call("read_project", { project_id: projectId });
  assert.deepEqual(after, stable, "失败及其诊断不得修改视频项目");
  const report = { verified: true, scope: "独立发行技术回归，不是正式项目成片或审美验收", root, port, release,
    inputFrameCount: work.durationInFrames, engineVersion: rendered.asset.motion.engineVersion, completedJob: completed.id,
    motionDiagnostics: completed.result.motionDiagnostics, preview, failedJob: failed.id, failure, failureReportPath: reportPath };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath: join(root, "report.json") }));
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await runCandidateRuntime("stop", args);
}
