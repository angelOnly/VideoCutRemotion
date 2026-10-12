import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApplication, type EditingApplication } from "@videocut/application";
import { assertProjectGraphValid } from "@videocut/domain";
import type { ExplainerSceneState, ProjectSnapshot } from "@videocut/contracts";
import { resolveVideoSourceVolume, resolveVlogAmbientVolume } from "@videocut/remotion";
import { probeMedia, runProcess } from "@videocut/speech";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { inspectComposedFrames } from "../apps/server/src/preview-inspection.js";
import { RevisionRenderer, runPreviewJob } from "../apps/render-worker/src/exporter.js";

const fps = 24;
const introFrames = fps;
const keepWorkspace = process.argv.includes("--keep");

/**
 * 三段颜色、几何形状和音高均不同的受控实拍替身素材。
 * 它只证明 FFmpeg 边界、受管素材、蒙太奇和渲染链路，不把硬切结果伪装成事件理解。
 */
async function createVlogFixture(directory: string): Promise<string> {
  const targetPath = join(directory, "vlog-montage-fixture.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=0xC8414B:s=180x320:r=24:d=1",
    "-f", "lavfi", "-i", "color=c=0x247BA0:s=180x320:r=24:d=1",
    "-f", "lavfi", "-i", "color=c=0x70A63D:s=180x320:r=24:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1",
    "-filter_complex",
    "[0:v]drawbox=x=18:y=42:w=144:h=72:color=white@0.9:t=fill[v0];[1:v]drawbox=x=18:y=124:w=144:h=72:color=white@0.9:t=fill[v1];[2:v]drawbox=x=18:y=206:w=144:h=72:color=white@0.9:t=fill[v2];[v0][v1][v2]concat=n=3:v=1:a=0[v];[3:a]volume=4[a0];[4:a]volume=4[a1];[5:a]volume=4[a2];[a0][a1][a2]concat=n=3:v=0:a=1[a]",
    "-map", "[v]",
    "-map", "[a]",
    // Renderer 内的 Chromium 走浏览器解码，固定为 H.264，避免仅 FFmpeg 可读的编码让真实 Preview 卡在取帧阶段。
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    targetPath
  ]);
  return targetPath;
}

async function registerReadyVideo(input: {
  application: EditingApplication;
  projectId: string;
  sourcePath: string;
}): Promise<string> {
  const registered = input.application.registerImportedAsset({
    projectId: input.projectId,
    baseRevision: input.application.readProject(input.projectId).revision.number,
    name: "vlog-montage-fixture.mp4",
    kind: "video",
    managedPath: "assets/source/vlog-montage-fixture.mp4",
    sourceHash: "stage4-vlog-fixture-v1",
    provenance: {
      source: "local_import",
      acquiredAt: "2026-09-02T00:00:00.000Z"
    }
  });
  const asset = input.application.readProject(input.projectId).snapshot.assets.find((candidate) => candidate.id === registered.asset.id);
  assert.ok(asset, "固定 Vlog 素材必须先登记为项目 Asset");
  const targetPath = join(input.application.readProject(input.projectId).snapshot.project.rootPath, asset.managedPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(input.sourcePath, targetPath);
  input.application.applyMediaAnalysis({
    projectId: input.projectId,
    assetId: asset.id,
    metadata: await probeMedia(targetPath)
  });
  // registerImportedAsset 还会建立通用媒体分析 Job；本脚本已经以同一受管文件完成真实探测，
  // 因而将旧 Job 收口，确保下一次 Worker 领取的就是本次 Vlog 分析。
  for (const job of input.application.listJobs(input.projectId)) {
    if (job.kind === "media_analysis" && job.status === "queued") {
      input.application.updateJob(job.id, { status: "succeeded", result: { seededBy: "stage4-vlog-e2e" } });
    }
  }
  return asset.id;
}

async function drainVlogAnalysis(application: EditingApplication, jobId: string): Promise<void> {
  const processor = createMediaJobProcessor(application);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = application.trackJob(jobId);
    if (current.status === "succeeded") return;
    assert.notEqual(current.status, "failed", current.error ?? "Vlog 分析 Job 不能失败");
    assert.equal(await runOneJob(application, processor), true, "队列中应有待执行的 Vlog 分析 Job");
  }
  assert.equal(application.trackJob(jobId).status, "succeeded", "Vlog 分析必须在有限轮次内完成");
}

function explainerStates(): Array<Omit<ExplainerSceneState, "id">> {
  return [
    { phase: "entry", startFrame: 0, endFrame: 4, label: "建立观看边界" },
    { phase: "progressive", startFrame: 4, endFrame: 12, label: "逐步建立来源关系" },
    { phase: "settled", startFrame: 12, endFrame: 20, label: "保留一个完整的阅读瞬间" },
    { phase: "exit", startFrame: 20, endFrame: introFrames, label: "交给现场画面" }
  ];
}

async function maximumVolumeDb(path: string): Promise<number> {
  const output = await runProcess("ffmpeg", ["-hide_banner", "-i", path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]);
  const match = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/u.exec(output);
  assert.ok(match, "FFmpeg 必须给出音频峰值，才能验证现场声没有被重复混入");
  return Number(match[1]);
}

async function assertPreview(input: {
  snapshot: ProjectSnapshot;
  projectId: string;
  revision: number;
  previewPath: string;
  sourcePath: string;
}): Promise<void> {
  const metadata = await probeMedia(input.previewPath);
  const expectedDurationMs = Math.round((input.snapshot.timeline.durationInFrames / input.snapshot.timeline.fps) * 1_000);
  assert.equal(metadata.videoCodec, "h264", "真实 Preview 必须由 Remotion 编码为 H.264");
  assert.equal(metadata.hasAudio, true, "明确保留现场声的 Vlog Preview 必须带音轨");
  assert.ok(Math.abs(metadata.durationMs - expectedDurationMs) <= 1_000, `Preview 时长异常：期望约 ${expectedDurationMs}ms，实际 ${metadata.durationMs}ms`);
  await runProcess("ffmpeg", ["-v", "error", "-i", input.previewPath, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], 10 * 60_000);

  const evidence = await inspectComposedFrames({
    projectRoot: input.snapshot.project.rootPath,
    previewPath: input.previewPath,
    revision: input.revision,
    fromFrame: 0,
    toFrame: input.snapshot.timeline.durationInFrames,
    fps: input.snapshot.timeline.fps
  });
  assert.ok(evidence.length >= 3, "真实 Preview 必须能提取 Explainer 边界、Montage 中段和结尾的合成帧证据");

  // 固定源音量为约 -6 dB。若 Background Video 与 Ambient 同时播放同一源声，
  // 峰值会接近 0 dB；允许编码引入的小幅误差，但不能允许 +6 dB 的重复混音。
  const sourcePeak = await maximumVolumeDb(input.sourcePath);
  const previewPeak = await maximumVolumeDb(input.previewPath);
  assert.ok(previewPeak >= sourcePeak - 4, `现场声不应在真实渲染中消失：源 ${sourcePeak} dB，Preview ${previewPeak} dB`);
  assert.ok(previewPeak <= sourcePeak + 2, `Vlog 视频源声疑似与 Ambient 重复播放：源 ${sourcePeak} dB，Preview ${previewPeak} dB`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "videocut-vlog-stage4-"));
  const application = createApplication(root);
  try {
    const created = application.createProject({ name: "阶段 4 Vlog 真实 Montage 验收", profile: "hybrid" });
    const projectId = created.snapshot.project.id;

    // 这一秒的 Explainer 只建立“下面进入现场记录”的视觉边界；事件解释仍完全来自随后显式写入的 Vlog Event / Select。
    const story = application.updateStory({
      projectId,
      baseRevision: created.revision.number,
      title: "从说明页进入三段现场画面",
      summary: "确定性运行时验收，不宣称自动理解生成素材中的动作或故事。",
      beats: [{ title: "进入现场", purpose: "将一个简短说明页与真实受管 Vlog Montage 顺序连接。" }]
    });
    const narrative = application.manageNarrativeMap({
      projectId,
      baseRevision: story.revision.number,
      viewerQuestion: "接下来看到的是怎样一段现场记录？",
      promisedModel: "先用简短说明建立边界，再播放可追溯的现场源范围。",
      conclusion: "本验收验证运行时链路，不代替导演对真实素材的事件判断。",
      beats: [{
        narrativeBeatId: story.snapshot.story.beats[0]!.id,
        enteringKnowledge: "观众尚未看到现场画面。",
        question: "现场记录如何开始？",
        newKnowledge: "说明页结束后进入受管 Vlog 源片段。",
        deferredInformation: "Vlog 内部事件含义由显式 Event 和 Select 记录。",
        claim: "现场源范围与剪辑选择应可追溯。"
      }]
    });
    application.compileExplainerScenes({
      projectId,
      baseRevision: narrative.revision.number,
      plans: [{
        title: "进入现场记录",
        purpose: "在 Hybrid 边界展示 ExplainerScene 与 VlogMontageScene 可以连续播放。",
        startFrame: 0,
        endFrame: introFrames,
        narrativeMapBeatId: narrative.snapshot.narrativeMap!.beats[0]!.id,
        kind: "HeroReveal",
        primaryTask: "向观众说明下一段是受管现场源范围。",
        states: explainerStates(),
        props: { metric: "现场记录", qualifier: "以下画面来自同一条受管测试素材。" },
        visualTreatment: {
          mode: "remotion",
          intensity: "low",
          primaryAttention: "保持说明页简短，给实拍主线让路。",
          narrativePurpose: "建立 Hybrid 边界。"
        }
      }]
    });

    const fixturePath = await createVlogFixture(root);
    const assetId = await registerReadyVideo({ application, projectId, sourcePath: fixturePath });
    const analysisJob = application.submitVlogAnalysis({
      projectId,
      baseRevision: application.readProject(projectId).revision.number,
      assetIds: [assetId],
      sceneThreshold: 0.1,
      idempotencyKey: "stage4-vlog-runtime-fixture-v1"
    });
    await drainVlogAnalysis(application, analysisJob.id);

    const analysed = application.readVlogPlan(projectId);
    const sourceShots = [...analysed.vlogShotAnalyses].sort((left, right) => left.sourceStartFrame - right.sourceStartFrame);
    assert.ok(sourceShots.length >= 3, "三个可辨硬切场景必须形成至少三个 FFmpeg 源范围");
    assert.ok(sourceShots.every((shot) => shot.source === "ffmpeg_scene" && shot.hasAudio), "Worker 只能回传可测量的边界和音轨事实");
    const selectedSourceShots = sourceShots.slice(0, 3);

    // Event / Select 是此测试的明确人工输入：它们只描述受控 fixture 的播放顺序，
    // 并不把 FFmpeg 边界标记为自动识别了人物、地点、动作或情绪。
    const eventState = application.manageVlogEvents({
      projectId,
      baseRevision: analysed.revision,
      action: "create",
      order: 0,
      title: "三段受控现场范围",
      summary: "按源片真实顺序播放三段颜色和音高不同的测试范围。",
      shotAnalysisIds: selectedSourceShots.map((shot) => shot.id),
      continuityNote: "所有范围取自同一受管文件，按原始时间顺序连接。",
      status: "ready"
    });
    const event = eventState.snapshot.vlogEvents[0]!;
    const shotFunctions = ["establish", "transition", "atmosphere"] as const;
    const selectIds: string[] = [];
    for (const [index, shot] of selectedSourceShots.entries()) {
      const state = application.manageVlogShotSelects({
        projectId,
        baseRevision: application.readProject(projectId).revision.number,
        action: "create",
        eventId: event.id,
        shotAnalysisId: shot.id,
        order: index,
        sourceStartFrame: shot.sourceStartFrame,
        sourceEndFrame: shot.sourceEndFrame,
        function: shotFunctions[index]!,
        selectionReason: "固定验收素材的此段范围用于验证受管 Montage 的顺序和声音路径。",
        continuityNote: "保持该硬切源范围的原始先后，未声明任何自动语义或动作判断。",
        sourceAudioMode: "keep",
        status: "planned"
      });
      selectIds.push(state.snapshot.vlogShotSelects.at(-1)!.id);
    }
    const montage = application.compileVlogMontage({
      projectId,
      baseRevision: application.readProject(projectId).revision.number,
      shotSelectIds: selectIds,
      startFrame: introFrames,
      titlePrefix: "现场验收"
    });
    const snapshot = montage.snapshot;
    assert.ok(snapshot.scenes.some((scene) => scene.type === "ExplainerScene" && scene.startFrame === 0 && scene.endFrame === introFrames), "Hybrid 项目必须保留 Explainer 边界 Scene");
    assert.ok(snapshot.scenes.some((scene) => scene.type === "VlogMontageScene" && scene.startFrame === introFrames), "Vlog Montage 必须从 Explainer 边界后开始");
    assert.equal(snapshot.vlogAmbientCues.length, selectedSourceShots.length, "每个明确 keep 的 Vlog Select 只能建立一条独立 Ambient Cue");
    const tracksById = new Map(snapshot.timeline.tracks.map((track) => [track.id, track]));
    for (const select of snapshot.vlogShotSelects.filter((candidate) => selectIds.includes(candidate.id))) {
      const videoItem = snapshot.timeline.items.find((item) => item.id === select.timelineItemId);
      const ambientItem = snapshot.timeline.items.find((item) => item.id === select.ambientTimelineItemId);
      assert.ok(videoItem && ambientItem, "keep Select 必须同时拥有画面 Item 与独立 Ambient Item");
      assert.equal(resolveVideoSourceVolume(snapshot, videoItem, tracksById.get(videoItem.trackId)!), 0, "Vlog Background Video 不得直接播放源声");
      assert.equal(resolveVlogAmbientVolume(snapshot, ambientItem, tracksById.get(ambientItem.trackId)!), 1, "现场声只能从有效 Ambient Cue 播放一次");
    }
    assertProjectGraphValid(snapshot);

    const revision = montage.revision.number;
    const previewJob = application.submitPreview({
      projectId,
      revision,
      fromFrame: 0,
      toFrame: snapshot.timeline.durationInFrames,
      idempotencyKey: `stage4-vlog-preview:${revision}`
    });
    const preview = await runPreviewJob(application, previewJob, new RevisionRenderer(undefined, 1));
    const previewPath = typeof preview.path === "string" ? preview.path : "";
    assert.ok(previewPath, "RevisionRenderer 必须返回真实 Preview 文件路径");
    await assertPreview({ snapshot, projectId, revision, previewPath, sourcePath: fixturePath });

    console.log(JSON.stringify({
      profile: snapshot.project.profile,
      revision,
      durationSeconds: snapshot.timeline.durationInFrames / fps,
      explainerScenes: snapshot.scenes.filter((scene) => scene.type === "ExplainerScene").length,
      vlogMontageScenes: snapshot.scenes.filter((scene) => scene.type === "VlogMontageScene").length,
      sourceAnalysisCount: sourceShots.length,
      selectedShotCount: selectedSourceShots.length,
      ambientCueCount: snapshot.vlogAmbientCues.length,
      preview: keepWorkspace ? previewPath : "已完成技术验证，临时 Preview 将清理"
    }, null, 2));
  } finally {
    application.close();
    if (keepWorkspace) console.log(`保留阶段 4 Vlog 验收工作目录：${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
