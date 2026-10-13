import {spawn} from "node:child_process";
import type {MediaMetadata} from "@videocut/contracts";

// 通用媒体能力不依赖本地模型，旧生成/转写服务已移除。
export class MediaProcessError extends Error {
  constructor(message: string, public readonly output: string,
    public readonly details?: { exitCode?: number | null; systemCode?: string; timedOut?: boolean }) {
    super(message);
  }
}

export async function runProcess(command: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new MediaProcessError(`${command} 执行超时`, output, { timedOut: true }));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new MediaProcessError(`无法启动 ${command}：${error.message}`, output, { systemCode: (error as NodeJS.ErrnoException).code }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new MediaProcessError(`${command} 失败，退出码 ${code}`, output, { exitCode: code }));
    });
  });
}


function hasVerifiedAlphaPixelFormat(pixelFormat: string | undefined): boolean {
  const normalized = pixelFormat?.trim().toLowerCase();
  return Boolean(normalized && /^(?:rgba|argb|bgra|abgr|yuva|gbrap|ya\d|ayuv)/u.test(normalized));
}
export async function probeMedia(filePath: string): Promise<MediaMetadata> {
  const output = await runProcess("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:format=format_name:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    filePath
  ], 60_000);
  const data = JSON.parse(output) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }>;
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const [numerator, denominator] = video?.r_frame_rate?.split("/").map(Number) ?? [];
  const fps = numerator && denominator ? numerator / denominator : undefined;
  return {
    durationMs: Math.round(Number(data.format?.duration ?? 0) * 1000),
    width: video?.width,
    height: video?.height,
    fps,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: audio?.channels,
    videoCodec: video?.codec_name,
    pixelFormat: video?.pix_fmt,
    hasAlpha: hasVerifiedAlphaPixelFormat(video?.pix_fmt),
    mime: data.format?.format_name
  };
}

