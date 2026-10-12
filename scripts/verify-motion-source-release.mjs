import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runCandidateRuntime, resolveCandidateRuntimeOptions } from "../plugins/videoflowcut/scripts/candidate-runtime.mjs";

// 仅接受候选工具已验证的独立边界，禁止此验收脚本连接生产队列。
const args = process.argv.slice(2);
const options = resolveCandidateRuntimeOptions(args);
const manifest = JSON.parse(await readFile(join(options.pluginRoot, "runtime/dist/manifest.json"), "utf8"));
await runCandidateRuntime("ensure", args);
const transport = new StdioClientTransport({ command: process.execPath, args: [join(options.pluginRoot, "scripts/mcp-launcher.mjs")],
  cwd: options.repoRoot, stderr: "pipe", env: { ...process.env, VIDEOCUT_WORKSPACE: options.workspaceRoot,
    VIDEOFLOWCUT_PORT: String(options.port), COMFYUI_BRIDGE_URL: options.bridgeUrl, VIDEOFLOWCUT_REPO_ROOT: options.repoRoot } });
const client = new Client({ name: "源码校验候选发行验收", version: "1" });
const evidence = { releaseId: manifest.releaseId, workspace: options.workspaceRoot, port: options.port };
const text = result => result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") ?? "";
const call = async (name, input = {}) => {
  const result = await client.callTool({ name, arguments: input });
  const raw = text(result);
  assert.notEqual(result.isError, true, raw);
  return JSON.parse(raw);
};
const waitJob = async id => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: id });
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`候选任务未到终态：${id}`);
};
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  for (const name of ["read_runtime_release", "create_project", "submit_motion_work", "track_job", "read_motion_work", "read_project"]) {
    assert.ok(catalog.tools.find(tool => tool.name === name)?.inputSchema);
  }
  const schema = catalog.tools.find(tool => tool.name === "submit_motion_work").inputSchema;
  for (const field of ["work", "base_revision_id", "idempotency_key"]) assert.ok(schema.properties[field]);
  evidence.release = await call("read_runtime_release");
  assert.equal(evidence.release.aligned, true); assert.equal(evidence.release.mcpReleaseId, manifest.releaseId);
  assert.equal(evidence.release.runtime.workers.media && evidence.release.runtime.workers.render, true);
  const created = await call("create_project", { name: "源码校验候选技术验收", profile: "presenter_motion" });
  const projectId = created.snapshot.project.id;
  const before = await call("read_project", { project_id: projectId });
  const source = `function RuleLine({top}:{top:number}){return <div style={{position:'absolute',left:0,top,width:320,height:100,background:'#00ff00'}}/>;}export default ()=> <RuleLine top={148}/>;`;
  const work = { name: "组件属性技术验证", creativeBrief: "独立候选中验证 JSX 属性名、源码拒绝和渲染链路，不作为正式视频或审美通过。", source, props: {}, width: 320, height: 320, fps: 30, durationInFrames: 4 };
  const input = { project_id: projectId, base_revision_id: before.revision.number, idempotency_key: "candidate-top-correction", work };
  const rejected = await client.callTool({ name: "submit_motion_work", arguments: { ...input, work: { ...work, source: source.replace("top={148}", "top={window.top}") } } });
  evidence.rejectionRaw = text(rejected);
  assert.equal(rejected.isError, true);
  const rejection = JSON.parse(evidence.rejectionRaw);
  assert.equal(rejection.code, "MOTION_API_REJECTED"); assert.equal(rejection.sideEffects, "none");
  assert.equal(rejection.stage, "validation"); assert.equal(rejection.safeToRetry, true); assert.equal(rejection.recovery, "correct_input");
  assert.equal(rejection.fields[0].token, "window");
  const jobs = await fetch(`${options.apiUrl}/api/projects/${projectId}/jobs`).then(r => r.json());
  assert.equal(jobs.length, 0);
  assert.deepEqual(await call("read_project", { project_id: projectId }), before);
  const job = await call("submit_motion_work", input);
  evidence.render = await waitJob(job.id);
  assert.equal(evidence.render.status, "succeeded", JSON.stringify(evidence.render));
  evidence.work = await call("read_motion_work", { project_id: projectId, job_id: job.id });
  assert.equal(evidence.work.asset.motion.frameCount, 4);
  const after = await call("read_project", { project_id: projectId });
  // 同一发行中的真实页面执行失败，必须保留失败 Job，不能返回参数纠正许可。
  const failureJob = await call("submit_motion_work", { ...input, base_revision_id: after.revision.number, idempotency_key: "candidate-execution-failure",
    work: { ...work, source: "export default function Motion(){throw new Error('候选运行阶段故障注入');}" } });
  evidence.executionFailure = await waitJob(failureJob.id);
  assert.equal(evidence.executionFailure.status, "failed");
  assert.ok(!JSON.stringify(evidence.executionFailure).includes('"safeToRetry":true'));
  const final = await call("read_project", { project_id: projectId });
  assert.equal(final.revision.number, after.revision.number);
  assert.equal(final.snapshot.assets.length, after.snapshot.assets.length);
  evidence.verified = true;
  console.log(JSON.stringify({ verified: true, releaseId: manifest.releaseId, projectId, frameCount: 4, failedJobRetained: true }));
} finally {
  const directory = resolve(options.repoRoot, ".repair-validation");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "motion-source-candidate.json"), JSON.stringify(evidence, null, 2));
  await client.close(); await transport.close();
  await runCandidateRuntime("stop", args);
}
