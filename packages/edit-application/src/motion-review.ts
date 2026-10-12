import type { Asset, JobRecord, MotionReviewEvidence, MotionReviewEvidenceInput, MotionReviewOutcome, ProjectSnapshot } from "@videocut/contracts";
import { DomainError, now, resolveCompositionReachability } from "@videocut/domain";
import { inspectEvidenceMedia, validateEditorialObservations } from "./editorial-evidence.js";

/** 验证观察对象与实际媒体；美术、连续性和设计是否成立仍需真实审看。 */
export async function validateMotionReviewEvidence(snapshot: ProjectSnapshot, revision: number, jobs: JobRecord[], asset: Asset, outcome: MotionReviewOutcome, input?: MotionReviewEvidenceInput): Promise<MotionReviewEvidence | undefined> {
  if (!input) {
    if (outcome === "passed") throw new DomainError("通过作品审阅需要完整连续动态证据；尚未观看请登记 inconclusive", "MOTION_REVIEW_EVIDENCE_REQUIRED");
    return undefined;
  }
  const motion = asset.motion!;
  if (!Number.isInteger(input.startFrame) || !Number.isInteger(input.endFrame) || input.startFrame < 0 || input.endFrame <= input.startFrame) throw new DomainError("作品审阅范围无效", "MOTION_REVIEW_RANGE_INVALID");
  let evidence: MotionReviewEvidence;
  if (input.kind === "work_proxy") {
    if (input.previewJobId || !["frames", "continuous_video"].includes(input.method)) throw new DomainError("无声作品代理只支持画面观察，不是 Preview 或声音证据", "MOTION_REVIEW_METHOD_INVALID");
    if (input.endFrame > motion.frameCount) throw new DomainError("观察超出作品局部帧范围", "MOTION_REVIEW_RANGE_INVALID");
    const media = await inspectEvidenceMedia(snapshot.project.rootPath, asset.managedPath, motion.frameCount / motion.fps, motion.fps);
    if (media.hash !== asset.sourceHash) throw new DomainError("作品代理已被替换，不能审阅旧版本", "MOTION_REVIEW_MEDIA_CHANGED");
    evidence = { ...input, relativePath: media.path, contentHash: media.hash, revision, workStartFrame: input.startFrame, workEndFrame: input.endFrame, recordedAt: now() };
  } else if (input.kind === "project_preview") {
    if (!input.previewJobId) throw new DomainError("合成证据需要 Preview Job", "MOTION_REVIEW_PREVIEW_REQUIRED");
    const active = resolveCompositionReachability(snapshot);
    const cues = snapshot.effectCues.filter(cue => active.effectCueIds.has(cue.id) && cue.type === "ManagedMotion"
      && cue.assetBindings.some(binding => binding.slot === "motion" && binding.assetId === asset.id)
      && cue.startFrame < input.endFrame && cue.endFrame > input.startFrame);
    const cue = outcome === "passed" ? cues.find(c => input.startFrame <= c.startFrame && input.endFrame >= c.endFrame) : cues[0];
    if (!cue) throw new DomainError(outcome === "passed"
      ? "project_preview 使用项目全局帧；passed 的观察范围必须完整覆盖目标版本的有效 Cue"
      : "project_preview 使用项目全局帧；观察范围未与目标版本的有效 Cue 相交，不能传入作品局部帧", "MOTION_REVIEW_CUE_MISMATCH");
    const [record] = await validateEditorialObservations(snapshot, revision, jobs, [{ ...input, previewJobId: input.previewJobId,
      pass: input.method === "audio" ? "audio_only" : input.method === "audiovisual" ? "audiovisual" : "mute_visual", observation: "校验此作品版本在合成范围内的真实媒体，具体审阅写入作品说明。" }]);
    evidence = { ...input, relativePath: record!.relativePath, contentHash: record!.contentHash, revision,
      workStartFrame: Math.max(0, Math.floor((input.startFrame - cue.startFrame) * motion.fps / snapshot.timeline.fps)),
      workEndFrame: input.endFrame >= cue.endFrame ? motion.frameCount : Math.min(motion.frameCount, Math.ceil((input.endFrame - cue.startFrame) * motion.fps / snapshot.timeline.fps)), recordedAt: now() };
  } else throw new DomainError("作品证据类型无效", "MOTION_REVIEW_EVIDENCE_INVALID");
  if (outcome === "passed" && (!["continuous_video", "audiovisual"].includes(input.method) || evidence.workStartFrame !== 0 || evidence.workEndFrame !== motion.frameCount)) throw new DomainError("静帧、只听声音或局部范围不能证明完整作品动态通过", "MOTION_REVIEW_INCOMPLETE");
  return evidence;
}
