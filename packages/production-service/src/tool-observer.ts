/** 心跳不代表工具有进展；只记录长期没有结束事件的具体调用，不盲目重放。 */
export class ToolObserver {
  private calls=new Map<string,{threadId:string;itemId:string;type:string;startedAt:number}>();
  observe(event:any,now=Date.now()){
    const p=event.params,item=p?.item;if(!p?.threadId||!item?.id)return;
    const key=`${p.threadId}:${item.id}`;
    if(event.method==='item/completed')this.calls.delete(key);
    else if(event.method==='item/started'&&['commandExecution','mcpToolCall'].includes(item.type))this.calls.set(key,{threadId:p.threadId,itemId:item.id,type:item.type,startedAt:now});
  }
  stalled(now=Date.now(),thresholdMs=180000){return [...this.calls.values()].filter(c=>now-c.startedAt>=thresholdMs).map(c=>({...c,elapsedMs:now-c.startedAt}));}
}
