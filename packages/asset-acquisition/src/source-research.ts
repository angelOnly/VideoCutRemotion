import { z } from "zod";

const sourceMaterialCommon = {
  baseRevision: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(160),
  url: z.string().url().max(4000),
};

// 把材料类型的参数边界发布到 JSON Schema，不能只在隐藏的 refine 中拒绝。
export const sourceMaterialSchema = z.discriminatedUnion("kind", [
  z.object({ ...sourceMaterialCommon, kind: z.literal("web_snapshot") }).strict()
    .describe("公开网页截图：固定 1440 像素视口，不接受 pages 或 pageWidth"),
  z.object({ ...sourceMaterialCommon, kind: z.literal("image") }).strict()
    .describe("直接图片原文件：不接受 pages 或 pageWidth"),
  z.object({
    ...sourceMaterialCommon,
    kind: z.literal("pdf"),
    pages: z.array(z.number().int().min(1).max(10000)).min(1).max(10).optional()
      .describe("仅 PDF：选定页码；省略时仅取得原 PDF，不生成页面图片"),
    pageWidth: z.number().int().min(640).max(1920).optional()
      .describe("仅 PDF：页面图片最长边像素，默认 1600；不是网页视口宽度")
  }).strict()
]);
export type SourceMaterialInput = z.infer<typeof sourceMaterialSchema>;
