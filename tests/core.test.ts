import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BridgeRunLostError, BridgeUnavailableError, ComfyUIBridgeClient, FUNASR_WORKFLOW_ID } from "@videocut/bridge";
import { AssetProviderRegistry, MockAssetProvider } from "@videocut/acquisition";
import { createApplication, RevisionConflictError, type EditingApplication } from "@videocut/application";
import { DomainError } from "@videocut/domain";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { runOneRenderJob } from "../apps/render-worker/src/index.js";
import { runExportJob } from "../apps/render-worker/src/exporter.js";
import { hashMediaFile } from "../packages/edit-application/src/media-intelligence.js";
import { createServer } from "../apps/server/src/app.js";
import { evaluateQuality } from "@videocut/quality";
import { runProcess } from "@videocut/speech";
import { compileCameraPunchLayout, compileCutawayLayout, compileMotionLayout, cutawaySourceVolume } from "@videocut/remotion";
import type { CaptionCard, EditorialReviewPass } from "@videocut/contracts";

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    assert.fail("MCP 应返回标准 content 结果");
  }
  const first = result.content[0];
  if (!first || typeof first !== "object" || !("type" in first) || first.type !== "text" || !("text" in first) || typeof first.text !== "string") {
    assert.fail("MCP 应返回文本内容");
  }
  return first.text;
}

async function createTestApplication(): Promise<{ root: string; app: EditingApplication; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "videocut-test-"));
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

/**
 * 核心 HTTP 合同只需要可分析的最小媒体，不应依赖完整的数字人口播素材库。
 * Fixture 在临时目录生成，CI 与本地都使用同一条 1 秒、64px、含静音音轨的确定性媒体。
 */
async function createDeterministicVideoFixture(directory: string): Promise<string> {
  const path = join(directory, "tiny-fixture.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=0x264653:s=64x64:r=24:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-shortest",
    "-c:v", "mpeg4", "-q:v", "5",
    "-c:a", "aac",
    "-movflags", "+faststart",
    path
  ]);
  return path;
}

function addReadyAsset(app: EditingApplication, projectId: string, name: string, kind: "video" | "audio" | "speech" = "video", durationMs = 1_000) {
  const initial = app.readProject(projectId);
  const imported = app.registerImportedAsset({
    projectId,
    baseRevision: initial.revision.number,
    name,
    kind,
    managedPath: `assets/source/${name}`,
    sourceHash: `${name}-hash`,
    provenance: {
      source: "local_import",
      acquiredAt: new Date().toISOString()
    }
  });
  app.applyMediaAnalysis({
    projectId,
    assetId: imported.asset.id,
    metadata: {
      durationMs,
      hasAudio: true,
      videoCodec: kind === "video" ? "h264" : undefined,
      audioCodec: "aac",
      sampleRate: kind === "video" ? undefined : 24_000,
      channels: kind === "video" ? undefined : 1,
      width: kind === "video" ? 720 : undefined,
      height: kind === "video" ? 1280 : undefined
    }
  });
  return imported.asset.id;
}

/** 测试模拟观察声明，真实文件用于验证服务端范围/哈希合同，不代表 AI 实际听过。 */
function fixtureObservations(previewJobId: string, endFrame: number) {
  return (["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"] as const).map((pass) => ({
    pass, previewJobId, startFrame: 0, endFrame,
    method: pass === "audio_only" ? "audio" as const : pass === "mute_visual" ? "continuous_video" as const : "audiovisual" as const,
    observation: "自动测试的观察声明，仅验证持久化合同"
  }));
}

/** 为需要经过 Render Preflight 的测试把确定性媒体放入该 Asset 的受管路径。 */
async function materializeFixtureForAsset(app: EditingApplication, projectId: string, assetId: string, fixturePath: string): Promise<void> {
  const state = app.readProject(projectId);
  const asset = state.snapshot.assets.find((candidate) => candidate.id === assetId);
  assert.ok(asset, "测试 Asset 必须存在");
  const targetPath = join(state.snapshot.project.rootPath, asset.managedPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(fixturePath, targetPath);
  const sourceHash = await hashMediaFile(targetPath);
  app.repository.commit(projectId, state.revision.number, "测试文件身份", snapshot => {
    snapshot.assets.find(candidate => candidate.id === assetId)!.sourceHash = sourceHash;
  });
}

/** 测试显式模拟 semantic-continuity：标点候选本身不会自动变成 SemanticUnit。 */
function applySemanticUnitsFromCandidates(app: EditingApplication, projectId: string) {
  const before = app.readProject(projectId);
  return app.applySemanticUnits({
    projectId,
    baseRevision: before.revision.number,
    units: [...before.snapshot.transcriptSentenceCandidates]
      .sort((left, right) => left.order - right.order)
      .map((candidate) => ({
        candidateIds: [candidate.id],
        text: candidate.text,
        kind: "statement" as const,
        confidence: 0.9,
        pauseBefore: { durationMs: 0, reason: "sentence" as const }
      }))
  });
}

test("过期 Revision 和失败写入不会污染项目快照", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Revision 测试" });
    const assetId = addReadyAsset(context.app, created.snapshot.project.id, "clip-a.mp4");
    const current = context.app.readProject(created.snapshot.project.id);

    assert.throws(
      () => context.app.createScene({
        projectId: created.snapshot.project.id,
        baseRevision: created.revision.number,
        type: "PresenterScene",
        title: "过期场景",
        purpose: "验证冲突",
        startFrame: 0,
        endFrame: 24,
        assetIds: [assetId]
      }),
      RevisionConflictError
    );
    assert.equal(context.app.readProject(created.snapshot.project.id).revision.number, current.revision.number);

    assert.throws(
      () => context.app.createEffectCue({
        projectId: created.snapshot.project.id,
        baseRevision: current.revision.number,
        sceneId: "missing-scene",
        type: "MetricBackdrop",
        layer: "rear",
        startFrame: 0,
        endFrame: 24
      }),
      (error: unknown) => error instanceof DomainError && error.code === "SCENE_NOT_FOUND"
    );
    const afterFailure = context.app.readProject(created.snapshot.project.id);
    assert.equal(afterFailure.revision.number, current.revision.number);
    assert.equal(afterFailure.snapshot.effectCues.length, 0);
  } finally {
    await context.dispose();
  }
});

test("同轨重叠会原子回滚，保留原有 Presenter 主线", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "时间线测试" });
    const first = addReadyAsset(context.app, created.snapshot.project.id, "first.mp4");
    const second = addReadyAsset(context.app, created.snapshot.project.id, "second.mp4");
    const beforeBuild = context.app.readProject(created.snapshot.project.id);
    context.app.buildPresenterTimeline({ projectId: created.snapshot.project.id, baseRevision: beforeBuild.revision.number, assetIds: [first, second], sceneSize: 1 });
    const beforeMove = context.app.readProject(created.snapshot.project.id);
    const actorTrack = beforeMove.snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll")!;
    const actorItems = beforeMove.snapshot.timeline.items.filter((item) => item.trackId === actorTrack.id).sort((left, right) => left.startFrame - right.startFrame);

    assert.throws(
      () => context.app.moveItem({
        projectId: created.snapshot.project.id,
        baseRevision: beforeMove.revision.number,
        itemId: actorItems[1]!.id,
        startFrame: actorItems[0]!.startFrame,
        ripple: false
      }),
      (error: unknown) => error instanceof DomainError && error.code === "TRACK_OVERLAP"
    );
    const afterMove = context.app.readProject(created.snapshot.project.id);
    assert.equal(afterMove.revision.number, beforeMove.revision.number);
    assert.deepEqual(afterMove.snapshot.timeline.items, beforeMove.snapshot.timeline.items);
  } finally {
    await context.dispose();
  }
});

test("局部 Script 修改只保留未受影响的 SpeechSegment", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Script 测试" });
    const audioAsset = addReadyAsset(context.app, created.snapshot.project.id, "voice.wav", "audio");
    context.app.applyTranscript({ projectId: created.snapshot.project.id, assetId: audioAsset, text: "第一句完整表达。第二句会删除。第三句需要保留。", source: "manual" });
    const pending = context.app.readProject(created.snapshot.project.id);
    assert.equal(pending.snapshot.semanticUnits.length, 0, "标点候选不能自动冒充语义单元");
    applySemanticUnitsFromCandidates(context.app, created.snapshot.project.id);
    const before = context.app.readProject(created.snapshot.project.id);
    const units = [...before.snapshot.semanticUnits].sort((left, right) => left.order - right.order);
    const segments = [...before.snapshot.speechSegments].sort((left, right) => left.order - right.order);

    context.app.applyScript({
      projectId: created.snapshot.project.id,
      baseRevision: before.revision.number,
      semanticUnitIds: [units[0]!.id, units[2]!.id]
    });
    const after = context.app.readProject(created.snapshot.project.id);
    assert.deepEqual(after.snapshot.script.semanticUnitIds, [units[0]!.id, units[2]!.id]);
    assert.deepEqual(after.snapshot.speechSegments.map((segment) => segment.id), [segments[0]!.id, segments[2]!.id]);
    assert.ok(after.revision.impact.stale.includes(segments[1]!.id));
  } finally {
    await context.dispose();
  }
});

test("人工校正转写遵守明确 baseRevision，不会覆盖并发编辑", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "人工转写 Revision 测试" });
    const audioAsset = addReadyAsset(context.app, created.snapshot.project.id, "manual.wav", "audio");
    const current = context.app.readProject(created.snapshot.project.id);
    assert.throws(
      () => context.app.applyTranscript({ projectId: created.snapshot.project.id, baseRevision: created.revision.number, assetId: audioAsset, text: "这是一句人工校正转写。", source: "manual" }),
      RevisionConflictError
    );
    const applied = context.app.applyTranscript({ projectId: created.snapshot.project.id, baseRevision: current.revision.number, assetId: audioAsset, text: "这是一句人工校正转写。", source: "manual" });
    assert.equal(applied.snapshot.transcripts[0]?.source, "manual");
  } finally {
    await context.dispose();
  }
});

test("SpeechAsset 写入 Dialogue 轨并在 Script 改动后移除旧旁白和字幕", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "旁白时间线测试" });
    const referenceAssetId = addReadyAsset(context.app, created.snapshot.project.id, "reference.wav", "audio");
    const registeredReference = context.app.registerVoiceReference({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      assetId: referenceAssetId,
    });
    const voiceReferenceId = registeredReference.snapshot.voiceReferences[0]!.id;
    context.app.applyTranscript({ projectId: created.snapshot.project.id, assetId: referenceAssetId, text: "第一句。第二句。", source: "manual" });
    applySemanticUnitsFromCandidates(context.app, created.snapshot.project.id);
    const beforeAssembly = context.app.readProject(created.snapshot.project.id);
    const speechFileAssetId = addReadyAsset(context.app, created.snapshot.project.id, "speech.wav", "speech");
    const segments = [...beforeAssembly.snapshot.speechSegments].sort((left, right) => left.order - right.order);
    const segmentAssets = segments.map((segment, index) => ({
      id: `speech_segment_asset_test_${index}`,
      speechSegmentId: segment.id,
      voiceReferenceAssetId: referenceAssetId,
      assetId: speechFileAssetId,
      durationMs: 500,
      bridgeRunId: `run-${index}`,
      schemaVersion: "v1",
      quality: "passed" as const
    }));
    context.app.applySpeechAssembly({
      projectId: created.snapshot.project.id,
      generatedAssets: [],
      segmentAssets,
      speechAsset: {
        id: "speech_asset_test",
        assetId: speechFileAssetId,
        scriptRevision: beforeAssembly.snapshot.script.revision,
        segmentAssetIds: segmentAssets.map((segmentAsset) => segmentAsset.id),
        timing: {
          precision: "segment_exact",
          source: "测试用真实段级边界",
          segments: [
            { speechSegmentId: segments[0]!.id, startMs: 0, endMs: 500, startFrame: 0, endFrame: 12 },
            { speechSegmentId: segments[1]!.id, startMs: 500, endMs: 1_000, startFrame: 12, endFrame: 24 }
          ]
        },
        status: "ready"
      }
    });
    const assembled = context.app.readProject(created.snapshot.project.id);
    const dialogueTrack = assembled.snapshot.timeline.tracks.find((track) => track.name === "Dialogue")!;
    assert.equal(assembled.snapshot.timeline.items.filter((item) => item.trackId === dialogueTrack.id && item.assetId === speechFileAssetId).length, 1);
    assert.equal(assembled.snapshot.timeline.captions.length, 2);
    assert.ok(assembled.snapshot.timeline.captions.every((caption) => caption.style === "stable" && caption.precision === "segment_exact"));

    // 模拟旧版本只保存 SpeechAsset、没有实际 Dialogue Item 的历史快照。
    const legacy = context.app.repository.commit(created.snapshot.project.id, assembled.revision.number, "模拟旧旁白快照", (snapshot) => {
      // 本段继续覆盖旧项目单卡格式，不改变新项目默认统一字幕的测试输入。
      delete snapshot.timeline.captionFormat;
      snapshot.timeline.items = snapshot.timeline.items.filter((item) => item.trackId !== dialogueTrack.id);
      snapshot.timeline.captions = [];
    });
    const repaired = context.app.rebuildSpeechAssetTimeline({ projectId: created.snapshot.project.id, baseRevision: legacy.revision.number });
    assert.equal(repaired.snapshot.timeline.items.filter((item) => item.trackId === dialogueTrack.id && item.assetId === speechFileAssetId).length, 1);
    assert.equal(repaired.snapshot.timeline.captions.length, 2);

    const originalCaption = repaired.snapshot.timeline.captions[0]!;
    const editedCaptionState = context.app.editCaptions({
      projectId: created.snapshot.project.id,
      baseRevision: repaired.revision.number,
      captionId: originalCaption.id,
      action: "update",
      text: "第一句\n请注意",
      format: { fontSize: 38, bottomPercent: 10, backgroundColor: "#101820" },
      emphasis: { text: "请注意", occurrence: 0, color: "#ffd166", fontWeight: 850, scale: 1.05 }
    });
    const editedCaption = editedCaptionState.snapshot.timeline.captions.find((caption) => caption.id === originalCaption.id)!;
    assert.equal(editedCaption.sourceText, segments[0]!.text);
    assert.equal(editedCaption.textMode, "manual");
    assert.equal(editedCaption.text, "第一句\n请注意");
    assert.equal(editedCaption.format?.fontSize, 38);
    assert.equal(editedCaption.format?.bottomPercent, 10);
    assert.equal(editedCaption.emphasis?.text, "请注意");
    assert.deepEqual(editedCaptionState.snapshot.script, repaired.snapshot.script, "编辑字幕不得改 Script");
    assert.deepEqual(editedCaptionState.snapshot.speechAsset, repaired.snapshot.speechAsset, "编辑字幕不得改 SpeechAsset");
    assert.ok(editedCaptionState.revision.impact.changed.includes(originalCaption.id));
    assert.ok(editedCaptionState.revision.impact.dirtyRanges.some((range) => range.startFrame === originalCaption.startFrame && range.endFrame === originalCaption.endFrame));

    assert.throws(
      () => context.app.editCaptions({ projectId: created.snapshot.project.id, baseRevision: editedCaptionState.revision.number, captionId: originalCaption.id, action: "update", text: "第一行\n第二行\n第三行" }),
      (error: unknown) => error instanceof DomainError && error.code === "CAPTION_TOO_MANY_LINES"
    );
    assert.throws(
      () => context.app.editCaptions({ projectId: created.snapshot.project.id, baseRevision: editedCaptionState.revision.number, captionId: originalCaption.id, action: "update", format: { color: "#fff" } }),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_CAPTION_COLOR"
    );
    assert.throws(
      () => context.app.editCaptions({ projectId: created.snapshot.project.id, baseRevision: editedCaptionState.revision.number, captionId: originalCaption.id, action: "update", emphasis: { text: "不存在", occurrence: 0 } }),
      (error: unknown) => error instanceof DomainError && error.code === "CAPTION_EMPHASIS_NOT_FOUND"
    );
    assert.equal(context.app.readProject(created.snapshot.project.id).revision.number, editedCaptionState.revision.number, "无效字幕编辑必须原子回滚");

    const rebuiltAfterCaptionEdit = context.app.rebuildSpeechAssetTimeline({ projectId: created.snapshot.project.id, baseRevision: editedCaptionState.revision.number });
    const preservedCaption = rebuiltAfterCaptionEdit.snapshot.timeline.captions.find((caption) => caption.id === originalCaption.id)!;
    assert.equal(preservedCaption.text, "第一句\n请注意", "同一语音段重建时应保留手工屏幕文案");
    assert.equal(preservedCaption.format?.fontSize, 38);
    assert.equal(preservedCaption.emphasis?.text, "请注意");

    context.app.applyScript({
      projectId: created.snapshot.project.id,
      baseRevision: rebuiltAfterCaptionEdit.revision.number,
      semanticUnitIds: [rebuiltAfterCaptionEdit.snapshot.semanticUnits[0]!.id]
    });
    const afterScript = context.app.readProject(created.snapshot.project.id);
    assert.equal(afterScript.snapshot.speechAsset, undefined);
    assert.equal(afterScript.snapshot.timeline.captions.length, 0);
    assert.equal(afterScript.snapshot.timeline.items.some((item) => item.trackId === dialogueTrack.id && item.assetId === speechFileAssetId), false);
    assert.equal(afterScript.snapshot.speechSegments.length, 1);
    assert.equal(afterScript.snapshot.speechSegments[0]!.status, "ready");
    assert.equal(afterScript.snapshot.speechSegmentAssets.length, 1);
    assert.ok(afterScript.revision.impact.stale.includes(originalCaption.id), "主线改动必须明确标记旧字幕失效");
    const reassemblyJob = context.app.submitVoiceSynthesis({ projectId: created.snapshot.project.id, voiceReferenceId });
    assert.deepEqual(reassemblyJob.payload.speechSegmentIds, []);
  } finally {
    await context.dispose();
  }
});

test("旧项目 HTTP 字幕编辑只修改 Caption Card，并校验有限样式输入", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-caption-http-test-"));
  const { app: server, application } = await createServer({ workspaceRoot });
  try {
    const created = application.createProject({ name: "HTTP 字幕编辑测试" });
    const projectId = created.snapshot.project.id;
    application.repository.commit(projectId, created.revision.number, "模拟旧项目局部字幕样式", (snapshot) => {
      delete snapshot.timeline.captionFormat;
    });
    const referenceAssetId = addReadyAsset(application, projectId, "caption-reference.wav", "audio");
    application.applyTranscript({ projectId, assetId: referenceAssetId, text: "这是一句完整的字幕测试。", source: "manual" });
    applySemanticUnitsFromCandidates(application, projectId);
    const beforeSpeech = application.readProject(projectId);
    const speechFileAssetId = addReadyAsset(application, projectId, "caption-speech.wav", "speech");
    const segments = beforeSpeech.snapshot.speechSegments;
    const segmentAssets = segments.map((segment, index) => ({
      id: `caption_http_segment_${index}`,
      speechSegmentId: segment.id,
      voiceReferenceAssetId: referenceAssetId,
      assetId: speechFileAssetId,
      durationMs: 1_000,
      bridgeRunId: `caption-http-run-${index}`,
      schemaVersion: "v1",
      quality: "passed" as const
    }));
    const assembled = application.applySpeechAssembly({
      projectId,
      generatedAssets: [],
      segmentAssets,
      speechAsset: {
        id: "caption_http_speech_asset",
        assetId: speechFileAssetId,
        scriptRevision: beforeSpeech.snapshot.script.revision,
        segmentAssetIds: segmentAssets.map((entry) => entry.id),
        timing: {
          precision: "segment_exact",
          source: "HTTP 测试段级边界",
          segments: segments.map((segment, index) => ({ speechSegmentId: segment.id, startMs: index * 1_000, endMs: (index + 1) * 1_000, startFrame: index * 24, endFrame: (index + 1) * 24 }))
        },
        status: "ready"
      }
    });
    const caption = assembled.snapshot.timeline.captions[0]!;
    const editedResponse = await server.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/captions/${caption.id}`,
      payload: {
        baseRevision: assembled.revision.number,
        action: "update",
        text: "这是一句\n屏幕字幕测试",
        format: { fontSize: 36, bottomPercent: 9, backgroundColor: "#101820", backgroundOpacity: 0.68 },
        emphasis: { text: "屏幕", occurrence: 0, color: "#ffd166", scale: 1.05 }
      }
    });
    assert.equal(editedResponse.statusCode, 200);
    const edited = editedResponse.json() as { snapshot: { timeline: { captions: CaptionCard[] }; script: unknown; speechAsset: unknown } };
    assert.equal(edited.snapshot.timeline.captions[0]?.textMode, "manual");
    assert.equal(edited.snapshot.timeline.captions[0]?.format?.fontSize, 36);
    assert.equal(edited.snapshot.timeline.captions[0]?.format?.backgroundOpacity, 0.68);
    assert.equal(edited.snapshot.timeline.captions[0]?.emphasis?.text, "屏幕");
    assert.deepEqual(edited.snapshot.script, assembled.snapshot.script);
    assert.deepEqual(edited.snapshot.speechAsset, assembled.snapshot.speechAsset);

    const invalidResponse = await server.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/captions/${caption.id}`,
      payload: { baseRevision: (editedResponse.json() as { revision: { number: number } }).revision.number, action: "update", format: { color: "#fff" } }
    });
    assert.equal(invalidResponse.statusCode, 400);
  } finally {
    await server.close();
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("BGM 与 SFX 通过 AudioCue 绑定专用轨，主线变化会停止旧声音包装", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "声音包装对象与失效传播测试" });
    const projectId = created.snapshot.project.id;
    const presenterAssetId = addReadyAsset(context.app, projectId, "audio-presenter.mp4", "video", 4_000);
    context.app.buildPresenterTimeline({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      assetIds: [presenterAssetId],
      sceneSize: 1
    });
    const bgmAssetId = addReadyAsset(context.app, projectId, "audio-bgm.wav", "audio", 1_000);
    const sfxAssetId = addReadyAsset(context.app, projectId, "audio-sfx.wav", "audio", 1_000);

    const withBgm = context.app.manageAudio({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      action: "create",
      kind: "bgm",
      assetId: bgmAssetId,
      purpose: "为完整人物口播提供克制的结构性音乐",
      loop: true,
      gainDb: -16,
      fadeInFrames: 6,
      fadeOutFrames: 12,
      ducking: { reductionDb: -12 }
    });
    const bgmCue = withBgm.snapshot.audioCues.find((cue) => cue.kind === "bgm")!;
    const bgmItem = withBgm.snapshot.timeline.items.find((item) => item.id === bgmCue.timelineItemId)!;
    const bgmTrack = withBgm.snapshot.timeline.tracks.find((track) => track.id === bgmItem.trackId)!;
    assert.equal(bgmTrack.name, "BGM");
    assert.equal(bgmCue.anchor, "sequence_global");
    assert.equal(bgmCue.loop, true);
    assert.deepEqual(bgmCue.ducking, { enabled: true, reductionDb: -12, attackFrames: 4, releaseFrames: 14 }, "稀疏 Duck 更新应保留当前阶段的安全默认值");
    assert.equal(bgmItem.startFrame, 0);
    assert.equal(bgmItem.endFrame, 96, "BGM 的目标范围应遵从主线时长，而不是把 1 秒素材当作整片长度");

    assert.throws(
      () => context.app.manageAudio({
        projectId,
        baseRevision: withBgm.revision.number,
        action: "create",
        kind: "sfx",
        assetId: sfxAssetId,
        purpose: "没有事件锚点的音效"
      }),
      (error: unknown) => error instanceof DomainError && error.code === "SFX_EVENT_REQUIRED"
    );
    assert.equal(context.app.readProject(projectId).revision.number, withBgm.revision.number, "无锚点 SFX 必须原子回滚");

    const withSfx = context.app.manageAudio({
      projectId,
      baseRevision: withBgm.revision.number,
      action: "create",
      kind: "sfx",
      assetId: sfxAssetId,
      purpose: "数字落定时提供一次轻提示",
      eventFrame: 36,
      onsetOffsetFrames: 4,
      gainDb: -8
    });
    const sfxCue = withSfx.snapshot.audioCues.find((cue) => cue.kind === "sfx")!;
    const sfxItem = withSfx.snapshot.timeline.items.find((item) => item.id === sfxCue.timelineItemId)!;
    const sfxTrack = withSfx.snapshot.timeline.tracks.find((track) => track.id === sfxItem.trackId)!;
    assert.equal(sfxTrack.name, "SFX");
    assert.equal(sfxCue.anchor, "media_event");
    assert.equal(sfxCue.eventFrame, 36);
    assert.equal(sfxCue.onsetOffsetFrames, 4);
    assert.equal(sfxItem.startFrame, 32);
    assert.equal(sfxCue.eventFrame, sfxItem.startFrame + sfxCue.onsetOffsetFrames);
    assert.ok(evaluateQuality(withSfx.snapshot, withSfx.revision.number).issues.some((entry) => entry.code === "AUDIO_ONLY_PREVIEW_REQUIRED"));

    assert.throws(
      () => context.app.moveItem({
        projectId,
        baseRevision: withSfx.revision.number,
        itemId: bgmItem.id,
        startFrame: 1
      }),
      (error: unknown) => error instanceof DomainError && error.code === "MANAGED_AUDIO_ITEM_DIRECT_MOVE"
    );
    assert.equal(context.app.readProject(projectId).revision.number, withSfx.revision.number, "直接移动受管声音不得产生半成品 Revision");

    const actorTrack = withSfx.snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll")!;
    const actorItem = withSfx.snapshot.timeline.items.find((item) => item.trackId === actorTrack.id && !item.disabled)!;
    const afterMainlineMove = context.app.moveItem({
      projectId,
      baseRevision: withSfx.revision.number,
      itemId: actorItem.id,
      startFrame: 1
    });
    for (const cue of afterMainlineMove.snapshot.audioCues) {
      const item = afterMainlineMove.snapshot.timeline.items.find((candidate) => candidate.id === cue.timelineItemId)!;
      assert.equal(cue.status, "stale");
      assert.equal(item.disabled, true);
      assert.ok(afterMainlineMove.revision.impact.stale.includes(cue.id));
    }

    const recheckedBgm = context.app.manageAudio({
      projectId,
      baseRevision: afterMainlineMove.revision.number,
      action: "update",
      audioCueId: bgmCue.id,
      gainDb: -18
    });
    const refreshedCue = recheckedBgm.snapshot.audioCues.find((cue) => cue.id === bgmCue.id)!;
    const refreshedItem = recheckedBgm.snapshot.timeline.items.find((item) => item.id === refreshedCue.timelineItemId)!;
    assert.equal(refreshedCue.status, "ready", "显式 update 才能重新启用已经 stale 的 BGM");
    assert.equal(refreshedItem.disabled, false);
    assert.equal(recheckedBgm.snapshot.audioCues.find((cue) => cue.id === sfxCue.id)?.status, "stale", "未复核的 SFX 仍应保持停止状态");
  } finally {
    await context.dispose();
  }
});

test("HTTP 声音包装建立 AudioCue，并拒绝缺少 SFX 事件的请求", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-audio-http-test-"));
  const { app: server, application } = await createServer({ workspaceRoot });
  try {
    const created = application.createProject({ name: "HTTP 声音包装测试" });
    const projectId = created.snapshot.project.id;
    const presenterAssetId = addReadyAsset(application, projectId, "http-audio-presenter.mp4", "video", 2_000);
    application.buildPresenterTimeline({
      projectId,
      baseRevision: application.readProject(projectId).revision.number,
      assetIds: [presenterAssetId],
      sceneSize: 1
    });
    const bgmAssetId = addReadyAsset(application, projectId, "http-audio-bgm.wav", "audio", 1_000);
    const sfxAssetId = addReadyAsset(application, projectId, "http-audio-sfx.wav", "audio", 1_000);
    const ready = application.readProject(projectId);

    const createdResponse = await server.inject({
      method: "POST",
      url: `/api/projects/${projectId}/audio`,
      payload: {
        baseRevision: ready.revision.number,
        action: "create",
        kind: "bgm",
        assetId: bgmAssetId,
        purpose: "HTTP 写入的背景音乐",
        loop: true,
        ducking: { enabled: true, reductionDb: -10, attackFrames: 3, releaseFrames: 9 }
      }
    });
    assert.equal(createdResponse.statusCode, 200);
    const createdState = createdResponse.json() as { revision: { number: number }; snapshot: { audioCues: Array<{ kind: string; purpose: string }> } };
    assert.equal(createdState.snapshot.audioCues[0]?.kind, "bgm");
    assert.equal(createdState.snapshot.audioCues[0]?.purpose, "HTTP 写入的背景音乐");

    const invalidResponse = await server.inject({
      method: "POST",
      url: `/api/projects/${projectId}/audio`,
      payload: {
        baseRevision: createdState.revision.number,
        action: "create",
        kind: "sfx",
        assetId: sfxAssetId,
        purpose: "没有事件锚点的 HTTP 音效"
      }
    });
    assert.equal(invalidResponse.statusCode, 400);
  } finally {
    await server.close();
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Presenter 有语义段但没有语音与稳定字幕时不能交付", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Presenter 字幕门禁", profile: "presenter_motion" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video");
    const transcriptAssetId = addReadyAsset(context.app, created.snapshot.project.id, "source.wav", "audio");
    context.app.buildPresenterTimeline({ projectId: created.snapshot.project.id, baseRevision: context.app.readProject(created.snapshot.project.id).revision.number, assetIds: [videoAssetId] });
    context.app.applyTranscript({ projectId: created.snapshot.project.id, assetId: transcriptAssetId, text: "这是可理解的完整表达。", source: "manual" });
    const semantic = applySemanticUnitsFromCandidates(context.app, created.snapshot.project.id);
    const quality = evaluateQuality(semantic.snapshot, semantic.revision.number);
    assert.ok(quality.issues.some((entry) => entry.code === "PRESENTER_CAPTION_SOURCE_REQUIRED" && entry.level === "blocking"));
  } finally {
    await context.dispose();
  }
});

test("Bridge 在 schemaVersion 409 后读取最新工作流并重试", async () => {
  const originalFetch = globalThis.fetch;
  let detailCalls = 0;
  let runCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/workflows/test-workflow")) {
      detailCalls += 1;
      return new Response(JSON.stringify({
        id: "test-workflow",
        name: "测试工作流",
        available: true,
        schemaVersion: detailCalls === 1 ? "v1" : "v2",
        fields: [{ id: "prompt", label: "文本", kind: "text", required: true }],
        itemSlots: [],
        outputs: []
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/workflows/test-workflow/runs")) {
      runCalls += 1;
      const request = JSON.parse(String(init?.body));
      if (runCalls === 1) return new Response(JSON.stringify({ error: "schemaVersion 过期" }), { status: 409, headers: { "content-type": "application/json" } });
      assert.equal(request.schemaVersion, "v2");
      return new Response(JSON.stringify({ id: "run-2", status: "queued", outputs: [] }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`未预期的请求：${url}`);
  };
  try {
    const client = new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1");
    const result = await client.createRunWithSchemaRetry("test-workflow", async (workflow) => ({ fieldValues: { prompt: workflow.schemaVersion } }));
    assert.equal(result.workflow.schemaVersion, "v2");
    assert.equal(result.run.id, "run-2");
    assert.equal(detailCalls, 2);
    assert.equal(runCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bridge 在读取 Workflow 时等待短暂的网络未就绪，但不会重放 Run 创建", async () => {
  const originalFetch = globalThis.fetch;
  let workflowCalls = 0;
  let healthCalls = 0;
  let runCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/workflows/recovering-workflow")) {
      workflowCalls += 1;
      if (workflowCalls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({
        id: "recovering-workflow",
        name: "恢复中的测试工作流",
        available: true,
        schemaVersion: "v1",
        fields: [],
        itemSlots: [],
        outputs: []
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/health")) {
      healthCalls += 1;
      return new Response(JSON.stringify({ status: "ready" }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/workflows/recovering-workflow/runs")) {
      runCalls += 1;
      return new Response(JSON.stringify({ id: "run-once", status: "queued", outputs: [] }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`未预期的请求：${url}`);
  };
  try {
    const client = new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1", {
      readinessTimeoutMs: 50,
      readinessPollIntervalMs: 1
    });
    const result = await client.createRunWithSchemaRetry("recovering-workflow", async () => ({ fieldValues: {} }));
    assert.equal(result.run.id, "run-once");
    assert.equal(workflowCalls, 2, "仅重读尚未产生副作用的 Workflow Schema");
    assert.equal(healthCalls, 1);
    assert.equal(runCalls, 1, "Bridge Run 创建请求不能因网络恢复而自动重放");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bridge 网络不可达会保留安全且可行动的诊断", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    const client = new ComfyUIBridgeClient("http://user:secret@bridge.test/comfyui-bridge/v1");
    await assert.rejects(
      () => client.health(),
      (error: unknown) => error instanceof BridgeUnavailableError
        && error.code === "BRIDGE_UNAVAILABLE"
        && error.message.includes("http://bridge.test/comfyui-bridge/v1/health")
        && !error.message.includes("secret")
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Bridge run_id 丢失会保留明确的可诊断错误", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "run not found" }), { status: 404, headers: { "content-type": "application/json" } });
  try {
    const client = new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1");
    await assert.rejects(
      () => client.waitForRun("lost-run", { timeoutMs: 1, intervalMs: 1 }),
      (error: unknown) => error instanceof BridgeRunLostError && error.code === "BRIDGE_RUN_LOST" && error.runId === "lost-run"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("失败 Job 保留 Bridge run、请求摘要与输出缺失诊断", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Bridge 失败诊断测试" });
    const job = context.app.repository.createJob({
      projectId: created.snapshot.project.id,
      kind: "transcription",
      payload: { workflowId: "funasr" },
      idempotencyKey: "bridge-diagnostic-test"
    });
    await runOneJob(context.app, async (claimed) => {
      context.app.recordBridgeRun(claimed.id, {
        workflowId: "funasr",
        runId: "run-missing-output",
        schemaVersion: "v3",
        schemaRetryCount: 1,
        submittedAt: new Date().toISOString(),
        request: { fieldValues: {}, fileSlots: [{ id: "audio", kind: "audio", fileName: "source.wav" }] }
      });
      throw new DomainError("FunASR 已完成，但没有返回文本输出", "MISSING_TRANSCRIPT_OUTPUT");
    });
    const failed = context.app.trackJob(job.id);
    assert.equal(failed.status, "failed");
    const bridgeRuns = failed.result?.bridgeRuns as Array<{ runId: string }> | undefined;
    const diagnostic = failed.result?.diagnostic as { code?: string; message?: string } | undefined;
    assert.equal(bridgeRuns?.[0]?.runId, "run-missing-output");
    assert.equal(diagnostic?.code, "MISSING_TRANSCRIPT_OUTPUT");
    assert.match(diagnostic?.message ?? "", /没有返回文本输出/u);
  } finally {
    await context.dispose();
  }
});

test("媒体 Worker 与 Render Worker 只领取各自的任务", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Worker 隔离测试" });
    const exportJob = context.app.submitExport({ projectId: created.snapshot.project.id });
    assert.equal(await runOneJob(context.app, async () => ({ unexpected: true })), false);
    assert.equal(context.app.trackJob(exportJob.id).status, "queued");
    assert.equal(await runOneRenderJob(context.app, async (job) => ({ processedKind: job.kind })), true);
    assert.deepEqual(context.app.trackJob(exportJob.id).result, { processedKind: "export" });
  } finally {
    await context.dispose();
  }
});

test("质量门禁会在渲染前拒绝空时间线导出", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "导出门禁测试" });
    const exportJob = context.app.submitExport({ projectId: created.snapshot.project.id });
    await assert.rejects(
      () => runExportJob(context.app, exportJob, { render: async () => assert.fail("质量门禁不应进入渲染") } as never),
      (error: unknown) => error instanceof DomainError && error.code === "QUALITY_GATE_BLOCKED"
    );
  } finally {
    await context.dispose();
  }
});

test("质量门禁会阻止旁白只覆盖首段、主画面却继续播放", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "口播长度一致性测试" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 10_000);
    const referenceAssetId = addReadyAsset(context.app, created.snapshot.project.id, "reference.wav", "audio", 1_000);
    const built = context.app.buildPresenterTimeline({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      assetIds: [videoAssetId],
      sceneSize: 1
    });
    context.app.applyTranscript({ projectId: created.snapshot.project.id, assetId: referenceAssetId, text: "只有这一句旁白。", source: "manual" });
    applySemanticUnitsFromCandidates(context.app, created.snapshot.project.id);
    const segments = context.app.readProject(created.snapshot.project.id).snapshot.speechSegments;
    const speechFileAssetId = addReadyAsset(context.app, created.snapshot.project.id, "short-speech.wav", "speech", 1_000);
    context.app.applySpeechAssembly({
      projectId: created.snapshot.project.id,
      generatedAssets: [],
      segmentAssets: [{
        id: "short_segment_asset",
        speechSegmentId: segments[0]!.id,
        voiceReferenceAssetId: referenceAssetId,
        assetId: speechFileAssetId,
        durationMs: 1_000,
        bridgeRunId: "run-short",
        schemaVersion: "v1",
        quality: "passed"
      }],
      speechAsset: {
        id: "short_speech_asset",
        assetId: speechFileAssetId,
        scriptRevision: context.app.readProject(created.snapshot.project.id).snapshot.script.revision,
        segmentAssetIds: ["short_segment_asset"],
        timing: {
          precision: "segment_exact",
          source: "测试段级时序",
          segments: [{ speechSegmentId: segments[0]!.id, startMs: 0, endMs: 1_000, startFrame: 0, endFrame: 24 }]
        },
        status: "ready"
      }
    });
    const state = context.app.readProject(created.snapshot.project.id);
    const report = evaluateQuality(state.snapshot, state.revision.number);
    assert.ok(report.issues.some((entry) => entry.level === "blocking" && entry.code === "PRESENTER_SPEECH_VISUAL_DURATION_MISMATCH"));
    assert.ok(built.snapshot.timeline.durationInFrames > 0);

    const aligned = context.app.alignPresenterToSpeech({ projectId: created.snapshot.project.id, baseRevision: state.revision.number });
    const actorTrack = aligned.snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll")!;
    const dialogueTrack = aligned.snapshot.timeline.tracks.find((track) => track.name === "Dialogue")!;
    const actorEnd = aligned.snapshot.timeline.items.filter((item) => item.trackId === actorTrack.id).reduce((latest, item) => Math.max(latest, item.endFrame), 0);
    const dialogueEnd = aligned.snapshot.timeline.items.find((item) => item.trackId === dialogueTrack.id && item.assetId === speechFileAssetId)?.endFrame;
    assert.equal(actorEnd, dialogueEnd);
    const alignedReport = evaluateQuality(aligned.snapshot, aligned.revision.number);
    assert.equal(alignedReport.issues.some((entry) => entry.code === "PRESENTER_SPEECH_VISUAL_DURATION_MISMATCH"), false);
  } finally {
    await context.dispose();
  }
});

test("人物音频所有权阻止原声与 Dialogue 重复播放", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "音频所有权测试" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    const referenceAssetId = addReadyAsset(context.app, created.snapshot.project.id, "reference.wav", "audio", 1_000);
    const built = context.app.buildPresenterTimeline({ projectId: created.snapshot.project.id, baseRevision: context.app.readProject(created.snapshot.project.id).revision.number, assetIds: [videoAssetId], sceneSize: 1 });
    context.app.applyTranscript({ projectId: created.snapshot.project.id, assetId: referenceAssetId, text: "完整旁白。", source: "manual" });
    applySemanticUnitsFromCandidates(context.app, created.snapshot.project.id);
    const segment = context.app.readProject(created.snapshot.project.id).snapshot.speechSegments[0]!;
    const speechFileAssetId = addReadyAsset(context.app, created.snapshot.project.id, "dialogue.wav", "speech", 1_000);
    context.app.applySpeechAssembly({
      projectId: created.snapshot.project.id,
      generatedAssets: [],
      segmentAssets: [{ id: "dialogue_segment", speechSegmentId: segment.id, voiceReferenceAssetId: referenceAssetId, assetId: speechFileAssetId, durationMs: 1_000, bridgeRunId: "run-dialogue", schemaVersion: "v1", quality: "passed" }],
      speechAsset: {
        id: "dialogue_asset",
        assetId: speechFileAssetId,
        scriptRevision: context.app.readProject(created.snapshot.project.id).snapshot.script.revision,
        segmentAssetIds: ["dialogue_segment"],
        timing: { precision: "segment_exact", source: "测试", segments: [{ speechSegmentId: segment.id, startMs: 0, endMs: 1_000, startFrame: 0, endFrame: 24 }] },
        status: "ready"
      }
    });
    const actorItemId = built.snapshot.timeline.items.find((item) => item.assetId === videoAssetId)!.id;
    const withSourceAudio = context.app.registerActorPerformance({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      timelineItemId: actorItemId,
      source: "imported",
      maskMode: "none",
      audioMode: "use_source_audio"
    });
    assert.ok(evaluateQuality(withSourceAudio.snapshot, withSourceAudio.revision.number).issues.some((issue) => issue.code === "DUPLICATE_DIALOGUE_AUDIO" && issue.level === "blocking"));

    const withDialogueAudio = context.app.registerActorPerformance({
      projectId: created.snapshot.project.id,
      baseRevision: withSourceAudio.revision.number,
      timelineItemId: actorItemId,
      source: "imported",
      maskMode: "none",
      audioMode: "use_dialogue_track"
    });
    assert.equal(evaluateQuality(withDialogueAudio.snapshot, withDialogueAudio.revision.number).issues.some((issue) => issue.code === "DUPLICATE_DIALOGUE_AUDIO"), false);
  } finally {
    await context.dispose();
  }
});

test("转写重试恢复既有 FunASR Run，成功写回 Transcript 且不创建第二个 Run", async () => {
  const context = await createTestApplication();
  const originalFetch = globalThis.fetch;
  let runReads = 0;
  let runCreates = 0;
  try {
    const created = context.app.createProject({ name: "FunASR Run 恢复测试" });
    const projectId = created.snapshot.project.id;
    const assetId = addReadyAsset(context.app, projectId, "recover-existing.wav", "audio");
    for (const seedJob of context.app.listJobs(projectId)) {
      if (seedJob.kind === "media_analysis" && seedJob.status === "queued") context.app.updateJob(seedJob.id, { status: "succeeded" });
    }
    const original = context.app.submitTranscription({ projectId, assetId, idempotencyKey: "funasr-existing-run" });
    context.app.recordBridgeRun(original.id, {
      workflowId: FUNASR_WORKFLOW_ID,
      runId: "funasr-existing-run",
      schemaVersion: "funasr-v1",
      schemaRetryCount: 0,
      submittedAt: new Date().toISOString(),
      request: { fieldValues: {}, fileSlots: [{ id: "audio", kind: "audio", fileName: "recover-existing.wav" }] }
    });
    context.app.updateJob(original.id, { status: "failed", error: "等待 Bridge 任务超时" });
    const retry = context.app.repository.createJob({
      projectId,
      kind: "transcription",
      payload: { assetId, retryOfJobId: original.id },
      idempotencyKey: "funasr-existing-run-retry"
    });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/runs/funasr-existing-run")) {
        runReads += 1;
        assert.equal(init?.method ?? "GET", "GET");
        return new Response(JSON.stringify({
          id: "funasr-existing-run",
          status: "succeeded",
          outputs: [{ outputSlotId: "text", displayName: "转写文本", kind: "text", text: "这是恢复后的真实转写文本。" }]
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith(`/workflows/${FUNASR_WORKFLOW_ID}/runs`)) runCreates += 1;
      throw new Error(`未预期的 FunASR 恢复请求：${url}`);
    };
    assert.equal(await runOneJob(context.app, createMediaJobProcessor(context.app, new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1"))), true);
    const completed = context.app.trackJob(retry.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(runReads, 1);
    assert.equal(runCreates, 0, "已有 run_id 的转写重试绝不能再次 POST Run");
    const transcript = context.app.readProject(projectId).snapshot.transcripts.find((candidate) => candidate.assetId === assetId);
    assert.equal(transcript?.text, "这是恢复后的真实转写文本。");
    assert.equal(transcript?.bridgeRunId, "funasr-existing-run");
    const retryAudits = completed.result?.bridgeRuns as Array<{ runId?: string; completedAt?: string }> | undefined;
    assert.equal(retryAudits?.[0]?.runId, "funasr-existing-run");
    assert.ok(retryAudits?.[0]?.completedAt, "恢复成功后必须更新当前 Job 的完成审计");
  } finally {
    globalThis.fetch = originalFetch;
    await context.dispose();
  }
});

test("转写重试遇到已丢失的 FunASR Run 时明确失败且不自动重提", async () => {
  const context = await createTestApplication();
  const originalFetch = globalThis.fetch;
  let runCreates = 0;
  try {
    const created = context.app.createProject({ name: "FunASR Run 丢失测试" });
    const projectId = created.snapshot.project.id;
    const assetId = addReadyAsset(context.app, projectId, "lost-existing.wav", "audio");
    for (const seedJob of context.app.listJobs(projectId)) {
      if (seedJob.kind === "media_analysis" && seedJob.status === "queued") context.app.updateJob(seedJob.id, { status: "succeeded" });
    }
    const original = context.app.submitTranscription({ projectId, assetId, idempotencyKey: "funasr-lost-run" });
    context.app.recordBridgeRun(original.id, {
      workflowId: FUNASR_WORKFLOW_ID,
      runId: "funasr-lost-run",
      schemaVersion: "funasr-v1",
      schemaRetryCount: 0,
      submittedAt: new Date().toISOString(),
      request: { fieldValues: {}, fileSlots: [{ id: "audio", kind: "audio", fileName: "lost-existing.wav" }] }
    });
    context.app.updateJob(original.id, { status: "failed", error: "等待 Bridge 任务超时" });
    const retry = context.app.repository.createJob({
      projectId,
      kind: "transcription",
      payload: { assetId, retryOfJobId: original.id },
      idempotencyKey: "funasr-lost-run-retry"
    });
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(`/workflows/${FUNASR_WORKFLOW_ID}/runs`)) runCreates += 1;
      if (url.endsWith("/runs/funasr-lost-run")) {
        return new Response(JSON.stringify({ error: "run not found" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      throw new Error(`未预期的 FunASR 丢失恢复请求：${url}`);
    };
    assert.equal(await runOneJob(context.app, createMediaJobProcessor(context.app, new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1"))), true);
    const failed = context.app.trackJob(retry.id);
    assert.equal(failed.status, "failed");
    assert.equal((failed.result?.diagnostic as { code?: string } | undefined)?.code, "TRANSCRIPTION_RUN_LOST_REQUIRES_RESUBMISSION");
    assert.equal(runCreates, 0, "Run 丢失只能显式失败，不能自动 POST 第二个 Run");
    assert.equal(context.app.readProject(projectId).snapshot.transcripts.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await context.dispose();
  }
});

test("Render Preflight 会把目标 Revision 的缺失受管文件报告为失败结果", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Render Preflight 文件依赖测试" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "missing-presenter.mp4", "video", 1_000);
    const built = context.app.buildPresenterTimeline({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      assetIds: [videoAssetId]
    });
    const preflightJob = context.app.submitRenderPreflight({ projectId: created.snapshot.project.id, revision: built.revision.number });
    assert.equal(await runOneRenderJob(context.app), true);
    const completed = context.app.trackJob(preflightJob.id);
    assert.equal(completed.status, "succeeded", "预检执行完成与预检通过是两件事");
    const preflight = completed.result?.preflight as { status?: string; checks?: Array<{ code?: string; status?: string }> } | undefined;
    assert.equal(preflight?.status, "failed");
    assert.ok(preflight?.checks?.some((check) => check.code === "PREFLIGHT_ASSET_FILE_MISSING" && check.status === "failed"));
  } finally {
    await context.dispose();
  }
});

test("Remotion 正式导出失败不会降级为仅 A-roll 成片", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "导出降级保护测试" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    await materializeFixtureForAsset(context.app, created.snapshot.project.id, videoAssetId, await createDeterministicVideoFixture(context.root));
    const built = context.app.buildPresenterTimeline({ projectId: created.snapshot.project.id, baseRevision: context.app.readProject(created.snapshot.project.id).revision.number, assetIds: [videoAssetId], sceneSize: 1 });
    const exportJob = context.app.submitExport({ projectId: created.snapshot.project.id, revision: built.revision.number, purpose: "draft", idempotencyKey: "remotion-must-fail" });
    await assert.rejects(
      () => runExportJob(context.app, exportJob, { render: async () => { throw new Error("渲染器不可用"); } } as never),
      (error: unknown) => error instanceof DomainError && error.code === "REMOTION_EXPORT_FAILED"
    );
  } finally {
    await context.dispose();
  }
});

test("ProductionRun 缺少真实创作证据时保持 incomplete，且不复制 Project Snapshot", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "ProductionRun 测试" });
    const run = await context.app.startProductionRun({
      projectId: created.snapshot.project.id,
      loadedSkills: ["production-director", "semantic-continuity"],
      loadedReferences: [".agents/skills/_shared/EDITORIAL_FOUNDATIONS.md"]
    });
    const recorded = await context.app.recordCreativeDecision({
      projectId: created.snapshot.project.id,
      runId: run.id,
      category: "visual",
      decision: "前半段保留人物主画面",
      rationale: "先建立人物与观点的稳定关系",
      quietRange: { startFrame: 0, endFrame: 24, reason: "开场不堆动效" },
      mcpCommand: "record_creative_decision"
    });
    assert.equal(recorded.creativeDecisions.length, 1);
    const completed = await context.app.completeProductionRun({ projectId: created.snapshot.project.id, runId: run.id });
    assert.equal(completed.status, "incomplete");
    assert.equal(completed.finalRevision, context.app.readProject(created.snapshot.project.id).revision.number);
    assert.ok(completed.completionBlockers.some((blocker) => blocker.includes("语义决策")));
    assert.ok(completed.completionBlockers.some((blocker) => blocker.includes("Preview Job")));
    const readBack = await context.app.readSkillExecutionReport({ projectId: created.snapshot.project.id, runId: run.id });
    assert.equal(readBack.quietRanges[0]?.reason, "开场不堆动效");
    assert.equal("skillExecutionReport" in context.app.readProject(created.snapshot.project.id).snapshot, false, "报告不写入项目快照");
  } finally {
    await context.dispose();
  }
});

test("ProductionRun 有当前版本的制作记录和真实预览即可完成，未审状态继续保留", async () => {
  const context = await createTestApplication();
  try {
    const projectId = context.app.createProject({ name: "制作完成与审阅分离" }).snapshot.project.id;
    const assetId = addReadyAsset(context.app, projectId, "presenter.mp4", "video", 1000);
    const state = context.app.buildPresenterTimeline({ projectId, baseRevision: context.app.readProject(projectId).revision.number, assetIds: [assetId] });
    const run = await context.app.startProductionRun({ projectId, loadedSkills: ["production-director"] });
    for (const category of ["semantic", "story", "visual"] as const) await context.app.recordCreativeDecision({ projectId, runId: run.id, category, decision: "合约测试制作决策", rationale: "不代表真实创意与观看" });
    const missing = await context.app.completeProductionRun({ projectId, runId: run.id });
    assert.equal(missing.status, "incomplete");
    assert.ok(missing.completionBlockers.some(message => message.includes("Preview Job")));
    const preview = context.app.submitPreview({ projectId, revision: state.revision.number, fromFrame: 0, toFrame: state.snapshot.timeline.durationInFrames });
    const path = join(state.snapshot.project.rootPath, "previews", "complete.mp4");
    await mkdir(dirname(path), { recursive: true });
    await copyFile(await createDeterministicVideoFixture(context.root), path);
    context.app.updateJob(preview.id, { status: "succeeded", result: { revision: state.revision.number, path, fromFrame: 0, toFrame: state.snapshot.timeline.durationInFrames } });
    const completed = await context.app.completeProductionRun({ projectId, runId: run.id });
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.composedFrameEvidence, []);
    assert.equal(completed.editorialReview, undefined);
    assert.equal((await context.app.readEditorialQualityReview({ projectId, revision: state.revision.number })), undefined);
    assert.deepEqual(context.app.listExportArtifacts(projectId), [], "完成制作不伪造导出与人工定稿");
  } finally { await context.dispose(); }
});

test("ProductionRun 不要求每个效果抽帧，已有证据仍按真实范围保存", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "EffectCue 审片覆盖" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    const built = context.app.buildPresenterTimeline({ projectId: created.snapshot.project.id, baseRevision: context.app.readProject(created.snapshot.project.id).revision.number, assetIds: [videoAssetId] });
    const scene = built.snapshot.scenes[0]!;
    const withCue = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: built.revision.number,
      sceneId: scene.id,
      type: "CameraPunch",
      layer: "actor",
      startFrame: 5,
      endFrame: 10,
      note: "只在这个短区间强调人物"
    });
    const revision = withCue.revision.number;
    const run = await context.app.startProductionRun({ projectId: created.snapshot.project.id, loadedSkills: ["production-director", "quality-verification"] });
    for (const category of ["semantic", "story", "visual"] as const) {
      await context.app.recordCreativeDecision({ projectId: created.snapshot.project.id, runId: run.id, category, decision: `${category} 决策`, rationale: "验证每个视觉事件都必须被实际检查" });
    }
    const preview = context.app.submitPreview({ projectId: created.snapshot.project.id, revision, fromFrame: 0, toFrame: withCue.snapshot.timeline.durationInFrames });
    const previewPath = join(created.snapshot.project.rootPath, "previews", "effect-coverage.mp4");
    const frameDirectory = join(created.snapshot.project.rootPath, "previews", "frames");
    await mkdir(frameDirectory, { recursive: true });
    await copyFile(await createDeterministicVideoFixture(context.root), previewPath);
    const outsideFrames = [0, 15, withCue.snapshot.timeline.durationInFrames - 1];
    for (const frame of [...outsideFrames, 7]) await writeFile(join(frameDirectory, `revision-${revision}-frame-${frame}.jpg`), `frame ${frame}`);
    context.app.updateJob(preview.id, { status: "succeeded", result: { revision, path: previewPath, fromFrame: 0, toFrame: withCue.snapshot.timeline.durationInFrames } });
    const toArtifact = (frame: number) => ({ frame, relativePath: join("previews", "frames", `revision-${revision}-frame-${frame}.jpg`) });
    await context.app.recordPreviewInspection({ projectId: created.snapshot.project.id, previewJobId: preview.id, revision, frames: outsideFrames.map(toArtifact) });
    await context.app.recordEditorialQualityReview({
      projectId: created.snapshot.project.id,
      runId: run.id,
      revision,
      passes: ["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"],
      previewEvidence: [toArtifact(outsideFrames[0]!).relativePath],
      observations: fixtureObservations(preview.id, withCue.snapshot.timeline.durationInFrames),
      findings: []
    });
    const missingCueFrame = await context.app.completeProductionRun({ projectId: created.snapshot.project.id, runId: run.id, finalRevision: revision });
    assert.equal(missingCueFrame.status, "completed");
    assert.deepEqual(missingCueFrame.completionBlockers, []);
    assert.equal(missingCueFrame.composedFrameEvidence.length, outsideFrames.length);
  } finally {
    await context.dispose();
  }
});

test("未审阅的 delivery 与 draft 都能进入渲染，渲染失败不伪装成功", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "导出用途门禁测试" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    await materializeFixtureForAsset(context.app, created.snapshot.project.id, videoAssetId, await createDeterministicVideoFixture(context.root));
    const assembled = context.app.buildPresenterTimeline({ projectId: created.snapshot.project.id, baseRevision: context.app.readProject(created.snapshot.project.id).revision.number, assetIds: [videoAssetId], sceneSize: 1 });
    const delivery = context.app.submitExport({ projectId: created.snapshot.project.id, revision: assembled.revision.number, purpose: "delivery" });
    assert.equal(delivery.payload.purpose, "delivery");
    await assert.rejects(
      () => runExportJob(context.app, delivery, { render: async () => { throw new Error("已进入交付渲染链路"); } } as never),
      (error: unknown) => error instanceof DomainError && error.code === "REMOTION_EXPORT_FAILED"
    );
    const draft = context.app.submitExport({ projectId: created.snapshot.project.id, revision: assembled.revision.number, purpose: "draft" });
    assert.equal(draft.payload.purpose, "draft");
    await assert.rejects(
      () => runExportJob(context.app, draft, { render: async () => { throw new Error("已进入草稿渲染链路"); } } as never),
      (error: unknown) => error instanceof DomainError && error.code === "REMOTION_EXPORT_FAILED"
    );
  } finally {
    await context.dispose();
  }
});

test("draft 错误只列真实技术阻断，不将待审观感误报为草稿拒绝原因", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "草稿拒绝原因" });
    const projectId = created.snapshot.project.id;
    const assetId = addReadyAsset(context.app, projectId, "missing-source.mp4", "video", 1000);
    const built = context.app.buildPresenterTimeline({ projectId, baseRevision: context.app.readProject(projectId).revision.number, assetIds: [assetId] });
    const state = context.app.updateAssetEditorialMetadata({ projectId, baseRevision: built.revision.number, assetId, provenance: { ...built.snapshot.assets.find(asset => asset.id === assetId)!.provenance!, source: "generated", } });
    const run = await context.app.startProductionRun({ projectId, loadedSkills: ["quality-verification"] });
    await context.app.recordEditorialQualityReview({ projectId, runId: run.id, revision: state.revision.number, passes: ["mute_visual"], previewEvidence: ["测试输入"], findings: [{ pass: "mute_visual", category: "motion", severity: "inconclusive", summary: "观感等待连续复核", impact: "不代表失败", evidence: "合约模拟" }] });
    for (const purpose of ["draft", "delivery"] as const) {
      const job = context.app.submitExport({ projectId, revision: state.revision.number, purpose });
      await assert.rejects(() => runExportJob(context.app, job, { render: async () => assert.fail("缺少源文件不应进入渲染") } as never), (error: unknown) => {
        assert.ok(error instanceof DomainError && error.code === "RENDER_PREFLIGHT_FAILED", String(error));
        assert.equal(error.message.includes("观感等待连续复核"), false);
        assert.match(error.message, /素材文件缺失|素材文件不存在|ENOENT/);
        return true;
      });
    }
  } finally { await context.dispose(); }
});

test("delivery ExportArtifact 固定 Revision、保留来源快照并让批准不受后续编辑影响", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "ExportArtifact 交付闭环测试" });
    const fixturePath = await createDeterministicVideoFixture(context.root);
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    await materializeFixtureForAsset(context.app, created.snapshot.project.id, videoAssetId, fixturePath);
    const provenance = { source: "provider" as const, provider: "测试素材库", sourceUrl: "https://example.test/media/fixture", creator: "测试作者", originalAssetId: "source-001", acquiredAt: "2026-10-05T00:00:00.000Z" };
    context.app.updateAssetEditorialMetadata({ projectId: created.snapshot.project.id, baseRevision: context.app.readProject(created.snapshot.project.id).revision.number, assetId: videoAssetId, provenance });
    const assembled = context.app.buildPresenterTimeline({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      assetIds: [videoAssetId]
    });
    const run = await context.app.startProductionRun({ projectId: created.snapshot.project.id, loadedSkills: ["quality-verification", "export"] });
    const preview = context.app.submitPreview({ projectId: created.snapshot.project.id, revision: assembled.revision.number, fromFrame: 0, toFrame: assembled.snapshot.timeline.durationInFrames });
    const previewPath = join(created.snapshot.project.rootPath, "previews", "artifact-gate.mp4");
    await mkdir(join(created.snapshot.project.rootPath, "previews"), { recursive: true });
    await copyFile(fixturePath, previewPath);
    context.app.updateJob(preview.id, { status: "succeeded", result: { revision: assembled.revision.number, path: previewPath, fromFrame: 0, toFrame: assembled.snapshot.timeline.durationInFrames } });
    await context.app.recordEditorialQualityReview({
      projectId: created.snapshot.project.id,
      runId: run.id,
      revision: assembled.revision.number,
      passes: ["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"],
      previewEvidence: ["已查看目标 Revision 的真实局部预览。"],
      observations: fixtureObservations(preview.id, assembled.snapshot.timeline.durationInFrames),
      findings: []
    });
    const renderFixture = { render: async (_snapshot: unknown, targetPath: string) => copyFile(fixturePath, targetPath) } as never;
    const firstJob = context.app.submitExport({ projectId: created.snapshot.project.id, revision: assembled.revision.number, purpose: "delivery", idempotencyKey: "artifact-first" });
    const firstResult = await runExportJob(context.app, firstJob, renderFixture) as { artifactId: string; relativePath: string };
    const firstArtifact = context.app.readExportArtifact({ projectId: created.snapshot.project.id, artifactId: firstResult.artifactId });
    assert.equal(firstArtifact.revision, assembled.revision.number);
    assert.equal(firstArtifact.purpose, "delivery");
    assert.equal(firstArtifact.preflight.status, "passed");
    assert.match(firstArtifact.fileHash, /^[a-f0-9]{64}$/u);
    assert.ok(firstArtifact.fileSizeBytes > 0);
    assert.deepEqual(firstArtifact.sourceManifest.entries, [{ assetId: videoAssetId, name: "presenter.mp4", sourceHash: assembled.snapshot.assets.find(asset => asset.id === videoAssetId)!.sourceHash, ...provenance }]);
    assert.equal(firstArtifact.sourceManifest.relativePath.startsWith(join("manifests", "sources")), true);
    await access(join(created.snapshot.project.rootPath, firstArtifact.relativePath));
    const manifest = JSON.parse(await readFile(join(created.snapshot.project.rootPath, firstArtifact.sourceManifest.relativePath), "utf8")) as { entries: unknown[] };
    assert.deepEqual(manifest.entries, firstArtifact.sourceManifest.entries);
    const replayed = await runExportJob(context.app, firstJob, renderFixture) as { artifactId: string; relativePath: string };
    assert.equal(replayed.artifactId, firstArtifact.id, "结果未知后重领同一 Export Job 必须复用已登记 Artifact");
    assert.equal(replayed.relativePath, firstArtifact.relativePath);

    await context.app.recordExportArtifactReview({
      projectId: created.snapshot.project.id,
      artifactId: firstArtifact.id,
      passes: ["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"],
      evidence: ["已完整播放并试听 delivery 文件。"],
      findings: []
    });
    const approved = await context.app.approveExportArtifact({ projectId: created.snapshot.project.id, artifactId: firstArtifact.id, fileHash: firstArtifact.fileHash, confirmedByUser: true, note: "合约测试模拟用户确认，不代表真人验收。" });
    assert.ok(approved.approval);

    const nextRevision = context.app.updateStory({ projectId: created.snapshot.project.id, baseRevision: assembled.revision.number, title: "后续修改不改写旧交付" });
    const preserved = context.app.readExportArtifact({ projectId: created.snapshot.project.id, artifactId: firstArtifact.id });
    assert.equal(preserved.revision, assembled.revision.number);
    assert.equal(preserved.approval?.note, "合约测试模拟用户确认，不代表真人验收。");
    assert.equal(nextRevision.revision.number, assembled.revision.number + 1);

    const secondJob = context.app.submitExport({ projectId: created.snapshot.project.id, revision: assembled.revision.number, purpose: "delivery", idempotencyKey: "artifact-second" });
    const secondResult = await runExportJob(context.app, secondJob, renderFixture) as { artifactId: string; relativePath: string };
    assert.notEqual(secondResult.artifactId, firstArtifact.id);
    assert.notEqual(secondResult.relativePath, firstArtifact.relativePath, "同一 Revision 的重新导出不得覆盖旧 Artifact 文件");
    await access(join(created.snapshot.project.rootPath, firstArtifact.relativePath));
  } finally {
    await context.dispose();
  }
});

test("真实审片记录会按 Revision 合并到 QualityReport，过期记录不会冒充当前结论", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "编辑审片记录测试" });
    const run = await context.app.startProductionRun({
      projectId: created.snapshot.project.id,
      loadedSkills: ["quality-verification"]
    });
    const recorded = await context.app.recordEditorialQualityReview({
      projectId: created.snapshot.project.id,
      runId: run.id,
      revision: created.revision.number,
      passes: ["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"],
      previewEvidence: ["测试环境已检查 R1 的真实预览范围 F0–F24"],
      findings: [{
        pass: "mute_visual",
        severity: "warning",
        category: "typography",
        summary: "字幕需要在安全区内复核",
        evidence: "稳定帧中字幕接近底部边缘",
        impact: "小屏设备上可能影响阅读",
        suggestedFix: "上移字幕安全区",
        verificationMethod: "重新渲染稳定帧"
      }]
    });
    assert.equal(recorded.editorialReview?.revision, created.revision.number);
    const review = await context.app.readLatestEditorialQualityReview({ projectId: created.snapshot.project.id });
    const quality = evaluateQuality(created.snapshot, created.revision.number, review);
    assert.equal(quality.editorial.status, "partial", "旧自由文字不能证明全片已连续审阅");
    assert.ok(quality.editorial.passes.includes("audiovisual"));
    assert.equal(quality.editorial.previewEvidence.length, 1);
    assert.equal(quality.editorial.typography[0]?.code, "EDITORIAL_TYPOGRAPHY");
    assert.equal(quality.technical.some((issue) => issue.code === "EDITORIAL_TYPOGRAPHY"), false, "编辑审片不能冒充技术检测结果");

    const updated = context.app.updateStory({ projectId: created.snapshot.project.id, baseRevision: created.revision.number, title: "R2" });
    const stale = evaluateQuality(updated.snapshot, updated.revision.number, await context.app.readLatestEditorialQualityReview({ projectId: created.snapshot.project.id }));
    assert.equal(stale.editorial.status, "stale");
    assert.equal(stale.editorial.typography.length, 1, "换 Revision 不能清除尚未复核的问题");
  } finally {
    await context.dispose();
  }
});

test("目标 Revision 导出只读取自身的审片记录，不被更新版本覆盖", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "目标 Revision 审片查询" });
    const reviewInput: { passes: EditorialReviewPass[]; previewEvidence: string[]; findings: [] } = {
      passes: ["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"],
      previewEvidence: ["真实 Preview 已完成检查"],
      findings: []
    };
    const firstRun = await context.app.startProductionRun({ projectId: created.snapshot.project.id, loadedSkills: ["quality-verification"] });
    await context.app.recordEditorialQualityReview({ projectId: created.snapshot.project.id, runId: firstRun.id, revision: created.revision.number, ...reviewInput });
    const second = context.app.updateStory({ projectId: created.snapshot.project.id, baseRevision: created.revision.number, title: "R2" });
    const secondRun = await context.app.startProductionRun({ projectId: created.snapshot.project.id, loadedSkills: ["quality-verification"] });
    await context.app.recordEditorialQualityReview({ projectId: created.snapshot.project.id, runId: secondRun.id, revision: second.revision.number, ...reviewInput });

    const firstReview = await context.app.readEditorialQualityReview({ projectId: created.snapshot.project.id, revision: created.revision.number });
    const secondReview = await context.app.readEditorialQualityReview({ projectId: created.snapshot.project.id, revision: second.revision.number });
    assert.equal(firstReview?.revision, created.revision.number);
    assert.equal(secondReview?.revision, second.revision.number);
  } finally {
    await context.dispose();
  }
});

test("已使用的外部素材不要求权利证明，素材角色和来源可独立更新", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "外部素材来源测试" });
    const assetId = addReadyAsset(context.app, created.snapshot.project.id, "provider-broll.mp4", "video", 1_000);
    const external = context.app.updateAssetEditorialMetadata({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      assetId,
      role: "b_roll",
      tags: ["城市", "呼吸镜头"],
      provenance: {
        source: "provider",
        provider: "测试素材库",
        sourceUrl: "https://example.test/assets/provider-broll",
        originalAssetId: "provider-001",
        acquiredAt: new Date().toISOString()
      }
    });
    const asset = external.snapshot.assets.find((candidate) => candidate.id === assetId)!;
    assert.equal(asset.role, "b_roll");
    assert.deepEqual(asset.tags, ["城市", "呼吸镜头"]);

    const assembled = context.app.assemblePresenterTrack({ projectId: created.snapshot.project.id, baseRevision: external.revision.number, assetIds: [assetId] });
    const quality = evaluateQuality(assembled.snapshot, assembled.revision.number);
    assert.equal(quality.issues.some((entry) => entry.code.startsWith("EXTERNAL_ASSET_RIGHTS")), false);

  } finally {
    await context.dispose();
  }
});

test("素材需求通过 Mock Provider 候选、本地化、哈希和来源登记后才成为可用 Asset", async () => {
  const context = await createTestApplication();
  try {
    const sourcePath = await createDeterministicVideoFixture(context.root);
    const created = context.app.createProject({ name: "素材获取闭环测试" });
    const requested = context.app.manageAssetRequirement({
      projectId: created.snapshot.project.id,
      baseRevision: created.revision.number,
      action: "create",
      title: "下班后城市呼吸镜头",
      purpose: "为人物反思留出真实生活的视觉呼吸。",
      visualBrief: "傍晚城市中景人物慢步行，画面上方保留天空，适合竖屏字幕。",
      queryHints: ["city", "walking", "dusk"],
      minDurationMs: 800,
    });
    const request = requested.snapshot.assetRequests[0]!;
    const provider = new MockAssetProvider([
      {
        originalAssetId: "accepted-city-walk",
        name: "city-walk.mp4",
        filePath: sourcePath,
        sourceUrl: "https://example.test/stock/city-walk",
        width: 64,
        height: 64,
        durationMs: 1_000,
        creator: "测试作者",
        tags: ["城市", "步行"]
      },
      {
        originalAssetId: "short-video",
        name: "short-video.mp4",
        filePath: sourcePath,
        sourceUrl: "https://example.test/stock/short-video",
        width: 64,
        height: 64,
        durationMs: 100,
      }
    ]);
    const providerCandidates = await provider.search({ request, query: "city walking dusk" });
    const searched = context.app.recordAssetSearch({
      projectId: created.snapshot.project.id,
      baseRevision: requested.revision.number,
      assetRequestId: request.id,
      provider: provider.name,
      query: "city walking dusk",
      candidates: providerCandidates
    });
    const accepted = searched.candidates.find((candidate) => candidate.originalAssetId === "accepted-city-walk")!;
    const short = searched.candidates.find((candidate) => candidate.originalAssetId === "short-video")!;
    assert.equal(accepted.status, "available");
    assert.equal(short.status, "available");
    assert.equal(short.rejectionReason, undefined);
    assert.equal(context.app.readAssetCandidate({ projectId: created.snapshot.project.id, assetCandidateId: accepted.id }).request.id, request.id);

    // Candidate 不是 Asset，不能绕过 Acquire 直接塞进 Scene。
    assert.throws(
      () => context.app.createScene({
        projectId: created.snapshot.project.id,
        baseRevision: searched.state.revision.number,
        type: "CutawayScene",
        title: "错误候选引用",
        purpose: "验证候选不会直接成为 Timeline 素材",
        startFrame: 0,
        endFrame: 24,
        assetIds: [accepted.id]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "ASSET_NOT_FOUND"
    );
    const acquisition = context.app.acquireAssetCandidate({
      projectId: created.snapshot.project.id,
      baseRevision: searched.state.revision.number,
      assetCandidateId: accepted.id
    });
    const registry = new AssetProviderRegistry([provider]);
    assert.equal(await runOneJob(context.app, createMediaJobProcessor(context.app, undefined, registry)), true);
    const acquiredJob = context.app.trackJob(acquisition.job.id);
    assert.equal(acquiredJob.status, "succeeded", acquiredJob.error);
    const acquiredState = context.app.readProject(created.snapshot.project.id);
    const acquiredAsset = acquiredState.snapshot.assets.find((asset) => asset.id === acquiredJob.result?.assetId);
    assert.ok(acquiredAsset);
    assert.equal(acquiredAsset.role, "b_roll");
    assert.equal(acquiredAsset.provenance?.provider, "mock");
    assert.match(acquiredAsset.sourceHash ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(acquiredState.snapshot.assetCandidates.find((candidate) => candidate.id === accepted.id)?.acquiredAssetId, acquiredAsset.id);

    // 获取 Worker 已探测原件，登记时直接回填；后续分析仍补缩略图。
    assert.equal(acquiredAsset.status, "ready");
    assert.equal(await runOneJob(context.app, createMediaJobProcessor(context.app, undefined, registry)), true);
    const readyAsset = context.app.readProject(created.snapshot.project.id).snapshot.assets.find((asset) => asset.id === acquiredAsset.id)!;
    assert.equal(readyAsset.status, "ready", readyAsset.failureReason);
    assert.ok(readyAsset.metadata?.videoCodec);
    const provenance = context.app.readAssetProvenance({ projectId: created.snapshot.project.id, assetId: readyAsset.id });
    assert.equal(provenance.candidate?.id, accepted.id);
    assert.equal(provenance.provenance?.sourceUrl, "https://example.test/stock/city-walk");
  } finally {
    await context.dispose();
  }
});

test("素材下载到伪装成视频的 HTML 错误页时保留失败诊断且不创建 Asset", async () => {
  const context = await createTestApplication();
  try {
    const errorPagePath = join(context.root, "expired-download.mp4");
    await writeFile(errorPagePath, "<!doctype html><html><body>expired download link</body></html>");
    const created = context.app.createProject({ name: "素材下载失败测试" });
    const requested = context.app.manageAssetRequirement({
      projectId: created.snapshot.project.id,
      baseRevision: created.revision.number,
      action: "create",
      title: "失败候选",
      purpose: "验证下载错误不会污染素材库。",
      visualBrief: "测试用候选。",
    });
    const request = requested.snapshot.assetRequests[0]!;
    const provider = new MockAssetProvider([{
      originalAssetId: "expired-link",
      name: "expired-link.mp4",
      filePath: errorPagePath,
      sourceUrl: "https://example.test/expired-link",
      durationMs: 100,
    }]);
    const searched = context.app.recordAssetSearch({
      projectId: created.snapshot.project.id,
      baseRevision: requested.revision.number,
      assetRequestId: request.id,
      provider: provider.name,
      query: "expired link",
      candidates: await provider.search({ request, query: "expired link" })
    });
    const candidate = searched.candidates[0]!;
    const acquisition = context.app.acquireAssetCandidate({
      projectId: created.snapshot.project.id,
      baseRevision: searched.state.revision.number,
      assetCandidateId: candidate.id
    });
    assert.equal(await runOneJob(context.app, createMediaJobProcessor(context.app, undefined, new AssetProviderRegistry([provider]))), true);
    const job = context.app.trackJob(acquisition.job.id);
    assert.equal(job.status, "failed");
    assert.equal((job.result?.diagnostic as { code?: string } | undefined)?.code, "ASSET_DOWNLOAD_HTML");
    const state = context.app.readProject(created.snapshot.project.id);
    assert.equal(state.snapshot.assets.length, 0);
    assert.equal(state.snapshot.assetCandidates[0]?.status, "failed");
    assert.match(state.snapshot.assetCandidates[0]?.acquisitionError ?? "", /网页错误页/u);
  } finally {
    await context.dispose();
  }
});

test("Cutaway 只接受已就绪本地视频，并把 VisualTreatment、CutawayScene 与顶层 Item 原子写入", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Cutaway 最小闭环" });
    const presenterAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    const brollAssetId = addReadyAsset(context.app, created.snapshot.project.id, "city-walk.mp4", "video", 1_000);
    const built = context.app.buildPresenterTimeline({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      assetIds: [presenterAssetId],
      sceneSize: 1
    });
    const hostScene = built.snapshot.scenes[0]!;
    const pending = context.app.registerImportedAsset({
      projectId: created.snapshot.project.id,
      baseRevision: built.revision.number,
      name: "not-ready.mp4",
      kind: "video",
      managedPath: "assets/source/not-ready.mp4",
      sourceHash: "not-ready-hash"
    });
    assert.throws(
      () => context.app.manageCutaway({
        projectId: created.snapshot.project.id,
        baseRevision: pending.state.revision.number,
        action: "create",
        hostSceneId: hostScene.id,
        assetId: pending.asset.id,
        mode: "fullscreen",
        fit: "cover",
        audioMode: "continue_dialogue",
        purpose: "错误示例",
        audienceTask: "验证未就绪素材被拒绝",
        sourceStartFrame: 0,
        sourceEndFrame: 12,
        startFrame: 4,
        endFrame: 16
      }),
      (error: unknown) => error instanceof DomainError && error.code === "CUTAWAY_ASSET_NOT_READY"
    );

    const treatment = context.app.manageVisualTreatment({
      projectId: created.snapshot.project.id,
      baseRevision: pending.state.revision.number,
      action: "upsert",
      sceneId: hostScene.id,
      mode: "b_roll",
      primaryAttention: "下班后的真实步行状态",
      narrativePurpose: "让个人反思落到具体生活，而不是用抽象关键词素材替代。",
      intensity: "low",
      fallbackPlan: "没有相关素材时保持人物"
    });
    const visualTreatment = treatment.snapshot.visualTreatments[0]!;
    const withCutaway = context.app.manageCutaway({
      projectId: created.snapshot.project.id,
      baseRevision: treatment.revision.number,
      action: "create",
      hostSceneId: hostScene.id,
      assetId: brollAssetId,
      visualTreatmentId: visualTreatment.id,
      title: "城市步行",
      mode: "pip",
      fit: "contain",
      pipAnchor: "top_right",
      pipScale: 0.32,
      audioMode: "continue_dialogue",
      purpose: "以现实步行镜头具体化下班后的停顿",
      audienceTask: "在不丢失人物关系的前提下看见真实生活场景",
      sourceStartFrame: 0,
      sourceEndFrame: 12,
      startFrame: 4,
      endFrame: 16
    });
    const cutaway = withCutaway.snapshot.cutaways[0]!;
    const cutawayScene = withCutaway.snapshot.scenes.find((scene) => scene.id === cutaway.cutawaySceneId)!;
    const cutawayItem = withCutaway.snapshot.timeline.items.find((item) => item.id === cutaway.timelineItemId)!;
    const topTrack = withCutaway.snapshot.timeline.tracks.find((track) => track.name === "Cutaway / Fullscreen")!;
    assert.equal(cutaway.status, "ready");
    assert.equal(cutaway.visualTreatmentId, visualTreatment.id);
    assert.equal(cutawayScene.type, "CutawayScene");
    assert.equal(cutawayItem.trackId, topTrack.id);
    assert.equal(cutawayItem.assetId, brollAssetId);
    assert.equal(cutawayItem.sceneId, cutawayScene.id);

    // 主线重编译不会留下指向旧 PresenterScene 的 VisualTreatment 或 Cutaway。
    const recompiled = context.app.compilePresenterScenes({
      projectId: created.snapshot.project.id,
      baseRevision: withCutaway.revision.number,
      scenes: [{ title: "重编后的主场景", purpose: "验证主线变化会清理旧 Cutaway", startFrame: 0, endFrame: 24 }]
    });
    assert.equal(recompiled.snapshot.cutaways.length, 0);
    assert.equal(recompiled.snapshot.visualTreatments.length, 0);
    assert.ok(recompiled.revision.impact.stale.includes(cutaway.id));
  } finally {
    await context.dispose();
  }
});

test("替换 Cutaway 素材保留主场景与 Cue，主线移动后会停用并标记 stale", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Cutaway 替换与失效传播" });
    const presenterAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    const firstBrollId = addReadyAsset(context.app, created.snapshot.project.id, "first-broll.mp4", "video", 1_000);
    const replacementBrollId = addReadyAsset(context.app, created.snapshot.project.id, "replacement-broll.mp4", "video", 1_000);
    const built = context.app.buildPresenterTimeline({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      assetIds: [presenterAssetId],
      sceneSize: 1
    });
    const hostScene = built.snapshot.scenes[0]!;
    const withCue = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: built.revision.number,
      sceneId: hostScene.id,
      type: "MetricBackdrop",
      layer: "front",
      startFrame: 0,
      endFrame: 12,
      narrativePurpose: "保持人物说出关键结论时的轻量强调",
      audienceTask: "记住当前结论"
    });
    const cueId = withCue.snapshot.effectCues[0]!.id;
    const withCutaway = context.app.manageCutaway({
      projectId: created.snapshot.project.id,
      baseRevision: withCue.revision.number,
      action: "create",
      hostSceneId: hostScene.id,
      assetId: firstBrollId,
      mode: "fullscreen",
      fit: "cover",
      audioMode: "continue_dialogue",
      purpose: "用真实环境给结论留出呼吸",
      audienceTask: "短暂进入现实环境后回到人物",
      sourceStartFrame: 0,
      sourceEndFrame: 12,
      startFrame: 4,
      endFrame: 16
    });
    const cutaway = withCutaway.snapshot.cutaways[0]!;
    const replaced = context.app.replaceSceneAsset({
      projectId: created.snapshot.project.id,
      baseRevision: withCutaway.revision.number,
      cutawayId: cutaway.id,
      assetId: replacementBrollId,
      sourceStartFrame: 4,
      sourceEndFrame: 16
    });
    const replacement = replaced.snapshot.cutaways[0]!;
    assert.equal(replacement.assetId, replacementBrollId);
    assert.equal(replacement.sourceStartFrame, 4);
    assert.equal(replaced.snapshot.scenes.find((scene) => scene.id === hostScene.id)?.id, hostScene.id);
    assert.equal(replaced.snapshot.effectCues.find((cue) => cue.id === cueId)?.id, cueId);
    assert.equal(replaced.snapshot.timeline.items.find((item) => item.id === replacement.timelineItemId)?.assetId, replacementBrollId);

    const actorItem = replaced.snapshot.timeline.items.find((item) => item.sceneId === hostScene.id)!;
    const moved = context.app.moveItem({
      projectId: created.snapshot.project.id,
      baseRevision: replaced.revision.number,
      itemId: actorItem.id,
      startFrame: 24
    });
    const staleCutaway = moved.snapshot.cutaways.find((candidate) => candidate.id === replacement.id)!;
    assert.equal(staleCutaway.status, "stale");
    assert.equal(moved.snapshot.timeline.items.find((item) => item.id === staleCutaway.timelineItemId)?.disabled, true);
    assert.ok(moved.revision.impact.stale.includes(staleCutaway.id));
    assert.ok(evaluateQuality(moved.snapshot, moved.revision.number).issues.some((issue) => issue.code === "STALE_CUTAWAY"));
  } finally {
    await context.dispose();
  }
});

test("Cutaway Runtime 对 Fullscreen/PiP 和声音策略使用同一项目事实", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Cutaway Runtime 布局" });
    const presenterAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    const brollAssetId = addReadyAsset(context.app, created.snapshot.project.id, "broll.mp4", "video", 1_000);
    const built = context.app.buildPresenterTimeline({ projectId: created.snapshot.project.id, baseRevision: context.app.readProject(created.snapshot.project.id).revision.number, assetIds: [presenterAssetId], sceneSize: 1 });
    const hostScene = built.snapshot.scenes[0]!;
    const state = context.app.manageCutaway({
      projectId: created.snapshot.project.id,
      baseRevision: built.revision.number,
      action: "create",
      hostSceneId: hostScene.id,
      assetId: brollAssetId,
      mode: "pip",
      fit: "contain",
      pipAnchor: "top_right",
      pipScale: 0.32,
      audioMode: "continue_dialogue",
      purpose: "辅助例子",
      audienceTask: "保留人物说话时看见例子",
      sourceStartFrame: 0,
      sourceEndFrame: 12,
      startFrame: 4,
      endFrame: 16
    });
    const cutaway = state.snapshot.cutaways[0]!;
    const item = state.snapshot.timeline.items.find((candidate) => candidate.id === cutaway.timelineItemId)!;
    const track = state.snapshot.timeline.tracks.find((candidate) => candidate.id === item.trackId)!;
    const pip = compileCutawayLayout(cutaway, 16 / 9);
    assert.equal(pip.container.position, "absolute");
    assert.equal(pip.container.right, "5%");
    assert.equal(pip.container.top, "8%");
    assert.equal(pip.container.width, "32%");
    assert.equal(pip.media.objectFit, "contain");
    assert.equal(cutawaySourceVolume(cutaway, item, track), 0);

    const fullscreen = compileCutawayLayout({ ...cutaway, mode: "fullscreen", fit: "cover", audioMode: "include_source_audio" }, 16 / 9);
    assert.equal(fullscreen.container.inset, 0);
    assert.equal(fullscreen.media.objectFit, "cover");
    assert.equal(cutawaySourceVolume({ ...cutaway, audioMode: "include_source_audio" }, item, track), 1);
  } finally {
    await context.dispose();
  }
});

test("Presenter 先编译 Scene 再登记人物，前置拒绝不产生 Revision 或改变原声", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "人物前置顺序回归", profile: "presenter_motion" });
    const projectId = created.snapshot.project.id;
    const assetId = addReadyAsset(context.app, projectId, "presenter.mp4");
    const assembled = context.app.assemblePresenterTrack({
      projectId, baseRevision: context.app.readProject(projectId).revision.number, assetIds: [assetId]
    });
    const item = assembled.snapshot.timeline.items.find((candidate) => candidate.assetId === assetId)!;
    const actorInput = { projectId, timelineItemId: item.id, source: "imported" as const,
      maskMode: "none" as const, audioMode: "use_source_audio" as const };
    const revisionsBefore = context.app.readRevisions(projectId).length;

    // 未归属 Scene 是明确的前置拒绝，不能靠重试或新建版本消除。
    assert.throws(() => context.app.registerActorPerformance({ ...actorInput, baseRevision: assembled.revision.number }),
      (error: unknown) => error instanceof DomainError && error.code === "ACTOR_SCENE_REQUIRED");
    assert.deepEqual(context.app.readProject(projectId), assembled);
    assert.equal(context.app.readRevisions(projectId).length, revisionsBefore);

    const story = context.app.updateStory({ projectId, baseRevision: assembled.revision.number,
      beats: [{ title: "完整观点", purpose: "建立人物片段的叙事归属" }] });
    const compiled = context.app.compilePresenterScenes({ projectId, baseRevision: story.revision.number,
      scenes: [{ title: "人物段落", purpose: "承载完整观点", startFrame: item.startFrame, endFrame: item.endFrame,
        narrativeBeatIds: [story.snapshot.story.beats[0]!.id] }] });
    const registered = context.app.registerActorPerformance({ ...actorInput, baseRevision: compiled.revision.number });
    const registeredItem = registered.snapshot.timeline.items.find((candidate) => candidate.id === item.id)!;
    assert.equal(registeredItem.sceneId, compiled.snapshot.scenes[0]!.id);
    assert.deepEqual({ ...registeredItem, sceneId: undefined }, { ...item, sceneId: undefined });
    assert.equal(registered.snapshot.actorPerformances.length, 1);
    assert.equal(registered.snapshot.actorPerformances[0]!.audioMode, "use_source_audio");
    assert.equal(registered.snapshot.speechAsset, undefined);
  } finally {
    await context.dispose();
  }
});

test("StoryBeat 保持稳定 ID，移动 Item 会重算关联 Scene 与 Cue", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "项目图一致性测试" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    const audioAssetId = addReadyAsset(context.app, created.snapshot.project.id, "script.wav", "audio", 1_000);
    context.app.applyTranscript({ projectId: created.snapshot.project.id, assetId: audioAssetId, text: "先说明原因。", source: "manual" });
    const semantic = applySemanticUnitsFromCandidates(context.app, created.snapshot.project.id);
    const semanticUnitId = semantic.snapshot.semanticUnits[0]!.id;
    const story = context.app.updateStory({
      projectId: created.snapshot.project.id,
      baseRevision: semantic.revision.number,
      beats: [{ title: "提出原因", purpose: "建立前提", semanticUnitIds: [semanticUnitId] }]
    });
    const beatId = story.snapshot.story.beats[0]!.id;
    const updatedStory = context.app.updateStory({
      projectId: created.snapshot.project.id,
      baseRevision: story.revision.number,
      beats: [{ id: beatId, title: "解释原因", purpose: "建立前提", semanticUnitIds: [semanticUnitId] }]
    });
    assert.equal(updatedStory.snapshot.story.beats[0]!.id, beatId);
    const assembled = context.app.assemblePresenterTrack({ projectId: created.snapshot.project.id, baseRevision: updatedStory.revision.number, assetIds: [videoAssetId] });
    const compiled = context.app.compilePresenterScenes({
      projectId: created.snapshot.project.id,
      baseRevision: assembled.revision.number,
      scenes: [{ title: "原因", purpose: "让观众理解前提", startFrame: 0, endFrame: 24, narrativeBeatIds: [beatId] }]
    });
    const scene = compiled.snapshot.scenes[0]!;
    const cue = context.app.createEffectCue({ projectId: created.snapshot.project.id, baseRevision: compiled.revision.number, sceneId: scene.id, type: "MetricBackdrop", layer: "rear", startFrame: 0, endFrame: 12 });
    const itemId = cue.snapshot.timeline.items.find((item) => item.sceneId === scene.id)!.id;
    const moved = context.app.moveItem({ projectId: created.snapshot.project.id, baseRevision: cue.revision.number, itemId, startFrame: 24 });
    const movedScene = moved.snapshot.scenes.find((candidate) => candidate.id === scene.id)!;
    const movedCue = moved.snapshot.effectCues[0]!;
    assert.equal(movedScene.startFrame, 24);
    assert.equal(movedCue.startFrame, 24);
    assert.equal(movedCue.status, "ready");
  } finally {
    await context.dispose();
  }
});

test("结构化 NarrativeBeat 锚点会覆盖遗留 SpeechSegment 锚点", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "NarrativeBeat 效果锚点" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 1_000);
    const assembled = context.app.assemblePresenterTrack({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      assetIds: [videoAssetId]
    });
    const story = context.app.updateStory({
      projectId: created.snapshot.project.id,
      baseRevision: assembled.revision.number,
      beats: [{ title: "关键转折", purpose: "验证原声 A-roll 可直接绑定 NarrativeBeat" }]
    });
    const beatId = story.snapshot.story.beats[0]!.id;
    const scene = context.app.compilePresenterScenes({
      projectId: created.snapshot.project.id,
      baseRevision: story.revision.number,
      scenes: [{ title: "转折段", purpose: "承载关键观点", startFrame: 0, endFrame: 24, narrativeBeatIds: [beatId] }]
    });

    const withCue = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: scene.revision.number,
      sceneId: scene.snapshot.scenes[0]!.id,
      type: "CameraPunch",
      layer: "actor",
      startFrame: 0,
      endFrame: 12,
      // 模拟旧客户端仍附带的字段；它不存在也不能否决新的结构化锚点。
      anchorTargetId: "legacy-speech-segment-that-does-not-exist",
      semanticAnchor: { type: "narrative_beat", targetId: beatId, relation: "land_on" }
    });

    const cue = withCue.snapshot.effectCues[0]!;
    assert.equal(cue.anchorTargetId, undefined);
    assert.deepEqual(cue.semanticAnchor, { type: "narrative_beat", targetId: beatId, relation: "land_on" });
  } finally {
    await context.dispose();
  }
});

test("MotionLayoutCompiler 将空间锚点、运动预设、风格包和强度落为可渲染参数", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "动效布局编译测试" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 2_000);
    const assembled = context.app.buildPresenterTimeline({ projectId: created.snapshot.project.id, baseRevision: context.app.readProject(created.snapshot.project.id).revision.number, assetIds: [videoAssetId], sceneSize: 1 });
    const scene = assembled.snapshot.scenes[0]!;
    const withCue = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: assembled.revision.number,
      sceneId: scene.id,
      type: "EvidenceCard",
      layer: "front",
      startFrame: 8,
      endFrame: 36,
      spatialAnchor: "top_left",
      stylePackId: "warm-editorial",
      motion: { enterPreset: "slide_left", settlePreset: "pulse", exitPreset: "scale", enterFrames: 10, exitFrames: 8 }
    });
    const cue = withCue.snapshot.effectCues[0]!;
    const initial = compileMotionLayout(cue, cue.startFrame);
    const settled = compileMotionLayout(cue, cue.startFrame + 12);
    const intense = compileMotionLayout({ ...cue, intensity: 1, spatialAnchor: "bottom_right", stylePackId: "evidence-paper" }, cue.startFrame + 3);
    assert.equal(initial.container.left, "5%");
    assert.equal(initial.container.top, "8%");
    assert.notEqual(initial.motion.transform, settled.motion.transform, "进入预设必须实际改变运动路径");
    assert.equal(intense.container.right, "5%");
    assert.equal(intense.container.bottom, "20%");
    assert.notEqual(intense.motion.transform, compileMotionLayout({ ...cue, intensity: 0 }, cue.startFrame + 3).motion.transform, "强度必须改变运动距离、速度或缩放");
    assert.equal(initial.stylePack.id, "warm-editorial");
    assert.equal(intense.stylePack.id, "evidence-paper");
    assert.notEqual(initial.stylePack.fontFamily, intense.stylePack.fontFamily, "stylePackId 必须改变实际视觉参数");
  } finally {
    await context.dispose();
  }
});

test("CameraPunch 由 MotionLayoutCompiler 消费进入、退出预设和安全取景重心", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "人物推近编译测试" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 2_000);
    const assembled = context.app.buildPresenterTimeline({ projectId: created.snapshot.project.id, baseRevision: context.app.readProject(created.snapshot.project.id).revision.number, assetIds: [videoAssetId], sceneSize: 1 });
    const scene = assembled.snapshot.scenes[0]!;
    const withCue = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: assembled.revision.number,
      sceneId: scene.id,
      type: "CameraPunch",
      layer: "actor",
      startFrame: 4,
      endFrame: 28,
      spatialAnchor: "top_left",
      motion: { enterPreset: "scale", settlePreset: "hold", exitPreset: "scale", enterFrames: 10, exitFrames: 8 }
    });
    const cue = withCue.snapshot.effectCues[0]!;
    const entering = compileCameraPunchLayout(cue, cue.startFrame + 3);
    const settled = compileCameraPunchLayout(cue, cue.startFrame + cue.motion.enterFrames + 2);
    const exiting = compileCameraPunchLayout(cue, cue.endFrame - 2);
    const popped = compileCameraPunchLayout({ ...cue, motion: { ...cue.motion, enterPreset: "pop" } }, cue.startFrame + 8);
    assert.equal(entering.transformOrigin, "28% 26%");
    assert.ok(entering.scale > 1 && entering.scale < settled.scale, "scale 预设必须逐步推近");
    assert.ok(exiting.scale < settled.scale && exiting.scale > 1, "退出预设必须自然回位");
    assert.ok(popped.scale > compileCameraPunchLayout(cue, cue.startFrame + 8).scale, "pop 预设必须改变实际推近曲线");
  } finally {
    await context.dispose();
  }
});

test("EffectCue qualityRules 会进入质量门禁，旧自由文本不会被静默当作已执行", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "Cue 质量规则执行测试" });
    const videoAssetId = addReadyAsset(context.app, created.snapshot.project.id, "presenter.mp4", "video", 3_000);
    const assembled = context.app.buildPresenterTimeline({
      projectId: created.snapshot.project.id,
      baseRevision: context.app.readProject(created.snapshot.project.id).revision.number,
      assetIds: [videoAssetId],
      sceneSize: 1
    });
    const scene = assembled.snapshot.scenes[0]!;
    const first = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: assembled.revision.number,
      sceneId: scene.id,
      type: "MetricBackdrop",
      layer: "front",
      startFrame: 0,
      endFrame: 12,
      spatialAnchor: "full_frame",
      semanticAnchor: { type: "absolute", relation: "land_on" },
      motion: { enterFrames: 6, exitFrames: 6 },
      qualityRules: ["semantic_anchor_required", "settled_frame_required", "no_competing_visual", "旧项目的自由文本规则"]
    });
    const second = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: first.revision.number,
      sceneId: scene.id,
      type: "GlowCTA",
      layer: "front",
      startFrame: 2,
      endFrame: 10,
      qualityRules: ["no_competing_visual"]
    });
    const third = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: second.revision.number,
      sceneId: scene.id,
      type: "ProductFan",
      layer: "front",
      startFrame: 14,
      endFrame: 36,
      qualityRules: ["asset_binding_required"]
    });
    const fourth = context.app.createEffectCue({
      projectId: created.snapshot.project.id,
      baseRevision: third.revision.number,
      sceneId: scene.id,
      type: "MetricBackdrop",
      layer: "rear",
      startFrame: 38,
      endFrame: 60,
      qualityRules: ["actor_mask_required"]
    });
    const quality = evaluateQuality(fourth.snapshot, fourth.revision.number);
    const codes = new Set(quality.issues.map((entry) => entry.code));
    assert.ok(codes.has("EFFECT_SEMANTIC_ANCHOR_REQUIRED"));
    assert.ok(codes.has("EFFECT_RULE_SETTLED_FRAME_REQUIRED"));
    assert.equal(codes.has("EFFECT_RULE_CAPTION_SAFE_AREA"), false);
    assert.ok(codes.has("EFFECT_RULE_COMPETING_VISUAL"));
    assert.ok(codes.has("EFFECT_RULE_ASSET_BINDING_REQUIRED"));
    assert.ok(codes.has("EFFECT_RULE_ACTOR_MASK_REQUIRED"));
    assert.ok(codes.has("EFFECT_QUALITY_RULE_UNSUPPORTED"));
  } finally {
    await context.dispose();
  }
});

test("阶段0 HTTP 导入、Scene、Revision 回退与定位链接保持同一状态", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-stage0-test-"));
  const { app: server, application } = await createServer({ workspaceRoot, webOrigin: "http://127.0.0.1:5173" });
  try {
    const createdResponse = await server.inject({ method: "POST", url: "/api/projects", payload: { name: "阶段0合同测试" } });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json() as { revision: { number: number }; snapshot: { project: { id: string } } };
    const projectId = created.snapshot.project.id;
    const sourcePath = await createDeterministicVideoFixture(workspaceRoot);
    const importedResponse = await server.inject({
      method: "POST",
      url: `/api/projects/${projectId}/assets/import-path`,
      payload: { baseRevision: created.revision.number, filePath: sourcePath }
    });
    assert.equal(importedResponse.statusCode, 200);
    assert.equal(await runOneJob(application), true);
    const imported = application.readProject(projectId);
    const readyAsset = imported.snapshot.assets[0];
    assert.equal(readyAsset?.status, "ready", readyAsset?.failureReason ?? "媒体分析未返回失败原因");

    const built = application.buildPresenterTimeline({ projectId, baseRevision: imported.revision.number, assetIds: [readyAsset!.id] });
    const scene = built.snapshot.scenes[0];
    const item = built.snapshot.timeline.items[0];
    assert.ok(scene);
    assert.ok(item);
    const editorResponse = await server.inject({
      method: "GET",
      url: `/api/projects/${projectId}/editor-url?sceneId=${scene.id}&itemId=${item.id}&frame=${scene.startFrame}`
    });
    assert.equal(editorResponse.statusCode, 200);
    const editor = editorResponse.json() as { editorUrl: string; focus: { revision: number } };
    assert.match(editor.editorUrl, new RegExp(`sceneId=${scene.id}`, "u"));
    assert.match(editor.editorUrl, new RegExp(`itemId=${item.id}`, "u"));
    assert.equal(editor.focus.revision, built.revision.number);

    const rolledBack = application.rollbackToRevision({ projectId, baseRevision: built.revision.number, targetRevision: imported.revision.number });
    assert.equal(rolledBack.snapshot.scenes.length, 0);
    assert.equal(rolledBack.snapshot.timeline.items.length, 0);
  } finally {
    await server.close();
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("阶段0 Web 服务与独立 MCP 进程读写同一 Project Revision", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-web-mcp-test-"));
  const { app: server, application } = await createServer({ workspaceRoot, webOrigin: "http://127.0.0.1:5173" });
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: workspaceRoot },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-web-mcp-contract-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const createdResponse = await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Web 与 MCP 同状态测试" } });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json() as { revision: { number: number }; snapshot: { project: { id: string } } };
    const projectId = created.snapshot.project.id;

    const targeted = JSON.parse(textFromToolResult(await client.callTool({ name: "target_project", arguments: { project_id: projectId } }))) as { revision: number };
    assert.equal(targeted.revision, created.revision.number);
    const mcpSceneState = JSON.parse(textFromToolResult(await client.callTool({ name: "create_scene", arguments: {
      base_revision_id: created.revision.number,
      type: "PresenterScene",
      title: "MCP 创建场景",
      purpose: "验证服务和 MCP 共用 Revision",
      start_frame: 0,
      end_frame: 24
    } }))) as { revision: { number: number }; snapshot: { scenes: Array<{ id: string }> } };
    const sceneId = mcpSceneState.snapshot.scenes[0]?.id;
    assert.ok(sceneId);

    const visibleToWeb = await server.inject({ method: "GET", url: `/api/projects/${projectId}` });
    const webState = visibleToWeb.json() as { revision: { number: number }; snapshot: { scenes: Array<{ id: string }> } };
    assert.equal(webState.revision.number, mcpSceneState.revision.number);
    assert.equal(webState.snapshot.scenes[0]?.id, sceneId);

    const rollbackResponse = await server.inject({ method: "POST", url: `/api/projects/${projectId}/revisions/${created.revision.number}/rollback`, payload: { baseRevision: webState.revision.number } });
    assert.equal(rollbackResponse.statusCode, 200);
    const afterWebRollback = JSON.parse(textFromToolResult(await client.callTool({ name: "read_project", arguments: {} }))) as { revision: { number: number }; snapshot: { scenes: unknown[] } };
    assert.equal(afterWebRollback.snapshot.scenes.length, 0);
    assert.equal(afterWebRollback.revision.number, webState.revision.number + 1);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close();
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("VideoFlowCut 插件配置校验真实 Skill 合同，而不是旧 Markdown 标题", async () => {
  const pluginRoot = join(process.cwd(), "plugins", "videoflowcut");
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")) as {
    name: string;
    skills?: string;
    mcpServers?: string;
  };
  const mcpConfig = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { args?: string[]; cwd?: string }>;
  };
  assert.equal(manifest.name, "videoflowcut");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(mcpConfig.mcpServers?.videoflowcut?.args, ["./scripts/mcp-launcher.mjs"]);
  assert.equal(mcpConfig.mcpServers?.videoflowcut?.cwd, ".", "插件配置只能使用相对工作目录");

  for (const skillName of [
    "project-basics",
    "web-editor-operator",
    "production-director",
    "asset-import",
    "visual-asset-sourcing",
    "transcription",
    "voice-production",
    "presenter-motion-director",
    "avatar-performance",
    "visual-explainer-director",
    "evidence-visualization",
    "vlog-director",
    "captions",
    "quality-verification",
    "export",
    "known-errors",
    "audio-finishing"
  ]) {
    const skillPath = join(pluginRoot, "skills", skillName, "SKILL.md");
    await access(skillPath);
    const skill = await readFile(skillPath, "utf8");
    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(skill);
    assert.ok(frontMatter, `${skillName} 缺少 YAML Front Matter`);
    assert.match(frontMatter![1], new RegExp(`^name:\\s*${skillName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`, "mu"), `${skillName} 的 name 必须与目录一致`);
    assert.match(frontMatter![1], /^description:\s*\S+/mu, `${skillName} 缺少 description`);
    // 交接可以按需链接到共享方法，不要求每个入口复制同名章节。
    // 角色路由与交接可达性由 skills-v5-integration / director-material-skills 验证。
    const references = [...skill.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/gu)].map((match) => match[1]!);
    assert.ok(references.length > 0, `${skillName} 应可到达实际方法或操作参考，不用入口字数代表完整性`);
    for (const reference of references) {
      if (/^[a-z]+:\/\//iu.test(reference)) continue;
      await access(resolve(dirname(skillPath), reference));
    }
  }
});

test("video-editor-mcp 可通过 stdio 连接并定位新项目", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-mcp-test-"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: workspaceRoot },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-contract-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    for (const name of [
      "create_project",
      "target_project",
      "read_project",
      "get_editor_url",
      "focus_editor_object",
      "submit_transcription",
      "apply_manual_transcript",
      "apply_script",
      "edit_captions",
      "manage_audio",
      "manage_voice_references",
      "submit_voice_synthesis",
      "submit_speech_placement",
      "apply_semantic_units",
      "update_asset_metadata",
      "manage_asset_requirements",
      "inspect_asset",
      "search_media_candidates",
      "inspect_media_candidate",
      "acquire_media_asset",
      "read_asset_provenance",
      "assemble_presenter_track",
      "compile_presenter_scenes",
      "create_presenter_timeline",
      "manage_actor_performance",
      "manage_visual_treatment",
      "manage_cutaways",
      "replace_scene_asset",
      "manage_effect_cues",
      "start_production_run",
      "record_creative_decision",
      "record_editorial_quality_review",
      "complete_production_run",
      "read_skill_execution_report",
      "validate_project_graph",
      "inspect_composed_frames",
      "align_presenter_to_speech",
      "render_preview_range",
      "run_render_preflight",
      "submit_export",
      "track_export",
      "read_export_artifact",
      "record_export_artifact_review",
      "approve_export_artifact"
    ]) {
      assert.ok(toolNames.has(name), `MCP 缺少 ${name}`);
    }

    const created = JSON.parse(textFromToolResult(await client.callTool({ name: "create_project", arguments: { name: "MCP 合同测试" } }))) as { revision: { number: number }; snapshot: { project: { id: string } } };
    const projectId = created.snapshot.project.id;
    const targeted = JSON.parse(textFromToolResult(await client.callTool({ name: "target_project", arguments: { project_id: projectId } }))) as { projectId: string };
    assert.equal(targeted.projectId, projectId);
    const requested = JSON.parse(textFromToolResult(await client.callTool({ name: "manage_asset_requirements", arguments: {
      base_revision_id: created.revision.number,
      action: "create",
      title: "城市步行 B-roll",
      purpose: "为当前人物口播留下现实生活呼吸。",
      visual_brief: "傍晚城市中景人物慢步行，竖屏上方有字幕留白。",
      query_hints: ["city", "walking", "dusk"]
    } }))) as { revision: { number: number }; snapshot: { assetRequests: Array<{ title: string; status: string }> } };
    assert.equal(requested.revision.number, created.revision.number + 1);
    assert.equal(requested.snapshot.assetRequests[0]?.title, "城市步行 B-roll");
    assert.equal(requested.snapshot.assetRequests[0]?.status, "open");
    const editor = JSON.parse(textFromToolResult(await client.callTool({ name: "get_editor_url", arguments: { project_id: projectId, frame: 0 } }))) as { editorUrl: string };
    assert.match(editor.editorUrl, new RegExp(`projectId=${projectId}`, "u"));
    assert.match(editor.editorUrl, /frame=0/u);
  } finally {
    await transport.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("旧项目 video-editor-mcp 的 edit_captions 接受稀疏样式更新且保留其它默认值", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-mcp-caption-test-"));
  const seedApplication = createApplication(workspaceRoot);
  let projectId = "";
  let seededRevision = 0;
  let captionId = "";
  try {
    const created = seedApplication.createProject({ name: "MCP 字幕稀疏更新测试" });
    projectId = created.snapshot.project.id;
    const speechAssetId = addReadyAsset(seedApplication, projectId, "mcp-caption-speech.wav", "speech");
    const seeded = seedApplication.repository.commit(projectId, seedApplication.readProject(projectId).revision.number, "建立 MCP 字幕测试数据", (snapshot) => {
      // 仅此夹具保留历史单卡模式，以验证旧项目仍能稀疏更新。
      delete snapshot.timeline.captionFormat;
      snapshot.speechSegments.push({
        id: "mcp_caption_segment",
        semanticUnitIds: [],
        text: "MCP 字幕测试",
        order: 0,
        pauseBefore: { durationMs: 0, reason: "sentence" },
        status: "ready"
      });
      snapshot.script = { semanticUnitIds: [], speechSegmentIds: ["mcp_caption_segment"], revision: 0 };
      snapshot.speechSegmentAssets.push({
        id: "mcp_caption_segment_asset",
        speechSegmentId: "mcp_caption_segment",
        voiceReferenceAssetId: speechAssetId,
        assetId: speechAssetId,
        durationMs: 1_000,
        bridgeRunId: "mcp-caption-run",
        schemaVersion: "v1",
        quality: "passed"
      });
      snapshot.speechAsset = {
        id: "mcp_caption_speech_asset",
        assetId: speechAssetId,
        scriptRevision: 0,
        segmentAssetIds: ["mcp_caption_segment_asset"],
        timing: {
          precision: "segment_exact",
          source: "MCP 字幕测试",
          segments: [{ speechSegmentId: "mcp_caption_segment", startMs: 0, endMs: 1_000, startFrame: 0, endFrame: 24 }]
        },
        status: "ready"
      };
      captionId = "mcp_caption_card";
      snapshot.timeline.captions.push({
        id: captionId,
        speechSegmentId: "mcp_caption_segment",
        sourceText: "MCP 字幕测试",
        text: "MCP 字幕测试",
        textMode: "derived",
        startFrame: 0,
        endFrame: 24,
        style: "stable",
        format: { fontSize: 32, fontWeight: 750, color: "#ffffff", bottomPercent: 7, horizontalInsetPercent: 8, textAlign: "center" },
        precision: "segment_exact"
      });
    });
    seededRevision = seeded.revision.number;
  } finally {
    seedApplication.close();
  }

  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: workspaceRoot },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-caption-mcp-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await client.callTool({ name: "target_project", arguments: { project_id: projectId } });
    const result = await client.callTool({ name: "edit_captions", arguments: {
      base_revision_id: seededRevision,
      caption_id: captionId,
      action: "update",
      format: { font_size: 38 }
    } });
    assert.equal(result.isError, undefined, textFromToolResult(result));
    const edited = JSON.parse(textFromToolResult(result)) as { snapshot: { timeline: { captions: CaptionCard[] } } };
    const caption = edited.snapshot.timeline.captions.find((entry) => entry.id === captionId)!;
    assert.equal(caption.format?.fontSize, 38);
    assert.equal(caption.format?.color, "#ffffff", "MCP 未传的样式字段不能被 undefined 覆盖");
    assert.equal(caption.format?.bottomPercent, 7);
  } finally {
    await transport.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("video-editor-mcp 的 manage_audio 接受稀疏 Duck 更新", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-mcp-audio-test-"));
  const seedApplication = createApplication(workspaceRoot);
  let projectId = "";
  let seededRevision = 0;
  let bgmAssetId = "";
  try {
    const created = seedApplication.createProject({ name: "MCP 声音包装稀疏更新测试" });
    projectId = created.snapshot.project.id;
    const presenterAssetId = addReadyAsset(seedApplication, projectId, "mcp-audio-presenter.mp4", "video", 2_000);
    bgmAssetId = addReadyAsset(seedApplication, projectId, "mcp-audio-bgm.wav", "audio", 1_000);
    const assembled = seedApplication.buildPresenterTimeline({
      projectId,
      baseRevision: seedApplication.readProject(projectId).revision.number,
      assetIds: [presenterAssetId],
      sceneSize: 1
    });
    seededRevision = assembled.revision.number;
  } finally {
    seedApplication.close();
  }

  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "mcp"],
    cwd: process.cwd(),
    env: { ...environment, VIDEOCUT_WORKSPACE: workspaceRoot },
    stderr: "pipe"
  });
  const client = new Client({ name: "videocut-audio-mcp-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await client.callTool({ name: "target_project", arguments: { project_id: projectId } });
    const result = await client.callTool({ name: "manage_audio", arguments: {
      base_revision_id: seededRevision,
      action: "create",
      kind: "bgm",
      asset_id: bgmAssetId,
      purpose: "验证 MCP 只修改 Duck 衰减时保留其它默认值",
      loop: true,
      ducking: { reduction_db: -11 }
    } });
    assert.equal(result.isError, undefined, textFromToolResult(result));
    const mixed = JSON.parse(textFromToolResult(result)) as { snapshot: { audioCues: Array<{ kind: string; ducking?: { enabled: boolean; reductionDb: number; attackFrames: number; releaseFrames: number } }> } };
    assert.deepEqual(mixed.snapshot.audioCues[0]?.ducking, { enabled: true, reductionDb: -11, attackFrames: 4, releaseFrames: 14 });
  } finally {
    await transport.close().catch(() => undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
