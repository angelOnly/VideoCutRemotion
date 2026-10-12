import { z } from "zod";
import type { ProjectSnapshot } from "@videocut/contracts";
import type { EditingApplication } from "./index.js";
import { DomainError, now } from "@videocut/domain";
import { digest } from "../../media-intelligence/src/index.js";
import { audioDesignSchema } from "./sound-design.js";
import { hashMediaFile, managedSourcePath } from "./media-intelligence.js";
import { soundDependencySignature } from "../../media-intelligence/src/sound-signature.js";
export { soundDependencySignature } from "../../media-intelligence/src/sound-signature.js";

export const soundComparisonSchema = z.object({
  revision: z.number().int().positive(), fromFrame: z.number().int().nonnegative(), toFrame: z.number().int().positive(),
  replaceCueId: z.string().min(1).optional(),
  alternatives: z.array(z.object({ name: z.string().trim().min(1).max(100), assetId: z.string().min(1), kind: z.enum(["sfx", "bgm"]), purpose: z.string().trim().min(1).max(800),
    eventFrame: z.number().int().nonnegative().optional(), onsetOffsetFrames: z.number().int().nonnegative().optional(), startFrame: z.number().int().nonnegative().optional(), endFrame: z.number().int().positive().optional(),
    sourceStartFrame: z.number().int().nonnegative(), sourceEndFrame: z.number().int().positive(), gainDb: z.number().min(-48).max(12), fadeInFrames: z.number().int().min(0).max(480).default(0), fadeOutFrames: z.number().int().min(0).max(480).default(0), loop: z.boolean().default(false), design: audioDesignSchema.optional()
  }).strict()).min(1).max(3), includeWithout: z.boolean().default(true)
}).strict().refine((input) => input.toFrame > input.fromFrame && input.toFrame - input.fromFrame <= 3600, "比较范围须为有效的有限上下文");

export async function reviewSoundMix(app: EditingApplication, projectId: string, input: { baseRevision: number; previewJobId: string; outcome: "passed" | "failed" | "inconclusive"; method: "audio" | "audiovisual"; note: string }) {
  const job = app.trackJob(input.previewJobId);
  if (job.projectId !== projectId || job.kind !== "preview" || job.status !== "succeeded" || !job.result?.path) throw new DomainError("混合审阅需要正式预览的成功产物，候选对比不等于最终采用", "SOUND_REVIEW_PREVIEW_REQUIRED");
  const current = app.readProject(projectId);
  const path = await managedSourcePath(current.snapshot.project.rootPath, String(job.result.path));
  const previewHash = await hashMediaFile(path);
  if (job.result.sourceHash !== previewHash) throw new DomainError("预览文件已改变或没有固定文件身份，需要重新生成", "SOUND_REVIEW_ARTIFACT_CHANGED");
  const reference = app.repository.getRevision(projectId, Number(job.payload.revision));
  const signature = soundDependencySignature(current.snapshot);
  if (signature !== soundDependencySignature(reference.snapshot)) throw new DomainError("试听后声画依赖已改变，需要重新生成预览", "SOUND_REVIEW_STALE");
  const from = Number(job.payload.fromFrame), to = Number(job.payload.toFrame);
  const state = app.repository.commit(projectId, input.baseRevision, "记录段落混合复核", (snapshot, impact) => {
    for (const cue of snapshot.audioCues) {
      const item = snapshot.timeline.items.find((entry) => entry.id === cue.timelineItemId)!;
      if (item && item.startFrame >= from && item.endFrame <= to && cue.status === "ready") { cue.mixReview = input.outcome === "passed" ? "reviewed" : "needs_review"; impact.changed.push(cue.id); }
    }
    (snapshot.soundReviews ??= []).push({ ...input, signature, previewHash, fromFrame: from, toFrame: to, recordedAt: now() });
  });
  app.publish({ projectId, revision: state.revision.number, type: "revision" });
  return state;
}
