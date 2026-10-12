import { sourceAudioTimeOrigin, type CaptionCard, type Id, type ImpactReport, type ProjectSnapshot, type SourceAudioAlignment, type TimelineItem } from "@videocut/contracts";
import { assetById, createId, DomainError, millisecondsToFrames, now, trackByName } from "@videocut/domain";

export interface PresenterSourceEditInput {
  timelineItemId: Id;
  keepRanges: Array<{ sourceStartFrame: number; sourceEndFrame: number }>;
  reason: string;
}

/** 只保留整张、有来源依据的字幕；跨卡切口必须先由剪辑师利用真实 token 重新分卡。 */
function copySourceCaptions(snapshot: ProjectSnapshot, original: TimelineItem, replacements: TimelineItem[], impact: ImpactReport, revision: number): void {
  const sourceCards = snapshot.timeline.captions.filter((card) => card.sourceKind === "source_audio" && card.sourceTimelineItemId === original.id);
  const program = snapshot.sourceCaptionPrograms.find((candidate) => candidate.sourceTimelineItemId === original.id);
  const alignment = program ? snapshot.sourceAudioAlignments.find((candidate) => candidate.id === program.alignmentId && candidate.status === "ready") : undefined;
  if (program && !alignment) throw new DomainError("原声字幕 Program 没有当前可用的对齐依据", "SOURCE_EDIT_ALIGNMENT_NOT_READY");

  for (const item of replacements) {
    for (const card of sourceCards) {
      if (card.sourceStartFrame === undefined || card.sourceEndFrame === undefined) throw new DomainError("字幕缺少源时间，无法安全裁剪", "SOURCE_EDIT_CAPTION_TIMING_REQUIRED");
      const intersects = card.sourceStartFrame < item.sourceEndFrame && card.sourceEndFrame > item.sourceStartFrame;
      if (intersects && (card.sourceStartFrame < item.sourceStartFrame || card.sourceEndFrame > item.sourceEndFrame)) {
        throw new DomainError(`切口穿过字幕 ${card.id}；请先依据已验证的 token 调整字幕分卡，或选择不切断该字幕的源边界，不能按字数估时`, "SOURCE_EDIT_CAPTION_BOUNDARY_CONFLICT");
      }
    }
  }

  const retainedIds = new Set<Id>();
  const nextCards: CaptionCard[] = [];
  for (const item of replacements) {
    const cards = sourceCards.filter((card) => card.sourceStartFrame! >= item.sourceStartFrame && card.sourceEndFrame! <= item.sourceEndFrame)
      .sort((left, right) => left.sourceStartFrame! - right.sourceStartFrame!);
    if (!cards.length) continue;
    const nextProgramId = program ? createId("source_caption_program") : undefined;
    let nextAlignment: SourceAudioAlignment | undefined;
    const tokenTimed = alignment?.tokenPrecision === "provider_token_timed";
    const tokenOffset = tokenTimed ? cards[0]!.sourceTokenStartIndex! : undefined;
    if (alignment && program) {
      const tokens = tokenTimed ? alignment.tokens!.slice(tokenOffset!, cards.at(-1)!.sourceTokenEndIndex).map((token, index) => ({ ...token, index })) : undefined;
      const segments = cards.map((card) => {
        if (!tokenTimed) {
          const index = program.captionIds.indexOf(card.id);
          if (index < 0 || !alignment.segments[index]) throw new DomainError("字幕与原 Provider 段不一致", "SOURCE_EDIT_CAPTION_MAPPING_INVALID");
          return structuredClone(alignment.segments[index]!);
        }
        const first = alignment.tokens![card.sourceTokenStartIndex!]!;
        const last = alignment.tokens![card.sourceTokenEndIndex! - 1]!;
        return { displayText: card.sourceText!, startMs: first.startMs, endMs: last.endMs,
          tokenStartIndex: card.sourceTokenStartIndex! - tokenOffset!, tokenEndIndex: card.sourceTokenEndIndex! - tokenOffset! };
      });
      nextAlignment = {
        ...structuredClone(alignment), id: createId("source_audio_alignment"), sourceTimelineItemId: item.id,
        sourceStartFrame: item.sourceStartFrame, sourceEndFrame: item.sourceEndFrame,
        timelineStartFrame: item.startFrame, timelineEndFrame: item.endFrame, requestedRevision: revision,
        transcriptText: segments.map((segment) => segment.displayText).join(""), tokens, segments,
        sentenceCandidateMode: "none", sentences: [], status: "ready", createdAt: now(),
        sourceEdit: { parentAlignmentId: alignment.id, originSourceFrame: sourceAudioTimeOrigin(alignment), parentTokenStartIndex: tokenOffset }
      };
      snapshot.sourceAudioAlignments.push(nextAlignment);
      snapshot.sourceCaptionPrograms.push({ ...structuredClone(program), id: nextProgramId!, alignmentId: nextAlignment.id,
        sourceTimelineItemId: item.id, captionIds: cards.map((card) => card.id), createdAt: now() });
      impact.changed.push(nextAlignment.id, nextProgramId!);
    }
    for (const card of cards) {
      retainedIds.add(card.id);
      nextCards.push({ ...structuredClone(card), sourceTimelineItemId: item.id,
        startFrame: item.startFrame + card.sourceStartFrame! - item.sourceStartFrame,
        endFrame: item.startFrame + card.sourceEndFrame! - item.sourceStartFrame,
        sourceAlignmentId: nextAlignment?.id, sourceCaptionProgramId: nextProgramId,
        sourceTokenStartIndex: tokenTimed ? card.sourceTokenStartIndex! - tokenOffset! : card.sourceTokenStartIndex,
        sourceTokenEndIndex: tokenTimed ? card.sourceTokenEndIndex! - tokenOffset! : card.sourceTokenEndIndex });
      impact.moved.push(card.id);
    }
  }
  if (program) {
    snapshot.sourceCaptionPrograms = snapshot.sourceCaptionPrograms.filter((candidate) => candidate.id !== program.id);
    impact.stale.push(program.id);
  }
  for (const evidence of snapshot.sourceAudioAlignments.filter((candidate) => candidate.sourceTimelineItemId === original.id && candidate.status === "ready")) {
    evidence.status = "stale";
    impact.stale.push(evidence.id);
  }
  snapshot.timeline.captions = snapshot.timeline.captions.filter((card) => !sourceCards.some((candidate) => candidate.id === card.id));
  snapshot.timeline.captions.push(...nextCards);
  impact.stale.push(...sourceCards.filter((card) => !retainedIds.has(card.id)).map((card) => card.id));
}

/**
 * 源裁剪是一次单调的时间映射：只删除明确舍弃的源范围，不重排、变速、重编码或生成新声音。
 * 原 Item 与原始对齐保留为 disabled/stale 审计对象，已保留卡片的文字、版式和时间精度不降级。
 */
export function editPresenterSourceInSnapshot(snapshot: ProjectSnapshot, impact: ImpactReport, input: PresenterSourceEditInput, revision: number): { affectedSceneIds: Set<Id>; firstRemovedFrame?: number } {
  const track = trackByName(snapshot, "Actor / A-roll");
  const original = snapshot.timeline.items.find((item) => item.id === input.timelineItemId);
  if (!original || original.disabled || original.trackId !== track.id) throw new DomainError("裁剪目标必须是当前可播放的原声 A-roll Item", "SOURCE_EDIT_ITEM_NOT_FOUND");
  if (track.locked) throw new DomainError("人物轨道已锁定", "TRACK_LOCKED");
  const performance = snapshot.actorPerformances.find((candidate) => candidate.timelineItemId === original.id);
  const asset = assetById(snapshot, original.assetId);
  if (performance?.status !== "ready" || performance.source !== "imported" || performance.audioMode !== "use_source_audio" || performance.maskMode !== "none"
    || asset.status !== "ready" || !asset.metadata?.hasAudio || !asset.metadata.videoCodec) {
    throw new DomainError("源裁剪目前只支持无 Mask、已就绪、保留原声的导入人物视频；不能裁断生成型口型或外置声音绑定", "SOURCE_EDIT_PERFORMANCE_UNSUPPORTED");
  }
  if (snapshot.speechAsset?.status === "ready" || snapshot.timeline.items.some((item) => !item.disabled && snapshot.timeline.tracks.some((candidate) => candidate.id === item.trackId && candidate.name === "Dialogue"))) {
    throw new DomainError("存在独立 Dialogue 时不能仅裁原声人物轨；请回到对应语音主工作流", "SOURCE_EDIT_DIALOGUE_CONFLICT");
  }
  if (original.endFrame - original.startFrame !== original.sourceEndFrame - original.sourceStartFrame) throw new DomainError("源裁剪要求一比一声画映射，不支持变速片段", "SOURCE_EDIT_TIME_MAPPING_UNSUPPORTED");
  if (!input.reason?.trim() || input.reason.length > 2000) throw new DomainError("必须记录源片审阅与裁剪理由", "SOURCE_EDIT_REASON_REQUIRED");
  if (!Array.isArray(input.keepRanges) || input.keepRanges.length > 160) throw new DomainError("保留范围必须为至多160个有序源区间", "SOURCE_EDIT_RANGES_INVALID");
  let previousEnd = original.sourceStartFrame;
  for (const range of input.keepRanges) {
    if (!Number.isInteger(range.sourceStartFrame) || !Number.isInteger(range.sourceEndFrame)
      || range.sourceStartFrame < previousEnd || range.sourceEndFrame <= range.sourceStartFrame || range.sourceEndFrame > original.sourceEndFrame
      || range.sourceEndFrame > millisecondsToFrames(asset.metadata.durationMs, snapshot.timeline.fps)) {
      throw new DomainError("保留区间必须是当前 Item 源范围内有序、不重叠的整帧区间；源帧使用项目 FPS", "SOURCE_EDIT_RANGES_INVALID");
    }
    previousEnd = range.sourceEndFrame;
  }
  const otherActors = snapshot.timeline.items.filter((item) => item.trackId === track.id && item.id !== original.id && !item.disabled);
  if (otherActors.some((item) => item.startFrame < original.endFrame && item.endFrame > original.startFrame)) {
    throw new DomainError("人物主轨存在重叠，必须先明确主声画所有权", "SOURCE_EDIT_OVERLAPPING_ACTORS");
  }
  if (!input.keepRanges.length && !otherActors.length) throw new DomainError("不能删除最后一条主画面", "SOURCE_EDIT_EMPTY_MAINLINE");
  if (input.keepRanges.length === 1 && input.keepRanges[0]!.sourceStartFrame === original.sourceStartFrame && input.keepRanges[0]!.sourceEndFrame === original.sourceEndFrame) {
    throw new DomainError("保留范围与原片段相同，没有需要提交的裁剪", "SOURCE_EDIT_NO_CHANGE");
  }
  let cursor = original.startFrame;
  const replacements = input.keepRanges.map((range): TimelineItem => {
    const item = { ...structuredClone(original), id: createId("item"), ...range, startFrame: cursor,
      endFrame: cursor + range.sourceEndFrame - range.sourceStartFrame, directOverride: true, disabled: false };
    cursor = item.endFrame;
    return item;
  });
  const removed: Array<{ start: number; end: number }> = [];
  let sourceCursor = original.sourceStartFrame;
  for (const range of [...input.keepRanges, { sourceStartFrame: original.sourceEndFrame, sourceEndFrame: original.sourceEndFrame }]) {
    if (range.sourceStartFrame > sourceCursor) removed.push({ start: original.startFrame + sourceCursor - original.sourceStartFrame,
      end: original.startFrame + range.sourceStartFrame - original.sourceStartFrame });
    sourceCursor = range.sourceEndFrame;
  }
  const mapFrame = (frame: number): number => frame - removed.reduce((sum, range) => sum + Math.max(0, Math.min(frame, range.end) - range.start), 0);
  const intersectsRemoved = (start: number, end: number): boolean => removed.some((range) => start < range.end && end > range.start);
  const affectedSceneIds = new Set<Id>();

  // 纯拆分不改变播放时间；只有实际删除才影响后续独立对象和锁定轨道。
  const firstRemovedFrame = removed[0]?.start;
  if (firstRemovedFrame !== undefined) {
    const managed = new Set([...snapshot.audioCues.map((cue) => cue.timelineItemId), ...snapshot.cutaways.map((cutaway) => cutaway.timelineItemId)]);
    if (snapshot.timeline.items.some((item) => !item.disabled && item.trackId !== track.id && item.endFrame > firstRemovedFrame && !managed.has(item.id))) {
      throw new DomainError("受影响范围存在非受管的其它轨道片段，不能猜测它们如何跟随原声裁剪", "SOURCE_EDIT_UNMANAGED_TRACK_CONFLICT");
    }
    if (snapshot.scenes.some((scene) => scene.status === "ready" && scene.endFrame > firstRemovedFrame && !["PresenterScene", "CutawayScene"].includes(scene.type))) {
      throw new DomainError("原声裁剪不能隐式改写另一种主工作流的场景", "SOURCE_EDIT_SCENE_CONFLICT");
    }
    for (const item of otherActors.filter((candidate) => candidate.startFrame >= original.endFrame)) {
      const nextPerformance = snapshot.actorPerformances.find((candidate) => candidate.timelineItemId === item.id);
      if (nextPerformance?.status !== "ready" || nextPerformance.source !== "imported" || nextPerformance.audioMode !== "use_source_audio"
        || nextPerformance.maskMode !== "none" || nextPerformance.generationRange
        || item.endFrame - item.startFrame !== item.sourceEndFrame - item.sourceStartFrame) {
        throw new DomainError("后续人物片段必须同样是已就绪的一比一原声视频，不能隐式移动生成或外置声音绑定", "SOURCE_EDIT_FOLLOWING_ACTOR_UNSUPPORTED");
      }
    }
    const affectedHosts = new Set(snapshot.scenes.filter((scene) => scene.type === "PresenterScene"
      && (mapFrame(scene.startFrame) !== scene.startFrame || mapFrame(scene.endFrame) !== scene.endFrame)).map((scene) => scene.id));
    const affectedItemIds = new Set([
      ...snapshot.cutaways.filter((cutaway) => affectedHosts.has(cutaway.hostSceneId)).map((cutaway) => cutaway.timelineItemId),
      ...snapshot.audioCues.map((cue) => cue.timelineItemId).filter((id) => snapshot.timeline.items.some((item) => item.id === id && item.endFrame > firstRemovedFrame))
    ]);
    if (snapshot.timeline.items.some((item) => !item.disabled && affectedItemIds.has(item.id)
      && snapshot.timeline.tracks.some((candidate) => candidate.id === item.trackId && candidate.locked))) {
      throw new DomainError("受影响的声音或 Cutaway 轨道已锁定，不能在裁剪时隐式停用", "TRACK_LOCKED");
    }
  }

  copySourceCaptions(snapshot, original, replacements, impact, revision);
  original.disabled = true;
  performance.status = "stale";
  snapshot.timeline.items.push(...replacements);
  for (const item of replacements) {
    snapshot.actorPerformances.push({ ...structuredClone(performance), id: createId("actor_performance"), timelineItemId: item.id,
      status: "ready", note: `${performance.note}\n原声裁剪：${input.reason.trim()}`.trim(), createdAt: now() });
  }
  impact.changed.push(original.id, ...replacements.map((item) => item.id));
  impact.stale.push(performance.id);
  for (const item of otherActors) {
    if (item.startFrame < original.endFrame) continue;
    const delta = mapFrame(item.startFrame) - item.startFrame;
    if (!delta) continue;
    item.startFrame += delta;
    item.endFrame += delta;
    impact.moved.push(item.id);
    for (const card of snapshot.timeline.captions.filter((card) => card.sourceKind === "source_audio" && card.sourceTimelineItemId === item.id)) {
      card.startFrame += delta;
      card.endFrame += delta;
      impact.moved.push(card.id);
    }
    for (const alignment of snapshot.sourceAudioAlignments.filter((candidate) => candidate.sourceTimelineItemId === item.id && candidate.status === "ready")) {
      alignment.timelineStartFrame += delta;
      alignment.timelineEndFrame += delta;
      impact.moved.push(alignment.id);
    }
  }
  for (const scene of snapshot.scenes.filter((candidate) => candidate.type === "PresenterScene")) {
    const start = mapFrame(scene.startFrame);
    const end = mapFrame(scene.endFrame);
    if (start === scene.startFrame && end === scene.endFrame) continue;
    affectedSceneIds.add(scene.id);
    if (end <= start) {
      scene.status = "stale";
      impact.stale.push(scene.id);
    } else {
      scene.startFrame = start;
      scene.endFrame = end;
      impact.changed.push(scene.id);
    }
  }
  for (const cue of snapshot.effectCues.filter((candidate) => affectedSceneIds.has(candidate.sceneId))) {
    if (intersectsRemoved(cue.startFrame, cue.endFrame)) {
      cue.status = "stale";
      impact.stale.push(cue.id);
    } else {
      cue.startFrame = mapFrame(cue.startFrame);
      cue.holdFrame = mapFrame(cue.holdFrame);
      cue.endFrame = mapFrame(cue.endFrame);
      impact.moved.push(cue.id);
    }
  }
  for (const treatment of snapshot.visualTreatments) {
    if ((treatment.sceneId && affectedSceneIds.has(treatment.sceneId)) || (treatment.narrativeBeatId
      && snapshot.story.beats.some((beat) => beat.id === treatment.narrativeBeatId && beat.sceneIds.some((id) => affectedSceneIds.has(id))))) {
      treatment.status = "stale";
      treatment.updatedAt = now();
      impact.stale.push(treatment.id);
    }
  }
  impact.recomputed.push("原声人物源区间、声画同步裁剪、后续主轨/字幕/场景平移；保留字幕的文案、版式和 Provider 时间证据");
  impact.dirtyRanges.push({ startFrame: original.startFrame, endFrame: snapshot.timeline.durationInFrames, reason: "原声人物裁剪及后续时间映射" });
  impact.warnings.push("源裁剪不自动判断重复或改写语义；请连续复听切口、复核字幕与失效包装，并为当前 Revision 重新生成预览和审片证据。");
  return { affectedSceneIds, firstRemovedFrame };
}
