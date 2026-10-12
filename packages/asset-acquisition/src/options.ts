import { z } from "zod";

/** 获取参数由 MCP、Application 和 Worker 共用，时间一律属于原片。 */
export const assetAcquisitionOptionsSchema = z.object({
  qualityHeight: z.number().int().min(144).max(8640).optional(),
  sourceRange: z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() })
    .strict().refine(range => range.endMs > range.startMs, "原片结束时间必须大于开始时间").optional()
}).strict();
