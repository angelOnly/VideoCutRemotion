import type { EffectCue, ImpactReport, ProjectSnapshot } from "@videocut/contracts";

/** 以 Scene 局部时间比较依赖；整段纯平移不会改变作品内部内容或声音落点。 */
function dependency(snapshot: ProjectSnapshot, cue: EffectCue) {
  const scene = snapshot.scenes.find(entry => entry.id === cue.sceneId);
  const origin = scene?.startFrame ?? 0;
  // 未声明覆盖的旧作品仍依赖宿主内容；这里的依赖追踪不扩大其质量对账覆盖。
  const ids = cue.coveredNarrativeBeatIds ?? (cue.semanticAnchor.type === "narrative_beat" && cue.semanticAnchor.targetId ? [cue.semanticAnchor.targetId] : scene?.narrativeBeatIds ?? []);
  const beats = ids.map(id => snapshot.story.beats.find(beat => beat.id === id));
  const unitIds = new Set(beats.flatMap(beat => beat?.semanticUnitIds ?? []));
  const segments = snapshot.speechSegments.filter(segment => segment.semanticUnitIds.some(id => unitIds.has(id))
    || cue.semanticAnchor.type === "speech_segment" && segment.id === cue.semanticAnchor.targetId);
  const segmentIds = new Set(segments.map(segment => segment.id));
  const relativeRange = (range: { startFrame: number; endFrame: number }) => [range.startFrame - origin, range.endFrame - origin];
  const speechItems = snapshot.timeline.items.filter(item => item.assetId === snapshot.speechAsset?.assetId && !item.disabled);
  const main = snapshot.timeline.items.filter(item => item.sceneId === cue.sceneId && !snapshot.audioCues.some(audio => audio.timelineItemId === item.id));
  return JSON.stringify({
    scene: scene ? [scene.id, scene.endFrame - origin, scene.status] : null,
    canvas: [snapshot.timeline.width, snapshot.timeline.height, snapshot.timeline.fps],
    beats, units: snapshot.semanticUnits.filter(unit => unitIds.has(unit.id)),
    segments: segments.map(({ status: _status, ...segment }) => segment),
    speech: segmentIds.size ? [snapshot.speechAsset?.assetId, snapshot.speechAsset?.timing.segments.filter(timing => segmentIds.has(timing.speechSegmentId)).map(timing => [timing.speechSegmentId, ...relativeRange(timing)]), speechItems.map(relativeRange)] : undefined,
    main: main.map(item => [item.id, item.assetId, item.sourceStartFrame, item.sourceEndFrame, item.disabled, ...relativeRange(item)])
  });
}

/** 在同一提交内处理全部入口，再让音效对账看见已经失效的 Cue。 */
export function reconcileMotionDependencies(previous: ProjectSnapshot, snapshot: ProjectSnapshot, impact: ImpactReport): void {
  for (const cue of snapshot.effectCues) {
    if (cue.type !== "ManagedMotion" && cue.coveredNarrativeBeatIds === undefined) continue;
    const before = previous.effectCues.find(entry => entry.id === cue.id);
    if (!before) continue;
    // 比较旧作品声明的依赖，不能通过同一次主线变化顺便改覆盖声明掩盖失效。
    if (dependency(previous, before) === dependency(snapshot, before)) continue;
    cue.status = "stale";
    impact.stale.push(cue.id);
    impact.changed.push(cue.id);
    impact.dirtyRanges.push({ startFrame: before.startFrame, endFrame: before.endFrame, reason: "旧作品依赖已变化" }, { startFrame: cue.startFrame, endFrame: cue.endFrame, reason: "覆盖内容或内部时序变化，需复核固定作品" });
    impact.warnings.push(`作品 ${cue.id} 的覆盖内容、声音或 Scene 范围已改变；保持固定帧数，重新确认覆盖或提交新版本后再启用。`);
  }
}
