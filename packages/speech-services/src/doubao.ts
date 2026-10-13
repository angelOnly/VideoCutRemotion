import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonical, sha256, ProductionError, type Run } from '../../production-service/src/contracts.js';
import { json, writeJson, probe } from '../../production-service/src/files.js';
import type { ProductionRepository } from '../../production-service/src/repository.js';
export const speechSchema=z.object({runId:z.string().uuid(),speechRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),segmentId:z.string().min(1),text:z.string().min(1).max(2000),voiceRef:z.string().min(1),speed:z.number().int().min(-50).max(100).default(0),reuseJobId:z.string().uuid().optional(),reuseRunId:z.string().uuid().optional()}).strict();
export type SpeechInput=z.infer<typeof speechSchema>;
export class DoubaoService {
  private pending=new Map<string,Promise<void>>();
  constructor(private repo:ProductionRepository,private root:string,private voiceFile:string,private apiKey:string,private endpoint='https://openspeech.bytedance.com/api/v3/tts/unidirectional'){}
  private path(run:Run,id:string){return join(this.root,'tasks',run.taskKey,'runs',run.runId,'speech',`${id}.json`);}
  async submit(raw:unknown,accountId:string){
    const input=speechSchema.parse(raw),run=this.repo.get(input.runId,accountId);
    if(input.reuseRunId&&!input.reuseJobId)throw new ProductionError('REUSE_JOB_REQUIRED','复用执行引用必须同时指定配音任务');
    if(run.stage!=='render'||run.state!=='running')throw new ProductionError('SPEECH_STAGE_FORBIDDEN','仅运行中的 Render 可生成配音',409);
    if(!run.checkpoint.template?.manifest.voiceRefs.includes(input.voiceRef))throw new ProductionError('VOICE_NOT_DECLARED','模板未声明此音色引用');
    const voices=await json(this.voiceFile),voice=voices[input.voiceRef];if(!voice?.speaker)throw new ProductionError('VOICE_UNRESOLVED','部署未配置模板音色',503);
    const fingerprint=sha256(canonical({text:input.text,voice,speed:input.speed})),keyDigest=sha256(canonical(input));
    const old=run.checkpoint.speech?.[input.speechRequestId];if(old){if(old.keyDigest!==keyDigest)throw new ProductionError('SPEECH_KEY_CONFLICT','同一配音键不可更改输入',409);return this.read(old.id,run.runId,accountId);}
    const id=randomUUID(),path=this.path(run,id),audio=join(join(path,'..'),`${id}.mp3`);
    const record:any={id,runId:run.runId,request:input,fingerprint,providerRequestId:randomUUID(),state:'queued',audioRef:audio};
    if(input.reuseJobId){
      const baseId=input.reuseRunId??(run.request as any).baseRenderRunId;if(!baseId)throw new ProductionError('REUSE_BASE_REQUIRED','复用声音需要明确基础执行或成片');
      // 制作失败不抹掉已经确定成功的声音；跨 run 复用仍限定同账号、同任务。
      const base=this.repo.get(baseId,accountId);
      if(base.taskKey!==run.taskKey||base.stage!=='render')throw new ProductionError('SPEECH_REUSE_SCOPE_INVALID','基础声音必须来自同任务的 Render');
      const previous=await this.read(input.reuseJobId,baseId,accountId);
      if(previous.state!=='succeeded'||previous.fingerprint!==fingerprint||sha256(await fs.readFile(previous.audioRef))!==previous.sha256)throw new ProductionError('SPEECH_REUSE_INVALID','基础声音文字、音色、参数或文件不一致');
      await fs.mkdir(join(path,'..'),{recursive:true});await fs.copyFile(previous.audioRef,audio);Object.assign(record,{state:'succeeded',sha256:previous.sha256,duration:previous.duration,reusedFrom:previous.id,reusedFromRunId:baseId});
    }
    await writeJson(path,record);
    this.repo.checkpoint(run.runId,run.token!,{speech:{...this.repo.get(run.runId).checkpoint.speech,[input.speechRequestId]:{id,keyDigest}}});
    if(record.state==='queued'){const promise=this.execute(record,path,voice,run).finally(()=>this.pending.delete(id));this.pending.set(id,promise);}
    return record;
  }
  async read(id:string,runId:string,accountId:string){
    if(!z.string().uuid().safeParse(id).success)throw new ProductionError('SPEECH_ID_INVALID','配音 ID 不合法');const run=this.repo.get(runId,accountId);
    const record=await json(this.path(run,id));if(record.runId!==runId)throw new ProductionError('SPEECH_SCOPE_INVALID','配音不属于此执行');
    if(['running','queued'].includes(record.state)&&!this.pending.has(id)){record.state='unknown';record.diagnostic='服务重启后无法确认供应商结果；不自动重新请求';await writeJson(this.path(run,id),record);}return record;
  }
  async drain(){await Promise.allSettled(this.pending.values());}
  private async execute(record:any,path:string,voice:any,run:Run){
    try{
      if(this.repo.get(run.runId).state!=='running'){record.state='cancelled';return;}
      record.state='running';record.submittedAt=Date.now();await writeJson(path,record);
      // 请求前持久化供应商 ID；连接中断不重发，避免重复计费。
      const response=await fetch(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':this.apiKey,'X-Api-Resource-Id':voice.resourceId??'seed-tts-2.0','X-Api-Request-Id':record.providerRequestId},body:JSON.stringify({user:{uid:'textvideo-studio'},req_params:{text:record.request.text,speaker:voice.speaker,audio_params:{format:'mp3',sample_rate:24000,speech_rate:record.request.speed}}}),signal:AbortSignal.timeout(120000)});
      record.httpStatus=response.status;record.providerLogId=response.headers.get('x-tt-logid');
      if(!response.ok){record.state='failed';record.diagnostic=`供应商 HTTP ${response.status}`;return;}
      const raw=await response.text();record.responseDigest=sha256(raw);const events=parseJsonStream(raw);const audio:Buffer[]=[];let complete=false;
      for(const event of events){if(String(event.code)==='0'){if(event.data)audio.push(Buffer.from(event.data,'base64'));}else if(String(event.code)==='20000000')complete=true;else {record.state='failed';record.diagnostic=`供应商拒绝 ${event.code}：${event.message}`;return;}}
      if(!complete||!audio.length)throw new Error('供应商响应不完整');
      const bytes=Buffer.concat(audio),tmp=`${record.audioRef}.tmp.mp3`;await fs.writeFile(tmp,bytes);const measured=await probe(tmp,true);await fs.rename(tmp,record.audioRef);
      Object.assign(record,{state:'succeeded',sha256:sha256(bytes),duration:measured.duration,sampleRate:measured.streams[0]?.sample_rate,bytes:bytes.length,durationSource:'measured',alignment:'segment_exact'});
    }catch(e){record.state='unknown';record.diagnostic=String(e).replaceAll(this.apiKey,'[已隐藏]');}finally{await writeJson(path,record);}
  }
}
// 豆包连续 JSON 可能跨行或紧挨，不能直接按网络分块 JSON.parse。
export function parseJsonStream(raw:string):any[]{let depth=0,start=-1,string=false,escaped=false;const out:any[]=[];
  for(let i=0;i<raw.length;i++){const c=raw[i];if(string){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')string=false;continue;}if(c==='"'){string=true;continue;}if(c==='{'){if(depth++===0)start=i;}else if(c==='}'&&--depth===0){out.push(JSON.parse(raw.slice(start,i+1)));start=-1;}else if(depth===0&&!/\s/.test(c))throw new Error('供应商响应包含非 JSON 数据');}
  if(depth!==0||string)throw new Error('供应商响应截断');return out;
}
