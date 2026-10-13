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
import { DoubaoService } from '../../../../packages/speech-services/src/doubao.js';
import { renderTemplate, renderToolSchema, templateFrame } from '../../../render-worker/src/template-renderer.js';
import { json, writeJson } from '../../../../packages/production-service/src/files.js';
export async function createProductionServer(config:ProductionConfig,executor?:Executor){
  const repo=new ProductionRepository(join(config.dataRoot,'tasks.sqlite')),runner=new ProductionRunner(repo,config,executor),callbacks=new CallbackSender(repo,config.callbackBase,config.callbackSecret);
  const speech=new DoubaoService(repo,config.dataRoot,config.voicesPath??'',process.env.DOUBAO_API_KEY??'');
  const app=Fastify({bodyLimit:2*1024*1024});await app.register(cors,{origin:true,exposedHeaders:['Content-Range','Content-Length','Accept-Ranges']});
  app.setErrorHandler((error:any,request,reply)=>{reply.code(error instanceof z.ZodError?400:error.statusCode??500).send({status:1,msg:error.message,error:{code:error instanceof z.ZodError?'INVALID_FIELDS':error.code??'INTERNAL_ERROR',fields:error instanceof z.ZodError?error.issues:undefined}});});
  app.addHook('preHandler',async(request,reply)=>{
    if(request.method==='OPTIONS'||request.url==='/healthz'||request.url.startsWith('/media/'))return;
    if(request.url.startsWith('/internal/tools/')){
      const runId=request.headers['x-run-id'],token=request.headers['x-run-token'];if(typeof runId!=='string'||typeof token!=='string')throw new ProductionError('RUN_AUTH_REQUIRED','需要执行身份',401);
      const run=repo.get(runId);if(run.token!==token||!['running','cancelling'].includes(run.state))throw new ProductionError('RUN_AUTH_INVALID','执行身份已失效',403);return;
    }
    if(request.headers.authorization!==`Bearer ${config.apiToken}`)throw new ProductionError('UNAUTHORIZED','需要有效服务身份',401);
  });
  app.get('/healthz',async()=>({status:'ready',releaseId:config.release.releaseId,pluginVersion:config.release.pluginVersion,skillsDigest:config.release.skillsDigest,configurationReady:Object.values(config.ready).every(Boolean),productionReady:Object.values(config.ready).every(Boolean)?null:false,readinessScope:'configuration_only',dependencies:config.ready,capabilities:{localModels:false,networkSearch:config.searchEnabled,lexicalMechanisms:true}}));
  const accept=(stage:'analysis'|'render')=>async(request:any,reply:any)=>{if(runner.stopping)throw new ProductionError('STOPPING','服务正在停止受理',503);const run=repo.accept(config.accountId,stage,request.body);return reply.code(202).send({status:0,msg:'已持久化受理',data:{taskId:run.taskId,requestId:run.requestId,runId:run.runId,stage,state:run.state,planVersion:run.planVersion}});};
  app.post('/narrate/ai_video_director/getAiVideoEditingAnalysisData',accept('analysis'));app.post('/narrate/ai_video_director/getAiVideoEditingData',accept('render'));
  app.get('/ai_video_director/tasks/:taskId',async(request:any)=>{const runs=repo.list(config.accountId,request.params.taskId);return {status:0,data:{latestSubmitted:runs.at(-1)?.runId,current:runs.find(r=>['running','unknown','recovering','cancelling'].includes(r.state))?.runId,latestSuccess:[...runs].reverse().find(r=>r.stage==='render'&&r.state==='succeeded')?.runId,runs:runs.map(r=>({...r,token:undefined,checkpoint:undefined,callback:repo.db.prepare('SELECT id,state,attempts,diagnostic FROM callback_outbox WHERE run_id=?').get(r.runId)}))}};});
  app.post('/ai_video_director/runs/:runId/cancel',async(request:any)=>{const run=repo.cancel(request.params.runId,config.accountId);return {status:0,data:{runId:run.runId,state:run.state}};});
  app.post('/ai_video_director/callbacks/:eventId/retry',async(request:any)=>({status:0,data:callbacks.retry(request.params.eventId,config.accountId)}));
  app.route({method:['GET','HEAD'],url:'/media/:task/:run/:file',handler:async(request:any,reply)=>{
    const {task,run,file}=request.params;if(!z.string().uuid().safeParse(task).success||!z.string().uuid().safeParse(run).success||!/^\d+\.mp4$/.test(file))throw new ProductionError('MEDIA_NOT_FOUND','媒体不存在',404);
    const record=repo.get(run);if(record.taskKey!==task||record.state!=='succeeded')throw new ProductionError('MEDIA_NOT_FOUND','媒体尚未发布',404);
    const path=join(config.dataRoot,'tasks',task,'results',run,file),stat=await fs.stat(path);let start=0,end=stat.size-1;reply.header('Content-Type','video/mp4').header('Accept-Ranges','bytes');
    if(request.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(request.headers.range);if(!m||(!m[1]&&!m[2]))return reply.code(416).header('Content-Range',`bytes */${stat.size}`).send();
      if(!m[1])start=Math.max(0,stat.size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}if(start>end||start>=stat.size)return reply.code(416).header('Content-Range',`bytes */${stat.size}`).send();reply.code(206).header('Content-Range',`bytes ${start}-${end}/${stat.size}`);}
    reply.header('Content-Length',end-start+1);return request.method==='HEAD'?reply.send():reply.send(createReadStream(path,{start,end}));
  }});
  const renderJobs=new Map<string,Promise<void>>();let toolQueue:Promise<any>=Promise.resolve();
  runner.settleTools=async()=>{await speech.drain();await Promise.allSettled(renderJobs.values());};
  app.post('/internal/tools/:name',async(request:any)=>{
    const name=request.params.name,run=repo.get(request.headers['x-run-id']),body=request.body??{};if(body.runId&&body.runId!==run.runId)throw new ProductionError('RUN_SCOPE_INVALID','工具不能访问其他执行',403);
    if(name==='synthesize_speech'){
      // 请求登记串行，防止相同键在网络等待期间被重复提交。
      const next=toolQueue.then(()=>speech.submit({...body,runId:run.runId},run.accountId));toolQueue=next.catch(()=>{});return next;
    }
    if(name==='read_speech_job')return speech.read(body.speechJobId,run.runId,run.accountId);
    if(name==='read_production_task')return {...run,token:undefined};
    if(name==='preview_template_frame'){const parsed=z.object({frame:z.number().int().nonnegative()}).strict().parse(body);if(run.stage!=='render')throw new ProductionError('RENDER_STAGE_FORBIDDEN','Analysis 不允许渲染');const path=join(runner.runRoot(run),'previews',`frame-${parsed.frame}.png`);await templateFrame(join(runner.runRoot(run),'project'),parsed.frame,path,config.dependencyRoot,config.browser);return {path};}
    if(name==='render_template'){
      // 只串行登记，不等待渲染结束；同键并发请求只能创建一个任务。
      const next=toolQueue.then(async()=>{
      const input=renderToolSchema.parse({...body,runId:run.runId});if(run.stage!=='render')throw new ProductionError('RENDER_STAGE_FORBIDDEN','Analysis 不允许渲染');const root=runner.runRoot(run),path=join(root,'render-jobs',`${input.renderRequestId}.json`),digest=sha256(canonical(input));
      const old=await json(path).catch(()=>null);if(old){if(old.inputDigest!==digest)throw new ProductionError('RENDER_KEY_CONFLICT','同一渲染键输入不同',409);return old;}
      const job:any={id:input.renderRequestId,state:'running',inputDigest:digest};await writeJson(path,job);
      const work=renderTemplate(run,root,input,{dependencyRoot:config.dependencyRoot,browser:config.browser,concurrency:config.renderConcurrency,signal:runner.active.get(run.runId)?.signal}).then(async result=>{Object.assign(job,{state:'succeeded',...result});await writeJson(path,job);}).catch(async e=>{Object.assign(job,{state:'failed',error:String(e)});await writeJson(path,job);}).finally(()=>renderJobs.delete(path));renderJobs.set(path,work);return job;
      });toolQueue=next.catch(()=>{});return next;
    }
    if(name==='read_render_job'){const id=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(body.renderRequestId),path=join(runner.runRoot(run),'render-jobs',`${id}.json`),job=await json(path);if(job.state==='running'&&!renderJobs.has(path))return {...job,state:'unknown',error:'原渲染进程状态需要核查'};return job;}
    throw new ProductionError('TOOL_NOT_FOUND','制作工具不存在',404);
  });
  return {app,repo,runner,callbacks,speech,async close(){runner.stop();await speech.drain();await Promise.allSettled(renderJobs.values());await app.close();repo.close();}};
}
