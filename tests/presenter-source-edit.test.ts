import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { assertProjectGraphValid, DomainError, sourceAudioTimingWithinRange } from "@videocut/domain";
import { evaluateQuality } from "@videocut/quality";
import { editPresenterSourceInSnapshot } from "../packages/edit-application/src/presenter-source-edit.js";
import { createServer } from "../apps/server/src/app.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function captionFixture(tokenTimed = true, withFollowing = false, timing: { durationMs: number; ranges: number[][] } = {
  durationMs: 3000, ranges: [[100, 600], [1100, 1600], [2100, 2600]]
}) {
  const root = await mkdtemp(join(tmpdir(), "videocut-source-caption-edit-"));
  const app = createApplication(root);
  const created = app.createProject({ name: "裁剪保留字幕证据" });
  const projectId = created.snapshot.project.id;
  const imported = app.registerImportedAsset({ projectId, baseRevision: created.revision.number,
    name: "presenter.mp4", kind: "video", managedPath: "assets/source/presenter.mp4", sourceHash: "source-edit-caption-fixture",
    provenance: { source: "local_import", acquiredAt: new Date().toISOString() } });
  app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: { durationMs: timing.durationMs, hasAudio: true, videoCodec: "h264", audioCodec: "aac", fps: 25, width: 720, height: 1280 } });
  for (const job of app.listJobs(projectId)) app.updateJob(job.id, { status: "succeeded" });
  const assembled = app.assemblePresenterTrack({ projectId, baseRevision: app.readProject(projectId).revision.number,
    assetIds: withFollowing ? [imported.asset.id, imported.asset.id] : [imported.asset.id] });
  const items = assembled.snapshot.timeline.items;
  const durationFrames = Math.round(timing.durationMs / 1000 * 24);
  app.compilePresenterScenes({ projectId, baseRevision: assembled.revision.number,
    scenes: [{ title: "人物原声", purpose: "验证准确源时间", startFrame: 0, endFrame: durationFrames * (withFollowing ? 2 : 1) }] });
  for (const item of items) {
    app.registerActorPerformance({ projectId, baseRevision: app.readProject(projectId).revision.number,
      timelineItemId: item.id, source: "imported", maskMode: "none", audioMode: "use_source_audio" });
    const texts = ["开头自然。", "这段重复。", "接着讲完。"];
    app.completeSourceAudioCaptionAlignment({ projectId, requestedRevision: app.readProject(projectId).revision.number,
      assetId: imported.asset.id, timelineItemId: item.id, sourceStartFrame: 0, sourceEndFrame: durationFrames,
      timelineStartFrame: item.startFrame, timelineEndFrame: item.endFrame,
      transcriptText: texts.join(""), tokenPrecision: tokenTimed ? "provider_token_timed" : "unavailable",
      tokens: tokenTimed ? texts.map((text, index) => ({ text, startMs: timing.ranges[index]![0]!, endMs: timing.ranges[index]![1]! })) : undefined,
      segments: texts.map((displayText, index) => ({ displayText, startMs: timing.ranges[index]![0]!, endMs: timing.ranges[index]![1]!,
        ...(tokenTimed ? { tokenStartIndex: index, tokenEndIndex: index + 1 } : {}) })),
      bridgeAudit: { workflowId: "provider-source-captions", schemaVersion: "v4", runId: `source-edit-${item.id}`,
        request: { fieldValues: {}, fileSlots: [{ id: "audio", kind: "audio", fileName: "presenter.wav" }] },
        submittedAt: new Date().toISOString(), completedAt: new Date().toISOString(), schemaRetryCount: 0 } });
  }
  return { root, app, projectId, items,
    dispose: async () => { app.close(); await rm(root, { recursive: true, force: true }); } };
}

const keepWithFractionalMillisecondOrigin = [{ sourceStartFrame: 0, sourceEndFrame: 19 }, { sourceStartFrame: 43, sourceEndFrame: 72 }];

test("禁用人物审计记录不阻断成片，重新启用与有效人物过期仍严格校验", async () => {
  const fixture = await captionFixture();
  const { app, projectId, items } = fixture;
  try {
    const before = app.readProject(projectId);
    const after = app.editPresenterSource({ projectId, baseRevision: before.revision.number, timelineItemId: items[0]!.id,
      keepRanges: keepWithFractionalMillisecondOrigin, reason: "删除重复片段后保留原人物审计" });
    const historical = after.snapshot.actorPerformances.find((performance) => performance.timelineItemId === items[0]!.id)!;
    assert.equal(after.snapshot.timeline.items.find((item) => item.id === historical.timelineItemId)!.disabled, true);
    assert.equal(historical.status, "stale", "历史记录不能为通过门禁伪改为 ready");
    assertProjectGraphValid(after.snapshot);
    const issuesFor = (snapshot: typeof after.snapshot, id: string) => evaluateQuality(snapshot, after.revision.number).issues
      .filter((issue) => issue.objectId === id && issue.code.startsWith("ACTOR_"));
    assert.deepEqual(issuesFor(after.snapshot, historical.id), []);

    const reenabled = structuredClone(after.snapshot);
    reenabled.timeline.items.find((item) => item.id === historical.timelineItemId)!.disabled = false;
    assert.ok(issuesFor(reenabled, historical.id).some((issue) => issue.code === "ACTOR_PERFORMANCE_STALE" && issue.level === "blocking"));
    const activeStale = structuredClone(after.snapshot);
    const active = activeStale.actorPerformances.find((performance) => performance.id !== historical.id)!;
    active.status = "stale";
    assert.ok(issuesFor(activeStale, active.id).some((issue) => issue.code === "ACTOR_PERFORMANCE_STALE" && issue.level === "blocking"));

    const dangling = structuredClone(after.snapshot);
    dangling.actorPerformances.find((performance) => performance.id === historical.id)!.timelineItemId = "missing-item";
    assert.ok(issuesFor(dangling, historical.id).some((issue) => issue.code === "ACTOR_ITEM_MISSING" && issue.level === "blocking"));
    assert.throws(() => assertProjectGraphValid(dangling), (error: unknown) => error instanceof DomainError && error.code === "PROJECT_GRAPH_INVALID");
    assert.deepEqual(app.readProject(projectId), after, "质量读取不得修改审计对象或创建 Revision");
  } finally { await fixture.dispose(); }
});

test("禁用人物的 Mask 和生成版本检查也只在重新参与合成时生效", async () => {
  const fixture = await captionFixture();
  try {
    const before = fixture.app.readProject(fixture.projectId);
    const after = fixture.app.editPresenterSource({ projectId: fixture.projectId, baseRevision: before.revision.number,
      timelineItemId: fixture.items[0]!.id, keepRanges: keepWithFractionalMillisecondOrigin, reason: "禁用人物的检查范围回归" });
    for (const maskMode of ["none", "alpha_asset", "embedded_alpha"] as const) {
      const snapshot = structuredClone(after.snapshot);
      const historical = snapshot.actorPerformances.find((performance) => performance.timelineItemId === fixture.items[0]!.id)!;
      historical.maskMode = maskMode;
      historical.source = "generated";
      const actorIssues = () => evaluateQuality(snapshot, after.revision.number).issues.filter((issue) => issue.objectId === historical.id && issue.code.startsWith("ACTOR_"));
      assert.deepEqual(actorIssues(), [], "不渲染的审计记录不能要求重新生成、补 Mask 或连续预览");
      snapshot.timeline.items.find((item) => item.id === historical.timelineItemId)!.disabled = false;
      assert.ok(actorIssues().some((issue) => issue.code === "ACTOR_SPEECH_VERSION_MISMATCH" && issue.level === "blocking"));
      if (maskMode !== "none") assert.ok(actorIssues().some((issue) => issue.code === (maskMode === "alpha_asset" ? "ACTOR_MASK_MISSING" : "ACTOR_EMBEDDED_ALPHA_INVALID")));
    }
  } finally { await fixture.dispose(); }
});

for (const tokenTimed of [true, false]) {
  test(`${tokenTimed ? "token" : "纯段级"}真实毫秒边界按同一帧映射裁剪，不把帧反算毫秒后误拒绝`, async () => {
    // 真实工单的 4390ms 映射到 F105，反算却只有 4375ms；同时覆盖切口下界向上舍入。
    for (const joinMs of [4990, 5010]) {
      const fixture = await captionFixture(tokenTimed, false, { durationMs: 6000, ranges: [[3110, 4390], [4390, joinMs], [joinMs, 5800]] });
      const { app, projectId, items } = fixture;
      try {
        const before = app.readProject(projectId);
        assert.equal(sourceAudioTimingWithinRange(before.snapshot.sourceAudioAlignments[0]!, 24, 3110, 6001), false, "原始 Provider 证据仍不能超过输入音频毫秒时长");
        const after = app.editPresenterSource({ projectId, baseRevision: before.revision.number, timelineItemId: items[0]!.id,
          keepRanges: [{ sourceStartFrame: 0, sourceEndFrame: 105 }, { sourceStartFrame: 120, sourceEndFrame: 144 }], reason: "工单毫秒到帧边界回归" });
        assert.equal(after.revision.number, before.revision.number + 1);
        assert.equal(after.snapshot.timeline.durationInFrames, 129);
        assertProjectGraphValid(after.snapshot);
        assert.deepEqual(after.snapshot.timeline.captions.map((card) => [card.startFrame, card.endFrame]), [[75, 105], [105, 124]]);
        const derived = after.snapshot.sourceAudioAlignments.filter((alignment) => alignment.sourceEdit);
        assert.equal(sourceAudioTimingWithinRange(derived[0]!, 24, 3110, 4395), true);
        assert.equal(sourceAudioTimingWithinRange(derived[0]!, 24, 3110, 4396), false);
        assert.equal(sourceAudioTimingWithinRange(derived[1]!, 24, 4980, 5800), true);
        assert.equal(sourceAudioTimingWithinRange(derived[1]!, 24, 4979, 5800), false);
        assert.deepEqual(derived.map((alignment) => [alignment.segments[0]!.startMs, alignment.segments[0]!.endMs]), [[3110, 4390], [joinMs, 5800]]);
        assert.deepEqual(evaluateQuality(after.snapshot, after.revision.number).issues.filter((issue) => issue.level === "blocking" && /SOURCE_.*(MAPPING|EVIDENCE|SEGMENTS|PROGRAM|COVERAGE)/.test(issue.code)), []);
        // 真正越过帧界、伪造 Provider 时间仍须拒绝，不能把修复变成忽略证据。
        const tampered = structuredClone(after.snapshot);
        const evidence = tampered.sourceAudioAlignments.find((alignment) => alignment.id === derived[0]!.id)!;
        evidence.segments[0]!.endMs = 4396; // 四舍五入已是 F106。
        if (evidence.tokens) evidence.tokens[0]!.endMs = 4396;
        assert.throws(() => assertProjectGraphValid(tampered), (error: unknown) => error instanceof DomainError && error.code === "PROJECT_GRAPH_INVALID");
        assert.ok(evaluateQuality(tampered, after.revision.number).issues.some((issue) => issue.level === "blocking" && /SOURCE_AUDIO_ALIGNMENT_(EVIDENCE|SEGMENTS)_INVALID/.test(issue.code)));
        const firstItem = after.snapshot.timeline.items.find((item) => item.id === derived[0]!.sourceTimelineItemId)!;
        const again = app.editPresenterSource({ projectId, baseRevision: after.revision.number, timelineItemId: firstItem.id,
          keepRanges: [{ sourceStartFrame: 75, sourceEndFrame: 105 }], reason: "同一真实边界再次裁剪不积累漂移" });
        assertProjectGraphValid(again.snapshot);
        assert.equal(again.snapshot.timeline.captions[0]!.sourceEndFrame, 139);
        const retained = again.snapshot.timeline.captions.find((card) => card.sourceStartFrame === 75)!;
        assert.equal(retained.endFrame, 30);
        if (tokenTimed) {
          const rebuilt = app.applySourceCaptionProgram({ projectId, baseRevision: again.revision.number, alignmentId: retained.sourceAlignmentId!,
            cards: [{ tokenStartIndex: 0, tokenEndIndex: 1, rationale: "裁剪后仍由原始 Provider token 生成" }] });
          assertProjectGraphValid(rebuilt.snapshot);
        }
      } finally { await fixture.dispose(); }
    }
  });
}

async function addPackaging(fixture: Awaited<ReturnType<typeof captionFixture>>) {
  const { app, projectId } = fixture;
  const state = app.readProject(projectId);
  const sceneId = state.snapshot.scenes[0]!.id;
  for (const [startFrame, endFrame] of [[20, 42], [46, 70]]) {
    app.createEffectCue({ projectId, baseRevision: app.readProject(projectId).revision.number, sceneId,
      type: "CameraPunch", layer: "actor", startFrame: startFrame!, endFrame: endFrame! });
  }
  const audio = app.registerImportedAsset({ projectId, baseRevision: app.readProject(projectId).revision.number,
    name: "bgm.wav", kind: "audio", managedPath: "assets/source/bgm.wav", sourceHash: "source-edit-audio",
    provenance: { source: "local_import", acquiredAt: new Date().toISOString() } });
  app.applyMediaAnalysis({ projectId, assetId: audio.asset.id, metadata: { durationMs: 3000, hasAudio: true, audioCodec: "pcm_s16le" } });
  for (const job of app.listJobs(projectId)) app.updateJob(job.id, { status: "succeeded" });
  app.manageAudio({ projectId, baseRevision: app.readProject(projectId).revision.number, action: "create", kind: "bgm",
    assetId: audio.asset.id, purpose: "验证裁剪后的背景声音失效", loop: true, gainDb: -18 });
  app.manageCutaway({ projectId, baseRevision: app.readProject(projectId).revision.number, action: "create",
    hostSceneId: sceneId, assetId: fixture.items[0]!.assetId, mode: "fullscreen", fit: "contain", audioMode: "continue_dialogue",
    startFrame: 48, endFrame: 60, sourceStartFrame: 0, sourceEndFrame: 12, purpose: "验证主线裁剪后需重新确认返回人物", audienceTask: "看清补充内容后回到连续人物主线" });
  return app.readProject(projectId);
}

test("删除使跨切口效果和包装失效、后续效果平移，纯拆分保留包装", async () => {
  for (const splitOnly of [false, true]) {
    const fixture = await captionFixture();
    const { app, projectId, items } = fixture;
    try {
      const before = await addPackaging(fixture);
      const after = app.editPresenterSource({ projectId, baseRevision: before.revision.number, timelineItemId: items[0]!.id,
        keepRanges: splitOnly ? [{ sourceStartFrame: 0, sourceEndFrame: 19 }, { sourceStartFrame: 19, sourceEndFrame: 72 }] : keepWithFractionalMillisecondOrigin,
        reason: "包装传播回归" });
      assertProjectGraphValid(after.snapshot);
      assert.equal(after.snapshot.effectCues[0]!.status, splitOnly ? "ready" : "stale");
      assert.equal(after.snapshot.effectCues[1]!.startFrame, splitOnly ? 46 : 22);
      assert.deepEqual(after.snapshot.effectCues[1]!.motion, before.snapshot.effectCues[1]!.motion);
      assert.equal(after.snapshot.audioCues[0]!.status, splitOnly ? "ready" : "stale");
      assert.equal(after.snapshot.cutaways[0]!.status, splitOnly ? "ready" : "stale");
      assert.equal(after.snapshot.timeline.durationInFrames, splitOnly ? 72 : 48);
      if (!splitOnly) {
        for (const id of [after.snapshot.audioCues[0]!.timelineItemId, after.snapshot.cutaways[0]!.timelineItemId]) {
          assert.equal(after.snapshot.timeline.items.find((item) => item.id === id)!.disabled, true);
        }
        const rechecked = app.manageAudio({ projectId, baseRevision: after.revision.number, action: "update",
          audioCueId: after.snapshot.audioCues[0]!.id, endFrame: 48 });
        assert.equal(rechecked.snapshot.audioCues[0]!.status, "ready");
      }
    } finally { await fixture.dispose(); }
  }
});

test("裁剪保护锁定包装和后续生成型人物绑定", async () => {
  const fixture = await captionFixture(true, true);
  try {
    const before = await addPackaging(fixture);
    for (const mode of ["BGM", "cutaway", "generated"]) {
      const snapshot = structuredClone(before.snapshot);
      if (mode === "generated") snapshot.actorPerformances.find((performance) => performance.timelineItemId === fixture.items[1]!.id)!.source = "generated";
      else {
        const itemId = mode === "BGM" ? snapshot.audioCues[0]!.timelineItemId : snapshot.cutaways[0]!.timelineItemId;
        const trackId = snapshot.timeline.items.find((item) => item.id === itemId)!.trackId;
        snapshot.timeline.tracks.find((track) => track.id === trackId)!.locked = true;
      }
      const unchanged = structuredClone(snapshot);
      assert.throws(() => editPresenterSourceInSnapshot(snapshot, structuredClone(before.revision.impact), {
        timelineItemId: fixture.items[0]!.id, keepRanges: keepWithFractionalMillisecondOrigin, reason: "保护跨对象绑定" }, before.revision.number + 1),
      (error: unknown) => error instanceof DomainError && error.code === (mode === "generated" ? "SOURCE_EDIT_FOLLOWING_ACTOR_UNSUPPORTED" : "TRACK_LOCKED"));
      assert.deepEqual(snapshot, unchanged);
    }
  } finally { await fixture.dispose(); }
});

test("删除整条非最后主画面后不留黑尾，后续场景编译与字幕编辑仍可用", async () => {
  const fixture = await captionFixture(true, true);
  const { app, projectId, items } = fixture;
  try {
    const scenes = app.compilePresenterScenes({ projectId, baseRevision: app.readProject(projectId).revision.number,
      scenes: [{ title: "前段", purpose: "保留", startFrame: 0, endFrame: 72 }, { title: "后段", purpose: "明确删除", startFrame: 72, endFrame: 144 }] });
    const after = app.editPresenterSource({ projectId, baseRevision: scenes.revision.number, timelineItemId: items[1]!.id,
      keepRanges: [], reason: "整条非最后可播放人物片段删除" });
    assert.equal(after.snapshot.timeline.durationInFrames, 72);
    assert.equal(after.snapshot.scenes.find((scene) => scene.title === "后段")!.status, "stale");
    const compiled = app.compilePresenterScenes({ projectId, baseRevision: after.revision.number,
      scenes: [{ title: "保留段", purpose: "后续主工作流", startFrame: 0, endFrame: 72 }] });
    const edited = app.editCaptions({ projectId, baseRevision: compiled.revision.number,
      captionId: compiled.snapshot.timeline.captions[0]!.id, action: "update", format: { fontSize: 36 } });
    assertProjectGraphValid(edited.snapshot);
    const rebuilt = app.assemblePresenterTrack({ projectId, baseRevision: edited.revision.number, assetIds: [items[0]!.assetId] });
    assertProjectGraphValid(rebuilt.snapshot);
    assert.equal(rebuilt.snapshot.sourceAudioAlignments.length, 0, "显式重建主轨时旧审计仅留历史 Revision，不能悬挂不存在的 Item");
  } finally { await fixture.dispose(); }
});

test("HTTP 与实时 MCP Schema 使用同一原子裁剪合同", async () => {
  const fixture = await captionFixture();
  const server = await createServer({ workspaceRoot: fixture.root });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/server/src/mcp.ts"], cwd: process.cwd(),
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), VIDEOCUT_WORKSPACE: fixture.root }, stderr: "pipe" });
  const client = new Client({ name: "source-edit-contract-test", version: "1" });
  try {
    await client.connect(transport);
    const schema = (await client.listTools()).tools.find((tool) => tool.name === "edit_presenter_source")!;
    assert.ok(schema);
    assert.deepEqual(schema.inputSchema.required, ["base_revision_id", "timeline_item_id", "keep_ranges", "reason"]);
    const before = fixture.app.readProject(fixture.projectId);
    const result = await client.callTool({ name: "edit_presenter_source", arguments: { project_id: fixture.projectId,
      base_revision_id: before.revision.number, timeline_item_id: fixture.items[0]!.id,
      keep_ranges: [{ source_start_frame: 0, source_end_frame: 19 }, { source_start_frame: 43, source_end_frame: 72 }], reason: "实时工具原子裁剪" } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const after = fixture.app.readProject(fixture.projectId);
    assert.equal(after.revision.number, before.revision.number + 1);
    const active = after.snapshot.timeline.items.find((item) => !item.disabled)!;
    const response = await server.app.inject({ method: "POST", url: `/api/projects/${fixture.projectId}/timeline/edit-presenter-source`,
      payload: { baseRevision: after.revision.number, timelineItemId: active.id,
        keepRanges: [{ sourceStartFrame: 0, sourceEndFrame: 16 }], reason: "HTTP 同一应用合同" } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(fixture.app.readProject(fixture.projectId).revision.number, after.revision.number + 1);
  } finally { await client.close(); await server.app.close(); server.application.close(); await fixture.dispose(); }
});

for (const tokenTimed of [true, false]) {
  test(`${tokenTimed ? "token" : "纯段级"}字幕裁剪后保留原证据与样式，非整数毫秒切口不累计漂移`, async () => {
    const fixture = await captionFixture(tokenTimed, true);
    const { app, projectId, items } = fixture;
    try {
      const beforeFormat = app.readProject(projectId);
      const cards = beforeFormat.snapshot.timeline.captions.filter((card) => card.sourceTimelineItemId === items[0]!.id);
      const before = app.editCaptions({ projectId, baseRevision: beforeFormat.revision.number, action: "bulk_source_format",
        captionIds: cards.map((card) => card.id), format: { fontSize: 34, bottomPercent: 10 } });
      const originalAlignment = before.snapshot.sourceAudioAlignments[0]!;
      const followingCards = before.snapshot.timeline.captions.filter((card) => card.sourceTimelineItemId === items[1]!.id);
      const after = app.editPresenterSource({ projectId, baseRevision: before.revision.number, timelineItemId: items[0]!.id,
        keepRanges: keepWithFractionalMillisecondOrigin, reason: "在字幕间的已审阅空隙移除中间内容" });
      assertProjectGraphValid(after.snapshot);
      const retained = after.snapshot.timeline.captions.filter((card) => cards.some((original) => original.id === card.id));
      assert.deepEqual(retained.map((card) => card.id), [cards[0]!.id, cards[2]!.id]);
      assert.deepEqual(retained.map((card) => [card.startFrame, card.endFrame]), [[2, 14], [26, 38]]);
      assert.ok(retained.every((card) => card.format?.fontSize === 34 && card.format.bottomPercent === 10));
      const derived = after.snapshot.sourceAudioAlignments.filter((alignment) => alignment.sourceEdit?.parentAlignmentId === originalAlignment.id);
      assert.equal(derived.length, 2);
      assert.equal(derived[1]!.segments[0]!.startMs, 2100, "不能把源时间转成新毫秒后产生二次舍入");
      assert.equal(derived[1]!.sourceEdit!.originSourceFrame, 0);
      assert.equal(derived[1]!.bridgeAudit.runId, originalAlignment.bridgeAudit.runId);
      for (const card of followingCards) {
        const moved = after.snapshot.timeline.captions.find((candidate) => candidate.id === card.id)!;
        assert.equal(moved.startFrame, card.startFrame - 24);
        assert.equal(moved.sourceStartFrame, card.sourceStartFrame);
      }
      const sourceErrors = evaluateQuality(after.snapshot, after.revision.number).issues.filter((issue) => issue.level === "blocking" && /SOURCE_.*(MAPPING|EVIDENCE|SEGMENTS|PROGRAM|COVERAGE)/.test(issue.code));
      assert.deepEqual(sourceErrors, [], "质量系统与 Graph 必须使用同一源原点合同");
      const secondItem = after.snapshot.timeline.items.find((item) => item.id === retained[1]!.sourceTimelineItemId)!;
      const again = app.editPresenterSource({ projectId, baseRevision: after.revision.number, timelineItemId: secondItem.id,
        keepRanges: [{ sourceStartFrame: 47, sourceEndFrame: 70 }], reason: "进一步去掉片段首尾非语音余量" });
      assertProjectGraphValid(again.snapshot);
      const againCard = again.snapshot.timeline.captions.find((card) => card.id === cards[2]!.id)!;
      assert.equal(againCard.sourceStartFrame, cards[2]!.sourceStartFrame);
      assert.equal(againCard.startFrame, 22);
      assert.equal(again.snapshot.sourceAudioAlignments.find((alignment) => alignment.id === againCard.sourceAlignmentId)!.segments[0]!.startMs, 2100);
      if (tokenTimed) {
        const rebuilt = app.applySourceCaptionProgram({ projectId, baseRevision: again.revision.number, alignmentId: againCard.sourceAlignmentId!,
          cards: [{ tokenStartIndex: 0, tokenEndIndex: 1, rationale: "裁剪后仍使用同源完整 token" }] });
        assert.equal(rebuilt.snapshot.timeline.captions.find((card) => card.sourceTimelineItemId === againCard.sourceTimelineItemId)!.startFrame, againCard.startFrame);
      }
    } finally { await fixture.dispose(); }
  });
}

test("穿过字幕的切口、无序范围、在途 Job 与过期 Revision 均原子拒绝", async () => {
  const fixture = await captionFixture();
  const { app, projectId, items } = fixture;
  try {
    const before = app.readProject(projectId);
    for (const keepRanges of [
      [{ sourceStartFrame: 8, sourceEndFrame: 72 }],
      [{ sourceStartFrame: 43, sourceEndFrame: 72 }, { sourceStartFrame: 0, sourceEndFrame: 19 }],
      [{ sourceStartFrame: -1, sourceEndFrame: 72 }],
      [{ sourceStartFrame: 0, sourceEndFrame: 100 }], []
    ]) {
      assert.throws(() => app.editPresenterSource({ projectId, baseRevision: before.revision.number, timelineItemId: items[0]!.id, keepRanges, reason: "边界拒绝回归" }), DomainError);
      assert.deepEqual(app.readProject(projectId), before, "失败不能留下半个裁剪或半份字幕");
    }
    assert.throws(() => app.editPresenterSource({ projectId, baseRevision: before.revision.number - 1, timelineItemId: items[0]!.id,
      keepRanges: keepWithFractionalMillisecondOrigin, reason: "过期提交" }));
    const pending = app.submitTranscription({ projectId, assetId: items[0]!.assetId });
    assert.throws(() => app.editPresenterSource({ projectId, baseRevision: before.revision.number, timelineItemId: items[0]!.id,
      keepRanges: keepWithFractionalMillisecondOrigin, reason: "未完成任务时拒绝" }), (error: unknown) => error instanceof DomainError && error.code === "SOURCE_EDIT_PENDING_JOBS");
    assert.equal(app.trackJob(pending.id).status, "queued");
    assert.deepEqual(app.readProject(projectId), before);
  } finally { await fixture.dispose(); }
});

test("裁剪派生字幕不能改写父 Provider token 或伪造来源", async () => {
  const fixture = await captionFixture();
  const { app, projectId, items } = fixture;
  try {
    const after = app.editPresenterSource({ projectId, baseRevision: app.readProject(projectId).revision.number, timelineItemId: items[0]!.id,
      keepRanges: keepWithFractionalMillisecondOrigin, reason: "检查父证据完整性" });
    const tampered = structuredClone(after.snapshot);
    const derived = tampered.sourceAudioAlignments.find((alignment) => alignment.sourceEdit)!;
    derived.tokens![0]!.startMs += 1;
    assert.throws(() => assertProjectGraphValid(tampered), DomainError);
    const cycle = structuredClone(after.snapshot);
    const self = cycle.sourceAudioAlignments.find((alignment) => alignment.sourceEdit)!;
    self.sourceEdit!.parentAlignmentId = self.id;
    assert.throws(() => assertProjectGraphValid(cycle), DomainError);
  } finally { await fixture.dispose(); }
});

test("原声人物视频可在同一 Revision 中删除中间重复段并保留声画源坐标", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-source-edit-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "原声片段编辑回归" });
    const projectId = created.snapshot.project.id;
    const imported = app.registerImportedAsset({ projectId, baseRevision: created.revision.number,
      name: "presenter.mp4", kind: "video", managedPath: "assets/source/presenter.mp4", sourceHash: "source-edit-fixture",
      provenance: { source: "local_import", acquiredAt: new Date().toISOString() } });
    app.applyMediaAnalysis({ projectId, assetId: imported.asset.id,
      metadata: { durationMs: 3000, hasAudio: true, videoCodec: "h264", audioCodec: "aac", fps: 25, width: 720, height: 1280 } });
    for (const job of app.listJobs(projectId)) app.updateJob(job.id, { status: "succeeded" });
    const assembled = app.assemblePresenterTrack({ projectId, baseRevision: app.readProject(projectId).revision.number, assetIds: [imported.asset.id] });
    const item = assembled.snapshot.timeline.items[0]!;
    const planned = app.compilePresenterScenes({ projectId, baseRevision: assembled.revision.number,
      scenes: [{ title: "原声人物", purpose: "保留主声画连续性", startFrame: 0, endFrame: 72 }] });
    const before = app.registerActorPerformance({ projectId, baseRevision: planned.revision.number, timelineItemId: item.id,
      source: "imported", maskMode: "none", audioMode: "use_source_audio" });
    const edit = (app as unknown as { editPresenterSource?: (input: unknown) => typeof before }).editPresenterSource;
    assert.equal(typeof edit, "function", "平台必须提供真正修改原声声画使用范围的原子命令");
    const after = edit!.call(app, { projectId, baseRevision: before.revision.number, timelineItemId: item.id,
      keepRanges: [{ sourceStartFrame: 0, sourceEndFrame: 24 }, { sourceStartFrame: 48, sourceEndFrame: 72 }],
      reason: "移除经源片审阅确认的中间重复段" });
    const active = after.snapshot.timeline.items.filter((candidate) => !candidate.disabled);
    assert.deepEqual(active.map((candidate) => [candidate.startFrame, candidate.endFrame, candidate.sourceStartFrame, candidate.sourceEndFrame]),
      [[0, 24, 0, 24], [24, 48, 48, 72]]);
    assert.equal(after.snapshot.timeline.durationInFrames, 48);
    assert.equal(after.revision.number, before.revision.number + 1);
    assert.ok(active.every((candidate) => after.snapshot.actorPerformances.some((performance) => performance.timelineItemId === candidate.id && performance.audioMode === "use_source_audio")));
    assert.equal(app.listJobs(projectId).length, 1, "确定性剪辑不能隐式生成新素材或 Job");
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
