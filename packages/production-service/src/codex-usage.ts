type Usage={inputTokens:number;cachedInputTokens:number;outputTokens:number;totalTokens:number};
function usage(value:any):Usage|null{
  const keys=['inputTokens','cachedInputTokens','outputTokens','totalTokens'] as const;
  return value&&keys.every(key=>Number.isFinite(value[key])&&value[key]>=0)?Object.fromEntries(keys.map(key=>[key,value[key]])) as Usage:null;
}
/** 只记录宿主原始计数；累计快照不相加，重复 responseId 不重复计数。 */
export class CodexUsageObserver{
  private threads=new Map<string,{firstInputTokens:number|null;peakInputTokens:number|null;latestTotal:Usage|null;snapshots:Set<string>;responses:Map<string,Usage|null>}>();
  observe(event:any){
    const p=event?.params;
    if(!p?.threadId||!['thread/tokenUsage/updated','rawResponse/completed'].includes(event.method))return;
    let entry=this.threads.get(p.threadId);
    if(!entry){entry={firstInputTokens:null,peakInputTokens:null,latestTotal:null,snapshots:new Set(),responses:new Map()};this.threads.set(p.threadId,entry);}
    let last:Usage|null=null;
    if(event.method==='rawResponse/completed'&&typeof p.responseId==='string'){
      if(entry.responses.has(p.responseId))return;last=usage(p.usage);entry.responses.set(p.responseId,last);
    }else if(event.method==='thread/tokenUsage/updated'){
      const total=usage(p.tokenUsage?.total);last=usage(p.tokenUsage?.last);
      if(!total||!last)return;
      const key=JSON.stringify({total,last});if(entry.snapshots.has(key))return;
      entry.snapshots.add(key);entry.latestTotal=total;
    }
    if(last){entry.firstInputTokens??=last.inputTokens;entry.peakInputTokens=Math.max(entry.peakInputTokens??0,last.inputTokens);}
  }
  summary(rawEventsPath:string){
    return {schemaVersion:1,rawEventsPath,source:'宿主原始 tokenUsage 与 rawResponse 事件；未收到字段保留 null，不按字符估算',threads:[...this.threads].map(([threadId,entry])=>({threadId,firstInputTokens:entry.firstInputTokens,peakInputTokens:entry.peakInputTokens,cumulativeInputTokens:entry.latestTotal?.inputTokens??null,cumulativeCachedInputTokens:entry.latestTotal?.cachedInputTokens??null,cumulativeOutputTokens:entry.latestTotal?.outputTokens??null,responseCount:entry.responses.size||null,responseCountSource:entry.responses.size?'去重后的 rawResponse/completed':'未收到精确响应事件，不能用 usage 快照次数代替',usageSnapshots:entry.snapshots.size})),available:this.threads.size>0};
  }
}
