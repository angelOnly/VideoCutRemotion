import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { EditorialReviewEvidence, EditorialReviewObservation, JobRecord, ProjectSnapshot } from "@videocut/contracts";
import { createId, DomainError, now } from "@videocut/domain";
import { evidenceSupportsPass } from "../../quality-system/src/editorial-review.js";

const runFile = promisify(execFile);

export async function evidenceHash(root: string, path: string): Promise<string> {
  const actual = await realpath(resolve(root, path));
  const distance = relative(await realpath(root), actual);
  if (!distance || isAbsolute(distance) || distance === ".." || distance.startsWith("../") || distance.startsWith("..\\")) throw new DomainError("审片证据不在受管项目内", "EDITORIAL_EVIDENCE_PATH_INVALID");
  const info = await stat(actual);
  if (!info.isFile() || info.size === 0) throw new DomainError("审片文件为空或不可读", "EDITORIAL_EVIDENCE_FILE_INVALID");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(actual)) hash.update(chunk);
  return hash.digest("hex");
}

/** Preview 与作品代理共用真实媒体检查，不把代理伪装成 Preview Job。 */
export async function inspectEvidenceMedia(root: string, path: string, durationSeconds: number, fps: number) {
  const hash = await evidenceHash(root, path);
  let metadata: { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
  try {
    const output = await runFile("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", resolve(root, path)], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    metadata = JSON.parse(output.stdout) as typeof metadata;
  } catch { throw new DomainError("证据无法解析为真实媒体", "EDITORIAL_EVIDENCE_MEDIA_INVALID"); }
  const duration = Number(metadata.format?.duration);
  if (!metadata.streams?.some((stream) => stream.codec_type === "video") || !Number.isFinite(duration) || Math.abs(duration - durationSeconds) > 2 / fps) throw new DomainError("证据实际时长与声明范围不一致", "EDITORIAL_EVIDENCE_MEDIA_INVALID");
  return { path: relative(root, resolve(root, path)), hash, hasAudio: metadata.streams.some((stream) => stream.codec_type === "audio") };
}

/** 只验证文件、版本与观察方式的事实；不声称程序能代替真实观看和听觉判断。 */
export async function validateEditorialObservations(snapshot: ProjectSnapshot, revision: number, jobs: JobRecord[], observations: EditorialReviewObservation[]): Promise<EditorialReviewEvidence[]> {
  const media = new Map<string, { path: string; hash: string; hasAudio: boolean }>();
  const result: EditorialReviewEvidence[] = [];
  for (const entry of observations) {
    if (!evidenceSupportsPass(entry) && !(entry.method === "frames" && ["mute_visual", "mode_specific"].includes(entry.pass))) throw new DomainError("观察方式不支持该审片轮次；抽帧不能表示听过或完整声画观看", "EDITORIAL_METHOD_INVALID");
    const job = jobs.find((candidate) => candidate.id === entry.previewJobId);
    if (!job || job.projectId !== snapshot.project.id || job.kind !== "preview" || job.status !== "succeeded" || !job.result || job.payload.revision !== revision || job.result.revision !== revision) throw new DomainError("证据必须来自本项目、目标 Revision 的成功 Preview Job", "EDITORIAL_PREVIEW_MISMATCH");
    const from = Number(job.payload.fromFrame);
    const to = Number(job.payload.toFrame);
    if (!Number.isInteger(from) || !Number.isInteger(to) || job.result.fromFrame !== from || job.result.toFrame !== to || !Number.isInteger(entry.startFrame) || !Number.isInteger(entry.endFrame) || entry.startFrame < from || entry.endFrame > to || entry.startFrame < 0 || entry.endFrame > snapshot.timeline.durationInFrames || entry.endFrame <= entry.startFrame) throw new DomainError("实际审阅范围超出 Preview 或目标时间线", "EDITORIAL_EVIDENCE_RANGE_INVALID");
    if (!entry.observation.trim()) throw new DomainError("必须记录实际观察与仍未确认事项", "EDITORIAL_OBSERVATION_REQUIRED");
    let file = media.get(job.id);
    if (!file) {
      if (typeof job.result.path !== "string") throw new DomainError("Preview 缺少实际文件", "EDITORIAL_EVIDENCE_FILE_INVALID");
      const path = resolve(snapshot.project.rootPath, job.result.path);
      file = await inspectEvidenceMedia(snapshot.project.rootPath, path, (to - from) / snapshot.timeline.fps, snapshot.timeline.fps);
      media.set(job.id, file);
    }
    if (["audio", "audiovisual"].includes(entry.method) && !file.hasAudio) throw new DomainError("无音轨 Preview 不能作为声音或声画审阅证据", "EDITORIAL_AUDIO_MISSING");
    result.push({ ...entry, observation: entry.observation.trim(), id: createId("editorial_evidence"), revision, relativePath: file.path, contentHash: file.hash, recordedAt: now() });
  }
  return result;
}
