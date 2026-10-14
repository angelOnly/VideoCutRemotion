import { createHmac } from 'node:crypto';
import type { ProductionRepository } from './repository.js';
export const signCallback=(secret:string,timestamp:string,body:string)=>createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
export class CallbackSender {
  private sending?:Promise<void>;
  constructor(private repo:ProductionRepository,private baseUrl:string,private secret:string,private options={maxAttempts:10,timeoutMs:15000,baseDelayMs:1000}){}
  tick(){
    // 定时器再次触发时继续等原批次，避免同一进程并发投递同一个事件。
    if(!this.sending)this.sending=this.sendPending().finally(()=>{this.sending=undefined;});
    return this.sending;
  }
  private async sendPending(){
    const rows=this.repo.db.prepare("SELECT * FROM callback_outbox WHERE state IN ('pending','retrying') AND next_at<=? ORDER BY next_at LIMIT 10").all(Date.now()) as any[];
    for(const event of rows){let state='retrying',diagnostic=''; const timestamp=String(Math.floor(Date.now()/1000));
      try{const run=this.repo.get(event.run_id),suffix=run.stage==='analysis'?'getAiVideoEditingAnalysisDataCallback':'getAiVideoEditingDataCallback';
        const r=await fetch(`${this.baseUrl.replace(/\/$/,'')}/ai_video_director/${suffix}`,{method:'POST',body:event.body,headers:{'Content-Type':'application/json','X-Event-Id':event.id,'X-Callback-Timestamp':timestamp,'X-Callback-Signature':signCallback(this.secret,timestamp,event.body)},signal:AbortSignal.timeout(this.options.timeoutMs),redirect:'error'});
        const body=await r.text();diagnostic=`HTTP ${r.status} ${body.slice(0,2000)}`;
        if(r.ok){try{const data=JSON.parse(body);if(data&&typeof data==='object'&&!Array.isArray(data)){if(data.status===0)state='delivered';else if(Object.hasOwn(data,'status'))state='dead_letter';}}catch{}}
        else if(r.status<500&&r.status!==429)state='dead_letter';
      }catch(e){diagnostic=String(e);}
      const attempts=event.attempts+1;if(state==='retrying'&&attempts>=this.options.maxAttempts)state='dead_letter';
      this.repo.db.prepare('UPDATE callback_outbox SET state=?,attempts=?,next_at=?,diagnostic=? WHERE id=?').run(state,attempts,Date.now()+Math.min(60000,this.options.baseDelayMs*2**(attempts-1)),diagnostic,event.id);
    }
  }
  retry(eventId:string,accountId:string){const e=this.repo.db.prepare('SELECT * FROM callback_outbox WHERE id=?').get(eventId) as any;if(!e)throw new Error('回调事件不存在');this.repo.get(e.run_id,accountId);this.repo.db.prepare("UPDATE callback_outbox SET state='pending',attempts=0,next_at=0 WHERE id=?").run(eventId);return {eventId};}
}
