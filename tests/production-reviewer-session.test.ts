import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {ReviewerSessions} from '../packages/production-service/src/reviewer-session.js';
import type {ReviewService} from '../packages/production-service/src/review-service.js';
import type {ProductionConfig} from '../packages/production-service/src/config.js';
import type {Run} from '../packages/production-service/src/contracts.js';

async function until(check:()=>boolean|Promise<boolean>){
 const deadline=Date.now()+8000;
 while(!(await check())){if(Date.now()>deadline)throw new Error('隔离审片生命周期等待超时');await new Promise(resolve=>setTimeout(resolve,10));}
}
async function fixture(initialMode:string){
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'reviewer-lifecycle-'))),executable=join(root,'fake-codex.mjs'),modePath=join(root,'mode'),logPath=join(root,'calls.jsonl');
 await fs.writeFile(modePath,initialMode);
 // 真实子进程模拟 App Server 协议，只测试连接与线程生命周期，不调用模型或生成作品。
 await fs.writeFile(executable,`#!${process.execPath}
 import {createInterface} from 'node:readline';
 import {readFileSync,appendFileSync} from 'node:fs';
 const mode=()=>readFileSync(${JSON.stringify(modePath)},'utf8');
 const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 let thread=0,turn=0;const held=[];
 const done=(request,id,status='completed')=>send({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id,status,error:status==='failed'?{message:'隔离失败'}:undefined}}});
 const input=createInterface({input:process.stdin});
 input.on('line',line=>{const request=JSON.parse(line);appendFileSync(${JSON.stringify(logPath)},JSON.stringify(request)+'\\n');if(request.id===undefined)return;
  if(request.method==='initialize'&&mode()==='startup-fail'){send({id:request.id,error:{message:'隔离启动失败'}});return;}
  let result={};
  if(request.method==='skills/list')result={data:[]};
  if(request.method==='thread/start'){if(mode()==='hold-thread-start')return;result={thread:{id:'thread-'+(++thread)},sandbox:'read-only'};}
  if(request.method==='mcpServerStatus/list')result={data:[{tools:Object.fromEntries((mode()==='tools-fail'?['render_template']:['claim_review_work','submit_review','read_review']).map(name=>[name,{name}]))}]};
  if(request.method==='turn/start'){const id='turn-'+(++turn);result={turn:{id}};if(mode()==='hold-turn')held.push([request,id]);else setTimeout(()=>done(request,id,mode()==='turn-fail'?'failed':'completed'),20);}
  send({id:request.id,result});
 });
 const timer=setInterval(()=>{if(mode()==='finish-held')for(const [request,id] of held.splice(0))done(request,id);},10);
 input.on('close',()=>{clearInterval(timer);process.exit(0);});
 `);await fs.chmod(executable,0o755);
 const server=createServer((_req,res)=>res.writeHead(403).end());await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const records:Array<{id:string;state:string;threadId?:string}>=[],diagnostics:Array<{reviewId:string;message:string|null}>=[];let closed=false,lateWrites=0;
 const writable=()=>{if(closed)lateWrites++;};
 const service={recoverSessions:()=>{writable();for(const record of records)record.state='revoked';},runRoot:()=>root,read:(_runId:string,reviewId:string)=>({reviewId,state:'active',remaining:1}),runtimeDiagnostic:(reviewId:string,message:string|null)=>{writable();diagnostics.push({reviewId,message});},createSession:()=>{writable();const id=`session-${records.length+1}`;records.push({id,state:'starting'});return {id,credential:`isolated-${id}`};},bindSession:(id:string,threadId:string)=>{writable();Object.assign(records.find(r=>r.id===id)!,{state:'active',threadId});},releaseSession:(id:string)=>{writable();records.find(r=>r.id===id)!.state='revoked';},repo:{db:{prepare:()=>({run:()=>writable(),get:()=>undefined})}}} as unknown as ReviewService;
 const config={codexExecutable:executable,codexHome:root,pluginRoot:root,dependencyRoot:root,host:'127.0.0.1',port:(server.address() as any).port,qaMaxReviewers:1,qaParallelReview:false} as ProductionConfig;
 const controller=new AbortController(),pool=new ReviewerSessions(service,config,()=>controller.signal),run={runId:'isolated-run'} as Run;
 const calls=async()=>{try{return (await fs.readFile(logPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error:any){if(error.code==='ENOENT')return [];throw error;}};
 return {root,records,diagnostics,pool,run,controller,calls,mode:(value:string)=>fs.writeFile(modePath,value),async close(){await pool.stop();closed=true;await new Promise(resolve=>setTimeout(resolve,30));assert.equal(lateWrites,0,'stop 返回后仍写审片记录');server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}};
}

test('App Server 启动或工具隔离失败收敛后，可以创建新的有效审片会话',async()=>{
 for(const mode of ['startup-fail','tools-fail']){
  const f=await fixture(mode);try{
   f.pool.start(f.run,'review-a');await until(()=>f.diagnostics.some(d=>d.message!==null));await f.pool.stop(f.run.runId);
   assert.ok(f.records.every(r=>r.state==='revoked'));
   await f.mode('normal');f.pool.start(f.run,'review-a');await until(async()=>(await f.calls()).some(c=>c.method==='turn/start'));
   assert.equal(f.records.filter(r=>r.state==='active').length,1);
  }finally{await f.close();}
 }
});

test('启动响应未返回时取消等待原进程收敛，不遗留 starting 凭证或后台写入',async()=>{
 const f=await fixture('hold-thread-start');try{
  f.pool.start(f.run,'review-a');await until(async()=>(await f.calls()).some(c=>c.method==='thread/start'));
  f.controller.abort();await Promise.all([f.pool.stop(f.run.runId),f.pool.stop(f.run.runId)]);
  assert.equal(f.records.length,1);assert.equal(f.records[0].state,'revoked');assert.equal((await f.calls()).some(c=>c.method==='turn/start'),false);
 }finally{await f.close();}
});

test('失败审片者释放名额，后续调度使用新凭证和新线程',async()=>{
 const f=await fixture('turn-fail');try{
  f.pool.start(f.run,'review-a');await until(()=>f.records.some(r=>r.state==='revoked'));
  await f.mode('normal');f.pool.start(f.run,'review-a');await until(async()=>(await f.calls()).filter(c=>c.method==='turn/start').length===2);
  assert.equal(f.records.length,2);assert.equal(f.records[0].state,'revoked');assert.equal(f.records[1].state,'active');assert.notEqual(f.records[0].threadId,f.records[1].threadId);
 }finally{await f.close();}
});

test('新版计划在旧轮次忙碌期间到达，旧轮次结束后续接新版；同版不自动空转',async()=>{
 const f=await fixture('hold-turn');try{
  f.pool.start(f.run,'review-a');await until(async()=>(await f.calls()).filter(c=>c.method==='turn/start').length===1);
  f.pool.start(f.run,'review-b');await f.mode('finish-held');await until(async()=>(await f.calls()).filter(c=>c.method==='turn/start').length===2);
  const calls=(await f.calls()).filter(c=>c.method==='turn/start');assert.match(calls[1].params.input[0].text,/review-b/);
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,2);
 }finally{await f.close();}
});
