import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EditingApplication } from "@videocut/application";
import type { JobRecord, ImpactReport } from "@videocut/contracts";
import { assertTimelineValid, assertProjectGraphValid, DomainError, emptyImpact } from "@videocut/domain";
import { soundComparisonSchema, soundDependencySignature } from "../../../packages/edit-application/src/sound-review.js";
import { inspectFinalAudio } from "../../../packages/media-intelligence/src/acoustics.js";
import { RevisionRenderer, type RevisionRenderEngine } from "./exporter.js";

export async function runSoundComparison(app: EditingApplication, job: JobRecord, renderer: RevisionRenderEngine = new RevisionRenderer()) {
  const { dependencySignature, retryOfJobId, ...raw } = job.payload;
  const input = soundComparisonSchema.parse(raw);
  const revision = app.repository.getRevision(job.projectId, input.revision);
  if (soundDependencySignature(revision.snapshot) !== dependencySignature) throw new DomainError("比较依赖不一致", "SOUND_COMPARISON_STALE");
  const directory = join(revision.snapshot.project.rootPath, "previews", "sound-comparison", job.id);
  await mkdir(directory, { recursive: true });
  const variants = [...input.alternatives, ...(input.includeWithout ? [null] : [])];
  const outputs: Array<Record<string, unknown>> = [];
  for (const [index, alternative] of variants.entries()) {
    if (app.trackJob(job.id).status === "cancelled") throw new DomainError("已取消后续候选渲染", "SOUND_COMPARISON_CANCELLED");
    const snapshot = structuredClone(revision.snapshot);
    const impact = emptyImpact();
    if (input.replaceCueId) app.applyAudioEdit(snapshot, impact, { projectId: job.projectId, baseRevision: input.revision, action: "remove", audioCueId: input.replaceCueId });
    if (alternative) { const { name, ...audio } = alternative; app.applyAudioEdit(snapshot, impact, { projectId: job.projectId, baseRevision: input.revision, action: "create", ...audio }); }
    assertTimelineValid(snapshot); assertProjectGraphValid(snapshot);
    const path = join(directory, `${index}.mp4`);
    await renderer.renderRange(snapshot, input.fromFrame, input.toFrame, path);
    const { probeMedia } = await import("@videocut/speech");
    const metadata = await probeMedia(path);
    const audio = metadata.hasAudio ? await inspectFinalAudio(path) : { hasAudio: false, decoded: false };
    outputs.push({ name: alternative?.name ?? "不使用该音效", path, relativePath: `previews/sound-comparison/${job.id}/${index}.mp4`, settings: alternative, audio, signature: soundDependencySignature(snapshot) });
    app.recordJobCheckpoint(job.id, { outputs });
  }
  return { revision: input.revision, fromFrame: input.fromFrame, toFrame: input.toFrame, dependencySignature, outputs, adopted: false, reviewRequired: true };
}
