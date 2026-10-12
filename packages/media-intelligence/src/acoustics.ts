import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "@videocut/speech";
import type { MediaSource, SourceTimeRange } from "@videocut/contracts";

/** 波形候选是技术证据，不给 onsetReview 自动盖章；最大能量也不等于主攻击。 */
export async function measureAudioWindow(source: MediaSource, range: SourceTimeRange, directory: string) {
  await mkdir(directory, { recursive: true });
  const sampleRate = 48000, hop = 240;
  const path = join(directory, "measurement.f32");
  const start = (source.startSeconds ?? 0) + range.startMs / 1000, end = (source.startSeconds ?? 0) + range.endMs / 1000;
  await runProcess("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-copyts", "-i", source.path, "-map", "0:a:0", "-vn", "-af", `atrim=start=${start}:end=${end},asetpts=PTS-${start}/TB,aresample=${sampleRate}:async=1:first_pts=0,apad,atrim=duration=${(range.endMs - range.startMs) / 1000}`, "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", path], 180_000);
  const raw = await readFile(path);
  const rms: number[] = [], peaks: number[] = [];
  for (let index = 0; index < raw.length / 4; index += hop) {
    let sum = 0, peak = 0, count = 0;
    for (let j = index; j < Math.min(raw.length / 4, index + hop); j++) { const v = raw.readFloatLE(j * 4); sum += v * v; peak = Math.max(peak, Math.abs(v)); count++; }
    rms.push(Math.sqrt(sum / count)); peaks.push(peak);
  }
  const maxRms = Math.max(0, ...rms), threshold = Math.max(10 ** (-55 / 20), maxRms * 0.03);
  const first = rms.findIndex((value) => value >= threshold);
  let last = rms.length - 1;
  while (last >= 0 && rms[last] < threshold) last--;
  const attacks = rms.map((value, index) => ({ sample: index * hop, strength: Math.max(0, value - (rms[index - 1] ?? 0)) })).filter((entry) => entry.strength >= threshold)
    .sort((a, b) => b.strength - a.strength).filter((entry, index, entries) => !entries.slice(0, index).some((earlier) => Math.abs(entry.sample - earlier.sample) < sampleRate * 0.08)).slice(0, 8).sort((a, b) => a.sample - b.sample);
  return { range, sampleRate, sampleOriginMs: range.startMs, hopSamples: hop, firstAudibleSample: first < 0 ? null : first * hop, effectiveEndSample: last < 0 ? null : Math.min(raw.length / 4, (last + 1) * hop), attackCandidates: attacks, rms, peaks, thresholdDb: 20 * Math.log10(threshold), precision: "measurement_candidate" as const, reviewStatus: "unreviewed" as const };
}

/** 对最终实际文件完整解码并测 EBU R128 / true peak，不能只检查音轨存在。 */
export async function inspectFinalAudio(path: string) {
  const output = await runProcess("ffmpeg", ["-hide_banner", "-nostdin", "-i", path, "-vn", "-af", "silencedetect=noise=-55dB:d=0.25,ebur128=peak=true", "-f", "null", "-"], 30 * 60_000);
  const summary = output.slice(output.lastIndexOf("Summary:"));
  const read = (pattern: RegExp) => { const text = summary.match(pattern)?.[1]; return text && Number.isFinite(Number(text)) ? Number(text) : null; };
  const silence: Array<{ startSeconds: number; endSeconds: number }> = [];
  let start: number | undefined;
  for (const match of output.matchAll(/silence_(start|end):\s*([\d.]+)/gu)) { if (match[1] === "start") start = Number(match[2]); else if (start !== undefined) { silence.push({ startSeconds: start, endSeconds: Number(match[2]) }); start = undefined; } }
  return { decoded: true, integratedLufs: read(/\bI:\s*([-\d.inf]+)\s*LUFS/u), truePeakDbfs: read(/Peak:\s*([-\d.inf]+)\s*dBFS/u), loudnessRangeLu: read(/LRA:\s*([-\d.]+)\s*LU/u), silence, trailingSilenceStartSeconds: start, method: "ffmpeg_ebur128_true_peak_complete_decode", rawSummary: summary.slice(-3000) };
}
