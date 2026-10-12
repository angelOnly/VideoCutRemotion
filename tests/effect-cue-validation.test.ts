import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { DomainError } from "@videocut/domain";
import { toolError } from "../apps/server/src/tool-error.js";
import { motionFixture } from "./fixtures/managed-motion.js";

test("真实MCP拒绝跨Scene整件作品且不写入，原作者改为完整承载后可正常放置", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vfc-cue-boundary-"));
  const app = createApplication(root);
  t.after(async () => { app.close(); await rm(root, { recursive: true, force: true }); });
  const projectId = app.createProject({ name: "隔离的1784帧边界复现", profile: "visual_explainer" }).snapshot.project.id;
  const revision = () => app.readProject(projectId).revision.number;
  app.repository.commit(projectId, revision(), "技术夹具画布", snapshot => {
    Object.assign(snapshot.timeline, { width: 320, height: 320, fps: 30, durationInFrames: 1784 });
  });
  const ranges = [0, 130, 347, 814, 1008, 1310, 1521, 1784];
  const sceneIds = ranges.slice(0, -1).map((startFrame, i) => app.createScene({ projectId, baseRevision: revision(), type: "ExplainerScene",
    title: `隔离场景${i}`, purpose: "只验证范围，不作为创作方案", startFrame, endFrame: ranges[i + 1]! }).snapshot.scenes.at(-1)!.id);
  // 夹具已有完整承载场景，失败路径不得自动扩大短场景或拆分作品。
  const hostId = app.createScene({ projectId, baseRevision: revision(), type: "ExplainerScene", title: "完整承载夹具",
    purpose: "验证已发布的单Scene多Beat能力", startFrame: 0, endFrame: 1784 }).snapshot.scenes.at(-1)!.id;
  const beatIds = sceneIds.map((_, i) => `fixture-beat-${i}`);
  app.repository.commit(projectId, revision(), "技术夹具关联", snapshot => {
    snapshot.story.beats = beatIds.map((id, order) => ({ id, order, title: id, purpose: "边界验证", semanticUnitIds: [], sceneIds: [sceneIds[order]!, hostId] }));
    sceneIds.forEach((id, i) => { snapshot.scenes.find(scene => scene.id === id)!.narrativeBeatIds = [beatIds[i]!]; });
    snapshot.scenes.find(scene => scene.id === hostId)!.narrativeBeatIds = beatIds;
  });
  const job = app.submitManagedMotion({ projectId, baseRevision: revision(), idempotencyKey: "fixture", work: { ...motionFixture, durationInFrames: 1784 } });
  const asset = app.completeManagedMotion({ projectId, jobId: job.id, sourceHash: "fixture-only", engineVersion: "fixture-only",
    metadata: { durationMs: 59467, width: 320, height: 320, fps: 30, hasAudio: false } });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: process.env.VFC_CUE_MCP_ENTRY ? [process.env.VFC_CUE_MCP_ENTRY] : ["--import", "tsx", "apps/server/src/mcp.ts"],
    cwd: process.cwd(), env: { ...process.env as Record<string, string>, VIDEOCUT_WORKSPACE: root }, stderr: "pipe" });
  const client = new Client({ name: "范围拒绝真实协议验证", version: "1" });
  const call = async (args: Record<string, unknown>) => {
    const raw = await client.callTool({ name: "manage_effect_cues", arguments: { project_id: projectId, base_revision_id: revision(), ...args } });
    const text = (raw.content as Array<{ type: string; text?: string }>).find(part => part.type === "text")?.text;
    assert.ok(text, JSON.stringify(raw));
    return { raw, value: JSON.parse(text) };
  };
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.match(catalog.tools.find(tool => tool.name === "manage_effect_cues")!.description!, /不允许跨 Scene 边界/);
    const before = app.readProject(projectId);
    const revisions = app.readRevisions(projectId);
    const jobs = app.repository.listJobs(projectId);
    const placement = { scene_id: sceneIds[0], type: "ManagedMotion", layer: "fullscreen", start_frame: 0, end_frame: 1784,
      covered_narrative_beat_ids: beatIds, asset_bindings: [{ slot: "motion", asset_id: asset.id }] };
    const rejected = await call(placement);
    assert.equal(rejected.raw.isError, true);
    assert.equal(rejected.value.code, "CUE_OUT_OF_SCENE");
    assert.equal(rejected.value.stage, "validation");
    assert.equal(rejected.value.sideEffects, "none");
    assert.equal(rejected.value.safeToRetry, true);
    assert.equal(rejected.value.recovery, "correct_input");
    assert.deepEqual(rejected.value.sceneRange, { startFrame: 0, endFrame: 130 });
    assert.deepEqual(rejected.value.requestedRange, { startFrame: 0, endFrame: 1784 });
    assert.deepEqual(rejected.value.fields.map((field: { field: string }) => field.field), ["start_frame", "end_frame", "scene_id"]);
    assert.match(rejected.value.fields[0].suggestion, /原作者/);
    assert.deepEqual(app.readProject(projectId), before);
    assert.deepEqual(app.readRevisions(projectId), revisions);
    assert.deepEqual(app.repository.listJobs(projectId), jobs);

    const accepted = await call({ ...placement, scene_id: hostId });
    assert.notEqual(accepted.raw.isError, true, JSON.stringify(accepted.raw));
    const after = app.readProject(projectId);
    assert.equal(after.revision.number, before.revision.number + 1);
    assert.equal(after.snapshot.effectCues.length, 1);
    assert.deepEqual(after.snapshot.scenes, before.snapshot.scenes);
    assert.deepEqual(after.snapshot.assets, before.snapshot.assets);
    const cue = after.snapshot.effectCues[0]!;
    assert.equal(cue.endFrame, 1784);
    assert.deepEqual(cue.coveredNarrativeBeatIds, beatIds);
    for (const patch of [{ end_frame: 1785 }, { start_frame: 1784 }]) {
      const invalidUpdate = await call({ action: "update", cue_id: cue.id, ...patch });
      assert.equal(invalidUpdate.raw.isError, true);
      assert.equal(invalidUpdate.value.code, "INVALID_CUE_RANGE");
      assert.equal(invalidUpdate.value.sideEffects, "none");
      assert.equal(invalidUpdate.value.recovery, "correct_input");
      assert.deepEqual(app.readProject(projectId), after);
    }
    const stale = await call({ ...placement, base_revision_id: before.revision.number });
    assert.equal(stale.raw.isError, true);
    assert.equal(stale.value.safeToRetry, false);
    assert.equal(stale.value.sideEffects, "unknown");
    assert.deepEqual(app.readProject(projectId), after);
    assert.deepEqual(app.repository.listJobs(projectId), jobs);
  } finally { await client.close(); await transport.close(); }
});

test("同码异常和提交后失败不能伪装成保存前范围拒绝", async () => {
  for (const error of [new DomainError("同码业务错误", "CUE_OUT_OF_SCENE"), new DomainError("同码业务错误", "INVALID_CUE_RANGE"), new Error("写入结果未知")]) {
    assert.equal(toolError(error).sideEffects, "unknown");
    assert.equal(toolError(error).safeToRetry, false);
  }
  const root = await mkdtemp(join(tmpdir(), "vfc-cue-outcome-"));
  const app = createApplication(root);
  try {
    const projectId = app.createProject({ name: "提交后异常夹具" }).snapshot.project.id;
    const state = app.createScene({ projectId, baseRevision: 1, type: "PresenterScene", title: "范围", purpose: "技术验证", startFrame: 0, endFrame: 120 });
    const commit = app.repository.commit.bind(app.repository);
    app.repository.commit = (...args) => { commit(...args); throw new DomainError("保存后结果丢失", "CUE_OUT_OF_SCENE"); };
    assert.throws(() => app.createEffectCue({ projectId, baseRevision: state.revision.number, sceneId: state.snapshot.scenes[0]!.id,
      type: "CameraPunch", layer: "actor", startFrame: 0, endFrame: 30 }), error => {
      assert.equal(toolError(error).sideEffects, "unknown");
      assert.equal(toolError(error).safeToRetry, false);
      return true;
    });
    assert.equal(app.readProject(projectId).revision.number, state.revision.number + 1);
    assert.equal(app.readProject(projectId).snapshot.effectCues.length, 1);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("范围纠正的交接合同保留原作者判断及旧unknown边界", async () => {
  for (const path of [".agents/skills/known-errors/references/submission-errors.md", ".agents/skills/remotion-production/references/submission-and-recovery.md"]) {
    const text = await readFile(path, "utf8");
    for (const keyword of ["CUE_OUT_OF_SCENE", "INVALID_CUE_RANGE", "covered_narrative_beat_ids", "原作者", "validation/none/correct_input"]) {
      // known-errors 使用完整命名字段，仍须明确三项恢复条件。
      if (keyword === "validation/none/correct_input" && path.includes("known-errors")) {
        for (const field of ["stage=validation", "sideEffects=none", "recovery=correct_input", "旧版 unknown"]) assert.ok(text.includes(field));
      } else assert.ok(text.includes(keyword), `${path} 缺少 ${keyword}`);
    }
  }
});
