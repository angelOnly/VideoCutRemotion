/** 心跳不代表工具有进展；只记录长期没有结束事件的具体调用，不盲目重放。 */
export class ToolObserver {
  private calls=new Map<string,{threadId:string;itemId:string;type:string;startedAt:number}>();
  private transport=new Map<string,{kind:string;source:'stderr'|'connection';lastObservedAt:number;count:number}>();
  private stderrTail='';
  private threads=new Map<string,{threadId:string;method:string;error:unknown;willRetry?:boolean;observedAt:number}>();
  observe(event:any,now=Date.now()){
    const p=event.params,item=p?.item;
    if(p?.threadId&&(event.method==='error'||event.method==='thread/error'||event.method==='thread/status/changed'))this.threads.set(p.threadId,{threadId:p.threadId,method:event.method,error:p.error??p.status,willRetry:p.willRetry,observedAt:now});
    if(!p?.threadId||!item?.id)return;
    const key=`${p.threadId}:${item.id}`;
    if(event.method==='item/completed')this.calls.delete(key);
    else if(event.method==='item/started'&&['commandExecution','mcpToolCall'].includes(item.type))this.calls.set(key,{threadId:p.threadId,itemId:item.id,type:item.type,startedAt:now});
  }
  stalled(now=Date.now(),thresholdMs=180000){return [...this.calls.values()].filter(c=>now-c.startedAt>=thresholdMs).map(c=>({...c,elapsedMs:now-c.startedAt}));}
  threadDiagnostics(){return [...this.threads.values()];}
  /** 仅记录通信诊断类别，不据此重放媒体，也不能推断某个审片单元没有进展。 */
  observeTransport(text:string,source:'stderr'|'connection'='stderr',now=Date.now()){
    const message=source==='stderr'?this.stderrTail+text:text;
    if(source==='stderr')this.stderrTail=message.slice(-128);
    const kinds=source==='connection'?['connection_closed']:[
      ...(/broken pipe|EPIPE/i.test(message)?['broken_pipe']:[]),
      ...(/(?:websocket.*(?:fallback|falling back))|(?:(?:fallback|falling back).*websocket)/i.test(message)?['websocket_fallback']:[]),
      ...(/timed? ?out|timeout/i.test(message)?['transport_timeout']:[])
    ];
    for(const kind of kinds){const key=`${source}:${kind}`,old=this.transport.get(key);this.transport.set(key,{kind,source,lastObservedAt:now,count:(old?.count??0)+1});}
    // 一条异常只作为线索，不让随后无关 stderr 重复计为异常。
    if(kinds.length&&source==='stderr')this.stderrTail='';
  }
  transportDiagnostics(){return [...this.transport.values()].map(value=>({...value,scope:'connection_or_unattributed',reviewProgressKnown:false}));}
}
