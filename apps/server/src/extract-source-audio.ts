import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { EditingApplication } from "@videocut/application";
import { DomainError } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";
import { sha256File } from "./media-hash.js";

/** 只提取已入库视频的明确源范围，登记后仍由现有媒体分析 Job 核验。 */
export async function extractSourceAudio(application: EditingApplication, input: {
  projectId: string; baseRevision: number; sourceAssetId: string; startMs: number; endMs: number;
}) {
  const state = application.readProject(input.projectId);
  if (state.revision.number !== input.baseRevision) throw new DomainError("项目版本已变化，请重读后提交", "REVISION_CONFLICT");
  const source = state.snapshot.assets.find(asset => asset.id === input.sourceAssetId);
  if (!source || !["video", "actor_video"].includes(source.kind) || source.status !== "ready" || !source.sourceHash || !source.metadata?.hasAudio) {
    throw new DomainError("源素材必须是已就绪、带原声的视频", "SOURCE_AUDIO_UNAVAILABLE");
  }
  if (!Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.endMs) || input.startMs < 0 || input.endMs <= input.startMs
    || input.endMs > source.metadata.durationMs || input.endMs - input.startMs > 120_000) {
    throw new DomainError("源范围须在视频时长内且不超过 120 秒", "SOURCE_AUDIO_RANGE_INVALID");
  }
  const derivedFrom = { assetId: source.id, sourceHash: source.sourceHash, startMs: input.startMs, endMs: input.endMs };
  const existing = state.snapshot.assets.find(asset => asset.kind === "audio" && JSON.stringify(asset.provenance?.derivedFrom) === JSON.stringify(derivedFrom));
  if (existing) return { reused: true, asset: existing, state };

  const root = state.snapshot.project.rootPath;
  const sourcePath = isAbsolute(source.managedPath) ? source.managedPath : join(root, source.managedPath);
  const relativePath = join("assets", "source", `audio-${source.id}-${input.startMs}-${input.endMs}-${randomUUID()}.wav`);
  const target = join(root, relativePath);
  await mkdir(join(root, "assets", "source"), { recursive: true });
  try {
    await runProcess("ffmpeg", ["-y", "-v", "error", "-i", sourcePath, "-ss", (input.startMs / 1000).toFixed(3), "-t", ((input.endMs - input.startMs) / 1000).toFixed(3), "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", target], 120_000);
    const metadata = await probeMedia(target);
    if (!metadata.hasAudio || !metadata.audioCodec || metadata.durationMs <= 0) throw new DomainError("提取结果没有可解码音轨", "SOURCE_AUDIO_OUTPUT_INVALID");
    const sourceHash = await sha256File(target);
    const provenance = source.provenance ? { ...structuredClone(source.provenance), derivedFrom, acquiredAt: new Date().toISOString() }
      : { source: "local_import" as const, acquiredAt: new Date().toISOString(), derivedFrom };
    const registered = application.registerImportedAsset({ projectId: input.projectId, baseRevision: input.baseRevision,
      name: `audio-${source.name}.wav`, kind: "audio", managedPath: relativePath, sourceHash, provenance,
      tags: ["derived-audio", `source:${source.id}`] });
    return { reused: false, ...registered, sourceRange: derivedFrom };
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}
