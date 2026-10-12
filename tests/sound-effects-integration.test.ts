import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { createEffectCue, createMediaAsset, createScene, createTimelineItem } from "@videocut/domain";
import { AssetProviderRegistry, MockAssetProvider, assertProviderMediaAnalysis, assertDownloadedProviderMedia, downloadHttpFile } from "@videocut/acquisition";
import { MixkitSoundProvider, mixkitPage, parseMixkitSoundPage, parseMixkitMusicPage } from "../packages/asset-acquisition/src/mixkit.js";
import type { AssetCandidate, AssetRequest } from "@videocut/contracts";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { evaluateQuality } from "@videocut/quality";
import { bindEffectAudioEvent } from "../packages/edit-application/src/effect-audio-events.js";

function wave() {
  const samples = 4800;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / 48000) * 5000), 44 + 2 * i);
  return data;
}

test("音频候选经真实 Worker/ffprobe 本地化，不伪造视频流或画幅；HTML 与无音轨被拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-sfx-acquisition-"));
  const app = createApplication(root);
  try {
    const project = app.createProject({ name: "独立音效测试", profile: "presenter_motion" });
    const projectId = project.snapshot.project.id;
    const rev = () => app.readProject(projectId).revision.number;
    const requested = app.manageAssetRequirement({ projectId, baseRevision: rev(), action: "create", title: "落定音", purpose: "确认视觉事件", mediaKind: "audio", audioBrief: "紧凑、无语音、短尾", role: "sfx" });
    const request = requested.snapshot.assetRequests[0];
    assert.equal(request.visualBrief, undefined); assert.equal(request.targetAspectRatio, undefined);
    assert.equal(request.fallbackPlan, "ask_user");
    await writeFile(join(root, "tick.wav"), wave());
    const provider = new MockAssetProvider([{ originalAssetId: "tick", name: "tick.wav", filePath: join(root, "tick.wav"), sourceUrl: "https://example.test/tick", }]);
    const result = app.recordAssetSearch({ projectId, baseRevision: rev(), assetRequestId: request.id, provider: "mock", query: "tick", candidates: await provider.search({ request, query: "tick" }) });
    assert.equal(result.candidates[0].kind, "audio"); assert.equal(result.candidates[0].hardFilterPassed, true);
    const acquire = app.acquireAssetCandidate({ projectId, baseRevision: rev(), assetCandidateId: result.candidates[0].id });
    const processor = createMediaJobProcessor(app, undefined, new AssetProviderRegistry([provider]));
    await runOneJob(app, processor);
    assert.equal(app.trackJob(acquire.job.id).status, "succeeded", app.trackJob(acquire.job.id).error);
    await runOneJob(app, processor);
    const asset = app.readProject(projectId).snapshot.assets[0];
    assert.equal(asset.kind, "audio"); assert.equal(asset.role, "sfx"); assert.equal(asset.status, "ready");
    assert.equal(asset.metadata?.hasAudio, true); assert.equal(asset.metadata?.durationMs, 100);
    assert.equal(asset.provenance?.originalAssetId, "tick");
    await writeFile(join(root, "bad.wav"), "<!DOCTYPE html><html>error</html>");
    await assert.rejects(assertDownloadedProviderMedia({ filePath: join(root, "bad.wav"), contentType: "audio/wav", expectedKind: "audio" }), /网页错误页/u);
    assert.throws(() => assertProviderMediaAnalysis({ candidate: { kind: "audio", name: "fake" }, metadata: { durationMs: 500, hasAudio: false, videoCodec: "h264" } }), /音轨/u);
    const before = rev();
    assert.throws(() => app.manageAssetRequirement({ projectId, baseRevision: rev(), action: "update", assetRequestId: request.id, targetAspectRatio: "9:16" }), /视觉参数/u);
    assert.equal(rev(), before);
  } finally { app.repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("Mixkit 解析只检查原站身份和媒体信息，页面变化不猜链接", () => {
  const html = 'data-license="sfxFree" <div data-test-id="audio-player" data-audio-player-item-id-value="2574" data-audio-player-preview-url-value="https://assets.mixkit.co/active_storage/sfx/2574/2574-preview.mp3"><h2 class="item-grid-card__title">Soft &amp; short</h2><div data-test-id="duration">0:02</div>';
  const rows = parseMixkitSoundPage(html, "https://mixkit.co/free-sound-effects/interface/");
  assert.equal(rows[0].kind, "audio"); assert.equal(rows[0].name, "Soft & short"); assert.equal(rows[0].durationMs, 2000);
  assert.equal(rows[0].mimeType, undefined, "试听 MP3 不能冒充下载 WAV 的 MIME");
  assert.equal(parseMixkitSoundPage(html.replace("sfxFree", "unknown"), "x").length, 1);
  assert.throws(() => parseMixkitSoundPage(html.replace("https://assets.mixkit.co", "http://127.0.0.1"), "x"), /结构/u);
});

test("Mixkit 下载核实原文件身份、域名及类型；限流不重试，错误页不留半成品", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "videocut-mixkit-download-"));
  const provider = new MixkitSoundProvider();
  const candidate = { kind: "audio", originalAssetId: "2574" } as AssetCandidate;
  const request = { mediaKind: "audio" } as AssetRequest;
  let calls = 0;
  let mode = "rate";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    calls++;
    assert.equal(options?.redirect, String(input).startsWith("https://mixkit.co/") ? "manual" : "error", "页面显式校验同站跳转，媒体不跟随未知跳转");
    assert.ok(options?.signal, "网络请求必须有超时");
    if (mode === "rate") return new Response("limited", { status: 429 });
    if (String(input).startsWith("https://mixkit.co/")) return new Response(
      `<div data-download--modal-url-value="https://assets.mixkit.co/active_storage/sfx/${mode === "wrong_id" ? "9999/9999" : "2574/2574"}.wav"></div>`,
      { headers: { "content-type": "text/html" } },
    );
    return new Response(mode === "html" ? "<!DOCTYPE html><html>failed</html>" : new Uint8Array(wave()), { headers: { "content-type": "audio/wav" } });
  });
  try {
    await assert.rejects(provider.search({ request, query: "interface" }), /限流/u);
    assert.equal(calls, 1);
    mode = "wrong_id";
    await assert.rejects(provider.download({ candidate, temporaryDirectory: root }), /对应 WAV/u);
    assert.equal(calls, 2, "身份不符不尝试下载");
    await assert.rejects(downloadHttpFile("https://example.test/2574.wav", root, "test.wav", "audio", undefined, {}, { allowedHosts: ["assets.mixkit.co"] }), /域名/u);
    assert.equal(calls, 2, "域名不符不发网络请求");
    mode = "html";
    await assert.rejects(provider.download({ candidate, temporaryDirectory: root }), /网页错误页/u);
    assert.deepEqual(await readdir(root), []);
    mode = "valid";
    const downloaded = await provider.download({ candidate, temporaryDirectory: root });
    assert.deepEqual(await readFile(downloaded.filePath), wave());
    assert.equal(downloaded.fileName, "mixkit-2574.wav");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Mixkit 分类迁移仅跟随有限同站公开页，音乐不能借用音效许可", async (t) => {
  let target = "/free-stock-music/discover/minimalism/", calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls++;
    if (String(input).endsWith("/tag/minimalism/")) return new Response(null, { status: 301, headers: { location: target } });
    return new Response("公开音乐分类", { headers: { "content-type": "text/html" } });
  });
  assert.equal(await mixkitPage("/free-stock-music/tag/minimalism/"), "公开音乐分类");
  assert.equal(calls, 2);
  for (target of ["https://example.test/free-stock-music/", "http://127.0.0.1/private", "/account/", "/free-stock-music/tag/minimalism/"]) {
    calls = 0;
    await assert.rejects(mixkitPage("/free-stock-music/tag/minimalism/"), /跳转/u);
    assert.equal(calls, target.endsWith("/tag/minimalism/") ? 4 : 1);
  }
  const html = '<div data-test-id="audio-player" data-audio-player-item-id-value="12" data-audio-player-preview-url-value="https://assets.mixkit.co/music/12/12.mp3"><h2 class="item-grid-card__title">技术曲目</h2><div data-test-id="duration">0:30</div>';
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videocut-sfx-event-"));
  const app = createApplication(root);
  const created = app.createProject({ name: "声音关联测试", profile: "presenter_motion" });
  const projectId = created.snapshot.project.id;
  const rev = () => app.readProject(projectId).revision.number;
  let effectId = "", soundId = "";
  app.repository.commit(projectId, rev(), "独立测试素材", (s) => {
    const visual = createMediaAsset({ name: "test.mp4", kind: "video", managedPath: "assets/test.mp4", sourceHash: "v", role: "a_roll" });
    Object.assign(visual, { status: "ready", metadata: { durationMs: 10_000, fps: 30, width: 1080, height: 1920, hasAudio: false } });
    const sound = createMediaAsset({ name: "test.wav", kind: "audio", managedPath: "assets/test.wav", sourceHash: "s", role: "sfx" });
    Object.assign(sound, { status: "ready", metadata: { durationMs: 1000, hasAudio: true, audioCodec: "pcm_s16le" } });
    s.assets.push(visual, sound); soundId = sound.id;
    s.timeline.items.push(createTimelineItem({ trackId: s.timeline.tracks.find((t) => t.name === "Actor / A-roll")!.id, assetId: visual.id, startFrame: 0, endFrame: 300, sourceStartFrame: 0, sourceEndFrame: 300 }));
    const scene = createScene({ type: "PresenterScene", title: "测试场景", purpose: "事件同步", startFrame: 0, endFrame: 300 });
    s.scenes.push(scene);
    const effect = createEffectCue({ sceneId: scene.id, type: "GlowCTA", layer: "front", startFrame: 50, endFrame: 110, props: { text: "测试" } });
    effectId = effect.id; s.effectCues.push(effect);
  });
  const add = () => app.manageAudio({ projectId, baseRevision: rev(), action: "create", kind: "sfx", assetId: soundId, purpose: "标题落定", eventFrame: 62, onsetOffsetFrames: 2, effectEvent: { effectCueId: effectId, eventName: "标题稳定", localFrame: 15, syncOffsetFrames: -3 } });
  return { app, projectId, rev, effectId, soundId, add, close: async () => { app.repository.close(); await rm(root, { recursive: true, force: true }); } };
}

test("音效候选可放置但不伪称复听；确认仅限当前源范围，变更后重新待审", async () => {
  const f = await fixture();
  try {
    const initial = f.add();
    const audioId = initial.snapshot.audioCues[0].id;
    assert.equal(initial.snapshot.audioCues[0].onsetReview?.status, "inconclusive");
    const pending = evaluateQuality(initial.snapshot, initial.revision.number);
    assert.equal(pending.technical.some((entry) => entry.code === "SFX_ONSET_REVIEW_REQUIRED"), false);
    assert.ok(pending.editorial.audio.some((entry) => entry.code === "SFX_ONSET_REVIEW_REQUIRED" && entry.objectId === audioId && entry.level === "blocking"));
    const patch = (extra: Partial<Parameters<typeof f.app.manageAudio>[0]>) => f.app.manageAudio({ projectId: f.projectId, baseRevision: f.rev(), action: "update", audioCueId: audioId, ...extra });
    const before = f.rev();
    for (const review of [{ status: "passed", note: "无效枚举不能使未审声音获得已听过的确认。" }, { status: "confirmed", note: "太短" }]) {
      assert.throws(() => patch({ onsetReview: review as never }), /起音审阅/u);
      assert.equal(f.rev(), before);
    }
    const confirmed = patch({ onsetReview: { status: "confirmed", note: "固定测试记录仅测试状态传播，不声称正式视频或测试音已获得听觉审美通过。" } });
    assert.equal(evaluateQuality(confirmed.snapshot, confirmed.revision.number).issues.some((entry) => entry.code === "SFX_ONSET_REVIEW_REQUIRED"), false);
    const gain = patch({ gainDb: -12 });
    assert.deepEqual(gain.snapshot.audioCues[0].onsetReview, confirmed.snapshot.audioCues[0].onsetReview, "只调增益不改源起音；整片听感仍由Revision审片负责");
    const changedRange = patch({ sourceEndFrame: 20 });
    assert.equal(changedRange.snapshot.audioCues[0].onsetReview?.status, "inconclusive");
    patch({ onsetReview: { status: "confirmed", note: "再次固定测试状态，用于验证源起点及偏移变化会失效。" } });
    const changedOnset = patch({ onsetOffsetFrames: 3 });
    assert.equal(changedOnset.snapshot.audioCues[0].onsetReview?.status, "inconclusive");
    assert.equal(changedOnset.snapshot.timeline.items.find((item) => item.id === changedOnset.snapshot.audioCues[0].timelineItemId)?.startFrame, 59);
    const legacy = structuredClone(changedOnset.snapshot);
    delete legacy.audioCues[0].onsetReview;
    assert.ok(evaluateQuality(legacy, changedOnset.revision.number).editorial.audio.some((entry) => entry.code === "SFX_ONSET_REVIEW_REQUIRED"), "旧数据没有确认记录不推断已听过");
    const beforeBgm = f.rev();
    assert.throws(() => f.app.manageAudio({ projectId: f.projectId, baseRevision: f.rev(), action: "create", kind: "bgm", assetId: f.soundId, purpose: "无效测试", loop: true, onsetReview: { status: "inconclusive", note: "BGM不接受SFX起音确认参数，不能静默忽略。" } }), /BGM/u);
    assert.equal(f.rev(), beforeBgm);
  } finally { await f.close(); }
});

test("18帧持续动作显式绑定时长，点事件可保留21帧尾音且两者保持待审", async () => {
  const f = await fixture();
  try {
    f.app.repository.commit(f.projectId, f.rev(), "准备独立范围合同", (snapshot) => {
      snapshot.timeline.fps = 24;
      snapshot.timeline.width = 1080; snapshot.timeline.height = 1920;
      snapshot.timeline.items[0].endFrame = 1500; snapshot.timeline.items[0].sourceEndFrame = 1500;
      snapshot.scenes[0].endFrame = 1500;
    });
    const job = f.app.submitManagedMotion({ projectId: f.projectId, baseRevision: f.rev(), idempotencyKey: "duration-contract", work: { name: "持续事件协议测试", creativeBrief: "隔离验证持续范围与点事件两种参数，不作为实际作品的审美判断。", source: "export default function M(){return null}", props: {}, imageBindings: {}, width: 1080, height: 1920, fps: 24, durationInFrames: 245, } });
    const asset = f.app.completeManagedMotion({ projectId: f.projectId, jobId: job.id, sourceHash: "fixture", engineVersion: "fixture-only", metadata: { durationMs: 10208, width: 1080, height: 1920, fps: 24, hasAudio: false, videoCodec: "h264" }, eventMap: { version: String(job.payload.version), fps: 24, frameCount: 245, events: [{ id: "relation_change", meaning: "关系改变", startFrame: 106, endFrame: 124 }] } });
    await f.app.reviewManagedMotion({ projectId: f.projectId, baseRevision: f.rev(), assetId: asset.id, outcome: "inconclusive", note: "隔离参数验证，没有获得实际连续声画审阅证据。" });
    const state = f.app.createEffectCue({ projectId: f.projectId, baseRevision: f.rev(), sceneId: f.app.readProject(f.projectId).snapshot.scenes[0].id, type: "ManagedMotion", layer: "fullscreen", startFrame: 1003, endFrame: 1248, assetBindings: [{ slot: "motion", assetId: asset.id }] });
    const effectCueId = state.snapshot.effectCues.at(-1)!.id;
    const effectEvent = { effectCueId, eventId: "relation_change", workVersion: asset.motion!.version, eventName: "关系改变", localFrame: 106, endLocalFrame: 124, syncOffsetFrames: -3 };
    const base = { projectId: f.projectId, action: "create" as const, kind: "sfx" as const, assetId: f.soundId, purpose: "待审持续声协议验证", eventFrame: 1106, onsetOffsetFrames: 0, sourceStartFrame: 0, sourceEndFrame: 21, fadeOutFrames: 3, effectEvent };
    const before = f.rev();
    assert.throws(() => f.app.manageAudio({ ...base, baseRevision: before, design: { role: "sfx", durationFrames: 21 } }), /持续声终点/u);
    assert.equal(f.rev(), before);
    const sustained = f.app.manageAudio({ ...base, baseRevision: f.rev(), sourceEndFrame: 18, design: { role: "sfx", durationFrames: 18 } });
    const check = (state: typeof sustained, endFrame: number, sustainedFlag: boolean) => {
      const cue = state.snapshot.audioCues.at(-1)!;
      const item = state.snapshot.timeline.items.find((entry) => entry.id === cue.timelineItemId)!;
      assert.equal(cue.status, "ready"); assert.equal(cue.sustained, sustainedFlag); assert.equal(cue.onsetReview?.status, "inconclusive");
      assert.equal(item.startFrame, 1106); assert.equal(item.endFrame, endFrame); assert.ok(!item.disabled);
    };
    check(sustained, 1124, true);
    f.app.manageAudio({ projectId: f.projectId, baseRevision: f.rev(), action: "remove", audioCueId: sustained.snapshot.audioCues.at(-1)!.id });
    check(f.app.manageAudio({ ...base, baseRevision: f.rev(), effectEvent: { ...effectEvent, endLocalFrame: undefined }, design: { role: "sfx" } }), 1127, false);
  } finally { await f.close(); }
});

test("动效整体平移同步移动 SFX，作品内部改变/移除停用旧声音，重绑须显式确认", async () => {
  const f = await fixture();
  try {
    const first = f.add(); const audioId = first.snapshot.audioCues[0].id;
    assert.equal(first.snapshot.scenes[0].status, "draft", "真实 Presenter 场景默认 draft，但有效动效已可绑定声音");
    assert.equal(first.snapshot.audioCues[0].status, "ready");
    const signature = first.snapshot.audioCues[0].effectEvent?.cueSignature;
    assert.equal(first.snapshot.timeline.items.find((i) => i.id === first.snapshot.audioCues[0].timelineItemId)?.startFrame, 60);
    const shifted = f.app.updateEffectCue({ projectId: f.projectId, baseRevision: f.rev(), cueId: f.effectId, startFrame: 80, endFrame: 140 });
    assert.equal(shifted.snapshot.audioCues[0].eventFrame, 92); assert.equal(shifted.snapshot.audioCues[0].status, "ready");
    assert.equal(shifted.snapshot.audioCues[0].effectEvent?.cueSignature, signature);
    const changed = f.app.updateEffectCue({ projectId: f.projectId, baseRevision: f.rev(), cueId: f.effectId, props: { text: "新标题" } });
    assert.equal(changed.snapshot.audioCues[0].status, "stale");
    assert.equal(changed.snapshot.timeline.items.find((i) => i.id === changed.snapshot.audioCues[0].timelineItemId)?.disabled, true);
    assert.ok(changed.revision.impact.stale.includes(audioId));
    const before = f.rev();
    assert.throws(() => f.app.manageAudio({ projectId: f.projectId, baseRevision: f.rev(), action: "update", audioCueId: audioId, gainDb: -2 }), /重新确认/u);
    assert.equal(f.rev(), before);
    const rebound = f.app.manageAudio({ projectId: f.projectId, baseRevision: f.rev(), action: "update", audioCueId: audioId, effectEvent: { effectCueId: f.effectId, eventName: "新标题稳定", localFrame: 15, syncOffsetFrames: -3 } });
    assert.equal(rebound.snapshot.audioCues[0].status, "ready"); assert.notEqual(rebound.snapshot.audioCues[0].effectEvent?.cueSignature, signature);
    const removed = f.app.removeEffectCue({ projectId: f.projectId, baseRevision: f.rev(), cueId: f.effectId });
    assert.equal(removed.snapshot.audioCues[0].status, "stale");
  } finally { await f.close(); }
});

test("draft 不误拦，场景失效、内容无效与帧率变化仍停用关联声音", async () => {
  for (const change of ["stale_scene", "invalid_content", "fps"] as const) {
    const f = await fixture();
    try {
      f.add();
      const state = f.app.repository.commit(f.projectId, f.rev(), "验证失效传播", (s) => {
        if (change === "stale_scene") s.scenes[0].status = "stale";
        if (change === "invalid_content") s.effectCues[0].props = {};
        if (change === "fps") s.timeline.fps = 25;
      });
      assert.equal(state.snapshot.audioCues[0].status, "stale", change);
      assert.equal(state.snapshot.timeline.items.find((i) => i.id === state.snapshot.audioCues[0].timelineItemId)?.disabled, true);
      if (change !== "fps") assert.throws(f.add, /内容可渲染/u);
    } finally { await f.close(); }
  }
});

test("不匹配事件、越界平移、源起点改动均不保留虚假同步", async () => {
  const f = await fixture();
  try {
    const before = f.rev();
    assert.throws(() => f.app.manageAudio({ projectId: f.projectId, baseRevision: f.rev(), action: "create", kind: "sfx", assetId: f.soundId, purpose: "不匹配", eventFrame: 80, onsetOffsetFrames: 0, effectEvent: { effectCueId: f.effectId, eventName: "落定", localFrame: 15 } }), /不一致/u);
    assert.equal(f.rev(), before);
    const state = f.add(); const audioId = state.snapshot.audioCues[0].id;
    assert.throws(() => f.app.manageAudio({ projectId: f.projectId, baseRevision: f.rev(), action: "update", audioCueId: audioId, sourceStartFrame: 2 }), /onset/u);
    f.app.manageAudio({ projectId: f.projectId, baseRevision: f.rev(), action: "update", audioCueId: audioId, onsetOffsetFrames: 20 });
    const moved = f.app.updateEffectCue({ projectId: f.projectId, baseRevision: f.rev(), cueId: f.effectId, startFrame: 0, endFrame: 60 });
    assert.equal(moved.snapshot.audioCues[0].status, "stale", "声音起点越过成片边界，不截断或猜落点");
  } finally { await f.close(); }
});

test("同一个真实事件合同允许起势、落定或贯穿，禁止自行编造内部时间", async () => {
  const f = await fixture();
  try {
    f.app.repository.commit(f.projectId, f.rev(), "固定协议测试画布", (snapshot) => { snapshot.timeline.width = 1080; snapshot.timeline.height = 1920; snapshot.timeline.fps = 30; });
    const job = f.app.submitManagedMotion({ projectId: f.projectId, baseRevision: f.rev(), idempotencyKey: "range-event", work: { name: "事件边界协议测试", props: {}, imageBindings: {}, creativeBrief: "只检验事件绑定边界，不冒充真实视觉作品的渲染验收。", source: "export default function M(){return null}", width: 1080, height: 1920, fps: 30, durationInFrames: 60, } });
    const asset = f.app.completeManagedMotion({ projectId: f.projectId, jobId: job.id, sourceHash: "fixture", engineVersion: "fixture-only", metadata: { durationMs: 2000, width: 1080, height: 1920, fps: 30, hasAudio: false, videoCodec: "h264" }, eventMap: { version: String(job.payload.version), fps: 30, frameCount: 60, events: [{ id: "fan", meaning: "展开", startFrame: 10, endFrame: 40 }, { id: "end", meaning: "片尾", startFrame: 50, endFrame: 60 }] } });
    await f.app.reviewManagedMotion({ projectId: f.projectId, baseRevision: f.rev(), assetId: asset.id, outcome: "inconclusive", note: "仅测试已生成事件的绑定合同，不冒充视觉或声音审阅。" });
    const state = f.app.createEffectCue({ projectId: f.projectId, baseRevision: f.rev(), sceneId: f.app.readProject(f.projectId).snapshot.scenes[0].id, type: "ManagedMotion", layer: "fullscreen", startFrame: 100, endFrame: 160, assetBindings: [{ slot: "motion", assetId: asset.id }] });
    const cue = state.snapshot.effectCues.at(-1)!;
    const input = { effectCueId: cue.id, eventId: "fan", workVersion: asset.motion!.version, eventName: "展开", localFrame: 10 };
    assert.equal(bindEffectAudioEvent(state.snapshot, input, 110).localFrame, 10);
    assert.equal(bindEffectAudioEvent(state.snapshot, { ...input, localFrame: 40 }, 140).localFrame, 40);
    assert.equal(bindEffectAudioEvent(state.snapshot, { ...input, endLocalFrame: 40 }, 110).endLocalFrame, 40);
    assert.equal(bindEffectAudioEvent(state.snapshot, { ...input, eventId: "end", localFrame: 59 }, 159).localFrame, 59);
    for (const wrong of [{ localFrame: 25 }, { endLocalFrame: 39 }]) assert.throws(() => bindEffectAudioEvent(state.snapshot, { ...input, ...wrong }, 110), /范围/u);
  } finally { await f.close(); }
});
