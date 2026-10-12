import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createApplication, type EditingApplication } from "@videocut/application";
import { ComfyUIBridgeClient, type BridgeRun, type BridgeWorkflow } from "@videocut/bridge";
import type { BridgeRunAudit, WordTiming } from "@videocut/contracts";
import { DomainError, millisecondsToFrames } from "@videocut/domain";
import { evaluateQuality } from "@videocut/quality";
import { createServer } from "../apps/server/src/app.js";
import { MEDIA_JOB_KINDS, createMediaJobProcessor } from "../apps/job-worker/src/index.js";
import { parseSpeechAlignmentJson, runSpeechAlignment } from "../apps/job-worker/src/speech-alignment.js";
import { resolveWordExactCaptionHighlight } from "../packages/remotion-runtime/src/index.js";

const alignmentWorkflow: BridgeWorkflow = {
  id: "forced-alignment-workflow",
  name: "真实强制对齐",
  available: true,
  schemaVersion: "alignment-v1",
  fields: [
    { id: "alignment_text", label: "Forced alignment text", kind: "text", required: true },
    { id: "language", label: "Language", kind: "text", required: false }
  ],
  itemSlots: [{ id: "speech_audio", label: "Speech audio", kind: "audio", required: true }],
  outputs: [{ id: "alignment_json", label: "Alignment JSON", kind: "text" }]
};

type SpeechContext = {
  root: string;
  app: EditingApplication;
  projectId: string;
  speechAssetId: string;
  segmentIds: string[];
  dispose: () => Promise<void>;
};

async function createSpeechContext(application?: EditingApplication, root?: string): Promise<SpeechContext> {
  const ownsApplication = !application;
  const workspaceRoot = root ?? await mkdtemp(join(tmpdir(), "videocut-speech-alignment-"));
  const app = application ?? createApplication(workspaceRoot);
  const created = app.createProject({ name: "真实词级对齐测试" });
  const projectId = created.snapshot.project.id;
  const imported = app.registerImportedAsset({
    projectId,
    baseRevision: created.revision.number,
    name: "speech.wav",
    kind: "speech",
    managedPath: "assets/source/speech.wav",
    sourceHash: "speech-alignment-fixture-hash",
    provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
  });
  const projectRoot = app.readProject(projectId).snapshot.project.rootPath;
  const audioPath = join(projectRoot, "assets", "source", "speech.wav");
  await mkdir(dirname(audioPath), { recursive: true });
  // Worker 只验证该文件可读取并作为 multipart 上传；音频元数据由当前项目的媒体分析事实提供。
  await writeFile(audioPath, Buffer.alloc(512, 0x31));
  app.applyMediaAnalysis({
    projectId,
    assetId: imported.asset.id,
    metadata: { durationMs: 1_000, hasAudio: true, audioCodec: "pcm_s16le", sampleRate: 24_000, channels: 1, mime: "audio/wav" }
  });
  const transcript = app.applyTranscript({ projectId, assetId: imported.asset.id, text: "你好。世界。", source: "manual" });
  const semantic = app.applySemanticUnits({
    projectId,
    baseRevision: transcript.revision.number,
    units: transcript.snapshot.transcriptSentenceCandidates.map((candidate) => ({
      candidateIds: [candidate.id],
      text: candidate.text,
      kind: "statement" as const,
      confidence: 0.9,
      pauseBefore: { durationMs: 0, reason: "sentence" as const }
    }))
  });
  const segments = semantic.snapshot.speechSegments;
  assert.equal(segments.length, 2, "测试文本必须形成两个 SpeechSegment");
  const timings = segments.map((segment, index) => {
    const startMs = index === 0 ? 0 : 500;
    const endMs = index === 0 ? 500 : 1_000;
    return {
      speechSegmentId: segment.id,
      startMs,
      endMs,
      startFrame: millisecondsToFrames(startMs, semantic.snapshot.timeline.fps),
      endFrame: millisecondsToFrames(endMs, semantic.snapshot.timeline.fps)
    };
  });
  const assembled = app.applySpeechAssembly({
    projectId,
    generatedAssets: [],
    segmentAssets: segments.map((segment, index) => ({
      id: `alignment_segment_asset_${index}`,
      speechSegmentId: segment.id,
      voiceReferenceAssetId: imported.asset.id,
      assetId: imported.asset.id,
      durationMs: 500,
      bridgeRunId: `segment-run-${index}`,
      schemaVersion: "fixture-v1",
      quality: "passed" as const
    })),
    speechAsset: {
      id: "speech_asset_alignment_fixture",
      assetId: imported.asset.id,
      scriptRevision: semantic.snapshot.script.revision,
      segmentAssetIds: segments.map((_segment, index) => `alignment_segment_asset_${index}`),
      timing: { precision: "segment_exact", source: "测试用真实段级时序", segments: timings },
      status: "ready"
    }
  });
  return {
    root: workspaceRoot,
    app,
    projectId,
    speechAssetId: assembled.snapshot.speechAsset!.id,
    segmentIds: segments.map((segment) => segment.id),
    dispose: async () => {
      if (ownsApplication) app.close();
      if (ownsApplication) await rm(workspaceRoot, { recursive: true, force: true });
    }
  };
}

function wordsFor(context: SpeechContext): WordTiming[] {
  const state = context.app.readProject(context.projectId);
  const fps = state.snapshot.timeline.fps;
  const make = (speechSegmentId: string, text: string, startMs: number, endMs: number): WordTiming => ({
    speechSegmentId,
    text,
    normalizedText: text,
    startMs,
    endMs,
    startFrame: millisecondsToFrames(startMs, fps),
    endFrame: millisecondsToFrames(endMs, fps)
  });
  return [
    make(context.segmentIds[0]!, "你", 0, 100),
    make(context.segmentIds[0]!, "好", 100, 500),
    make(context.segmentIds[1]!, "世", 500, 600),
    make(context.segmentIds[1]!, "界", 600, 1_000)
  ];
}

function completedAudit(): BridgeRunAudit {
  return {
    workflowId: alignmentWorkflow.id,
    runId: "alignment-bridge-run",
    schemaVersion: alignmentWorkflow.schemaVersion,
    schemaRetryCount: 0,
    submittedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    request: { fieldValues: { alignment_text: "你好。世界。" }, fileSlots: [{ id: "speech_audio", kind: "audio", fileName: "speech.wav" }] },
    response: { status: "succeeded", outputs: [] }
  };
}

function submit(context: SpeechContext) {
  const state = context.app.readProject(context.projectId);
  return context.app.submitSpeechAlignment({
    projectId: context.projectId,
    baseRevision: state.revision.number,
    workflowId: alignmentWorkflow.id,
    speechAssetId: context.speechAssetId,
    idempotencyKey: `alignment-${state.revision.number}-${Math.random().toString(36).slice(2)}`
  });
}

test("Application 仅在真实 token、审计与当前 SpeechAsset 一致时升级为 word_exact", async () => {
  const context = await createSpeechContext();
  try {
    const job = submit(context);
    const completed = context.app.completeSpeechAlignment({
      projectId: context.projectId,
      jobId: job.id,
      alignment: { words: wordsFor(context), source: "测试强制对齐器" },
      bridgeAudit: completedAudit()
    });
    assert.equal(completed.duplicate, false);
    assert.equal(completed.state.snapshot.speechAsset?.timing.precision, "word_exact");
    assert.equal(completed.state.snapshot.speechAlignment?.generationJobId, job.id);
    assert.ok(completed.state.snapshot.timeline.captions.every((caption) => caption.precision === "word_exact"));
    assert.equal(context.app.readSpeechAlignment(context.projectId)?.words.length, 4);
    const report = evaluateQuality(completed.state.snapshot, completed.state.revision.number);
    assert.equal(report.issues.some((entry) => entry.code === "WORD_ALIGNMENT_REQUIRED" || entry.code === "WORD_ALIGNMENT_INVALID"), false);
    const firstWord = completed.alignment.words[0]!;
    const caption = completed.state.snapshot.timeline.captions.find((candidate) => candidate.speechSegmentId === firstWord.speechSegmentId)!;
    assert.equal(resolveWordExactCaptionHighlight(completed.state.snapshot, caption, firstWord.startFrame)?.text, "你", "真实词级时间戳必须实际驱动当前字幕的高亮");
    assert.equal(resolveWordExactCaptionHighlight(completed.state.snapshot, { ...caption, textMode: "manual" }, firstWord.startFrame), undefined, "手工改写字幕不能按 normalizedText 猜测逐词位置");

    const invalidated = context.app.applyScript({
      projectId: context.projectId,
      baseRevision: completed.state.revision.number,
      semanticUnitIds: completed.state.snapshot.script.semanticUnitIds
    });
    assert.equal(invalidated.snapshot.speechAlignment, undefined, "主线变化后当前快照不能保留旧词级时间戳");
    assert.ok(invalidated.revision.impact.stale.includes(completed.alignment.id));
  } finally {
    await context.dispose();
  }
});

test("Application 拒绝伪造文本、越界分段、帧换算和错误 Script 的词级输出", async () => {
  const context = await createSpeechContext();
  try {
    const job = submit(context);
    const attempt = (words: WordTiming[]) => context.app.completeSpeechAlignment({
      projectId: context.projectId,
      jobId: job.id,
      alignment: { words, source: "测试强制对齐器" },
      bridgeAudit: completedAudit()
    });
    const badNormalized = wordsFor(context);
    badNormalized[0] = { ...badNormalized[0]!, normalizedText: "伪造" };
    assert.throws(() => attempt(badNormalized), (error: unknown) => error instanceof DomainError && error.code === "SPEECH_ALIGNMENT_WORD_TEXT_INVALID");

    const crossSegment = wordsFor(context);
    crossSegment[1] = { ...crossSegment[1]!, endMs: 501, endFrame: millisecondsToFrames(501, 24) };
    assert.throws(() => attempt(crossSegment), (error: unknown) => error instanceof DomainError && error.code === "SPEECH_ALIGNMENT_SEGMENT_MISMATCH");

    const badFrame = wordsFor(context);
    badFrame[0] = { ...badFrame[0]!, startFrame: 9 };
    assert.throws(() => attempt(badFrame), (error: unknown) => error instanceof DomainError && error.code === "SPEECH_ALIGNMENT_FRAME_INVALID");

    const badText = wordsFor(context);
    badText[3] = { ...badText[3]!, text: "错", normalizedText: "错" };
    assert.throws(() => attempt(badText), (error: unknown) => error instanceof DomainError && error.code === "SPEECH_ALIGNMENT_TEXT_MISMATCH");
  } finally {
    await context.dispose();
  }
});

test("Worker 动态读取 Schema、上传本地音频和当前 Script，并只接受明确 JSON 时间戳", async () => {
  const context = await createSpeechContext();
  const originalFetch = globalThis.fetch;
  let observedRequest: Record<string, unknown> | undefined;
  let observedAudioFile = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.endsWith(`/workflows/${alignmentWorkflow.id}`) && (!init?.method || init.method === "GET")) return Response.json(alignmentWorkflow);
    if (address.endsWith(`/workflows/${alignmentWorkflow.id}/runs`) && init?.method === "POST") {
      assert.ok(init.body instanceof FormData, "对齐音频必须通过 multipart 上传");
      const form = init.body as FormData;
      observedRequest = JSON.parse(String(form.get("request"))) as Record<string, unknown>;
      const file = form.get("file_speech_audio");
      observedAudioFile = file instanceof Blob && file.size > 0;
      return Response.json({ id: "alignment-run-1", status: "queued", outputs: [] });
    }
    if (address.endsWith("/runs/alignment-run-1")) {
      return Response.json({
        id: "alignment-run-1",
        status: "succeeded",
        outputs: [{
          outputSlotId: "alignment_json",
          displayName: "Final alignment",
          kind: "text",
          text: JSON.stringify({
            timeUnit: "ms",
            source: "fixture aligner",
            words: [
              { text: "你", start: 0, end: 100, confidence: 0.98 },
              { text: "好", start: 100, end: 500 },
              { text: "世", start: 500, end: 600 },
              { text: "界", start: 600, end: 1000 }
            ]
          })
        }]
      } satisfies BridgeRun);
    }
    throw new Error(`测试未处理的 Bridge 请求：${address}`);
  }) as typeof fetch;
  try {
    const job = submit(context);
    assert.ok(MEDIA_JOB_KINDS.includes("speech_alignment"), "词级对齐 Job 必须由媒体 Worker 领取");
    const result = await createMediaJobProcessor(
      context.app,
      new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1")
    )(job);
    assert.equal(result.speechAlignmentId, context.app.readSpeechAlignment(context.projectId)?.id);
    assert.equal(result.wordCount, 4);
    assert.deepEqual(observedRequest, {
      schemaVersion: "alignment-v1",
      fieldValues: { alignment_text: "你好。\n世界。" }
    });
    assert.equal(observedAudioFile, true);
    assert.equal(context.app.readSpeechAlignment(context.projectId)?.source, "fixture aligner");
    const audits = context.app.trackJob(job.id).result?.bridgeRuns as Array<BridgeRunAudit>;
    assert.equal(audits.length, 1, "同一 run 的完成审计应覆盖未完成快照，而不是重复保存两份同一 run");
    assert.ok(audits[0]?.completedAt, "最终审计必须记录真实完成时间");
  } finally {
    globalThis.fetch = originalFetch;
    await context.dispose();
  }
});

test("裸时间单位和丢失的 Bridge Run 都不会被猜测或自动重提", async () => {
  assert.throws(
    () => parseSpeechAlignmentJson(JSON.stringify({ words: [{ text: "你", start: 0, end: 100 }] })),
    (error: unknown) => error instanceof DomainError && error.code === "SPEECH_ALIGNMENT_TIME_UNIT_REQUIRED"
  );
  const context = await createSpeechContext();
  const originalFetch = globalThis.fetch;
  let createRunCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.endsWith("/runs/lost-alignment-run")) return Response.json({ error: "run missing" }, { status: 404 });
    if (address.endsWith(`/workflows/${alignmentWorkflow.id}/runs`) && init?.method === "POST") {
      createRunCalls += 1;
      return Response.json({ id: "unexpected", status: "queued", outputs: [] });
    }
    throw new Error(`测试未处理的 Bridge 请求：${address}`);
  }) as typeof fetch;
  try {
    const job = submit(context);
    context.app.recordBridgeRun(job.id, {
      workflowId: alignmentWorkflow.id,
      runId: "lost-alignment-run",
      schemaVersion: alignmentWorkflow.schemaVersion,
      schemaRetryCount: 0,
      submittedAt: new Date().toISOString(),
      request: { fieldValues: { alignment_text: "你好。世界。" }, fileSlots: [] }
    });
    await assert.rejects(
      () => runSpeechAlignment(context.app, context.app.trackJob(job.id), new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1")),
      (error: unknown) => error instanceof DomainError && error.code === "ALIGNMENT_RUN_LOST_REQUIRES_RECONFIRMATION"
    );
    assert.equal(createRunCalls, 0, "run_id 丢失时不能自动创建第二个对齐任务");
  } finally {
    globalThis.fetch = originalFetch;
    await context.dispose();
  }
});

test("HTTP 提交和读取词级对齐只暴露当前 Revision 的受管 Job / 对齐对象", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-speech-alignment-http-"));
  const { app: server, application } = await createServer({ workspaceRoot });
  try {
    const context = await createSpeechContext(application, workspaceRoot);
    const current = application.readProject(context.projectId);
    const submitted = await server.inject({
      method: "POST",
      url: `/api/projects/${context.projectId}/speech-alignment`,
      payload: { baseRevision: current.revision.number, workflowId: alignmentWorkflow.id, speechAssetId: context.speechAssetId }
    });
    assert.equal(submitted.statusCode, 202);
    assert.equal((submitted.json() as { kind: string }).kind, "speech_alignment");
    const read = await server.inject({ method: "GET", url: `/api/projects/${context.projectId}/speech-alignment` });
    assert.equal(read.statusCode, 200);
    assert.equal((read.json() as { speechAlignment?: unknown }).speechAlignment, undefined);
  } finally {
    await server.close();
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
