import { randomUUID, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonical, sha256, ProductionError, type Run, type RenderRequest, type Delivery } from './contracts.js';
import type { ProductionRepository } from './repository.js';
import { json, regular, treeDigest } from './files.js';
import { createReviewPlan } from './review-policy.js';
import { sceneRangesFromTimeline } from './scene-cut-timeline.js';
import { validateTemplate } from './template-package.js';
import { compareReviewSnapshots, snapshotFiles, type ReviewSnapshot } from './review-invalidation.js';

const text=z.string().trim().min(1).max(4000),frame=z.number().int().nonnegative();
const requestId=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const reviewRangeSchema=z.object({fromFrame:frame,toFrame:frame}).strict().refine(v=>v.toFrame>v.fromFrame,'止帧必须大于起帧');
export const prepareReviewSchema=z.object({renderRequestIds:z.array(requestId).min(1).max(100),phase:z.enum(['pre_export','final']),timelineRef:text.optional()}).strict();
export const claimReviewSchema=z.object({}).strict();
export const readReviewSchema=z.object({reviewId:z.string().uuid()}).strict();
export const submitReviewSchema=z.object({assignmentToken:z.string().uuid(),observations:z.array(z.object({checkId:text,evidenceId:text,note:text,range:reviewRangeSchema.optional()}).strict()).max(1000),issues:z.array(z.object({checkId:text,evidenceId:text,severity:z.enum(['blocking','warning','suggestion']),problem:text,range:reviewRangeSchema.optional()}).strict()).max(1000),status:z.enum(['partial','complete'])}).strict();
export type ReviewRange=z.infer<typeof reviewRangeSchema>;
type Observation=z.infer<typeof submitReviewSchema>['observations'][number];
type Issue=z.infer<typeof submitReviewSchema>['issues'][number];
export type ReviewEvidence={evidenceId:string;kind:'image'|'video';path:string;sha256:string;frame?:number;fromFrame?:number;toFrame?:number;fps:number;width:number;height:number};
export type ReviewCheck={checkId:string;purpose:string;mode:'image'|'video'|'audio'|'audiovisual';evidenceIds:string[];range?:ReviewRange};
type Reuse={reviewId:string;workId:string;checkId:string;evidenceId:string;basis:string};
export type ReviewWork={unitId:string;sceneIds:string[];fromFrame:number;toFrame:number;fps:number;checks:ReviewCheck[];evidence:ReviewEvidence[];observations:Observation[];issues:Issue[];reused:Reuse[]};
type ReviewData={snapshot:ReviewSnapshot;evidence:ReviewEvidence[];renderRequestIds:string[];files:Delivery['files'];missing:string[];audio?:{sha256:string;sampleRate:number;samples:number};runtimeDiagnostic?:string|null};
type Session={id:string;run_id:string;review_id:string;thread_id:string|null;state:string};
function ensure(v:unknown,code:string,message:string):asserts v{if(!v)throw new ProductionError(code,message,409);}
function unique<T>(items:T[]):T[]{return [...new Map(items.map(item=>[canonical(item),item])).values()];}

/** 同一检查目的单独合并半开区间，不能借别项观察填洞。 */
export function missingRanges(range:ReviewRange,observed:ReviewRange[]):ReviewRange[]{
  let cursor=range.fromFrame;const missing:ReviewRange[]=[];
  for(const item of [...observed].sort((a,b)=>a.fromFrame-b.fromFrame)){
    const start=Math.max(range.fromFrame,item.fromFrame),end=Math.min(range.toFrame,item.toFrame);
    if(end<=cursor)continue;if(start>cursor)missing.push({fromFrame:cursor,toFrame:start});cursor=Math.max(cursor,end);
  }
  if(cursor<range.toFrame)missing.push({fromFrame:cursor,toFrame:range.toFrame});return missing;
}
export function remainingChecks(work:ReviewWork){
  return work.checks.flatMap(check=>{
    if(!check.evidenceIds.length)return [{checkId:check.checkId,reason:'缺少本检查要求的真实媒体',ranges:check.range?[check.range]:[]}];
    const observations=work.observations.filter(o=>o.checkId===check.checkId);
    if(check.mode==='image'){
      const missing=check.evidenceIds.filter(id=>!observations.some(o=>o.evidenceId===id)&&!work.reused.some(r=>r.checkId===check.checkId&&r.evidenceId===id));
      return missing.length?[{checkId:check.checkId,reason:'尚未观察全部静帧',evidenceIds:missing,ranges:[]}]:[];
    }
    const ranges=observations.flatMap(o=>o.range?[o.range]:[]);
    for(const reuse of work.reused.filter(r=>r.checkId===check.checkId)){
      const e=work.evidence.find(e=>e.evidenceId===reuse.evidenceId)!;
      ranges.push({fromFrame:Math.max(work.fromFrame,e.fromFrame!),toFrame:Math.min(work.toFrame,e.toFrame!)});
    }
    const missing=missingRanges(check.range!,ranges);
    return missing.length?[{checkId:check.checkId,reason:'连续观察仍有未覆盖范围',ranges:missing}]:[];
  });
}

export class ReviewService{
  constructor(readonly repo:ProductionRepository,readonly runRoot:(run:Run)=>string){}
  runtimeDiagnostic(reviewId:string,message:string|null){this.repo.transaction(()=>{const row=this.repo.db.prepare('SELECT data FROM reviews WHERE id=?').get(reviewId) as any;if(row)this.repo.db.prepare('UPDATE reviews SET data=? WHERE id=?').run(canonical({...JSON.parse(row.data),runtimeDiagnostic:message}),reviewId);});}
  private review(id:string,runId:string){const row=this.repo.db.prepare('SELECT * FROM reviews WHERE id=? AND run_id=?').get(id,runId) as any;ensure(row,'REVIEW_NOT_FOUND','审片计划不属于当前任务');return row;}
  authenticate(runId:string,credential:string,allowStarting=false):Session{
    const row=this.repo.db.prepare('SELECT * FROM review_sessions WHERE run_id=? AND credential_digest=?').get(runId,sha256(credential)) as Session|undefined;
    ensure(row&&((row.state==='active'&&row.thread_id)||(allowStarting&&row.state==='starting')),'REVIEW_AUTH_INVALID','审片凭证未绑定真实线程或已经撤销');
    const run=this.repo.get(runId);ensure(run.state==='running','REVIEW_RUN_STOPPED','任务已停止审片写入');return row;
  }
  createSession(runId:string,reviewId:string){
    ensure(this.review(reviewId,runId).state==='active','REVIEW_SUPERSEDED','不能为已替换计划启动审片者');const id=randomUUID(),credential=randomBytes(32).toString('hex');
    this.repo.db.prepare("INSERT INTO review_sessions(id,run_id,review_id,credential_digest,state) VALUES(?,?,?,?,'starting')").run(id,runId,reviewId,sha256(credential));
    return {id,credential};
  }
  bindSession(id:string,threadId:string){ensure(threadId,'REVIEW_THREAD_MISSING','审片线程尚未建立');this.repo.db.prepare("UPDATE review_sessions SET thread_id=?,state='active' WHERE id=? AND state='starting'").run(threadId,id);}
  releaseSession(id:string,reason:string){
    this.repo.transaction(()=>{
      this.repo.db.prepare("UPDATE review_sessions SET state='revoked',diagnostic=? WHERE id=?").run(reason,id);
      this.repo.db.prepare("UPDATE review_work SET state='pending',session_id=NULL,assignment_token=NULL WHERE session_id=? AND state='assigned'").run(id);
    });
  }
  recoverSessions(runId:string){
    this.repo.transaction(()=>{
      // 新连接不能假称旧线程已恢复；先隔离旧凭证，已有观察继续保留。
      this.repo.db.prepare("UPDATE review_work SET state='pending',session_id=NULL,assignment_token=NULL WHERE state='assigned' AND session_id IN (SELECT id FROM review_sessions WHERE run_id=?)").run(runId);
      this.repo.db.prepare("UPDATE review_sessions SET state='revoked',diagnostic='原审片连接不可恢复，新连接已隔离旧凭证并接替未完成范围' WHERE run_id=? AND state IN ('active','starting')").run(runId);
    });
  }
  /** 文件读取在事务外，事务只负责计划替换与分派隔离。 */
  async prepare(run:Run,input:unknown){
    const request=prepareReviewSchema.parse(input),root=this.runRoot(run);
    ensure(run.stage==='render'&&run.state==='running','REVIEW_STAGE_INVALID','审片只属于运行中的 Render');
    const jobs=await Promise.all([...new Set(request.renderRequestIds)].sort().map(async id=>{
      const job=await json(await regular(root,join('render-jobs',`${id}.json`)));
      ensure(job.runId===run.runId&&job.id===id&&job.sourceDigest,'REVIEW_JOB_INVALID','必须使用当前 Run 已冻结的原媒体作业');
      const project=join(root,job.kind==='frame-preview'||job.input.previewOnly?'preview-snapshots':'render-snapshots',id,'project');
      ensure(await treeDigest(project)===job.sourceDigest,'REVIEW_SOURCE_CHANGED','冻结工程摘要已改变');return {...job,project};
    }));
    const sourceDigest=jobs[0].sourceDigest;ensure(jobs.every(j=>j.sourceDigest===sourceDigest),'REVIEW_MIXED_SOURCE','检查材料必须属于同一冻结版本');
    let timelineRef=request.timelineRef??jobs.find(j=>j.input.timelineRef)?.input.timelineRef;
    if(!timelineRef){
      const audit=this.repo.get(run.runId).checkpoint.sentenceAudioAudits?.[sourceDigest];timelineRef=audit?.timelineRef;
    }
    ensure(timelineRef,'REVIEW_TIMELINE_REQUIRED','原静帧作业没有时间线引用，请提供本快照内的 timelineRef');
    const timeline=await json(await regular(jobs[0].project,timelineRef));
    const scenes=sceneRangesFromTimeline(timeline,(run.request as RenderRequest).dataList,timeline.totalFrames,timeline.fps);
    const normalized=(value:string)=>value.replace(/\s+/gu,'');
    for(const [index,scene] of timeline.scenes.entries()){
      const expected=(run.request as RenderRequest).dataList[index].content;
      ensure(Array.isArray(scene.captions)&&scene.captions.every((c:any)=>typeof c.text==='string')&&normalized(scene.captions.map((c:any)=>c.text).join(''))===normalized(expected),'REVIEW_CONTENT_CHANGED','审片时间线字幕必须完整对应本 Run 确认正文；断行可以改变，不能丢字或换稿');
      if(scene.utterances.every((u:any)=>typeof u.text==='string'))ensure(normalized(scene.utterances.map((u:any)=>u.text).join(''))===normalized(expected),'REVIEW_CONTENT_CHANGED','审片配音正文与当前确认稿不同');
    }
    const manifest=await validateTemplate(jobs[0].project);
    const evidence:ReviewEvidence[]=[],files:Delivery['files']=[];let audio:ReviewData['audio'];
    for(const job of jobs){
      if(job.continuousAudio){const a=job.continuousAudio,path=await regular(root,a.path);ensure(a.sourceDigest===sourceDigest&&sha256(await fs.readFile(path))===a.sha256,'REVIEW_EVIDENCE_CHANGED','服务登记的连续音轨与本版不符');audio={sha256:a.sha256,sampleRate:a.sampleRate,samples:a.samples};}
      for(const f of job.readyFrames??[]){
        const path=await regular(root,f.path);ensure(sha256(await fs.readFile(path))===f.sha256,'REVIEW_EVIDENCE_CHANGED','登记静帧摘要不符');
        ensure(Number.isInteger(f.frame)&&f.frame>=0&&f.frame<timeline.totalFrames,'REVIEW_EVIDENCE_RANGE','登记静帧超出时间线');
        evidence.push({evidenceId:`ev-${sha256(canonical(['image',f.frame,f.sha256])).slice(0,24)}`,kind:'image',path,sha256:f.sha256,frame:f.frame,fps:timeline.fps,width:manifest.width,height:manifest.height});
      }
      for(const f of job.readyFiles??[]){
        if(request.phase==='final')ensure(job.state==='succeeded'&&!job.input.previewOnly,'REVIEW_FINAL_NOT_READY','成片检查必须使用成功的正式导出');
        const path=await regular(root,f.file);ensure(sha256(await fs.readFile(path))===f.sha256,'REVIEW_EVIDENCE_CHANGED','登记视频摘要不符');
        ensure(f.fps===timeline.fps&&f.fromFrame>=0&&f.toFrame<=timeline.totalFrames&&f.toFrame>f.fromFrame,'REVIEW_EVIDENCE_RANGE','登记视频不属于当前全局时间线');
        files.push(f);evidence.push({evidenceId:`ev-${sha256(canonical(['video',f.fromFrame,f.toFrame,f.sha256])).slice(0,24)}`,kind:'video',path,sha256:f.sha256,fromFrame:f.fromFrame,toFrame:f.toFrame,fps:f.fps,width:f.width,height:f.height});
      }
    }
    const actualEvidence=[...new Map(evidence.map(e=>[e.evidenceId,e])).values()],snapshot:ReviewSnapshot={sourceDigest,timeline,files:await snapshotFiles(jobs[0].project),timelineRef};
    // 章节只采纳通过完整性和连续性验证的显式结构；无章节时沿真实分镜组包。
    const plan=createReviewPlan({runId:run.runId,sourceDigest,scenes:scenes.map(s=>({sceneId:s.id,...s})),chapters:timeline.chapters,readyFrames:actualEvidence.filter(e=>e.kind==='image').map(e=>({frame:e.frame!,sourceDigest}))});
    const works:ReviewWork[]=plan.units.map(unit=>{
      const images=actualEvidence.filter(e=>e.kind==='image'&&e.frame!>=unit.fromFrame&&e.frame!<unit.toFrame);
      const video=actualEvidence.filter(e=>e.kind==='video'&&e.toFrame!>unit.fromFrame&&e.fromFrame!<unit.toFrame).sort((a,b)=>(a.toFrame!-a.fromFrame!)-(b.toFrame!-b.fromFrame!));
      // 优先分镜原文件，保留整片作为跨边界连续性证据，不通过静帧推导运动合格。
      const range={fromFrame:unit.fromFrame,toFrame:unit.toFrame};
      const checks:ReviewCheck[]=request.phase==='pre_export'?
        [{checkId:'visual-layout',purpose:'文字、图形、空间遮挡与真实字形',mode:'image',evidenceIds:images.map(e=>e.evidenceId)},
         {checkId:'caption-layout',purpose:'字幕分卡、断行、字号和背景叠加',mode:'image',evidenceIds:images.map(e=>e.evidenceId)}]:
        [{checkId:'motion',purpose:'连续演出、关键中途、接管及语义落点',mode:'video',range,evidenceIds:video.map(e=>e.evidenceId)},
         {checkId:'caption-reading',purpose:'完整阅读、换卡、画面遮挡',mode:'audiovisual',range,evidenceIds:video.map(e=>e.evidenceId)},
         {checkId:'audio',purpose:'听审自然分段、连续性、句尾和混音',mode:'audio',range,evidenceIds:video.map(e=>e.evidenceId)},
         {checkId:'av-sync',purpose:'同时看听字幕、关键动作与当前讲述',mode:'audiovisual',range,evidenceIds:video.map(e=>e.evidenceId)}];
      return {unitId:unit.unitId,sceneIds:unit.sceneIds,...range,fps:timeline.fps,checks,evidence:request.phase==='pre_export'?images:video,observations:[],issues:[],reused:[]};
    });
    if(request.phase==='final'&&scenes.length>1){
      const whole=actualEvidence.filter(e=>e.kind==='video'&&e.fromFrame===0&&e.toFrame===timeline.totalFrames);
      // 缺少更精确演出接点时检查相邻两个实际分镜，不扩大为前后整章或全片。
      for(let index=1;index<scenes.length;index++){
        const left=scenes[index-1],right=scenes[index],range={fromFrame:left.fromFrame,toFrame:right.toFrame};
        works.push({unitId:`continuity-${left.id}-${right.id}`,sceneIds:[left.id,right.id],...range,fps:timeline.fps,evidence:whole,checks:[{checkId:'continuity',purpose:'相邻分镜声音桥、持续对象与接管；范围由实际时间线给出',mode:'audiovisual',range,evidenceIds:whole.map(e=>e.evidenceId)}],observations:[],issues:[],reused:[]});
      }
    }
    const data:ReviewData={snapshot,evidence:actualEvidence,renderRequestIds:jobs.map(j=>j.id),files:unique(files),audio,missing:works.flatMap(w=>w.checks.filter(c=>!c.evidenceIds.length).map(c=>`${w.unitId}/${c.checkId} 缺少材料`))};
    const inputDigest=sha256(canonical({phase:request.phase,sourceDigest,timelineRef,evidence:actualEvidence.map(({path,...e})=>e),policy:1}));
    return this.repo.transaction(()=>{
      const current=this.repo.get(run.runId);this.repo.guard(current,run.token!);ensure(current.state==='running','REVIEW_RUN_STOPPED','任务已停止');
      const previous=this.repo.db.prepare("SELECT * FROM reviews WHERE run_id=? AND phase=? ORDER BY created_at DESC LIMIT 1").get(run.runId,request.phase) as any;
      if(previous?.state==='active'&&previous.input_digest===inputDigest)return this.read(run.runId,previous.id);
      if(previous){
        this.reuse(previous,works,data);
      }
      this.repo.db.prepare("UPDATE review_work SET state='obsolete' WHERE review_id IN (SELECT id FROM reviews WHERE run_id=? AND state='active') AND state!='completed'").run(run.runId);
      this.repo.db.prepare("UPDATE reviews SET state='superseded' WHERE run_id=? AND state='active'").run(run.runId);
      const reviewId=randomUUID();this.repo.db.prepare("INSERT INTO reviews(id,run_id,input_digest,source_digest,phase,state,data,created_at) VALUES(?,?,?,?,?,'active',?,?)").run(reviewId,run.runId,inputDigest,sourceDigest,request.phase,canonical(data),Date.now());
      works.forEach((work,index)=>this.repo.db.prepare('INSERT INTO review_work(id,review_id,ordinal,state,data) VALUES(?,?,?,?,?)').run(randomUUID(),reviewId,index,remainingChecks(work).length?'pending':'completed',canonical(work)));
      // 绑定由 Runtime 明确推进，旧 token 只可查回已接收响应。
      this.repo.db.prepare("UPDATE review_sessions SET review_id=? WHERE run_id=? AND state IN ('active','starting')").run(reviewId,run.runId);
      return this.read(run.runId,reviewId);
    });
  }
  private reuse(previous:any,works:ReviewWork[],data:ReviewData){
    const oldData=JSON.parse(previous.data) as ReviewData,changes=compareReviewSnapshots(oldData.snapshot,data.snapshot);
    const rows=this.repo.db.prepare("SELECT * FROM review_work WHERE review_id=? AND state='completed'").all(previous.id) as any[];
    for(const work of works){
      const old=rows.find(r=>JSON.parse(r.data).unitId===work.unitId);if(!old)continue;
      const before=JSON.parse(old.data) as ReviewWork;
      for(const check of work.checks)for(const id of check.evidenceIds){
        const e=work.evidence.find(e=>e.evidenceId===id)!;
        let matched=before.evidence.find(p=>p.sha256===e.sha256&&p.kind===e.kind&&p.width===e.width&&p.height===e.height&&p.fps===e.fps&&p.frame===e.frame&&p.fromFrame===e.fromFrame&&p.toFrame===e.toFrame);
        let basis='相同媒体字节、显示条件、检查目的及未变相关依赖';
        if(!matched&&e.kind==='video'){
          const range={fromFrame:Math.max(work.fromFrame,e.fromFrame!),toFrame:Math.min(work.toFrame,e.toFrame!)};
          const equalSlices=data.files.filter(f=>f.id!=='whole-video'&&oldData.files.some(p=>p.id===f.id&&p.sha256===f.sha256&&p.fromFrame===f.fromFrame&&p.toFrame===f.toFrame&&p.fps===f.fps&&p.width===f.width&&p.height===f.height));
          const sameAudio=check.mode==='audio'&&data.audio&&canonical(data.audio)===canonical(oldData.audio??null);
          // 整片容器有变化时，等价依据必须来自服务登记的实际分镜字节或连续PCM。
          if(sameAudio||!missingRanges(range,equalSlices).length){
            matched=before.evidence.find(p=>p.kind==='video'&&p.fps===e.fps&&p.width===e.width&&p.height===e.height&&p.fromFrame!<=range.fromFrame&&p.toFrame!>=range.toFrame);
            basis=sameAudio?'服务连续 PCM 字节、采样规格与当前摆放一致':'范围内所有正式分镜文件字节、规格、全局摆放及相关依赖一致';
          }
        }
        if(!matched||before.issues.some(i=>i.checkId===check.checkId))continue;
        if(!before.checks.some(c=>c.checkId===check.checkId&&c.mode===check.mode))continue;
        if(check.mode!=='image'&&changes.some(c=>c.sceneIds.some(s=>work.sceneIds.includes(s))&&c.checkIds.includes(check.checkId)))continue;
        if(check.mode!=='image'&&missingRanges({fromFrame:Math.max(work.fromFrame,e.fromFrame!),toFrame:Math.min(work.toFrame,e.toFrame!)},before.observations.filter(o=>o.checkId===check.checkId&&o.evidenceId===matched.evidenceId&&o.range).map(o=>o.range!)).length&&!before.reused.some(r=>r.checkId===check.checkId&&r.evidenceId===matched.evidenceId))continue;
        if(check.mode==='image'&&!before.observations.some(o=>o.checkId===check.checkId&&o.evidenceId===matched.evidenceId)&&!before.reused.some(r=>r.checkId===check.checkId&&r.evidenceId===matched.evidenceId))continue;
        work.reused.push({reviewId:previous.id,workId:old.id,checkId:check.checkId,evidenceId:id,basis:`${basis}；引用原观察，未声称重新看听`});
      }
    }
  }
  private claimInside(session:Session){
    const review=this.review(session.review_id,session.run_id);ensure(review.state==='active','REVIEW_SUPERSEDED','计划已被替换，请读取当前分派');
    let row=this.repo.db.prepare("SELECT * FROM review_work WHERE session_id=? AND state='assigned'").get(session.id) as any;
    if(!row){
      row=this.repo.db.prepare("SELECT * FROM review_work WHERE review_id=? AND state='pending' ORDER BY ordinal LIMIT 1").get(session.review_id) as any;
      if(!row)return null;
      const token=randomUUID();this.repo.db.prepare("UPDATE review_work SET state='assigned',session_id=?,assignment_token=?,generation=generation+1 WHERE id=?").run(session.id,token,row.id);row={...row,state:'assigned',session_id:session.id,assignment_token:token};
    }
    const work=JSON.parse(row.data) as ReviewWork;
    return {assignmentToken:row.assignment_token,reviewId:session.review_id,...work,remaining:remainingChecks(work)};
  }
  claim(runId:string,credential:string,input:unknown={}){claimReviewSchema.parse(input);return this.repo.transaction(()=>this.claimInside(this.authenticate(runId,credential)));}
  async verifySubmissionEvidence(runId:string,credential:string,input:unknown){
    const body=submitReviewSchema.parse(input),session=this.authenticate(runId,credential);
    const row=this.repo.db.prepare("SELECT data FROM review_work WHERE assignment_token=? AND session_id=? AND state='assigned' AND review_id=?").get(body.assignmentToken,session.id,session.review_id) as any;
    if(!row)return;const work=JSON.parse(row.data) as ReviewWork,root=this.runRoot(this.repo.get(runId));
    // 大文件摘要在提交事务外核对；事务内还会重新确认当前版本和分派。
    for(const id of new Set([...body.observations,...body.issues].map(item=>item.evidenceId))){const e=work.evidence.find(e=>e.evidenceId===id);if(e)ensure(sha256(await fs.readFile(await regular(root,e.path)))===e.sha256,'REVIEW_EVIDENCE_CHANGED','观察期间媒体证据发生改变，请保留观察并重新准备本版材料');}
  }
  submit(runId:string,credential:string,input:unknown){
    const body=submitReviewSchema.parse(input),digest=sha256(canonical(body));
    return this.repo.transaction(()=>{
      const session=this.authenticate(runId,credential);
      // 先恢复原接收结果，完成后的正常重试不应被误判为过期。
      const old=this.repo.db.prepare('SELECT response FROM review_submissions WHERE session_id=? AND assignment_token=? AND body_digest=?').get(session.id,body.assignmentToken,digest) as any;
      if(old){const response=JSON.parse(old.response);if(response.next?.assignmentToken){const next=this.repo.db.prepare("SELECT id FROM review_work WHERE assignment_token=? AND session_id=? AND state='assigned' AND review_id=?").get(response.next.assignmentToken,session.id,session.review_id);if(!next){response.next=null;response.nextAssignmentRevoked=true;}}return response;}
      const row=this.repo.db.prepare('SELECT * FROM review_work WHERE assignment_token=? AND session_id=?').get(body.assignmentToken,session.id) as any;
      if(!row||row.state!=='assigned'||row.review_id!==session.review_id){
        const response={accepted:false,code:'REVIEW_ASSIGNMENT_STALE',reason:'分派已结束或版本已改变，仅保存迟到记录',nextStep:'调用 claim_review_work 取得当前分派'};this.saveSubmission(session,body,digest,response,false);return response;
      }
      const work=JSON.parse(row.data) as ReviewWork;
      const validate=(item:Observation|Issue)=>{
        const check=work.checks.find(c=>c.checkId===item.checkId),e=work.evidence.find(e=>e.evidenceId===item.evidenceId);
        ensure(check&&e&&check.evidenceIds.includes(e.evidenceId),'REVIEW_EVIDENCE_SCOPE','观察或问题必须属于当前检查和证据');
        if(check.mode==='image')ensure(!item.range&&e.kind==='image','REVIEW_MODE_INVALID','静帧使用登记帧号，不能冒充连续看听');
        else ensure(item.range&&e.kind==='video'&&item.range.fromFrame>=Math.max(work.fromFrame,e.fromFrame!)&&item.range.toFrame<=Math.min(work.toFrame,e.toFrame!),'REVIEW_RANGE_INVALID','连续媒体必须提交实际观察的全局半开区间');
      };
      body.observations.forEach(validate);body.issues.forEach(validate);
      work.observations=unique([...work.observations,...body.observations]);
      for(const issue of body.issues){
        const observed=work.observations.filter(o=>o.checkId===issue.checkId&&o.evidenceId===issue.evidenceId);
        ensure(issue.range?!missingRanges(issue.range,observed.flatMap(o=>o.range?[o.range]:[])).length:observed.length,'REVIEW_ISSUE_UNOBSERVED','问题落点必须位于实际观察范围');
      }
      work.issues=unique([...work.issues,...body.issues]);
      const remaining=remainingChecks(work),completed=body.status==='complete'&&!remaining.length;
      this.repo.db.prepare('UPDATE review_work SET data=?,state=? WHERE id=?').run(canonical(work),completed?'completed':'assigned',row.id);
      const response={accepted:true,status:completed?'complete':'partial',remaining,next:completed?this.claimInside(session):null};
      this.saveSubmission(session,body,digest,response,true);return response;
    });
  }
  private saveSubmission(session:Session,body:z.infer<typeof submitReviewSchema>,digest:string,response:unknown,accepted:boolean){this.repo.db.prepare('INSERT INTO review_submissions(session_id,assignment_token,body_digest,body,response,accepted,created_at) VALUES(?,?,?,?,?,?,?)').run(session.id,body.assignmentToken,digest,canonical(body),canonical(response),Number(accepted),Date.now());}
  read(runId:string,reviewId:string){
    const review=this.review(reviewId,runId),rows=this.repo.db.prepare('SELECT state,data FROM review_work WHERE review_id=? ORDER BY ordinal').all(reviewId) as any[],data=JSON.parse(review.data) as ReviewData;
    const work=rows.map(r=>({...JSON.parse(r.data) as ReviewWork,state:r.state})),issues=work.flatMap(w=>w.issues.map(i=>({unitId:w.unitId,...i})));
    return {reviewId,phase:review.phase,sourceDigest:review.source_digest,state:review.state,total:rows.length,remaining:rows.filter(r=>r.state!=='completed').length,missing:data.missing,issues,...(data.runtimeDiagnostic?{runtimeDiagnostic:data.runtimeDiagnostic}:{}),sessions:this.repo.db.prepare('SELECT thread_id,state,diagnostic FROM review_sessions WHERE review_id=?').all(reviewId),unobserved:work.filter(w=>w.state!=='completed').map(w=>({unitId:w.unitId,remaining:remainingChecks(w)}))};
  }
  assertDelivery(runId:string,sourceDigest:string,files:Delivery['files']){
    const row=this.repo.db.prepare("SELECT * FROM reviews WHERE run_id=? AND source_digest=? AND phase='final' AND state='active' ORDER BY created_at DESC LIMIT 1").get(runId,sourceDigest) as any;
    ensure(row,'REVIEW_REQUIRED','发布前必须完成本版成片专业审查');
    const summary=this.read(runId,row.id),data=JSON.parse(row.data) as ReviewData;
    ensure(!summary.remaining&&!summary.missing.length&&!summary.issues.some(i=>i.severity!=='suggestion'),'REVIEW_INCOMPLETE','仍有未看听范围或未处置问题，不能发布');
    ensure(files.every(f=>data.files.some(e=>e.id===f.id&&e.sha256===f.sha256&&e.fromFrame===f.fromFrame&&e.toFrame===f.toFrame&&e.fps===f.fps&&e.width===f.width&&e.height===f.height)),'REVIEW_DELIVERY_CHANGED','待发布文件与专业审查证据不一致');
    return {reviewId:row.id,sourceDigest};
  }
}
