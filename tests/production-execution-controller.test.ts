import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProductionRepository} from '../packages/production-service/src/repository.js';
import {ExecutionController,mediaEventKey,type RuntimeMediaState} from '../packages/production-service/src/execution-controller.js';
import {ProductionError,canonical,sha256} from '../packages/production-service/src/contracts.js';
import {MediaJobEvents} from '../packages/production-service/src/run-work.js';
import {createTurnReceiver,threadDiscoveries} from '../packages/production-service/src/turn-events.js';
import {readThreadTurns,completedTurnResult,handoffSchema} from '../packages/production-service/src/codex-session.js';
function setup(){
  const root=mkdtempSync(join(tmpdir(),'wait-controller-')),repo=new ProductionRepository(join(root,'tasks.sqlite'));
  repo.accept('a','analysis',{taskId:'test',content:'正文',otherRequirements:'',plugin:{customTemplateId:'x'}});const a=repo.claim()!;repo.finish(a.runId,a.token,'succeeded',{});
  repo.accept('a','render',{taskId:'test',basePlanVersion:1,otherRequirements:'',dataList:[{id:'s',content:'正文'}]});let run=repo.claim()!;run=repo.checkpoint(run.runId,run.token!,{release:{releaseId:'fixture-release'},template:{digest:'template'}});
  const input={previewOnly:false,timelineRef:'timeline.json',checks:['已观察静帧；未连续看听']};
  const deliveryPath=join(root,'delivery.json');
  writeFileSync(deliveryPath,JSON.stringify({taskId:run.taskId,runId:run.runId,inputDigest:run.inputDigest,templateDigest:'template',renderRequestId:'render',sourceDigest:'source',timelineRef:input.timelineRef,checks:input.checks,files:['whole-video','s'].map(id=>({id,content:'正文',file:join(root,id+'.mp4'),sha256:'hash',dur:1,fromFrame:0,toFrame:30,width:100,height:100,fps:30}))}));
  let job:RuntimeMediaState={runId:run.runId,id:'render',state:'running',kind:'template-render',input,releaseId:'fixture-release',deliveryPath,attempt:1,inputDigest:sha256(canonical({kind:'template-render',input})),sourceDigest:'source'},reads=0;
  const events=new MediaJobEvents(),abort=new AbortController();
  const media={events,read:async()=>{reads++;return {...job};}};
  const controller=new ExecutionController(run,repo,media,abort.signal,5,root);
  return {root,repo,run,events,abort,controller,media,get reads(){return reads;},get job(){return job;},set job(value){job=value;},close(){repo.close();rmSync(root,{recursive:true,force:true});}};
}
const waitResult={kind:'await_runtime',renderRequestId:'render'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('模型输出根节点为严格对象，等待与最终交付仅在 result 内分支',()=>{
  const schema=handoffSchema as any;
  assert.equal(schema.type,'object');assert.equal(schema.anyOf,undefined);
  assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,['result']);
  assert.equal(schema.properties.result.anyOf.length,2);
  for(const branch of schema.properties.result.anyOf){assert.equal(branch.type,'object');assert.equal(branch.additionalProperties,false);assert.deepEqual(new Set(branch.required),new Set(Object.keys(branch.properties)));}
  assert.throws(()=>completedTurnResult({status:'completed',items:[{type:'agentMessage',text:JSON.stringify(waitResult)}]}));
});
test('明确失败、重复终态和心跳交错只允许一次续接',async()=>{
  const x=setup();try{x.job={...x.job,state:'failed'};const result=await x.controller.wait('thread','first',waitResult);assert.equal(result?.kind,'resume');if(result?.kind!=='resume')throw new Error('预期失败续接');assert.equal(result.wait.state,'resuming');assert.match(result.message,/明确失败/);x.repo.heartbeat(x.run.runId,x.run.token!);x.controller.bind(result!.wait,'second');assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.resumeTurnId,'second');assert.throws(()=>x.controller.bind(result!.wait,'duplicate'),/检查点/);await assert.rejects(x.controller.wait('thread','second',waitResult),/已接回/);}finally{x.close();}
});
test('普通进度与漏通知仅核对原作业，终态才接回',async()=>{
  const x=setup();try{let woken=false;const pending=x.controller.wait('thread','first',waitResult).then(v=>{woken=true;return v;});await tick();x.events.notify(mediaEventKey(x.run.runId,'render'));await tick();assert.equal(woken,false);assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.state,'waiting_media');x.job={...x.job,state:'succeeded'};const result=await pending;assert.equal(result?.wait.terminalState,'succeeded');assert.ok(x.reads>=3);}finally{x.close();}
});
test('取消与未知不唤醒模型，重试代次和快照变化不串作业',async()=>{
  for(const state of ['cancelled','unknown','attempt','snapshot'] as const){const x=setup();try{const pending=x.controller.wait('thread','first',waitResult);await tick();if(state==='attempt')x.job={...x.job,attempt:2};else if(state==='snapshot')x.job={...x.job,sourceDigest:'changed'};else x.job={...x.job,state};x.events.notify(mediaEventKey(x.run.runId,'render'));await assert.rejects(pending);assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.state,'waiting_media');}finally{x.close();}}
  const x=setup();try{const pending=x.controller.wait('thread','first',waitResult);await tick();x.abort.abort();await assert.rejects(pending,/取消/);}finally{x.close();}
});
test('服务重启保留原失败续接记录；已发起未知不得再启动',async()=>{
  const x=setup();try{x.job={...x.job,state:'failed'};const result=await x.controller.wait('thread','first',waitResult);const restart=new ExecutionController(x.run,x.repo,x.media,new AbortController().signal);await assert.rejects(restart.wait('thread','first',waitResult),/先核查/);assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.waitId,result!.wait.waitId);}finally{x.close();}
});
test('新 turn 响应之前的事件缓冲，旧 final 和子线程不能冒充续接',async()=>{
  const receive=createTurnReceiver('main');const emit=(id:string,text:string)=>receive.observe({method:'item/completed',params:{threadId:'main',turnId:id,item:{type:'agentMessage',text}}});
  emit('old','错误');receive.observe({method:'turn/completed',params:{threadId:'main',turn:{id:'old',status:'completed'}}});emit('new','正确');receive.observe({method:'turn/completed',params:{threadId:'main',turn:{id:'new',status:'completed'}}});receive.bind('new');assert.equal((await receive.promise).text,'正确');
});
test('子代理 activity 和真实 thread/started 都归一化',()=>{
  assert.deepEqual(threadDiscoveries({method:'item/completed',params:{threadId:'main',item:{type:'subAgentActivity',agentThreadId:'author'}}}),[{threadId:'author',parentThreadId:'main',source:'subAgentActivity'}]);
});
test('恢复通过分页读取完整轮次，只接受明确完成输出',async()=>{
  let calls=0;const turns=await readThreadTurns({call:async(method:string,params:any)=>{assert.equal(method,'thread/turns/list');assert.equal(params.itemsView,'full');calls++;return params.cursor?{data:[{id:'new',status:'completed',items:[{type:'agentMessage',text:'{"result":{"kind":"await_runtime","renderRequestId":"render"}}'}]}]}:{data:[{id:'old'}],nextCursor:'page2'};}},'thread');assert.equal(calls,2);assert.deepEqual(completedTurnResult(turns[1]),waitResult);assert.throws(()=>completedTurnResult({status:'inProgress'}),/确定完成/);
});

for(const invalidPreview of [false,true])test(invalidPreview?'错误等待参数反馈原线程，原媒体继续执行并在纠正后接回':'同 Run 正式媒体成功直接交付，不开启搬清单模型轮次',async()=>{
  const {promises:fs}=await import('node:fs');const {executeCodex}=await import('../packages/production-service/src/codex-session.js');
  const x=setup(),root=x.root;
  try{
    const plugin=join(root,'plugin');await fs.mkdir(join(plugin,'skills-stages/render/production-coordinator'),{recursive:true});await fs.writeFile(join(plugin,'skills-stages/render/production-coordinator/SKILL.md'),'# 测试入口');
    const executable=join(root,'fake-codex.cjs');
    await fs.writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');if(process.argv.includes('--version')){console.log('fixture');process.exit(0)}let turns=fs.existsSync(path.join(process.cwd(),'turns.json'))?JSON.parse(fs.readFileSync(path.join(process.cwd(),'turns.json'),'utf8')):[];const send=o=>console.log(JSON.stringify(o));rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='skills/list')result={data:[{skills:[{name:'production-coordinator',path:path.join(process.cwd(),'.agents/skills/production-coordinator/SKILL.md'),scope:'repo',enabled:true}]}]};if(m.method==='thread/start'){if(m.params.config.features.plugins!==false||!process.argv.includes('features.plugins=false')){send({id:m.id,error:{code:-32600,message:'未关闭晚到插件自动发现'}});return;}result={thread:{id:'main'},model:'fixture'};}if(m.method==='mcpServerStatus/list')result={data:[{tools:Object.fromEntries(['read_runtime_release','read_production_task','synthesize_speech_batch','assemble_sentence_audio','verify_sentence_audio','prepare_review','read_review','render_template'].map(n=>[n,{name:n}]))}]};if(m.method==='mcpServer/tool/call')result={releaseId:'fixture-release'};if(m.method==='thread/turns/list'){if(!turns.length){send({id:m.id,error:{code:-32600,message:'thread is not materialized yet; thread/turns/list is unavailable before first user message'}});return;}result={data:turns};}if(m.method==='turn/start'){if(m.params.outputSchema.type!=='object'||m.params.outputSchema.anyOf){send({id:m.id,error:{code:-32600,message:'输出Schema根节点必须是对象'}});return;}const id='turn-'+(turns.length+1),text=JSON.stringify({result:turns.length>=(${invalidPreview}?2:1)?{kind:'final',taskId:'test',runId:'run',inputDigest:'input',resultPath:'/tmp/result.json'}:{kind:'await_runtime',renderRequestId:'render'}});if(turns.length){send({method:'item/completed',params:{threadId:'main',turnId:'turn-1',item:{type:'agentMessage',text:'过期'}}});send({method:'turn/completed',params:{threadId:'main',turn:{id:'turn-1',status:'completed'}}});}const turn={id,status:'completed',items:[{type:'agentMessage',text}]};turns.push(turn);fs.writeFileSync(path.join(process.cwd(),'turns.json'),JSON.stringify(turns));fs.writeFileSync(path.join(process.cwd(),'turn-count'),String(turns.length));send({method:'item/completed',params:{threadId:'main',turnId:id,item:{type:'agentMessage',text}}});send({method:'turn/completed',params:{threadId:'main',turn}});result={turn:{id,status:'inProgress'}};}send({id:m.id,result});});\n`);await fs.chmod(executable,0o755);
    const config={codexHome:root,host:'localhost',port:1,pluginRoot:plugin,codexExecutable:executable,dependencyRoot:root,release:{releaseId:'fixture-release'}} as any;
    let corrected=false;const media={...x.media,read:async()=>{if(invalidPreview&&!corrected){corrected=true;throw new ProductionError('WAIT_JOB_INVALID','静帧不属于正式导出');}return x.media.read();}};
    const execution=executeCodex(x.run,root,x.repo,config,x.abort.signal,media);
    for(let i=0;i<200&&!x.repo.get(x.run.runId).checkpoint.runtimeWait;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.state,'waiting_media');assert.equal(await fs.readFile(join(root,'turn-count'),'utf8'),invalidPreview?'2':'1');
    x.events.notify(mediaEventKey(x.run.runId,'render'));await new Promise(resolve=>setTimeout(resolve,20));assert.equal(await fs.readFile(join(root,'turn-count'),'utf8'),invalidPreview?'2':'1');
    x.job={...x.job,state:'succeeded'};x.events.notify(mediaEventKey(x.run.runId,'render'));x.events.notify(mediaEventKey(x.run.runId,'render'));
    const final=await execution;assert.equal(final.kind,'final');assert.equal(await fs.readFile(join(root,'turn-count'),'utf8'),invalidPreview?'2':'1');assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.state,'handed_off');assert.equal(final.resultPath,x.job.deliveryPath);assert.equal(x.repo.get(x.run.runId).checkpoint.handoff.resultPath,x.job.deliveryPath);
    if(!invalidPreview){
      // 完成 await_runtime 后、服务登记前中断；原主轮次足以确认目标，子作者无需重启。
      x.repo.checkpoint(x.run.runId,x.run.token!,{handoff:null,runtimeWait:null,codex:{threadIds:['main','original-author']}});
      const recovered=await executeCodex(x.repo.get(x.run.runId),root,x.repo,config,x.abort.signal,media);
      assert.equal(recovered.resultPath,x.job.deliveryPath);assert.equal(await fs.readFile(join(root,'turn-count'),'utf8'),'1');
    }
  }finally{x.abort.abort();x.close();await fs.rm(root,{recursive:true,force:true});}
});

test('启动响应未知仅认领唯一新增轮次，不能重放或把旧 final 当成新结果',async()=>{
  const {resolveStartedTurn}=await import('../packages/production-service/src/codex-session.js');
  assert.throws(()=>resolveStartedTurn([{id:'old'}],['old']),/禁止重发/);
  assert.throws(()=>resolveStartedTurn([{id:'a'},{id:'b'}],[]),/禁止重发/);
  assert.equal(resolveStartedTurn([{id:'old'},{id:'new',status:'inProgress'}],['old']).id,'new');
});

test('成功原清单与转交标记同事务保存，重复读取不增加轮次或改写文件',async()=>{
  const x=setup();try{
    x.job={...x.job,state:'succeeded'};
    const result=await x.controller.wait('main','turn',waitResult);assert.equal(result?.kind,'handoff');
    const saved=x.repo.get(x.run.runId).checkpoint;assert.equal(saved.runtimeWait.state,'handed_off');assert.equal(saved.handoff.resultPath,x.job.deliveryPath);
    const again=await new ExecutionController(x.run,x.repo,x.media,x.abort.signal,5,x.root).wait('main','turn',waitResult);
    assert.deepEqual(again,result);await x.controller.validateTransferred();
    x.job={...x.job,attempt:2};await assert.rejects(x.controller.validateTransferred(),/身份变化/);
  }finally{x.close();}
});

test('原清单缺失、损坏、身份不符明确失败，临时读取故障保留原等待',async()=>{
  const {promises:fs}=await import('node:fs');
  for(const fault of ['missing','json','shape','run','template','source','checks','outside','io'] as const){const x=setup();try{
    x.job={...x.job,state:'succeeded'};
    const original=JSON.parse(await fs.readFile(x.job.deliveryPath!,'utf8'));
    if(fault==='missing')await fs.unlink(x.job.deliveryPath!);
    else if(fault==='json')await fs.writeFile(x.job.deliveryPath!,'坏 JSON');
    else if(fault==='shape')await fs.writeFile(x.job.deliveryPath!,'{}');
    else if(fault==='outside')x.job={...x.job,deliveryPath:join(x.root,'..','outside.json')};
    else if(fault==='io')x.job={...x.job,deliveryPath:join(x.job.deliveryPath!,'child.json')};
    else {const field={run:'runId',template:'templateDigest',source:'sourceDigest',checks:'checks'}[fault];await fs.writeFile(x.job.deliveryPath!,JSON.stringify({...original,[field]:fault==='checks'?['伪造听审通过']:fault==='run'?'00000000-0000-4000-8000-000000000000':'wrong'}));}
    await assert.rejects(x.controller.wait('main','turn',waitResult),error=>fault==='io'?(error as NodeJS.ErrnoException).code==='ENOTDIR':error instanceof ProductionError);
    const saved=x.repo.get(x.run.runId).checkpoint;assert.equal(saved.runtimeWait.state,'waiting_media');assert.equal(saved.handoff,undefined);
  }finally{x.close();}}
});

test('预览、跨 Run、错发行与输入摘要不能登记为正式待交付目标',async()=>{
  for(const fault of ['preview','frame','run','release','digest'] as const){const x=setup();try{
    x.job={...x.job,state:'succeeded',...(fault==='preview'?{input:{...x.job.input,previewOnly:true}}:fault==='frame'?{kind:'frame-preview'}:fault==='run'?{runId:'other'}:fault==='release'?{releaseId:'other'}:{inputDigest:'other'})};
    await assert.rejects(x.controller.wait('main','turn',waitResult));assert.equal(x.repo.get(x.run.runId).checkpoint.handoff,undefined);
  }finally{x.close();}}
});

test('事务提交前取消或等待变化不能保存半份 handoff',async()=>{
  for(const fault of ['cancel','replace','transaction'] as const){const x=setup();try{
    x.job={...x.job,state:'succeeded'};
    const commit=x.repo.handoffRuntime.bind(x.repo);
    x.repo.handoffRuntime=(id,token,expected,wait,handoff)=>{
      if(fault==='cancel')x.repo.cancel(id,'a');
      else if(fault==='replace')x.repo.checkpoint(id,token,{runtimeWait:{waitId:'other'}});
      else x.repo.db.exec("CREATE TRIGGER reject_handoff BEFORE UPDATE OF checkpoint ON runs WHEN json_extract(NEW.checkpoint,'$.handoff') IS NOT NULL BEGIN SELECT RAISE(ABORT,'模拟交接事务中断'); END;");
      return commit(id,token,expected,wait,handoff);
    };
    await assert.rejects(x.controller.wait('main','turn',waitResult));const saved=x.repo.get(x.run.runId).checkpoint;
    assert.equal(saved.handoff,undefined);assert.notEqual(saved.runtimeWait.state,'handed_off');
  }finally{x.close();}}
});

test('源码摘要首次可读后立即绑定，等待中后续改动不能被成功状态覆盖',async()=>{
  const x=setup();try{
    x.job={...x.job,sourceDigest:undefined};const pending=x.controller.wait('main','turn',waitResult);await tick();
    x.job={...x.job,sourceDigest:'first'};x.events.notify(mediaEventKey(x.run.runId,'render'));await tick();assert.equal(x.repo.get(x.run.runId).checkpoint.runtimeWait.sourceDigest,'first');
    x.job={...x.job,sourceDigest:'second',state:'succeeded'};x.events.notify(mediaEventKey(x.run.runId,'render'));await assert.rejects(pending,/快照已变化/);
  }finally{x.close();}
});


test('取消先于成功结果事务时不生成成功回调，原 outbox 保持唯一',()=>{
  const x=setup();try{
    x.repo.cancel(x.run.runId,'a');assert.throws(()=>x.repo.finish(x.run.runId,x.run.token,'succeeded',{}),/取消先于结果事务/);
    assert.equal(x.repo.db.prepare('SELECT id FROM callback_outbox WHERE run_id=?').get(x.run.runId),undefined);
    x.repo.finish(x.run.runId,x.run.token,'cancelled');x.repo.finish(x.run.runId,x.run.token,'cancelled');
    assert.equal((x.repo.db.prepare('SELECT count(*) AS n FROM callback_outbox WHERE run_id=?').get(x.run.runId) as any).n,1);
  }finally{x.close();}
});
