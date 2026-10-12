import { z } from "zod";
import type { CreativeBrief, ExplicitCreativePreferences } from "./index.js";

const preferenceText = z.string().trim().min(1).max(1600);
export const explicitCreativePreferencesSchema = z.object({
  dimensions: z.object({
    narration: preferenceText.optional(), visual: preferenceText.optional(),
    motion: preferenceText.optional(), background: preferenceText.optional(), sound: preferenceText.optional()
  }).strict().optional(),
  notes: z.string().trim().min(1).max(4000).optional()
}).strict();

export const creativeBriefSchema = z.object({
  platform: z.string().optional(),
  aspectRatio: z.enum(["9:16", "16:9", "1:1"]).optional(),
  targetDurationSeconds: z.number().positive().optional(),
  audience: z.string().optional(), tone: preferenceText.optional(),
  captionMode: z.enum(["stable", "none"]).optional(),
  allowHighDensityMotion: z.boolean().optional(),
  explicitCreativePreferences: explicitCreativePreferencesSchema.optional()
}).strict();

// 更新方向不自动重生成作品或改变画幅；清空后由导演续接当前任务。
export const creativeBriefUpdateSchema = creativeBriefSchema.pick({ tone: true, explicitCreativePreferences: true })
  .extend({ explicitCreativePreferences: explicitCreativePreferencesSchema.nullable().optional() }).strict()
  .refine(value => value.tone !== undefined || value.explicitCreativePreferences !== undefined, "请提供要修改的明确偏好");

export function mergeCreativePreferences(defaults: ExplicitCreativePreferences, overrides?: ExplicitCreativePreferences): ExplicitCreativePreferences {
  const dimensions = { ...defaults.dimensions, ...overrides?.dimensions };
  const notes = overrides?.notes ?? defaults.notes;
  return { ...(Object.keys(dimensions).length ? { dimensions } : {}), ...(notes ? { notes } : {}) };
}

/** 建项时继承一次；旧 tone 作为本任务的讲述口吻，不能被默认设置覆盖。 */
export function initializeCreativeBrief(defaults: ExplicitCreativePreferences, brief: Partial<CreativeBrief> = {}): Partial<CreativeBrief> {
  const explicit = mergeCreativePreferences({}, brief.explicitCreativePreferences);
  if (brief.tone && !explicit.dimensions?.narration) explicit.dimensions = { ...explicit.dimensions, narration: brief.tone };
  const preferences = mergeCreativePreferences(defaults, explicit);
  return { ...brief,
    ...(Object.keys(preferences).length ? { explicitCreativePreferences: preferences } : {}),
    ...(preferences.dimensions?.narration ? { tone: preferences.dimensions.narration } : {}) };
}
