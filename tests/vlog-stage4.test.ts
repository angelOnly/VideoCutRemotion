import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createApplication, type EditingApplication } from "@videocut/application";
import type { AssetKind, MediaMetadata } from "@videocut/contracts";
import { evaluateQuality } from "@videocut/quality";
import { probeMedia, runProcess } from "@videocut/speech";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { createServer } from "../apps/server/src/app.js";

async function createTestApplication(): Promise<{ root: string; app: EditingApplication; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "videocut-vlog-stage4-"));
  const app = createApplication(root);
  return {
    root,
    app,
    dispose: async () => {
      app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

/** 三段纯色硬切足以稳定验证 FFmpeg scene filter，不把测试伪装成内容理解能力。 */
async function createSceneFixture(directory: string): Promise<string> {
  const path = join(directory, "vlog-hard-cuts.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1",
    "-f", "lavfi", "-i", "color=c=white:s=64x64:r=24:d=1",
    "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=3",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]",
    "-map", "3:a",
    "-c:v", "mpeg4", "-q:v", "5",
    "-c:a", "aac",
    "-shortest",
    "-movflags", "+faststart",
    path
  ]);
  return path;
}

async function addReadyAsset(input: {
  app: EditingApplication;
  projectId: string;
  name: string;
  kind: AssetKind;
  sourcePath?: string;
  durationMs?: number;
  hasAudio?: boolean;
}): Promise<string> {
  const registered = input.app.registerImportedAsset({
    projectId: input.projectId,
    baseRevision: input.app.readProject(input.projectId).revision.number,
    name: input.name,
    kind: input.kind,
    managedPath: `assets/source/${input.name}`,
    sourceHash: `${input.name}-${Date.now()}-${Math.random()}`,
    provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
  });
  let metadata: MediaMetadata = {
    durationMs: input.durationMs ?? 3_000,
    hasAudio: input.hasAudio ?? input.kind !== "image",
    videoCodec: input.kind === "video" ? "mpeg4" : undefined,
    audioCodec: input.kind === "image" ? undefined : "aac",
    width: input.kind === "video" ? 64 : undefined,
    height: input.kind === "video" ? 64 : undefined
  };
  if (input.sourcePath) {
    const asset = input.app.readProject(input.projectId).snapshot.assets.find((candidate) => candidate.id === registered.asset.id);
    assert.ok(asset, "测试素材必须已登记");
    const targetPath = join(input.app.readProject(input.projectId).snapshot.project.rootPath, asset.managedPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(input.sourcePath, targetPath);
    metadata = await probeMedia(targetPath);
  }
  input.app.applyMediaAnalysis({ projectId: input.projectId, assetId: registered.asset.id, metadata });
  // registerImportedAsset 的媒体分析 Job 已被这里的真实元数据替代，避免它抢在目标 vlog_analysis 前再次执行。
  for (const job of input.app.listJobs(input.projectId)) {
    if (job.kind === "media_analysis" && job.status === "queued") {
      input.app.updateJob(job.id, { status: "succeeded", result: { seeded: true } });
    }
  }
  return registered.asset.id;
}

async function drainUntilFinished(app: EditingApplication, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = app.trackJob(jobId);
    if (current.status === "succeeded") return;
    assert.notEqual(current.status, "failed", current.error ?? "Vlog Job 不应失败");
    assert.equal(await runOneJob(app, createMediaJobProcessor(app)), true, "队列中应存在待处理 Vlog Job");
  }
  assert.equal(app.trackJob(jobId).status, "succeeded", "Vlog Job 必须在有限轮次内完成");
}

test("Vlog Worker 从 FFmpeg 场景边界到 Event、Select、Montage、Ambient 和质量规则形成最小闭环", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Vlog 阶段 4 E2E", profile: "vlog" });
    const projectId = created.snapshot.project.id;
    const fixture = await createSceneFixture(context.root);
    const sourceAssetId = await addReadyAsset({ app: context.app, projectId, name: "vlog-hard-cuts.mp4", kind: "video", sourcePath: fixture });
    const submitted = context.app.submitVlogAnalysis({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      assetIds: [sourceAssetId],
      sceneThreshold: 0.1,
      idempotencyKey: "vlog-stage4-real-ffmpeg"
    });
    await drainUntilFinished(context.app, submitted.id);

    const analysed = context.app.readVlogPlan(projectId);
    assert.ok(analysed.vlogShotAnalyses.length >= 3, "硬切素材应至少形成三个可追溯源范围");
    assert.ok(analysed.vlogShotAnalyses.every((shot) => shot.source === "ffmpeg_scene"));
    assert.ok(analysed.vlogShotAnalyses.every((shot) => shot.hasAudio));
    assert.ok(analysed.vlogShotAnalyses.every((shot) => shot.evidenceNote.includes("未自动判断动作、事件或画面美学")));

    const selectedShots = [
      analysed.vlogShotAnalyses[0]!,
      analysed.vlogShotAnalyses[1]!,
      analysed.vlogShotAnalyses[2]!,
      analysed.vlogShotAnalyses[0]!
    ];
    const eventState = context.app.manageVlogEvents({
      projectId,
      baseRevision: analysed.revision,
      action: "create",
      order: 0,
      title: "从进入地点到完成行动",
      summary: "用建立、行动和反应镜头呈现一段可跟随的真实过程。",
      shotAnalysisIds: analysed.vlogShotAnalyses.map((shot) => shot.id),
      goal: "进入并完成一次现场行动",
      actionNote: "人物移动并完成动作",
      change: "画面与空间发生变化",
      reaction: "保留完成后的真实停顿",
      continuityNote: "按照同一段真实拍摄顺序组织，不把不同事件伪装为同时发生。",
      status: "ready"
    });
    const event = eventState.snapshot.vlogEvents[0]!;
    const functions = ["establish", "action", "reaction", "atmosphere"] as const;
    const audioModes = ["keep", "mute", "keep", "mute"] as const;
    const selectIds: string[] = [];
    for (const [index, shot] of selectedShots.entries()) {
      const state = context.app.manageVlogShotSelects({
        projectId,
        baseRevision: context.app.readProject(projectId).revision.number,
        action: "create",
        eventId: event.id,
        shotAnalysisId: shot.id,
        order: index,
        sourceStartFrame: shot.sourceStartFrame,
        sourceEndFrame: shot.sourceEndFrame,
        function: functions[index]!,
        selectionReason: `${functions[index]} 镜头为事件提供不可替代的真实信息。`,
        continuityNote: "保留动作前后余量，并与前一镜头的空间方向连续。",
        sourceAudioMode: audioModes[index]!,
        // 编译前只有候选计划，Scene / Timeline Item 由 compileVlogMontage 原子补齐后才成为 ready。
        status: "planned"
      });
      selectIds.push(state.snapshot.vlogShotSelects.at(-1)!.id);
    }
    const montage = context.app.compileVlogMontage({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      shotSelectIds: selectIds,
      titlePrefix: "现场记录"
    });
    assert.ok(montage.snapshot.scenes.some((scene) => scene.type === "VlogMontageScene" && scene.status === "ready"));
    assert.ok(montage.snapshot.vlogAmbientCues.length === 2, "只有明确 keep 的 Select 才应有独立 Ambient Cue");

    const bgmAssetId = await addReadyAsset({ app: context.app, projectId, name: "vlog-bgm.wav", kind: "audio", durationMs: 1_000 });
    const withBgm = context.app.manageAudio({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      action: "create",
      kind: "bgm",
      assetId: bgmAssetId,
      purpose: "仅为 Montage 提供克制的节奏支撑",
      loop: true,
      gainDb: -18,
      ducking: { reductionDb: -12 }
    });
    const bgm = withBgm.snapshot.audioCues.find((cue) => cue.kind === "bgm");
    assert.ok(bgm, "测试应成功建立 BGM，才能记录人工拍点");
    const starts = withBgm.snapshot.vlogShotSelects
      .map((select) => withBgm.snapshot.timeline.items.find((item) => item.id === select.timelineItemId)?.startFrame)
      .filter((frame): frame is number => frame !== undefined)
      .sort((left, right) => left - right);
    for (const frame of starts.slice(1)) {
      context.app.manageVlogMusicBeats({
        projectId,
        baseRevision: context.app.readProject(projectId).revision.number,
        action: "create",
        audioCueId: bgm.id,
        frame,
        note: "人工试听确认的参考拍点，不自动驱动剪辑。"
      });
    }

    const finalState = context.app.readProject(projectId);
    const report = evaluateQuality(finalState.snapshot, finalState.revision.number);
    assert.equal(report.issues.some((entry) => entry.code === "MISSING_PRIMARY_VIDEO"), false, "纯 Vlog 不应要求 Actor / A-roll 主画面");
    assert.equal(report.issues.some((entry) => entry.code === "VLOG_PRIMARY_MONTAGE_MISSING"), false);
    assert.equal(report.issues.some((entry) => entry.code === "VLOG_SELECT_TIMELINE_BINDING_INVALID"), false);
    assert.equal(report.issues.some((entry) => entry.code === "VLOG_AMBIENT_BINDING_INVALID"), false);
    assert.ok(report.issues.some((entry) => entry.code === "VLOG_DUPLICATE_SHOT_REVIEW"), "重复源范围必须显式交给连续预览复核");
    assert.ok(report.issues.some((entry) => entry.code === "VLOG_MUSIC_CUT_DOMINANCE_REVIEW"), "所有切点都落在拍点时必须提示人工复核");
  } finally {
    await context.dispose();
  }
});

test("Hybrid 的 Explainer + Vlog 主线认可已就绪 Montage，且不放宽纯模式门禁", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Hybrid Vlog 主画面质量回归", profile: "hybrid" });
    const projectId = created.snapshot.project.id;
    // 说明页只表达 Hybrid 的 Scene 边界；实际主画面由随后编译的 Vlog Montage 承担。
    context.app.createScene({
      projectId,
      baseRevision: created.revision.number,
      type: "ExplainerScene",
      title: "进入现场",
      purpose: "建立说明页到实拍事件的观看边界。",
      startFrame: 0,
      endFrame: 24
    });
    const assetId = await addReadyAsset({
      app: context.app,
      projectId,
      name: "hybrid-vlog.mp4",
      kind: "video",
      durationMs: 2_000,
      hasAudio: false
    });
    const job = context.app.submitVlogAnalysis({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      assetIds: [assetId],
      sceneThreshold: 0.2
    });
    const analysis = context.app.completeVlogAnalysis({
      projectId,
      jobId: job.id,
      analyses: [{
        assetId,
        sourceStartFrame: 0,
        sourceEndFrame: 48,
        source: "manual",
        technicalScore: 0.5,
        hasAudio: false,
        evidenceNote: "人工确认的实拍事件范围，用于验证混合项目的主画面门禁。"
      }]
    }).analyses[0]!;
    const event = context.app.manageVlogEvents({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      action: "create",
      order: 0,
      title: "现场事件",
      summary: "说明页结束后播放一段可追溯的实拍范围。",
      shotAnalysisIds: [analysis.id],
      status: "ready"
    }).snapshot.vlogEvents[0]!;
    const select = context.app.manageVlogShotSelects({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      action: "create",
      eventId: event.id,
      shotAnalysisId: analysis.id,
      order: 0,
      sourceStartFrame: 0,
      sourceEndFrame: 48,
      function: "action",
      selectionReason: "该范围承担 Hybrid 项目的实拍主线。",
      continuityNote: "从说明页后进入同一受管实拍范围。",
      sourceAudioMode: "mute",
      status: "planned"
    }).snapshot.vlogShotSelects[0]!;
    const compiled = context.app.compileVlogMontage({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      shotSelectIds: [select.id],
      startFrame: 24
    });

    const hybridReport = evaluateQuality(compiled.snapshot, compiled.revision.number);
    assert.equal(hybridReport.issues.some((entry) => entry.code === "MISSING_PRIMARY_VIDEO"), false, "Hybrid 已就绪 Vlog Montage 应作为有效主画面");
    assert.ok(hybridReport.issues.some((entry) => entry.code === "VLOG_AMBIENT_ABSENT_REVIEW"), "Hybrid 不能因主画面通过而跳过 Vlog 环境声质量规则");

    const presenterSnapshot = structuredClone(compiled.snapshot);
    presenterSnapshot.project.profile = "presenter_motion";
    assert.ok(evaluateQuality(presenterSnapshot, compiled.revision.number).issues.some((entry) => entry.code === "MISSING_PRIMARY_VIDEO"), "纯 Presenter 不能借用 Vlog Montage 绕过 A-roll 门禁");
    const explainerSnapshot = structuredClone(compiled.snapshot);
    explainerSnapshot.project.profile = "visual_explainer";
    assert.ok(evaluateQuality(explainerSnapshot, compiled.revision.number).issues.some((entry) => entry.code === "EXPLAINER_PRIMARY_VISUAL_MISSING"), "纯 Explainer 仍必须拥有已就绪的 Explainer Program");
  } finally {
    await context.dispose();
  }
});

/**
 * 重编 Montage 会停用旧 Item 并留下 stale Scene 供审计，但最终时长只能由当前可播放主线决定。
 * 否则用户把一个镜头缩短后，导出仍会在旧尾帧之后留下无画面的黑屏。
 */
test("Vlog 缩短 Shot Select 后重编，不保留已停用旧 Montage 的黑尾时长", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Vlog 重编时长回归", profile: "vlog" });
    const projectId = created.snapshot.project.id;
    const assetId = await addReadyAsset({
      app: context.app,
      projectId,
      name: "vlog-recompile.mp4",
      kind: "video",
      durationMs: 6_000,
      hasAudio: false
    });
    const analysisJob = context.app.submitVlogAnalysis({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      assetIds: [assetId],
      sceneThreshold: 0.2
    });
    const analysis = context.app.completeVlogAnalysis({
      projectId,
      jobId: analysisJob.id,
      analyses: [{
        assetId,
        sourceStartFrame: 0,
        sourceEndFrame: 120,
        source: "manual",
        technicalScore: 0.7,
        hasAudio: false,
        evidenceNote: "人工确认的连续动作范围；用于验证缩短后重编的时长，而不是自动理解事件。"
      }]
    }).analyses[0]!;
    const eventState = context.app.manageVlogEvents({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      action: "create",
      order: 0,
      title: "一段可缩短的动作",
      summary: "先使用完整动作范围，随后缩短为有效片段。",
      shotAnalysisIds: [analysis.id],
      status: "ready"
    });
    const event = eventState.snapshot.vlogEvents[0]!;
    const selectState = context.app.manageVlogShotSelects({
      projectId,
      baseRevision: eventState.revision.number,
      action: "create",
      eventId: event.id,
      shotAnalysisId: analysis.id,
      order: 0,
      sourceStartFrame: 0,
      sourceEndFrame: 120,
      function: "action",
      selectionReason: "完整动作先作为初版主线。",
      continuityNote: "缩短后仍从同一动作起点进入。",
      sourceAudioMode: "mute",
      status: "planned"
    });
    const selectId = selectState.snapshot.vlogShotSelects[0]!.id;
    const initial = context.app.compileVlogMontage({
      projectId,
      baseRevision: selectState.revision.number,
      shotSelectIds: [selectId]
    });
    assert.equal(initial.snapshot.timeline.durationInFrames, 120);

    const shortened = context.app.manageVlogShotSelects({
      projectId,
      baseRevision: initial.revision.number,
      action: "update",
      shotSelectId: selectId,
      sourceEndFrame: 48,
      status: "planned"
    });
    const recompiled = context.app.compileVlogMontage({
      projectId,
      baseRevision: shortened.revision.number,
      shotSelectIds: [selectId]
    });
    const activeBackgroundEnds = recompiled.snapshot.timeline.items
      .filter((item) => !item.disabled && recompiled.snapshot.timeline.tracks.find((track) => track.id === item.trackId)?.name === "Background")
      .map((item) => item.endFrame);

    assert.deepEqual(activeBackgroundEnds, [48]);
    assert.equal(recompiled.snapshot.timeline.durationInFrames, 48, "已停用 Item 与 stale Scene 不能继续延长最终导出时长");
  } finally {
    await context.dispose();
  }
});

test("HTTP 暴露 Vlog 分析、计划、Event、Select、Montage 与人工拍点的受控入口", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-vlog-http-"));
  const server = await createServer({ workspaceRoot: root });
  try {
    const created = await server.app.inject({ method: "POST", url: "/api/projects", payload: { name: "Vlog HTTP", profile: "vlog" } });
    assert.equal(created.statusCode, 201);
    const projectId = (created.json() as { snapshot: { project: { id: string } } }).snapshot.project.id;
    const sourceAssetId = await addReadyAsset({ app: server.application, projectId, name: "http-vlog.mp4", kind: "video" });
    const submitted = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/vlog-analysis`,
      payload: { baseRevision: server.application.readProject(projectId).revision.number, assetIds: [sourceAssetId], sceneThreshold: 0.2 }
    });
    assert.equal(submitted.statusCode, 202);
    const job = submitted.json() as { id: string; kind: string };
    assert.equal(job.kind, "vlog_analysis");

    // HTTP 负责受控提交；这里用 Application 注入一条人工边界，让后续 HTTP 写入能验证对象映射。
    server.application.completeVlogAnalysis({
      projectId,
      jobId: job.id,
      analyses: [{
        assetId: sourceAssetId,
        sourceStartFrame: 0,
        sourceEndFrame: 72,
        source: "manual",
        technicalScore: 0.5,
        hasAudio: true,
        evidenceNote: "测试用人工确认的完整源范围；不代表自动事件识别。"
      }]
    });
    const initialPlan = await server.app.inject({ method: "GET", url: `/api/projects/${projectId}/vlog-plan` });
    assert.equal(initialPlan.statusCode, 200);
    const plan = initialPlan.json() as { revision: number; vlogShotAnalyses: Array<{ id: string; sourceStartFrame: number; sourceEndFrame: number }> };
    assert.equal(plan.vlogShotAnalyses.length, 1);

    const eventResponse = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/vlog-events`,
      payload: {
        baseRevision: plan.revision,
        action: "create",
        order: 0,
        title: "HTTP 事件",
        summary: "验证显式 Event Map 写入。",
        shotAnalysisIds: [plan.vlogShotAnalyses[0]!.id],
        status: "ready"
      }
    });
    assert.equal(eventResponse.statusCode, 200, eventResponse.body);
    const eventState = eventResponse.json() as { revision: { number: number }; snapshot: { vlogEvents: Array<{ id: string }> } };
    const selectResponse = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/vlog-shot-selects`,
      payload: {
        baseRevision: eventState.revision.number,
        action: "create",
        eventId: eventState.snapshot.vlogEvents[0]!.id,
        shotAnalysisId: plan.vlogShotAnalyses[0]!.id,
        order: 0,
        sourceStartFrame: 0,
        sourceEndFrame: 72,
        function: "action",
        selectionReason: "保留实际动作。",
        continuityNote: "保留动作前后余量。",
        sourceAudioMode: "keep",
        status: "planned"
      }
    });
    assert.equal(selectResponse.statusCode, 200, selectResponse.body);
    const selectState = selectResponse.json() as { revision: { number: number }; snapshot: { vlogShotSelects: Array<{ id: string }> } };
    const montageResponse = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/timeline/compile-vlog-montage`,
      payload: { baseRevision: selectState.revision.number, shotSelectIds: [selectState.snapshot.vlogShotSelects[0]!.id] }
    });
    assert.equal(montageResponse.statusCode, 200);
    assert.ok((montageResponse.json() as { snapshot: { scenes: Array<{ type: string }> } }).snapshot.scenes.some((scene) => scene.type === "VlogMontageScene"));
  } finally {
    await server.app.close();
    server.application.close();
    await rm(root, { recursive: true, force: true });
  }
});
