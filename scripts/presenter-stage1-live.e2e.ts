import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { runOneJob } from "../apps/job-worker/src/index.js";
import { runOneRenderJob } from "../apps/render-worker/src/index.js";
import { runProcess } from "@videocut/speech";

const liveSkills = [
  "project-basics",
  "production-director",
  "transcription",
  "semantic-continuity",
  "presenter-motion-director",
  "visual-treatment-planning",
  "effect-timing",
  "remotion-production",
  "depth-composition",
  "quality-verification"
];

function textFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("MCP 没有返回标准 content");
  }
  if ("isError" in result && result.isError) {
    const message = result.content[0];
    throw new Error(message && typeof message === "object" && "text" in message ? String(message.text) : "MCP 调用失败");
  }
  const first = result.content[0];
  if (!first || typeof first !== "object" || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP 没有返回文本结果");
  }
  return first.text;
}

function semanticKind(text: string): "statement" | "question" | "cause" | "contrast" | "conclusion" {
  if (/[？?]$/u.test(text)) return "question";
  if (/^(因为|由于)/u.test(text)) return "cause";
  if (/^(但是|但|不过|然而|反而)/u.test(text)) return "contrast";
  if (/^(所以|因此|这就是|总结)/u.test(text)) return "conclusion";
  return "statement";
}

/**
 * 本地真实阶段 1 验收：所有项目写入均经过 MCP，Worker 只处理各自已领取的 Job。
 * 它会保留真实预览和合成帧，但刻意不伪造人工声画审片，因此最后的 ProductionRun 应保持 incomplete。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fullMode = args.includes("--full");
  const explicitSources = args.filter((arg) => arg !== "--full");
  const defaultSources = fullMode
    ? [1, 2, 3, 4, 5].map((index) => join(process.cwd(), "videos", "数字人口播", `segment-${String(index).padStart(2, "0")}.mp4`))
    : [join(process.cwd(), "videos", "数字人口播", "segment-01.mp4")];
  const sourcePaths = (explicitSources.length > 0 ? explicitSources : defaultSources).map((path) => resolve(path));
  for (const sourcePath of sourcePaths) {
    if (!existsSync(sourcePath)) throw new Error(`找不到验收视频：${sourcePath}`);
  }
  const sourcePath = sourcePaths[0]!;

  const workspaceParent = join(process.cwd(), "workspace");
  await mkdir(workspaceParent, { recursive: true });
  const workspaceRoot = process.env.VIDEOCUT_LIVE_WORKSPACE
    ? resolve(process.env.VIDEOCUT_LIVE_WORKSPACE)
    : await mkdtemp(join(workspaceParent, "stage1-live-"));
  const application = createApplication(workspaceRoot);
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
  const client = new Client({ name: "videocut-presenter-stage1-live", version: "1.0.0" });

  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(textFromToolResult(result)) as T;
  };
  const readProject = (projectId: string) => call<{
    revision: { number: number };
    snapshot: {
      project: { id: string; rootPath: string };
      assets: Array<{ id: string; name: string; status: string }>;
      transcriptSentenceCandidates: Array<{ id: string; text: string; sourceAssetId: string }>;
      semanticUnits: Array<{ id: string; text: string; sourceAssetId: string }>;
      speechSegments: Array<{ id: string }>;
      story: { beats: Array<{ id: string }> };
      timeline: { fps: number; durationInFrames: number; tracks: Array<{ id: string; name: string }>; items: Array<{ id: string; trackId: string; startFrame: number; endFrame: number }> };
      scenes: Array<{ id: string; startFrame: number; endFrame: number }>;
      speechAsset?: { id: string };
    };
  }>("read_project", { project_id: projectId });
  const runMediaJob = async (jobId: string) => {
    assert.equal(await runOneJob(application), true, `没有可执行的媒体 Job：${jobId}`);
    const job = await call<{ status: string; error?: string }>("track_job", { job_id: jobId });
    assert.equal(job.status, "succeeded", job.error ?? `媒体 Job ${jobId} 未成功`);
  };
  const runRenderJob = async (jobId: string) => {
    assert.equal(await runOneRenderJob(application), true, `没有可执行的渲染 Job：${jobId}`);
    const job = await call<{ status: string; error?: string }>("track_job", { job_id: jobId });
    assert.equal(job.status, "succeeded", job.error ?? `渲染 Job ${jobId} 未成功`);
  };

  try {
    await client.connect(transport);
    const created = await call<{ revision: { number: number }; snapshot: { project: { id: string } } }>("create_project", {
      name: fullMode ? "阶段 1 45-60 秒真实素材验收" : "阶段 1 真实素材验收",
      profile: "presenter_motion"
    });
    const projectId = created.snapshot.project.id;
    const run = await call<{ id: string }>("start_production_run", {
      project_id: projectId,
      base_revision_id: created.revision.number,
      loaded_skills: liveSkills,
      loaded_references: [
        "docs/asr接入.md",
        ".agents/skills/_shared/EDITORIAL_FOUNDATIONS.md",
        ".agents/skills/_shared/PROJECT_REVISION_AND_HANDOFF.md"
      ]
    });

    let state = await readProject(projectId);
    const importedVideos: Array<{ id: string; sourcePath: string }> = [];
    for (const [index, currentSourcePath] of sourcePaths.entries()) {
      const importedVideo = await call<{ asset: { id: string }; job: { id: string } }>("import_media", {
        project_id: projectId,
        base_revision_id: state.revision.number,
        file_path: currentSourcePath,
        role: "a_roll",
        tags: ["阶段1真实验收", "数字人口播", `原片-${String(index + 1).padStart(2, "0")}`],
        provenance: { source: "local_import", }
      });
      await runMediaJob(importedVideo.job.id);
      importedVideos.push({ id: importedVideo.asset.id, sourcePath: currentSourcePath });
      state = await readProject(projectId);
    }
    for (const [index, importedVideo] of importedVideos.entries()) {
      const transcription = await call<{ id: string }>("submit_transcription", {
        project_id: projectId,
        asset_id: importedVideo.id,
        idempotency_key: `stage1-live-transcription-${index + 1}`
      });
      await runMediaJob(transcription.id);
    }
    state = await readProject(projectId);
    assert.ok(state.snapshot.transcriptSentenceCandidates.length > 0, "FunASR 没有生成可审阅的转写候选");

    const candidates = state.snapshot.transcriptSentenceCandidates;
    const semantic = await call<{ revision: { number: number }; snapshot: { semanticUnits: Array<{ id: string; text: string }> } }>("apply_semantic_units", {
      project_id: projectId,
      base_revision_id: state.revision.number,
      units: candidates.map((candidate, index) => ({
        candidate_ids: [candidate.id],
        text: candidate.text,
        kind: semanticKind(candidate.text),
        preceding_context: candidates[index - 1]?.text ?? "",
        following_context: candidates[index + 1]?.text ?? "",
        confidence: 0.8
      }))
    });
    const semanticIds = semantic.snapshot.semanticUnits.map((unit) => unit.id);
    await call("apply_script", { project_id: projectId, base_revision_id: semantic.revision.number, semantic_unit_ids: semanticIds });
    state = await readProject(projectId);
    const transcriptText = state.snapshot.semanticUnits.map((unit) => unit.text).join("");
    const groupCount = Math.min(3, importedVideos.length);
    const groupSize = Math.ceil(importedVideos.length / groupCount);
    const sourceGroups = Array.from({ length: groupCount }, (_, index) => importedVideos.slice(index * groupSize, (index + 1) * groupSize));

    const story = await call<{ revision: { number: number }; snapshot: { story: { beats: Array<{ id: string }> } } }>("manage_story", {
      project_id: projectId,
      base_revision_id: state.revision.number,
      title: "人物口播完整表达",
      summary: "保留 FunASR 转写的完整表达，以人物为主视觉，仅在开场给予一次克制的构图强调。",
      beats: sourceGroups.map((group, index) => ({
        title: sourceGroups.length === 1 ? "建立人物观点" : `表达段落 ${index + 1}`,
        purpose: "让观众先理解连续人物表达，不用无关包装打断。",
        semantic_unit_ids: state.snapshot.semanticUnits
          .filter((unit) => group.some((asset) => asset.id === unit.sourceAssetId))
          .map((unit) => unit.id)
      }))
    });

    const referencePath = join(workspaceRoot, "voice-reference.wav");
    await runProcess("ffmpeg", ["-y", "-t", "8", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "24000", referencePath], 120_000);
    const importedReference = await call<{ asset: { id: string }; job: { id: string } }>("import_media", {
      project_id: projectId,
      base_revision_id: story.revision.number,
      file_path: referencePath,
      role: "voice_reference",
      tags: ["阶段1验收音色参考"],
      provenance: { source: "local_import", }
    });
    await runMediaJob(importedReference.job.id);
    state = await readProject(projectId);
    await call("manage_voice_references", {
      project_id: projectId,
      base_revision_id: state.revision.number,
      asset_id: importedReference.asset.id,
      label: "源口播参考音色",
    });
    state = await readProject(projectId);
    const voiceReference = await call<{ voiceReferences: Array<{ id: string }> }>("read_speech_asset", { project_id: projectId });
    const synthesis = await call<{ id: string }>("submit_voice_synthesis", {
      project_id: projectId,
      voice_reference_id: voiceReference.voiceReferences[0]!.id,
      idempotency_key: "stage1-live-voice"
    });
    await runMediaJob(synthesis.id);

    state = await readProject(projectId);
    assert.ok(state.snapshot.speechAsset, "OmniVoice 成功后没有生成 SpeechAsset");
    const firstSpeechSegmentId = state.snapshot.speechSegments[0]?.id;
    assert.ok(firstSpeechSegmentId, "语义 Script 没有生成可用于 EffectCue 的 SpeechSegment");
    const assembled = await call<{ revision: { number: number } }>("assemble_presenter_track", {
      project_id: projectId,
      base_revision_id: state.revision.number,
      asset_ids: importedVideos.map((asset) => asset.id)
    });
    // 只裁短已有画面以收齐真实旁白；需要补画面时应停下来，而不是循环或凭空延长人物视频。
    const aligned = await call<{ revision: { number: number } }>("align_presenter_to_speech", {
      project_id: projectId,
      base_revision_id: assembled.revision.number
    });
    state = await readProject(projectId);
    const actorTrack = state.snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll");
    const actorItems = state.snapshot.timeline.items
      .filter((item) => item.trackId === actorTrack?.id)
      .sort((left, right) => left.startFrame - right.startFrame);
    assert.ok(actorItems.length > 0, "A-roll 组装后缺少人物主画面");
    const scenePlans = sourceGroups.map((group, index) => {
      const groupItems = actorItems.slice(index * groupSize, index * groupSize + group.length);
      if (groupItems.length === 0) throw new Error(`表达段落 ${index + 1} 缺少可播放 A-roll`);
      return {
        title: sourceGroups.length === 1 ? "完整人物表达" : `人物表达 ${index + 1}`,
        purpose: "先建立人物可信度和完整观点，避免用无关动效打断语义。",
        start_frame: groupItems[0]!.startFrame,
        end_frame: groupItems[groupItems.length - 1]!.endFrame,
        narrative_beat_ids: [state.snapshot.story.beats[index]!.id],
        style_pack_id: "default-clean"
      };
    });
    const compiled = await call<{ revision: { number: number }; snapshot: { scenes: Array<{ id: string }> } }>("compile_presenter_scenes", {
      project_id: projectId,
      base_revision_id: aligned.revision.number,
      scenes: scenePlans
    });
    const sceneId = compiled.snapshot.scenes[0]!.id;
    const sceneIds = compiled.snapshot.scenes.map((scene) => scene.id);
    for (const actorItem of actorItems) {
      state = await readProject(projectId);
      await call("manage_actor_performance", {
        project_id: projectId,
        base_revision_id: state.revision.number,
        timeline_item_id: actorItem.id,
        source: "imported",
        mask_mode: "none",
        audio_mode: "use_dialogue_track",
        note: "阶段 1 暂无可用人物 Mask，后景效果不使用，保持人物主画面。"
      });
    }
    state = await readProject(projectId);
    const actorItem = actorItems[0]!;
    const cueStart = Math.min(18, Math.max(0, actorItem.endFrame - 36));
    const cueEnd = Math.min(actorItem.endFrame, cueStart + 24);
    const cue = await call<{ revision: { number: number }; snapshot: { effectCues: Array<{ id: string }> } }>("manage_effect_cues", {
      project_id: projectId,
      base_revision_id: state.revision.number,
      scene_id: sceneId,
      type: "CameraPunch",
      layer: "actor",
      start_frame: cueStart,
      end_frame: cueEnd,
      narrative_purpose: "开场仅用一次轻微推近收拢人物注意力，不引入新的事实或抢夺字幕。",
      audience_task: "确认人物是这段表达的视觉锚点。",
      semantic_anchor: { type: "speech_segment", target_id: firstSpeechSegmentId, relation: "anticipate" },
      spatial_anchor: "center",
      motion: { enter_preset: "scale", settle_preset: "hold", exit_preset: "fade", enter_frames: 6, hold_frames: 12, exit_frames: 6 },
      style_pack_id: "default-clean",
      quality_rules: ["semantic_anchor_required", "settled_frame_required", "no_competing_visual"]
    });

    await call("record_creative_decision", {
      project_id: projectId,
      run_id: run.id,
      category: "semantic",
      decision: "保留 FunASR 候选的完整顺序，不做跨 Take 拼接或按字符伪造词级切点。",
      rationale: "当前只有全文转写和段级语音时序，完整思想优先于压缩。",
      object_ids: semanticIds,
      evidence: [transcriptText],
      alternatives: ["按标点进一步拆成关键词字幕", "删除未回听确认的短语"]
    });
    await call("record_creative_decision", {
      project_id: projectId,
      run_id: run.id,
      category: "story",
      decision: sourceGroups.length === 1 ? "全段用一个 PresenterScene 承载人物完整表达。" : "按连续表达段落编译少量 PresenterScene，不把每个转写候选拆成卡片。",
      rationale: sourceGroups.length === 1
        ? "素材时长短，拆成多个 Scene 会把自然表达误切成卡片。"
        : "约 50 秒口播需要可跟随的章节节奏，但 Scene 数量仍低于逐句切分，保护自然表达。",
      object_ids: [...state.snapshot.story.beats.map((beat) => beat.id), ...sceneIds],
      alternatives: ["每个转写候选单独成 Scene", "以全屏文字替换人物"]
    });
    await call("record_creative_decision", {
      project_id: projectId,
      run_id: run.id,
      category: "visual",
      decision: "只保留开场一次短 CameraPunch，其余时间是人物与稳定字幕的安静区。",
      rationale: "当前没有 Mask、手势或额外授权素材；克制处理最能保护人物、嘴部和语义。",
      object_ids: [cue.snapshot.effectCues[0]!.id],
      quiet_range: { start_frame: cueEnd, end_frame: state.snapshot.timeline.durationInFrames, reason: "高密度开场后让观众阅读字幕并建立人物信任。" },
      effect_decision: "CameraPunch 仅在开场进入一次，不与其它前后景效果叠加。",
      rejected_alternative: "不使用无关 ProductFan、CommentCloud 或 FullScreenMeme。"
    });

    state = await readProject(projectId);
    if (fullMode) {
      const durationSeconds = state.snapshot.timeline.durationInFrames / state.snapshot.timeline.fps;
      assert.ok(durationSeconds >= 45 && durationSeconds <= 60, `45-60 秒验收需要落在目标时长内，实际 ${durationSeconds.toFixed(1)} 秒`);
    }
    const preview = await call<{ id: string }>("render_preview_range", {
      project_id: projectId,
      revision: state.revision.number,
      from_frame: 0,
      to_frame: state.snapshot.timeline.durationInFrames,
      idempotency_key: "stage1-live-preview"
    });
    await runRenderJob(preview.id);
    // 同时覆盖开场、Cue 的进入/稳定/退出、片段中段和结尾；完整模式还要检查每个 Scene 的交界。
    const sceneBoundaryFrames = fullMode
      ? scenePlans.flatMap((scene) => [scene.start_frame, scene.end_frame - 1])
      : [];
    const keyFrames = [...new Set([
      0,
      cueStart,
      Math.min(cueEnd - 1, cueStart + 6),
      cueEnd - 1,
      ...sceneBoundaryFrames,
      Math.floor(state.snapshot.timeline.durationInFrames / 2),
      state.snapshot.timeline.durationInFrames - 1
    ])].sort((left, right) => left - right);
    const inspected = await call<{ frames: Array<{ frame: number; path: string; relativePath: string }> }>("inspect_composed_frames", {
      project_id: projectId,
      preview_job_id: preview.id,
      frames: keyFrames
    });
    const incomplete = await call<{ status: string; completionBlockers: string[] }>("complete_production_run", {
      project_id: projectId,
      run_id: run.id,
      final_revision: state.revision.number
    });
    const quality = await call<{ issues: Array<{ level: string; code: string; message: string }> }>("read_quality_report", { project_id: projectId });

    console.log(JSON.stringify({
      test: "presenter-stage1-live",
      workspaceRoot,
      projectId,
      revision: state.revision.number,
      sourcePath,
      sourcePaths,
      fullMode,
      durationSeconds: Number((state.snapshot.timeline.durationInFrames / state.snapshot.timeline.fps).toFixed(2)),
      transcript: transcriptText,
      previewJobId: preview.id,
      composedFrames: inspected.frames,
      productionRun: incomplete,
      blockingIssues: quality.issues.filter((entry) => entry.level === "blocking"),
      nextStep: "请基于真实预览完成四轮审片，再用 record_editorial_quality_review 与 complete_production_run 收口；脚本不会伪造这一步。"
    }, null, 2));
  } finally {
    await transport.close().catch(() => undefined);
    application.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
