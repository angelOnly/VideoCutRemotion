import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeWebAnalysis,normalizeWebRender } from '../packages/production-service/src/web-contract.js';
import { ProductionRepository } from '../packages/production-service/src/repository.js';
import { createProductionServer } from '../apps/server/src/production/routes.js';
import type { ProductionConfig } from '../packages/production-service/src/config.js';

test('网页两阶段归一化、回调及同请求去重',()=>{
 const repo=new ProductionRepository(join(mkdtempSync(join(tmpdir(),'web-contract-')),'tasks.sqlite'));
 try {
  const input=normalizeWebAnalysis({taskId:'web-1',content:'原文。',otherRequirements:'保持原文',plugin:{customTemplateId:'8',templateId:'',digitalHumanId:''},otherMaterial:{picInfoList:[],videoInfoList:[]}});
  const accepted=repo.accept('web','analysis',input),run=repo.claim()!;
  const web={taskId:'web-1',templateId:'',introUrl:'',introIndex:0,outroUrl:'',outroIndex:0,dataList:[{id:'scene1',content:'原文。'}]};
  assert.throws(()=>normalizeWebRender(web,repo.list('web','web-1')),/最新 Analysis/);
  repo.finish(run.runId,run.token,'succeeded',{dataList:[{id:'scene1',content:'原文。',dur:3}],context:'约束'});
  const event=repo.db.prepare('SELECT body FROM callback_outbox WHERE run_id=?').get(run.runId) as any;
  const body=JSON.parse(event.body);assert.equal(body.dataList[0].content,'原文。');assert.equal(body.dataInfo.templateId,'8');assert.equal(body.dataInfo.basePlanVersion,undefined);
  const render=normalizeWebRender(web,repo.list('web','web-1'));assert.equal(render.basePlanVersion,accepted.planVersion);assert.equal(render.otherRequirements,'保持原文');
  const first=repo.accept('web','render',render);assert.equal(repo.accept('web','render',normalizeWebRender(web,repo.list('web','web-1'))).runId,first.runId);
  assert.throws(()=>normalizeWebRender({...web,templateId:'9'},repo.list('web','web-1')),/冻结模板/);
  repo.accept('web','analysis',{...input,content:'另一版。'});
  assert.throws(()=>normalizeWebRender(web,repo.list('web','web-1')),/最新 Analysis/);
 } finally {repo.close();}
});
test('网页白名单只允许直连提交，不能伪造转发地址或调用管理接口',async()=>{
 const config={dataRoot:mkdtempSync(join(tmpdir(),'web-auth-')),apiToken:'secret',accountId:'web',callbackBase:'http://localhost',callbackSecret:'test',release:{},ready:{},webSubmitAddresses:['10.20.130.250']} as unknown as ProductionConfig;
 const service=await createProductionServer(config);
 const url='/narrate/ai_video_director/getAiVideoEditingAnalysisData',payload={taskId:'t',content:'测试',otherRequirements:'',plugin:{customTemplateId:'8'}};
 try {
  assert.equal((await service.app.inject({method:'POST',url,payload,remoteAddress:'10.20.130.250'})).statusCode,202);
  assert.equal((await service.app.inject({method:'POST',url,payload,remoteAddress:'10.20.130.251',headers:{'x-forwarded-for':'10.20.130.250'}})).statusCode,401);
  assert.equal((await service.app.inject({url:'/ai_video_director/tasks/t',remoteAddress:'10.20.130.250'})).statusCode,401);
 } finally {await service.close();}
});

test('Analysis HTTP 两栏可分别省略，缺省与显式空串归一化后复用同一请求',async()=>{
 const config={dataRoot:mkdtempSync(join(tmpdir(),'web-single-input-')),apiToken:'secret',accountId:'web',callbackBase:'http://localhost',callbackSecret:'test',release:{},ready:{},webSubmitAddresses:['10.20.130.250']} as unknown as ProductionConfig;
 const service=await createProductionServer(config);
 const post=(taskId:string,fields:Record<string,unknown>)=>service.app.inject({method:'POST',url:'/narrate/ai_video_director/getAiVideoEditingAnalysisData',remoteAddress:'10.20.130.250',payload:{taskId,plugin:{customTemplateId:'8'},...fields}});
 try{
  for(const [i,fields] of [{content:' 原文。\n'},{otherRequirements:' 需求。\n'},{content:'正文',otherRequirements:'要求'}].entries()){
   const taskId=`single-${i}`,response=await post(taskId,fields);assert.equal(response.statusCode,202,response.body);
   const expected={content:fields.content??'',otherRequirements:fields.otherRequirements??''};
   const saved=service.repo.get(response.json().data.runId).request as any;assert.equal(saved.content,expected.content);assert.equal(saved.otherRequirements,expected.otherRequirements);
   const repeated=await post(taskId,expected);assert.equal(repeated.json().data.runId,response.json().data.runId);
  }
  for(const fields of [{},{content:''},{otherRequirements:''},{content:' ',otherRequirements:'\n'}]){
   const response=await post('empty',fields);assert.equal(response.statusCode,400);assert.match(response.body,/至少一栏/);
  }
  assert.equal(service.repo.list('web','empty').length,0);
 }finally{await service.close();}
});

test('真实 HTTP 按原网页载荷接回可见标签，删除、换人、重排和同请求恢复落入保存请求',async()=>{
 const config={dataRoot:mkdtempSync(join(tmpdir(),'web-current-')),apiToken:'secret',accountId:'web',callbackBase:'http://localhost',callbackSecret:'test',release:{},ready:{},webSubmitAddresses:['10.20.130.250']} as unknown as ProductionConfig;
 const service=await createProductionServer(config);
 const post=(suffix:string,payload:Record<string,unknown>)=>service.app.inject({method:'POST',url:'/narrate/ai_video_director/'+suffix,payload,remoteAddress:'10.20.130.250'});
 try{
  const a=await post('getAiVideoEditingAnalysisData',{taskId:'t',content:'【室长】原稿。',otherRequirements:'语气平实',plugin:{customTemplateId:'8'}});assert.equal(a.statusCode,202);
  const run=service.repo.claim()!;service.repo.finish(run.runId,run.token,'succeeded',{dataList:[{id:'s1',content:'【室长】原稿。',dur:3,durationSource:'estimated'},{id:'deleted',content:'被删句。',dur:2,durationSource:'estimated'}],context:'原稿采用，保持语气平实'});
  const callback=JSON.parse((service.repo.db.prepare('SELECT body FROM callback_outbox WHERE run_id=?').get(run.runId) as any).body);
  assert.equal(callback.dataList[0].content,'【室长】原稿。');
  const payload={taskId:'t',templateId:'',introUrl:'',introIndex:0,outroUrl:'',outroIndex:0,dataList:[{id:'new',content:'【无口播：2秒】【画面：当前公司图表】',dur:3,extraData:{}},{id:'s1',content:'【财小策】改过（含括号）的稿。',dur:4,extraData:{keywordList:['公司']}}]};
  const r=await post('getAiVideoEditingData',payload);assert.equal(r.statusCode,202,r.body);
  const saved=service.repo.get(r.json().data.runId).request as any;
  assert.equal(saved.basePlanVersion,run.planVersion);assert.equal(saved.otherRequirements,'语气平实');assert.deepEqual(saved.dataList.map((s:any)=>s.id),['new','s1']);
  assert.equal(saved.dataList[0].content,'');assert.equal(saved.dataList[0].directing.durationSec,2);
  assert.equal(saved.dataList[1].submittedContent,payload.dataList[1].content);assert.equal(saved.dataList[1].content,'改过（含括号）的稿。');assert.equal(saved.dataList[1].directing.speechTurns[0].speakerId,'caixiaoce');
  const repeated=await post('getAiVideoEditingData',payload);assert.equal(repeated.json().data.runId,r.json().data.runId);
  const invalid=await post('getAiVideoEditingData',{...payload,dataList:[{id:'s1',content:'【室长'}]});assert.equal(invalid.statusCode,400);
  assert.equal(service.repo.list('web','t').length,2);
 }finally{await service.close();}
});
