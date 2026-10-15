import { z } from 'zod';
import { analysisRequestSchema, renderRequestSchema, ProductionError, type Run, type AnalysisRequest } from './contracts.js';
import {parseSceneScript} from './scene-script.js';

const webAnalysis = z.object({
  taskId: z.string().min(1), content: z.string().default(''), otherRequirements: z.string().default(''),
  plugin: z.object({customTemplateId:z.string().min(1),templateId:z.string().default(''),digitalHumanId:z.string().default('')}).strict(),
  otherMaterial: z.object({picInfoList:z.array(z.unknown()).max(0),videoInfoList:z.array(z.unknown()).max(0)}).strict().optional()
}).strict();
const webRender = z.object({
  taskId:z.string().min(1),
  templateId:z.string().default(''),introUrl:z.string().default(''),introIndex:z.number().int().nonnegative().default(0),
  outroUrl:z.string().default(''),outroIndex:z.number().int().nonnegative().default(0),
  // 接受现有网页的估时和素材字段，制作正文只从本次 content 解析。
  dataList:z.array(z.object({id:z.string(),content:z.string(),dur:z.number().optional(),extraData:z.unknown().optional()}).strict()).min(1)
}).strict();

export function normalizeWebAnalysis(raw:unknown) {
  const web=webAnalysis.parse(raw);
  if(web.plugin.digitalHumanId||web.plugin.templateId)throw new ProductionError('UNSUPPORTED_WEB_INPUT','定制模板任务不能同时选择其他模板或数字人');
  return analysisRequestSchema.parse({taskId:web.taskId,content:web.content,otherRequirements:web.otherRequirements,plugin:{customTemplateId:web.plugin.customTemplateId}});
}
export function normalizeWebRender(raw:unknown,runs:Run[]) {
  // 保留原有内部指定版本/指定成片 API；网页不需要提供这些字段。
  const direct=renderRequestSchema.safeParse(raw);
  if(direct.success){
    const analysis=runs.find(r=>r.taskId===direct.data.taskId&&r.stage==='analysis'&&r.planVersion===direct.data.basePlanVersion);
    return {...direct.data,dataList:direct.data.dataList.map(s=>s.directing?s:parseSceneScript(s,analysis?.checkpoint.template?.manifest))};
  }
  const web=webRender.parse(raw);
  // 沿原任务关联最新一次分析；失败或尚未完成时不回退到旧结果。
  const analysis=[...runs].filter(r=>r.taskId===web.taskId&&r.stage==='analysis').sort((a,b)=>b.planVersion-a.planVersion)[0];
  if(!analysis||analysis.state!=='succeeded')throw new ProductionError('BASE_ANALYSIS_INVALID','网页任务必须先完成最新 Analysis',409);
  const base=analysis.request as AnalysisRequest;
  if(web.templateId&&web.templateId!==base.plugin.customTemplateId)throw new ProductionError('TEMPLATE_CONFLICT','渲染模板与分析冻结模板不一致',409);
  if(web.introUrl||web.outroUrl)throw new ProductionError('UNSUPPORTED_WEB_INPUT','片头片尾由定制模板提供，不支持网页额外替换');
  return renderRequestSchema.parse({taskId:web.taskId,basePlanVersion:analysis.planVersion,otherRequirements:base.otherRequirements,dataList:web.dataList.map(scene=>parseSceneScript(scene,analysis.checkpoint.template?.manifest))});
}

export function webCallbackFields(stage:string,result:any,templateId:string) {
  return {msg:'',dataList:result?.dataList??[],dataInfo:{templateId,...(stage==='analysis'?{durationMode:'estimated',previews:[]}:{sceneCount:result?.dataList?.filter((s:any)=>s.extraData?.kind!=='wholeVideo').length??0})},...(stage==='analysis'?{plan:{}}:{})};
}
