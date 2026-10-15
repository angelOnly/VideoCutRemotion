import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {reviewFixture,complete,observations,code} from './helpers/production-review.js';
import {missingRanges} from '../packages/production-service/src/review-service.js';
import {sha256} from '../packages/production-service/src/contracts.js';
import {writeJson} from '../packages/production-service/src/files.js';

test('协调者指定检查目的与范围；准备幂等且不创建审片线程',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const plan=await f.plan('v1');assert.equal(plan.total,2);assert.deepEqual(plan.units[0].checks.map((c:any)=>c.checkId),['meaning']);assert.equal(plan.requiredObservationCount,4);
  assert.equal((f.repo.db.prepare('SELECT COUNT(*) n FROM review_sessions').get() as any).n,0);assert.equal((await f.plan('v1')).reviewId,plan.reviewId);
  await assert.rejects(f.service.prepare(f.run,{renderRequestIds:['v1'],phase:'pre_export'}));
  const wrong=f.input('v1');wrong.units[0].checks[0].evidence[0].frame=9;await assert.rejects(f.service.prepare(f.run,wrong),code('REVIEW_MODE_INVALID'));
 }finally{await f.close();}
});

test('分派请求幂等、互斥接替且保留部分观察；完成不自动领取下一包',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const plan=await f.plan('v1'),request={reviewId:plan.reviewId,unitId:'unit-0',reviewerAgentId:'native-a',assignmentRequestId:'assignment-a'};
  const a=f.service.assign(f.run.runId,request);assert.equal(f.service.assign(f.run.runId,request).assignmentToken,a.assignmentToken);assert.equal(a.provenance,'coordinator_reported');
  assert.throws(()=>f.service.assign(f.run.runId,{...request,reviewerAgentId:'other'}),code('REVIEW_ASSIGNMENT_CONFLICT'));
  const first={...complete(a),observations:observations(a).slice(0,1)};assert.equal(f.service.submit(f.run.runId,first).status,'partial');
  assert.throws(()=>f.assign(plan.reviewId),code('REVIEW_ASSIGNMENT_STALE'));
  const b=f.service.assign(f.run.runId,{...request,assignmentRequestId:'assignment-b',reviewerAgentId:'native-b',previousAssignmentToken:a.assignmentToken,reason:'原生宿主报告旧代理失联'});
  assert.equal(b.observations.length,1);assert.equal(b.remaining[0].evidenceIds?.length,1);
  const late=f.service.submit(f.run.runId,complete(a));assert.equal(late.accepted,false);assert.deepEqual(f.service.submit(f.run.runId,complete(a)),late);
  const done=f.service.submit(f.run.runId,complete(b));assert.equal(done.status,'complete');assert.equal(done.next,null);assert.deepEqual(f.service.submit(f.run.runId,complete(b)),done);
  const current=f.service.read(f.run.runId,plan.reviewId);assert.equal(current.units[1].state,'pending');assert.equal(current.units[1].assignmentToken,null);
  assert.equal(f.service.assign(f.run.runId,request).active,false);
 }finally{await f.close();}
});

test('观察不跨检查目的填充，问题必须有实际观察依据',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const input=f.input('v1');input.units[0].checks.push({...input.units[0].checks[0],checkId:'reading',purpose:'阅读是否清楚'});
  const plan=await f.service.prepare(f.run,input),a=f.assign(plan.reviewId),evidenceId=a.evidence[0].evidenceId;
  const issue={checkId:'reading',evidenceId,severity:'warning',problem:'测试问题'};
  assert.throws(()=>f.service.submit(f.run.runId,{...complete(a),observations:[],issues:[issue]}),code('REVIEW_ISSUE_UNOBSERVED'));
  const partial=f.service.submit(f.run.runId,{...complete(a),observations:observations(a).filter(o=>o.checkId==='meaning')});assert.equal(partial.status,'partial');assert.deepEqual(partial.remaining.map((r:any)=>r.checkId),['reading']);
  assert.equal(f.service.submit(f.run.runId,{...complete(a),issues:[issue]}).status,'complete');assert.equal(f.service.read(f.run.runId,plan.reviewId).issues.length,1);
 }finally{await f.close();}
});

test('新版不自动复用；协调者显式复用只接受同一图片和目的的原观察，问题保留',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const first=await f.plan('v1'),a=f.assign(first.reviewId);const e=a.evidence[0].evidenceId;
  f.service.submit(f.run.runId,{...complete(a),issues:[{checkId:'meaning',evidenceId:e,severity:'warning',problem:'待复查问题'}]});
  await f.version('v2','pre_export',t=>{t.scenes[1].note='作者改动';});const second=await f.plan('v2');assert.equal(second.reusedCount,0);assert.equal(second.pendingIssues.length,1);assert.ok(second.changes.changedScenes.some((s:any)=>s.sceneId==='s1'));assert.ok(!JSON.stringify(second.changes).includes('checkIds'));
  const request={...f.input('v2'),reuse:[{sourceReviewId:first.reviewId,unitId:'unit-0',checkId:'meaning',evidenceId:e,reason:'已核对本图关系与上下文不受本次改动影响'}]};
  const reused=await f.service.prepare(f.run,request);assert.equal(reused.reusedCount,1);assert.equal(reused.pendingIssues.length,1);assert.equal(reused.units[0].observations.length,0);
  const late=f.service.submit(f.run.runId,{...complete(a),observations:[]});assert.equal(late.accepted,false);
  assert.equal((await f.plan('v1')).state,'superseded');assert.equal(f.service.read(f.run.runId,reused.reviewId).state,'active');
  const bad={...request,reuse:[{...request.reuse[0],evidenceId:'not-observed'}]};await assert.rejects(f.service.prepare(f.run,bad),code('REVIEW_REUSE_INVALID'));
 }finally{await f.close();}
});

test('问题闭环需新观察；换检查单元后未处置问题仍可追溯',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const first=await f.plan('v1'),a=f.assign(first.reviewId),evidenceId=a.evidence[0].evidenceId;
  f.service.submit(f.run.runId,{...complete(a),issues:[{checkId:'meaning',evidenceId,severity:'blocking',problem:'原问题'}]});
  await f.version('v2','pre_export',t=>{t.scenes[0].note='修订';});const plan=await f.plan('v2'),b=f.assign(plan.reviewId),issueId=plan.pendingIssues[0].issueId;
  assert.throws(()=>f.service.submit(f.run.runId,{...complete(b),observations:[],issueResolutions:[{issueId,evidenceId,resolution:'resolved',note:'无观察不接收'}]}),code('REVIEW_ISSUE_UNOBSERVED'));
  f.service.submit(f.run.runId,{...complete(b),issueResolutions:[{issueId,evidenceId,resolution:'resolved',note:'本次复查已修正'}]});assert.equal(f.service.read(f.run.runId,plan.reviewId).pendingIssues.length,0);
 }finally{await f.close();}
});

test('冻结工程与证据篡改、跨版本混用、跨任务分派拒绝',async()=>{
 const f=await reviewFixture();try{
  const first=await f.version('v1');await f.version('v2','pre_export',t=>{t.scenes[0].note='不同版本';});
  await assert.rejects(f.service.prepare(f.run,{...f.input('v1'),renderRequestIds:['v1','v2']}),code('REVIEW_MIXED_SOURCE'));
  const plan=await f.plan('v1'),a=f.assign(plan.reviewId);
  assert.throws(()=>f.service.submit(f.run.runId,{...complete(a),reviewId:randomUUID()}),code('REVIEW_ASSIGNMENT_INVALID'));
  await fs.appendFile(first.job.readyFrames[0].path,'改变');await assert.rejects(f.service.verifySubmissionEvidence(f.run.runId,complete(a)),code('REVIEW_EVIDENCE_CHANGED'));
  await assert.rejects(f.plan('v1'),code('REVIEW_EVIDENCE_CHANGED'));
  await fs.appendFile(join(first.project,'timeline.json'),' ');await assert.rejects(f.plan('v1'),code('REVIEW_SOURCE_CHANGED'));
 }finally{await f.close();}
});

test('连续观察按协调者指定的目的与区间登记，静帧不能冒充听审',async()=>{
 const f=await reviewFixture();try{
  const v=await f.version('movie');const file=join(f.root,'fixture.mp4'),bytes=Buffer.from('隔离协议媒体夹具，不是真实视频');await fs.writeFile(file,bytes);
  const job={...v.job,kind:'template-render',input:{previewOnly:true},readyFrames:[],readyFiles:[{id:'clip',file,sha256:sha256(bytes),fromFrame:0,toFrame:12,fps:24,width:64,height:64}]};await writeJson(join(f.root,'render-jobs','movie.json'),job);
  const input={renderRequestIds:['movie'],phase:'post_export',timelineRef:'timeline.json',units:[{unitId:'whole',sceneIds:['s0','s1'],checks:[{checkId:'rhythm',purpose:'核对声画接续',mode:'audiovisual',range:{fromFrame:0,toFrame:12},evidence:[{renderRequestId:'movie',fileId:'clip'}]}]}]};
  const plan=await f.service.prepare(f.run,input),a=f.assign(plan.reviewId,'whole');
  const partial=f.service.submit(f.run.runId,{...complete(a),observations:[{...observations(a)[0],range:{fromFrame:0,toFrame:6}}]});assert.equal(partial.status,'partial');assert.deepEqual(partial.remaining[0].ranges,[{fromFrame:6,toFrame:12}]);
  assert.throws(()=>f.service.submit(f.run.runId,{...complete(a),observations:[{...observations(a)[0],range:{fromFrame:0,toFrame:13}}]}),code('REVIEW_RANGE_INVALID'));
  assert.equal(f.service.submit(f.run.runId,complete(a)).status,'complete');
  assert.deepEqual(missingRanges({fromFrame:0,toFrame:10},[{fromFrame:0,toFrame:3},{fromFrame:5,toFrame:10}]),[{fromFrame:3,toFrame:5}]);
 }finally{await f.close();}
});

test('媒体等待保留原作业；未知、取消与关闭不重建检查计划',async()=>{
 const f=await reviewFixture();try{
  const v=await f.version('v1');v.job.state='running';await writeJson(join(f.root,'render-jobs','v1.json'),v.job);
  assert.equal((await f.plan('v1')).state,'waiting_media');assert.equal((f.repo.db.prepare('SELECT COUNT(*) n FROM reviews').get() as any).n,0);
  assert.equal((await f.service.prepare(f.run,f.input('v1'),{isRunning:()=>false})).jobs[0].state,'unknown');
  const waiting=f.service.prepare(f.run,{...f.input('v1'),waitMs:1000});const rejection=assert.rejects(waiting,code('PROCESS_CANCELLED'));f.service.close();await rejection;
  assert.equal((f.service.events as any).listeners.size,0);
 }finally{await f.close();}
});

test('状态等待由分派与观察唤醒，查询不伪装进展且取消清理监听',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const plan=await f.plan('v1');const pending=f.service.readWait(f.run.runId,{reviewId:plan.reviewId,afterDigest:plan.statusDigest,waitMs:1000});
  const a=f.assign(plan.reviewId);const changed=await pending;assert.notEqual(changed.statusDigest,plan.statusDigest);
  const timeout=await f.service.readWait(f.run.runId,{reviewId:plan.reviewId,afterDigest:changed.statusDigest,waitMs:5});assert.equal(timeout.timedOut,true);assert.equal(timeout.statusDigest,changed.statusDigest);
  const body={...complete(a),observations:observations(a).slice(0,1)};f.service.submit(f.run.runId,body);const saved=f.service.read(f.run.runId,plan.reviewId);f.service.submit(f.run.runId,body);assert.deepEqual(f.service.read(f.run.runId,plan.reviewId),saved);
  const waiting=f.service.readWait(f.run.runId,{reviewId:plan.reviewId,afterDigest:saved.statusDigest,waitMs:1000});const rejected=assert.rejects(waiting,code('PROCESS_CANCELLED'));f.service.close();await rejected;
  assert.equal((f.service.events as any).listeners.size,0);
 }finally{await f.close();}
});

test('替换检查目的仍保留旧问题，可用明确的新检查与实际观察关闭',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const first=await f.plan('v1'),a=f.assign(first.reviewId),evidenceId=a.evidence[0].evidenceId;
  f.service.submit(f.run.runId,{...complete(a),issues:[{checkId:'meaning',evidenceId,severity:'blocking',problem:'原问题'}]});
  const input=f.input('v1');input.units[0].unitId='new-unit';input.units[0].checks[0].checkId='new-check';input.units[0].checks[0].purpose='针对原问题复查';
  const next=await f.service.prepare(f.run,input);assert.equal(next.pendingIssues.length,1);const b=f.assign(next.reviewId,'new-unit');
  f.service.submit(f.run.runId,{...complete(b),issueResolutions:[{issueId:next.pendingIssues[0].issueId,checkId:'new-check',evidenceId,resolution:'resolved',note:'已对实际新范围复查'}]});assert.equal(f.service.read(f.run.runId,next.reviewId).pendingIssues.length,0);
 }finally{await f.close();}
});

test('导出前后计划保留未处置问题，完整复用后仍可明确分派复查',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const first=await f.plan('v1'),a=f.assign(first.reviewId),evidenceId=a.evidence[0].evidenceId;
  f.service.submit(f.run.runId,{...complete(a),issues:[{checkId:'meaning',evidenceId,severity:'warning',problem:'已知问题'}]});
  const input={...f.input('v1'),phase:'post_export',reuse:a.evidence.map((e:{evidenceId:string})=>({sourceReviewId:first.reviewId,unitId:a.unitId,checkId:'meaning',evidenceId:e.evidenceId,reason:'同版同图，原结论保留'}))};
  const next=await f.service.prepare(f.run,input);assert.equal(next.pendingIssues.length,1);assert.equal(next.units[0].state,'completed');
  const b=f.assign(next.reviewId);assert.equal(b.remaining.length,0);
  f.service.submit(f.run.runId,{...complete(b),issueResolutions:[{issueId:next.pendingIssues[0].issueId,evidenceId,resolution:'retained',note:'实际复查仍存在，由主协调决定处置'}]});assert.equal(f.service.read(f.run.runId,next.reviewId).issues.length,1);
 }finally{await f.close();}
});

test('已保存提交重试恢复原响应，媒体后续变化只拒绝新的观察',async()=>{
 const f=await reviewFixture();try{
  await f.version('v1');const plan=await f.plan('v1'),a=f.assign(plan.reviewId),body={...complete(a),observations:observations(a).slice(0,1)};
  await f.service.verifySubmissionEvidence(f.run.runId,body);const accepted=f.service.submit(f.run.runId,body);await fs.appendFile(a.evidence[0].path,'后续变化');
  await f.service.verifySubmissionEvidence(f.run.runId,body);assert.deepEqual(f.service.submit(f.run.runId,body),accepted);
  await assert.rejects(f.service.verifySubmissionEvidence(f.run.runId,complete(a)),code('REVIEW_EVIDENCE_CHANGED'));
 }finally{await f.close();}
});
