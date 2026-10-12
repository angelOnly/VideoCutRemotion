import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import type { ProjectSnapshot } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { runProcess } from "@videocut/speech";

/** 混合完成后仅应用一次总增益；复制视频码流，不改轨道、Duck、包络和时序。 */
export async function applyFinalAudioMixGain(snapshot: ProjectSnapshot, targetPath: string): Promise<void> {
  const gainDb = snapshot.audioMixGainDb ?? 0;
  if (!Number.isFinite(gainDb) || gainDb < -48 || gainDb > 24) throw new DomainError("整体混合增益必须在 -48 到 24 dB 之间", "INVALID_AUDIO_MIX_GAIN");
  if (gainDb === 0) return;
  const temporaryPath = `${targetPath}.mix-gain-${randomUUID()}.mp4`;
  try {
    await runProcess("ffmpeg", ["-y", "-i", targetPath, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", `volume=${gainDb}dB:precision=double`, "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart", temporaryPath], 30 * 60_000);
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
