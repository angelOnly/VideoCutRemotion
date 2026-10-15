import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MediaBudget } from '../packages/production-service/src/run-work.js';
import { registerProductionTools } from '../apps/server/src/production/speech-tools.js';
import { createProductionServer } from '../apps/server/src/production/routes.js';
import { speechBatchSummary } from '../packages/production-service/src/tool-results.js';
import type { ProductionConfig } from '../packages/production-service/src/config.js';
import { treeDigest } from '../packages/production-service/src/files.js';
import { renderTemplate } from '../apps/render-worker/src/template-renderer.js';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise<void>(done=>setImmediate(done));

test('四个 Run 共用加权绘图预算，失败、排队取消后释放并轮转',async()=>{
  const budget=new MediaBudget(8,2),gates=Array.from({length:8},deferred),started:number[]=[];let peak=0;
  const jobs=gates.map((gate,index)=>budget.withDrawing(`run-${index%4}`,4,undefined,async()=>{started.push(index);peak=Math.max(peak,budget.active.drawing);await gate.promise;if(index===0)throw new Error('注入失败');}));
  const settled=Promise.allSettled(jobs);await tick();assert.deepEqual(started,[0,1]);assert.equal(peak,8);
  const controller=new AbortController();const cancelled=budget.withDrawing('cancel',4,controller.signal,async()=>assert.fail('取消后不应启动'));controller.abort();await assert.rejects(cancelled,/取消/);
  gates[0].resolve();await tick();assert.deepEqual(started,[0,1,2]);
  for(const gate of gates)gate.resolve();const results=await settled;assert.equal(results[0].status,'rejected');assert.equal(started.length,8);assert.equal(peak,8);assert.deepEqual(budget.active,{drawing:0,processes:0});
  await assert.rejects(budget.withDrawing('invalid',9,undefined,async()=>{}),/额度/);
  const gate=deferred();const processJobs=[0,1,2,3].map(i=>budget.withProcess(String(i),undefined,async()=>{assert.ok(budget.active.processes<=2);await gate.promise;}));await tick();assert.equal(budget.active.processes,2);gate.resolve();await Promise.all(processJobs);assert.equal(budget.active.processes,0);
});

test('Analysis MCP 实际发现仅只读事实，不能调用配音或渲染',async()=>{
  const server=new McpServer({name:'阶段测试',version:'1'}),client=new Client({name:'测试',version:'1'});let calls=0;
  registerProductionTools(server,async()=>{calls++;return {stage:'analysis'};},'analysis');
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  try{assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['read_production_task']);
    const denied=await client.callTool({name:'render_template',arguments:{}});assert.equal(denied.isError,true);assert.equal(calls,0);
    assert.notEqual((await client.callTool({name:'read_production_task',arguments:{}})).isError,true);assert.equal(calls,1);
  }finally{await client.close();await server.close();}
});

test('服务拒绝 Analysis 制作调用；媒体等待读取原身份并返回摘要',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'stage-wait-')),gate=deferred();let options:any;
  const config={dataRoot:root,accountId:'test',apiToken:'test',callbackBase:'http://127.0.0.1',callbackSecret:'test',ready:{},release:{},voicesPath:'',renderStrategy:'scene-chunks',mediaGlobalConcurrency:8} as unknown as ProductionConfig;
  const service=await createProductionServer(config,undefined,{renderTemplate:async(_run,_root,_input,opt)=>{options=opt;await gate.promise;return {deliveryPath:'delivery.json',delivery:{} as any};}});
  const call=(run:any,name:string,payload:any={})=>service.app.inject({method:'POST',url:`/internal/tools/${name}`,headers:{'x-run-id':run.runId,'x-run-token':run.token},payload});
  try{
    service.repo.accept('test','analysis',{taskId:'a',content:'正文',otherRequirements:'',plugin:{customTemplateId:'x'}});const analysis=service.repo.claim()!;
    for(const tool of ['synthesize_speech','read_speech_batch','assemble_sentence_audio','verify_sentence_audio','render_template','retry_render_slices'])assert.equal((await call(analysis,tool)).statusCode,403,tool);
    service.repo.checkpoint(analysis.runId,analysis.token!,{template:{root:'/private/render',manifest:{entry:'secret.tsx',templateVersion:'1'},analysisContract:{digest:'text',files:[]}}});
    const facts=(await call(analysis,'read_production_task')).json();assert.equal(facts.stage,'analysis');assert.ok(!JSON.stringify(facts).includes('secret.tsx'));assert.ok(!JSON.stringify(facts).includes('/private/render'));
    service.repo.finish(analysis.runId,analysis.token,'succeeded',{});
    service.repo.accept('test','render',{taskId:'a',basePlanVersion:1,dataList:[{id:'s',content:'正文'}],otherRequirements:''});const run=service.repo.claim()!;service.runner.active.set(run.runId,new AbortController());
    const project=join(service.runner.runRoot(run),'project');await fs.mkdir(project,{recursive:true});await fs.writeFile(join(project,'timeline.json'),'{}');
    const preview={renderRequestId:'preview',timelineRef:'timeline.json',ranges:[{id:'s',fromFrame:0,toFrame:30}],checks:[],previewOnly:true};
    assert.equal((await call(run,'render_template',preview)).statusCode,400);
    const pending=(await call(run,'render_template',{...preview,previewRequests:[{sourceDigest:await treeDigest(project),question:'检查过渡',fromFrame:0,toFrame:30,consumer:'观察者',passCriteria:'无遮挡',needsVideo:true,needsAudio:false,continuousVideoAvailable:false,continuousAudioAvailable:false}]})).json();
    assert.equal(pending.state,'not_started');assert.deepEqual(pending.decisions,['professional_review_pending']);assert.equal(options,undefined);assert.equal((await fs.stat(pending.decisionRef)).isFile(),true);
    const submitted=(await call(run,'render_template',{renderRequestId:'original',timelineRef:'timeline.json',checks:[]})).json();
    assert.equal(submitted.renderStrategy,'scene-chunks');assert.equal(submitted.input,undefined);
    const startedAt=Date.now();while(!options){assert.ok(Date.now()-startedAt<5000,'异步作业未进入渲染器');await new Promise(done=>setTimeout(done,10));}
    const first=(await call(run,'read_render_job',{renderRequestId:'original'})).json();
    const wait=call(run,'read_render_job',{renderRequestId:'original',afterDigest:first.statusDigest,waitMs:1000});await tick();
    await (options as any).onChunkReady({id:'s',fromFrame:0,toFrame:30,path:'chunk',sha256:'sha',sourceDigest:'digest',parametersDigest:'parameters',width:10,height:10,fps:30});
    const changed=(await wait).json();assert.notEqual(changed.statusDigest,first.statusDigest);assert.equal(changed.completedChunks[0].id,'s');assert.equal(changed.id,'original');
    const timed=await call(run,'read_render_job',{renderRequestId:'original',afterDigest:changed.statusDigest,waitMs:10});assert.equal(timed.json().state,'running');
    gate.resolve();await service.runner.settleTools(run.runId);assert.equal((await call(run,'read_render_job',{renderRequestId:'original',waitMs:1000})).json().state,'succeeded');
  }finally{gate.resolve();await service.close();await fs.rm(root,{recursive:true,force:true});}
});

test('配音摘要保留完整原响应引用且不反复展开正文',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'speech-summary-'));
  try{const raw={id:'b',runId:'r',state:'partial',total:2,counts:{succeeded:1,unknown:1},jobs:[{id:'1',state:'succeeded',request:{segmentId:'s',text:'长正文'},audioRef:'audio.mp3'},{id:'2',state:'unknown',request:{segmentId:'t'},diagnostic:'原请求状态不明'}]};
    const result=await speechBatchSummary(root,raw);assert.equal((result as any).jobs,undefined);assert.equal(result.issues[0].diagnostic,'原请求状态不明');assert.deepEqual(JSON.parse(await fs.readFile(result.detailsRef,'utf8')),raw);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('预览冻结后再次绑定疑点版本，排队期间源码变化不能沿用旧检查请求',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'preview-freeze-'));
  try{
    const project=join(root,'project');await fs.mkdir(project);await fs.writeFile(join(project,'timeline.json'),'旧版');const oldDigest=await treeDigest(project);await fs.writeFile(join(project,'timeline.json'),'新版');
    await assert.rejects(renderTemplate({stage:'render',state:'running'} as any,root,{runId:'00000000-0000-4000-8000-000000000010',renderRequestId:'p',timelineRef:'timeline.json',ranges:[{id:'s',fromFrame:0,toFrame:1}],checks:[],previewOnly:true,previewRequests:[{sourceDigest:oldDigest,question:'检查旧版',fromFrame:0,toFrame:1,consumer:'观察者',passCriteria:'正确',needsVideo:true,needsAudio:false,continuousVideoAvailable:true,continuousAudioAvailable:false}]},{dependencyRoot:root,concurrency:1}),/冻结版本与检查疑点不同/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
