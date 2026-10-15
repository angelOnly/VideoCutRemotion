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
import { RunWork, MediaBudget, MediaJobEvents } from '../../../../packages/production-service/src/run-work.js';
import { assembleSentenceAudio } from '../../../../packages/production-service/src/sentence-audio-assembly.js';
import { verifySentenceAudio } from '../../../../packages/production-service/src/sentence-audio.js';
import { DoubaoService } from '../../../../packages/speech-services/src/doubao.js';
import { renderTemplate, renderToolSchema, templateFrames, previewFramesSchema, frameBatchSchema, renderRequestIdSchema, retryRenderSlices, type MediaJob, type RenderOptions } from '../../../render-worker/src/template-renderer.js';
import { json, writeJson, treeDigest, regular } from '../../../../packages/production-service/src/files.js';
import { normalizeWebAnalysis, normalizeWebRender } from '../../../../packages/production-service/src/web-contract.js';
import { createMediaMetricSink, withMediaSpan } from '../../../../packages/production-service/src/media-metrics.js';
import { mediaJobSummary, speechBatchSummary, productionTaskSummary, reviewResultSummary } from '../../../../packages/production-service/src/tool-results.js';
import { ReviewService, prepareReviewSchema, readReviewSchema } from '../../../../packages/production-service/src/review-service.js';
import { reviewFramesInput } from '../../../../packages/production-service/src/review-frame-plan.js';
export async function createProductionServer(config:ProductionConfig,executor?:Executor,overrides:Partial<{renderTemplate:typeof renderTemplate;templateFrames:typeof templateFrames;retryRenderSlices:typeof retryRenderSlices}>={}){
  const renderers={renderTemplate,templateFrames,retryRenderSlices,...overrides};
  const repo=new ProductionRepository(join(config.dataRoot,'tasks.sqlite')),runner=new ProductionRunner(repo,config,executor),callbacks=new CallbackSender(repo,config.callbackBase,config.callbackSecret);
  const reviews=new ReviewService(repo,run=>runner.runRoot(run));
  const speech=new DoubaoService(repo,config.dataRoot,config.voicesPath??'',process.env.DOUBAO_API_KEY??'',undefined,{concurrency:config.speechConcurrency??20,perRunConcurrency:config.speechPerRunConcurrency??5,signalFor:id=>runner.active.get(id)?.signal});
  await speech.recover();
  const app=Fastify({bodyLimit:2*1024*1024});await app.register(cors,{origin:true,exposedHeaders:['Content-Range','Content-Length','Accept-Ranges']});
  app.setErrorHandler((error:any,request,reply)=>{reply.code(error instanceof z.ZodError?400:error.statusCode??500).send({status:1,msg:error.message,error:{code:error instanceof z.ZodError?'INVALID_FIELDS':error.code??'INTERNAL_ERROR',fields:error instanceof z.ZodError?error.issues:undefined}});});
  app.addHook('preHandler',async(request,reply)=>{
    if(request.method==='OPTIONS'||request.url==='/healthz'||request.url.startsWith('/media/'))return;
    if(request.url.startsWith('/internal/tools/')){
      const runId=request.headers['x-run-id'],token=request.headers['x-run-token'];if(typeof runId!=='string'||typeof token!=='string')throw new ProductionError('RUN_AUTH_REQUIRED','需要执行身份',401);
      const run=repo.get(runId);if(run.token!==token||!['running','cancelling'].includes(run.state))throw new ProductionError('RUN_AUTH_INVALID','执行身份已失效',403);
      if(run.checkpoint.release?.releaseId&&run.checkpoint.release.releaseId!==config.release.releaseId)throw new ProductionError('RUN_RELEASE_MISMATCH','原任务必须使用固定发行，不得跨版混用工具',409);return;
    }
    // 旧网页服务没有令牌配置；只对白名单直连地址开放两阶段提交，管理接口仍需令牌。
    const webSubmit=request.method==='POST'&&['/narrate/ai_video_director/getAiVideoEditingAnalysisData','/narrate/ai_video_director/getAiVideoEditingData'].includes(request.url)&&config.webSubmitAddresses?.includes(request.ip.replace(/^::ffff:/,''));
    if(!webSubmit&&request.headers.authorization!==`Bearer ${config.apiToken}`)throw new ProductionError('UNAUTHORIZED','需要有效服务身份',401);
  });
  app.get('/healthz',async()=>({status:'ready',releaseId:config.release.releaseId,pluginVersion:config.release.pluginVersion,skillsDigest:config.release.skillsDigest,configurationReady:Object.values(config.ready).every(Boolean),productionReady:Object.values(config.ready).every(Boolean)?null:false,readinessScope:'configuration_only',dependencies:config.ready,capacity:{maxActiveRuns:config.maxActiveRuns??4,renderConcurrency:config.renderConcurrency??4,mediaGlobalConcurrency:config.mediaGlobalConcurrency??16,mediaRunConcurrency:config.mediaRunConcurrency??2,mediaProcessConcurrency:config.mediaProcessConcurrency??4,speechConcurrency:config.speechConcurrency??20,speechPerRunConcurrency:config.speechPerRunConcurrency??5,activeRuns:runner.active.size},optimization:{renderStrategy:config.renderStrategy??'scene-chunks',qaParallelReview:config.qaParallelReview??true,previewOnDemand:config.previewOnDemand??true},capabilities:{localModels:false,networkSearch:config.searchEnabled,lexicalMechanisms:true,reviewProtocol:5,runtimeWait:true,sentenceAssembly:true,timelineContract:'sentence-timeline/1',derivedRenderRanges:true,directDelivery:true,reviewStorage:'sqlite',reviewIdentity:'coordinator_reported',reviewOrchestration:'codex_native',reviewFramePreparation:true,reviewSummary:true,reviewReportFiles:true,templateTimelineValidation:true}}));
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
  const frameJobs=new Set<string>();
  const rendering=new RunWork(),budget=new MediaBudget(config.mediaGlobalConcurrency??16,config.mediaProcessConcurrency??4),events=new MediaJobEvents();let toolQueue:Promise<any>=Promise.resolve();
  runner.mediaRuntime={events,read:async(run,id)=>{
    renderRequestIdSchema.parse(id);const job=await json(await regular(runner.runRoot(run),join('render-jobs',`${id}.json`)));
    if(job.id!==id||job.runId!==run.runId||job.kind!=='template-render'||job.input.previewOnly)throw new ProductionError('WAIT_JOB_INVALID','只允许等待当前 Run 已受理的原正式导出');
    if(job.inputDigest!==sha256(canonical({kind:job.kind,input:job.input})))throw new ProductionError('WAIT_JOB_CHANGED','原媒体作业身份摘要不符');
    return {...job,attempt:job.attempt??1,...(job.state==='running'&&rendering.current(run.runId)!==id?{state:'unknown' as const,error:'无法确认原媒体执行状态，请核查原作业'}:{})};
  }};
  const serial=<T>(work:()=>Promise<T>)=>{const next=toolQueue.then(work);toolQueue=next.catch(()=>{});return next;};
  runner.onRunStopping=id=>{speech.cancelQueued(id);};
  runner.settleTools=async(runId)=>{await toolQueue;await speech.drain(runId);await rendering.drain(runId);};
  const runnable=(id:string)=>{const run=repo.get(id);if(!runner.canStartWork(id)||run.state!=='running')throw new ProductionError('RUN_STOPPING','任务已停止接受新生成',409);return run;};
  // 媒体成功与材料登记分别记账；登记失败只恢复本步骤，不重新冻结或绘图。
  const registerReview=async(current:ReturnType<typeof repo.get>,job:MediaJob,persist:(change:()=>void)=>Promise<unknown>)=>{
    if(!('reviewPlan' in job.input))return;
    const signal=runner.active.get(current.runId)?.signal;
    await persist(()=>{job.reviewPreparation={state:'running'};});
    try{
      const result=await withMediaSpan({runId:current.runId,renderRequestId:job.id,sourceDigest:job.sourceDigest,signal,enabled:config.mediaTiming??true,onMetric:createMediaMetricSink(runner.runRoot(current))},'review_registration',()=>reviews.prepare(current,('reviewPlan' in job.input)?job.input.reviewPlan:undefined,{signal}));
      if(!result.reviewId)throw new ProductionError('REVIEW_PREPARATION_INCOMPLETE','媒体未能登记为完整检查材料');
      await persist(()=>{job.reviewPreparation={state:'succeeded',reviewId:result.reviewId};});
    }catch(error:any){await persist(()=>{job.reviewPreparation={state:signal?.aborted||repo.get(current.runId).state!=='running'?'cancelled':'failed',error:String(error),errorCode:error.code??'REVIEW_PREPARATION_FAILED'};});}
  };
  const observedJob=(runId:string,job:MediaJob)=>{
    if(rendering.has(runId,job.id))return job;
    if(['running','queued'].includes(job.state))return {...job,state:'unknown',error:'原工作状态需要核查'};
    if(job.state==='succeeded'&&job.reviewPreparation&&['pending','running'].includes(job.reviewPreparation.state))return {...job,reviewPreparation:{...job.reviewPreparation,state:'unknown',error:'媒体已完成，材料登记结果待核查；可沿原编号恢复幂等登记'}};
    return job;
  };
  // 只在入口短锁中登记；实际核验、绘图和编码始终属于本Run的工作生命周期。
  const startMedia=async(current:ReturnType<typeof repo.get>,path:string,job:MediaJob,resume:boolean)=>{
    const active=rendering.current(current.runId);
    if(active&&!(job.kind==='frame-preview'&&frameJobs.has(`${current.runId}:${active}`)))throw new ProductionError('RENDER_BUSY',`本视频正在处理 ${active}`,409);
    // 续切校验使用入口确认的失败记录；对外登记 running 不得抹去这份恢复依据。
    const retryJob=resume?structuredClone(job):undefined;
    job.attempt=resume?(job.attempt??1)+1:job.attempt??1;
    job.state=active?'queued':'running';delete job.error;
    const registration=writeJson(path,job);
    let began!:()=>void,beginFailed!:(error:unknown)=>void;
    const started=new Promise<void>((yes,no)=>{began=yes;beginFailed=no;});void started.catch(()=>{});
    if(job.kind==='frame-preview')frameJobs.add(`${current.runId}:${job.id}`);
    const start=job.kind==='frame-preview'?rendering.enqueue.bind(rendering):rendering.start.bind(rendering);
    const work=start(current.runId,job.id,async()=>{
      try{await registration;job.state='running';delete job.error;await writeJson(path,job);began();events.notify(`${current.runId}:${job.id}`);}catch(error){beginFailed(error);throw error;}
      // renderFrames并发回调，单作业清单必须串行落盘，避免固定.tmp文件互相覆盖。
      let writes:Promise<unknown>=Promise.resolve();
      const persist=(change:()=>void)=>{const next=writes.then(async()=>{change();await writeJson(path,job);events.notify(path);events.notify(`${current.runId}:${job.id}`);});writes=next.catch(()=>{});return next;};
      const root=runner.runRoot(current),signal=runner.active.get(current.runId)?.signal;
      const options:RenderOptions={dependencyRoot:config.dependencyRoot,releaseId:config.release.releaseId,browser:config.browser,concurrency:job.concurrency??config.renderConcurrency??4,runConcurrency:job.runConcurrency??config.mediaRunConcurrency??2,renderStrategy:job.renderStrategy??'whole-slices',budget,signal,sceneCutMode:job.sceneCutMode??'accurate',audioAudits:current.checkpoint.sentenceAudioAudits,
        metrics:{runId:current.runId,renderRequestId:job.id,sourceDigest:job.sourceDigest,signal,enabled:config.mediaTiming??true,activeMediaJobs:()=>rendering.size,onMetric:createMediaMetricSink(root)},
        onRangesResolved:ranges=>persist(()=>{job.resolvedRanges=ranges;}),
        onChunkReady:chunk=>persist(()=>{job.chunks=(job.chunks??[]).filter(item=>item.id!==chunk.id).concat(chunk).sort((a,b)=>a.fromFrame-b.fromFrame);}),
        onAudioReady:audio=>persist(()=>{job.continuousAudio=audio;}),
        onSourceFrozen:digest=>persist(()=>{job.sourceDigest=digest;}),
        onOutputStart:id=>persist(()=>{job.currentOutput=id;}),
        onFileReady:file=>persist(()=>{job.readyFiles=job.readyFiles.filter(f=>f.id!==file.id).concat(file);}),
        onFrameReady:frame=>persist(()=>{
          const requested='frames' in job.input?job.input.frames:[];
          job.readyFrames=job.readyFrames.filter(f=>f.frame!==frame.frame).concat(frame).sort((a,b)=>requested.indexOf(a.frame)-requested.indexOf(b.frame));
        })};
      try{
        if(signal?.aborted||repo.get(current.runId).state!=='running')throw new ProductionError('PROCESS_CANCELLED','排队静帧启动前任务已取消');
        const result=await withMediaSpan(options.metrics,resume?'media_job_resume':'media_job',async metrics=>{
          const scoped={...options,metrics};
          const result=retryJob?await renderers.retryRenderSlices(current,root,retryJob,scoped):job.kind==='frame-preview'
            ?await renderers.templateFrames(current,root,frameBatchSchema.parse({runId:job.input.runId,renderRequestId:job.id,...('frames' in job.input?{frames:job.input.frames,sourceDigest:job.input.sourceDigest}:{})}),scoped)
            :await renderers.renderTemplate(current,root,renderToolSchema.parse(job.input),scoped);
          if(metrics)metrics.sourceDigest=job.sourceDigest;return result;
        });
        if(options.signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','本视频已取消');
        await persist(()=>Object.assign(job,{state:'succeeded',...result}));
        await registerReview(current,job,persist);
      }catch(e){await persist(()=>{
        Object.assign(job,{state:options.signal?.aborted?'cancelled':'failed',error:String(e)});
        if(job.reviewPreparation)job.reviewPreparation={state:options.signal?.aborted?'cancelled':'failed',errorCode:'REVIEW_MEDIA_INCOMPLETE',error:'媒体未完成，未登记检查计划；保留成功图片与缺帧清单'};
        if('frames' in job.input)job.missingFrames=job.input.frames.filter(frame=>!job.readyFrames.some(f=>f.frame===frame));
      });}
      await writes;
    });void work.finally(()=>frameJobs.delete(`${current.runId}:${job.id}`)).catch(()=>{});await registration;if(!active)await started;return job;
  };
  app.post('/internal/tools/:name',async(request:any,reply:any)=>{
    const name=request.params.name,run=repo.get(request.headers['x-run-id']),body=request.body??{};
    // 等待只持有监听，断线、取消和服务关闭均释放；不进入全局提交队列。
    const waitConnected=async<T>(work:(signal:AbortSignal)=>Promise<T>)=>{
      const connection=new AbortController(),close=()=>{if(!reply.raw.writableEnded)connection.abort();};
      reply.raw.once('close',close);
      const active=runner.active.get(run.runId)?.signal;
      try{return await work(active?AbortSignal.any([active,connection.signal]):connection.signal);}
      finally{connection.abort();reply.raw.removeListener('close',close);}
    };if(body.runId&&body.runId!==run.runId)throw new ProductionError('RUN_SCOPE_INVALID','工具不能访问其他执行',403);
    if(run.stage==='analysis'&&name!=='read_production_task')throw new ProductionError('ANALYSIS_TOOL_FORBIDDEN','Analysis 仅提供文字阶段事实读取',403);
    if(name==='prepare_review'){
      const result=await waitConnected(signal=>reviews.prepare(runnable(run.runId),prepareReviewSchema.parse(body),{events,signal,isRunning:id=>rendering.has(run.runId,id)}));return result;
    }
    if(name==='assign_review_work')return reviews.assign(run.runId,body);
    if(name==='submit_review')return reviews.submitReports(run.runId,body);
    if(name==='read_review'){
      const input=readReviewSchema.parse(body),result=await waitConnected(signal=>reviews.readWait(run.runId,input,signal));
      return reviewResultSummary(runner.runRoot(run),result,input.details,input.afterDigest);
    }
    if(name==='synthesize_speech'){runnable(run.runId);return speech.submit({...body,runId:run.runId},run.accountId);}
    if(name==='synthesize_speech_batch'){runnable(run.runId);return speechBatchSummary(runner.runRoot(run),await speech.submitBatch({...body,runId:run.runId},run.accountId));}
    if(name==='read_speech_job')return speech.read(body.speechJobId,run.runId,run.accountId);
    if(name==='read_speech_batch'){const input=z.object({speechBatchRequestId:renderRequestIdSchema,details:z.boolean().default(false)}).strict().parse(body);return speechBatchSummary(runner.runRoot(run),await speech.readBatch(input.speechBatchRequestId,run.runId,run.accountId),input.details);}
    if(name==='retry_speech_validation'){runnable(run.runId);return speech.retryValidation(body.speechJobId,run.runId,run.accountId);}
    if(name==='read_production_task')return {...productionTaskSummary(run),activeRender:rendering.current(run.runId),activeReviewId:(repo.db.prepare("SELECT id FROM reviews WHERE run_id=? AND state='active'").get(run.runId) as any)?.id??null,metricsPath:join(runner.runRoot(run),'metrics','media.jsonl'),optimization:{qaParallelReview:config.qaParallelReview??true,qaMaxReviewers:config.qaMaxReviewers??3,previewOnDemand:config.previewOnDemand??true,sceneCutMode:config.sceneCutMode??'accurate',renderStrategy:config.renderStrategy??'scene-chunks',mediaGlobalConcurrency:config.mediaGlobalConcurrency??16,mediaRunConcurrency:config.mediaRunConcurrency??2,mediaProcessConcurrency:config.mediaProcessConcurrency??4,mediaTiming:config.mediaTiming??true}};
    if(name==='assemble_sentence_audio'){
      const current=runnable(run.runId);
      return rendering.start(run.runId,'sentence-audio-assembly',()=>{
        const signal=runner.active.get(run.runId)?.signal;
        return budget.withProcess(run.runId,signal,()=>assembleSentenceAudio(current,runner.runRoot(current),body,speech,signal));
      });
    }
    if(name==='verify_sentence_audio'){
      const current=runnable(run.runId);
      return rendering.start(run.runId,'sentence-audio-check',async()=>{
        const signal=runner.active.get(run.runId)?.signal;
        const result=await budget.withProcess(run.runId,signal,()=>verifySentenceAudio(current,runner.runRoot(current),body,speech,signal));
        const latest=repo.get(run.runId);
        repo.checkpoint(run.runId,current.token!,{sentenceAudioAudits:{...latest.checkpoint.sentenceAudioAudits,[result.sourceDigest]:{timelineSha256:result.timelineSha256,timelineRef:body.timelineRef}}});
        return result;
      });
    }
    if(name==='render_template'||name==='preview_template_frames'||name==='prepare_review_frames')return serial(async()=>{
      const kind=name==='render_template'?'template-render':'frame-preview';
      const input=name==='render_template'?renderToolSchema.parse({...body,runId:run.runId}):name==='prepare_review_frames'?reviewFramesInput(run.runId,body):previewFramesSchema.parse({...body,runId:run.runId});
      if(run.stage!=='render')throw new ProductionError('RENDER_STAGE_FORBIDDEN','Analysis 不允许渲染');
      const path=join(runner.runRoot(run),'render-jobs',`${input.renderRequestId}.json`),digest=sha256(canonical({kind,input}));
      const old=await json(path).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});
      if(old){
        if(old.kind!==kind||old.inputDigest!==digest)throw new ProductionError('RENDER_KEY_CONFLICT','同一编号的作业类型或输入不同',409);
        return mediaJobSummary(observedJob(run.runId,old),path);
      }
      const current=runnable(run.runId);
      const job:MediaJob={id:input.renderRequestId,runId:run.runId,kind,state:'running',inputDigest:digest,input,...('reviewPlan' in input?{reviewPreparation:{state:'pending' as const}}:{}),releaseId:config.release.releaseId,rendererVersion:'scene-chunks/1',sceneCutMode:config.sceneCutMode??'accurate',renderStrategy:config.renderStrategy??'scene-chunks',concurrency:config.renderConcurrency??4,runConcurrency:config.mediaRunConcurrency??2,readyFiles:[],readyFrames:[]};
      return mediaJobSummary(await startMedia(current,path,job,false),path);
    });
    if(name==='retry_review_preparation')return serial(async()=>{
      const {renderRequestId}=z.object({renderRequestId:renderRequestIdSchema}).strict().parse(body);
      const current=runnable(run.runId),path=join(runner.runRoot(run),'render-jobs',`${renderRequestId}.json`),job:MediaJob=await json(path);
      if(job.runId!==run.runId||job.kind!=='frame-preview'||!('reviewPlan' in job.input)||job.inputDigest!==sha256(canonical({kind:job.kind,input:job.input})))throw new ProductionError('REVIEW_JOB_INVALID','原材料作业身份不符',409);
      if(rendering.has(run.runId,job.id)||job.reviewPreparation?.state==='succeeded')return mediaJobSummary(observedJob(run.runId,job),path);
      if(job.state!=='succeeded'||job.reviewPreparation?.state==='cancelled')throw new ProductionError('REVIEW_RETRY_FORBIDDEN','仅成功媒体可恢复原材料登记；不续绘失败、未知或取消媒体',409);
      // 原登记结果未知也仅幂等核验原媒体，绝不重绘。占用同一 Run 生命周期防止取消后漏提交。
      if(rendering.current(run.runId))throw new ProductionError('RENDER_BUSY','本 Run 正在处理其他媒体，请沿原作业等待',409);
      job.reviewPreparation={state:'running'};await writeJson(path,job);
      void rendering.start(run.runId,job.id,()=>registerReview(current,job,async change=>{change();await writeJson(path,job);events.notify(path);events.notify(`${run.runId}:${job.id}`);})).catch(()=>{events.notify(path);});
      return mediaJobSummary(job,path);
    });
    if(name==='retry_render_slices')return serial(async()=>{
      const {renderRequestId}=z.object({renderRequestId:renderRequestIdSchema}).strict().parse(body);
      const current=runnable(run.runId),path=join(runner.runRoot(run),'render-jobs',`${renderRequestId}.json`),job:MediaJob=await json(path);
      if(job.runId!==run.runId||job.kind!=='template-render'||!job.input||!('previewOnly' in job.input)||(job.input.previewOnly&&job.renderStrategy!=='scene-chunks'))throw new ProductionError('SLICE_RETRY_FORBIDDEN','仅本Run原正式导出可以续切',409);
      if(job.inputDigest!==sha256(canonical({kind:job.kind,input:job.input})))throw new ProductionError('RENDER_KEY_CONFLICT','原作业输入摘要不符',409);
      if(job.state==='succeeded')return mediaJobSummary(job,path);
      if(job.state==='running')return mediaJobSummary(rendering.current(run.runId)===job.id?job:{...job,state:'unknown',error:'原工作状态需要核查，不能续切'},path);
      if(job.state!=='failed'||!job.sourceDigest||(job.renderStrategy!=='scene-chunks'&&!job.readyFiles.some(f=>f.id==='whole-video')))throw new ProductionError('SLICE_RETRY_FORBIDDEN','须明确失败且快照可信；旧策略另须原整片已核验，未知或取消作业不能恢复',409);
      return mediaJobSummary(await startMedia(current,path,job,true),path);
    });
    if(name==='read_render_job'){
      const input=z.object({renderRequestId:renderRequestIdSchema,waitMs:z.number().int().min(0).max(60000).default(0),afterDigest:z.string().optional(),details:z.boolean().default(false)}).strict().parse(body);
      const path=join(runner.runRoot(run),'render-jobs',`${input.renderRequestId}.json`),deadline=Date.now()+input.waitMs;
      await toolQueue;
      while(true){
        // 先登记监听再读取，防止读完状态到订阅之间遗漏完成事件。
        const controller=new AbortController();
        const wake=events.wait(path,Math.max(0,deadline-Date.now()),AbortSignal.any([controller.signal,...(runner.active.get(run.runId)?[runner.active.get(run.runId)!.signal]:[])]));
        try{
          const job=observedJob(run.runId,await json(path));
          const statusDigest=sha256(canonical(job));
          if((!['running','queued'].includes(job.state)&&!(job.state==='succeeded'&&job.reviewPreparation&&['pending','running'].includes(job.reviewPreparation.state)))||Date.now()>=deadline||runner.active.get(run.runId)?.signal.aborted||(input.afterDigest!==undefined&&input.afterDigest!==statusDigest))return {...mediaJobSummary(job,path,input.details),statusDigest};
          await wake;
        }finally{controller.abort();}
      }
    }
    throw new ProductionError('TOOL_NOT_FOUND','制作工具不存在',404);
  });
  return {app,repo,runner,callbacks,speech,reviews,async close(){runner.stop();speech.stop();reviews.close();await runner.drain();await runner.settleTools();await app.close();repo.close();}};
}
