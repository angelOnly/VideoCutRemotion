import { z } from "zod";
import { motionSourceForUrl } from "./catalog.js";

const description = z.string().trim().min(8).max(1800);
// 视频槽名与 JSX 的 slot 原样对应，允许驼峰写法。
const videoSlotSchema = z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/u);
/** 观察记录是创作判断，不等于平台已自动观看、技术校验通过或成片审片通过。 */
export const motionSubmissionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.string().min(20).max(60_000),
  props: z.record(z.unknown()).default({}),
  imageBindings: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u), z.string().min(1).max(150)).default({}),
  width: z.number().int().min(64).max(1920).describe("画布宽度（像素），64–1920 的偶数；完整输出按真实磁盘需求预检。"),
  height: z.number().int().min(64).max(1920).describe("画布高度（像素），64–1920 的偶数；完整输出按真实磁盘需求预检。"),
  fps: z.number().int().min(15).max(60).describe("帧率，15–60 的整数；视频按真实时间戳重采样。"),
  durationInFrames: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER).describe("作品完整帧数；平台有界取帧并连续渲染，不按30秒、900帧或累计像素帧要求作者拆件。"),
  reference: z.object({
    url: z.string().url().refine((value) => { try { motionSourceForUrl(value); return true; } catch { return false; } }, "只能使用已选择的在线来源"),
    observation: z.object({
      layout: description,
      motion: description,
      rhythm: description,
      adaptation: description,
      evidence: description
    }).strict()
  }).strict().optional(),
  previousAssetId: z.string().max(150).optional(),
  // 追加字段不注入默认值，不改变历史输入的字段次序和作品哈希。
  creativeBrief: z.string().trim().min(1).max(6000).optional().describe("新作品必填的创作说明；仅历史作品按原输入进行幂等重放时可省略。"),
  videoBindings: z.record(videoSlotSchema, z.object({
    assetId: z.string().min(1).max(150), sourceStartMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sourceEndMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startFrame: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), endFrame: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    decodeScale: z.number().finite().gt(0).max(1).optional()
  }).strict()).optional().describe("命名视频选段，不设作品选段总数上限；声明源毫秒范围和作品帧范围，实际负载受资源校验约束。TimelineVideo读取作品根时钟，Sequence只改变布局；正常速度且静音，不接受offsetInFrames。"),
  fontBindings: z.record(videoSlotSchema, z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u)).optional()
    .describe("字体槽位到已登记 fontId 的映射，最多8槽。先查询 read_motion_capabilities；平台加载后注入 props.fonts[槽位] 的 family、weight、style，不接受路径或URL。")
}).strict().superRefine((value, ctx) => {
  if (!Number.isSafeInteger(value.width * value.height * value.durationInFrames * 8)) ctx.addIssue({ code: "custom", message: "作品输出体积超过安全整数范围" });
  if (JSON.stringify(value.props).length > 24_000) ctx.addIssue({ code: "custom", message: "Props 超过大小上限" });
  if (Object.keys(value.imageBindings).length > 8) ctx.addIssue({ code: "custom", message: "单个作品最多绑定 8 个图片素材" });
  if ("assets" in value.props) ctx.addIssue({ code: "custom", message: "Props.assets 由平台按 imageBindings 注入，不能覆盖" });
  if ("fonts" in value.props) ctx.addIssue({ code: "custom", message: "Props.fonts 由平台按 fontBindings 注入，不能覆盖" });
  if (Object.keys(value.fontBindings ?? {}).length > 8) ctx.addIssue({ code: "custom", message: "单个作品最多绑定8个字体槽位" });
  if (value.width % 2 || value.height % 2) ctx.addIssue({ code: "custom", message: "画布宽高必须是偶数" });
  // 选段数量不代表同时解码负载；保留逐槽范围校验，资源由有界视频 Provider 检查。
  for (const binding of Object.values(value.videoBindings ?? {})) {
    const frames = binding.endFrame - binding.startFrame;
    const duration = binding.sourceEndMs - binding.sourceStartMs;
    if (frames <= 0 || binding.endFrame > value.durationInFrames) ctx.addIssue({ code: "custom", message: "视频作品帧范围必须为正且位于作品内" });
    // 输出帧数是权威值；源毫秒取整不能凭空增加一帧，允许不足一帧的选段余量。
    if (duration <= 0 || duration + 1 < frames * 1000 / value.fps || duration - frames * 1000 / value.fps >= 1000 / value.fps + 1) ctx.addIssue({ code: "custom", message: "视频源范围与作品帧范围不匹配（允许毫秒取整及不足一帧的余量）" });
  }
});
export type MotionSubmission = z.infer<typeof motionSubmissionSchema>;

/** 事件必须由受管代码实际计算，平台只校验结果和绑定版本。 */
export function parseMotionEvents(value: unknown, frameCount: number) {
  const events = z.array(z.object({ id: z.string().trim().min(1).max(160), meaning: z.string().trim().min(1).max(500), startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive().optional() }).strict()).max(100).parse(value);
  if (new Set(events.map((event) => event.id)).size !== events.length || events.some((event) => event.startFrame >= frameCount || event.endFrame !== undefined && (event.endFrame <= event.startFrame || event.endFrame > frameCount))) throw new Error("MOTION_EVENT_RANGE_INVALID: 事件 ID 重复或范围不在当前作品内");
  return events;
}

export const motionReviewEvidenceSchema = z.object({
  kind: z.enum(["work_proxy", "project_preview"]).describe("work_proxy用作品局部帧；project_preview用项目全局帧"), previewJobId: z.string().min(1).optional(),
  startFrame: z.number().int().nonnegative().describe("实际观察半开区间的起点；坐标系取决于kind"), endFrame: z.number().int().positive().describe("实际观察半开区间的终点；failed/inconclusive允许局部范围，passed须完整覆盖作品"),
  method: z.enum(["frames", "continuous_video", "audio", "audiovisual"])
}).strict();
export const motionReviewFields = {
  outcome: z.enum(["passed", "failed", "inconclusive"]).optional(),
  referenceMatch: z.enum(["passed", "failed", "inconclusive"]).optional(),
  note: z.string().min(16).max(2400), evidence: motionReviewEvidenceSchema.optional()
};

/** 提交时固定素材身份与字节哈希，不让后台任务读取后来变更的绑定。 */
export const boundMotionImageSchema = z.object({
  slot: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u), assetId: z.string().min(1), managedPath: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type BoundMotionImage = z.infer<typeof boundMotionImageSchema>;
export const boundMotionFontSchema = z.object({
  slot: videoSlotSchema, fontId: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u),
  hash: z.string().regex(/^[a-f0-9]{64}$/u), family: z.string().regex(/^VFC_[a-f0-9]{64}$/u),
  weight: z.number().int().min(100).max(900), style: z.enum(["normal", "italic"])
}).strict();
export type BoundMotionFont = z.infer<typeof boundMotionFontSchema>;
export const boundMotionVideoSchema = boundMotionImageSchema.extend({ slot: videoSlotSchema, sourceStartMs: z.number().int().nonnegative(), sourceEndMs: z.number().int().positive(), startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive(), decodeScale: z.number().finite().gt(0).max(1).optional() });
export type BoundMotionVideo = z.infer<typeof boundMotionVideoSchema>;
export interface DecodedMotionVideo { width: number; height: number; frameCount: number; startFrame: number; endFrame: number; geometry?: { streamIndex: number; encodedWidth: number; encodedHeight: number; sar: number; rotation: number; displayWidth: number; displayHeight: number; durationMs: number }; decodeScale?: number; }
export interface MotionVideoProvider {
  videos: Record<string, DecodedMotionVideo>;
  workingSetBytes: number;
  reserveDiskSpace(bytes: number): Promise<void>;
  getFrame(slot: string, workFrame: number): Promise<Buffer>;
  releaseBefore(workFrame: number): Promise<void>;
  verifySources(): Promise<void>;
  close(): Promise<void>;
}
