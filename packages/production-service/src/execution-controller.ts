import { relative } from 'node:path';
import { canonical, deliverySchema, ProductionError, sha256, type Run, turnResultSchema, type finalHandoffSchema } from './contracts.js';
import type { z } from 'zod';
import type { ProductionRepository } from './repository.js';
import { json, regular } from './files.js';
import { MediaJobEvents } from './run-work.js';

export type RuntimeMediaState={id:string;runId:string;kind:'template-render'|'frame-preview';input:{previewOnly?:boolean;timelineRef?:string;checks?:string[];[key:string]:unknown};releaseId?:string;deliveryPath?:string;state:'running'|'succeeded'|'failed'|'unknown'|'cancelled';attempt:number;inputDigest:string;sourceDigest?:string;error?:string};
export type MediaRuntime={read:(run:Run,id:string)=>Promise<RuntimeMediaState>;events:MediaJobEvents};
export type RuntimeWait={waitId:string;threadId:string;originTurnId:string;renderRequestId:string;attempt:number;inputDigest:string;sourceDigest?:string;releaseId:string;executionToken:string;deliveryDigest?:string;state:'waiting_media'|'resuming'|'resumed'|'handed_off';terminalState?:RuntimeMediaState['state'];resumeTurnId?:string};
type FinalHandoff=z.infer<typeof finalHandoffSchema>;
export type RuntimeOutcome={kind:'handoff';handoff:FinalHandoff;wait:RuntimeWait}|{kind:'resume';wait:RuntimeWait;message:string};
export const mediaEventKey=(runId:string,id:string)=>`${runId}:${id}`;
const cancelled=()=>new ProductionError('PROCESS_CANCELLED','任务已取消，不再开启模型轮次');

/** 等待只读明确选定的正式作业；成功由服务交付，只有明确失败才续接作者。 */
export class ExecutionController {
  constructor(private run:Run,private repo:ProductionRepository,private media:MediaRuntime|undefined,private signal:AbortSignal,private reconcileMs=30000,private root?:string){}
  private check(){if(this.signal.aborted)throw cancelled();const latest=this.repo.get(this.run.runId);if(latest.state==='cancelling'||latest.token!==this.run.token)throw cancelled();this.repo.guard(latest,this.run.token!);}
  private swap(expected:RuntimeWait|undefined,value:RuntimeWait){this.check();if(!this.repo.compareCheckpoint(this.run.runId,this.run.token!,'runtimeWait',expected,value))throw new ProductionError('CODEX_RESULT_UNKNOWN','等待检查点已变化，禁止重复续接',503);}
  private async readJob(id:string){
    try{return await this.media!.read(this.run,id);}catch(error){
      if(error instanceof ProductionError&&error.code==='WAIT_JOB_CHANGED')throw new ProductionError('CODEX_RESULT_UNKNOWN','原媒体输入摘要不符，保留原句柄核查',503);
      throw error;
    }
  }
  private validateJob(job:RuntimeMediaState,id:string){
    if(job.runId!==this.run.runId||job.id!==id||job.kind!=='template-render'||job.input?.previewOnly!==false||!Number.isInteger(job.attempt)||job.attempt<1)throw new ProductionError('WAIT_JOB_INVALID','只能选定本 Run 具有真实尝试代次的正式导出');
    if(job.inputDigest!==sha256(canonical({kind:job.kind,input:job.input})))throw new ProductionError('CODEX_RESULT_UNKNOWN','原媒体输入摘要不符，保留原句柄核查',503);
    if(!job.releaseId||job.releaseId!==this.run.checkpoint.release?.releaseId)throw new ProductionError('CODEX_RESULT_UNKNOWN','原媒体发行与当前 Run 不符',503);
  }
  /** 发布恢复仍核对原作业，不能只因为磁盘上有一份 final 就换代交付。 */
  async validateTransferred(){
    this.check();const latest=this.repo.get(this.run.runId),wait=latest.checkpoint.runtimeWait as RuntimeWait;
    if(!this.media||wait?.state!=='handed_off')throw new ProductionError('CODEX_RESULT_UNKNOWN','缺少可核对的服务交接记录',503);
    const job=await this.readJob(wait.renderRequestId);this.check();this.validateJob(job,wait.renderRequestId);
    if(job.state!=='succeeded'||wait.executionToken!==this.run.token||job.attempt!==wait.attempt||job.releaseId!==wait.releaseId||job.inputDigest!==wait.inputDigest||job.sourceDigest!==wait.sourceDigest||job.deliveryPath!==latest.checkpoint.handoff?.resultPath)throw new ProductionError('CODEX_RESULT_UNKNOWN','已转交的原作业状态或身份变化，保留原句柄核查',503);
  }
  async wait(threadId:string,turnId:string,raw:unknown):Promise<RuntimeOutcome|null>{
    const result=turnResultSchema.parse(raw);if(result.kind==='final')return null;
    if(this.run.stage!=='render'||!this.media)throw new ProductionError('RUNTIME_WAIT_UNAVAILABLE','当前阶段未连接媒体等待能力');
    this.check();
    let job=await this.readJob(result.renderRequestId);this.validateJob(job,result.renderRequestId);
    const previous=this.repo.get(this.run.runId).checkpoint.runtimeWait as RuntimeWait|undefined;
    const waitId=`${threadId}:${turnId}`;
    let wait:RuntimeWait;
    if(previous?.waitId===waitId){
      if(previous.state==='handed_off'){
        const handoff=this.repo.get(this.run.runId).checkpoint.handoff;
        if(handoff)return {kind:'handoff',handoff,wait:previous};
        throw new ProductionError('CODEX_RESULT_UNKNOWN','等待已转交但缺少交接记录',503);
      }
      if(previous.state!=='waiting_media')throw new ProductionError('CODEX_RESULT_UNKNOWN','原等待已发起续接，先核查实际轮次',503);
      wait=previous;
    }else{
      if(previous?.state==='resuming'||previous?.state==='handed_off')throw new ProductionError('CODEX_RESULT_UNKNOWN','上次续接或交付已接管，禁止替换目标',503);
      if(previous?.renderRequestId===job.id&&previous.attempt===job.attempt&&previous.terminalState===job.state)throw new ProductionError('RUNTIME_WAIT_CONSUMED','同一媒体终态已接回，应继续检查原结果');
      wait={waitId,threadId,originTurnId:turnId,renderRequestId:job.id,attempt:job.attempt,inputDigest:job.inputDigest,sourceDigest:job.sourceDigest,releaseId:job.releaseId!,executionToken:this.run.token!,state:'waiting_media'};
      this.swap(previous,wait);
    }
    // 先登记监听，再读可靠状态，覆盖“完成早于等待”和读写交错。
    while(true){
      this.check();const wake=this.media.events.subscribe(mediaEventKey(this.run.runId,job.id),this.reconcileMs,this.signal);
      try{
        try{job=await this.readJob(job.id);this.check();this.validateJob(job,result.renderRequestId);}catch(error){
          if(error instanceof ProductionError&&error.code==='WAIT_JOB_INVALID')throw new ProductionError('CODEX_RESULT_UNKNOWN','已选定的正式媒体身份变化，保留原句柄核查',503);
          throw error;
        }
        if(wait.executionToken!==this.run.token||job.releaseId!==wait.releaseId||job.attempt!==wait.attempt||job.inputDigest!==wait.inputDigest||(wait.sourceDigest&&job.sourceDigest!==wait.sourceDigest))throw new ProductionError('CODEX_RESULT_UNKNOWN','原媒体尝试、令牌、发行或快照已变化，保留原等待记录核查',503);
        if(!wait.sourceDigest&&job.sourceDigest){const bound={...wait,sourceDigest:job.sourceDigest};this.swap(wait,bound);wait=bound;}
        if(job.state==='cancelled')throw cancelled();
        if(job.state==='unknown')throw new ProductionError('CODEX_RESULT_UNKNOWN',job.error??'原媒体进程无法确认，禁止重放',503);
        if(job.state==='succeeded'||job.state==='failed')break;
        await wake.promise;
      }finally{wake.dispose();}
    }
    if(job.state==='succeeded')return this.handoff(wait,job);
    const next:RuntimeWait={...wait,state:'resuming',terminalState:job.state,sourceDigest:job.sourceDigest};this.swap(wait,next);
    return {kind:'resume',wait:next,message:`原正式媒体作业明确失败：${JSON.stringify(job)}。按原诊断决定续做原作业或返修源码，不重放未知作业、不重配无关音频。`};
  }
  private async handoff(wait:RuntimeWait,job:RuntimeMediaState):Promise<RuntimeOutcome>{
    if(!this.root||!job.deliveryPath||!job.sourceDigest)throw new ProductionError('DELIVERY_RESULT_MISSING','正式成功作业缺少受管清单或源码身份');
    let path:string,raw:unknown;
    try{path=await regular(this.root,relative(this.root,job.deliveryPath));raw=await json(path);}
    catch(error){
      if(error instanceof SyntaxError)throw new ProductionError('DELIVERY_FORMAT_INVALID','原正式清单 JSON 损坏，不由模型重写');
      if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ProductionError('DELIVERY_RESULT_MISSING','原正式清单确定缺失，不由模型重写');
      throw error;
    }
    const parsed=deliverySchema.safeParse(raw);
    if(!parsed.success)throw new ProductionError('DELIVERY_FORMAT_INVALID','原正式清单不符合交付合同');
    const delivery=parsed.data;
    if(delivery.taskId!==this.run.taskId||delivery.runId!==this.run.runId||delivery.inputDigest!==this.run.inputDigest||delivery.templateDigest!==this.run.checkpoint.template?.digest||delivery.renderRequestId!==job.id||delivery.sourceDigest!==job.sourceDigest||delivery.timelineRef!==job.input.timelineRef||canonical(delivery.checks)!==canonical(job.input.checks))throw new ProductionError('DELIVERY_IDENTITY_INVALID','原正式清单的任务、模板、输入、源码或检查说明不符');
    this.check();
    const handoff:FinalHandoff={kind:'final',taskId:this.run.taskId,runId:this.run.runId,inputDigest:this.run.inputDigest,resultPath:path};
    const next:RuntimeWait={...wait,state:'handed_off',terminalState:'succeeded',sourceDigest:job.sourceDigest,deliveryDigest:sha256(canonical(delivery))};
    // 短事务同时落下转交标记和原清单引用，重启不会重复开启模型轮次。
    if(!this.repo.handoffRuntime(this.run.runId,this.run.token!,wait,next,handoff))throw new ProductionError('CODEX_RESULT_UNKNOWN','原等待已变化，不能转交另一份清单',503);
    return {kind:'handoff',handoff,wait:next};
  }
  bind(wait:RuntimeWait,turnId:string){this.swap(wait,{...wait,state:'resumed',resumeTurnId:turnId});}
}
