import type { JobRecord, ProjectSnapshot } from "@videocut/contracts";
import { inspectEffectContentContract } from "@videocut/contracts";
import { assertProjectGraphValid, assertTimelineValid, DomainError, projectFrameRateChange } from "@videocut/domain";
import { effectAudioSignature } from "./effect-audio-events.js";

/** 预检查和正式提交共用同一计算；只刷新可证明仍成立的派生签名。 */
export function prepareProjectFrameRateChange(previous: ProjectSnapshot, fps: number, revision: number, jobs: JobRecord[]) {
  const change = projectFrameRateChange(previous, fps, revision);
  const { snapshot, report } = change;
  if (!report.changed || !report.canApply) return change;
  const readOnlyKinds = new Set(["preview", "render_preflight", "export", "media_understanding", "media_search", "motion_library_search", "motion_reference_analysis", "sound_ranking", "sound_comparison"]);
  for (const job of jobs) if (["queued", "running", "unknown"].includes(job.status) && !readOnlyKinds.has(job.kind)) {
    report.blockers.push({ code: "PROJECT_FPS_PENDING_JOB", objectId: job.id, message: `${job.kind}任务尚未终态或结果未知，需先对账再变更项目帧率` });
  }
  for (const audio of snapshot.audioCues) {
    const before = previous.audioCues.find(entry => entry.id === audio.id);
    const oldCue = previous.effectCues.find(entry => entry.id === before?.effectEvent?.effectCueId);
    const cue = snapshot.effectCues.find(entry => entry.id === audio.effectEvent?.effectCueId);
    if (audio.effectEvent && before?.effectEvent && oldCue && cue
      && before.effectEvent.cueSignature === effectAudioSignature(previous, oldCue)) {
      audio.effectEvent.cueSignature = effectAudioSignature(snapshot, cue);
    }
  }
  for (const cue of snapshot.effectCues) if (cue.status === "ready") {
    const before = previous.effectCues.find(entry => entry.id === cue.id);
    if (before && inspectEffectContentContract(before, previous.assets, previous.timeline).ready) {
      const content = inspectEffectContentContract(cue, snapshot.assets, snapshot.timeline);
      if (!content.ready) report.blockers.push({ code: "PROJECT_FPS_CONTENT_INVALID", objectId: cue.id, message: content.missing.join("；") });
    }
  }
  try { assertTimelineValid(snapshot); assertProjectGraphValid(snapshot); }
  catch (error) { report.blockers.push({ code: error instanceof DomainError ? error.code : "PROJECT_FPS_MAPPING_INVALID", message: error instanceof Error ? error.message : String(error) }); }
  report.canApply = report.blockers.length === 0;
  report.durationAfterSeconds = snapshot.timeline.durationInFrames / fps;
  return change;
}
