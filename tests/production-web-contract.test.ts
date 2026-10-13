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
  const web={taskId:'web-1',templateId:'',introUrl:'',introIndex:0,outroUrl:'',outroIndex:0,dataList:[{id:'scene1',content:'原文。',dur:3,extraData:{}}]};
  assert.throws(()=>normalizeWebRender(web,repo.list('web','web-1')),/最新 Analysis/);
  repo.finish(run.runId,run.token,'succeeded',{dataList:[{id:'scene1',content:'原文。',dur:3}],context:'约束'});
  const event=repo.db.prepare('SELECT body FROM callback_outbox WHERE run_id=?').get(run.runId) as any;
  const body=JSON.parse(event.body);assert.equal(body.dataList[0].content,'原文。');assert.equal(body.dataInfo.templateId,'8');
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
