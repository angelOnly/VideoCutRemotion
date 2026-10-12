import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication, type EditingApplication } from "@videocut/application";
import { DomainError } from "@videocut/domain";
import { evaluateQuality } from "@videocut/quality";
import { probeMedia, runProcess } from "@videocut/speech";
import { runOneJob } from "../apps/job-worker/src/index.js";
import { buildDialogueProcessingFilters } from "../apps/job-worker/src/dialogue-processing.js";
import { createServer } from "../apps/server/src/app.js";

type DialogueFixture = {
  root: string;
  app: EditingApplication;
  projectId: string;
  sourceAssetId: string;
  speechAssetId: string;
  dispose: () => Promise<void>;
};

async function createWavFixture(directory: string): Promise<string> {
  const path = join(directory, "dialogue.wav");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:a", "pcm_s16le",
    path
  ]);
  return path;
}

/** 构造一条真实可播放的完整 SpeechAsset；不借用 BGM/SFX 的 AudioCue。 */
async function prepareDialogueFixture(application?: EditingApplication, root?: string): Promise<DialogueFixture> {
  const ownsApplication = !application;
  const workspaceRoot = root ?? await mkdtemp(join(tmpdir(), "videocut-dialogue-processing-"));
  const app = application ?? createApplication(workspaceRoot);
  const created = app.createProject({ name: "对白处理测试", profile: "presenter_motion" });
  const projectId = created.snapshot.project.id;
  const imported = app.registerImportedAsset({
    projectId,
    baseRevision: created.revision.number,
    name: "dialogue.wav",
    kind: "speech",
    managedPath: "assets/source/dialogue.wav",
    sourceHash: "dialogue-processing-source-hash",
    provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
  });
  const fixture = await createWavFixture(workspaceRoot);
  const target = join(app.readProject(projectId).snapshot.project.rootPath, "assets", "source", "dialogue.wav");
  await mkdir(dirname(target), { recursive: true });
  await copyFile(fixture, target);
  const metadata = await probeMedia(target);
  app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata });
  const transcript = app.applyTranscript({ projectId, assetId: imported.asset.id, text: "这是一段用于比较原声和处理候选的完整旁白。", source: "manual" });
  const semantic = app.applySemanticUnits({
    projectId,
    baseRevision: transcript.revision.number,
    units: transcript.snapshot.transcriptSentenceCandidates.map((candidate) => ({
      candidateIds: [candidate.id],
      text: candidate.text,
      kind: "statement" as const,
      confidence: 0.95,
      pauseBefore: { durationMs: 0, reason: "sentence" as const }
    }))
  });
  const segment = semantic.snapshot.speechSegments[0];
  assert.ok(segment, "测试旁白必须生成 SpeechSegment");
  const assembled = app.applySpeechAssembly({
    projectId,
    generatedAssets: [],
    segmentAssets: [{
      id: "dialogue_processing_segment",
      speechSegmentId: segment.id,
      voiceReferenceAssetId: imported.asset.id,
      assetId: imported.asset.id,
      durationMs: metadata.durationMs,
      bridgeRunId: "dialogue-processing-fixture-run",
      schemaVersion: "fixture-v1",
      quality: "passed"
    }],
    speechAsset: {
      id: "dialogue_processing_speech_asset",
      assetId: imported.asset.id,
      scriptRevision: semantic.snapshot.script.revision,
      segmentAssetIds: ["dialogue_processing_segment"],
      timing: {
        precision: "segment_exact",
        source: "测试用真实 WAV 时长",
        segments: [{
          speechSegmentId: segment.id,
          startMs: 0,
          endMs: metadata.durationMs,
          startFrame: 0,
          endFrame: Math.round((metadata.durationMs / 1_000) * semantic.snapshot.timeline.fps)
        }]
      },
      status: "ready"
    }
  });
  return {
    root: workspaceRoot,
    app,
    projectId,
    sourceAssetId: imported.asset.id,
    speechAssetId: assembled.snapshot.speechAsset!.id,
    dispose: async () => {
      if (ownsApplication) app.close();
      if (ownsApplication) await rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

function markSeedMediaJobsHandled(app: EditingApplication, projectId: string): void {
  for (const job of app.repository.listJobs(projectId)) {
    if (job.kind === "media_analysis" && job.status === "queued") {
      app.repository.updateJob(job.id, { status: "succeeded", result: { seeded: true } });
    }
  }
}

test("Dialogue Processing 只登记原声 / 最小 / 强处理候选，显式选择后才替换 Dialogue", async () => {
  const context = await prepareDialogueFixture();
  try {
    const before = context.app.readProject(context.projectId);
    assert.throws(() => context.app.submitDialogueProcessing({
      projectId: context.projectId,
      baseRevision: before.revision.number,
      issueTypes: [],
      evidenceNote: ""
    }), (error: unknown) => error instanceof DomainError && error.code === "DIALOGUE_PROCESSING_ISSUES_REQUIRED");
    assert.throws(() => context.app.submitDialogueProcessing({
      projectId: context.projectId,
      baseRevision: before.revision.number - 1,
      issueTypes: ["noise"],
      evidenceNote: "00:00–00:01 存在持续底噪。"
    }), /Revision/i);

    const job = context.app.submitDialogueProcessing({
      projectId: context.projectId,
      baseRevision: before.revision.number,
      issueTypes: ["noise", "low_frequency"],
      evidenceNote: "00:00–00:01 可听见持续底噪与近讲低频，需比较处理副作用。"
    });
    assert.equal(job.kind, "dialogue_processing");
    assert.equal((job.payload as { speechAssetId?: string }).speechAssetId, context.speechAssetId);
    assert.equal((job.payload as { sourceAssetId?: string }).sourceAssetId, context.sourceAssetId);
    assert.equal(context.app.readProject(context.projectId).revision.number, before.revision.number, "提交候选不得先创建 Revision 或改 Timeline");

    markSeedMediaJobsHandled(context.app, context.projectId);
    assert.equal(await runOneJob(context.app), true, "媒体 Worker 应领取 Dialogue Processing Job");
    const afterProcessing = context.app.readProject(context.projectId);
    const processing = afterProcessing.snapshot.speechAsset?.dialogueProcessing;
    assert.ok(processing, "Worker 完成后必须登记可试听候选");
    assert.equal(afterProcessing.snapshot.speechAsset?.assetId, context.sourceAssetId, "候选生成绝不能自动替换原声");
    assert.equal(processing.selectedProfile, undefined, "未试听前保持原声默认选择");
    assert.deepEqual(processing.variants.map((variant) => variant.profile), ["original", "minimal", "strong"]);
    const dialogueTrack = afterProcessing.snapshot.timeline.tracks.find((track) => track.name === "Dialogue")!;
    assert.equal(afterProcessing.snapshot.timeline.items.filter((item) => item.trackId === dialogueTrack.id && !item.disabled).length, 1, "候选不得叠加出第二条 Dialogue");
    for (const variant of processing.variants.filter((variant) => variant.profile !== "original")) {
      const asset = afterProcessing.snapshot.assets.find((candidate) => candidate.id === variant.assetId);
      assert.ok(asset?.managedPath.startsWith(`assets/speech/processed/${job.id}/`));
      assert.ok(asset?.metadata?.hasAudio);
      assert.equal(asset?.metadata?.audioCodec?.toLowerCase(), "pcm_s16le");
      assert.ok(variant.filters.length > 0);
    }
    const beforeSelectionQuality = evaluateQuality(afterProcessing.snapshot, afterProcessing.revision.number);
    assert.ok(beforeSelectionQuality.issues.some((issue) => issue.code === "DIALOGUE_PROCESSING_LISTENING_REQUIRED"));

    // 模拟候选 Revision 已提交、但进程尚未来得及写 Job 回执就中断：重领不能因旧 Revision 误失败或复制候选。
    const assetCountBeforeRecovery = afterProcessing.snapshot.assets.length;
    context.app.repository.updateJob(job.id, { status: "queued", result: {} });
    assert.equal(await runOneJob(context.app), true);
    const recovered = context.app.readProject(context.projectId);
    assert.equal(recovered.snapshot.assets.length, assetCountBeforeRecovery, "恢复 Job 不得重复创建候选 Asset");
    assert.equal(context.app.trackJob(job.id).status, "succeeded");
    assert.equal((context.app.trackJob(job.id).result as { dialogueProcessingJobId?: string }).dialogueProcessingJobId, job.id);

    const confirmedOriginal = context.app.selectDialogueProcessingVariant({
      projectId: context.projectId,
      baseRevision: recovered.revision.number,
      profile: "original"
    });
    assert.equal(confirmedOriginal.snapshot.speechAsset?.dialogueProcessing?.selectedProfile, "original", "用户可以显式确认原声最佳");
    assert.equal(confirmedOriginal.snapshot.speechAsset?.assetId, context.sourceAssetId);
    const confirmedOriginalQuality = evaluateQuality(confirmedOriginal.snapshot, confirmedOriginal.revision.number);
    assert.equal(confirmedOriginalQuality.issues.some((issue) => issue.code === "DIALOGUE_PROCESSING_LISTENING_REQUIRED"), false);

    const selected = context.app.selectDialogueProcessingVariant({
      projectId: context.projectId,
      baseRevision: confirmedOriginal.revision.number,
      profile: "minimal"
    });
    const selectedProcessing = selected.snapshot.speechAsset?.dialogueProcessing;
    const minimal = selectedProcessing?.variants.find((variant) => variant.profile === "minimal");
    assert.equal(selectedProcessing?.selectedProfile, "minimal");
    assert.equal(selected.snapshot.speechAsset?.assetId, minimal?.assetId);
    const selectedDialogueItems = selected.snapshot.timeline.items.filter((item) => item.trackId === dialogueTrack.id && !item.disabled);
    assert.equal(selectedDialogueItems.length, 1);
    assert.equal(selectedDialogueItems[0]?.assetId, minimal?.assetId);
    assert.equal(selected.snapshot.speechAsset?.timing.precision, "segment_exact");
    const afterSelectionQuality = evaluateQuality(selected.snapshot, selected.revision.number);
    assert.ok(afterSelectionQuality.issues.some((issue) => issue.code === "DIALOGUE_PROCESSING_PREVIEW_REQUIRED"));

    assert.throws(() => context.app.selectDialogueProcessingVariant({
      projectId: context.projectId,
      baseRevision: recovered.revision.number,
      profile: "strong"
    }), /Revision/i, "选择候选必须受 Revision 冲突保护");
  } finally {
    await context.dispose();
  }
});

test("Dialogue Processing 的 HTTP 合同只创建 Job，选择接口必须显式携带 Revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-dialogue-http-"));
  const server = await createServer({ workspaceRoot: root });
  try {
    const context = await prepareDialogueFixture(server.application, root);
    const current = server.application.readProject(context.projectId);
    const submitted = await server.app.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/dialogue-processing`,
      payload: { baseRevision: current.revision.number, issueTypes: ["noise"], evidenceNote: "首句存在持续底噪，需要试听对比。" }
    });
    assert.equal(submitted.statusCode, 202);
    const submittedJob = submitted.json() as { id: string; kind: string };
    assert.equal(submittedJob.kind, "dialogue_processing");
    const invalid = await server.app.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/dialogue-processing`,
      payload: { baseRevision: current.revision.number, issueTypes: ["noise"], evidenceNote: "" }
    });
    assert.equal(invalid.statusCode, 400);
    const selectMissing = await server.app.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/dialogue-processing/select`,
      payload: { baseRevision: current.revision.number, profile: "minimal" }
    });
    assert.equal(selectMissing.statusCode, 400, "候选尚未生成时不能通过 HTTP 直接替换 Dialogue");

    // 旧 Revision 的完整 SpeechAsset 已经不能安全重跑；通用 retry 必须要求重新提交。
    server.application.applyScript({
      projectId: context.projectId,
      baseRevision: server.application.readProject(context.projectId).revision.number,
      semanticUnitIds: server.application.readProject(context.projectId).snapshot.script.semanticUnitIds
    });
    server.application.repository.updateJob(submittedJob.id, { status: "failed", error: "模拟旧任务失败" });
    const staleRetry = await server.app.inject({ method: "POST", url: `/api/jobs/${submittedJob.id}/retry` });
    assert.equal(staleRetry.statusCode, 400);
    assert.equal((staleRetry.json() as { error: string }).error, "DIALOGUE_PROCESSING_RETRY_STALE");
    await context.dispose();
  } finally {
    server.application.close();
    await server.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("不同处理强度使用可审计的不同滤镜，空问题不会被静默转换", () => {
  const minimal = buildDialogueProcessingFilters("minimal", ["noise", "sibilance"]);
  const strong = buildDialogueProcessingFilters("strong", ["noise", "sibilance"]);
  assert.notDeepEqual(minimal, strong);
  assert.notDeepEqual(
    buildDialogueProcessingFilters("minimal", ["loudness", "true_peak"]),
    buildDialogueProcessingFilters("strong", ["loudness", "true_peak"]),
    "仅响度 / 峰值问题时两档候选也必须实际不同"
  );
  assert.throws(() => buildDialogueProcessingFilters("minimal", []), (error: unknown) => error instanceof DomainError && error.code === "DIALOGUE_PROCESSING_FILTERS_EMPTY");
});

test("MCP 公开对白处理的提交与显式选择入口", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-dialogue-mcp-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: workspaceRoot },
    stderr: "pipe"
  });
  const client = new Client({ name: "dialogue-processing-contract-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    assert.ok(names.has("submit_dialogue_processing"));
    assert.ok(names.has("select_dialogue_processing_variant"));
  } finally {
    await transport.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
