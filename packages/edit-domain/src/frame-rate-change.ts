import type { FrameRateChangeReport, ProjectSnapshot } from "@videocut/contracts";
import { createHash } from "node:crypto";
import { convertFrameRate, motionDurationAtFps, projectFrameRateSchema, sourceAudioTimeOrigin } from "@videocut/contracts";

/** 显式区分项目帧、源毫秒和固定作品帧，不按属性名递归改写快照。 */
export function projectFrameRateChange(previous: ProjectSnapshot, fps: number, revision = 0): { snapshot: ProjectSnapshot; report: FrameRateChangeReport } {
  const snapshot = structuredClone(previous);
  const fromFps = previous.timeline.fps;
  const report: FrameRateChangeReport = {
    revision, fromFps, toFps: fps, changed: fromFps !== fps, canApply: true,
    affectedObjectIds: [], durationBeforeSeconds: previous.timeline.durationInFrames / fromFps,
    durationAfterSeconds: previous.timeline.durationInFrames / fromFps, maxBoundaryErrorMs: 0,
    blockers: [], warnings: [], rebuild: []
  };
  if (!projectFrameRateSchema.safeParse(fps).success || !projectFrameRateSchema.safeParse(fromFps).success) {
    report.blockers.push({ code: "PROJECT_FPS_INVALID", message: "项目帧率必须是15至60的整数" }); report.canApply = false;
    return { snapshot, report };
  }
  if (!report.changed) return { snapshot, report };
  // 旁白的真实毫秒边界是上游事实；共享该边界的场景和字幕必须投影到同一新帧。
  const speechAnchors = new Map<number, number>();
  const addSpeechAnchor = (oldFrame: number, newFrame: number) => {
    const existing = speechAnchors.get(oldFrame);
    if (existing !== undefined && existing !== newFrame) report.blockers.push({ code: "PROJECT_FPS_SPEECH_ANCHOR_AMBIGUOUS", objectId: previous.speechAsset?.id, message: "原帧边界包含不同真实语音时间，目标帧率下需先确认编排边界" });
    else speechAnchors.set(oldFrame, newFrame);
  };
  for (const segment of previous.speechAsset?.timing.segments ?? []) {
    addSpeechAnchor(segment.startFrame, Math.round(segment.startMs * fps / 1000));
    addSpeechAnchor(segment.endFrame, Math.round(segment.endMs * fps / 1000));
  }
  const speechFile = previous.assets.find(asset => asset.id === previous.speechAsset?.assetId);
  if (speechFile?.metadata) addSpeechAnchor(Math.round(speechFile.metadata.durationMs * fromFps / 1000), Math.round(speechFile.metadata.durationMs * fps / 1000));
  const affected = new Set<string>([snapshot.project.id]);
  const rememberError = (before: number, after: number) => {
    report.maxBoundaryErrorMs = Math.max(report.maxBoundaryErrorMs, Math.abs(after / fps - before / fromFps) * 1000);
  };
  const frame = (value: number): number => {
    const result = convertFrameRate(value, fromFps, fps);
    rememberError(value, result);
    return result;
  };
  const fields = <T extends object>(object: T, keys: Array<keyof T>, id?: string) => {
    for (const key of keys) if (typeof object[key] === "number") {
      object[key] = frame(object[key] as number) as T[keyof T];
      if (id) affected.add(id);
    }
  };
  const range = <T extends { startFrame: number; endFrame: number }>(object: T, id?: string, projectCoordinates = true) => {
    const beforeStart = object.startFrame, beforeEnd = object.endFrame;
    object.startFrame = projectCoordinates ? speechAnchors.get(beforeStart) ?? frame(beforeStart) : frame(beforeStart);
    object.endFrame = projectCoordinates ? speechAnchors.get(beforeEnd) ?? frame(beforeEnd) : frame(beforeEnd);
    rememberError(beforeStart, object.startFrame); rememberError(beforeEnd, object.endFrame);
    if (id) affected.add(id);
    if (object.endFrame <= object.startFrame) report.blockers.push({ code: "PROJECT_FPS_RANGE_COLLAPSED", objectId: id, message: "降采样后范围不足一帧，请先调整该短范围" });
  };
  snapshot.timeline.fps = fps;
  for (const item of snapshot.timeline.items) {
    const sourceLength = item.sourceEndFrame - item.sourceStartFrame;
    const normalSpeed = sourceLength === item.endFrame - item.startFrame;
    range(item, item.id);
    fields(item, ["sourceStartFrame", "sourceEndFrame"]);
    // 项目位置共用绝对边界；一比一源范围由新片段长度推导，避免两次取整破坏正常速度。
    if (normalSpeed) item.sourceEndFrame = item.sourceStartFrame + item.endFrame - item.startFrame;
    const before = previous.timeline.items.find(entry => entry.id === item.id)!;
    rememberError(before.sourceEndFrame, item.sourceEndFrame);
    const asset = snapshot.assets.find(entry => entry.id === item.assetId);
    if (asset?.metadata && !["image", "document"].includes(asset.kind) && item.sourceEndFrame > Math.round(asset.metadata.durationMs * fps / 1000)) {
      report.blockers.push({ code: "PROJECT_FPS_SOURCE_RANGE", objectId: item.id, message: "取整后的源范围越过真实素材末端，请先调整该切口" });
    }
  }
  for (const scene of snapshot.scenes) range(scene, scene.id);
  for (const cue of snapshot.effectCues) {
    range(cue, cue.id); fields(cue, ["holdFrame"]);
    if (cue.type === "ManagedMotion") {
      const work = snapshot.assets.find(asset => asset.id === cue.assetBindings.find(binding => binding.slot === "motion")?.assetId)?.motion;
      if (work) cue.endFrame = cue.startFrame + motionDurationAtFps(work.frameCount, work.fps, fps);
      cue.motion.enterFrames = 0; cue.motion.exitFrames = 0; cue.motion.holdFrames = cue.endFrame - cue.startFrame;
      const before = previous.effectCues.find(entry => entry.id === cue.id)!;
      rememberError(before.endFrame, cue.endFrame);
      const scene = snapshot.scenes.find(entry => entry.id === cue.sceneId);
      if (scene && cue.endFrame > scene.endFrame) report.blockers.push({ code: "PROJECT_FPS_CUE_RANGE", objectId: cue.id, message: "完整作品取整后超过宿主场景，请先调整场景边界" });
    } else {
      // 分段时长从共同边界推导，保证 enter + hold + exit 不因取整多出一帧。
      const before = previous.effectCues.find(entry => entry.id === cue.id)!;
      const enterEnd = frame(before.startFrame + before.motion.enterFrames);
      const exitStart = frame(before.endFrame - before.motion.exitFrames);
      cue.motion.enterFrames = enterEnd - cue.startFrame;
      cue.motion.exitFrames = cue.endFrame - exitStart;
      cue.motion.holdFrames = exitStart - enterEnd;
    }
  }
  for (const program of snapshot.explainerPrograms) {
    for (const state of program.states) range(state, program.id, false);
    // 旧预渲染文件仍属于旧规格，键变化后不会复用其画面。
    program.cacheKey = createHash("sha256").update(`${program.cacheKey}:fps:${fps}`).digest("hex");
    affected.add(program.id);
  }
  if (snapshot.speechAsset) for (const timing of snapshot.speechAsset.timing.segments) {
    timing.startFrame = Math.round(timing.startMs * fps / 1000);
    timing.endFrame = Math.round(timing.endMs * fps / 1000);
    affected.add(snapshot.speechAsset.id);
  }
  if (snapshot.speechAlignment) for (const word of snapshot.speechAlignment.words) {
    word.startFrame = Math.round(word.startMs * fps / 1000);
    word.endFrame = Math.round(word.endMs * fps / 1000);
    affected.add(snapshot.speechAlignment.id);
    if (word.endFrame <= word.startFrame) report.blockers.push({ code: "PROJECT_FPS_WORD_COLLAPSED", objectId: snapshot.speechAlignment.id, message: "真实词级时间在目标帧率不足一帧，需调整字幕呈现精度" });
  }
  for (const alignment of snapshot.sourceAudioAlignments) {
    fields(alignment, ["sourceStartFrame", "sourceEndFrame", "timelineStartFrame", "timelineEndFrame"], alignment.id);
    if (alignment.sourceEdit) fields(alignment.sourceEdit, ["originSourceFrame"]);
    const item = snapshot.timeline.items.find(entry => entry.id === alignment.sourceTimelineItemId);
    if (item && alignment.status === "ready") Object.assign(alignment, { sourceStartFrame: item.sourceStartFrame, sourceEndFrame: item.sourceEndFrame, timelineStartFrame: item.startFrame, timelineEndFrame: item.endFrame });
  }
  for (const caption of snapshot.timeline.captions) {
    range(caption, caption.id);
    fields(caption, ["sourceStartFrame", "sourceEndFrame"]);
    for (const display of caption.display?.ranges ?? []) range(display, caption.id);
    const alignment = snapshot.sourceAudioAlignments.find(entry => entry.id === caption.sourceAlignmentId);
    const item = snapshot.timeline.items.find(entry => entry.id === caption.sourceTimelineItemId);
    if (alignment && item) {
      const program = snapshot.sourceCaptionPrograms.find(entry => entry.id === caption.sourceCaptionProgramId);
      const segment = program ? alignment.segments[program.captionIds.indexOf(caption.id)] : undefined;
      const first = caption.sourceTokenStartIndex === undefined ? undefined : alignment.tokens?.[caption.sourceTokenStartIndex];
      const last = caption.sourceTokenEndIndex === undefined ? undefined : alignment.tokens?.[caption.sourceTokenEndIndex - 1];
      const startMs = first?.startMs ?? segment?.startMs, endMs = last?.endMs ?? segment?.endMs;
      if (startMs !== undefined && endMs !== undefined) {
        caption.sourceStartFrame = sourceAudioTimeOrigin(alignment) + Math.round(startMs * fps / 1000);
        caption.sourceEndFrame = sourceAudioTimeOrigin(alignment) + Math.round(endMs * fps / 1000);
      }
    } else if (caption.speechSegmentId && caption.precision === "segment_exact") {
      const timing = snapshot.speechAsset?.timing.segments.find(entry => entry.speechSegmentId === caption.speechSegmentId);
      if (timing) { caption.startFrame = timing.startFrame; caption.endFrame = timing.endFrame; }
    }
    if (item && caption.sourceStartFrame !== undefined && caption.sourceEndFrame !== undefined) {
      caption.startFrame = item.startFrame + caption.sourceStartFrame - item.sourceStartFrame;
      caption.endFrame = item.startFrame + caption.sourceEndFrame - item.sourceStartFrame;
    }
  }
  for (const cutaway of snapshot.cutaways) {
    range(cutaway, cutaway.id); fields(cutaway, ["sourceStartFrame", "sourceEndFrame"]);
    const item = snapshot.timeline.items.find(entry => entry.id === cutaway.timelineItemId);
    if (item) Object.assign(cutaway, { startFrame: item.startFrame, endFrame: item.endFrame, sourceStartFrame: item.sourceStartFrame, sourceEndFrame: item.sourceEndFrame });
  }
  for (const marker of snapshot.markers) fields(marker, ["frame"], marker.id);
  for (const actor of snapshot.actorPerformances) if (actor.generationRange) range(actor.generationRange, actor.id);
  for (const shot of snapshot.vlogShotAnalyses) fields(shot, ["sourceStartFrame", "sourceEndFrame"], shot.id);
  for (const select of snapshot.vlogShotSelects) {
    fields(select, ["sourceStartFrame", "sourceEndFrame"], select.id);
    const item = snapshot.timeline.items.find(entry => entry.id === select.timelineItemId);
    if (item) { select.sourceStartFrame = item.sourceStartFrame; select.sourceEndFrame = item.sourceEndFrame; }
  }
  for (const beat of snapshot.vlogMusicBeats) fields(beat, ["frame"], beat.id);
  for (const group of snapshot.multicamGroups) {
    fields(group, ["programStartFrame", "programEndFrame"], group.id);
    for (const sync of group.angleSyncs) {
      fields(sync, ["sessionOffsetFrames", "driftFrames"]);
      fields(sync.evidence, ["referenceSourceFrame", "angleSourceFrame", "windowFrames"]);
      if (sync.sourceRange) range(sync.sourceRange, undefined, false);
      // 从同一事件的两个边界推导偏移，保留负偏移语义。
      sync.sessionOffsetFrames = sync.evidence.referenceSourceFrame - sync.evidence.angleSourceFrame;
    }
  }
  for (const cut of snapshot.multicamCuts) {
    fields(cut, ["sessionStartFrame", "sessionEndFrame", "sourceStartFrame", "sourceEndFrame"], cut.id);
    const group = snapshot.multicamGroups.find(entry => entry.id === cut.groupId);
    const sync = group?.angleSyncs.find(entry => entry.assetId === cut.angleAssetId);
    if (sync) { cut.sourceStartFrame = cut.sessionStartFrame - sync.sessionOffsetFrames; cut.sourceEndFrame = cut.sessionEndFrame - sync.sessionOffsetFrames; }
    const item = snapshot.timeline.items.find(entry => entry.id === cut.timelineItemId);
    const readyCuts = snapshot.multicamCuts.filter(entry => entry.groupId === cut.groupId && entry.status === "ready");
    const sessionOrigin = Math.min(...readyCuts.map(entry => entry.sessionStartFrame));
    if (item && cut.status === "ready" && group?.programStartFrame !== undefined) Object.assign(item, { startFrame: group.programStartFrame + cut.sessionStartFrame - sessionOrigin, endFrame: group.programStartFrame + cut.sessionEndFrame - sessionOrigin, sourceStartFrame: cut.sourceStartFrame, sourceEndFrame: cut.sourceEndFrame });
  }
  for (const group of snapshot.multicamGroups) {
    const readyCuts = snapshot.multicamCuts.filter(cut => cut.groupId === group.id && cut.status === "ready");
    const master = snapshot.timeline.items.find(item => item.id === group.masterAudioTimelineItemId);
    const sync = group.angleSyncs.find(entry => entry.assetId === group.masterAudioAssetId);
    if (!readyCuts.length || !master || !sync || group.programStartFrame === undefined) continue;
    const start = Math.min(...readyCuts.map(cut => cut.sessionStartFrame)), end = Math.max(...readyCuts.map(cut => cut.sessionEndFrame));
    group.programEndFrame = group.programStartFrame + end - start;
    Object.assign(master, { startFrame: group.programStartFrame, endFrame: group.programEndFrame, sourceStartFrame: start - sync.sessionOffsetFrames, sourceEndFrame: end - sync.sessionOffsetFrames });
    const scene = snapshot.scenes.find(entry => entry.id === group.sceneId);
    if (scene) { scene.startFrame = group.programStartFrame; scene.endFrame = group.programEndFrame; }
  }
  for (const plan of snapshot.soundPlans ?? []) {
    range(plan, plan.id); for (const dominant of plan.dominantRanges ?? []) range(dominant, plan.id);
  }
  for (const cue of snapshot.audioCues) {
    fields(cue, ["eventFrame", "onsetOffsetFrames", "fadeInFrames", "fadeOutFrames", "loopCrossfadeFrames"], cue.id);
    if (cue.ducking) fields(cue.ducking, ["attackFrames", "releaseFrames", "holdFrames"]);
    for (const point of cue.envelope ?? []) fields(point, ["frame"]);
    const binding = cue.effectEvent;
    if (binding) {
      fields(binding, ["localFrame", "endLocalFrame", "syncOffsetFrames"]);
      const effect = snapshot.effectCues.find(entry => entry.id === binding.effectCueId);
      const work = effect?.assetBindings.map(entry => snapshot.assets.find(asset => asset.id === entry.assetId)).find(asset => asset?.motion?.eventMap)?.motion;
      const event = work?.eventMap?.events.find(entry => entry.id === binding.eventId);
      if (event && work?.eventMap && binding.workVersion === work.eventMap.version) {
        const before = previous.audioCues.find(entry => entry.id === cue.id)?.effectEvent;
        const wasEnd = before?.endLocalFrame === undefined && event.endFrame !== undefined && before?.localFrame === Math.min(convertFrameRate(event.endFrame, work.eventMap.fps, fromFps), (previous.effectCues.find(entry => entry.id === binding.effectCueId)?.endFrame ?? 0) - (previous.effectCues.find(entry => entry.id === binding.effectCueId)?.startFrame ?? 0) - 1);
        binding.localFrame = wasEnd ? Math.min(convertFrameRate(event.endFrame!, work.eventMap.fps, fps), effect!.endFrame - effect!.startFrame - 1) : convertFrameRate(event.startFrame, work.eventMap.fps, fps);
        if (binding.endLocalFrame !== undefined && event.endFrame !== undefined) binding.endLocalFrame = convertFrameRate(event.endFrame, work.eventMap.fps, fps);
      }
      if (effect) cue.eventFrame = effect.startFrame + binding.localFrame + binding.syncOffsetFrames;
    }
    const item = snapshot.timeline.items.find(entry => entry.id === cue.timelineItemId);
    if (item && cue.eventFrame !== undefined && cue.onsetOffsetFrames !== undefined) {
      const duration = item.endFrame - item.startFrame;
      item.startFrame = cue.eventFrame - cue.onsetOffsetFrames;
      item.endFrame = item.startFrame + duration;
      if (binding?.endLocalFrame !== undefined) {
        const effect = snapshot.effectCues.find(entry => entry.id === binding.effectCueId);
        if (effect) item.endFrame = effect.startFrame + binding.endLocalFrame + binding.syncOffsetFrames;
      }
    }
    cue.mixReview = "needs_review";
  }
  snapshot.timeline.durationInFrames = Math.max(0, ...snapshot.timeline.items.filter(item => !item.disabled).map(item => item.endFrame), ...snapshot.scenes.map(scene => scene.endFrame));
  report.durationAfterSeconds = snapshot.timeline.durationInFrames / fps;
  report.affectedObjectIds = [...affected];
  report.rebuild = ["合成预览", "动画缓存", "输出规格检查", "成片声画复核"];
  report.warnings = ["帧边界按目标帧率取整；反复切换可能累积量化偏差", "提高输出帧率不会增加既有动画的运动细节", "历史预览、同步预览和审片记录仍属于原规格，不作为新Revision通过证据"];
  report.canApply = report.blockers.length === 0;
  return { snapshot, report };
}
