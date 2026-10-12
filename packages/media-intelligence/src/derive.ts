import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MediaSource, SourceRegion, SourceTimeRange } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { runProcess } from "@videocut/speech";

export const PREPROCESSING_VERSION = "source-pts-window-v2";
export async function documentPageCount(path: string): Promise<number> {
  const text = await runProcess("pdfinfo", [path], 120_000);
  const count = Number(text.match(/^Pages:\s*(\d+)/mu)?.[1]);
  if (!Number.isInteger(count) || count < 1) throw new DomainError("无法读取 PDF 页码目录；需要可用的 Poppler pdfinfo", "MEDIA_DOCUMENT_DECODE_FAILED");
  return count;
}

/** 派生始终保存真实源偏移；先按 PTS 裁切，再归零，保留音轨迟入的静音。 */
export async function deriveMediaInput(source: Pick<MediaSource, "id" | "hash" | "kind" | "path" | "startSeconds" | "hasAudio" | "pageCount">, directory: string, range?: SourceTimeRange, region?: SourceRegion, audioOnly = false): Promise<{ path: string; kind: "video" | "audio" | "image"; mapping: Record<string, unknown> }> {
  await mkdir(directory, { recursive: true });
  const kind = source.kind === "document" || source.kind === "image" ? "image" : source.kind === "audio" || audioOnly ? "audio" : "video";
  const path = join(directory, `input.${kind === "image" ? "png" : kind === "audio" ? "wav" : "mp4"}`);
  if (kind === "image") {
    let input = source.path;
    if (source.kind === "document") {
      if (!region?.page || region.page > (source.pageCount ?? 0)) throw new DomainError("PDF 页码越界", "MEDIA_DOCUMENT_PAGE_INVALID");
      const prefix = join(directory, "page");
      await runProcess("pdftoppm", ["-f", String(region.page), "-l", String(region.page), "-singlefile", "-scale-to", "1600", "-png", source.path, prefix], 120_000);
      input = `${prefix}.png`;
    }
    const crop = region ? `crop=iw*${region.width}:ih*${region.height}:iw*${region.x}:ih*${region.y},` : "";
    await runProcess("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-i", input, "-vf", `${crop}scale=w='min(1600,iw)':h=-1`, "-frames:v", "1", path], 120_000);
  } else {
    if (!range) throw new DomainError("时序媒体需要真实源范围", "MEDIA_RANGE_REQUIRED");
    const start = (source.startSeconds ?? 0) + range.startMs / 1000;
    const end = (source.startSeconds ?? 0) + range.endMs / 1000;
    const duration = (range.endMs - range.startMs) / 1000;
    const audioFilter = `atrim=start=${start}:end=${end},asetpts=PTS-${start}/TB,aresample=16000:async=1:first_pts=0,apad,atrim=duration=${duration}`;
    if (kind === "audio") {
      await runProcess("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-copyts", "-i", source.path, "-vn", "-map", "0:a:0", "-af", audioFilter, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path], 180_000);
    } else {
      const filters = `[0:v:0]trim=start=${start}:end=${end},setpts=PTS-${start}/TB,scale=w='min(960,iw)':h=-2[v]${source.hasAudio ? `;[0:a:0]${audioFilter}[a]` : ""}`;
      await runProcess("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-copyts", "-i", source.path, "-filter_complex", filters, "-map", "[v]", ...(source.hasAudio ? ["-map", "[a]", "-ac", "1", "-ar", "16000", "-c:a", "aac"] : ["-an"]), "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-fps_mode", "vfr", "-t", String(duration), path], 180_000);
    }
  }
  return { path, kind, mapping: { parentSourceId: source.id, parentHash: source.hash, offsetMs: range?.startMs, region, rate: 1, coordinateSpace: "display_after_rotation", preprocessing: PREPROCESSING_VERSION } };
}
