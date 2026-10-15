import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PNG} from 'pngjs';
import {ProductionRepository} from '../packages/production-service/src/repository.js';
import {ReviewService,missingRanges,type ReviewWork} from '../packages/production-service/src/review-service.js';
import {sha256} from '../packages/production-service/src/contracts.js';
import {treeDigest,writeJson} from '../packages/production-service/src/files.js';

// 全部观察是隔离协议夹具，不作为真实作品的看听记录或质量批准。
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'review-service-'))),repo=new ProductionRepository(join(root,'isolated.sqlite'));
 repo.accept('test','analysis',{taskId:'isolated-review',content:'甲乙',otherRequirements:'',plugin:{customTemplateId:'test'}});
 const analysis=repo.claim()!;repo.finish(analysis.runId,analysis.token,'succeeded',{});
 repo.accept('test','render',{taskId:'isolated-review',basePlanVersion:analysis.planVersion,otherRequirements:'',dataList:[{id:'s0',content:'甲'},{id:'s1',content:'乙'}]});
 const run=repo.claim()!,service=new ReviewService(repo,()=>root);
 async function version(id:string,phase:'pre_export'='pre_export',update?:(timeline:any)=>void){
  const project=join(root,'preview-snapshots',id,'project'),renderer=join(project,'renderer');
  await fs.mkdir(join(renderer,'public'),{recursive:true});await fs.writeFile(join(project,'说明.md'),'隔离测试');await fs.writeFile(join(renderer,'index.tsx'),'// 隔离结构夹具');await fs.writeFile(join(renderer,'timeline.ts'),'export default {};');
  await writeJson(join(renderer,'renderer-manifest.json'),{schemaVersion:1,templateVersion:'test',instructions:['../说明.md'],entry:'index.tsx',timelineModule:'timeline.ts',wholeComposition:'Main',publicAssetRoot:'public',width:64,height:64,fps:24,voiceRefs:[]});
  const timeline={fps:24,totalFrames:12,scenes:[0,1].map(i=>({id:`s${i}`,from:i*6,frames:6,utterances:[{id:`u${i}`,src:`${i}.wav`,startFrame:0,endFrameExclusive:6}],captions:[{text:i?'乙':'甲',startFrame:0,endFrameExclusive:6,utteranceId:`u${i}`}]}))};update?.(timeline);await writeJson(join(project,'timeline.json'),timeline);
  const readyFrames=[];
  for(const frame of [0,3,6,9]){const path=join(root,`${id}-${frame}.png`),png=new PNG({width:64,height:64});png.data.fill(255);png.data[0]=frame;const bytes=PNG.sync.write(png);await fs.writeFile(path,bytes);readyFrames.push({frame,path,sha256:sha256(bytes)});}
  const sourceDigest=await treeDigest(project),job={id,runId:run.runId,kind:'frame-preview',state:'succeeded',sourceDigest,input:{previewOnly:true},readyFrames,readyFiles:[]};
  await writeJson(join(root,'render-jobs',`${id}.json`),job);return {project,sourceDigest,job};
 }
 function session(reviewId:string){const created=service.createSession(run.runId,reviewId);service.bindSession(created.id,`isolated-thread-${created.id}`);return created;}
 return {root,repo,run,service,version,session,async close(){repo.close();await fs.rm(root,{recursive:true,force:true});}};
}
type Assignment=ReviewWork&{assignmentToken:string;reviewId:string};
function observations(work:Assignment){return work.checks.flatMap(check=>check.mode==='image'?check.evidenceIds.map(evidenceId=>({checkId:check.checkId,evidenceId,note:'隔离协议观察夹具'})):[{checkId:check.checkId,evidenceId:check.evidenceIds[0],note:'隔离协议观察夹具',range:check.range}]);}
const complete=(work:Assignment)=>({assignmentToken:work.assignmentToken,observations:observations(work),issues:[],status:'complete'});
const code=(expected:string)=>(error:any)=>error?.code===expected;

test('模板全局章节转换为真实分镜包，末章包含固定片尾且拒绝切断或遗漏分镜',async()=>{
 const f=await fixture();try{
  for(const [id,end] of [['full',12],['outro',10]] as const){
   await f.version(id,'pre_export',t=>{t.chapters=[{id:'c1',from:0,endFrameExclusive:6},{id:'c2',from:6,endFrameExclusive:end}];t.ending={narrationEndFrame:10,outro:{frames:2}};t.scenes[1].utterances[0].endFrameExclusive=4;t.scenes[1].captions[0].endFrameExclusive=4;});
   const plan=await f.service.prepare(f.run,{renderRequestIds:[id],phase:'pre_export',timelineRef:'timeline.json'});
   assert.equal(plan.total,2);const session=f.session(plan.reviewId),first=f.service.claim(f.run.runId,session.credential)!;
   assert.deepEqual(first.sceneIds,['s0']);assert.equal(first.unitId,'chapter-c1');
   const secondSession=f.session(plan.reviewId),second=f.service.claim(f.run.runId,secondSession.credential)!;
   assert.deepEqual(second.sceneIds,['s1']);assert.equal(second.toFrame,12);
  }
  for(const [id,chapters] of [
   ['cut',[{id:'c1',from:0,endFrameExclusive:5},{id:'c2',from:5,endFrameExclusive:12}]],
   ['missing',[{id:'c1',from:0,endFrameExclusive:6}]],
   ['overlap',[{id:'c1',from:0,endFrameExclusive:12},{id:'c2',from:6,endFrameExclusive:12}]],
  ] as const){
   await f.version(id,'pre_export',t=>{t.chapters=chapters;});
   await assert.rejects(f.service.prepare(f.run,{renderRequestIds:[id],phase:'pre_export',timelineRef:'timeline.json'}),code('REVIEW_CHAPTER_INVALID'));
  }
 }finally{await f.close();}
});

test('真实冻结版本准备幂等，静帧时间线必须明确且证据/工程篡改被拒绝',async()=>{
 const f=await fixture();try{
  const version=await f.version('preview','pre_export');
  await assert.rejects(f.service.prepare(f.run,{renderRequestIds:['preview'],phase:'pre_export'}),code('PRODUCTION_TIMELINE_INVALID'));
  const input={renderRequestIds:['preview'],phase:'pre_export',timelineRef:'timeline.json'},plan=await f.service.prepare(f.run,input);
  assert.equal(plan.total,2);assert.equal(plan.missing.length,0);assert.equal((await f.service.prepare(f.run,input)).reviewId,plan.reviewId);
  await fs.appendFile(version.job.readyFrames[0].path,'改变');await assert.rejects(f.service.prepare(f.run,input),code('REVIEW_EVIDENCE_CHANGED'));
  await fs.writeFile(join(version.project,'timeline.json'),'{}');await assert.rejects(f.service.prepare(f.run,input),code('REVIEW_SOURCE_CHANGED'));
 }finally{await f.close();}
});

test('真实线程绑定前拒绝领活，多审片者互斥且重复领取返回当前包',async()=>{
 const f=await fixture();try{
  await f.version('preview');const plan=await f.service.prepare(f.run,{renderRequestIds:['preview'],phase:'pre_export',timelineRef:'timeline.json'}),a=f.service.createSession(f.run.runId,plan.reviewId);
  assert.throws(()=>f.service.claim(f.run.runId,a.credential),code('REVIEW_AUTH_INVALID'));f.service.bindSession(a.id,'isolated-a');
  const first=f.service.claim(f.run.runId,a.credential)!;assert.deepEqual(f.service.claim(f.run.runId,a.credential),first);
  const b=f.session(plan.reviewId),second=f.service.claim(f.run.runId,b.credential)!;assert.notEqual(first.assignmentToken,second.assignmentToken);assert.notEqual(first.unitId,second.unitId);
  assert.equal(f.service.submit(f.run.runId,b.credential,complete(first)).accepted,false);
 }finally{await f.close();}
});

test('逐图片累积观察，部分完成不跨目的填充，完成原子续领且重试不多领',async()=>{
 const f=await fixture();try{
  await f.version('preview');const plan=await f.service.prepare(f.run,{renderRequestIds:['preview'],phase:'pre_export',timelineRef:'timeline.json'}),session=f.session(plan.reviewId),work=f.service.claim(f.run.runId,session.credential)!;
  const evidenceId=work.checks[0].evidenceIds[0];
  const partial=f.service.submit(f.run.runId,session.credential,{assignmentToken:work.assignmentToken,observations:[{checkId:'visual-layout',evidenceId,note:'第一张图片观察'}],issues:[],status:'complete'});
  assert.equal(partial.status,'partial');assert.deepEqual(partial.remaining?.find((r:any)=>r.checkId==='visual-layout')?.evidenceIds,work.checks[0].evidenceIds.slice(1));
  assert.deepEqual(partial.remaining?.find((r:any)=>r.checkId==='caption-layout')?.evidenceIds,work.checks[1].evidenceIds);
  const body=complete(work),finished=f.service.submit(f.run.runId,session.credential,body);assert.equal(finished.status,'complete');assert.ok(finished.next);assert.notEqual(finished.next.unitId,work.unitId);
  assert.deepEqual(f.service.submit(f.run.runId,session.credential,body),finished);assert.equal(f.service.claim(f.run.runId,session.credential)?.assignmentToken,finished.next.assignmentToken);
  assert.deepEqual(missingRanges({fromFrame:0,toFrame:10},[{fromFrame:0,toFrame:3},{fromFrame:5,toFrame:10}]),[{fromFrame:3,toFrame:5}]);
 }finally{await f.close();}
});

test('问题必须来自实际查看图片，不同问题保存供作者集中返修',async()=>{
 const f=await fixture();try{
  await f.version('preview');const plan=await f.service.prepare(f.run,{renderRequestIds:['preview'],phase:'pre_export',timelineRef:'timeline.json'}),session=f.session(plan.reviewId),work=f.service.claim(f.run.runId,session.credential)!;
  const evidenceId=work.checks[0].evidenceIds[0],issue={checkId:'visual-layout',evidenceId:work.checks[0].evidenceIds[1],severity:'blocking',problem:'协议夹具问题甲'};
  assert.throws(()=>f.service.submit(f.run.runId,session.credential,{assignmentToken:work.assignmentToken,observations:[{checkId:'visual-layout',evidenceId,note:'只观察第一张图片'}],issues:[issue],status:'partial'}),code('REVIEW_ISSUE_UNOBSERVED'));
  assert.equal(f.service.claim(f.run.runId,session.credential)?.observations.length,0);
  let result=f.service.submit(f.run.runId,session.credential,{...complete(work),issues:[issue,{...issue,problem:'协议夹具问题乙'}]});
  while(result.next)result=f.service.submit(f.run.runId,session.credential,complete(result.next));
  const summary=f.service.read(f.run.runId,plan.reviewId);assert.equal(summary.remaining,0);assert.equal(summary.issues.length,2);
 }finally{await f.close();}
});


test('版本替换撤销旧分派，迟到记录留档而不污染新计划；停止审片者只交接剩余范围',async()=>{
 const f=await fixture();try{
  await f.version('v1');const p1=await f.service.prepare(f.run,{renderRequestIds:['v1'],phase:'pre_export',timelineRef:'timeline.json'}),s=f.session(p1.reviewId),old=f.service.claim(f.run.runId,s.credential)!;
  await f.version('v2','pre_export',t=>{t.scenes[0].captions[0].text='甲\n';});const p2=await f.service.prepare(f.run,{renderRequestIds:['v2'],phase:'pre_export',timelineRef:'timeline.json'});
  const late=f.service.submit(f.run.runId,s.credential,complete(old));assert.equal(late.accepted,false);assert.equal(late.code,'REVIEW_ASSIGNMENT_STALE');assert.equal(f.service.read(f.run.runId,p2.reviewId).remaining,2);
  const current=f.service.claim(f.run.runId,s.credential)!;assert.equal(current.reviewId,p2.reviewId);assert.notEqual(current.assignmentToken,old.assignmentToken);
  f.service.submit(f.run.runId,s.credential,{assignmentToken:current.assignmentToken,observations:[observations(current)[0]],issues:[],status:'partial'});
  f.service.releaseSession(s.id,'隔离测试模拟失联');const replacement=f.session(p2.reviewId),resumed=f.service.claim(f.run.runId,replacement.credential)!;
  assert.equal(resumed.unitId,current.unitId);assert.equal(resumed.observations.length,1);assert.notEqual(resumed.assignmentToken,current.assignmentToken);
  assert.throws(()=>f.service.claim(f.run.runId,s.credential),code('REVIEW_AUTH_INVALID'));
 }finally{await f.close();}
});

test('新审片连接撤销遗留凭证，保留部分观察并重新领取未完成范围',async()=>{
 const f=await fixture();try{
  await f.version('preview');const plan=await f.service.prepare(f.run,{renderRequestIds:['preview'],phase:'pre_export',timelineRef:'timeline.json'});
  const active=f.session(plan.reviewId),starting=f.service.createSession(f.run.runId,plan.reviewId),work=f.service.claim(f.run.runId,active.credential)!;
  f.service.submit(f.run.runId,active.credential,{assignmentToken:work.assignmentToken,observations:[observations(work)[0]],issues:[],status:'partial'});
  f.service.recoverSessions(f.run.runId);
  for(const session of [active,starting])assert.throws(()=>f.service.claim(f.run.runId,session.credential),code('REVIEW_AUTH_INVALID'));
  const replacement=f.session(plan.reviewId),resumed=f.service.claim(f.run.runId,replacement.credential)!;
  assert.equal(resumed.unitId,work.unitId);assert.equal(resumed.observations.length,1);assert.notEqual(resumed.assignmentToken,work.assignmentToken);
 }finally{await f.close();}
});

test('相同媒体与未变依赖按检查目的复用，局部字幕修订仍须补齐字幕布局检查',async()=>{
 const f=await fixture();try{
  await f.version('v1');const first=await f.service.prepare(f.run,{renderRequestIds:['v1'],phase:'pre_export',timelineRef:'timeline.json'}),s=f.session(first.reviewId);
  let work=f.service.claim(f.run.runId,s.credential);const firstBody=complete(work!);
  while(work)work=f.service.submit(f.run.runId,s.credential,complete(work)).next;
  await f.version('v2','pre_export',t=>{t.scenes[0].captions[0].text='甲\n';});const second=await f.service.prepare(f.run,{renderRequestIds:['v2'],phase:'pre_export',timelineRef:'timeline.json'});
  assert.equal(second.remaining,1);const changed=f.service.claim(f.run.runId,s.credential)!;
  assert.equal(changed.unitId,'scene-s0');assert.deepEqual(changed.remaining.map((r:any)=>r.checkId),['caption-layout']);
  assert.ok(changed.reused.some(r=>r.checkId==='visual-layout'));
  assert.equal(changed.observations.length,0);
  // 原已接收请求重放仅恢复历史应答，不泄露已撤销 next，也不完成新版本。
  const replay=f.service.submit(f.run.runId,s.credential,firstBody);assert.equal(replay.accepted,true);assert.equal(replay.next,null);assert.equal(replay.nextAssignmentRevoked,true);
  assert.equal(f.service.read(f.run.runId,second.reviewId).remaining,1);
 }finally{await f.close();}
});


test('确认正文与观察期间证据被改写时拒绝提交，保留原计划状态',async()=>{
 const f=await fixture();try{
  await f.version('wrong','pre_export',t=>{t.scenes[0].captions[0].text='换掉确认稿';});
  await assert.rejects(f.service.prepare(f.run,{renderRequestIds:['wrong'],phase:'pre_export',timelineRef:'timeline.json'}),code('PRODUCTION_TIMELINE_INVALID'));
  await f.version('good');const plan=await f.service.prepare(f.run,{renderRequestIds:['good'],phase:'pre_export',timelineRef:'timeline.json'}),session=f.session(plan.reviewId),work=f.service.claim(f.run.runId,session.credential)!;
  await fs.appendFile(work.evidence[0].path,'证据在观察后被改写');
  await assert.rejects(f.service.verifySubmissionEvidence(f.run.runId,session.credential,complete(work)),code('REVIEW_EVIDENCE_CHANGED'));
  assert.equal(f.service.claim(f.run.runId,session.credential)!.observations.length,0);
 }finally{await f.close();}
});


test('只创建静帧包，拒绝 final 审片和用连续区间冒充图片观察',async()=>{
 const f=await fixture();try{
  await f.version('preview');
  await assert.rejects(f.service.prepare(f.run,{renderRequestIds:['preview'],phase:'final',timelineRef:'timeline.json'}));
  const plan=await f.service.prepare(f.run,{renderRequestIds:['preview'],phase:'pre_export',timelineRef:'timeline.json'}),session=f.session(plan.reviewId);
  const work=f.service.claim(f.run.runId,session.credential)!;
  assert.equal(plan.total,2);assert.deepEqual(work.checks.map(c=>c.checkId),['visual-layout','caption-layout']);
  assert.ok(work.evidence.every(e=>e.kind==='image'));
  const item=observations(work)[0];
  assert.throws(()=>f.service.submit(f.run.runId,session.credential,{assignmentToken:work.assignmentToken,observations:[{...item,range:{fromFrame:0,toFrame:6}}],issues:[],status:'complete'}),code('REVIEW_MODE_INVALID'));
  let pending:Assignment|null=work;while(pending)pending=f.service.submit(f.run.runId,session.credential,complete(pending)).next;
  assert.equal(f.service.read(f.run.runId,plan.reviewId).remaining,0);
 }finally{await f.close();}
});

test('同章逐图片复用 partial 已接收观察，保留未变问题并显式处置变化图片的旧问题',async()=>{
 const f=await fixture();try{
  const chapter=(t:any)=>{t.chapters=[{id:'all',from:0,endFrameExclusive:12}];};
  await f.version('v1','pre_export',chapter);
  const first=await f.service.prepare(f.run,{renderRequestIds:['v1'],phase:'pre_export',timelineRef:'timeline.json'}),s=f.session(first.reviewId),work=f.service.claim(f.run.runId,s.credential)!;
  const a=work.evidence.find(e=>e.frame===0)!,b=work.evidence.find(e=>e.frame===3)!;
  f.service.submit(f.run.runId,s.credential,{assignmentToken:work.assignmentToken,observations:observations(work).filter(o=>!(o.checkId==='caption-layout'&&o.evidenceId===work.evidence.find(e=>e.frame===9)!.evidenceId)),issues:[{checkId:'visual-layout',evidenceId:a.evidenceId,severity:'blocking',problem:'未变图片遮挡'},{checkId:'caption-layout',evidenceId:b.evidenceId,severity:'warning',problem:'变化图片字幕待复查'}],status:'partial'});
  const version=await f.version('v2','pre_export',chapter),changed=version.job.readyFrames.find(e=>e.frame===3)!;
  const png=PNG.sync.read(await fs.readFile(changed.path));png.data[0]=77;const bytes=PNG.sync.write(png);await fs.writeFile(changed.path,bytes);changed.sha256=sha256(bytes);await writeJson(join(f.root,'render-jobs','v2.json'),version.job);
  const second=await f.service.prepare(f.run,{renderRequestIds:['v2'],phase:'pre_export',timelineRef:'timeline.json'}),next=f.service.claim(f.run.runId,s.credential)!;
  assert.equal(next.reused.length,5);assert.equal(second.issues.length,1);assert.equal(second.issues[0].severity,'blocking');assert.equal(second.pendingIssues.length,1);
  assert.ok(next.remaining.some(r=>r.evidenceIds?.includes(next.evidence.find(e=>e.frame===9)!.evidenceId)));
  assert.throws(()=>f.service.submit(f.run.runId,s.credential,{assignmentToken:next.assignmentToken,observations:[],issues:[],issueResolutions:[{issueId:second.pendingIssues[0].issueId,resolution:'resolved',note:'尚未看图'}],status:'partial'}),code('REVIEW_ISSUE_UNOBSERVED'));
  const newId=next.evidence.find(e=>e.frame===3)!.evidenceId;
  f.service.submit(f.run.runId,s.credential,{assignmentToken:next.assignmentToken,observations:[{checkId:'caption-layout',evidenceId:newId,note:'实际复查当前字幕'}],issues:[],status:'partial'});
  const resolution={assignmentToken:next.assignmentToken,observations:[],issues:[],issueResolutions:[{issueId:second.pendingIssues[0].issueId,resolution:'resolved',note:'当前字幕遮挡已消除'}],status:'partial'};
  await fs.writeFile(changed.path,'处置前证据被改写');
  await assert.rejects(f.service.verifySubmissionEvidence(f.run.runId,s.credential,resolution),code('REVIEW_EVIDENCE_CHANGED'));
  await fs.writeFile(changed.path,bytes);await f.service.verifySubmissionEvidence(f.run.runId,s.credential,resolution);
  f.service.submit(f.run.runId,s.credential,resolution);
  const summary=f.service.read(f.run.runId,second.reviewId);assert.equal(summary.pendingIssues.length,0);assert.equal(summary.issues.length,1);assert.equal(summary.remaining,1);
 }finally{await f.close();}
});

test('建议不牵连同章其他图；章节语义、共享源码和字体变化仍扩大真实复查',async()=>{
 const f=await fixture();try{
  const chapter=(t:any)=>{t.chapters=[{id:'all',title:'比较基线',from:0,endFrameExclusive:12}];};
  await f.version('v1','pre_export',chapter);const first=await f.service.prepare(f.run,{renderRequestIds:['v1'],phase:'pre_export',timelineRef:'timeline.json'}),s=f.session(first.reviewId),work=f.service.claim(f.run.runId,s.credential)!;
  f.service.submit(f.run.runId,s.credential,{...complete(work),issues:[{checkId:'visual-layout',evidenceId:work.evidence[0].evidenceId,severity:'suggestion',problem:'可选视觉建议'}]});
  const v2=await f.version('v2','pre_export',chapter);v2.job.readyFrames=v2.job.readyFrames.slice(0,3);await writeJson(join(f.root,'render-jobs','v2.json'),v2.job);
  const second=await f.service.prepare(f.run,{renderRequestIds:['v2'],phase:'pre_export',timelineRef:'timeline.json'});assert.equal(second.remaining,0);assert.equal(second.reusedCount,6);assert.equal(second.issues.length,1);
  await f.version('v3','pre_export',t=>{chapter(t);t.chapters[0].title='比较口径已变化';});
  const third=await f.service.prepare(f.run,{renderRequestIds:['v3'],phase:'pre_export',timelineRef:'timeline.json'});assert.equal(third.reusedCount,0);assert.equal(third.pendingIssues.length,1);
  const current=f.service.claim(f.run.runId,s.credential)!;f.service.submit(f.run.runId,s.credential,complete(current));
  const v4=await f.version('v4','pre_export',t=>{chapter(t);t.chapters[0].title='比较口径已变化';});
  await fs.writeFile(join(v4.project,'renderer','index.tsx'),'// 共享布局发生变化');await fs.writeFile(join(v4.project,'renderer','public','font.woff2'),'隔离字体字节');v4.job.sourceDigest=await treeDigest(v4.project);await writeJson(join(f.root,'render-jobs','v4.json'),v4.job);
  const fourth=await f.service.prepare(f.run,{renderRequestIds:['v4'],phase:'pre_export',timelineRef:'timeline.json'});assert.equal(fourth.reusedCount,0);assert.equal(fourth.pendingIssues.length,1);
 }finally{await f.close();}
});

test('审片有界等待摘要稳定，诊断与 partial 唤醒，超时和取消释放监听',async()=>{
 const f=await fixture();try{
  await f.version('v1');const first=await f.service.prepare(f.run,{renderRequestIds:['v1'],phase:'pre_export',timelineRef:'timeline.json'}),s=f.session(first.reviewId),work=f.service.claim(f.run.runId,s.credential)!;
  const initial=f.service.read(f.run.runId,first.reviewId);
  assert.equal((await f.service.readWait(f.run.runId,{reviewId:first.reviewId,waitMs:100})).statusDigest,initial.statusDigest);
  const waiting=f.service.readWait(f.run.runId,{reviewId:first.reviewId,afterDigest:initial.statusDigest,waitMs:200});
  f.service.submit(f.run.runId,s.credential,{assignmentToken:work.assignmentToken,observations:[observations(work)[0]],issues:[],status:'partial'});
  const partial=await waiting;assert.notEqual(partial.statusDigest,initial.statusDigest);assert.equal(partial.timedOut,false);
  const diagnostic=f.service.readWait(f.run.runId,{reviewId:first.reviewId,afterDigest:partial.statusDigest,waitMs:200});f.service.sessionDiagnostic(s.id,'原会话需要接替');const updated=await diagnostic;assert.notEqual(updated.statusDigest,partial.statusDigest);
  const timeout=await f.service.readWait(f.run.runId,{reviewId:first.reviewId,afterDigest:updated.statusDigest,waitMs:10});assert.equal(timeout.timedOut,true);assert.equal(timeout.statusDigest,updated.statusDigest);
  const abort=new AbortController(),cancelled=f.service.readWait(f.run.runId,{reviewId:first.reviewId,afterDigest:updated.statusDigest,waitMs:200},abort.signal);abort.abort();await assert.rejects(cancelled,code('PROCESS_CANCELLED'));
  assert.equal((f.service.events as any).listeners.size,0);
  const subscribing=f.service.events.subscribe.bind(f.service.events);let once=true;
  f.service.events.subscribe=(...args)=>{const sub=subscribing(...args);if(once){once=false;f.service.runtimeDiagnostic(first.reviewId,'订阅和读取交错更新');}return sub;};
  assert.notEqual((await f.service.readWait(f.run.runId,{reviewId:first.reviewId,afterDigest:updated.statusDigest,waitMs:200})).statusDigest,updated.statusDigest);
 }finally{await f.close();}
});

test('多批静帧等齐同快照才建计划，超时不建空计划，失败保留原身份且重试幂等',async()=>{
 const f=await fixture();try{
  const a=await f.version('a'),b=await f.version('b');a.job.readyFrames=a.job.readyFrames.slice(0,2);b.job.readyFrames=b.job.readyFrames.slice(2);
  await writeJson(join(f.root,'render-jobs','a.json'),a.job);b.job.state='running';await writeJson(join(f.root,'render-jobs','b.json'),b.job);
  const input={renderRequestIds:['a','b'],phase:'pre_export',timelineRef:'timeline.json',waitMs:10};
  const waiting=await f.service.prepare(f.run,input);assert.equal(waiting.state,'waiting_media');assert.equal(waiting.reviewId,undefined);assert.deepEqual(waiting.pendingJobs,[{renderRequestId:'b',state:'running'}]);assert.equal((f.repo.db.prepare('SELECT COUNT(*) AS n FROM reviews').get() as any).n,0);
  const pending=f.service.prepare(f.run,{...input,waitMs:500});
  b.job.state='succeeded';await writeJson(join(f.root,'render-jobs','b.json'),b.job);f.service.events.notify(`${f.run.runId}:b`);
  const ready=await pending;assert.equal(ready.total,2);assert.equal(ready.missing.length,0);assert.equal((await f.service.prepare(f.run,input)).reviewId,ready.reviewId);
  b.job.state='failed';Object.assign(b.job,{error:'第二批原绘制失败'});await writeJson(join(f.root,'render-jobs','b.json'),b.job);
  const failed=await f.service.prepare(f.run,input);assert.equal(failed.state,'media_failed');assert.equal(failed.jobs[0].renderRequestId,'b');assert.equal(failed.jobs[0].error,'第二批原绘制失败');assert.equal((f.repo.db.prepare('SELECT COUNT(*) AS n FROM reviews').get() as any).n,1);assert.equal((f.service.events as any).listeners.size,0);
 }finally{await f.close();}
});

test('同章字幕局部断行只失效对应场景图片，章节其余图片继续复用',async()=>{
 const f=await fixture();try{
  const chapter=(t:any)=>{t.chapters=[{id:'all',from:0,endFrameExclusive:12}];};
  await f.version('v1','pre_export',chapter);const first=await f.service.prepare(f.run,{renderRequestIds:['v1'],phase:'pre_export',timelineRef:'timeline.json'}),s=f.session(first.reviewId),work=f.service.claim(f.run.runId,s.credential)!;
  f.service.submit(f.run.runId,s.credential,complete(work));await f.version('v2','pre_export',t=>{chapter(t);t.scenes[0].captions[0].text='甲\n';});
  const second=await f.service.prepare(f.run,{renderRequestIds:['v2'],phase:'pre_export',timelineRef:'timeline.json'}),next=f.service.claim(f.run.runId,s.credential)!;
  assert.equal(second.reusedCount,6);assert.deepEqual(next.remaining.map(r=>r.checkId),['caption-layout']);assert.deepEqual(next.remaining[0].evidenceIds,next.evidence.filter(e=>e.sceneId==='s0').map(e=>e.evidenceId));
 }finally{await f.close();}
});

test('准备遇到失联原媒体返回 unknown，混版拒绝；关闭服务同时清理审片和媒体等待',async()=>{
 const f=await fixture();try{
  const first=await f.version('a'),second=await f.version('b','pre_export',t=>{t.scenes[0].captions[0].text='甲\n';});
  await assert.rejects(f.service.prepare(f.run,{renderRequestIds:['a','b'],phase:'pre_export',timelineRef:'timeline.json'}),code('REVIEW_MIXED_SOURCE'));
  const plan=await f.service.prepare(f.run,{renderRequestIds:['a'],phase:'pre_export',timelineRef:'timeline.json'});
  second.job.state='running';await writeJson(join(f.root,'render-jobs','b.json'),second.job);
  const request={renderRequestIds:['a','b'],phase:'pre_export',timelineRef:'timeline.json',waitMs:500};
  const unknown=await f.service.prepare(f.run,request,{isRunning:()=>false});assert.equal(unknown.state,'media_failed');assert.equal(unknown.jobs[0].state,'unknown');assert.equal(unknown.jobs[0].renderRequestId,'b');
  const media=f.service.prepare(f.run,request,{isRunning:()=>true}),review=f.service.readWait(f.run.runId,{reviewId:plan.reviewId,afterDigest:plan.statusDigest,waitMs:500});
  const settled=Promise.all([assert.rejects(media,code('PROCESS_CANCELLED')),assert.rejects(review,code('PROCESS_CANCELLED'))]);f.service.close();await settled;assert.equal((f.service.events as any).listeners.size,0);assert.equal(first.job.state,'succeeded');
 }finally{await f.close();}
});

test('审片观测时间与查询计数持久化，重复观察不膨胀计数且查询不改变状态摘要',async()=>{
 const f=await fixture();try{
  await f.version('metrics');const plan=await f.service.prepare(f.run,{renderRequestIds:['metrics'],phase:'pre_export',timelineRef:'timeline.json'});
  assert.ok(Number.isInteger(plan.metrics.preparedAt));assert.equal(plan.metrics.firstClaimedAt,null);assert.equal(plan.metrics.lastAcceptedSubmissionAt,null);assert.equal(plan.metrics.readQueryCount,0);
  const first=await f.service.readWait(f.run.runId,{reviewId:plan.reviewId});assert.equal(first.metrics.readQueryCount,1);assert.equal(first.statusDigest,plan.statusDigest);
  const timeout=await f.service.readWait(f.run.runId,{reviewId:plan.reviewId,afterDigest:first.statusDigest,waitMs:10});assert.equal(timeout.timedOut,true);assert.equal(timeout.metrics.readQueryCount,2);assert.equal(timeout.metrics.readTimeoutCount,1);assert.equal(timeout.statusDigest,first.statusDigest);
  const s=f.session(plan.reviewId),work=f.service.claim(f.run.runId,s.credential)!,claimed=f.service.read(f.run.runId,plan.reviewId);assert.ok(claimed.metrics.firstClaimedAt!>=claimed.metrics.preparedAt);
  f.service.claim(f.run.runId,s.credential);assert.equal(f.service.read(f.run.runId,plan.reviewId).metrics.firstClaimedAt,claimed.metrics.firstClaimedAt);
  const observation=observations(work)[0],body={assignmentToken:work.assignmentToken,observations:[observation,{...observation,note:'同图同检查的补充说明'}],issues:[],status:'partial'};
  f.service.submit(f.run.runId,s.credential,body);const submitted=f.service.read(f.run.runId,plan.reviewId);assert.equal(submitted.observationCount,1);assert.ok(submitted.metrics.lastAcceptedSubmissionAt!>=submitted.metrics.firstClaimedAt!);
  f.service.submit(f.run.runId,s.credential,body);assert.deepEqual(f.service.read(f.run.runId,plan.reviewId),submitted);
  const stored=JSON.parse((f.repo.db.prepare('SELECT data FROM reviews WHERE id=?').get(plan.reviewId) as any).data);assert.deepEqual(stored.metrics,submitted.metrics);
  assert.equal((f.service.events as any).listeners.size,0);
 }finally{await f.close();}
});
