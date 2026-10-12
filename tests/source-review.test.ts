import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../apps/server/src/app.js";
import { inspectAsset } from "../apps/server/src/source-review.js";
import { probeMedia, runProcess } from "@videocut/speech";
import { motionFixture } from "./fixtures/managed-motion.js";
import { millisecondsToFrames } from "@videocut/domain";

async function createSourceReviewFixture(directory: string, size = "96x72"): Promise<string> {
  const path = join(directory, "source-review-fixture.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=24:duration=3`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=1",
    "-filter_complex", "[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]",
    "-map", "0:v:0",
    "-map", "[a]",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    "-movflags", "+faststart",
    path
  ]);
  return path;
}

async function createSpeechReviewFixture(directory: string): Promise<string> {
  const path = join(directory, "source-review-speech.m4a");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=48000:duration=2",
    "-c:a", "aac",
    "-movflags", "+faststart",
    path
  ]);
  return path;
}

test("纯音频审阅接受旁白统一尾帧并保留真实毫秒尾音，仍拒绝多一帧", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-review-audio-tail-"));
  const server = await createServer({ workspaceRoot: root }), app = server.application;
  try {
    const created = app.createProject({ name: "旁白尾帧边界" });
    const projectId = created.snapshot.project.id;
    for (const seconds of [2.07, 2.01, 38.07]) {
      const current = app.readProject(projectId);
      const registered = app.registerImportedAsset({ projectId, baseRevision: current.revision.number, name: `speech-${seconds}.wav`, kind: "speech", managedPath: `assets/source/speech-${seconds}.wav` });
      const path = join(created.snapshot.project.rootPath, registered.asset.managedPath);
      await mkdir(dirname(path), { recursive: true });
      await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=520:sample_rate=16000:duration=${seconds}`, "-c:a", "pcm_s16le", path]);
      const metadata = await probeMedia(path);
      app.applyMediaAnalysis({ projectId, assetId: registered.asset.id, metadata });
      const before = app.readProject(projectId), jobs = app.repository.listJobs(projectId);
      const endFrame = millisecondsToFrames(metadata.durationMs, before.snapshot.timeline.fps);
      const input = { projectId, assetId: registered.asset.id, mode: "range" as const, sourceStartFrame: 0, sourceEndFrame: endFrame };
      const result = await inspectAsset(app, input);
      assert.equal(result.sourceRange!.endFrame, endFrame);
      assert.equal(result.sourceRange!.endMs, metadata.durationMs, "帧坐标取整不改变实际音频终点");
      const proxy = await probeMedia(join(created.snapshot.project.rootPath, result.proxy!.relativePath));
      assert.ok(proxy.durationMs >= metadata.durationMs - 1 && proxy.durationMs <= metadata.durationMs + 40, "连续代理应保留尾音");
      const overview = await inspectAsset(app, { projectId, assetId: registered.asset.id, mode: "overview" });
      assert.equal(overview.sourceRange!.endFrame, endFrame);
      assert.equal(overview.requestableRanges.at(-1)!.endMs, metadata.durationMs);
      await assert.rejects(inspectAsset(app, { ...input, sourceEndFrame: endFrame + 1 }), /真实时长/u);
      assert.deepEqual(app.readProject(projectId), before);
      assert.deepEqual(app.repository.listJobs(projectId), jobs);
    }
  } finally { await server.app.close(); app.close(); await rm(root, { recursive: true, force: true }); }
});

test("素材审阅60秒与12秒边界明确，短范围dBFS不得冒充全片LUFS", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-review-limits-"));
  const server = await createServer({ workspaceRoot: root });
  const app = server.application;
  try {
    const created = app.createProject({ name: "音频审阅范围边界" });
    const projectId = created.snapshot.project.id;
    const registered = app.registerImportedAsset({ projectId, baseRevision: created.revision.number, name: "边界音频.wav", kind: "audio", managedPath: "assets/source/limits.wav" });
    const path = join(created.snapshot.project.rootPath, registered.asset.managedPath);
    await mkdir(dirname(path), { recursive: true });
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=61", "-c:a", "pcm_s16le", path]);
    app.applyMediaAnalysis({ projectId, assetId: registered.asset.id, metadata: await probeMedia(path) });
    const before = app.readProject(projectId);
    const jobs = app.repository.listJobs(projectId);
    const fps = before.snapshot.timeline.fps;
    for (const [mode, seconds] of [["range", 60], ["dense", 12]] as const) {
      await assert.rejects(inspectAsset(app, { projectId, assetId: registered.asset.id, mode, sourceStartFrame: 0, sourceEndFrame: seconds * fps + 1 }), new RegExp(`最长${seconds}秒.*${seconds * fps}帧.*不提供LUFS`));
      const result = await inspectAsset(app, { projectId, assetId: registered.asset.id, mode, sourceStartFrame: 0, sourceEndFrame: seconds * fps });
      assert.equal(result.sourceRange!.endFrame, seconds * fps);
      assert.ok(Number.isFinite(result.audio.meanVolumeDb));
      assert.equal("integratedLufs" in result.audio, false);
      assert.equal("truePeakDbfs" in result.audio, false);
    }
    const overview = await inspectAsset(app, { projectId, assetId: registered.asset.id, mode: "overview" });
    assert.equal(overview.sourceRange!.endFrame, 61 * fps);
    assert.equal(overview.audio.meanVolumeDb, undefined);
    assert.deepEqual(app.readProject(projectId), before);
    assert.deepEqual(app.repository.listJobs(projectId), jobs, "审阅或拒绝只允许可重建缓存，不创建Job");
  } finally {
    await server.app.close();
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function createVideoOnlyReviewFixture(directory: string): Promise<string> {
  const path = join(directory, "source-review-video-only.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=96x72:rate=24:duration=3",
    "-map", "0:v:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    path
  ]);
  return path;
}

async function createMismatchedFrameRateReviewFixture(directory: string): Promise<string> {
  const path = join(directory, "source-review-25fps-3_8s.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=96x72:rate=25:duration=3.8",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3.8",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    "-movflags", "+faststart",
    path
  ]);
  return path;
}

async function createVp8VorbisAudioTailFixture(directory: string): Promise<string> {
  const path = join(directory, "source-review-vp8-vorbis-tail.webm");
  // 故意让 Vorbis 音轨比 VP8 画面多 125ms，复现 WebM 容器总时长大于画面可解码范围的素材。
  await runProcess("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=96x72:rate=25:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3.125",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libvpx",
    "-b:v", "300k",
    "-pix_fmt", "yuv420p",
    "-c:a", "libvorbis",
    path
  ]);
  return path;
}

test("inspect_asset 不会把 25fps 源素材的 overview 末帧采样到 24fps 项目边界之外", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-source-review-fps-"));
  const server = await createServer({ workspaceRoot });
  try {
    const created = server.application.createProject({ name: "帧率错配素材审阅", profile: "presenter_motion" });
    const projectId = created.snapshot.project.id;
    const fixture = await createMismatchedFrameRateReviewFixture(workspaceRoot);
    const sourceHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
    const registered = server.application.registerImportedAsset({
      projectId,
      baseRevision: server.application.readProject(projectId).revision.number,
      name: "25fps 源素材.mp4",
      kind: "video",
      managedPath: "assets/source/source-review-25fps.mp4",
      sourceHash,
      provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
    });
    const targetPath = join(server.application.readProject(projectId).snapshot.project.rootPath, registered.asset.managedPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(fixture, targetPath);
    server.application.applyMediaAnalysis({
      projectId,
      assetId: registered.asset.id,
      metadata: await probeMedia(targetPath)
    });

    const overview = await inspectAsset(server.application, {
      projectId,
      assetId: registered.asset.id,
      mode: "overview",
      contactSheetFrames: 12
    });
    assert.equal(overview.contactSheet.frames.length, 12);
    assert.ok(overview.contactSheet.frames.every((frame) => frame.sourceMs < 3_800));
  } finally {
    server.application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("inspect_asset 以 VP8 实际画面帧数约束带 Vorbis 音轨尾巴的 WebM 联系表", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-source-review-vp8-tail-"));
  const server = await createServer({ workspaceRoot });
  const app = server.application;
  try {
    const created = app.createProject({ name: "VP8 与 Vorbis 尾部审阅" });
    const projectId = created.snapshot.project.id;
    const fixture = await createVp8VorbisAudioTailFixture(workspaceRoot);
    const registered = app.registerImportedAsset({
      projectId,
      baseRevision: created.revision.number,
      name: "vp8-vorbis-tail.webm",
      kind: "video",
      managedPath: "assets/source/vp8-vorbis-tail.webm",
      sourceHash: createHash("sha256").update(await readFile(fixture)).digest("hex"),
      provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
    });
    const sourcePath = join(registered.state.snapshot.project.rootPath, registered.asset.managedPath);
    await mkdir(dirname(sourcePath), { recursive: true });
    await copyFile(fixture, sourcePath);
    const metadata = await probeMedia(sourcePath);
    assert.equal(metadata.videoCodec, "vp8");
    assert.equal(metadata.audioCodec, "vorbis");
    assert.ok(metadata.durationMs > 3_000, "容器时长必须包含音轨尾巴");
    app.applyMediaAnalysis({ projectId, assetId: registered.asset.id, metadata });

    const revision = app.readProject(projectId).revision.number;
    const overview = await inspectAsset(app, { projectId, assetId: registered.asset.id, mode: "overview", contactSheetFrames: 16 });
    assert.equal(overview.sourceRange?.endFrame, 72, "25fps 的 75 个实际视频帧在 24fps 项目中只能审阅到 3 秒");
    assert.equal(overview.contactSheet.frames.length, 16);
    assert.ok(overview.contactSheet.frames.every((frame) => frame.sourceFrame < 72 && frame.sourceMs < 3_000));
    for (const frame of overview.contactSheet.frames) {
      await runProcess("ffmpeg", ["-v", "error", "-i", join(registered.state.snapshot.project.rootPath, frame.relativePath), "-frames:v", "1", "-f", "null", "-"]);
    }
    await assert.rejects(inspectAsset(app, {
      projectId,
      assetId: registered.asset.id,
      mode: "range",
      sourceStartFrame: 0,
      sourceEndFrame: 73
    }), /真实时长/u);
    assert.equal(app.readProject(projectId).revision.number, revision, "审阅与越界拒绝均不得改写视频 Revision");
  } finally {
    app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("inspect_asset 完整审阅 245 帧受管作品并准确解码末帧，不把毫秒取整误差变成越界", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-source-review-exact-"));
  const server = await createServer({ workspaceRoot });
  const app = server.application;
  try {
    const created = app.createProject({ name: "受管作品末帧回归", profile: "presenter_motion" });
    const projectId = created.snapshot.project.id;
    const job = app.submitManagedMotion({ projectId, baseRevision: created.revision.number, idempotencyKey: "245-frames", work: { ...motionFixture, fps: 24, durationInFrames: 245 } });
    const path = join(created.snapshot.project.rootPath, `assets/derived/motion/${job.id}/${job.payload.version}/preview.mp4`);
    await mkdir(dirname(path), { recursive: true });
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x320:rate=24", "-frames:v", "245", "-vf", "drawbox=color=red:t=fill:enable='eq(n,244)'", "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
    const metadata = await probeMedia(path);
    assert.equal(metadata.durationMs, 10208, "容器毫秒不足以无损表达 245/24 秒");
    const asset = app.completeManagedMotion({ projectId, jobId: job.id, sourceHash: createHash("sha256").update(await readFile(path)).digest("hex"), engineVersion: "fixture", metadata });
    const revision = app.readProject(projectId).revision.number;
    const range = await inspectAsset(app, { projectId, assetId: asset.id, mode: "range", sourceStartFrame: 0, sourceEndFrame: 245, contactSheetFrames: 8 });
    const overview = await inspectAsset(app, { projectId, assetId: asset.id, mode: "overview", contactSheetFrames: 3 });
    assert.equal(range.sourceRange?.endFrame, 245);
    assert.equal(overview.sourceRange?.endFrame, 245);
    assert.equal(overview.requestableRanges.at(-1)?.endFrame, 245);
    assert.equal(range.contactSheet.frames.at(-1)?.sourceFrame, 244);
    const reference = join(workspaceRoot, "exact-last-frame.jpg");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-i", path, "-vf", "select=eq(n\\,244),scale=480:-2", "-frames:v", "1", "-q:v", "3", reference]);
    assert.deepEqual(await readFile(join(created.snapshot.project.rootPath, range.contactSheet.frames.at(-1)!.relativePath)), await readFile(reference), "抽图必须是实际第 244 帧，而不是末帧前的替代图片");
    const proxyPath = join(created.snapshot.project.rootPath, range.proxy!.relativePath);
    const probe = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "json", proxyPath]));
    assert.equal(Number(probe.streams[0].nb_read_frames), 245);
    await assert.rejects(inspectAsset(app, { projectId, assetId: asset.id, mode: "range", sourceStartFrame: 0, sourceEndFrame: 246 }), /真实时长/u);
    assert.equal(app.readProject(projectId).revision.number, revision, "完整审阅和越界拒绝均不修改视频 Revision");
  } finally {
    app.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("inspect_asset 只生成可重建审阅缓存，并交付 overview、range、dense 的真实声画证据", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-source-review-"));
  const server = await createServer({ workspaceRoot });
  try {
    const created = server.application.createProject({ name: "素材审阅测试", profile: "hybrid" });
    const projectId = created.snapshot.project.id;
    const fixture = await createSourceReviewFixture(workspaceRoot);
    const sourceHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
    const registered = server.application.registerImportedAsset({
      projectId,
      baseRevision: server.application.readProject(projectId).revision.number,
      name: "源素材.mp4",
      kind: "video",
      managedPath: "assets/source/source-review.mp4",
      sourceHash,
      provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
    });
    const targetPath = join(server.application.readProject(projectId).snapshot.project.rootPath, registered.asset.managedPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(fixture, targetPath);
    server.application.applyMediaAnalysis({
      projectId,
      assetId: registered.asset.id,
      metadata: await probeMedia(targetPath)
    });
    server.application.applyTranscript({ projectId, assetId: registered.asset.id, text: "第一句。第二句。", source: "manual" });
    server.application.buildPresenterTimeline({
      projectId,
      baseRevision: server.application.readProject(projectId).revision.number,
      assetIds: [registered.asset.id]
    });
    const revisionBeforeInspect = server.application.readProject(projectId).revision.number;

    const overview = await inspectAsset(server.application, {
      projectId,
      assetId: registered.asset.id,
      mode: "overview",
      contactSheetFrames: 4
    });
    assert.equal(overview.revision, revisionBeforeInspect);
    assert.equal(server.application.readProject(projectId).revision.number, revisionBeforeInspect, "审阅缓存不应创建 Revision");
    assert.equal(overview.contactSheet.frames.length, 4);
    assert.ok(overview.contactSheet.frames.every((frame) => frame.relativePath.startsWith("cache/source-review/")));
    assert.ok(overview.contactSheet.frames.every((frame) => frame.mediaPath.startsWith(`/media/${projectId}/cache/source-review/`)));
    assert.equal(overview.transcript?.timingPrecision, "unavailable");
    assert.ok(overview.usage.timelineItems.length > 0, "返回当前素材在 Timeline 的使用位置");
    assert.ok(overview.requestableRanges.length > 0, "overview 应提供后续短范围候选");
    for (const frame of overview.contactSheet.frames) {
      const file = join(server.application.readProject(projectId).snapshot.project.rootPath, frame.relativePath);
      assert.ok((await stat(file)).size > 0);
    }

    const range = await inspectAsset(server.application, {
      projectId,
      assetId: registered.asset.id,
      mode: "range",
      sourceStartFrame: 12,
      sourceEndFrame: 48,
      contactSheetFrames: 4
    });
    assert.equal(range.proxy?.kind, "video");
    assert.equal(range.proxy?.reviewPath, range.proxy?.mediaPath.replace(/^\/media\//u, "/review/"));
    assert.ok(range.proxy?.relativePath.startsWith("cache/source-review/"));
    assert.ok(range.audio.waveform, "带音轨的短范围应生成波形");
    assert.ok(range.audio.silenceRanges.length >= 1, "静音段应作为辅助证据返回");
    const proxyMetadata = await probeMedia(join(server.application.readProject(projectId).snapshot.project.rootPath, range.proxy!.relativePath));
    assert.equal(proxyMetadata.videoCodec, "h264");
    assert.equal(proxyMetadata.hasAudio, true);

    const dense = await inspectAsset(server.application, {
      projectId,
      assetId: registered.asset.id,
      mode: "dense",
      sourceStartFrame: 24,
      sourceEndFrame: 48
    });
    assert.equal(dense.contactSheet.density, "high");
    assert.ok(dense.contactSheet.frames.length >= 8, "dense 在短窗口内应比 range 提供更高的帧密度");

    const cachedOverview = await inspectAsset(server.application, {
      projectId,
      assetId: registered.asset.id,
      mode: "overview",
      contactSheetFrames: 4
    });
    assert.deepEqual(cachedOverview.contactSheet.frames.map((frame) => frame.relativePath), overview.contactSheet.frames.map((frame) => frame.relativePath), "同一缓存键必须复用同一派生文件");

    const response = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/assets/${registered.asset.id}/inspect`,
      payload: { mode: "range", sourceStartFrame: 12, sourceEndFrame: 48, contactSheetFrames: 3 }
    });
    assert.equal(response.statusCode, 200);
    const fromHttp = response.json() as { mode: string; proxy?: { mediaPath: string }; sourceRange?: { startFrame: number; endFrame: number } };
    assert.equal(fromHttp.mode, "range");
    assert.equal(fromHttp.sourceRange?.startFrame, 12);
    assert.ok(fromHttp.proxy?.mediaPath.startsWith(`/media/${projectId}/`));
    assert.equal(server.application.readProject(projectId).revision.number, revisionBeforeInspect, "HTTP 入口同样不能改 Revision");

    // MCP 必须复用同一个只读服务；不能为了工具入口另建临时素材或不同缓存语义。
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", "mcp"],
      cwd: process.cwd(),
      env: { ...environment, VIDEOCUT_WORKSPACE: workspaceRoot },
      stderr: "pipe"
    });
    const client = new Client({ name: "videocut-source-review-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const catalog = (await client.listTools()).tools;
      const inspectTool = catalog.find((tool) => tool.name === "inspect_asset")!;
      assert.match(inspectTool.description!, /range最长60秒，dense最长12秒/u);
      assert.match(inspectTool.description!, /dBFS.*不提供LUFS或true peak/u);
      const previewTool = catalog.find((tool) => tool.name === "render_preview_range")!;
      assert.match(previewTool.description!, /省略时默认0.*timeline.durationInFrames/u);
      assert.match(previewTool.description!, /result.audio.*integratedLufs.*truePeakDbfs/u);
      const toolResult = await client.callTool({
        name: "inspect_asset",
        arguments: { project_id: projectId, asset_id: registered.asset.id, mode: "dense", source_start_frame: 24, source_end_frame: 48, contact_sheet_frames: 8 }
      });
      const content = (toolResult as { content?: unknown }).content;
      assert.ok(Array.isArray(content), "inspect_asset 必须返回 MCP content 数组");
      const text = content.find((entry): entry is { type: "text"; text: string } => (
        Boolean(entry) && typeof entry === "object" && (entry as { type?: unknown }).type === "text"
          && typeof (entry as { text?: unknown }).text === "string"
      ))?.text;
      assert.ok(text, "inspect_asset 必须返回标准文本结果");
      const fromMcp = JSON.parse(text) as { mode: string; diagnostics: { status: string; sideEffects: string; continuousReview: string }; sourceRange?: { startFrame: number; endFrame: number }; contactSheet: { frames: unknown[] } };
      assert.equal(fromMcp.mode, "dense");
      assert.deepEqual(fromMcp.sourceRange, { startFrame: 24, endFrame: 48, startMs: 1_000, endMs: 2_000, fps: 24 });
      assert.equal(fromMcp.contactSheet.frames.length, 8);
      assert.equal(fromMcp.diagnostics.status, "complete");
      assert.equal(fromMcp.diagnostics.sideEffects, "review_cache_only");
      assert.equal(fromMcp.diagnostics.continuousReview, "available");
      assert.equal(server.application.readProject(projectId).revision.number, revisionBeforeInspect, "MCP 审阅同样不能创建 Revision");
    } finally {
      await transport.close().catch(() => undefined);
    }
  } finally {
    await server.app.close();
    server.application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("宽银幕素材预览缩放保证偶数尺寸，1920×802 不再编码为 960×401", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-source-review-even-"));
  const server = await createServer({ workspaceRoot });
  try {
    const projectId = server.application.createProject({ name: "宽幅代理回归" }).snapshot.project.id;
    const fixture = await createSourceReviewFixture(workspaceRoot, "1920x802");
    const registered = server.application.registerImportedAsset({ projectId, baseRevision: 1, name: "wide.mp4", kind: "video", managedPath: "assets/wide.mp4", sourceHash: createHash("sha256").update(await readFile(fixture)).digest("hex"), provenance: { source: "local_import", acquiredAt: new Date().toISOString() } });
    const root = registered.state.snapshot.project.rootPath;
    const path = join(root, registered.asset.managedPath);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(fixture, path);
    server.application.applyMediaAnalysis({ projectId, assetId: registered.asset.id, metadata: await probeMedia(path) });
    const revision = server.application.readProject(projectId).revision.number;
    const result = await inspectAsset(server.application, { projectId, assetId: registered.asset.id, mode: "range", sourceStartFrame: 0, sourceEndFrame: 48, contactSheetFrames: 4 });
    assert.equal(result.contactSheet.frames.length, 4);
    assert.ok(result.proxy);
    const proxy = await probeMedia(join(root, result.proxy.relativePath));
    assert.equal(proxy.width! % 2, 0);
    assert.equal(proxy.height! % 2, 0);
    assert.equal(proxy.videoCodec, "h264");
    assert.equal(proxy.hasAudio, true);
    await runProcess("ffmpeg", ["-v", "error", "-i", join(root, result.proxy.relativePath), "-f", "null", "-"]);
    assert.equal(server.application.readProject(projectId).revision.number, revision);
  } finally { await server.app.close(); server.application.close(); await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("inspect_asset 把 SpeechAsset 当作连续音频候选，范围复核会生成音频代理与波形", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-source-review-speech-"));
  const server = await createServer({ workspaceRoot });
  try {
    const created = server.application.createProject({ name: "旁白审阅测试", profile: "presenter_motion" });
    const projectId = created.snapshot.project.id;
    const fixture = await createSpeechReviewFixture(workspaceRoot);
    const sourceHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
    const registered = server.application.registerImportedAsset({
      projectId,
      baseRevision: server.application.readProject(projectId).revision.number,
      name: "旁白候选.m4a",
      kind: "speech",
      managedPath: "assets/source/source-review-speech.m4a",
      sourceHash,
      provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
    });
    const targetPath = join(server.application.readProject(projectId).snapshot.project.rootPath, registered.asset.managedPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(fixture, targetPath);
    server.application.applyMediaAnalysis({
      projectId,
      assetId: registered.asset.id,
      metadata: await probeMedia(targetPath)
    });

    const beforeInspect = server.application.readProject(projectId).revision.number;
    const review = await inspectAsset(server.application, {
      projectId,
      assetId: registered.asset.id,
      mode: "range",
      sourceStartFrame: 0,
      sourceEndFrame: 24
    });
    assert.equal(review.proxy?.kind, "audio");
    assert.equal(review.proxy?.reviewPath, review.proxy?.mediaPath.replace(/^\/media\//u, "/review/"));
    assert.ok(review.proxy?.relativePath.endsWith(".m4a"));
    assert.ok(review.audio.waveform, "speech 范围复核必须生成波形");
    assert.equal(server.application.readProject(projectId).revision.number, beforeInspect, "语音审阅同样不应创建 Revision");
  } finally {
    await server.app.close();
    server.application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("inspect_asset 对无音轨 derived 视频与 derived 音频按真实媒体流选择审阅路径", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-source-review-derived-"));
  const server = await createServer({ workspaceRoot });
  try {
    const created = server.application.createProject({ name: "派生素材审阅测试", profile: "hybrid" });
    const projectId = created.snapshot.project.id;
    const videoFixture = await createVideoOnlyReviewFixture(workspaceRoot);
    const audioFixture = await createSpeechReviewFixture(workspaceRoot);

    const registerDerived = async (name: string, fixture: string) => {
      const sourceHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
      const registered = server.application.registerImportedAsset({
        projectId,
        baseRevision: server.application.readProject(projectId).revision.number,
        name,
        kind: "derived",
        managedPath: `assets/derived/${name}`,
        sourceHash,
        provenance: { source: "generated", provider: "source-review-test", acquiredAt: new Date().toISOString() }
      });
      const targetPath = join(server.application.readProject(projectId).snapshot.project.rootPath, registered.asset.managedPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(fixture, targetPath);
      server.application.applyMediaAnalysis({
        projectId,
        assetId: registered.asset.id,
        metadata: await probeMedia(targetPath)
      });
      return { assetId: registered.asset.id, targetPath };
    };

    const video = await registerDerived("generated-video.mp4", videoFixture);
    const audio = await registerDerived("generated-audio.m4a", audioFixture);
    const videoReview = await inspectAsset(server.application, {
      projectId,
      assetId: video.assetId,
      mode: "range",
      sourceStartFrame: 0,
      sourceEndFrame: 24,
      contactSheetFrames: 4
    });
    assert.equal(videoReview.proxy?.kind, "video", "有 videoCodec 和时长的 derived 必须按视频审阅");
    assert.equal(videoReview.contactSheet.frames.length, 4, "derived 视频必须生成联系表");
    assert.equal(videoReview.audio.hasAudio, false, "无音轨视频必须明确降级而非伪造波形");
    assert.equal(videoReview.audio.waveform, undefined);
    const videoProxy = await probeMedia(join(server.application.readProject(projectId).snapshot.project.rootPath, videoReview.proxy!.relativePath));
    assert.equal(videoProxy.hasAudio, false, "无音轨范围代理仍必须可播放");

    const audioReview = await inspectAsset(server.application, {
      projectId,
      assetId: audio.assetId,
      mode: "range",
      sourceStartFrame: 0,
      sourceEndFrame: 24
    });
    assert.equal(audioReview.proxy?.kind, "audio", "无视觉流的 derived 必须按音频审阅");
    assert.ok(audioReview.audio.waveform, "derived 音频范围复核必须生成波形");
  } finally {
    await server.app.close();
    server.application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("inspect_asset 的当前使用只返回实际 Composition 可达对象", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-source-review-reachability-"));
  const server = await createServer({ workspaceRoot });
  try {
    const created = server.application.createProject({ name: "素材审阅可达性测试", profile: "presenter_motion" });
    const projectId = created.snapshot.project.id;
    const fixture = await createSourceReviewFixture(workspaceRoot);
    const sourceHash = createHash("sha256").update(await readFile(fixture)).digest("hex");
    const registered = server.application.registerImportedAsset({
      projectId,
      baseRevision: server.application.readProject(projectId).revision.number,
      name: "可达性源素材.mp4",
      kind: "video",
      managedPath: "assets/source/reachability.mp4",
      sourceHash,
      provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
    });
    const targetPath = join(server.application.readProject(projectId).snapshot.project.rootPath, registered.asset.managedPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(fixture, targetPath);
    server.application.applyMediaAnalysis({ projectId, assetId: registered.asset.id, metadata: await probeMedia(targetPath) });
    const presenter = server.application.buildPresenterTimeline({
      projectId,
      baseRevision: server.application.readProject(projectId).revision.number,
      assetIds: [registered.asset.id],
      sceneSize: 1
    });
    const hostScene = presenter.snapshot.scenes[0]!;
    const withCutaway = server.application.manageCutaway({
      projectId,
      baseRevision: presenter.revision.number,
      action: "create",
      hostSceneId: hostScene.id,
      assetId: registered.asset.id,
      mode: "fullscreen",
      fit: "cover",
      audioMode: "continue_dialogue",
      purpose: "测试失效 Cutaway 不应算当前使用",
      audienceTask: "仅验证可达性",
      sourceStartFrame: 0,
      sourceEndFrame: 12,
      startFrame: hostScene.startFrame,
      endFrame: hostScene.startFrame + 12
    });
    server.application.repository.commit(projectId, withCutaway.revision.number, "素材审阅可达性测试状态", (snapshot) => {
      const videoItem = snapshot.timeline.items.find((item) => item.assetId === registered.asset.id && item.sceneId === hostScene.id);
      const videoTrack = snapshot.timeline.tracks.find((track) => track.id === videoItem?.trackId);
      const audioTrack = snapshot.timeline.tracks.find((track) => track.kind === "audio");
      const cutaway = snapshot.cutaways[0];
      assert.ok(videoItem && videoTrack && audioTrack && cutaway, "测试必须建立主画面、音频轨与 Cutaway");
      videoTrack.hidden = true;
      audioTrack.muted = true;
      snapshot.timeline.items.push({
        id: "muted-source-review-audio",
        trackId: audioTrack.id,
        assetId: registered.asset.id,
        startFrame: 0,
        endFrame: 12,
        sourceStartFrame: 0,
        sourceEndFrame: 12,
        disabled: false
      });
      cutaway.status = "stale";
    });

    const review = await inspectAsset(server.application, { projectId, assetId: registered.asset.id, mode: "overview" });
    assert.equal(review.usage.timelineItems.length, 0, "隐藏视频轨和静音音频轨不能称为当前成片使用");
    assert.equal(review.usage.cutaways.length, 0, "stale Cutaway 不能称为当前成片使用");
    assert.equal(review.usage.scenes.length, 0, "只有不可达 Item 的 Scene 不能称为当前成片使用");
  } finally {
    await server.app.close();
    server.application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
