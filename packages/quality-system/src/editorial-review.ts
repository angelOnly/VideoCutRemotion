import type { EditorialQualityReview, EditorialReviewEvidence, EditorialReviewFinding, EditorialReviewPass, ProjectSnapshot, QualityReport } from "@videocut/contracts";
import { resolveCompositionReachability } from "@videocut/domain";

export const EDITORIAL_PASSES: EditorialReviewPass[] = ["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"];

export function evidenceSupportsPass(evidence: Pick<EditorialReviewEvidence, "method" | "pass">): boolean {
  if (evidence.pass === "audio_only") return evidence.method === "audio";
  if (evidence.pass === "mute_visual") return evidence.method === "continuous_video";
  return evidence.method === "audiovisual";
}

export function missingReviewRanges(ranges: Array<{ startFrame: number; endFrame: number }>, startFrame: number, endFrame: number) {
  const missing: Array<{ startFrame: number; endFrame: number }> = [];
  let cursor = startFrame;
  for (const range of [...ranges].sort((a, b) => a.startFrame - b.startFrame)) {
    if (range.endFrame <= cursor || range.startFrame >= endFrame) continue;
    if (range.startFrame > cursor) missing.push({ startFrame: cursor, endFrame: range.startFrame });
    cursor = Math.min(endFrame, Math.max(cursor, range.endFrame));
  }
  if (cursor < endFrame) missing.push({ startFrame: cursor, endFrame });
  return missing;
}

export function reviewCoverage(review: EditorialQualityReview | undefined, revision: number, duration: number): NonNullable<QualityReport["editorial"]["coverage"]> {
  return EDITORIAL_PASSES.map((pass) => {
    const evidence = (review?.evidenceRecords ?? []).filter((entry) => entry.revision === revision && entry.pass === pass && evidenceSupportsPass(entry));
    // 首次观众轮必须连续看完整片，不能拼合多个互不相邻的观看会话。
    const ranges = pass === "first_viewer" ? evidence.filter((entry) => entry.startFrame === 0 && entry.endFrame === duration) : evidence;
    const missingRanges = missingReviewRanges(ranges, 0, duration);
    return { pass, complete: duration > 0 && missingRanges.length === 0, missingRanges };
  });
}

export function openEditorialFindings(review: EditorialQualityReview | undefined): EditorialReviewFinding[] {
  const resolved = new Set((review?.resolutions ?? []).filter((entry) => entry.revision <= review!.revision).map((entry) => entry.findingId));
  return (review?.findings ?? []).filter((finding) => !resolved.has(finding.id));
}

/** 合并全部 Run 的审计；历史问题保留，只有目标 Revision 的证据能补足本版覆盖。 */
export function mergeEditorialReviews(reviews: EditorialQualityReview[], revision: number): EditorialQualityReview | undefined {
  const eligible = reviews.filter((review) => review.revision <= revision).sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
  if (!eligible.length) return undefined;
  const current = eligible.filter((review) => review.revision === revision);
  const unique = <T>(values: T[], key: (value: T) => string): T[] => [...new Map(values.map((value) => [key(value), value])).values()];
  return {
    revision: current.length ? revision : eligible[eligible.length - 1]!.revision,
    passes: [...new Set(current.flatMap((review) => review.passes))],
    previewEvidence: [...new Set(current.flatMap((review) => review.previewEvidence))],
    findings: unique(eligible.flatMap((review) => review.findings.map((finding) => ({ ...finding, revision: finding.revision ?? review.revision }))), (finding) => finding.id),
    evidenceRecords: unique(eligible.flatMap((review) => review.evidenceRecords ?? []), (evidence) => evidence.id),
    resolutions: unique(eligible.flatMap((review) => review.resolutions ?? []), (resolution) => resolution.findingId),
    reviewedAt: eligible[eligible.length - 1]!.reviewedAt
  };
}

export function productionReconciliation(snapshot: ProjectSnapshot): NonNullable<QualityReport["productionReconciliation"]> {
  const active = resolveCompositionReachability(snapshot);
  return [...snapshot.story.beats].sort((a, b) => a.order - b.order).map((beat) => {
    // 同属一个长 Scene 不代表某个 Cue 实现了这个 Scene 内的每一拍。
    const treatments = snapshot.visualTreatments.filter((entry) => entry.narrativeBeatId === beat.id);
    const cues = snapshot.effectCues.filter((cue) => active.effectCueIds.has(cue.id) && (cue.coveredNarrativeBeatIds !== undefined
      ? cue.coveredNarrativeBeatIds.includes(beat.id) : cue.semanticAnchor.type === "narrative_beat" && cue.semanticAnchor.targetId === beat.id));
    const cutaways = snapshot.cutaways.filter((entry) => entry.status === "ready" && treatments.some((treatment) => treatment.id === entry.visualTreatmentId) && active.videoItemIds.has(entry.timelineItemId));
    const programs = snapshot.explainerPrograms.filter((program) => active.explainerProgramIds.has(program.id) && snapshot.narrativeMap?.beats.some((entry) => entry.id === program.narrativeMapBeatId && entry.narrativeBeatId === beat.id));
    const scenes = snapshot.scenes.filter((scene) => beat.sceneIds.includes(scene.id));
    const inScene = (range: { startFrame: number; endFrame: number }) => scenes.some((scene) => range.startFrame < scene.endFrame && range.endFrame > scene.startFrame);
    const audio = snapshot.audioCues.filter((cue) => cue.status === "ready" && active.audioItemIds.has(cue.timelineItemId) && snapshot.timeline.items.some((item) => item.id === cue.timelineItemId && inScene(item)));
    const needs: string[] = [];
    if (!treatments.length) needs.push("没有明确关联本 Beat 的视觉计划；检查是否遗漏，不能把共用 Scene 当成逐拍计划。");
    if (treatments.some((entry) => entry.status === "stale")) needs.push("重新确认失效视觉计划与当前成片是否一致。");
    for (const treatment of treatments.filter((entry) => entry.status === "ready")) {
      if (["light_overlay", "remotion"].includes(treatment.mode) && !cues.length && !programs.length) needs.push(`${treatment.id} 没有明确绑定本 Beat 的有效 Cue/Program；待实施或核实关联。`);
      if (["b_roll", "cutaway", "evidence"].includes(treatment.mode) && !cutaways.length && !cues.length && !programs.length) needs.push(`${treatment.id} 未发现明确关联的有效视觉对象；待实施或核实关联。`);
      if (["quiet", "keep_presenter"].includes(treatment.mode) && !treatment.quietReason) needs.push(`${treatment.id} 需要说明人物保持或留白如何服务观看。`);
    }
    return { beatId: beat.id, title: beat.title, treatmentIds: treatments.map((entry) => entry.id), staleTreatmentIds: treatments.filter((entry) => entry.status === "stale").map((entry) => entry.id), linkedEffectCueIds: cues.map((entry) => entry.id), linkedCutawayIds: cutaways.map((entry) => entry.id), linkedExplainerProgramIds: programs.map((entry) => entry.id), sceneAudioCueIds: audio.map((entry) => entry.id), sceneCaptionIds: snapshot.timeline.captions.filter(inScene).map((entry) => entry.id), sceneIds: beat.sceneIds, needs };
  });
}
