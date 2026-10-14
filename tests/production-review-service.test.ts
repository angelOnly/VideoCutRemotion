import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PNG} from 'pngjs';
import {ProductionRepository} from '../packages/production-service/src/repository.js';
import {ReviewService,missingRanges,type ReviewWork} from '../packages/production-service/src/review-service.js';
import {sha256} from '../packages/production-service/src/contracts.js';
import {treeDigest,writeJson,processFile} from '../packages/production-service/src/files.js';

// 全部观察是隔离协议夹具，不作为真实作品的看听记录或质量批准。
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'review-service-'))),repo=new ProductionRepository(join(root,'isolated.sqlite'));
 repo.accept('test','analysis',{taskId:'isolated-review',content:'甲乙',otherRequirements:'',plugin:{customTemplateId:'test'}});
 const analysis=repo.claim()!;repo.finish(analysis.runId,analysis.token,'succeeded',{});
 repo.accept('test','render',{taskId:'isolated-review',basePlanVersion:analysis.planVersion,otherRequirements:'',dataList:[{id:'s0',content:'甲'},{id:'s1',content:'乙'}]});
 const run=repo.claim()!,service=new ReviewService(repo,()=>root);
 const media=join(root,'whole.mp4');
 await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=24','-f','lavfi','-i','sine=frequency=538:sample_rate=48000','-t','0.5','-c:v','mpeg4','-threads:v','1','-c:a','aac',media]);
 const files=[{id:'whole-video',content:'甲乙',file:media,sha256:sha256(await fs.readFile(media)),dur:.5,fromFrame:0,toFrame:12,width:64,height:64,fps:24}];
 async function version(id:string,phase:'pre_export'|'final'='final',update?:(timeline:any)=>void){
  const project=join(root,phase==='final'?'render-snapshots':'preview-snapshots',id,'project'),renderer=join(project,'renderer');
  await fs.mkdir(join(renderer,'public'),{recursive:true});await fs.writeFile(join(project,'说明.md'),'隔离测试');await fs.writeFile(join(renderer,'index.tsx'),'// 隔离结构夹具');await fs.writeFile(join(renderer,'timeline.ts'),'export default {};');
  await writeJson(join(renderer,'renderer-manifest.json'),{schemaVersion:1,templateVersion:'test',instructions:['../说明.md'],entry:'index.tsx',timelineModule:'timeline.ts',wholeComposition:'Main',publicAssetRoot:'public',width:64,height:64,fps:24,voiceRefs:[]});
  const timeline={fps:24,totalFrames:12,scenes:[0,1].map(i=>({id:`s${i}`,from:i*6,frames:6,utterances:[{id:`u${i}`,src:`${i}.wav`,startFrame:0,endFrameExclusive:6}],captions:[{text:i?'乙':'甲',startFrame:0,endFrameExclusive:6,utteranceId:`u${i}`}]}))};update?.(timeline);await writeJson(join(project,'timeline.json'),timeline);
  const readyFrames=[];
  for(const frame of [0,3,6,9]){const path=join(root,`${id}-${frame}.png`),png=new PNG({width:64,height:64});png.data.fill(255);png.data[0]=frame;const bytes=PNG.sync.write(png);await fs.writeFile(path,bytes);readyFrames.push({frame,path,sha256:sha256(bytes)});}
  const sourceDigest=await treeDigest(project),job={id,runId:run.runId,kind:phase==='final'?'template-render':'frame-preview',state:'succeeded',sourceDigest,input:phase==='final'?{timelineRef:'timeline.json',previewOnly:false}:{previewOnly:true},readyFrames,readyFiles:phase==='final'?files:[]};
  await writeJson(join(root,'render-jobs',`${id}.json`),job);return {project,sourceDigest,job};
 }
 function session(reviewId:string){const created=service.createSession(run.runId,reviewId);service.bindSession(created.id,`isolated-thread-${created.id}`);return created;}
 return {root,repo,run,service,files,version,session,async close(){repo.close();await fs.rm(root,{recursive:true,force:true});}};
}
type Assignment=ReviewWork&{assignmentToken:string;reviewId:string};
function observations(work:Assignment){return work.checks.flatMap(check=>check.mode==='image'?check.evidenceIds.map(evidenceId=>({checkId:check.checkId,evidenceId,note:'隔离协议观察夹具'})):[{checkId:check.checkId,evidenceId:check.evidenceIds[0],note:'隔离协议观察夹具',range:check.range}]);}
const complete=(work:Assignment)=>({assignmentToken:work.assignmentToken,observations:observations(work),issues:[],status:'complete'});
const code=(expected:string)=>(error:any)=>error?.code===expected;

test('真实冻结版本准备幂等，静帧时间线必须明确且证据/工程篡改被拒绝',async()=>{
 const f=await fixture();try{
  const version=await f.version('preview','pre_export');
  await assert.rejects(f.service.prepare(f.run,{renderRequestIds:['preview'],phase:'pre_export'}),code('REVIEW_TIMELINE_REQUIRED'));
  const input={renderRequestIds:['preview'],phase:'pre_export',timelineRef:'timeline.json'},plan=await f.service.prepare(f.run,input);
  assert.equal(plan.total,2);assert.equal(plan.missing.length,0);assert.equal((await f.service.prepare(f.run,input)).reviewId,plan.reviewId);
  await fs.appendFile(version.job.readyFrames[0].path,'改变');await assert.rejects(f.service.prepare(f.run,input),code('REVIEW_EVIDENCE_CHANGED'));
  await fs.writeFile(join(version.project,'timeline.json'),'{}');await assert.rejects(f.service.prepare(f.run,input),code('REVIEW_SOURCE_CHANGED'));
 }finally{await f.close();}
});

test('真实线程绑定前拒绝领活，多审片者互斥且重复领取返回当前包',async()=>{
 const f=await fixture();try{
  await f.version('final');const plan=await f.service.prepare(f.run,{renderRequestIds:['final'],phase:'final'}),a=f.service.createSession(f.run.runId,plan.reviewId);
  assert.throws(()=>f.service.claim(f.run.runId,a.credential),code('REVIEW_AUTH_INVALID'));f.service.bindSession(a.id,'isolated-a');
  const first=f.service.claim(f.run.runId,a.credential)!;assert.deepEqual(f.service.claim(f.run.runId,a.credential),first);
  const b=f.session(plan.reviewId),second=f.service.claim(f.run.runId,b.credential)!;assert.notEqual(first.assignmentToken,second.assignmentToken);assert.notEqual(first.unitId,second.unitId);
  assert.equal(f.service.submit(f.run.runId,b.credential,complete(first)).accepted,false);
 }finally{await f.close();}
});

test('逐检查累积半开观察范围，部分完成不跨目的填洞，完成原子续领且重试不多领',async()=>{
 const f=await fixture();try{
  await f.version('final');const plan=await f.service.prepare(f.run,{renderRequestIds:['final'],phase:'final'}),session=f.session(plan.reviewId),work=f.service.claim(f.run.runId,session.credential)!;
  const evidenceId=work.checks[0].evidenceIds[0];
  const partial=f.service.submit(f.run.runId,session.credential,{assignmentToken:work.assignmentToken,observations:[{checkId:'motion',evidenceId,note:'前半段协议观察',range:{fromFrame:0,toFrame:3}}],issues:[],status:'complete'});
  assert.equal(partial.status,'partial');assert.deepEqual(partial.remaining?.find((r:any)=>r.checkId==='motion')?.ranges,[{fromFrame:3,toFrame:6}]);
  assert.deepEqual(partial.remaining?.find((r:any)=>r.checkId==='audio')?.ranges,[{fromFrame:0,toFrame:6}]);
  const body=complete(work),finished=f.service.submit(f.run.runId,session.credential,body);assert.equal(finished.status,'complete');assert.ok(finished.next);assert.notEqual(finished.next.unitId,work.unitId);
  assert.deepEqual(f.service.submit(f.run.runId,session.credential,body),finished);assert.equal(f.service.claim(f.run.runId,session.credential)?.assignmentToken,finished.next.assignmentToken);
  assert.deepEqual(missingRanges({fromFrame:0,toFrame:10},[{fromFrame:0,toFrame:3},{fromFrame:5,toFrame:10}]),[{fromFrame:3,toFrame:5}]);
 }finally{await f.close();}
});

test('问题必须位于该目的的观察范围，不同问题保留且阻断质量门',async()=>{
 const f=await fixture();try{
  const v=await f.version('final'),plan=await f.service.prepare(f.run,{renderRequestIds:['final'],phase:'final'}),session=f.session(plan.reviewId),work=f.service.claim(f.run.runId,session.credential)!;
  const evidenceId=work.checks[0].evidenceIds[0],issue={checkId:'motion',evidenceId,severity:'blocking',problem:'协议夹具问题甲',range:{fromFrame:3,toFrame:5}};
  assert.throws(()=>f.service.submit(f.run.runId,session.credential,{assignmentToken:work.assignmentToken,observations:[{checkId:'motion',evidenceId,note:'只观察开头',range:{fromFrame:0,toFrame:3}}],issues:[issue],status:'partial'}),code('REVIEW_ISSUE_UNOBSERVED'));
  assert.equal(f.service.claim(f.run.runId,session.credential)?.observations.length,0);
  let result=f.service.submit(f.run.runId,session.credential,{...complete(work),issues:[issue,{...issue,problem:'协议夹具问题乙'}]});
  while(result.next)result=f.service.submit(f.run.runId,session.credential,complete(result.next));
  const summary=f.service.read(f.run.runId,plan.reviewId);assert.equal(summary.remaining,0);assert.equal(summary.issues.length,2);
  assert.throws(()=>f.service.assertDelivery(f.run.runId,v.sourceDigest,f.files),code('REVIEW_INCOMPLETE'));
 }finally{await f.close();}
});

test('质量门拒绝静帧替代连续检查，成片完成后仍绑定对应文件和版本',async()=>{
 const f=await fixture();try{
  const pre=await f.version('preview','pre_export'),p=await f.service.prepare(f.run,{renderRequestIds:['preview'],phase:'pre_export',timelineRef:'timeline.json'}),ps=f.session(p.reviewId);
  let pw=f.service.claim(f.run.runId,ps.credential);while(pw)pw=f.service.submit(f.run.runId,ps.credential,complete(pw)).next;
  assert.throws(()=>f.service.assertDelivery(f.run.runId,pre.sourceDigest,f.files),code('REVIEW_REQUIRED'));
  const v=await f.version('final'),p2=await f.service.prepare(f.run,{renderRequestIds:['final'],phase:'final'}),s=f.session(p2.reviewId);
  assert.throws(()=>f.service.assertDelivery(f.run.runId,v.sourceDigest,f.files),code('REVIEW_INCOMPLETE'));
  let work=f.service.claim(f.run.runId,s.credential);while(work)work=f.service.submit(f.run.runId,s.credential,complete(work)).next;
  assert.equal(f.service.assertDelivery(f.run.runId,v.sourceDigest,f.files).reviewId,p2.reviewId);
  assert.throws(()=>f.service.assertDelivery(f.run.runId,v.sourceDigest,[{...f.files[0],sha256:'different'}]),code('REVIEW_DELIVERY_CHANGED'));
  assert.throws(()=>f.service.assertDelivery(f.run.runId,'old-version',f.files),code('REVIEW_REQUIRED'));
 }finally{await f.close();}
});

test('版本替换撤销旧分派，迟到记录留档而不污染新计划；停止审片者只交接剩余范围',async()=>{
 const f=await fixture();try{
  await f.version('v1');const p1=await f.service.prepare(f.run,{renderRequestIds:['v1'],phase:'final'}),s=f.session(p1.reviewId),old=f.service.claim(f.run.runId,s.credential)!;
  await f.version('v2','final',t=>{t.scenes[0].captions[0].text='甲\n';});const p2=await f.service.prepare(f.run,{renderRequestIds:['v2'],phase:'final'});
  const late=f.service.submit(f.run.runId,s.credential,complete(old));assert.equal(late.accepted,false);assert.equal(late.code,'REVIEW_ASSIGNMENT_STALE');assert.equal(f.service.read(f.run.runId,p2.reviewId).remaining,3);
  const current=f.service.claim(f.run.runId,s.credential)!;assert.equal(current.reviewId,p2.reviewId);assert.notEqual(current.assignmentToken,old.assignmentToken);
  f.service.submit(f.run.runId,s.credential,{assignmentToken:current.assignmentToken,observations:[observations(current)[0]],issues:[],status:'partial'});
  f.service.releaseSession(s.id,'隔离测试模拟失联');const replacement=f.session(p2.reviewId),resumed=f.service.claim(f.run.runId,replacement.credential)!;
  assert.equal(resumed.unitId,current.unitId);assert.equal(resumed.observations.length,1);assert.notEqual(resumed.assignmentToken,current.assignmentToken);
  assert.throws(()=>f.service.claim(f.run.runId,s.credential),code('REVIEW_AUTH_INVALID'));
 }finally{await f.close();}
});

test('新审片连接撤销遗留凭证，保留部分观察并重新领取未完成范围',async()=>{
 const f=await fixture();try{
  await f.version('final');const plan=await f.service.prepare(f.run,{renderRequestIds:['final'],phase:'final'});
  const active=f.session(plan.reviewId),starting=f.service.createSession(f.run.runId,plan.reviewId),work=f.service.claim(f.run.runId,active.credential)!;
  f.service.submit(f.run.runId,active.credential,{assignmentToken:work.assignmentToken,observations:[observations(work)[0]],issues:[],status:'partial'});
  f.service.recoverSessions(f.run.runId);
  for(const session of [active,starting])assert.throws(()=>f.service.claim(f.run.runId,session.credential),code('REVIEW_AUTH_INVALID'));
  const replacement=f.session(plan.reviewId),resumed=f.service.claim(f.run.runId,replacement.credential)!;
  assert.equal(resumed.unitId,work.unitId);assert.equal(resumed.observations.length,1);assert.notEqual(resumed.assignmentToken,work.assignmentToken);
 }finally{await f.close();}
});

test('相同媒体与未变依赖按检查目的复用，局部字幕修订仍须补齐阅读检查',async()=>{
 const f=await fixture();try{
  await f.version('v1');const first=await f.service.prepare(f.run,{renderRequestIds:['v1'],phase:'final'}),s=f.session(first.reviewId);
  let work=f.service.claim(f.run.runId,s.credential);const firstBody=complete(work!);
  while(work)work=f.service.submit(f.run.runId,s.credential,complete(work)).next;
  await f.version('v2','final',t=>{t.scenes[0].captions[0].text='甲\n';});const second=await f.service.prepare(f.run,{renderRequestIds:['v2'],phase:'final'});
  assert.equal(second.remaining,1);const changed=f.service.claim(f.run.runId,s.credential)!;
  assert.equal(changed.unitId,'scene-s0');assert.deepEqual(changed.remaining.map((r:any)=>r.checkId),['caption-reading']);
  assert.ok(changed.reused.some(r=>r.checkId==='audio'));assert.ok(changed.reused.some(r=>r.checkId==='motion'));
  assert.equal(changed.observations.length,0);
  assert.throws(()=>f.service.assertDelivery(f.run.runId,second.sourceDigest,f.files),code('REVIEW_INCOMPLETE'));
  // 原已接收请求重放仅恢复历史应答，不泄露已撤销 next，也不完成新版本。
  const replay=f.service.submit(f.run.runId,s.credential,firstBody);assert.equal(replay.accepted,true);assert.equal(replay.next,null);assert.equal(replay.nextAssignmentRevoked,true);
  assert.equal(f.service.read(f.run.runId,second.reviewId).remaining,1);
 }finally{await f.close();}
});

test('导出前转入成片检查时同一真实会话显式重绑，旧分派不能写入新阶段',async()=>{
 const f=await fixture();try{
  await f.version('pre','pre_export');const pre=await f.service.prepare(f.run,{renderRequestIds:['pre'],phase:'pre_export',timelineRef:'timeline.json'}),session=f.session(pre.reviewId),old=f.service.claim(f.run.runId,session.credential)!;
  await f.version('formal');const final=await f.service.prepare(f.run,{renderRequestIds:['formal'],phase:'final'});
  assert.equal(f.service.read(f.run.runId,pre.reviewId).state,'superseded');
  assert.equal(f.service.authenticate(f.run.runId,session.credential).review_id,final.reviewId);
  assert.equal(f.service.submit(f.run.runId,session.credential,complete(old)).accepted,false);
  const current=f.service.claim(f.run.runId,session.credential)!;assert.equal(current.reviewId,final.reviewId);assert.ok(current.checks.some(c=>c.mode==='audio'));
 }finally{await f.close();}
});

test('确认正文与观察期间证据被改写时拒绝提交，保留原计划状态',async()=>{
 const f=await fixture();try{
  await f.version('wrong','final',t=>{t.scenes[0].captions[0].text='换掉确认稿';});
  await assert.rejects(f.service.prepare(f.run,{renderRequestIds:['wrong'],phase:'final'}),code('REVIEW_CONTENT_CHANGED'));
  await f.version('good');const plan=await f.service.prepare(f.run,{renderRequestIds:['good'],phase:'final'}),session=f.session(plan.reviewId),work=f.service.claim(f.run.runId,session.credential)!;
  await fs.appendFile(work.evidence[0].path,'证据在观察后被改写');
  await assert.rejects(f.service.verifySubmissionEvidence(f.run.runId,session.credential,complete(work)),code('REVIEW_EVIDENCE_CHANGED'));
  assert.equal(f.service.claim(f.run.runId,session.credential)!.observations.length,0);
 }finally{await f.close();}
});

test('整片字节改变时仅凭服务登记的未变分镜及连续音轨复用对应检查',async()=>{
 const f=await fixture();try{
  const pcm=join(f.root,'continuous.wav');await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=538:sample_rate=48000','-t','0.5','-c:a','pcm_s16le',pcm]);
  const audioHash=sha256(await fs.readFile(pcm));
  for(let i=0;i<2;i++){
    const file=join(f.root,`scene-${i}.mp4`);await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-i',f.files[0].file,'-ss',String(i*.25),'-t','0.25','-c:v','mpeg4','-c:a','aac',file]);
    f.files.push({...f.files[0],id:`s${i}`,file,sha256:sha256(await fs.readFile(file)),dur:.25,fromFrame:i*6,toFrame:(i+1)*6});
  }
  const make=async(id:string,update?:(timeline:any)=>void)=>{
    const v=await f.version(id,'final',update);
    await writeJson(join(f.root,'render-jobs',`${id}.json`),{...v.job,continuousAudio:{path:pcm,sha256:audioHash,sourceDigest:v.sourceDigest,sampleRate:48000,samples:24000}});return v;
  };
  await make('first');const first=await f.service.prepare(f.run,{renderRequestIds:['first'],phase:'final'}),s=f.session(first.reviewId);
  let work=f.service.claim(f.run.runId,s.credential);while(work)work=f.service.submit(f.run.runId,s.credential,complete(work)).next;
  // 改变容器字节以覆盖“不能只比较整片 SHA”分支，测试不声称画面实际变化。
  for(const index of [0,1]){const file=join(f.root,`changed-${index}.mp4`);await fs.copyFile(f.files[index].file,file);await fs.appendFile(file,'隔离字节变化');f.files[index]={...f.files[index],file,sha256:sha256(await fs.readFile(file))};}
  await make('second',t=>{t.scenes[0].graphic={x:50};});const second=await f.service.prepare(f.run,{renderRequestIds:['second'],phase:'final'});
  const rows=f.repo.db.prepare('SELECT state,data FROM review_work WHERE review_id=?').all(second.reviewId) as any[];
  const unchanged=rows.find(r=>JSON.parse(r.data).unitId==='scene-s1');assert.equal(unchanged.state,'completed');
  const changed=JSON.parse(rows.find(r=>JSON.parse(r.data).unitId==='scene-s0').data);assert.ok(changed.reused.some((r:any)=>r.checkId==='audio'&&r.basis.includes('PCM')));assert.equal(changed.reused.some((r:any)=>r.checkId==='motion'),false);
 }finally{await f.close();}
});
