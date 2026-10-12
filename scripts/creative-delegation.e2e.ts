import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import { probeMedia } from "@videocut/speech";
import { planCreativePreviewFrames } from "./creative-preview-frames.js";

/** 仅驱动隔离发行验收；创意输入来自宿主子代理，脚本不生成设计或冒充审片。 */
type Context = {
  kind: "creative-delegation-candidate";
  root: string;
  port: number;
  releaseId?: string;
  projectId?: string;
  projectRoot?: string;
  revision?: number;
  runId?: string;
  sceneId?: string;
  cueId?: string;
  assetId?: string;
  repairTicketId?: string;
  releaseHistory?: Array<{ previousReleaseId: string; releaseId: string; reason: string }>;
  iterations: Array<Record<string, unknown>>;
};

const [stage, contextArgument, inputArgument] = process.argv.slice(2);
assert.ok(["prepare", "render", "inspect", "compose", "review", "audit", "blocker", "upgrade"].includes(stage!), "用法：creative-delegation.e2e.ts prepare|render|inspect|compose|review|audit|blocker|upgrade <context.json> [input.json]");
assert.ok(contextArgument, "必须明确指定验收上下文文件");
const contextPath = resolve(contextArgument);
const require = createRequire(import.meta.url);
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
const { findAvailablePort } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const repoRoot = resolve(import.meta.dirname, "..");
const pluginRoot = join(repoRoot, "plugins", "videoflowcut");
let context: Context;
if (stage === "prepare") {
  await assert.rejects(readFile(contextPath), { code: "ENOENT" }, "不能覆盖既有验收上下文");
  context = { kind: "creative-delegation-candidate", root: await mkdtemp(join(tmpdir(), "videocut-creative-delegation-")), port: await findAvailablePort(), iterations: [] };
} else {
  context = JSON.parse(await readFile(contextPath, "utf8"));
}
// 只允许本脚本的临时候选目录；外部上下文不能将驱动指向正式工作区。
const actualRoot = await realpath(context.root);
assert.equal(context.kind, "creative-delegation-candidate");
assert.equal(dirname(actualRoot).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
assert.ok(basename(actualRoot).startsWith("videocut-creative-delegation-"));
const candidateArgs = ["--repo-root", repoRoot, "--workspace", actualRoot, "--port", String(context.port), "--comfyui-bridge-url", "http://127.0.0.1:18199"];
const runtime = await runCandidateRuntime("ensure", candidateArgs);
const spec = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.videoflowcut;
const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: pluginRoot, stderr: "pipe", env: { ...getDefaultEnvironment(), ...spec.env, VIDEOCUT_WORKSPACE: actualRoot, VIDEOFLOWCUT_PORT: String(context.port), COMFYUI_BRIDGE_URL: "http://127.0.0.1:18199" } });
const client = new Client({ name: "creative-delegation-candidate", version: "1.0.0" });
const trace: Array<Record<string, unknown>> = [];
const tracePath = `${contextPath}.${stage}.${Date.now()}.trace.json`;
const saveTrace = () => writeFile(tracePath, JSON.stringify({ scope: "实际候选 MCP 调用；不是宿主代理身份认证或审美结论", trace }, null, 2));
const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  // 先保存调用意图；断连时保留幂等键与未知状态，不让后续操作者误以为未提交。
  const entry: Record<string, unknown> = { tool: name, arguments: args, outcome: "attempted", at: new Date().toISOString() };
  trace.push(entry);
  await saveTrace();
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    Object.assign(entry, { outcome: "unknown", error: String(error) });
    await saveTrace();
    throw error;
  }
  Object.assign(entry, { outcome: result.isError ? "rejected" : "returned", result });
  await saveTrace();
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse((result.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text")!.text!);
};
const project = () => call("read_project", { project_id: context.projectId });
const save = () => writeFile(contextPath, JSON.stringify(context, null, 2));
const waitJob = async (jobId: string) => {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const job = await call("track_job", { job_id: jobId });
    if (job.status === "succeeded") return job;
    assert.ok(job.status !== "failed" && job.status !== "cancelled", JSON.stringify(job));
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`候选 Job 超时，保留原 ID 对账：${jobId}`);
};

try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.ok(catalog.tools.find((tool) => tool.name === "record_creative_decision")?.inputSchema.properties?.delegation, "发行 MCP 必须真实暴露新增字段");
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.equal(release.runtime.releaseId, runtime.releaseId);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  if (stage === "upgrade") {
    assert.ok(inputArgument, "升级候选须明确前后发行标识与原因");
    const upgrade = JSON.parse(await readFile(resolve(inputArgument), "utf8"));
    assert.equal(upgrade.previous_release_id, context.releaseId);
    assert.equal(upgrade.release_id, runtime.releaseId);
    assert.ok(typeof upgrade.reason === "string" && upgrade.reason.trim());
    (context.releaseHistory ??= []).push({ previousReleaseId: context.releaseId!, releaseId: runtime.releaseId, reason: upgrade.reason });
  } else if (context.releaseId) assert.equal(context.releaseId, runtime.releaseId, "续接验收不得静默换发行物");
  context.releaseId = runtime.releaseId;
  if (stage === "upgrade") {
    context.revision = (await project()).revision.number;
  } else if (stage === "prepare") {
    const created = await call("create_project", { name: "子代理交接发行验收（隔离项目）", profile: "visual_explainer" });
    context.projectId = created.snapshot.project.id;
    context.projectRoot = created.snapshot.project.rootPath;
    context.revision = created.revision.number;
    context.runId = (await call("start_production_run", { project_id: context.projectId, base_revision_id: context.revision, loaded_skills: ["production-coordinator", "project-basics"] })).id;
    await writeFile(`${contextPath}.schema.json`, JSON.stringify(catalog, null, 2));
  } else if (stage === "inspect") {
    // 中断后只读对账，不重复生成或重放写入；把真实对象交回原代理确认。
    const current = await project();
    context.revision = current.revision.number;
    const iteration = context.iterations.at(-1);
    assert.ok(iteration?.motionJobId, "尚无可对账作品");
    const rendered = await call("read_motion_work", { project_id: context.projectId, job_id: iteration.motionJobId });
    assert.equal(rendered.job.status, "succeeded");
    context.assetId = rendered.asset.id;
    Object.assign(iteration, { assetId: context.assetId, workPreview: join(context.projectRoot!, rendered.asset.managedPath), workVersion: rendered.asset.motion.version });
    await writeFile(`${contextPath}.snapshot.json`, JSON.stringify(current, null, 2));
  } else if (stage === "blocker") {
    assert.ok(inputArgument, "必须提供实际阻断事实");
    const input = JSON.parse(await readFile(resolve(inputArgument), "utf8"));
    const before = await project();
    assert.equal(input.reported_revision, before.revision.number);
    const ticket = await call("report_editing_blocker", { ...input, project_id: context.projectId });
    context.repairTicketId = ticket.id;
    assert.ok(context.repairTicketId);
    assert.deepEqual(await project(), before, "报障只能写独立工单，不能创建视频 Revision");
    context.revision = before.revision.number;
  } else {
    assert.ok(inputArgument, "必须提供子代理产物或审计输入");
    const input = JSON.parse(await readFile(resolve(inputArgument), "utf8"));
    const before = await project();
    assert.equal(input.delegation.input_revision, before.revision.number, "测试输入过期，交原子代理重新确认；不能替换版本重发");
    // 在审计、作品审阅和放置前拒绝错误取样输入，避免失败后留下无关项目写入。
    const inspectionFrames = stage === "compose"
      ? planCreativePreviewFrames(motionSubmissionSchema.parse(input.work).durationInFrames, input.inspection_frames)
      : [];
    const beforeAudit = JSON.stringify(before);
    await call("record_creative_decision", { project_id: context.projectId, run_id: context.runId, category: input.category ?? "visual", decision: input.decision, rationale: input.rationale, delegation: input.delegation, object_ids: input.object_ids ?? [], evidence: input.evidence ?? [] });
    if (input.editorial_review) {
      await call("record_editorial_quality_review", { ...input.editorial_review, project_id: context.projectId, run_id: context.runId, revision: before.revision.number });
      await writeFile(`${contextPath}.quality.json`, JSON.stringify(await call("read_quality_report", { project_id: context.projectId }), null, 2));
    }
    assert.equal(JSON.stringify(await project()), beforeAudit, "委派审计不能改变成片事实");
    if (stage === "review") {
      assert.ok(context.assetId && input.motion_review, "必须提供真实作品与子代理审阅结论");
      const reviewed = await call("review_motion_work", { ...input.motion_review, project_id: context.projectId, base_revision_id: before.revision.number, asset_id: context.assetId });
      Object.assign(context.iterations.at(-1)!, { workReview: reviewed.snapshot.assets.find((asset: { id: string }) => asset.id === context.assetId).motion.review });
    }
    if (stage === "render") {
      const work = motionSubmissionSchema.parse(input.work);
      assert.deepEqual([work.width, work.height, work.fps], [before.snapshot.timeline.width, before.snapshot.timeline.height, before.snapshot.timeline.fps]);
      assert.equal(Object.keys(work.imageBindings).length, 0, "此独立验收只接受无外部素材的作品");
      const submitted = await call("submit_motion_work", { project_id: context.projectId, base_revision_id: before.revision.number, idempotency_key: input.delegation.assignment_id, work: { ...work, ...(context.assetId ? { previousAssetId: context.assetId } : {}) } });
      context.iterations.push({ delegation: input.delegation, inputRevision: before.revision.number, motionJobId: submitted.id });
      await writeFile(contextPath, JSON.stringify(context, null, 2));
      await waitJob(submitted.id);
      const rendered = await call("read_motion_work", { project_id: context.projectId, job_id: submitted.id });
      context.assetId = rendered.asset.id;
      Object.assign(context.iterations.at(-1)!, { assetId: context.assetId, workPreview: join(context.projectRoot!, rendered.asset.managedPath), workVersion: rendered.asset.motion.version, reviewStatus: "等待原子代理审阅真实作品后提交 compose 输入" });
    }
    if (stage === "compose") {
      const work = motionSubmissionSchema.parse(input.work);
      assert.ok(context.assetId && context.iterations.at(-1), "必须先生成作品并回传子代理");
      const rendered = await call("read_motion_work", { project_id: context.projectId, job_id: context.iterations.at(-1)!.motionJobId });
      assert.equal(rendered.asset.id, context.assetId);
      const { previousAssetId: _submittedPrevious, ...submittedWork } = motionSubmissionSchema.parse(rendered.job.payload.work);
      const { previousAssetId: _inputPrevious, ...inputWork } = work;
      assert.deepEqual(inputWork, submittedWork, "合成必须使用已经生成的完整固定输入");
      assert.ok(input.motion_review, "必须提供子代理实际审阅结论；证据不足用 inconclusive");
      const reviewed = await call("review_motion_work", { ...input.motion_review, project_id: context.projectId, base_revision_id: before.revision.number, asset_id: context.assetId });
      Object.assign(context.iterations.at(-1)!, { workReview: reviewed.snapshot.assets.find((asset: { id: string }) => asset.id === context.assetId).motion.review });
      if (!context.sceneId) {
        const created = await call("create_scene", { project_id: context.projectId, base_revision_id: (await project()).revision.number, type: "ExplainerScene", title: input.scene.title, purpose: input.scene.purpose, start_frame: 0, end_frame: work.durationInFrames });
        context.sceneId = created.snapshot.scenes.at(-1).id;
        await save();
      }
      const placed = await call("manage_effect_cues", { project_id: context.projectId, base_revision_id: (await project()).revision.number, ...(context.cueId ? { action: "update", cue_id: context.cueId } : { action: "create", scene_id: context.sceneId, type: "ManagedMotion", layer: "fullscreen", start_frame: 0, end_frame: work.durationInFrames, semantic_anchor: { type: "scene", target_id: context.sceneId, relation: "hold_through" } }), asset_bindings: [{ slot: "motion", asset_id: context.assetId }] });
      context.cueId ??= placed.snapshot.effectCues.at(-1).id;
      await save();
      const preview = await call("render_preview_range", { project_id: context.projectId, revision: placed.revision.number, from_frame: 0, to_frame: work.durationInFrames, idempotency_key: `${input.delegation.assignment_id}-preview` });
      Object.assign(context.iterations.at(-1)!, { previewJobId: preview.id, previewRevision: placed.revision.number });
      await save();
      const completed = await waitJob(preview.id);
      const mediaPath = completed.result.path ?? join(context.projectRoot!, completed.result.relativePath);
      const metadata = await probeMedia(mediaPath);
      assert.ok(Math.abs(metadata.durationMs - work.durationInFrames / work.fps * 1000) < 100, "真实预览时长应与作品一致");
      const inspectionBatches = [];
      for (const frames of inspectionFrames) {
        const result = await call("inspect_composed_frames", { project_id: context.projectId, preview_job_id: preview.id, frames });
        inspectionBatches.push({ frames, result });
      }
      // 原 inspection 字段保留首批结果兼容旧验收记录，完整证据从 inspectionBatches 读取。
      Object.assign(context.iterations.at(-1)!, { assetId: context.assetId, cueId: context.cueId, previewJobId: preview.id, previewRevision: placed.revision.number, preview: mediaPath, metadata, inspection: inspectionBatches[0].result, inspectionBatches, reviewStatus: "待实际子代理审阅，抽帧与技术成功不等于连续观看或审美通过" });
    }
    const audit = await call("read_skill_execution_report", { project_id: context.projectId, run_id: context.runId });
    await writeFile(`${contextPath}.audit.json`, JSON.stringify(audit, null, 2));
    context.revision = (await project()).revision.number;
  }
  await writeFile(contextPath, JSON.stringify(context, null, 2));
  const latest = context.iterations.at(-1);
  console.log(JSON.stringify({ stage, contextPath, projectId: context.projectId, revision: context.revision, releaseId: context.releaseId, assetId: context.assetId, motionJobId: latest?.motionJobId, previewJobId: latest?.previewJobId, preview: latest?.preview }));
} finally {
  // 即使后续步骤拒绝，也保留已经返回的真实 Job/对象，便于只读续接。
  await save();
  await saveTrace();
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await runCandidateRuntime("stop", candidateArgs);
}
