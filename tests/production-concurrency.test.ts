import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProductionRepository } from '../packages/production-service/src/repository.js';
import { ProductionRunner } from '../packages/production-service/src/runner.js';
import { ProductionError } from '../packages/production-service/src/contracts.js';
import type { ProductionConfig } from '../packages/production-service/src/config.js';
import { createProductionServer } from '../apps/server/src/production/routes.js';
import { processFile,writeJson } from '../packages/production-service/src/files.js';
import { ToolObserver } from '../packages/production-service/src/tool-observer.js';
import { AppServerClient } from '../packages/production-service/src/codex-session.js';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function until(predicate:()=>boolean){const end=Date.now()+4000;while(!predicate()){if(Date.now()>end)throw new Error('测试等待超时');await new Promise(r=>setTimeout(r,5));}}
const configFor=(root:string)=>({dataRoot:root,maxActiveRuns:4,renderConcurrency:5,speechConcurrency:20,speechPerRunConcurrency:5,accountId:'a',apiToken:'test',callbackBase:'http://127.0.0.1',callbackSecret:'test',ready:{codex:true},release:{releaseId:'test'},voicesPath:''} as unknown as ProductionConfig);

test('四任务调度：第五个排队、独立收尾、清理结束后补位',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'production-slots-')),repo=new ProductionRepository(join(root,'db.sqlite')),gates=new Map<string,ReturnType<typeof deferred>>(),finishing=new Map<string,ReturnType<typeof deferred>>();
 const runner=new ProductionRunner(repo,configFor(root),async(run,dir,_repo,_config,signal)=>{
   const gate=deferred();gates.set(run.runId,gate);await gate.promise;if(signal.aborted)throw new ProductionError('PROCESS_CANCELLED','测试取消');
   const path=join(dir,'result.json');await writeJson(path,{taskId:run.taskId,runId:run.runId,inputDigest:run.inputDigest,dataList:[{id:'s',content:(run.request as any).content,dur:1,durationSource:'estimated'}],context:'测试'});
   return {taskId:run.taskId,runId:run.runId,inputDigest:run.inputDigest,resultPath:path};
 });
 runner.prepare=async run=>run;runner.settleTools=async id=>{if(id)await finishing.get(id)?.promise;};
 const runs=Array.from({length:6},(_,i)=>repo.accept('a','analysis',{taskId:`video-${i}`,content:'正文',otherRequirements:'',plugin:{customTemplateId:'x'}}));
 try{
   await runner.tick();await until(()=>gates.size===4);assert.equal(runner.active.size,4);assert.equal(repo.get(runs[4].runId).state,'queued');
   const gate=deferred();finishing.set(runs[0].runId,gate);gates.get(runs[0].runId)!.resolve();await new Promise(r=>setTimeout(r,30));await runner.tick();assert.equal(runner.active.size,4);assert.equal(repo.get(runs[4].runId).state,'queued');
   gate.resolve();await runner.drain(runs[0].runId);assert.equal(repo.get(runs[0].runId).state,'succeeded');assert.equal(repo.get(runs[1].runId).state,'running');
   await runner.tick();await until(()=>gates.has(runs[4].runId));assert.equal(runner.active.size,4);
   repo.cancel(runs[1].runId,'a');runner.stopRun(runs[1].runId);gates.get(runs[1].runId)!.resolve();await runner.drain(runs[1].runId);assert.equal(repo.get(runs[1].runId).state,'cancelled');
   await runner.tick();await until(()=>gates.size===6);assert.equal(runner.active.size,4);
   for(const gate of gates.values())gate.resolve();await runner.drain();assert.equal(runner.active.size,0);
 }finally{for(const gate of gates.values())gate.resolve();for(const gate of finishing.values())gate.resolve();runner.stop();await runner.drain();repo.close();await fs.rm(root,{recursive:true,force:true});}
});

test('渲染入口：四视频各五槽，同视频不同请求及静帧不能绕过，已完成文件可查询',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'production-render-gate-')),gates=new Map<string,ReturnType<typeof deferred>>(),options=new Map<string,any>();let active=0,peak=0;
 const fake={renderTemplate:async(run:any,_root:any,input:any,opt:any)=>{active+=opt.concurrency;peak=Math.max(peak,active);options.set(run.runId,opt);const gate=deferred();gates.set(run.runId,gate);await gate.promise;active-=opt.concurrency;if(opt.signal.aborted)throw new Error('本视频已取消');if(input.renderRequestId==='failed')throw new Error('模拟文件完整性检查失败');return {deliveryPath:'test',delivery:{} as any};},templateFrame:async()=>{throw new Error('静帧不应该绕过正在进行的渲染');}};
 const service=await createProductionServer(configFor(root),undefined,fake);
 const runs=[];
 for(let i=0;i<4;i++){const a=service.repo.accept('a','analysis',{taskId:`v${i}`,content:'原文',otherRequirements:'',plugin:{customTemplateId:'x'}}),claimed=service.repo.claim()!;service.repo.finish(a.runId,claimed.token,'succeeded',{});const r=service.repo.accept('a','render',{taskId:`v${i}`,basePlanVersion:1,dataList:[{id:'s',content:'原文'}],otherRequirements:''}),c=service.repo.claim()!;service.runner.active.set(r.runId,new AbortController());runs.push(c);}
 const call=(run:any,name:string,body:any)=>service.app.inject({method:'POST',url:`/internal/tools/${name}`,headers:{'x-run-id':run.runId,'x-run-token':run.token},payload:body});
 const input={renderRequestId:'first',timelineRef:'timeline.json',ranges:[{id:'s',fromFrame:0,toFrame:30}],checks:[]};
 try{
   for(const run of runs)assert.equal((await call(run,'render_template',input)).statusCode,200);
   assert.equal(peak,20);assert.equal(gates.size,4);
   assert.equal((await call(runs[0],'render_template',input)).statusCode,200);assert.equal(gates.size,4);
   assert.equal((await call(runs[0],'render_template',{...input,checks:['更改输入']})).statusCode,409);
   assert.equal((await call(runs[0],'render_template',{...input,renderRequestId:'second'})).statusCode,409);
   assert.equal((await call(runs[0],'preview_template_frame',{frame:0})).statusCode,409);
   assert.equal((await call(runs[0],'read_render_job',{renderRequestId:'first'})).json().readyFiles.length,0);
   await options.get(runs[0].runId).onFileReady({id:'whole-video',file:'checked.mp4'});
   const partial=(await call(runs[0],'read_render_job',{renderRequestId:'first'})).json();assert.equal(partial.state,'running');assert.equal(partial.readyFiles[0].id,'whole-video');
   gates.get(runs[0].runId)!.resolve();await service.runner.settleTools(runs[0].runId);assert.equal(active,15);assert.equal((await call(runs[0],'read_render_job',{renderRequestId:'first'})).json().state,'succeeded');
   await service.app.inject({method:'POST',url:`/ai_video_director/runs/${runs[1].runId}/cancel`,headers:{authorization:'Bearer test'}});assert.equal((await call(runs[1],'preview_template_frame',{frame:1})).statusCode,409);
   assert.equal(options.get(runs[1].runId).signal.aborted,true);assert.equal(options.get(runs[2].runId).signal.aborted,false);gates.get(runs[1].runId)!.resolve();await service.runner.settleTools(runs[1].runId);assert.equal((await call(runs[1],'read_render_job',{renderRequestId:'first'})).json().state,'cancelled');
   assert.equal((await call(runs[0],'render_template',{...input,renderRequestId:'failed'})).statusCode,200);gates.get(runs[0].runId)!.resolve();await service.runner.settleTools(runs[0].runId);const failed=(await call(runs[0],'read_render_job',{renderRequestId:'failed'})).json();assert.equal(failed.state,'failed');assert.deepEqual(failed.readyFiles,[]);
 }finally{for(const gate of gates.values())gate.resolve();await service.close();await fs.rm(root,{recursive:true,force:true});}
});

test('受控子进程超时真正结束后返回，提前取消不启动',async()=>{
 await assert.rejects(processFile(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:50}),(e:any)=>e.code==='PROCESS_TIMEOUT');
 const controller=new AbortController();controller.abort();await assert.rejects(processFile(process.execPath,['-e','process.exit(0)'],{signal:controller.signal}),(e:any)=>e.code==='PROCESS_CANCELLED');
});

test('悬挂观察按线程及调用定位，完成事件清除，不把心跳视为工具完成',()=>{
 const observer=new ToolObserver();observer.observe({method:'item/started',params:{threadId:'a',item:{id:'1',type:'commandExecution'}}},100);
 observer.observe({method:'item/started',params:{threadId:'b',item:{id:'1',type:'commandExecution'}}},100);
 assert.equal(observer.stalled(1000,500).length,2);observer.observe({method:'item/completed',params:{threadId:'a',item:{id:'1'}}});assert.equal(observer.stalled(1000,500)[0].threadId,'b');
});

test('恢复任务也遵守四名额，原会话未知不重放、停止后不领取剩余任务',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'production-recovery-')),repo=new ProductionRepository(join(root,'db.sqlite')),gates=new Map<string,ReturnType<typeof deferred>>();
 const runs=Array.from({length:6},(_,i)=>{repo.accept('a','analysis',{taskId:`recover-${i}`,content:'正文',otherRequirements:'',plugin:{customTemplateId:'x'}});const r=repo.claim()!;repo.checkpoint(r.runId,r.token!,{codex:{threadId:`original-${i}`}});return r;});
 const runner=new ProductionRunner(repo,configFor(root),async run=>{assert.ok(run.checkpoint.codex.threadId.startsWith('original-'));const gate=deferred();gates.set(run.runId,gate);await gate.promise;throw new ProductionError('CODEX_RESULT_UNKNOWN','原会话未完成');});runner.prepare=async run=>run;
 try{await runner.recover();assert.equal(gates.size,4);assert.equal(runner.active.size,4);gates.get(runs[0].runId)!.resolve();await runner.drain(runs[0].runId);assert.equal(repo.get(runs[0].runId).state,'unknown');await runner.tick();assert.equal(gates.size,5);assert.equal(runner.active.size,4);runner.stop();for(const gate of gates.values())gate.resolve();await runner.drain();await runner.tick();assert.equal(gates.size,5);}
 finally{runner.stop();for(const gate of gates.values())gate.resolve();await runner.drain();repo.close();await fs.rm(root,{recursive:true,force:true});}
});

test('会话关闭等待自己的进程退出，重复关闭返回原等待，不影响另一会话',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'production-appserver-'));
 const code='process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>process.exit(0),80));';
 const a=new AppServerClient(process.execPath,['-e',code],process.env,root),b=new AppServerClient(process.execPath,['-e',code],process.env,root);
 try{const closing=a.close();assert.equal(a.close(),closing);await closing;assert.equal(a.child.exitCode,0);assert.equal(b.child.exitCode,null);process.kill(b.child.pid!,0);await b.close();assert.equal(b.child.exitCode,0);}
 finally{await Promise.all([a.close(),b.close()]);await fs.rm(root,{recursive:true,force:true});}
});
