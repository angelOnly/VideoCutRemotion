import type {MediaSpanRecord} from './media-metrics.js';

export type TimedActivity={id:string;owner:string;activity:string;from:number;to:number;result:string;dependency?:string;sourceDigest?:string|null};
/** 媒体区间和真实宿主调用可重叠；未配对/没有时间戳的事件不能猜成推理或空等。 */
export function productionTiming(start:number,end:number,media:MediaSpanRecord[],events:any[]){
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw new Error('必须提供真实且递增的开始、结束时间');
  const activities:TimedActivity[]=[],diagnostics:string[]=[],pending=new Map<string,any>();
  for(const record of new Map(media.map(m=>[`${m.clock.processInstanceId}/${m.spanId}`,m])).values()){
    const from=Date.parse(record.startedAt),to=Date.parse(record.endedAt);
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<from){diagnostics.push(`媒体时间无效：${record.renderRequestId}/${record.spanId}`);continue;}
    activities.push({id:record.spanId,owner:`媒体:${record.renderRequestId}`,activity:record.stage,from,to,result:record.result,sourceDigest:record.sourceDigest});
  }
  let untimed=0;
  for(const event of events){
    const p=event.params,item=p?.item;
    if(!p?.threadId||!item?.id||!['item/started','item/completed'].includes(event.method)||!['mcpToolCall','commandExecution','collabAgentToolCall'].includes(item.type))continue;
    const key=`${p.threadId}/${item.id}`,time=Date.parse(event.recordedAt);
    if(!Number.isFinite(time)){untimed++;continue;}
    if(event.method==='item/started'){pending.set(key,{time,item,threadId:p.threadId});continue;}
    const before=pending.get(key);if(!before){diagnostics.push(`调用缺少开始事件：${key}`);continue;}pending.delete(key);
    if(time<before.time){diagnostics.push(`宿主时钟倒退：${key}`);continue;}
    const tool=item.tool??before.item.tool??item.type,args=item.arguments??before.item.arguments;
    // 只保留依赖编号，不输出命令正文、工具参数全文或凭据。
    const dependency=typeof args==='object'&&args?args.renderRequestId??args.reviewId:undefined;
    activities.push({id:key,owner:`代理:${p.threadId}`,activity:tool,from:before.time,to:time,result:item.error?'failed':item.status??'completed',...(typeof dependency==='string'?{dependency}:{})});
  }
  if(untimed)diagnostics.push(`${untimed} 条宿主边界缺少 recordedAt，保留未归因，不猜测时长`);
  for(const key of pending.keys())diagnostics.push(`调用没有结束证据：${key}，不据此认定一直运行`);
  const clipped=activities.filter(a=>a.to>start&&a.from<end).map(a=>({...a,from:Math.max(start,a.from),to:Math.min(end,a.to)}));
  const points=[...new Set([start,end,...clipped.flatMap(a=>[a.from,a.to])])].sort((a,b)=>a-b);
  const timeline=points.slice(0,-1).map((from,i)=>{
    const to=points[i+1],active=clipped.filter(a=>a.from<to&&a.to>from);
    return {from,to,durationMs:to-from,activities:active.map(a=>({id:a.id,owner:a.owner,activity:a.activity})),attribution:active.length?'已记录活动':'尚未归因'};
  });
  return {start,end,wallClockMs:end-start,unattributedMs:timeline.filter(t=>!t.activities.length).reduce((n,t)=>n+t.durationMs,0),timeline,activities:clipped,diagnostics,
    limitation:'全流程区间互不重叠；负责人活动允许并行，不能相加为总耗时。宿主事件时间是接收时间。缺少依赖完成证据时不能推断关键路径或空等。'};
}
