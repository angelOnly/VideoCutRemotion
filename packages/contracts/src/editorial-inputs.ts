import { z } from "zod";

/** HTTP、MCP 共用的显示纠错依据；缺省 basis 仅兼容已有回听接口。 */
export const sourceCaptionTextReviewSchema = z.union([
  z.object({ basis: z.literal("listening").optional(), note: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ basis: z.literal("confirmed_script"), note: z.string().trim().min(1).max(1000), scriptRevision: z.number().int().positive(), speechSegmentIds: z.array(z.string().min(1)).min(1).max(20) }).strict(),
  z.object({ basis: z.literal("user_instruction"), note: z.string().trim().min(1).max(1000), instruction: z.string().trim().min(1).max(2000), source: z.string().trim().min(1).max(1000) }).strict()
]);

/** 自动化不能把导出成功当作用户批准；调用方须持有用户对这一哈希的明确确认。 */
export const exportApprovalSchema = z.object({
  confirmedByUser: z.literal(true),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/u),
  note: z.string().trim().max(1000).optional()
}).strict();
