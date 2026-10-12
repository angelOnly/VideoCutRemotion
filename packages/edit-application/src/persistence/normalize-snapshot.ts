import { DEFAULT_CAPTION_FORMAT, DEFAULT_TRACKS, type ProjectSnapshot } from "@videocut/contracts";
import { createId, createStoryDocument } from "@videocut/domain";
import { normalizeCandidateFilters } from "../../../media-intelligence/src/candidate-lifecycle.js";

/**
 * 为已有项目补齐新增的快照字段；旧 Revision 在下一次提交时自然升级，不改写历史记录。
 *
 * 这属于持久化兼容边界，不应泄漏到具体视频业务命令中。
 */
export function normalizeSnapshot(snapshot: ProjectSnapshot): ProjectSnapshot {
  snapshot.story ??= createStoryDocument(snapshot.project.name, snapshot.project.updatedAt);
  snapshot.assetRequests ??= [];
  snapshot.searchIntents ??= [];
  snapshot.assetCandidates ??= [];
  for (const candidate of snapshot.assetCandidates) normalizeCandidateFilters(candidate, snapshot.assetRequests.find(request => request.id === candidate.assetRequestId));
  snapshot.evidenceCaptures ??= [];
  snapshot.explainerPrograms ??= [];
  snapshot.vlogShotAnalyses ??= [];
  snapshot.vlogEvents ??= [];
  snapshot.vlogShotSelects ??= [];
  snapshot.vlogAmbientCues ??= [];
  snapshot.vlogMusicBeats ??= [];
  snapshot.multicamGroups ??= [];
  snapshot.multicamCuts ??= [];
  snapshot.agentWorkOrders ??= [];
  for (const workOrder of snapshot.agentWorkOrders) {
    // 旧完成记录没有结果对象与 Impact 证据，不能在升级后倒推为“已编辑”。
    if (workOrder.status === "completed" && !workOrder.completionKind) {
      workOrder.completionKind = "reviewed_no_change";
      workOrder.resultChangedObjectIds = undefined;
      workOrder.resultImpact = undefined;
    }
  }
  // 新增 Ambient 后，旧项目不需要重建 Revision；仅补一条空轨，原有 Item 与顺序保持不变。
  if (!snapshot.timeline.tracks.some((track) => track.name === "Ambient")) {
    const ambient = DEFAULT_TRACKS.find((track) => track.name === "Ambient");
    if (ambient) {
      snapshot.timeline.tracks.push({
        id: createId("track"),
        ...ambient,
        order: Math.max(-1, ...snapshot.timeline.tracks.map((track) => track.order)) + 1,
        locked: false,
        hidden: false,
        muted: false
      });
    }
  }
  snapshot.visualTreatments ??= [];
  snapshot.cutaways ??= [];
  snapshot.audioCues ??= [];
  snapshot.voiceReferences ??= [];
  // 旧 Revision 没有分离保存原声时间证据和视觉字幕 Program；只补空集合，绝不倒推或伪造 token 对齐。
  snapshot.sourceAudioAlignments ??= [];
  for (const alignment of snapshot.sourceAudioAlignments) {
    // 历史 v2/v3 记录保留 Provider 标点候选；正式 v4 段级对齐会显式保存 none。
    alignment.sentenceCandidateMode ??= alignment.sentences?.length ? "provider_punctuation" : "none";
    // 旧快照中只要有 token，就只能按已存在的 Provider token 时间处理；没有时绝不倒推或估算。
    alignment.tokenPrecision ??= alignment.tokens?.length ? "provider_token_timed" : "unavailable";
    // 旧记录没有正式段级结果；保留原审计以供读取，但绝不倒推或估算 segment 时间。
    alignment.segments ??= [];
  }
  snapshot.sourceCaptionPrograms ??= [];
  for (const program of snapshot.sourceCaptionPrograms) {
    // 旧 Program 都来自人工/Agent 分卡，不能在升级时伪称 Provider 默认结果。
    program.source ??= "editorial_override";
  }
  snapshot.transcriptSentenceCandidates ??= [];
  for (const caption of snapshot.timeline.captions ?? []) {
    // 旧快照没有保存原始语音文案时，以当时已经渲染的文字作为可回退来源。
    caption.sourceKind ??= "speech_asset";
    caption.sourceText ??= caption.text;
    caption.textMode ??= "derived";
    if (snapshot.timeline.captionFormat) { delete caption.format; delete caption.emphasis; }
    else caption.format ??= { ...DEFAULT_CAPTION_FORMAT };
  }
  for (const reference of snapshot.voiceReferences) {
    reference.source ??= "local_asset";
    reference.usageNote ??= "仅用于当前项目的本地语音合成。";
    reference.recommendedRange ??= { startMs: 0, endMs: 0 };
    reference.quality ??= "warning";
    reference.usable ??= true;
  }
  snapshot.actorCapabilityProfiles ??= [];
  for (const profile of snapshot.actorCapabilityProfiles) {
    // 旧档案没有明确声明口型能力时，一律按未验证处理，不能因为可上传音频就假定已同步。
    profile.supportsAudioDrivenLipSync ??= false;
  }
  snapshot.actorPerformances ??= [];
  for (const performance of snapshot.actorPerformances) {
    // 旧快照缺少声音所有权时，优先选择 Dialogue，宁可提示复核也不能继续双声叠加。
    performance.audioMode ??= snapshot.speechAsset ? "use_dialogue_track" : "use_source_audio";
  }
  for (const unit of snapshot.semanticUnits ?? []) {
    if (unit.sourceKind !== "authored" && !unit.candidateIds?.length && unit.transcriptId && unit.sourceAssetId) {
      const legacyCandidateId = `sentence_candidate_legacy_${unit.id}`;
      if (!snapshot.transcriptSentenceCandidates.some((candidate) => candidate.id === legacyCandidateId)) {
        snapshot.transcriptSentenceCandidates.push({
          id: legacyCandidateId,
          transcriptId: unit.transcriptId,
          sourceAssetId: unit.sourceAssetId,
          text: unit.text,
          order: unit.order
        });
      }
      unit.candidateIds = [legacyCandidateId];
    }
    unit.kind ??= "statement";
    unit.dependencies ??= [];
    unit.precedingContext ??= "";
    unit.followingContext ??= "";
    unit.confidence ??= 0.5;
  }
  for (const segment of snapshot.speechSegments ?? []) {
    segment.pauseBefore ??= { durationMs: segment.prePauseMs ?? 0, reason: "sentence" };
    if (segment.pauseAfter === undefined && (segment.postPauseMs ?? 0) > 0) {
      segment.pauseAfter = { durationMs: segment.postPauseMs ?? 0, reason: "sentence" };
    }
  }
  for (const cue of snapshot.effectCues ?? []) {
    // coveredNarrativeBeatIds 原样保留；旧快照缺省时继续单锚点对账，不填满宿主 Scene。
    cue.narrativePurpose ??= cue.note || "支持当前叙事重点";
    cue.audienceTask ??= "理解当前表达";
    cue.semanticAnchor ??= {
      type: cue.anchorTargetId ? "speech_segment" : "scene",
      targetId: cue.anchorTargetId ?? cue.sceneId,
      relation: "land_on"
    };
    cue.spatialAnchor ??= cue.layer === "fullscreen" ? "full_frame" : cue.layer === "rear" ? "middle_left" : "bottom_right";
    cue.assetBindings ??= [];
    cue.props ??= {};
    cue.motion ??= {
      enterPreset: "fade_slide",
      settlePreset: "hold",
      exitPreset: "fade",
      enterFrames: 10,
      holdFrames: Math.max(0, cue.endFrame - cue.startFrame - 20),
      exitFrames: 10
    };
    cue.stylePackId ??= "default-clean";
    cue.qualityRules ??= [];
  }
  return snapshot;
}
