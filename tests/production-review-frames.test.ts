import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {reviewFixture,complete} from './helpers/production-review.js';
import {createProductionServer} from '../apps/server/src/production/routes.js';
import {templateFrames} from '../apps/render-worker/src/template-renderer.js';
import {json,writeJson,treeDigest} from '../packages/production-service/src/files.js';
import {reviewResultSummary} from '../packages/production-service/src/tool-results.js';

// 真实 HTTP、冻结、图片落盘和 SQLite；仅浏览器绘制使用确定性像素夹具。
test('整轮一次冻结与登记；登记失败/丢失确认只恢复原计划，部分绘图失败和取消保留成果',async()=>{
 const f=await reviewFixture();let bundles=0,draws=0,freezeCount=0,mode='normal';
 const backend:any={bundle:async()=>{bundles++;return 'fixture';},openBrowser:async()=>({close:async()=>{}}),selectComposition:async()=>({width:64,height:64,fps:24,durationInFrames:60}),renderFrames:async(o:any)=>{
  draws++;for(const frame of o.frames){const png=new PNG({width:64,height:64});png.data.fill(frame);await o.onFrameBuffer(PNG.sync.write(png),frame);if(mode==='failed')throw new Error('模拟中途失败');if(mode==='cancelled'){controller.abort();throw new Error('模拟取消');}}
 }};
 const config:any={dataRoot:join(f.root,'service'),dependencyRoot:process.cwd(),apiToken:'test',accountId:'test',callbackBase:'http://localhost',callbackSecret:'test',release:{releaseId:'fixture'},ready:{},mediaTiming:false};
 const service=await createProductionServer(config,undefined,{templateFrames:(run,root,input,options)=>templateFrames(run,root,input,{...options,onSourceFrozen:async digest=>{freezeCount++;await options.onSourceFrozen?.(digest);await fs.writeFile(join(root,'project','工作副本.md'),'冻结后继续创作');}},backend)});
 const controller=new AbortController();
 try{
  const v=await f.version('base','pre_export',t=>{t.totalFrames=60;t.scenes.forEach((s:any,i:number)=>{s.from=i*30;s.frames=30;});});
  service.repo.accept('test','analysis',{taskId:'round',content:'甲乙',otherRequirements:'',plugin:{customTemplateId:'test'}});const a=service.repo.claim()!;service.repo.finish(a.runId,a.token,'succeeded',{});
  service.repo.accept('test','render',{taskId:'round',basePlanVersion:a.planVersion,dataList:[{id:'s0',content:'甲'},{id:'s1',content:'乙'}],otherRequirements:''});const run=service.repo.claim()!;service.runner.active.set(run.runId,controller);
  const root=service.runner.runRoot(run);await fs.cp(v.project,join(root,'project'),{recursive:true});
  const call=async(name:string,payload:any)=>{const response=await service.app.inject({method:'POST',url:`/internal/tools/${name}`,headers:{'x-run-id':run.runId,'x-run-token':run.token!},payload});return {status:response.statusCode,body:response.json()};};
  const request={renderRequestId:'round',sourceDigest:await treeDigest(join(root,'project')),phase:'pre_export',timelineRef:'timeline.json',units:[{unitId:'one',sceneIds:['s0'],checks:[{checkId:'layout',purpose:'检查布局',frames:Array.from({length:26},(_,i)=>i)},{checkId:'caption',purpose:'检查字幕',frames:[0,25]}]}]};
  const prepare=service.reviews.prepare.bind(service.reviews);let fail=true;
  service.reviews.prepare=async(...args)=>{if(fail){fail=false;throw new Error('模拟登记故障');}return prepare(...args);};
  assert.equal((await call('prepare_review_frames',request)).status,200);
  const done=(await call('read_render_job',{renderRequestId:'round',waitMs:5000})).body;
  assert.equal(done.state,'succeeded',JSON.stringify(done));assert.equal(done.reviewPreparation.state,'failed');assert.equal(done.freezeState,'frozen');assert.equal(done.readyFrameCount,26);assert.equal(done.requestedFrameCount,26);assert.equal(done.readyFrames,undefined);assert.equal((await json(done.detailsRef)).readyFrames.length,26);
  assert.equal(bundles,1);assert.equal(draws,1);assert.equal(freezeCount,1);
  assert.equal(await treeDigest(join(root,'preview-snapshots/round/project')),request.sourceDigest);
  assert.equal((await call('prepare_review_frames',request)).body.reviewPreparation.state,'failed');assert.equal(draws,1);
  assert.equal((await call('prepare_review_frames',{...request,phase:'post_export'})).status,409);
  await call('retry_review_preparation',{renderRequestId:'round'});const retried=(await call('read_render_job',{renderRequestId:'round',waitMs:5000})).body;assert.equal(retried.reviewPreparation.state,'succeeded');assert.equal(draws,1);
  const reviewId=retried.reviewPreparation.reviewId;
  const summary=(await call('read_review',{reviewId})).body,details=(await call('read_review',{reviewId,details:true})).body;
  assert.equal(summary.requiredObservationCount,28);assert.equal(summary.remainingObservationCount,28);assert.equal(summary.units[0].evidence,undefined);assert.equal(details.units[0].evidence.length,26);assert.equal((await json(summary.detailsRef)).statusDigest,summary.statusDigest);
  const assigned=service.reviews.assign(run.runId,{reviewId,unitId:'one',reviewerAgentId:'fixture-agent',assignmentRequestId:'first'});
  service.reviews.submit(run.runId,{...complete(assigned),observations:complete(assigned).observations.slice(0,1),status:'partial'});
  const progressed=(await call('read_review',{reviewId,afterDigest:summary.statusDigest})).body;assert.equal(progressed.changed,true);assert.equal(progressed.completedObservationCount,1);assert.equal(progressed.remainingObservationCount,27);
  const timeout=(await call('read_review',{reviewId,afterDigest:progressed.statusDigest,waitMs:5})).body;assert.equal(timeout.changed,false);assert.equal(timeout.timedOut,true);
  // 模拟登记已提交但媒体 JSON 确认丢失，幂等恢复必须找回同一计划和已存观察。
  const path=join(root,'render-jobs/round.json'),job=await json(path);job.reviewPreparation={state:'running'};await writeJson(path,job);
  assert.equal((await call('read_render_job',{renderRequestId:'round'})).body.reviewPreparation.state,'unknown');
  await call('retry_review_preparation',{renderRequestId:'round'});assert.equal((await call('read_render_job',{renderRequestId:'round',waitMs:5000})).body.reviewPreparation.reviewId,reviewId);
  assert.equal(service.reviews.read(run.runId,reviewId).observationCount,1);assert.equal(service.repo.db.prepare('SELECT COUNT(*) n FROM reviews').get()?.n,1);assert.equal(draws,1);
  const mismatch={...request,renderRequestId:'wrong-source'};await call('prepare_review_frames',mismatch);
  const wrong=(await call('read_render_job',{renderRequestId:'wrong-source',waitMs:5000})).body;assert.equal(wrong.state,'failed');assert.equal(wrong.freezeState,'not_frozen');assert.equal(draws,1);
  for(const failure of ['failed','cancelled']){
   mode=failure;await call('prepare_review_frames',{...request,sourceDigest:undefined,renderRequestId:failure});
   const result=(await call('read_render_job',{renderRequestId:failure,waitMs:5000})).body;
   if(failure==='cancelled')await service.runner.settleTools(run.runId);
   const saved=await json(join(root,'render-jobs',`${failure}.json`));assert.equal(saved.state,failure);assert.equal(saved.readyFrames.length,1);assert.equal(saved.missingFrames.length,25);assert.ok(!saved.reviewPreparation.reviewId);
   if(failure==='failed')assert.equal((await call('retry_review_preparation',{renderRequestId:failure})).status,409);
  }
 }finally{await service.close();await f.close();}
});

test('摘要不遗漏问题、待复查项与完整差异；同证据跨单元计数独立',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const input=f.input('v1');input.units.push({...input.units[0],unitId:'duplicate-purpose'});const plan=await f.service.prepare(f.run,input);
  for(const unit of ['unit-0','duplicate-purpose']){const a=f.assign(plan.reviewId,unit);f.service.submit(f.run.runId,{...complete(a),issues:[{checkId:'meaning',evidenceId:a.evidence[0].evidenceId,severity:'warning',problem:'真实问题夹具'}]});}
  const result=f.service.read(f.run.runId,plan.reviewId);assert.equal(result.observationCount,4);
  const summary=await reviewResultSummary(f.root,result);assert.deepEqual(summary.issues,result.issues);
  await f.version('v2','pre_export',t=>{t.scenes[0].note='修改';});const next=await f.plan('v2'),short=await reviewResultSummary(f.root,next);
  assert.equal(short.pendingIssues.length,2);assert.deepEqual((await json(short.detailsRef)).changes,next.changes);
 }finally{await f.close();}
});
