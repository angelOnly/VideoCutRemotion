import { createHash } from 'node:crypto';
import { z } from 'zod';

export class ProductionError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
const text = z.string().max(100000).refine(v => v.trim().length > 0, '正文不能为空');
export const sceneId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).refine(v => v !== 'whole-video', '整片 ID 不可用于分镜');
export const sceneSchema = z.object({ id: sceneId, content: text }).strict();
const scenes = z.array(sceneSchema).min(1).max(200).refine(v => new Set(v.map(s => s.id)).size === v.length, '分镜 ID 重复');
const common = { taskId: z.string().min(1).max(200), otherRequirements: z.string().max(20000) };
export const analysisRequestSchema = z.object({ ...common, content: text, plugin: z.object({ customTemplateId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict() }).strict();
export const renderRequestSchema = z.object({ ...common, basePlanVersion: z.number().int().positive(), dataList: scenes,
  baseRenderRunId: z.string().uuid().optional(), revisionInstructions: text.optional()
}).strict().refine(v => Boolean(v.baseRenderRunId) === Boolean(v.revisionInstructions), '基础成片和修改说明必须同时提供');
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
export type RenderRequest = z.infer<typeof renderRequestSchema>;
export type Stage = 'analysis' | 'render';
export type State = 'queued' | 'running' | 'recovering' | 'unknown' | 'cancelling' | 'cancelled' | 'failed' | 'succeeded';
export type Run = { runId: string; requestId: string; accountId: string; taskKey: string; taskId: string; stage: Stage; state: State; planVersion: number;
  inputDigest: string; request: AnalysisRequest | RenderRequest; token: string | null; heartbeat: number | null; checkpoint: Record<string, any>;
  result: any; error: any; resultVersion: number | null; createdAt: number };
// 对象键排序，字符串和数组保持原样；时间、随机 ID 和发行版本不进入输入摘要。
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const analysisResultSchema = z.object({ taskId: z.string(), runId: z.string().uuid(), inputDigest: z.string(),
  dataList: z.array(sceneSchema.extend({ dur: z.number().positive(), durationSource: z.literal('estimated') })).min(1), context: z.string().min(1).refine(value=>value.trim().length>0,'context 必须是非空 Markdown 字符串')
}).strict();
// 切点保留逻辑区间；文件时长及实际切法单独登记，旧交付无需补字段。
export const sceneCutMetadataSchema=z.object({
  cutMode:z.enum(['accurate','stream_copy','local_transcode']),requestedStartSec:z.number().finite().nonnegative(),requestedEndSec:z.number().finite().positive(),
  measuredDurationSec:z.number().finite().positive(),startDeviationMs:z.number().finite(),endDeviationMs:z.number().finite(),
  mediaValidationVersion:z.literal('scene-cut-v1'),fallbackReason:z.string().max(8000).optional(),
  boundaryValidation:z.enum(['packet-pts-and-decoded-boundaries','decoded-boundaries','accurate-frame-trim']),videoToleranceMs:z.number().finite().nonnegative(),audioToleranceMs:z.number().finite().nonnegative()
}).strict();
export const deliverySchema = z.object({ taskId: z.string(), runId: z.string().uuid(), inputDigest: z.string(), templateDigest: z.string(), renderRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  sourceDigest: z.string(), timelineRef: z.string(), checks: z.array(z.string()),
  files: z.array(z.object({ id: z.string(), content: z.string(), file: z.string(), sha256: z.string(), dur: z.number().positive(),
    fromFrame: z.number().int().nonnegative(), toFrame: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(),cutMetadata:sceneCutMetadataSchema.optional()
  }).strict()).min(2)
}).strict();
export type Delivery = z.infer<typeof deliverySchema>;
export const terminal = (state: State) => ['succeeded','failed','cancelled'].includes(state);
