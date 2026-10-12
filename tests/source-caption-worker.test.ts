import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ComfyUIBridgeClient, FUNASR_SOURCE_CAPTION_WORKFLOW_ID } from "@videocut/bridge";
import { createApplication } from "@videocut/application";
import { assertProjectGraphValid, DomainError } from "@videocut/domain";
import { evaluateQuality } from "@videocut/quality";
import { probeMedia, runProcess } from "@videocut/speech";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";

const sourceCaptionTranscript = "今天我们一起看如何把视频剪得更精彩。";

type ProviderSegment = {
  displayText: string;
  startMs: number;
  endMs: number;
  /** token 证据可选；正常段级字幕没有它仍可按 Provider 时间显示。 */
  tokenStart?: number;
  tokenEnd?: number;
};

function providerTokens() {
  return [
    { text: "今天", startMs: 0, endMs: 120 },
    { text: "我们", startMs: 120, endMs: 220 },
    { text: "一起", startMs: 220, endMs: 340 },
    { text: "看", startMs: 340, endMs: 400 },
    { text: "如何", startMs: 430, endMs: 540 },
    { text: "把", startMs: 540, endMs: 600 },
    { text: "视频", startMs: 600, endMs: 720 },
    { text: "剪得", startMs: 720, endMs: 850 },
    { text: "更精彩。", startMs: 850, endMs: 1_000 }
  ];
}

function providerSegments(): ProviderSegment[] {
  return [
    { displayText: "今天我们一起看", startMs: 0, endMs: 400, tokenStart: 0, tokenEnd: 4 },
    { displayText: "如何把视频剪得更精彩。", startMs: 430, endMs: 1_000, tokenStart: 4, tokenEnd: 9 }
  ];
}

function providerSegmentsWithoutTokenEvidence(): ProviderSegment[] {
  return providerSegments().map(({ tokenStart: _tokenStart, tokenEnd: _tokenEnd, ...segment }) => segment);
}

function sourceCaptionAlignmentOutput(
  segments = providerSegments(),
  options: { tokenPrecision?: "provider_token_timed" | "unavailable"; tokens?: ReturnType<typeof providerTokens> } = {}
) {
  const tokenPrecision = options.tokenPrecision ?? "provider_token_timed";
  const tokens = options.tokens ?? (tokenPrecision === "provider_token_timed" ? providerTokens() : []);
  return {
    version: 4,
    precision: "provider_segment_timed",
    text: sourceCaptionTranscript,
    alignment: {
      tokenEvidence: tokenPrecision === "provider_token_timed" ? "verified" : "unavailable",
      tokenPrecision,
      tokens
    },
    segments
  };
}

function sourceCaptionWorkflowResponse(outputs = [
  { id: "transcript-text", label: "全文", kind: "text" },
  { id: "caption-alignment-json", label: "字幕段时间", kind: "text" }
]) {
  return {
    id: FUNASR_SOURCE_CAPTION_WORKFLOW_ID,
    name: "FunASR 原声段级字幕对齐",
    available: true,
    schemaVersion: "funasr-source-caption-v4",
    fields: [],
    itemSlots: [{ id: "audio", label: "原声音频", kind: "audio", required: true }],
    outputs
  };
}

type ProviderMockCounters = { creates: number; reads: number };

/** 模拟 Bridge 的正式 v4 响应，并保留 POST/GET 计数以验证结果未知时不重复外部提交。 */
function installProviderBridgeMock(output: unknown, runId: string, counters: ProviderMockCounters): void {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "ready", queueModes: ["normal", "foreground"] }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith(`/workflows/${FUNASR_SOURCE_CAPTION_WORKFLOW_ID}`)) {
      return new Response(JSON.stringify(sourceCaptionWorkflowResponse()), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith(`/workflows/${FUNASR_SOURCE_CAPTION_WORKFLOW_ID}/runs`)) {
      assert.equal(init?.method, "POST");
      assert.ok(init?.body instanceof FormData, "原声段级字幕必须通过 Bridge multipart 合同提交");
      const request = JSON.parse(String((init.body as FormData).get("request")));
      assert.equal(request.queueMode, "foreground", "原声字幕必须进入前置队列，不能被长视频生成饿死");
      counters.creates += 1;
      return new Response(JSON.stringify({ id: runId, status: "queued", outputs: [] }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith(`/runs/${runId}`)) {
      counters.reads += 1;
      return new Response(JSON.stringify({
        id: runId,
        status: "succeeded",
        outputs: [
          { outputSlotId: "transcript-text", displayName: "全文", kind: "text", text: sourceCaptionTranscript },
          { outputSlotId: "caption-alignment-json", displayName: "字幕段时间", kind: "text", text: JSON.stringify(output) }
        ]
      }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`未预期的 Bridge 请求：${url}`);
  };
}

async function createArollFixture(directory: string): Promise<string> {
  const path = join(directory, "source-audio-captions.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=0x264653:s=64x64:r=24:d=1.35",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.45",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=0.45",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=0.45",
    "-filter_complex", "[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]",
    "-map", "0:v:0", "-map", "[a]", "-shortest",
    "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-movflags", "+faststart", path
  ]);
  return path;
}

async function prepareSourceCaptionFixture(root: string) {
  const app = createApplication(root);
  const sourceFile = await createArollFixture(root);
  const created = app.createProject({ name: "原声段级字幕 Worker 测试", profile: "presenter_motion" });
  const projectId = created.snapshot.project.id;
  const imported = app.registerImportedAsset({
    projectId,
    baseRevision: created.revision.number,
    name: "presenter.mp4",
    kind: "video",
    managedPath: "assets/source/presenter.mp4",
    sourceHash: "source-caption-provider-segments-fixture",
    provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
  });
  const targetPath = join(app.readProject(projectId).snapshot.project.rootPath, imported.asset.managedPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourceFile, targetPath);
  app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(targetPath) });
  for (const seedJob of app.listJobs(projectId)) {
    if (seedJob.kind === "media_analysis" && seedJob.status === "queued") app.updateJob(seedJob.id, { status: "succeeded" });
  }
  const assembled = app.buildPresenterTimeline({ projectId, baseRevision: app.readProject(projectId).revision.number, assetIds: [imported.asset.id] });
  const actorItem = assembled.snapshot.timeline.items.find((item) => item.trackId === assembled.snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll")?.id);
  assert.ok(actorItem, "Presenter 时间线应包含 A-roll Item");
  const performed = app.registerActorPerformance({
    projectId,
    baseRevision: assembled.revision.number,
    timelineItemId: actorItem.id,
    source: "imported",
    maskMode: "none",
    audioMode: "use_source_audio"
  });
  return { app, projectId, actorItem, assetId: imported.asset.id, revision: performed.revision.number };
}

async function executeProviderCaptionAlignment(
  fixture: Awaited<ReturnType<typeof prepareSourceCaptionFixture>>,
  output: unknown = sourceCaptionAlignmentOutput(),
  runId = "provider-segment-run"
) {
  const originalFetch = globalThis.fetch;
  const counters: ProviderMockCounters = { creates: 0, reads: 0 };
  try {
    const job = fixture.app.generateSourceAudioCaptions({
      projectId: fixture.projectId,
      baseRevision: fixture.app.readProject(fixture.projectId).revision.number,
      timelineItemId: fixture.actorItem.id
    });
    installProviderBridgeMock(output, runId, counters);
    assert.equal(await runOneJob(fixture.app, createMediaJobProcessor(fixture.app, new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1"))), true);
    return { job, counters };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Provider 两个带自然标点的 v4 字幕段在同一 Worker 提交中自动生成 derived 默认 Program 与两张字幕卡", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-source-caption-v4-"));
  const fixture = await prepareSourceCaptionFixture(root);
  try {
    const output = sourceCaptionAlignmentOutput([
      { displayText: "今天，我们一起看，", startMs: 0, endMs: 400, tokenStart: 0, tokenEnd: 4 },
      { displayText: "如何把视频剪得更精彩。", startMs: 430, endMs: 1_000, tokenStart: 4, tokenEnd: 9 }
    ]);
    const completed = await executeProviderCaptionAlignment(fixture, output, "provider-segment-default");
    assert.equal(fixture.app.trackJob(completed.job.id).status, "succeeded");
    assert.equal(completed.counters.creates, 1, "完整 A-roll 只能提交一个 Provider 段级 Run");

    const snapshot = fixture.app.readProject(fixture.projectId).snapshot;
    const alignment = snapshot.sourceAudioAlignments.find((candidate) => candidate.sourceTimelineItemId === fixture.actorItem.id);
    assert.ok(alignment, "必须保存同源 token 与 Provider 段级时间证据");
    assert.equal(alignment.tokenPrecision, "provider_token_timed");
    assert.ok(alignment.tokens);
    assert.deepEqual(
      alignment.tokens.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })),
      providerTokens(),
      "严格 token 证据必须原样可审计地保存"
    );
    assert.deepEqual(alignment.tokens.map((token) => token.index), providerTokens().map((_token, index) => index));
    assert.equal(alignment.segments.length, 2);
    assert.equal(alignment.sentences.length, 0, "v4 正式链不再把旧自动标点候选混入结果");
    assert.equal(alignment.sentenceCandidateMode, "none");

    const program = snapshot.sourceCaptionPrograms.find((candidate) => candidate.alignmentId === alignment.id);
    assert.ok(program, "无需剪辑任务手工提交 Program，Worker 必须自动生成默认 Program");
    assert.equal(program.source, "provider_segments", "自动生成的 Program 必须可与后续编辑覆盖区分");
    const captions = snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio");
    assert.equal(captions.length, 2);
    assert.deepEqual(captions.map((caption) => caption.text), ["今天，我们一起看，", "如何把视频剪得更精彩。"]);
    assert.deepEqual(captions.map((caption) => [caption.sourceTokenStartIndex, caption.sourceTokenEndIndex]), [[0, 4], [4, 9]]);
    assert.ok(captions.every((caption) => caption.precision === "source_token_anchored"));
    assert.ok(captions.every((caption) => caption.text === caption.sourceText && caption.textMode === "derived"), "Provider 自然标点不是人工改写");
    assert.ok(captions.every((caption) => caption.sourceCaptionProgramId === program.id && caption.sourceAlignmentId === alignment.id));
    assert.ok(!captions.some((caption) => caption.precision === "chunk_coarse"), "v4 正常路径不能遗留 VAD 粗字幕");
    assert.deepEqual(program.captionIds, captions.map((caption) => caption.id));
    assert.doesNotThrow(() => assertProjectGraphValid(snapshot));

    // 模拟 Revision 已写入、但 Job 成功回执丢失：重试必须读回同一外部 Run，不能二次 POST 或二次编译字幕。
    fixture.app.updateJob(completed.job.id, { status: "failed", error: "模拟成功回执丢失" });
    const retry = fixture.app.repository.createJob({
      projectId: fixture.projectId,
      kind: "source_caption_alignment",
      payload: { ...completed.job.payload, retryOfJobId: completed.job.id },
      idempotencyKey: "provider-segment-retry"
    });
    const originalFetch = globalThis.fetch;
    try {
      installProviderBridgeMock(output, "provider-segment-default", completed.counters);
      assert.equal(await runOneJob(fixture.app, createMediaJobProcessor(fixture.app, new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1"))), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fixture.app.trackJob(retry.id).status, "succeeded");
    assert.equal(completed.counters.creates, 1, "已记录外部 Run 的 retry 绝不能再次 POST");
    assert.ok(completed.counters.reads >= 2, "retry 必须重新读取已有 Run，而不是猜测已成功");
    const retried = fixture.app.readProject(fixture.projectId).snapshot;
    assert.equal(retried.sourceCaptionPrograms.length, 1);
    assert.equal(retried.sourceCaptionPrograms[0]?.id, program.id, "幂等恢复不能生成第二份默认 Program");
    assert.deepEqual(retried.timeline.captions.filter((caption) => caption.sourceKind === "source_audio").map((caption) => caption.id), program.captionIds);
  } finally {
    fixture.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Provider 无 token 证据的 v4 段仍自动生成 sentence_exact 默认字幕，但拒绝猜测重分段", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-source-caption-v4-token-unavailable-"));
  const fixture = await prepareSourceCaptionFixture(root);
  try {
    const output = sourceCaptionAlignmentOutput(
      providerSegmentsWithoutTokenEvidence(),
      { tokenPrecision: "unavailable", tokens: [] }
    );
    const completed = await executeProviderCaptionAlignment(fixture, output, "provider-segment-token-unavailable");
    assert.equal(fixture.app.trackJob(completed.job.id).status, "succeeded");
    assert.equal(completed.counters.creates, 1, "无 token 证据不能阻塞真实 Provider 段级字幕");

    const before = fixture.app.readProject(fixture.projectId);
    const alignment = before.snapshot.sourceAudioAlignments.find((candidate) => candidate.sourceTimelineItemId === fixture.actorItem.id);
    assert.ok(alignment, "仍必须保存同源 Provider 段级时间与 Bridge 审计");
    assert.equal(alignment.tokenPrecision, "unavailable");
    assert.equal(alignment.tokens, undefined, "无严格 token 证据时不能伪造空 token 对齐对象");
    assert.ok(alignment.segments.every((segment) => segment.tokenStartIndex === undefined && segment.tokenEndIndex === undefined));

    const program = before.snapshot.sourceCaptionPrograms.find((candidate) => candidate.alignmentId === alignment.id);
    assert.ok(program);
    assert.equal(program.source, "provider_segments");
    const captions = before.snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio");
    assert.equal(captions.length, 2, "每个 Provider segment 仍是一屏稳定字幕");
    assert.deepEqual(captions.map((caption) => caption.text), ["今天我们一起看", "如何把视频剪得更精彩。"]);
    assert.ok(captions.every((caption) => caption.precision === "sentence_exact"));
    assert.ok(captions.every((caption) => (
      caption.sourceAlignmentId === alignment.id
      && caption.sourceCaptionProgramId === program.id
      && caption.sourceTokenStartIndex === undefined
      && caption.sourceTokenEndIndex === undefined
    )));
    assert.ok(captions.every((caption, index) => index === 0 || captions[index - 1]!.endFrame <= caption.startFrame), "Provider 段不能重叠显示");
    assert.doesNotThrow(() => assertProjectGraphValid(before.snapshot));

    // 没有逐项 token 时间时，编辑覆盖不得用字符数或段时长猜出新的切点。
    assert.throws(
      () => fixture.app.applySourceCaptionProgram({
        projectId: fixture.projectId,
        baseRevision: before.revision.number,
        alignmentId: alignment.id,
        cards: [{
          tokenStartIndex: 0,
          tokenEndIndex: 1,
          rationale: "测试：无 token 证据时不得猜测新的字幕切点"
        }]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "SOURCE_CAPTION_PROGRAM_TOKEN_EVIDENCE_UNAVAILABLE"
    );
    const after = fixture.app.readProject(fixture.projectId);
    assert.equal(after.revision.number, before.revision.number, "失败的重分段不能留下半个 Revision");
    assert.equal(after.snapshot.sourceCaptionPrograms[0]?.id, program.id);
    assert.deepEqual(
      after.snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio").map((caption) => caption.id),
      captions.map((caption) => caption.id),
      "默认 Provider 字幕必须原样保留"
    );

    // Presenter 仍可能有语义段但没有 TTS；合法的 Provider 段级 Program 必须被质量门禁识别，
    // 不能因没有 token 而被误报为“缺字幕来源”。
    const transcribed = fixture.app.applyTranscript({
      projectId: fixture.projectId,
      baseRevision: after.revision.number,
      assetId: fixture.assetId,
      text: sourceCaptionTranscript,
      source: "manual"
    });
    const semantic = fixture.app.applySemanticUnits({
      projectId: fixture.projectId,
      baseRevision: transcribed.revision.number,
      units: transcribed.snapshot.transcriptSentenceCandidates.map((candidate) => ({
        candidateIds: [candidate.id],
        text: candidate.text,
        kind: "statement" as const,
        confidence: 0.9,
        pauseBefore: { durationMs: 0, reason: "sentence" as const }
      }))
    });
    assert.equal(
      evaluateQuality(semantic.snapshot, semantic.revision.number).issues.some((entry) => entry.code === "PRESENTER_CAPTION_SOURCE_REQUIRED"),
      false,
      "无 token 的完整 Provider 段级 Program 仍是 Presenter 的有效字幕事实源"
    );
  } finally {
    fixture.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Provider 段重叠、倒序或越界时失败且不写入半成品字幕 Revision", async () => {
  const valid = providerSegments();
  const invalidCases: Array<{ name: string; segments: ProviderSegment[] }> = [
    {
      name: "重叠",
      segments: [
        { displayText: "今天我们一起看如何", startMs: 0, endMs: 540, tokenStart: 0, tokenEnd: 5 },
        { ...valid[1]!, tokenStart: 4 }
      ]
    },
    {
      name: "倒序",
      segments: [valid[1]!, valid[0]!]
    },
    {
      name: "越界",
      segments: [valid[0]!, { ...valid[1]!, tokenEnd: 10 }]
    },
    {
      name: "只有标点的末段不能在图校验阶段才报错",
      segments: [...valid, { displayText: "。", startMs: 1_001, endMs: 1_100, tokenStart: 9, tokenEnd: 10 }]
    }
  ];
  for (const [index, invalid] of invalidCases.entries()) {
    const root = await mkdtemp(join(tmpdir(), "videocut-source-caption-v4-invalid-"));
    const fixture = await prepareSourceCaptionFixture(root);
    try {
      const completed = await executeProviderCaptionAlignment(
        fixture,
        sourceCaptionAlignmentOutput(invalid.segments),
        `provider-segment-invalid-${index}`
      );
      const failed = fixture.app.trackJob(completed.job.id);
      assert.equal(failed.status, "failed", invalid.name);
      assert.equal((failed.result?.diagnostic as { code?: string } | undefined)?.code, "SOURCE_CAPTION_SEGMENT_OUTPUT_INVALID", invalid.name);
      const current = fixture.app.readProject(fixture.projectId);
      assert.equal(current.revision.number, fixture.revision, invalid.name);
      assert.equal(current.snapshot.sourceAudioAlignments.length, 0, invalid.name);
      assert.equal(current.snapshot.sourceCaptionPrograms.length, 0, invalid.name);
      assert.equal(current.snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio").length, 0, invalid.name);
    } finally {
      fixture.app.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("剪辑任务的 editorial override 原子替换 Provider 默认 Program，不混留两套字幕", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-source-caption-v4-override-"));
  const fixture = await prepareSourceCaptionFixture(root);
  try {
    await executeProviderCaptionAlignment(fixture, sourceCaptionAlignmentOutput(), "provider-segment-override");
    const before = fixture.app.readProject(fixture.projectId);
    const alignment = before.snapshot.sourceAudioAlignments[0];
    const defaultProgram = before.snapshot.sourceCaptionPrograms[0];
    assert.ok(alignment);
    assert.ok(defaultProgram);
    const tokens = alignment.tokens;
    assert.ok(tokens && tokens.length > 0, "编辑重分段只允许使用已严格验证的 token 时间");
    const defaultCaptionIds = [...defaultProgram.captionIds];

    const overridden = fixture.app.applySourceCaptionProgram({
      projectId: fixture.projectId,
      baseRevision: before.revision.number,
      alignmentId: alignment.id,
      cards: [{
        tokenStartIndex: 0,
        tokenEndIndex: tokens.length,
        rationale: "经回听确认，本段应保持一张稳定字幕，避免默认两段切换打断画面动作"
      }]
    });
    const program = overridden.snapshot.sourceCaptionPrograms[0];
    const captions = overridden.snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio");
    assert.equal(overridden.snapshot.sourceCaptionPrograms.length, 1);
    assert.ok(program);
    assert.equal(program.source, "editorial_override");
    assert.notEqual(program.id, defaultProgram.id);
    assert.equal(captions.length, 1);
    assert.deepEqual(program.captionIds, captions.map((caption) => caption.id));
    assert.ok(!captions.some((caption) => defaultCaptionIds.includes(caption.id)), "提交后不能把默认卡和编辑覆盖卡混在同一 A-roll");
    assert.ok(!overridden.snapshot.sourceCaptionPrograms.some((candidate) => candidate.id === defaultProgram.id));
    assert.ok(overridden.revision.impact.stale.includes(defaultProgram.id));
    assert.ok(defaultCaptionIds.every((id) => overridden.revision.impact.stale.includes(id)));
    assert.doesNotThrow(() => assertProjectGraphValid(overridden.snapshot));
  } finally {
    fixture.app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("A-roll 映射改变会使 Provider 默认 Program 与字幕卡一起失效", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-source-caption-v4-stale-"));
  const fixture = await prepareSourceCaptionFixture(root);
  try {
    await executeProviderCaptionAlignment(fixture, sourceCaptionAlignmentOutput(), "provider-segment-stale");
    const before = fixture.app.readProject(fixture.projectId);
    const alignment = before.snapshot.sourceAudioAlignments[0];
    const program = before.snapshot.sourceCaptionPrograms[0];
    assert.ok(alignment);
    assert.ok(program);

    const changed = fixture.app.repository.commit(fixture.projectId, before.revision.number, "测试：移动 A-roll 使用", (snapshot) => {
      const item = snapshot.timeline.items.find((candidate) => candidate.id === fixture.actorItem.id);
      assert.ok(item);
      item.startFrame += 1;
      item.endFrame += 1;
    });
    assert.equal(changed.snapshot.sourceAudioAlignments.find((candidate) => candidate.id === alignment.id)?.status, "stale");
    assert.equal(changed.snapshot.sourceCaptionPrograms.length, 0);
    assert.equal(changed.snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio").length, 0);
    assert.ok(changed.revision.impact.stale.includes(alignment.id));
    assert.ok(changed.revision.impact.stale.includes(program.id));
    assert.doesNotThrow(() => assertProjectGraphValid(changed.snapshot));
  } finally {
    fixture.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
