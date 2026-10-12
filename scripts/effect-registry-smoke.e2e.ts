import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@videocut/application";
import { EFFECT_TYPES } from "@videocut/contracts";
import { RevisionRenderer, validateExport } from "../apps/render-worker/src/exporter.js";
import { inspectComposedFrames } from "../apps/server/src/preview-inspection.js";
import { probeMedia, runProcess } from "@videocut/speech";

async function createColorVideo(path: string, color: string, durationSeconds: number): Promise<void> {
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `color=c=${color}:s=240x420:r=24:d=${durationSeconds}`,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
    "-c:a", "aac",
    path
  ]);
}

/** 生成确定性的单音 BGM，供真实合成中的循环与 Duck 验证使用。 */
async function createToneAudio(path: string, durationSeconds: number, frequency: number): Promise<void> {
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=${durationSeconds}`,
    "-c:a", "pcm_s16le",
    path
  ]);
}

/** 静音 Dialogue 仍保留真实时间范围，用来隔离验证 BGM Duck 本身。 */
async function createSilentAudio(path: string, durationSeconds: number): Promise<void> {
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono:d=${durationSeconds}`,
    "-c:a", "pcm_s16le",
    path
  ]);
}

/** 从已导出的真实媒体读取指定区间平均响度；数值越接近 0，声音越响。 */
async function readMeanVolume(videoPath: string, startSeconds: number, durationSeconds: number): Promise<number> {
  const output = await runProcess("ffmpeg", [
    "-hide_banner",
    "-ss", startSeconds.toFixed(3),
    "-t", durationSeconds.toFixed(3),
    "-i", videoPath,
    "-vn",
    "-af", "volumedetect",
    "-f", "null",
    "-"
  ]);
  const match = /mean_volume:\s*(-?[\d.]+)\s+dB/iu.exec(output);
  if (!match) throw new Error(`无法读取导出音频的平均响度：${output}`);
  return Number(match[1]);
}

async function createRedThenBlueVideo(path: string): Promise<void> {
  await runProcess("ffmpeg", [
    "-y",
    // 单一连续流避免 concat 在个别 FFmpeg/Chromium 组合下造成短视频寻帧不稳定。
    "-f", "lavfi", "-i", "color=c=blue:s=240x420:r=24:d=0.5,drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='lt(n,6)'",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-map", "0:v",
    "-map", "1:a",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
    "-c:a", "aac",
    path
  ]);
}

/** 直接读取一个合成像素，验证 Cue 内视频的时间轴而不是只检查组件有没有渲染。 */
async function readRgbPixel(videoPath: string, x: number, y: number): Promise<[number, number, number]> {
  return new Promise((resolve, reject) => {
    // H.264 常为 4:2:0，取 2×2 偶数区域避免 FFmpeg 将 1px crop 对齐为 0。
    const child = spawn("ffmpeg", ["-v", "error", "-i", videoPath, "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(chunks);
      if (code !== 0 || output.length < 3) {
        reject(new Error(`无法读取合成像素：${stderr || `ffmpeg 退出码 ${code}`}`));
        return;
      }
      resolve([output[0]!, output[1]!, output[2]!]);
    });
  });
}

/**
 * Cue 位于整片后半段时，绑定短视频必须从自身第 0 帧开始，而不是继承全局 Composition Frame。
 * 红色首帧和蓝色末帧让这个行为可以通过真实合成像素确定性验证。
 */
async function verifyLateBoundVideoStartsAtZero(application: ReturnType<typeof createApplication>, renderer: RevisionRenderer): Promise<{ outputPath: string; pixel: [number, number, number] }> {
  const created = application.createProject({ name: "Late Bound Asset Playback" });
  const projectId = created.snapshot.project.id;
  const projectRoot = created.snapshot.project.rootPath;
  const sourceDirectory = join(projectRoot, "assets", "source");
  await mkdir(sourceDirectory, { recursive: true });
  const backgroundPath = join(sourceDirectory, "late-background.mp4");
  const cuePath = join(sourceDirectory, "late-bound.mp4");
  await createColorVideo(backgroundPath, "0x405060", 4);
  // 先红后蓝：Cue 开始的局部第 0 帧必须读到红色，全局第 2 秒则已经超出这个短素材。
  await createRedThenBlueVideo(cuePath);

  const background = application.registerImportedAsset({
    projectId,
    baseRevision: created.revision.number,
    name: "late-background.mp4",
    kind: "video",
    managedPath: join("assets", "source", "late-background.mp4"),
    sourceHash: "late-bound-background"
  });
  application.applyMediaAnalysis({ projectId, assetId: background.asset.id, metadata: await probeMedia(backgroundPath) });
  const bound = application.registerImportedAsset({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    name: "late-bound.mp4",
    kind: "video",
    managedPath: join("assets", "source", "late-bound.mp4"),
    sourceHash: "late-bound-red"
  });
  application.applyMediaAnalysis({ projectId, assetId: bound.asset.id, metadata: await probeMedia(cuePath) });
  const assembled = application.buildPresenterTimeline({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    assetIds: [background.asset.id],
    sceneSize: 1
  });
  const scene = assembled.snapshot.scenes[0]!;
  const cueStart = assembled.snapshot.timeline.fps * 2;
  application.createEffectCue({
    projectId,
    baseRevision: assembled.revision.number,
    sceneId: scene.id,
    type: "ContentCarousel",
    layer: "front",
    startFrame: cueStart,
    endFrame: cueStart + 12,
    spatialAnchor: "center",
    assetBindings: [{ slot: "primary", assetId: bound.asset.id }],
    narrativePurpose: "验证后半段绑定素材的局部播放时间",
    audienceTask: "冒烟验证",
    motion: { enterPreset: "none", settlePreset: "hold", exitPreset: "none", enterFrames: 1, exitFrames: 1 }
  });
  const snapshot = application.readProject(projectId).snapshot;
  const outputPath = join(projectRoot, "previews", "late-bound-local-time.mp4");
  await renderer.renderRange(snapshot, cueStart, cueStart + 1, outputPath);
  // ContentCarousel 居中时第一张卡片位于画布左侧约 5%～34%、高度约 39%～47%，避开标题文字取中部像素。
  const pixel = await readRgbPixel(outputPath, 100, 550);
  assert.ok(pixel[0] > pixel[2] + 70, `后半段 Cue 的绑定视频应从红色第 0 帧开始，实际 RGB=${pixel.join(",")}`);
  return { outputPath, pixel };
}

/**
 * 没有 ActorPerformance / Mask 时，rear Cue 必须显式降级为可见前景。
 * 纯黑人物底片让“被错误藏在人物后面”和“正确显示”可以通过合成像素区分。
 */
async function verifyRearCueFallsBackWithoutMask(application: ReturnType<typeof createApplication>, renderer: RevisionRenderer): Promise<{ outputPath: string; pixel: [number, number, number] }> {
  const created = application.createProject({ name: "Rear Cue Mask Fallback" });
  const projectId = created.snapshot.project.id;
  const projectRoot = created.snapshot.project.rootPath;
  const sourceDirectory = join(projectRoot, "assets", "source");
  await mkdir(sourceDirectory, { recursive: true });
  const backgroundPath = join(sourceDirectory, "black-actor.mp4");
  await createColorVideo(backgroundPath, "black", 3);
  const imported = application.registerImportedAsset({
    projectId,
    baseRevision: created.revision.number,
    name: "black-actor.mp4",
    kind: "video",
    managedPath: join("assets", "source", "black-actor.mp4"),
    sourceHash: "rear-cue-fallback"
  });
  application.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(backgroundPath) });
  const assembled = application.buildPresenterTimeline({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    assetIds: [imported.asset.id],
    sceneSize: 1
  });
  const scene = assembled.snapshot.scenes[0]!;
  application.createEffectCue({
    projectId,
    baseRevision: assembled.revision.number,
    sceneId: scene.id,
    type: "MetricBackdrop",
    layer: "rear",
    startFrame: 0,
    endFrame: 24,
    note: "Mask 缺失降级检查",
    // 该测试验证空间降级，也必须提供 Registry 的正式内容；否则 Cue 会按内容合同被正确隐藏。
    props: { metric: "42%" },
    motion: { enterPreset: "none", settlePreset: "hold", exitPreset: "none", enterFrames: 1, exitFrames: 1 }
  });
  const snapshot = application.readProject(projectId).snapshot;
  const outputPath = join(projectRoot, "previews", "rear-cue-mask-fallback.mp4");
  await renderer.renderRange(snapshot, 6, 7, outputPath);
  // MetricBackdrop 位于中左安全区；底片全黑，像素变亮才说明 Cue 没有被错误藏到人物后面。
  const pixel = await readRgbPixel(outputPath, 120, 560);
  assert.ok(Math.max(...pixel) > 55, `无 Mask 的 rear Cue 应降级为可见前景，实际 RGB=${pixel.join(",")}`);
  return { outputPath, pixel };
}

/**
 * Cutaway 不是只写进 Timeline 的元数据：这里以真实颜色素材验证它在同一个 Revision 中
 * 确实覆盖 Fullscreen，并能作为 PiP 保留人物主画面。两个范围分开，避免同轨重叠掩盖布局问题。
 */
async function verifyCutawayRender(application: ReturnType<typeof createApplication>, renderer: RevisionRenderer): Promise<{
  fullscreenPath: string;
  pipPath: string;
  fullscreenPixel: [number, number, number];
  pipPixel: [number, number, number];
  backgroundPixel: [number, number, number];
}> {
  const created = application.createProject({ name: "Cutaway Fullscreen 与 PiP 渲染" });
  const projectId = created.snapshot.project.id;
  const projectRoot = created.snapshot.project.rootPath;
  const sourceDirectory = join(projectRoot, "assets", "source");
  await mkdir(sourceDirectory, { recursive: true });
  const presenterPath = join(sourceDirectory, "cutaway-presenter.mp4");
  const fullscreenPath = join(sourceDirectory, "cutaway-fullscreen.mp4");
  const pipPath = join(sourceDirectory, "cutaway-pip.mp4");
  await createColorVideo(presenterPath, "0x102040", 4);
  await createColorVideo(fullscreenPath, "0x00d050", 2);
  await createColorVideo(pipPath, "0xff8a00", 2);

  const registerVideo = async (name: string, sourceHash: string) => {
    const asset = application.registerImportedAsset({
      projectId,
      baseRevision: application.readProject(projectId).revision.number,
      name,
      kind: "video",
      managedPath: join("assets", "source", name),
      sourceHash
    });
    await application.applyMediaAnalysis({ projectId, assetId: asset.asset.id, metadata: await probeMedia(join(sourceDirectory, name)) });
    return asset.asset.id;
  };
  const presenterAssetId = await registerVideo("cutaway-presenter.mp4", "cutaway-presenter");
  const fullscreenAssetId = await registerVideo("cutaway-fullscreen.mp4", "cutaway-fullscreen");
  const pipAssetId = await registerVideo("cutaway-pip.mp4", "cutaway-pip");
  const presenter = application.buildPresenterTimeline({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    assetIds: [presenterAssetId],
    sceneSize: 1
  });
  const hostScene = presenter.snapshot.scenes[0]!;
  const treatment = application.manageVisualTreatment({
    projectId,
    baseRevision: presenter.revision.number,
    action: "upsert",
    sceneId: hostScene.id,
    mode: "cutaway",
    primaryAttention: "用真实画面具体化当前旁白",
    narrativePurpose: "验证 Cutaway 已经进入可播放合成",
    intensity: "medium"
  });
  const fullscreen = application.manageCutaway({
    projectId,
    baseRevision: treatment.revision.number,
    action: "create",
    hostSceneId: hostScene.id,
    assetId: fullscreenAssetId,
    visualTreatmentId: treatment.snapshot.visualTreatments[0]!.id,
    mode: "fullscreen",
    fit: "cover",
    audioMode: "continue_dialogue",
    purpose: "在完整说明期间展示现实素材",
    audienceTask: "看清完整现实画面后继续听人物说明",
    sourceStartFrame: 0,
    sourceEndFrame: 12,
    startFrame: 12,
    endFrame: 24
  });
  const withPip = application.manageCutaway({
    projectId,
    baseRevision: fullscreen.revision.number,
    action: "create",
    hostSceneId: hostScene.id,
    assetId: pipAssetId,
    mode: "pip",
    fit: "cover",
    pipAnchor: "top_right",
    pipScale: 0.4,
    audioMode: "mute_source_audio",
    purpose: "在保留人物的前提下展示辅助对象",
    audienceTask: "同时看见人物与辅助例子",
    sourceStartFrame: 0,
    sourceEndFrame: 12,
    startFrame: 36,
    endFrame: 48
  });
  const snapshot = withPip.snapshot;
  const fullscreenPreviewPath = join(projectRoot, "previews", "cutaway-fullscreen.mp4");
  const pipPreviewPath = join(projectRoot, "previews", "cutaway-pip.mp4");
  await renderer.renderRange(snapshot, 12, 13, fullscreenPreviewPath);
  await renderer.renderRange(snapshot, 36, 37, pipPreviewPath);

  const fullscreenPixel = await readRgbPixel(fullscreenPreviewPath, Math.floor(snapshot.timeline.width * 0.5), Math.floor(snapshot.timeline.height * 0.5));
  const pipPixel = await readRgbPixel(pipPreviewPath, Math.floor(snapshot.timeline.width * 0.75), Math.floor(snapshot.timeline.height * 0.15));
  const backgroundPixel = await readRgbPixel(pipPreviewPath, Math.floor(snapshot.timeline.width * 0.1), Math.floor(snapshot.timeline.height * 0.65));
  assert.ok(fullscreenPixel[1] > fullscreenPixel[0] + 65 && fullscreenPixel[1] > fullscreenPixel[2] + 65, `Fullscreen Cutaway 应覆盖主画面，实际 RGB=${fullscreenPixel.join(",")}`);
  assert.ok(pipPixel[0] > pipPixel[1] + 55 && pipPixel[1] > pipPixel[2] + 25, `PiP 区域应显示辅助素材，实际 RGB=${pipPixel.join(",")}`);
  assert.ok(backgroundPixel[2] > backgroundPixel[0] + 25, `PiP 外应继续保留人物主画面，实际 RGB=${backgroundPixel.join(",")}`);
  return { fullscreenPath: fullscreenPreviewPath, pipPath: pipPreviewPath, fullscreenPixel, pipPixel, backgroundPixel };
}

/**
 * 字幕不是只在 JSON 中存在：用明确的红色 Card 背景验证稳定文案、换行安全区和样式
 * 已进入真实 Remotion 合成。这里不声称词级时间，只验证 Card 级渲染路径。
 */
async function verifyCaptionCardRender(application: ReturnType<typeof createApplication>, renderer: RevisionRenderer): Promise<{ outputPath: string; pixel: [number, number, number] }> {
  const created = application.createProject({ name: "Caption Card Render" });
  const projectId = created.snapshot.project.id;
  const projectRoot = created.snapshot.project.rootPath;
  const sourceDirectory = join(projectRoot, "assets", "source");
  await mkdir(sourceDirectory, { recursive: true });
  const backgroundPath = join(sourceDirectory, "caption-background.mp4");
  await createColorVideo(backgroundPath, "0x102040", 2);
  const background = application.registerImportedAsset({
    projectId,
    baseRevision: created.revision.number,
    name: "caption-background.mp4",
    kind: "video",
    managedPath: join("assets", "source", "caption-background.mp4"),
    sourceHash: "caption-render-background"
  });
  application.applyMediaAnalysis({ projectId, assetId: background.asset.id, metadata: await probeMedia(backgroundPath) });
  const presenter = application.buildPresenterTimeline({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    assetIds: [background.asset.id],
    sceneSize: 1
  });
  const withCaption = application.repository.commit(projectId, presenter.revision.number, "写入字幕渲染冒烟数据", (snapshot) => {
    snapshot.speechSegments.push({
      id: "caption_smoke_segment",
      semanticUnitIds: [],
      text: "CAPTION",
      order: 0,
      pauseBefore: { durationMs: 0, reason: "sentence" },
      status: "ready"
    });
    snapshot.timeline.captions.push({
      id: "caption_smoke_card",
      speechSegmentId: "caption_smoke_segment",
      sourceText: "CAPTION",
      text: "CAPTION",
      textMode: "derived",
      startFrame: 0,
      endFrame: 24,
      style: "stable",
      format: {
        fontSize: 64,
        fontWeight: 800,
        color: "#ffffff",
        backgroundColor: "#ff0000",
        bottomPercent: 10,
        horizontalInsetPercent: 8,
        textAlign: "center"
      },
      emphasis: { text: "TION", occurrence: 0, color: "#ffd166", fontWeight: 850, scale: 1.05 },
      precision: "segment_exact"
    });
  });
  const outputPath = join(projectRoot, "previews", "caption-card.mp4");
  await renderer.renderRange(withCaption.snapshot, 0, 1, outputPath);
  await validateExport(outputPath, Math.round(1_000 / withCaption.snapshot.timeline.fps));
  // 红色背景位于底部 10% 的中央文字 Card，取首行上方填充区，避开浅色字形。
  const pixel = await readRgbPixel(outputPath, 275, 1_118);
  assert.ok(pixel[0] > pixel[1] + 70 && pixel[0] > pixel[2] + 70, `稳定字幕 Card 应写入真实合成，实际 RGB=${pixel.join(",")}`);
  return { outputPath, pixel };
}

/**
 * 声音包装必须进入实际 Renderer，而不只是保存 AudioCue JSON：
 * 1 秒 BGM 在 4 秒成片中循环；中间 1～3 秒存在静音 Dialogue Item，
 * 因此导出音量应在 Dialogue 区间显著 Duck，前后恢复为原音乐响度。
 */
async function verifyAudioDuckingRender(application: ReturnType<typeof createApplication>, renderer: RevisionRenderer): Promise<{
  outputPath: string;
  beforeDb: number;
  duckedDb: number;
  tailDb: number;
}> {
  const created = application.createProject({ name: "AudioCue Loop 与 Duck Render" });
  const projectId = created.snapshot.project.id;
  const projectRoot = created.snapshot.project.rootPath;
  const sourceDirectory = join(projectRoot, "assets", "source");
  await mkdir(sourceDirectory, { recursive: true });
  const presenterPath = join(sourceDirectory, "audio-presenter.mp4");
  const bgmPath = join(sourceDirectory, "audio-bgm.wav");
  const dialoguePath = join(sourceDirectory, "audio-dialogue-silence.wav");
  await createColorVideo(presenterPath, "0x102040", 4);
  await createToneAudio(bgmPath, 1, 880);
  await createSilentAudio(dialoguePath, 4);

  const presenter = application.registerImportedAsset({
    projectId,
    baseRevision: created.revision.number,
    name: "audio-presenter.mp4",
    kind: "video",
    managedPath: join("assets", "source", "audio-presenter.mp4"),
    sourceHash: "audio-duck-presenter"
  });
  application.applyMediaAnalysis({ projectId, assetId: presenter.asset.id, metadata: await probeMedia(presenterPath) });
  const bgm = application.registerImportedAsset({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    name: "audio-bgm.wav",
    kind: "audio",
    managedPath: join("assets", "source", "audio-bgm.wav"),
    sourceHash: "audio-duck-bgm"
  });
  application.applyMediaAnalysis({ projectId, assetId: bgm.asset.id, metadata: await probeMedia(bgmPath) });
  const dialogue = application.registerImportedAsset({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    name: "audio-dialogue-silence.wav",
    kind: "speech",
    managedPath: join("assets", "source", "audio-dialogue-silence.wav"),
    sourceHash: "audio-duck-dialogue"
  });
  application.applyMediaAnalysis({ projectId, assetId: dialogue.asset.id, metadata: await probeMedia(dialoguePath) });
  const assembled = application.buildPresenterTimeline({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    assetIds: [presenter.asset.id],
    sceneSize: 1
  });
  const dialogueTrack = assembled.snapshot.timeline.tracks.find((track) => track.name === "Dialogue")!;
  const withDialogue = application.repository.commit(projectId, assembled.revision.number, "写入 Duck 渲染测试的静音 Dialogue", (snapshot) => {
    snapshot.timeline.items.push({
      id: "audio_duck_dialogue_item",
      trackId: dialogueTrack.id,
      assetId: dialogue.asset.id,
      startFrame: 24,
      endFrame: 72,
      sourceStartFrame: 0,
      sourceEndFrame: 48,
      disabled: false,
      gainDb: 0
    });
  });
  const withBgm = application.manageAudio({
    projectId,
    baseRevision: withDialogue.revision.number,
    action: "create",
    kind: "bgm",
    assetId: bgm.asset.id,
    purpose: "验证真实 Renderer 中的循环背景音乐与旁白 Duck",
    loop: true,
    gainDb: 0,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    ducking: { enabled: true, reductionDb: -20, attackFrames: 0, releaseFrames: 0 }
  });
  const cue = withBgm.snapshot.audioCues[0]!;
  assert.equal(cue.kind, "bgm");
  assert.equal(cue.loop, true);
  assert.equal(withBgm.snapshot.timeline.items.find((item) => item.id === cue.timelineItemId)?.endFrame, 96);

  const outputPath = join(projectRoot, "previews", "audio-duck-loop.mp4");
  await renderer.render(withBgm.snapshot, outputPath);
  await validateExport(outputPath, 4_000);
  const beforeDb = await readMeanVolume(outputPath, 0.25, 0.5);
  const duckedDb = await readMeanVolume(outputPath, 1.5, 0.5);
  const tailDb = await readMeanVolume(outputPath, 3.25, 0.5);
  assert.ok(beforeDb > duckedDb + 12, `Dialogue 区间应显著 Duck BGM，导出前/中为 ${beforeDb.toFixed(1)}dB / ${duckedDb.toFixed(1)}dB`);
  assert.ok(tailDb > duckedDb + 12, `Dialogue 结束后 BGM 应恢复且仍循环，导出中/尾为 ${duckedDb.toFixed(1)}dB / ${tailDb.toFixed(1)}dB`);
  return { outputPath, beforeDb, duckedDb, tailDb };
}

/** 单组件单项目渲染，避免 Registry 冒烟因并行视频解码而掩盖某个组件本身的失败。 */
async function renderRegisteredEffect(input: {
  application: ReturnType<typeof createApplication>;
  renderer: RevisionRenderer;
  fixturePath: string;
  type: typeof EFFECT_TYPES[number];
  index: number;
}): Promise<{ type: string; outputPath: string; durationMs: number; inspectedFrames: number }> {
  const created = input.application.createProject({ name: `Effect Registry Smoke ${input.type}` });
  const projectId = created.snapshot.project.id;
  const projectRoot = created.snapshot.project.rootPath;
  const relativePath = join("assets", "source", `effect-smoke-${input.index}.mp4`);
  const managedPath = join(projectRoot, relativePath);
  await mkdir(join(projectRoot, "assets", "source"), { recursive: true });
  await copyFile(input.fixturePath, managedPath);
  const imported = input.application.registerImportedAsset({
    projectId,
    baseRevision: created.revision.number,
    name: `effect-smoke-${input.index}.mp4`,
    kind: "video",
    managedPath: relativePath,
    originalPath: input.fixturePath,
    sourceHash: `effect-registry-smoke-${input.index}`
  });
  input.application.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(managedPath) });
  const assembled = input.application.buildPresenterTimeline({
    projectId,
    baseRevision: input.application.readProject(projectId).revision.number,
    assetIds: [imported.asset.id],
    sceneSize: 1
  });
  const scene = assembled.snapshot.scenes[0];
  if (!scene) throw new Error("Effect Registry Smoke 缺少 PresenterScene");
  const rangeEnd = scene.startFrame + 4;
  input.application.createEffectCue({
    projectId,
    baseRevision: assembled.revision.number,
    sceneId: scene.id,
    type: input.type,
    layer: input.type === "MetricBackdrop" ? "rear" : input.type === "CameraPunch" ? "actor" : input.type === "FullScreenMeme" || input.type === "EndCard" ? "fullscreen" : "front",
    startFrame: scene.startFrame,
    endFrame: rangeEnd,
    narrativePurpose: "验证已注册组件能合成",
    audienceTask: "冒烟验证",
    assetBindings: ["ProductFan", "PortfolioWall", "EvidenceCard", "DeviceShowcase", "ContentCarousel"].includes(input.type) ? [{ slot: "primary", assetId: imported.asset.id }] : [],
    // 冒烟也使用各组件的正式内容合同，不能依赖 Renderer 的默认示例文案。
    props: input.type === "CommentCloud"
      ? { comments: ["真实项目评论 A", "真实项目评论 B"] }
      : input.type === "MetricBackdrop"
        ? { metric: "响应时间减少 42%" }
        : input.type === "EndCard"
          ? { brand: "Smoke Studio", headline: "完成本次验证", cta: "查看完整结果" }
          : {},
    note: `Smoke: ${input.type}`,
    motion: { enterFrames: 1, exitFrames: 2 }
  });
  const snapshot = input.application.readProject(projectId).snapshot;
  assert.equal(snapshot.effectCues[0]?.type, input.type, `${input.type} 必须被写入 Project Snapshot`);
  const outputPath = join(projectRoot, "previews", `effect-${input.type}.mp4`);
  await input.renderer.renderRange(snapshot, scene.startFrame, rangeEnd, outputPath);
  const validation = await validateExport(outputPath, Math.round(((rangeEnd - scene.startFrame) / snapshot.timeline.fps) * 1000));
  // 包含局部预览最后一帧，防止 FFmpeg 跳帧让“退出帧已审片”的证据实际上缺失。
  const inspectionFrames = Array.from(
    { length: rangeEnd - scene.startFrame },
    (_, offset) => scene.startFrame + offset
  );
  const inspectedFrames = await inspectComposedFrames({
    projectRoot,
    previewPath: outputPath,
    revision: input.application.readProject(projectId).revision.number,
    fromFrame: scene.startFrame,
    toFrame: rangeEnd,
    fps: snapshot.timeline.fps,
    frames: inspectionFrames
  });
  assert.equal(inspectedFrames.length, inspectionFrames.length, `${input.type} 必须能抽取进入、稳定、退出及最后一帧的真实合成帧`);
  return { type: input.type, outputPath, durationMs: validation.durationMs, inspectedFrames: inspectedFrames.length };
}

/**
 * 这是 Effect Registry 的渲染冒烟测试，而不是产品创作效果测试。
 * 它用同一真实视频分别验证 11 种已注册组件可被构建和合成；语义、Skill、MCP 与质量链路请运行
 * presenter-creative-agent.eval.ts。
 */
async function main(): Promise<void> {
  const fixturePath = join(process.cwd(), "videos", "数字人口播", "segment-01.mp4");
  if (!existsSync(fixturePath)) throw new Error(`缺少冒烟测试视频：${fixturePath}`);
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-effect-registry-"));
  const application = createApplication(workspaceRoot);
  try {
    const renderer = new RevisionRenderer(undefined, 1);
    const results = [];
    for (const [index, type] of EFFECT_TYPES.entries()) {
      results.push(await renderRegisteredEffect({ application, renderer, fixturePath, type, index }));
    }
    assert.equal(results.length, EFFECT_TYPES.length, "11 个 Registry 类型必须都完成真实合成");
    const captionRender = await verifyCaptionCardRender(application, renderer);
    const audioMix = await verifyAudioDuckingRender(application, renderer);
    // 局部时间验证使用独立 Project/Renderer，避免 Registry 冒烟的多项目缓存影响短素材解码。
    const lateWorkspaceRoot = await mkdtemp(join(tmpdir(), "videocut-late-bound-"));
    const lateApplication = createApplication(lateWorkspaceRoot);
    let lateBoundPlayback: { outputPath: string; pixel: [number, number, number] };
    try {
      lateBoundPlayback = await verifyLateBoundVideoStartsAtZero(lateApplication, new RevisionRenderer(undefined, 1));
    } finally {
      lateApplication.close();
      await rm(lateWorkspaceRoot, { recursive: true, force: true });
    }
    const rearFallbackWorkspace = await mkdtemp(join(tmpdir(), "videocut-rear-fallback-"));
    const rearFallbackApplication = createApplication(rearFallbackWorkspace);
    let rearCueFallback: { outputPath: string; pixel: [number, number, number] };
    try {
      rearCueFallback = await verifyRearCueFallsBackWithoutMask(rearFallbackApplication, new RevisionRenderer(undefined, 1));
    } finally {
      rearFallbackApplication.close();
      await rm(rearFallbackWorkspace, { recursive: true, force: true });
    }
    const cutawayWorkspace = await mkdtemp(join(tmpdir(), "videocut-cutaway-render-"));
    const cutawayApplication = createApplication(cutawayWorkspace);
    let cutawayRender: Awaited<ReturnType<typeof verifyCutawayRender>>;
    try {
      cutawayRender = await verifyCutawayRender(cutawayApplication, new RevisionRenderer(undefined, 1));
    } finally {
      cutawayApplication.close();
      await rm(cutawayWorkspace, { recursive: true, force: true });
    }
    console.log(JSON.stringify({
      test: "effect-registry-smoke",
      effectTypes: EFFECT_TYPES,
      results,
      captionRender,
      audioMix,
      lateBoundPlayback,
      rearCueFallback,
      cutawayRender
    }, null, 2));
  } finally {
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
