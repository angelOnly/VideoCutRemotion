import { ProductionError } from './contracts.js';

/** App Server 同时推送子代理事件；只有主线程的指定 turn 可以交付结果。 */
export function collectMainTurn(
  target: () => { threadId?: string; turnId?: string },
  finish: (result: { turn: any; text: string }) => void,
  fail: (error: Error) => void,
) {
  let finalText = '';
  return (event: any) => {
    const expected = target(), params = event.params;
    if (!expected.threadId || params?.threadId !== expected.threadId) return;
    const eventTurn = params.turnId ?? params.turn?.id;
    // 首个 turn 的通知可能早于 turn/start 响应；该新线程此时没有旧 turn。
    if (expected.turnId && eventTurn !== expected.turnId) return;
    if (event.method === 'item/completed' && params.item?.type === 'agentMessage') {
      finalText = params.item.text;
    }
    if (event.method === 'turn/completed') {
      if (params.turn.status === 'completed') finish({ turn: params.turn, text: finalText });
      else fail(new ProductionError('CODEX_TURN_FAILED', `Codex 状态 ${params.turn.status}：${JSON.stringify(params.turn.error)}`, 500));
    }
  };
}

/** 新轮次响应前只缓存，拿到真实 turnId 后重放，绝不认领旧轮迟到 final。 */
export function createTurnReceiver(threadId:string){
  let turnId:string|undefined,finished=false;
  const buffered:any[]=[];
  let resolve!:(value:{turn:any;text:string})=>void,reject!:(error:Error)=>void;
  const promise=new Promise<{turn:any;text:string}>((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});
  const collect=collectMainTurn(()=>({threadId,turnId}),value=>{if(!finished){finished=true;resolve(value);}},error=>{if(!finished){finished=true;reject(error);}});
  return {promise,
    observe(event:any){if(finished||event.params?.threadId!==threadId)return;if(!turnId)buffered.push(event);else collect(event);},
    bind(id:string){if(turnId&&turnId!==id)throw new ProductionError('CODEX_RESULT_UNKNOWN','轮次绑定冲突',503);turnId=id;for(const event of buffered.splice(0))collect(event);},
    fail(error:Error){if(!finished){finished=true;reject(error);}},
  };
}

/** 宿主可能仅通过 subAgentActivity 公告作者线程，不依赖 thread/started 的单一路径。 */
export function threadDiscoveries(event:any):Array<{threadId:string;cwd?:string;parentThreadId?:string;source:string}>{
  const p=event.params,t=p?.thread,item=p?.item;
  if(event.method==='thread/started'&&t?.id)return [{threadId:t.id,cwd:t.cwd,parentThreadId:t.parentThreadId??undefined,source:'thread/started'}];
  if(item?.type==='subAgentActivity'&&item.agentThreadId)return [{threadId:item.agentThreadId,parentThreadId:p.threadId,source:'subAgentActivity'}];
  if(item?.type==='collabAgentToolCall'&&Array.isArray(item.receiverThreadIds))return item.receiverThreadIds.map((threadId:string)=>({threadId,parentThreadId:item.senderThreadId??p.threadId,source:'collabAgentToolCall'}));
  return [];
}
