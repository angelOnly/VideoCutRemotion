import { ProductionError } from './contracts.js';

/** 同一视频的渲染、批量静帧和固定媒体检查共用入口，直到真实工作结束才释放。 */
export class RunWork {
  private active=new Map<string,{id:string;promise:Promise<unknown>}>();
  current(runId:string){return this.active.get(runId)?.id;}
  start<T>(runId:string,id:string,work:()=>Promise<T>):Promise<T>{
    const old=this.active.get(runId);
    if(old)throw new ProductionError('RENDER_BUSY',`本视频正在处理 ${old.id}，请先读取原任务`,409);
    const promise=Promise.resolve().then(work).finally(()=>this.active.delete(runId));
    this.active.set(runId,{id,promise});
    void promise.catch(()=>{});
    return promise;
  }
  async drain(runId?:string){
    while(true){const entries=[...this.active].filter(([id])=>!runId||id===runId);if(!entries.length)return;await Promise.allSettled(entries.map(([,w])=>w.promise));}
  }
}
