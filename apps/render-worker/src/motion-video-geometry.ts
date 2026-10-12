import { runProcess } from "@videocut/speech";

export interface MotionVideoGeometry {
  streamIndex: number; encodedWidth: number; encodedHeight: number; sar: number;
  rotation: number; displayWidth: number; displayHeight: number; durationMs: number;
  startTimeSeconds: number;
}
/** 只接受能够确定解释的正交显示矩阵；不把剪切、镜像或透视静默当作旋转。 */
export function parseMotionVideoGeometry(probe: any): MotionVideoGeometry {
  const stream = probe.streams?.find((s: any) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!stream || !Number.isInteger(stream.index) || !(stream.width > 0 && stream.height > 0)) throw new Error("MOTION_VIDEO_GEOMETRY: 没有有效视频流");
  const parts = (stream.sample_aspect_ratio || "1:1").split(":").map(Number);
  const sar = parts[0] / parts[1];
  if (parts.length !== 2 || !Number.isFinite(sar) || sar <= 0 || sar > 16 || sar < 1/16) throw new Error("MOTION_VIDEO_GEOMETRY: 不支持该像素宽高比");
  const matrices = (stream.side_data_list ?? []).filter((s: any) => s.side_data_type === "Display Matrix");
  if (matrices.length > 1) throw new Error("MOTION_VIDEO_GEOMETRY: 显示矩阵不唯一");
  const matrix = matrices[0];
  if (matrix) {
    const values = String(matrix.displaymatrix).trim().split("\n").flatMap(line => line.split(":")[1]?.trim().split(/\s+/).map(Number) ?? []);
    const [a,b,u,c,d,v,x,y,w] = values;
    if (values.length !== 9 || [a,b,c,d].some(n => ![-65536,0,65536].includes(n)) || a*d-b*c !== 65536**2 || a*a+b*b !== 65536**2 || c*c+d*d !== 65536**2 || [u,v,x,y].some(n => n !== 0) || w !== 1073741824) throw new Error("MOTION_VIDEO_GEOMETRY: 不支持镜像、剪切或透视显示变换");
  }
  const rawRotation = Number(matrix?.rotation ?? stream.tags?.rotate ?? 0);
  const rotation = (rawRotation % 360 + 360) % 360;
  if (!Number.isFinite(rotation) || ![0,90,180,270].includes(rotation)) throw new Error("MOTION_VIDEO_GEOMETRY: 仅支持正交旋转");
  const normalizedWidth = stream.width * sar, normalizedHeight = stream.height;
  const durationMs = Number(stream.duration ?? probe.format?.duration) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("MOTION_VIDEO_SOURCE_RANGE: 视频时长无效");
  const startTimeSeconds = Number(stream.start_time ?? probe.format?.start_time ?? 0);
  if (!Number.isFinite(startTimeSeconds)) throw new Error("MOTION_VIDEO_GEOMETRY: 起始时间戳无效");
  return { streamIndex: stream.index, encodedWidth: stream.width, encodedHeight: stream.height, sar, rotation, displayWidth: rotation % 180 ? normalizedHeight : normalizedWidth, displayHeight: rotation % 180 ? normalizedWidth : normalizedHeight, durationMs, startTimeSeconds };
}
export async function probeMotionVideoGeometry(path: string) {
  return parseMotionVideoGeometry(JSON.parse(await runProcess("ffprobe", ["-v","error","-show_streams","-show_format","-of","json",path])));
}
export function motionDecodeDimensions(geometry: Pick<MotionVideoGeometry,"displayWidth"|"displayHeight">, work: { width: number; height: number }, decodeScale?: number) {
  const scale = decodeScale ?? Math.min(1, work.width / geometry.displayWidth, work.height / geometry.displayHeight);
  const width = Math.floor(geometry.displayWidth * scale / 2)*2, height = Math.floor(geometry.displayHeight * scale / 2)*2;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1 || width < 2 || height < 2 || width > 1920 || height > 1920) throw new Error(`MOTION_VIDEO_DIMENSION_BUDGET: 请求比例${scale}得到${width}×${height}，每边须在2–1920内`);
  return { width, height };
}
