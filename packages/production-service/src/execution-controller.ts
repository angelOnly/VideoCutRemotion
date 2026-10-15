import { ProductionError, type Run, turnResultSchema } from './contracts.js';
import type { ProductionRepository } from './repository.js';
import { MediaJobEvents } from './run-work.js';

export type RuntimeMediaState={id:string;runId:string;state:'running'|'succeeded'|'failed'|'unknown'|'cancelled';attempt:number;inputDigest:string;sourceDigest?:string;error?:string};
export type MediaRuntime={read:(run:Run,id:string)=>Promise<RuntimeMediaState>;events:MediaJobEvents};
export type RuntimeWait={waitId:string;threadId:string;originTurnId:string;renderRequestId:string;attempt:number;inputDigest:string;sourceDigest?:string;state:'waiting_media'|'resuming'|'resumed';terminalState?:RuntimeMediaState['state'];resumeTurnId?:string};
export const mediaEventKey=(runId:string,id:string)=>`${runId}:${id}`;
const cancelled=()=>new ProductionError('PROCESS_CANCELLED','任务已取消，不再开启模型轮次');

/** 等待只读已受理作业；通知与定时核对都不调用模型、不重交媒体。 */
export class ExecutionController {
  constructor(private run:Run,private repo:ProductionRepository,private media:MediaRuntime|undefined,private signal:AbortSignal,private reconcileMs=30000){}
  private check(){if(this.signal.aborted)throw cancelled();const latest=this.repo.get(this.run.runId);if(latest.state==='cancelling'||latest.token!==this.run.token)throw cancelled();}
  private swap(expected:RuntimeWait|undefined,value:RuntimeWait){this.check();if(!this.repo.compareCheckpoint(this.run.runId,this.run.token!,'runtimeWait',expected,value))throw new ProductionError('CODEX_RESULT_UNKNOWN','等待检查点已变化，禁止重复续接',503);}
  async wait(threadId:string,turnId:string,raw:unknown):Promise<{wait:RuntimeWait;message:string}|null>{
    const result=turnResultSchema.parse(raw);if(result.kind==='final')return null;
    if(this.run.stage!=='render'||!this.media)throw new ProductionError('RUNTIME_WAIT_UNAVAILABLE','当前阶段未连接媒体等待能力');
    this.check();
    let job=await this.media.read(this.run,result.renderRequestId);
    if(job.runId!==this.run.runId||job.id!==result.renderRequestId||!Number.isInteger(job.attempt)||job.attempt<1)throw new ProductionError('RUNTIME_WAIT_INVALID','等待作业不属于当前 Run 或缺少真实尝试代次');
    const previous=this.repo.get(this.run.runId).checkpoint.runtimeWait as RuntimeWait|undefined;
    const waitId=`${threadId}:${turnId}`;
    let wait:RuntimeWait;
    if(previous?.waitId===waitId){
      if(previous.state!=='waiting_media')throw new ProductionError('CODEX_RESULT_UNKNOWN','原等待已发起续接，先核查实际轮次',503);
      wait=previous;
    }else{
      if(previous?.state==='resuming')throw new ProductionError('CODEX_RESULT_UNKNOWN','上次续接结果未知',503);
      if(previous?.renderRequestId===job.id&&previous.attempt===job.attempt&&previous.terminalState===job.state)throw new ProductionError('RUNTIME_WAIT_CONSUMED','同一媒体终态已接回，应继续检查原结果');
      wait={waitId,threadId,originTurnId:turnId,renderRequestId:job.id,attempt:job.attempt,inputDigest:job.inputDigest,sourceDigest:job.sourceDigest,state:'waiting_media'};
      this.swap(previous,wait);
    }
    // 先登记监听，再读可靠状态，覆盖“完成早于等待”和读写交错。
    while(true){
      this.check();const wake=this.media.events.subscribe(mediaEventKey(this.run.runId,job.id),this.reconcileMs,this.signal);
      try{
        job=await this.media.read(this.run,job.id);this.check();
        if(job.attempt!==wait.attempt||job.inputDigest!==wait.inputDigest||(wait.sourceDigest&&job.sourceDigest!==wait.sourceDigest))throw new ProductionError('CODEX_RESULT_UNKNOWN','原媒体尝试或快照已变化，保留原等待记录核查',503);
        if(job.state==='cancelled')throw cancelled();
        if(job.state==='unknown')throw new ProductionError('CODEX_RESULT_UNKNOWN',job.error??'原媒体进程无法确认，禁止重放',503);
        if(job.state==='succeeded'||job.state==='failed')break;
        await wake.promise;
      }finally{wake.dispose();}
    }
    const next:RuntimeWait={...wait,state:'resuming',terminalState:job.state,sourceDigest:job.sourceDigest};this.swap(wait,next);
    return {wait:next,message:`原媒体作业已到终态：${JSON.stringify(job)}。这是同一 Run 的原作业结果，成功时读取工具返回的 deliveryPath，将完整交付清单保存为 result.json 并返回正式 final 交接；失败时按原诊断处理。不得重复生成、配音或导出。未进行连续看听只如实记录，不等待听审或返回待审说明。`};
  }
  bind(wait:RuntimeWait,turnId:string){this.swap(wait,{...wait,state:'resumed',resumeTurnId:turnId});}
}
