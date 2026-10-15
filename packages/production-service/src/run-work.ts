import { ProductionError } from './contracts.js';

/** 同一视频的渲染、批量静帧和固定媒体检查共用入口，直到真实工作结束才释放。 */
export class RunWork {
  private active=new Map<string,{id:string;promise:Promise<unknown>}>();
  private queued=new Map<string,Array<{id:string;launch:()=>void}>>();
  current(runId:string){return this.active.get(runId)?.id;}
  get size(){return this.active.size;}
  start<T>(runId:string,id:string,work:()=>Promise<T>):Promise<T>{
    const old=this.active.get(runId);
    if(old)throw new ProductionError('RENDER_BUSY',`本视频正在处理 ${old.id}，请先读取原任务`,409);
    const promise=Promise.resolve().then(work).finally(()=>this.next(runId));
    this.active.set(runId,{id,promise});
    void promise.catch(()=>{});
    return promise;
  }
  private next(runId:string){
    this.active.delete(runId);const queue=this.queued.get(runId),next=queue?.shift();
    if(!queue?.length)this.queued.delete(runId);next?.launch();
  }
  /** 仅用于已受理静帧批次；仍逐项执行，同一 Run 不增加绘图并发。 */
  enqueue<T>(runId:string,id:string,work:()=>Promise<T>):Promise<T>{
    if(!this.active.has(runId))return this.start(runId,id,work);
    const promise=new Promise<T>((resolve,reject)=>{
      const launch=()=>{void this.start(runId,id,work).then(resolve,reject);};
      const queue=this.queued.get(runId)??[];queue.push({id,launch});this.queued.set(runId,queue);
    });void promise.catch(()=>{});return promise;
  }
  has(runId:string,id:string){return this.current(runId)===id||!!this.queued.get(runId)?.some(item=>item.id===id);}
  async drain(runId?:string){
    while(true){const entries=[...this.active].filter(([id])=>!runId||id===runId);if(!entries.length)return;await Promise.allSettled(entries.map(([,w])=>w.promise));}
  }
}

type Waiter={runId:string;slots:number;signal?:AbortSignal;abort:()=>void;resolve:(release:()=>void)=>void;reject:(error:unknown)=>void};
/** 按 Run 轮转领取加权额度；退出与异常必须等工作真正结束后释放。 */
class FairBudget {
  private used=0;
  private queues=new Map<string,Waiter[]>();
  private order:string[]=[];
  constructor(private capacity:number){if(!Number.isInteger(capacity)||capacity<1)throw new ProductionError('CONFIG_INVALID','媒体预算必须为正整数');}
  get active(){return this.used;}
  private pump(){
    while(this.order.length){
      const id=this.order[0],queue=this.queues.get(id)!,waiter=queue[0];
      // 等待队首的大额度，避免小作业无限插队导致饥饿。
      if(this.used+waiter.slots>this.capacity)return;
      this.order.shift();queue.shift();if(queue.length)this.order.push(id);else this.queues.delete(id);
      waiter.signal?.removeEventListener('abort',waiter.abort);this.used+=waiter.slots;
      let released=false;waiter.resolve(()=>{if(released)return;released=true;this.used-=waiter.slots;this.pump();});
    }
  }
  private acquire(runId:string,slots:number,signal?:AbortSignal):Promise<()=>void>{
    if(!Number.isInteger(slots)||slots<1||slots>this.capacity)return Promise.reject(new ProductionError('MEDIA_BUDGET_INVALID','请求额度超过当前媒体预算'));
    if(signal?.aborted)return Promise.reject(new ProductionError('PROCESS_CANCELLED','排队前已取消'));
    return new Promise((resolve,reject)=>{
      const waiter:Waiter={runId,slots,signal,resolve,reject,abort:()=>{
        const queue=this.queues.get(runId);if(!queue)return;
        const index=queue.indexOf(waiter);if(index<0)return;queue.splice(index,1);
        if(!queue.length){this.queues.delete(runId);this.order=this.order.filter(id=>id!==runId);}
        reject(new ProductionError('PROCESS_CANCELLED','媒体排队已取消'));this.pump();
      }};
      if(!this.queues.has(runId)){this.queues.set(runId,[]);this.order.push(runId);}
      this.queues.get(runId)!.push(waiter);signal?.addEventListener('abort',waiter.abort,{once:true});this.pump();
    });
  }
  async with<T>(runId:string,slots:number,signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T>{
    const release=await this.acquire(runId,slots,signal);
    try{if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','媒体启动前已取消');return await work();}finally{release();}
  }
}

/** 一个服务实例共用预算，预览和正式导出均从这里领取。 */
export class MediaBudget {
  private drawing:FairBudget;
  private processes:FairBudget;
  constructor(drawing:number,processes:number){this.drawing=new FairBudget(drawing);this.processes=new FairBudget(processes);}
  get active(){return {drawing:this.drawing.active,processes:this.processes.active};}
  withDrawing<T>(runId:string,slots:number,signal:AbortSignal|undefined,work:()=>Promise<T>){return this.drawing.with(runId,slots,signal,work);}
  withProcess<T>(runId:string,signal:AbortSignal|undefined,work:()=>Promise<T>){return this.processes.with(runId,1,signal,work);}
}

/** 只唤醒原作业状态读取；超时不会创建或重试任何工作。 */
export class MediaJobEvents {
  private listeners=new Map<string,Set<()=>void>>();
  notify(key:string){for(const listener of [...this.listeners.get(key)??[]])listener();}
  /** 先订阅后读取磁盘，避免完成事件恰好落在读状态与注册监听之间。 */
  subscribe(key:string,ms:number,signal?:AbortSignal){
    let dispose=()=>{};
    const promise=new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);const group=this.listeners.get(key);group?.delete(done);if(!group?.size)this.listeners.delete(key);resolve();};
      const timer=setTimeout(done,ms);dispose=done;
      if(!this.listeners.has(key))this.listeners.set(key,new Set());this.listeners.get(key)!.add(done);
      signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
    });return {promise,dispose};
  }
  async wait(key:string,ms:number,signal?:AbortSignal){
    if(ms<=0||signal?.aborted)return;
    await new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);const group=this.listeners.get(key);group?.delete(done);if(!group?.size)this.listeners.delete(key);resolve();};
      const timer=setTimeout(done,ms);
      if(!this.listeners.has(key))this.listeners.set(key,new Set());this.listeners.get(key)!.add(done);
      signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
    });
  }
}
