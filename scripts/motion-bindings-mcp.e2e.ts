import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";

const repoRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { findAvailablePort } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
await mkdir(join(repoRoot, ".candidate"), { recursive: true });
const root = await mkdtemp(join(repoRoot, ".candidate", "motion-bindings-"));
const port = await findAvailablePort();
const bridgeUrl = "http://127.0.0.1:18199/comfyui-bridge/v1";
const args = ["--repo-root", repoRoot, "--workspace", root, "--port", String(port), "--comfyui-bridge-url", bridgeUrl];
const runtime = await runCandidateRuntime("ensure", args);
const transport = new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, "plugins/videoflowcut/scripts/mcp-launcher.mjs")], cwd: repoRoot, stderr: "pipe", env: { ...getDefaultEnvironment(), VIDEOCUT_WORKSPACE: root, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: bridgeUrl } });
const client = new Client({ name: "motion-binding-regression", version: "1.0.0" });
const call = async (name: string, input: Record<string, unknown> = {}): Promise<any> => {
  const result = await client.callTool({ name, arguments: input });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse((result.content as { type: string; text?: string }[]).find(c => c.type === "text")!.text!);
};
try {
  await client.connect(transport);
  const schema = await client.listTools();
  assert.ok(schema.tools.find(t => t.name === "submit_motion_work")?.inputSchema.properties?.work);
  const release = await call("read_runtime_release");
  assert.ok(release.aligned && release.runtime.workers.media && release.runtime.workers.render);
  assert.equal(release.mcpReleaseId, runtime.releaseId);
  const state = await call("create_project", { name: "局部 top 作用域隔离技术回归" });
  const projectId = state.snapshot.project.id;
  const work = {
    name: "局部几何变量实际渲染", creativeBrief: "仅验证局部 top 数值驱动 SVG 高度时能通过校验并渲染；不作为用户作品或审美通过证据。",
    source: "import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(){const p=useCurrentFrame()/11, top=180-p*80, height=40+p*80;return <svg width={320} height={320}><rect x={80} y={top} width={120} height={height} fill='#19aa88'/></svg>}",
    width: 320, height: 320, fps: 30, durationInFrames: 12, props: {}, imageBindings: {},
  };
  for (const expression of ["top", "window.top", "globalThis.top"]) {
    const rejected = await client.callTool({ name: "submit_motion_work", arguments: { project_id: projectId, base_revision_id: 1, idempotency_key: `reject-${expression}`, work: { ...work, source: `export default function Motion(){return <div>{${expression}}</div>}` } } });
    assert.ok(rejected.isError && JSON.stringify(rejected.content).includes("MOTION_API_REJECTED"), expression);
  }
  const before = await call("read_project", { project_id: projectId });
  assert.equal(before.revision.number, 1, "拒绝的输入不得创建视频 Revision");
  const job = await call("submit_motion_work", { project_id: projectId, base_revision_id: 1, idempotency_key: "local-top-render", work });
  console.log(JSON.stringify({ stage: "candidate_render", root, port, releaseId: runtime.releaseId, jobId: job.id }));
  const deadline = Date.now() + 90_000;
  let current;
  do {
    current = await call("track_job", { job_id: job.id });
    if (["succeeded", "failed"].includes(current.status)) break;
    await new Promise(r => setTimeout(r, 500));
  } while (Date.now() < deadline);
  assert.equal(current.status, "succeeded", JSON.stringify(current));
  const rendered = await call("read_motion_work", { project_id: projectId, job_id: job.id });
  const framePath = (frame: number) => join(state.snapshot.project.rootPath, rendered.asset.motion.framesDirectory, `frame-${String(frame).padStart(5, "0")}.png`);
  const first = PNG.sync.read(await readFile(framePath(0)));
  const last = PNG.sync.read(await readFile(framePath(11)));
  const alpha = (png: PNG, x: number, y: number) => png.data[(y * 320 + x) * 4 + 3];
  assert.equal(alpha(first, 100, 110), 0);
  assert.equal(alpha(last, 100, 110), 255);
  assert.equal(alpha(first, 100, 200), 255);
  assert.equal(alpha(last, 100, 200), 255);
  const report = { verified: true, root, port, release, projectId, jobId: job.id, frames: 12, firstFrame: framePath(0), lastFrame: framePath(11), globalAccessRejected: true, localGeometryRendered: true };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await client.close().catch(() => undefined);
  await runCandidateRuntime("stop", args);
}
