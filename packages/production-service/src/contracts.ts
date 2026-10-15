import { createHash } from 'node:crypto';
import { z } from 'zod';

export class ProductionError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
const text = z.string().max(100000).refine(v => v.trim().length > 0, '正文不能为空');
export const sceneId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).refine(v => v !== 'whole-video', '整片 ID 不可用于分镜');
const offset = z.number().int().nonnegative();
export const directingSchema = z.object({
  kind: z.enum(['speech','visual']),
  speechTurns: z.array(z.object({id:sceneId,speakerId:z.string().min(1).max(80).nullable(),start:offset,end:offset}).strict()).max(500),
  visualDirections: z.array(z.string().max(8000).refine(v=>Boolean(v.trim()),'画面说明不能为空')).max(100),
  chapter: z.string().min(1).max(300).optional(),
  durationSec: z.number().finite().positive().max(3600).optional()
}).strict();
const sceneFields = {id:sceneId,content:z.string().max(100000),submittedContent:z.string().max(100000).optional(),directing:directingSchema.optional()};
function checkScene(scene:{content:string;directing?:z.infer<typeof directingSchema>},ctx:z.RefinementCtx){
  const fail=(path:(string|number)[],message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,path,message});
  const d=scene.directing;
  if(d?.kind==='visual'){
    if(scene.content.length||d.speechTurns.length||!d.visualDirections.length||!d.durationSec)fail(['directing'],'无口播分镜须正文为空、没有发言、有画面安排及正时长');
    return;
  }
  if(!scene.content.trim())fail(['content'],'口播正文不能为空');
  if(!d)return;
  if(d.durationSec!==undefined)fail(['directing','durationSec'],'口播时长须来自实际音频');
  let cursor=0;const ids=new Set<string>();
  for(const [i,t] of d.speechTurns.entries()){
    if(ids.has(t.id)||t.start!==cursor||t.end<=t.start||t.end>scene.content.length)fail(['directing','speechTurns',i],'发言 ID 重复或 UTF-16 范围重叠、遗漏、越界');
    // 不允许从 UTF-16 代理对中间拆开人物发言。
    for(const p of [t.start,t.end])if(p>0&&p<scene.content.length&&/[\uD800-\uDBFF]/u.test(scene.content[p-1])&&/[\uDC00-\uDFFF]/u.test(scene.content[p]))fail(['directing','speechTurns',i],'发言边界不能拆开字符');
    if(!scene.content.slice(t.start,t.end).trim())fail(['directing','speechTurns',i],'发言不能只有空白');
    ids.add(t.id);cursor=t.end;
  }
  if(cursor!==scene.content.length)fail(['directing','speechTurns'],'发言必须完整覆盖正文');
}
export const sceneSchema = z.object(sceneFields).strict().superRefine(checkScene);
// 网页只编辑可见文本；人物和画面标签随 content 原样往返。
export const analysisSceneSchema = z.object({id:sceneId,content:text,dur:z.number().finite().positive(),durationSource:z.literal('estimated')}).strict();
const uniqueScenes=(v:{id:string}[])=>new Set(v.map(s=>s.id)).size===v.length;
const scenes = z.array(sceneSchema).min(1).max(200).refine(uniqueScenes,'分镜 ID 重复');
const common = { taskId: z.string().min(1).max(200), otherRequirements: z.string().max(20000) };
// 两栏都允许省略；补空串后统一判断，保留实际传入的原文。
export const analysisRequestSchema = z.object({ ...common, content: z.string().max(100000).default(''), otherRequirements: common.otherRequirements.default(''), plugin: z.object({ customTemplateId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict() }).strict().refine(v=>Boolean(v.content.trim()||v.otherRequirements.trim()),'正文与需求至少一栏有实质内容');
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
  dataList: z.array(analysisSceneSchema).min(1).max(200).refine(uniqueScenes,'分镜 ID 重复'), context: z.string().min(1).refine(value=>value.trim().length>0,'context 必须是非空 Markdown 字符串')
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

// 非最终等待仅指向已经受理的媒体；交付身份仍由 Worker 独立核验。
export const finalHandoffSchema=z.object({kind:z.literal('final'),taskId:z.string(),runId:z.string(),inputDigest:z.string(),resultPath:z.string().min(1)}).strict();
export const turnResultSchema=z.discriminatedUnion('kind',[finalHandoffSchema,z.object({kind:z.literal('await_runtime'),renderRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)}).strict()]);
// 模型结构化输出要求根节点为对象；内部仍共用原有等待／交付联合校验。
export const modelTurnOutputSchema=z.object({result:turnResultSchema}).strict();
