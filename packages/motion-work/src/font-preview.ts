import { z } from "zod";

/** 推荐只用于浏览；最终选择必须由用户在聊天中明确确认，不写项目或自动采用。 */
export const fontPreviewSchema = z.object({
  text: z.string().trim().min(1).max(120),
  expected_font: z.string().trim().min(1).max(100).optional(),
  purpose: z.string().trim().min(1).max(100).optional(),
  candidates: z.array(z.object({
    font_id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u),
    reason: z.string().trim().min(1).max(160)
  }).strict()).min(1).max(3)
}).strict().refine(value => new Set(value.candidates.map(c => c.font_id)).size === value.candidates.length, "推荐字体不能重复");
export type FontPreview = z.infer<typeof fontPreviewSchema>;
export interface FontLibraryFace { id: string; name: string; weight: number; style: "normal" | "italic"; sha256: string; }

export function readFontPreview(search: string): { preview?: FontPreview; error?: string } {
  const value = new URLSearchParams(search).get("fontPreview");
  if (!value) return {};
  try { return { preview: fontPreviewSchema.parse(JSON.parse(value)) }; }
  catch { return { error: "字体推荐链接无效，请让主任务重新提供预览链接。" }; }
}
