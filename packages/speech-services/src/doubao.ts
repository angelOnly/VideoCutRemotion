import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonical, sha256, ProductionError, type Run } from '../../production-service/src/contracts.js';
import { json, writeJson, probe, decodedAudioSeconds } from '../../production-service/src/files.js';
import type { ProductionRepository } from '../../production-service/src/repository.js';
const requestKey=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const speechSchema=z.object({runId:z.string().uuid(),speechRequestId:requestKey,segmentId:z.string().min(1),sceneId:z.string().min(1).optional(),text:z.string().min(1).max(2000),voiceRef:z.string().min(1),speed:z.number().int().min(-50).max(100).default(0),reuseJobId:z.string().uuid().optional(),reuseRunId:z.string().uuid().optional()}).strict();
export const speechBatchSchema=z.object({runId:z.string().uuid(),speechBatchRequestId:requestKey,segments:z.array(speechSchema.omit({runId:true}).extend({sceneId:z.string().min(1)})).min(1).max(1000)}).strict();
export type SpeechInput=z.infer<typeof speechSchema>;
type Work={record:any;path:string;voice:any;run:Run;promise:Promise<void>;done:()=>void;localOnly?:boolean};
type SpeechOptions={concurrency?:number;perRunConcurrency?:number;signalFor?:(runId:string)=>AbortSignal|undefined};
export class DoubaoService {
  private pending=new Map<string,Work>();
  private queues=new Map<string,Work[]>();
  private order:string[]=[];
  private active=new Map<string,number>();
  private unknown=new Map<string,string>();
  private registration:Promise<unknown>=Promise.resolve();
  private scheduled=false;
  private stopping=false;
  private stoppedRuns=new Set<string>();
  private total:number;
  private perRun:number;
  constructor(private repo:ProductionRepository,private root:string,private voiceFile:string,private apiKey:string,private endpoint='https://openspeech.bytedance.com/api/v3/tts/unidirectional',private options:SpeechOptions={}){
    this.total=options.concurrency??20;this.perRun=options.perRunConcurrency??5;
    if(!Number.isInteger(this.total)||this.total<1||this.total>20||!Number.isInteger(this.perRun)||this.perRun<1||this.perRun>5||this.perRun>this.total)throw new ProductionError('CONFIG_INVALID','配音并发配置无效');
  }
  private path(run:Run,id:string){return join(this.root,'tasks',run.taskKey,'runs',run.runId,'speech',`${id}.json`);}
  private batchPath(run:Run,id:string){return join(this.root,'tasks',run.taskKey,'runs',run.runId,'speech-batches',`${requestKey.parse(id)}.json`);}
  private serial<T>(operation:()=>Promise<T>):Promise<T>{const next=this.registration.then(operation);this.registration=next.catch(()=>{});return next;}
  private runnable(run:Run){if(this.stopping||this.stoppedRuns.has(run.runId)||run.stage!=='render'||run.state!=='running')throw new ProductionError('SPEECH_STAGE_FORBIDDEN','仅运行中的 Render 可生成配音',409);}
  private async validate(input:SpeechInput,accountId:string){
    const run=this.repo.get(input.runId,accountId);this.runnable(run);
    if(input.reuseRunId&&!input.reuseJobId)throw new ProductionError('REUSE_JOB_REQUIRED','复用执行引用必须同时指定配音任务');
    if(input.sceneId&&!(run.request as any).dataList.some((s:any)=>s.id===input.sceneId))throw new ProductionError('SPEECH_SCENE_INVALID','句段所属分镜不在当前确认稿中');
    if(!run.checkpoint.template?.manifest.voiceRefs.includes(input.voiceRef))throw new ProductionError('VOICE_NOT_DECLARED','模板未声明此音色引用');
    const voices=await json(this.voiceFile),voice=voices[input.voiceRef];if(!voice?.speaker)throw new ProductionError('VOICE_UNRESOLVED','部署未配置模板音色',503);
    const fingerprint=sha256(canonical({text:input.text,voice,speed:input.speed})),keyDigest=sha256(canonical(input));
    const old=run.checkpoint.speech?.[input.speechRequestId];
    if(old&&old.keyDigest!==keyDigest)throw new ProductionError('SPEECH_KEY_CONFLICT','同一配音键不可更改输入',409);
    let previous:any,baseId:string|undefined;
    if(input.reuseJobId&&!old){
      baseId=input.reuseRunId??(run.request as any).baseRenderRunId;if(!baseId)throw new ProductionError('REUSE_BASE_REQUIRED','复用声音需要明确基础执行或成片');
      const base=this.repo.get(baseId,accountId);
      if(base.taskKey!==run.taskKey||base.stage!=='render')throw new ProductionError('SPEECH_REUSE_SCOPE_INVALID','基础声音必须来自同任务的 Render');
      previous=await this.read(input.reuseJobId,baseId,accountId);
      if(previous.state!=='succeeded'||previous.fingerprint!==fingerprint||sha256(await fs.readFile(previous.audioRef))!==previous.sha256)throw new ProductionError('SPEECH_REUSE_INVALID','基础声音文字、音色、参数或文件不一致');
    }
    return {input,run,voice,fingerprint,keyDigest,previous,baseId};
  }
  private async register(prepared:Awaited<ReturnType<DoubaoService['validate']>>){
    const {input,voice,fingerprint,keyDigest,previous,baseId}=prepared,run=this.repo.get(input.runId);this.runnable(run);
    const old=run.checkpoint.speech?.[input.speechRequestId];
    if(old)return {record:await this.read(old.id,run.runId,run.accountId),voice,run,path:this.path(run,old.id)};
    const id=randomUUID(),path=this.path(run,id),audio=join(path,'..',`${id}.mp3`);
    const record:any={id,runId:run.runId,request:input,fingerprint,providerRequestId:randomUUID(),state:'queued',audioRef:audio};
    if(previous){await fs.mkdir(join(path,'..'),{recursive:true});await fs.copyFile(previous.audioRef,audio);Object.assign(record,{state:'succeeded',sha256:previous.sha256,duration:previous.duration,durationSource:'measured',alignment:'segment_exact',reusedFrom:previous.id,reusedFromRunId:baseId});}
    await writeJson(path,record);
    this.repo.checkpoint(run.runId,run.token!,{speech:{...this.repo.get(run.runId).checkpoint.speech,[input.speechRequestId]:{id,keyDigest}}});
    return {record,voice,run,path};
  }
  async submit(raw:unknown,accountId:string){return this.serial(async()=>{
    const prepared=await this.validate(speechSchema.parse(raw),accountId),work=await this.register(prepared);this.enqueue(work);return work.record;
  });}
  async submitBatch(raw:unknown,accountId:string){return this.serial(async()=>{
    const input=speechBatchSchema.parse(raw),run=this.repo.get(input.runId,accountId);this.runnable(run);
    if(new Set(input.segments.map(s=>s.segmentId)).size!==input.segments.length||new Set(input.segments.map(s=>s.speechRequestId)).size!==input.segments.length)throw new ProductionError('SPEECH_BATCH_DUPLICATE','批次中句段编号和请求编号不能重复');
    const path=this.batchPath(run,input.speechBatchRequestId),digest=sha256(canonical(input));
    const old=await json(path).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});
    if(old&&old.inputDigest!==digest)throw new ProductionError('SPEECH_BATCH_CONFLICT','同一批次编号不可更改输入',409);
    // 整批先校验、登记，最后统一放行；登记中断后沿原句段键续接。
    const prepared=[];for(const item of input.segments)prepared.push(await this.validate({...item,runId:run.runId},accountId));
    const batch=old??{id:input.speechBatchRequestId,runId:run.runId,inputDigest:digest,state:'registering',jobIds:[]};
    if(!old)await writeJson(path,batch);
    const works=[];for(const item of prepared)works.push(await this.register(item));
    this.runnable(this.repo.get(run.runId));
    Object.assign(batch,{state:'registered',jobIds:works.map(w=>w.record.id)});await writeJson(path,batch);
    for(const work of works)this.enqueue(work);
    return this.readBatch(batch.id,run.runId,accountId);
  });}
  async readBatch(id:string,runId:string,accountId:string){
    const run=this.repo.get(runId,accountId),batch=await json(this.batchPath(run,id));if(batch.runId!==runId)throw new ProductionError('SPEECH_SCOPE_INVALID','批次不属于此执行');
    const jobs=[];for(const jobId of batch.jobIds)jobs.push(await this.read(jobId,runId,accountId));
    const counts:Record<string,number>={};for(const job of jobs)counts[job.state]=(counts[job.state]??0)+1;
    const state=batch.state==='registering'?'registering':jobs.every(j=>j.state==='succeeded')?'succeeded':jobs.some(j=>['queued','running','validating'].includes(j.state))?'running':counts.unknown?'unknown':counts.succeeded?'partial':counts.cancelled===jobs.length?'cancelled':'failed';
    return {id,runId,state,total:jobs.length,counts,jobs,unknownReservations:this.unknown.size};
  }
  async read(id:string,runId:string,accountId:string){
    if(!z.string().uuid().safeParse(id).success)throw new ProductionError('SPEECH_ID_INVALID','配音 ID 不合法');const run=this.repo.get(runId,accountId);
    const record=await json(this.path(run,id));if(record.runId!==runId)throw new ProductionError('SPEECH_SCOPE_INVALID','配音不属于此执行');
    if(['running','validating'].includes(record.state)&&!this.pending.has(id)){
      record.state=record.providerComplete?'validation_failed':'unknown';record.diagnostic='原执行中断，保留已有音频及请求编号，不自动重新请求';await writeJson(this.path(run,id),record);
    }
    if(record.state==='unknown'&&record.submittedAt&&!record.providerComplete)this.unknown.set(id,runId);
    return record;
  }
  async recover(){
    // 未知请求跨重启保留额度，防止丢失本地连接后继续无上限补发。
    const rows=this.repo.db.prepare('SELECT id FROM runs').all() as {id:string}[];
    for(const row of rows){const run=this.repo.get(row.id);for(const entry of Object.values(run.checkpoint.speech??{}) as any[])await this.read(entry.id,run.runId,run.accountId);}
  }
  private enqueue(item:Omit<Work,'promise'|'done'>){
    if(this.pending.has(item.record.id)||item.record.state!=='queued'&&!item.localOnly)return;
    let done!:()=>void;const promise=new Promise<void>(resolve=>{done=resolve;}),work={...item,promise,done};this.pending.set(work.record.id,work);
    if(!this.queues.has(work.run.runId)){this.queues.set(work.run.runId,[]);this.order.push(work.run.runId);}
    this.queues.get(work.run.runId)!.push(work);if(this.stopping||this.stoppedRuns.has(work.run.runId))this.cancelQueued(work.run.runId);else this.schedule();
  }
  private schedule(){if(this.scheduled)return;this.scheduled=true;setImmediate(()=>{this.scheduled=false;this.pump();});}
  private pump(){
    if(this.stopping)return;
    while([...this.active.values()].reduce((a,b)=>a+b,0)+this.unknown.size<this.total){
      let selected:Work|undefined;
      for(let i=0,n=this.order.length;i<n;i++){
        const id=this.order.shift()!;this.order.push(id);
        const reserved=[...this.unknown.values()].filter(r=>r===id).length;
        if((this.active.get(id)??0)+reserved>=this.perRun)continue;
        selected=this.queues.get(id)?.shift();
        if(!this.queues.get(id)?.length){this.queues.delete(id);this.order=this.order.filter(runId=>runId!==id);}
        if(selected)break;
      }
      if(!selected)return;
      const work=selected,id=work.run.runId;this.active.set(id,(this.active.get(id)??0)+1);
      void this.execute(work).catch(error=>{work.record.state=work.record.providerComplete?'validation_failed':work.record.submittedAt?'unknown':'failed';work.record.diagnostic=String(error);}).finally(()=>{
        if(work.record.state==='unknown'&&work.record.submittedAt&&!work.record.providerComplete)this.unknown.set(work.record.id,id);
        const remaining=(this.active.get(id)??1)-1;if(remaining)this.active.set(id,remaining);else this.active.delete(id);
        this.pending.delete(work.record.id);work.done();this.schedule();
      });
    }
  }
  async drain(runId?:string){await this.registration;while(true){const works=[...this.pending.values()].filter(w=>!runId||w.run.runId===runId);if(!works.length)return;await Promise.all(works.map(w=>w.promise));}}
  cancelQueued(runId:string){
    this.stoppedRuns.add(runId);const queue=this.queues.get(runId)??[];this.queues.delete(runId);this.order=this.order.filter(id=>id!==runId);
    for(const work of queue){work.record.state='cancelled';void writeJson(work.path,work.record).catch(e=>{work.record.diagnostic=String(e);}).finally(()=>{this.pending.delete(work.record.id);work.done();});}
  }
  stop(){this.stopping=true;for(const id of [...this.queues.keys()])this.cancelQueued(id);}
  async retryValidation(id:string,runId:string,accountId:string){return this.serial(async()=>{
    const run=this.repo.get(runId,accountId);this.runnable(run);const record=await this.read(id,runId,accountId);
    if(record.state!=='validation_failed'||!record.providerComplete)throw new ProductionError('SPEECH_VALIDATION_STATE','只能恢复已取得音频的本地检查');
    if(this.pending.has(id))throw new ProductionError('SPEECH_VALIDATION_BUSY','原检查正在收尾，请查询原任务后再恢复',409);
    record.state='validating';await writeJson(this.path(run,id),record);this.enqueue({record,path:this.path(run,id),voice:null,run,localOnly:true});
    return record;
  });}
  private async validateAudio(record:any){
    let path=record.receivedAudioRef??`${record.audioRef}.tmp.mp3`;
    // 文件已改名但状态尚未落盘时，也沿原摘要恢复，不再次请求供应商。
    if(!(await fs.stat(path).catch(()=>null)))path=record.audioRef;
    const bytes=await fs.readFile(path);if(record.receivedSha256&&sha256(bytes)!==record.receivedSha256)throw new ProductionError('AUDIO_CHANGED','已收到音频摘要发生变化');
    const signal=this.options.signalFor?.(record.runId),measured=await probe(path,false,signal);
    if(!measured.streams.some((s:any)=>s.codec_type==='audio'))throw new ProductionError('MEDIA_INVALID','配音文件没有音轨');
    // 时间轴使用真实解码采样长度，避免 MP3 容器填充造成句段累计偏移。
    const duration=await decodedAudioSeconds(path,signal);
    if(path!==record.audioRef)await fs.rename(path,record.audioRef);
    Object.assign(record,{state:'succeeded',sha256:sha256(bytes),duration,containerDuration:measured.duration,sampleRate:measured.streams.find((s:any)=>s.codec_type==='audio')?.sample_rate,bytes:bytes.length,durationSource:'measured',alignment:'segment_exact'});
  }
  private async execute(work:Work){
    const {record,path,voice,run}=work;
    try{
      if(this.stopping||this.stoppedRuns.has(run.runId)||this.repo.get(run.runId).state!=='running'){record.state='cancelled';return;}
      if(!work.localOnly){
        record.state='running';record.submittedAt=Date.now();await writeJson(path,record);
        // 请求前持久化原编号；连接中断不重发，取消也不能撤销云端收费。
        const response=await fetch(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':this.apiKey,'X-Api-Resource-Id':voice.resourceId??'seed-tts-2.0','X-Api-Request-Id':record.providerRequestId},body:JSON.stringify({user:{uid:'textvideo-studio'},req_params:{text:record.request.text,speaker:voice.speaker,audio_params:{format:'mp3',sample_rate:24000,speech_rate:record.request.speed}}}),signal:AbortSignal.timeout(120000)});
        record.httpStatus=response.status;record.providerLogId=response.headers.get('x-tt-logid');
        if(!response.ok){record.state=response.status>=500?'unknown':'failed';record.diagnostic=`供应商 HTTP ${response.status}`;return;}
        const raw=await response.text();record.responseDigest=sha256(raw);const events=parseJsonStream(raw);const audio:Buffer[]=[];let complete=false;
        for(const event of events){if(String(event.code)==='0'){if(event.data)audio.push(Buffer.from(event.data,'base64'));}else if(String(event.code)==='20000000')complete=true;else {record.state='failed';record.diagnostic=`供应商拒绝 ${event.code}：${event.message}`;return;}}
        if(!complete||!audio.length)throw new Error('供应商响应不完整');
        const bytes=Buffer.concat(audio);record.providerComplete=true;record.receivedAudioRef=`${record.audioRef}.tmp.mp3`;record.receivedSha256=sha256(bytes);
        await fs.writeFile(record.receivedAudioRef,bytes);record.state='validating';await writeJson(path,record);
      }
      await this.validateAudio(record);
    }catch(e){record.state=record.providerComplete?'validation_failed':'unknown';record.diagnostic=this.apiKey?String(e).replaceAll(this.apiKey,'[已隐藏]'):String(e);}
    finally{await writeJson(path,record);}
  }
}
// 豆包连续 JSON 可能跨行或紧挨，不能直接按网络分块 JSON.parse。
export function parseJsonStream(raw:string):any[]{let depth=0,start=-1,string=false,escaped=false;const out:any[]=[];
  for(let i=0;i<raw.length;i++){const c=raw[i];if(string){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')string=false;continue;}if(c==='"'){string=true;continue;}if(c==='{'){if(depth++===0)start=i;}else if(c==='}'&&--depth===0){out.push(JSON.parse(raw.slice(start,i+1)));start=-1;}else if(depth===0&&!/\s/.test(c))throw new Error('供应商响应包含非 JSON 数据');}
  if(depth!==0||string)throw new Error('供应商响应截断');return out;
}
