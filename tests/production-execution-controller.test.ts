import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProductionRepository} from '../packages/production-service/src/repository.js';
import {ExecutionController,mediaEventKey,type RuntimeMediaState} from '../packages/production-service/src/execution-controller.js';
import {MediaJobEvents} from '../packages/production-service/src/run-work.js';
import {createTurnReceiver,threadDiscoveries} from '../packages/production-service/src/turn-events.js';
import {readThreadTurns,completedTurnResult} from '../packages/production-service/src/codex-session.js';
function setup(){
  const root=mkdtempSync(join(tmpdir(),'wait-controller-')),repo=new ProductionRepository(join(root,'tasks.sqlite'));
  repo.accept('a','analysis',{taskId:'test',content:'正文',otherRequirements:'',plugin:{customTemplateId:'x'}});const a=repo.claim()!;repo.finish(a.runId,a.token,'succeeded',{});
  repo.accept('a','render',{taskId:'test',basePlanVersion:1,otherRequirements:'',dataList:[{id:'s',content:'正文'}]});const run=repo.claim()!;
  let job:RuntimeMediaState={runId:run.runId,id:'render',state:'running',attempt:1,inputDigest:'input',sourceDigest:'source'},reads=0;
  const events=new MediaJobEvents(),abort=new AbortController();
  const media={events,read:async()=>{reads++;return {...job};}};
  const controller=new ExecutionController(run,repo,media,abort.signal,5);
  return {repo,run,events,abort,controller,media,get reads(){return reads;},get job(){return job;},set job(value){job=value;},close(){repo.close();rmSync(root,{recursive:true,force:true});}};
}
const waitResult={kind:'await_runtime',renderRequestId:'render'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('媒体先完成、重复终态和心跳交错只允许一次续接',async()=>{
  const x=setup();try{x.job={...x.job,state:'succeeded'};const result=await x.controller.wait('thread','first',waitResult);assert.equal(result?.wait.state,'resuming');x.repo.heartbeat(x.run.runId,x.run.token!);x.controller.bind(result!.wait,'second');assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.resumeTurnId,'second');assert.throws(()=>x.controller.bind(result!.wait,'duplicate'),/检查点/);await assert.rejects(x.controller.wait('thread','second',waitResult),/已接回/);}finally{x.close();}
});
test('普通进度与漏通知仅核对原作业，终态才接回',async()=>{
  const x=setup();try{let woken=false;const pending=x.controller.wait('thread','first',waitResult).then(v=>{woken=true;return v;});await tick();x.events.notify(mediaEventKey(x.run.runId,'render'));await tick();assert.equal(woken,false);assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.state,'waiting_media');x.job={...x.job,state:'succeeded'};const result=await pending;assert.equal(result?.wait.terminalState,'succeeded');assert.ok(x.reads>=3);}finally{x.close();}
});
test('取消与未知不唤醒模型，重试代次和快照变化不串作业',async()=>{
  for(const state of ['cancelled','unknown','attempt','snapshot'] as const){const x=setup();try{const pending=x.controller.wait('thread','first',waitResult);await tick();if(state==='attempt')x.job={...x.job,attempt:2};else if(state==='snapshot')x.job={...x.job,sourceDigest:'changed'};else x.job={...x.job,state};x.events.notify(mediaEventKey(x.run.runId,'render'));await assert.rejects(pending);assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.state,'waiting_media');}finally{x.close();}}
  const x=setup();try{const pending=x.controller.wait('thread','first',waitResult);await tick();x.abort.abort();await assert.rejects(pending,/取消/);}finally{x.close();}
});
test('服务重启保留 waiting 原记录，媒体完成可续接；已发起未知不得再启动',async()=>{
  const x=setup();try{x.job={...x.job,state:'succeeded'};const result=await x.controller.wait('thread','first',waitResult);const restart=new ExecutionController(x.run,x.repo,x.media,new AbortController().signal);await assert.rejects(restart.wait('thread','first',waitResult),/先核查/);assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.waitId,result!.wait.waitId);}finally{x.close();}
});
test('新 turn 响应之前的事件缓冲，旧 final 和子线程不能冒充续接',async()=>{
  const receive=createTurnReceiver('main');const emit=(id:string,text:string)=>receive.observe({method:'item/completed',params:{threadId:'main',turnId:id,item:{type:'agentMessage',text}}});
  emit('old','错误');receive.observe({method:'turn/completed',params:{threadId:'main',turn:{id:'old',status:'completed'}}});emit('new','正确');receive.observe({method:'turn/completed',params:{threadId:'main',turn:{id:'new',status:'completed'}}});receive.bind('new');assert.equal((await receive.promise).text,'正确');
});
test('子代理 activity 和真实 thread/started 都归一化',()=>{
  assert.deepEqual(threadDiscoveries({method:'item/completed',params:{threadId:'main',item:{type:'subAgentActivity',agentThreadId:'author'}}}),[{threadId:'author',parentThreadId:'main',source:'subAgentActivity'}]);
});
test('恢复通过分页读取完整轮次，只接受明确完成输出',async()=>{
  let calls=0;const turns=await readThreadTurns({call:async(method:string,params:any)=>{assert.equal(method,'thread/turns/list');assert.equal(params.itemsView,'full');calls++;return params.cursor?{data:[{id:'new',status:'completed',items:[{type:'agentMessage',text:'{"kind":"final"}'}]}]}:{data:[{id:'old'}],nextCursor:'page2'};}},'thread');assert.equal(calls,2);assert.deepEqual(completedTurnResult(turns[1]),{kind:'final'});assert.throws(()=>completedTurnResult({status:'inProgress'}),/确定完成/);
});

test('同 Run 执行器保留连接跨媒体等待，终态只开启一轮且只返回最终交付',async()=>{
  const {promises:fs}=await import('node:fs');const {executeCodex}=await import('../packages/production-service/src/codex-session.js');
  const x=setup(),root=mkdtempSync(join(tmpdir(),'codex-loop-'));
  try{
    const plugin=join(root,'plugin');await fs.mkdir(join(plugin,'skills-stages/render/production-coordinator'),{recursive:true});await fs.writeFile(join(plugin,'skills-stages/render/production-coordinator/SKILL.md'),'# 测试入口');
    const executable=join(root,'fake-codex.cjs');
    await fs.writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');if(process.argv.includes('--version')){console.log('fixture');process.exit(0)}let turns=[];const send=o=>console.log(JSON.stringify(o));rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='skills/list')result={data:[{skills:[{name:'production-coordinator',path:path.join(process.cwd(),'.agents/skills/production-coordinator/SKILL.md'),scope:'repo',enabled:true}]}]};if(m.method==='thread/start')result={thread:{id:'main'},model:'fixture'};if(m.method==='mcpServerStatus/list')result={data:[{tools:Object.fromEntries(['read_runtime_release','read_production_task','synthesize_speech_batch','verify_sentence_audio','render_template'].map(n=>[n,{name:n}]))}]};if(m.method==='mcpServer/tool/call')result={releaseId:'fixture-release'};if(m.method==='thread/turns/list')result={data:turns};if(m.method==='turn/start'){const id='turn-'+(turns.length+1),text=JSON.stringify(turns.length?{kind:'final',taskId:'test',runId:'run',inputDigest:'input',resultPath:'/tmp/result.json'}:{kind:'await_runtime',renderRequestId:'render'});if(turns.length){send({method:'item/completed',params:{threadId:'main',turnId:'turn-1',item:{type:'agentMessage',text:'过期'}}});send({method:'turn/completed',params:{threadId:'main',turn:{id:'turn-1',status:'completed'}}});}const turn={id,status:'completed',items:[{type:'agentMessage',text}]};turns.push(turn);fs.writeFileSync(path.join(process.cwd(),'turn-count'),String(turns.length));send({method:'item/completed',params:{threadId:'main',turnId:id,item:{type:'agentMessage',text}}});send({method:'turn/completed',params:{threadId:'main',turn}});result={turn:{id,status:'inProgress'}};}send({id:m.id,result});});\n`);await fs.chmod(executable,0o755);
    const config={codexHome:root,host:'localhost',port:1,pluginRoot:plugin,codexExecutable:executable,dependencyRoot:root,release:{releaseId:'fixture-release'}} as any;
    const execution=executeCodex(x.run,root,x.repo,config,x.abort.signal,x.media);
    for(let i=0;i<200&&!x.repo.get(x.run.runId).checkpoint.runtimeWait;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.state,'waiting_media');assert.equal(await fs.readFile(join(root,'turn-count'),'utf8'),'1');
    x.events.notify(mediaEventKey(x.run.runId,'render'));await new Promise(resolve=>setTimeout(resolve,20));assert.equal(await fs.readFile(join(root,'turn-count'),'utf8'),'1');
    x.job={...x.job,state:'succeeded'};x.events.notify(mediaEventKey(x.run.runId,'render'));x.events.notify(mediaEventKey(x.run.runId,'render'));
    const final=await execution;assert.equal(final.kind,'final');assert.equal(await fs.readFile(join(root,'turn-count'),'utf8'),'2');assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.resumeTurnId,'turn-2');
  }finally{x.abort.abort();x.close();await fs.rm(root,{recursive:true,force:true});}
});

test('启动响应未知仅认领唯一新增轮次，不能重放或把旧 final 当成新结果',async()=>{
  const {resolveStartedTurn}=await import('../packages/production-service/src/codex-session.js');
  assert.throws(()=>resolveStartedTurn([{id:'old'}],['old']),/禁止重发/);
  assert.throws(()=>resolveStartedTurn([{id:'a'},{id:'b'}],[]),/禁止重发/);
  assert.equal(resolveStartedTurn([{id:'old'},{id:'new',status:'inProgress'}],['old']).id,'new');
});
