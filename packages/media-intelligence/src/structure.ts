import { runProcess } from "@videocut/speech";

export interface SceneBoundary { seconds: number; score?: number }
/** 技术镜头边界是公共证据；事件意义仍由各主工作流判断。 */
export function parseSceneBoundaries(output: string): SceneBoundary[] {
  const times = [...output.matchAll(/pts_time:\s*(-?\d+(?:\.\d+)?)/gu)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value >= 0);
  const scores = [...output.matchAll(/lavfi\.scene_score\s*=\s*(-?\d+(?:\.\d+)?)/gu)].map((match) => Number(match[1]));
  return times.map((seconds, index) => ({ seconds, score: Number.isFinite(scores[index]) ? scores[index] : undefined }));
}
export async function detectSceneBoundaries(path: string, threshold = 0.3): Promise<SceneBoundary[]> {
  if (!Number.isFinite(threshold) || threshold < 0.05 || threshold > 0.9) throw new Error("镜头阈值必须在 0.05–0.9 之间");
  return parseSceneBoundaries(await runProcess("ffmpeg", ["-hide_banner", "-i", path, "-vf", `select='gt(scene,${threshold.toFixed(4)})',metadata=print:key=lavfi.scene_score`, "-an", "-f", "null", "-"], 30 * 60_000));
}
