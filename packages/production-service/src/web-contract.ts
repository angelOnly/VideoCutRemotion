import { z } from 'zod';
import { analysisRequestSchema, renderRequestSchema, ProductionError, type Run, type AnalysisRequest } from './contracts.js';

const webAnalysis = z.object({
  taskId: z.string().min(1), content: z.string().min(1), otherRequirements: z.string().default(''),
  plugin: z.object({customTemplateId:z.string().min(1),templateId:z.string().default(''),digitalHumanId:z.string().default('')}).strict(),
  otherMaterial: z.object({picInfoList:z.array(z.unknown()).max(0),videoInfoList:z.array(z.unknown()).max(0)}).strict()
}).strict();
const webRender = z.object({
  taskId:z.string().min(1),templateId:z.string().default(''),introUrl:z.string().default(''),introIndex:z.number().int().nonnegative().default(0),
  outroUrl:z.string().default(''),outroIndex:z.number().int().nonnegative().default(0),
  dataList:z.array(z.object({id:z.string(),content:z.string()}).passthrough()).min(1)
}).strict();

export function normalizeWebAnalysis(raw:unknown) {
  const direct=analysisRequestSchema.safeParse(raw);if(direct.success)return direct.data;
  const web=webAnalysis.parse(raw);
  if(web.plugin.digitalHumanId||web.plugin.templateId)throw new ProductionError('UNSUPPORTED_WEB_INPUT','定制模板任务不能同时选择其他模板或数字人');
  return analysisRequestSchema.parse({taskId:web.taskId,content:web.content,otherRequirements:web.otherRequirements,plugin:{customTemplateId:web.plugin.customTemplateId}});
}
export function normalizeWebRender(raw:unknown,runs:Run[]) {
  const direct=renderRequestSchema.safeParse(raw);if(direct.success)return direct.data;
  const web=webRender.parse(raw);
  // 网页不传分析版本，只允许接回本任务最新且成功的分析，不能跨过失败的新分析。
  const analysis=[...runs].reverse().find(r=>r.stage==='analysis');
  if(!analysis||analysis.state!=='succeeded')throw new ProductionError('BASE_ANALYSIS_INVALID','网页任务必须先完成最新 Analysis',409);
  const base=analysis.request as AnalysisRequest;
  if(web.templateId&&web.templateId!==base.plugin.customTemplateId)throw new ProductionError('TEMPLATE_CONFLICT','渲染模板与分析冻结模板不一致',409);
  if(web.introUrl||web.outroUrl)throw new ProductionError('UNSUPPORTED_WEB_INPUT','片头片尾由定制模板提供，不支持网页额外替换');
  return renderRequestSchema.parse({taskId:web.taskId,basePlanVersion:analysis.planVersion,otherRequirements:base.otherRequirements,dataList:web.dataList.map(({id,content})=>({id,content}))});
}

export function webCallbackFields(stage:string,result:any,templateId:string) {
  return {msg:'',dataList:result?.dataList??[],dataInfo:{templateId,...(stage==='analysis'?{durationMode:'estimated',previews:[]}:{sceneCount:result?.dataList?.filter((s:any)=>s.extraData?.kind!=='wholeVideo').length??0})},...(stage==='analysis'?{plan:{}}:{})};
}
