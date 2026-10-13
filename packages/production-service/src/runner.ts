import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { analysisResultSchema, deliverySchema, ProductionError, type Run, type AnalysisRequest, type RenderRequest } from './contracts.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ProductionConfig } from './config.js';
import type { ProductionRepository } from './repository.js';
import { freezeTemplate } from './template-package.js';
import { json, writeJson, treeDigest, regular } from './files.js';
import { publishDelivery } from './delivery.js';
import { executeCodex } from './codex-session.js';
export type Executor=(run:Run,root:string,repo:ProductionRepository,config:ProductionConfig,signal:AbortSignal)=>Promise<any>;
export class ProductionRunner {
  active=new Map<string,AbortController>();stopping=false;
  settleTools:()=>Promise<void>=async()=>{};
  constructor(public repo:ProductionRepository,public config:ProductionConfig,private executor:Executor=executeCodex){}
  runRoot(run:Run){return join(this.config.dataRoot,'tasks',run.taskKey,'runs',run.runId);}
  async prepare(run:Run){
    const root=this.runRoot(run),taskRoot=join(this.config.dataRoot,'tasks',run.taskKey);await fs.mkdir(root,{recursive:true});let template:any,analysis:any,base:any;
    if(run.stage==='analysis')template=await freezeTemplate(this.config.templateBase,(run.request as AnalysisRequest).plugin.customTemplateId,join(taskRoot,'analyses',run.runId));
    else{
      analysis=this.repo.list(run.accountId,run.taskId).find(r=>r.planVersion===(run.request as RenderRequest).basePlanVersion)!;template=analysis.checkpoint.template;
      if(!template||await treeDigest(template.root)!==template.sourceDigest)throw new ProductionError('FROZEN_TEMPLATE_INVALID','冻结模板缺失或摘要不符');
      let source=template.root;const baseId=(run.request as RenderRequest).baseRenderRunId;
      if(baseId){base=this.repo.get(baseId,run.accountId);source=join(this.runRoot(base),'source-snapshot');
        if(!(await fs.stat(source).catch(()=>null))||await treeDigest(source)!==base.result.sourceDigest)throw new ProductionError('BASE_PROJECT_UNAVAILABLE','基础工程不可用，旧视频保留');
      }
      const project=join(root,'project');if(!(await fs.stat(project).catch(()=>null)))await fs.cp(source,project,{recursive:true});
    }
    run=this.repo.checkpoint(run.runId,run.token!,{template,release:this.config.release});
    await writeJson(join(root,'input.json'),{taskId:run.taskId,runId:run.runId,stage:run.stage,inputDigest:run.inputDigest,request:run.request,template,analysis:analysis?.result,baseRender:base?{runId:base.runId,result:base.result,request:base.request}:null,workRoot:root,projectRoot:join(root,'project'),release:this.config.release});
    // 从实际校验器生成协议，避免示例文字被误读为字段类型。
    await writeJson(join(root,'result-schema.json'),zodToJsonSchema(run.stage==='analysis'?analysisResultSchema:deliverySchema,{$refStrategy:'none'}));
    return run;
  }
  async execute(run:Run){
    const controller=new AbortController();this.active.set(run.runId,controller);const root=this.runRoot(run);
    const heartbeat=setInterval(()=>{try{const latest=this.repo.get(run.runId);if(latest.state==='cancelling')controller.abort();else this.repo.checkpoint(run.runId,run.token!,{});}catch{}},1000);
    try{
      // 先恢复确定的交付检查点；发布失败不重新请求 Codex 或配音。
      if(!run.checkpoint.handoff){run=await this.prepare(run);const handoff=await this.executor(run,root,this.repo,this.config,controller.signal);
        if(handoff.runId!==run.runId||handoff.taskId!==run.taskId||handoff.inputDigest!==run.inputDigest)throw new ProductionError('HANDOFF_IDENTITY_INVALID','后台交接身份不符');
        if(typeof handoff.resultPath!=='string'||!handoff.resultPath.trim())throw new ProductionError('CODEX_NO_RESULT','后台未交付结果文件；详见本 run 的 Codex 事件和工具诊断',500);
        const path=await regular(root,relative(root,handoff.resultPath));run=this.repo.checkpoint(run.runId,run.token!,{handoff:{...handoff,resultPath:path}});
      }
      await this.settleTools();
      if(controller.signal.aborted){this.repo.finish(run.runId,run.token,'cancelled');return;}
      const result=await json(run.checkpoint.handoff.resultPath);
      if(run.stage==='analysis'){
        const parsed=analysisResultSchema.parse(result);if(parsed.runId!==run.runId||parsed.taskId!==run.taskId||parsed.inputDigest!==run.inputDigest)throw new ProductionError('ANALYSIS_IDENTITY_INVALID','分析结果身份不符');
        if(new Set(parsed.dataList.map(s=>s.id)).size!==parsed.dataList.length)throw new ProductionError('ANALYSIS_IDS_INVALID','分析分镜 ID 重复');
        if(parsed.dataList.map(s=>s.content).join('')!==(run.request as AnalysisRequest).content)throw new ProductionError('ANALYSIS_CONTENT_CHANGED','分析分镜必须完整保留输入正文及顺序');
        await fs.writeFile(join(root,'analysis-context.md'),parsed.context);this.repo.finish(run.runId,run.token,'succeeded',parsed);
      }else{
        const published=await publishDelivery(run,root,join(this.config.dataRoot,'tasks',run.taskKey),this.config.mediaBase,result);this.repo.finish(run.runId,run.token,'succeeded',published);
      }
    }catch(e){
      const error={code:e instanceof ProductionError?e.code:'EXECUTION_FAILED',message:e instanceof Error?e.message:String(e)};
      await this.settleTools();
      if(controller.signal.aborted&&error.code==='CODEX_TURN_FAILED')this.repo.finish(run.runId,run.token,'cancelled',null,error);
      else if(error.code==='CODEX_RESULT_UNKNOWN'||error.code==='PROCESS_CANCELLED')this.repo.mark(run.runId,run.token!,'unknown',error);
      else if(!(e instanceof ProductionError)&&this.repo.get(run.runId).checkpoint.handoff&&run.stage==='render')this.repo.mark(run.runId,run.token!,'recovering',error);
      else this.repo.finish(run.runId,run.token,'failed',null,error);
    }finally{clearInterval(heartbeat);this.active.delete(run.runId);}
  }
  async tick(){if(this.stopping||this.active.size)return;const run=this.repo.claim();if(run)await this.execute(run);}
  async recover(){for(const run of this.repo.unfinished()){
    if(run.checkpoint.handoff)await this.execute(run);
    else if(run.checkpoint.codex?.threadId)await this.execute(run);
    else this.repo.mark(run.runId,run.token!,'unknown',{code:'INTERRUPTED_WITHOUT_CHECKPOINT',message:'原执行中断，未证明可安全重新提交；请核查原任务'});
  }}
  stop(){this.stopping=true;for(const controller of this.active.values())controller.abort();}
}
