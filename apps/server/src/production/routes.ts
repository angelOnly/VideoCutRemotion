import Fastify from 'fastify';
import cors from '@fastify/cors';
import { promises as fs, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ProductionError, sha256, canonical } from '../../../../packages/production-service/src/contracts.js';
import { ProductionRepository } from '../../../../packages/production-service/src/repository.js';
import { ProductionRunner, type Executor } from '../../../../packages/production-service/src/runner.js';
import { CallbackSender } from '../../../../packages/production-service/src/callbacks.js';
import type { ProductionConfig } from '../../../../packages/production-service/src/config.js';
import { RunWork } from '../../../../packages/production-service/src/run-work.js';
import { verifySentenceAudio } from '../../../../packages/production-service/src/sentence-audio.js';
import { DoubaoService } from '../../../../packages/speech-services/src/doubao.js';
import { renderTemplate, renderToolSchema, templateFrames, previewFramesSchema, renderRequestIdSchema, retryRenderSlices, type MediaJob, type RenderOptions } from '../../../render-worker/src/template-renderer.js';
import { json, writeJson } from '../../../../packages/production-service/src/files.js';
import { normalizeWebAnalysis, normalizeWebRender } from '../../../../packages/production-service/src/web-contract.js';
import { createMediaMetricSink, withMediaSpan } from '../../../../packages/production-service/src/media-metrics.js';
export async function createProductionServer(config:ProductionConfig,executor?:Executor,overrides:Partial<{renderTemplate:typeof renderTemplate;templateFrames:typeof templateFrames;retryRenderSlices:typeof retryRenderSlices}>={}){
  const renderers={renderTemplate,templateFrames,retryRenderSlices,...overrides};
  const repo=new ProductionRepository(join(config.dataRoot,'tasks.sqlite')),runner=new ProductionRunner(repo,config,executor),callbacks=new CallbackSender(repo,config.callbackBase,config.callbackSecret);
  const speech=new DoubaoService(repo,config.dataRoot,config.voicesPath??'',process.env.DOUBAO_API_KEY??'',undefined,{concurrency:config.speechConcurrency??20,perRunConcurrency:config.speechPerRunConcurrency??5,signalFor:id=>runner.active.get(id)?.signal});
  await speech.recover();
  const app=Fastify({bodyLimit:2*1024*1024});await app.register(cors,{origin:true,exposedHeaders:['Content-Range','Content-Length','Accept-Ranges']});
  app.setErrorHandler((error:any,request,reply)=>{reply.code(error instanceof z.ZodError?400:error.statusCode??500).send({status:1,msg:error.message,error:{code:error instanceof z.ZodError?'INVALID_FIELDS':error.code??'INTERNAL_ERROR',fields:error instanceof z.ZodError?error.issues:undefined}});});
  app.addHook('preHandler',async(request,reply)=>{
    if(request.method==='OPTIONS'||request.url==='/healthz'||request.url.startsWith('/media/'))return;
    if(request.url.startsWith('/internal/tools/')){
      const runId=request.headers['x-run-id'],token=request.headers['x-run-token'];if(typeof runId!=='string'||typeof token!=='string')throw new ProductionError('RUN_AUTH_REQUIRED','需要执行身份',401);
      const run=repo.get(runId);if(run.token!==token||!['running','cancelling'].includes(run.state))throw new ProductionError('RUN_AUTH_INVALID','执行身份已失效',403);return;
    }
    // 旧网页服务没有令牌配置；只对白名单直连地址开放两阶段提交，管理接口仍需令牌。
    const webSubmit=request.method==='POST'&&['/narrate/ai_video_director/getAiVideoEditingAnalysisData','/narrate/ai_video_director/getAiVideoEditingData'].includes(request.url)&&config.webSubmitAddresses?.includes(request.ip.replace(/^::ffff:/,''));
    if(!webSubmit&&request.headers.authorization!==`Bearer ${config.apiToken}`)throw new ProductionError('UNAUTHORIZED','需要有效服务身份',401);
  });
  app.get('/healthz',async()=>({status:'ready',releaseId:config.release.releaseId,pluginVersion:config.release.pluginVersion,skillsDigest:config.release.skillsDigest,configurationReady:Object.values(config.ready).every(Boolean),productionReady:Object.values(config.ready).every(Boolean)?null:false,readinessScope:'configuration_only',dependencies:config.ready,capacity:{maxActiveRuns:config.maxActiveRuns??4,renderConcurrency:config.renderConcurrency??5,speechConcurrency:config.speechConcurrency??20,speechPerRunConcurrency:config.speechPerRunConcurrency??5,activeRuns:runner.active.size},capabilities:{localModels:false,networkSearch:config.searchEnabled,lexicalMechanisms:true}}));
  const accept=(stage:'analysis'|'render')=>async(request:any,reply:any)=>{if(runner.stopping)throw new ProductionError('STOPPING','服务正在停止受理',503);const input=stage==='analysis'?normalizeWebAnalysis(request.body):normalizeWebRender(request.body,repo.list(config.accountId,request.body?.taskId??''));const run=repo.accept(config.accountId,stage,input);return reply.code(202).send({status:0,msg:'已持久化受理',data:{taskId:run.taskId,requestId:run.requestId,runId:run.runId,stage,state:run.state,planVersion:run.planVersion}});};
  app.post('/narrate/ai_video_director/getAiVideoEditingAnalysisData',accept('analysis'));app.post('/narrate/ai_video_director/getAiVideoEditingData',accept('render'));
  app.get('/ai_video_director/tasks/:taskId',async(request:any)=>{const runs=repo.list(config.accountId,request.params.taskId);return {status:0,data:{latestSubmitted:runs.at(-1)?.runId,current:runs.find(r=>['running','unknown','recovering','cancelling'].includes(r.state))?.runId,latestSuccess:[...runs].reverse().find(r=>r.stage==='render'&&r.state==='succeeded')?.runId,runs:runs.map(r=>({...r,token:undefined,checkpoint:undefined,callback:repo.db.prepare('SELECT id,state,attempts,diagnostic FROM callback_outbox WHERE run_id=?').get(r.runId)}))}};});
  app.post('/ai_video_director/runs/:runId/cancel',async(request:any)=>{const run=repo.cancel(request.params.runId,config.accountId);runner.stopRun(run.runId);return {status:0,data:{runId:run.runId,state:run.state}};});
  app.post('/ai_video_director/callbacks/:eventId/retry',async(request:any)=>({status:0,data:callbacks.retry(request.params.eventId,config.accountId)}));
  app.route({method:['GET','HEAD'],url:'/media/:task/:run/:file',handler:async(request:any,reply)=>{
    const {task,run,file}=request.params;if(!z.string().uuid().safeParse(task).success||!z.string().uuid().safeParse(run).success||!/^\d+\.mp4$/.test(file))throw new ProductionError('MEDIA_NOT_FOUND','媒体不存在',404);
    const record=repo.get(run);if(record.taskKey!==task||record.state!=='succeeded')throw new ProductionError('MEDIA_NOT_FOUND','媒体尚未发布',404);
    const path=join(config.dataRoot,'tasks',task,'results',run,file),stat=await fs.stat(path);let start=0,end=stat.size-1;reply.header('Content-Type','video/mp4').header('Accept-Ranges','bytes');
    if(request.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range);if(!m||(!m[1]&&!m[2]))return reply.code(416).header('Content-Range',`bytes */${stat.size}`).send();
      if(!m[1])start=Math.max(0,stat.size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}if(start>end||start>=stat.size)return reply.code(416).header('Content-Range',`bytes */${stat.size}`).send();reply.code(206).header('Content-Range',`bytes ${start}-${end}/${stat.size}`);}
    reply.header('Content-Length',end-start+1);return request.method==='HEAD'?reply.send():reply.send(createReadStream(path,{start,end}));
  }});
  const rendering=new RunWork();let toolQueue:Promise<any>=Promise.resolve();
  const serial=<T>(work:()=>Promise<T>)=>{const next=toolQueue.then(work);toolQueue=next.catch(()=>{});return next;};
  runner.onRunStopping=id=>speech.cancelQueued(id);
  runner.settleTools=async(runId)=>{await toolQueue;await speech.drain(runId);await rendering.drain(runId);};
  const runnable=(id:string)=>{const run=repo.get(id);if(!runner.canStartWork(id)||run.state!=='running')throw new ProductionError('RUN_STOPPING','任务已停止接受新生成',409);return run;};
  // 只在入口短锁中登记；实际核验、绘图和编码始终属于本Run的工作生命周期。
  const startMedia=async(current:ReturnType<typeof repo.get>,path:string,job:MediaJob,resume:boolean)=>{
    if(rendering.current(current.runId))throw new ProductionError('RENDER_BUSY',`本视频正在处理 ${rendering.current(current.runId)}`,409);
    // 续切校验使用入口确认的失败记录；对外登记 running 不得抹去这份恢复依据。
    const retryJob=resume?structuredClone(job):undefined;
    let persisted!:()=>void,rejected!:(error:unknown)=>void;
    const registered=new Promise<void>((yes,no)=>{persisted=yes;rejected=no;});
    const work=rendering.start(current.runId,job.id,async()=>{
      job.state='running';delete job.error;
      try{await writeJson(path,job);persisted();}catch(error){rejected(error);throw error;}
      // renderFrames并发回调，单作业清单必须串行落盘，避免固定.tmp文件互相覆盖。
      let writes:Promise<unknown>=Promise.resolve();
      const persist=(change:()=>void)=>{const next=writes.then(async()=>{change();await writeJson(path,job);});writes=next.catch(()=>{});return next;};
      const root=runner.runRoot(current),signal=runner.active.get(current.runId)?.signal;
      const options:RenderOptions={dependencyRoot:config.dependencyRoot,browser:config.browser,concurrency:config.renderConcurrency??5,signal,sceneCutMode:job.sceneCutMode??'accurate',audioAudits:current.checkpoint.sentenceAudioAudits,
        metrics:{runId:current.runId,renderRequestId:job.id,sourceDigest:job.sourceDigest,signal,enabled:config.mediaTiming??true,activeMediaJobs:()=>rendering.size,onMetric:createMediaMetricSink(root)},
        onSourceFrozen:digest=>persist(()=>{job.sourceDigest=digest;}),
        onOutputStart:id=>persist(()=>{job.currentOutput=id;}),
        onFileReady:file=>persist(()=>{job.readyFiles=job.readyFiles.filter(f=>f.id!==file.id).concat(file);}),
        onFrameReady:frame=>persist(()=>{
          const requested='frames' in job.input?job.input.frames:[];
          job.readyFrames=job.readyFrames.filter(f=>f.frame!==frame.frame).concat(frame).sort((a,b)=>requested.indexOf(a.frame)-requested.indexOf(b.frame));
        })};
      try{
        const result=await withMediaSpan(options.metrics,resume?'media_job_resume':'media_job',async metrics=>{
          const scoped={...options,metrics};
          const result=retryJob?await renderers.retryRenderSlices(current,root,retryJob,scoped):job.kind==='frame-preview'
            ?await renderers.templateFrames(current,root,previewFramesSchema.parse(job.input),scoped)
            :await renderers.renderTemplate(current,root,renderToolSchema.parse(job.input),scoped);
          if(metrics)metrics.sourceDigest=job.sourceDigest;return result;
        });
        if(options.signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','本视频已取消');
        await persist(()=>Object.assign(job,{state:'succeeded',...result}));
      }catch(e){await persist(()=>{
        Object.assign(job,{state:options.signal?.aborted?'cancelled':'failed',error:String(e)});
        if('frames' in job.input)job.missingFrames=job.input.frames.filter(frame=>!job.readyFrames.some(f=>f.frame===frame));
      });}
      await writes;
    });void work.catch(()=>{});await registered;return job;
  };
  app.post('/internal/tools/:name',async(request:any)=>{
    const name=request.params.name,run=repo.get(request.headers['x-run-id']),body=request.body??{};if(body.runId&&body.runId!==run.runId)throw new ProductionError('RUN_SCOPE_INVALID','工具不能访问其他执行',403);
    if(name==='synthesize_speech'){runnable(run.runId);return speech.submit({...body,runId:run.runId},run.accountId);}
    if(name==='synthesize_speech_batch'){runnable(run.runId);return speech.submitBatch({...body,runId:run.runId},run.accountId);}
    if(name==='read_speech_job')return speech.read(body.speechJobId,run.runId,run.accountId);
    if(name==='read_speech_batch')return speech.readBatch(body.speechBatchRequestId,run.runId,run.accountId);
    if(name==='retry_speech_validation'){runnable(run.runId);return speech.retryValidation(body.speechJobId,run.runId,run.accountId);}
    if(name==='read_production_task')return {...run,token:undefined,activeRender:rendering.current(run.runId),qaRoot:join(runner.runRoot(run),'qa'),metricsPath:join(runner.runRoot(run),'metrics','media.jsonl'),optimization:{qaParallelReview:config.qaParallelReview??false,qaMaxReviewers:config.qaMaxReviewers??3,previewOnDemand:config.previewOnDemand??false,sceneCutMode:config.sceneCutMode??'accurate',mediaTiming:config.mediaTiming??true}};
    if(name==='verify_sentence_audio'){
      const current=runnable(run.runId);
      return rendering.start(run.runId,'sentence-audio-check',async()=>{
        const result=await verifySentenceAudio(current,runner.runRoot(current),body,speech,runner.active.get(run.runId)?.signal);
        const latest=repo.get(run.runId);
        repo.checkpoint(run.runId,current.token!,{sentenceAudioAudits:{...latest.checkpoint.sentenceAudioAudits,[result.sourceDigest]:{timelineSha256:result.timelineSha256}}});
        return result;
      });
    }
    if(name==='render_template'||name==='preview_template_frames')return serial(async()=>{
      const kind=name==='render_template'?'template-render':'frame-preview';
      const input=name==='render_template'?renderToolSchema.parse({...body,runId:run.runId}):previewFramesSchema.parse({...body,runId:run.runId});
      if(run.stage!=='render')throw new ProductionError('RENDER_STAGE_FORBIDDEN','Analysis 不允许渲染');
      const path=join(runner.runRoot(run),'render-jobs',`${input.renderRequestId}.json`),digest=sha256(canonical({kind,input}));
      const old=await json(path).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});
      if(old){
        if(old.kind!==kind||old.inputDigest!==digest)throw new ProductionError('RENDER_KEY_CONFLICT','同一编号的作业类型或输入不同',409);
        return old.state==='running'&&rendering.current(run.runId)!==old.id?{...old,state:'unknown',error:'原工作状态需要核查'}:old;
      }
      const current=runnable(run.runId);
      const job:MediaJob={id:input.renderRequestId,runId:run.runId,kind,state:'running',inputDigest:digest,input,sceneCutMode:config.sceneCutMode??'accurate',readyFiles:[],readyFrames:[]};
      return startMedia(current,path,job,false);
    });
    if(name==='retry_render_slices')return serial(async()=>{
      const {renderRequestId}=z.object({renderRequestId:renderRequestIdSchema}).strict().parse(body);
      const current=runnable(run.runId),path=join(runner.runRoot(run),'render-jobs',`${renderRequestId}.json`),job:MediaJob=await json(path);
      if(job.runId!==run.runId||job.kind!=='template-render'||!job.input||!('previewOnly' in job.input)||job.input.previewOnly)throw new ProductionError('SLICE_RETRY_FORBIDDEN','仅本Run原正式导出可以续切',409);
      if(job.inputDigest!==sha256(canonical({kind:job.kind,input:job.input})))throw new ProductionError('RENDER_KEY_CONFLICT','原作业输入摘要不符',409);
      if(job.state==='succeeded')return job;
      if(job.state==='running')return rendering.current(run.runId)===job.id?job:{...job,state:'unknown',error:'原工作状态需要核查，不能续切'};
      if(job.state!=='failed'||!job.sourceDigest||!job.readyFiles.some(f=>f.id==='whole-video'))throw new ProductionError('SLICE_RETRY_FORBIDDEN','须明确失败且原整片已核验，未知或取消作业不能续切',409);
      return startMedia(current,path,job,true);
    });
    if(name==='read_render_job'){
      const id=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(body.renderRequestId),path=join(runner.runRoot(run),'render-jobs',`${id}.json`);
      await toolQueue;const job=await json(path);
      if(job.state==='running'&&rendering.current(run.runId)!==id)return {...job,state:'unknown',error:'原渲染进程状态需要核查'};
      return job;
    }
    throw new ProductionError('TOOL_NOT_FOUND','制作工具不存在',404);
  });
  return {app,repo,runner,callbacks,speech,async close(){runner.stop();speech.stop();await runner.drain();await runner.settleTools();await app.close();repo.close();}};
}
