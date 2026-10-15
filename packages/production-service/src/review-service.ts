import { randomUUID, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonical, sha256, ProductionError, type Run, type RenderRequest } from './contracts.js';
import type { ProductionRepository } from './repository.js';
import { json, regular, treeDigest } from './files.js';
import { createReviewPlan } from './review-policy.js';
import { preflightTimeline } from './production-timeline.js';
import { MediaJobEvents } from './run-work.js';
import { compareReviewSnapshots, snapshotFiles, type ReviewSnapshot } from './review-invalidation.js';

const text=z.string().trim().min(1).max(4000),frame=z.number().int().nonnegative();
const requestId=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const reviewRangeSchema=z.object({fromFrame:frame,toFrame:frame}).strict().refine(v=>v.toFrame>v.fromFrame,'止帧必须大于起帧');
export const prepareReviewSchema=z.object({renderRequestIds:z.array(requestId).min(1).max(100),phase:z.literal('pre_export'),timelineRef:text.optional(),waitMs:z.number().int().min(0).max(60000).default(0)}).strict();
export const claimReviewSchema=z.object({}).strict();
export const readReviewSchema=z.object({reviewId:z.string().uuid(),afterDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),waitMs:z.number().int().min(0).max(60000).default(0)}).strict();
export const submitReviewSchema=z.object({assignmentToken:z.string().uuid(),observations:z.array(z.object({checkId:text,evidenceId:text,note:text,range:reviewRangeSchema.optional()}).strict()).max(1000),issues:z.array(z.object({checkId:text,evidenceId:text,severity:z.enum(['blocking','warning','suggestion']),problem:text,range:reviewRangeSchema.optional()}).strict()).max(1000),issueResolutions:z.array(z.object({issueId:text,evidenceId:text.optional(),resolution:z.enum(['resolved','retained']),note:text}).strict()).max(1000).optional(),status:z.enum(['partial','complete'])}).strict();
export type ReviewRange=z.infer<typeof reviewRangeSchema>;
type Observation=z.infer<typeof submitReviewSchema>['observations'][number];
type Issue=z.infer<typeof submitReviewSchema>['issues'][number];
// 保留历史连续媒体记录的读取类型；新计划只创建图片检查包。
export type ReviewEvidence={evidenceId:string;kind:'image'|'video';path:string;sha256:string;sceneId?:string;frame?:number;fromFrame?:number;toFrame?:number;fps:number;width:number;height:number};
export type ReviewCheck={checkId:string;purpose:string;mode:'image'|'video'|'audio'|'audiovisual';ruleVersion?:number;evidenceIds:string[];range?:ReviewRange};
type PendingIssue=Issue&{issueId:string;sourceReviewId:string;sourceWorkId:string;currentEvidenceId?:string;resolution?:'resolved'|'retained';resolutionNote?:string};
type Reuse={reviewId:string;workId:string;checkId:string;evidenceId:string;basis:string};
export type ReviewWork={unitId:string;sceneIds:string[];fromFrame:number;toFrame:number;fps:number;checks:ReviewCheck[];evidence:ReviewEvidence[];observations:Observation[];issues:Issue[];pendingIssues?:PendingIssue[];context?:{confirmedScenes:{id:string;content:string}[];chapter:unknown};reused:Reuse[]};
type ReviewMetrics={preparedAt:number;firstClaimedAt:number|null;lastAcceptedSubmissionAt:number|null;readQueryCount:number;readTimeoutCount:number};
type ReviewData={metrics?:ReviewMetrics;changes?:ReturnType<typeof compareReviewSnapshots>;snapshot:ReviewSnapshot;evidence:ReviewEvidence[];renderRequestIds:string[];missing:string[];runtimeDiagnostic?:string|null};
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
export function remainingChecks(work:ReviewWork):Array<{checkId:string;reason:string;evidenceIds?:string[];ranges:ReviewRange[]}>{
  const remaining:Array<{checkId:string;reason:string;evidenceIds?:string[];ranges:ReviewRange[]}>=work.checks.flatMap(check=>{
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
  for(const issue of work.pendingIssues??[])if(!issue.resolution&&issue.severity!=='suggestion')remaining.push({checkId:issue.checkId,reason:`旧问题尚待复查及明确处置：${issue.issueId}`,evidenceIds:issue.currentEvidenceId?[issue.currentEvidenceId]:[],ranges:[]});
  return remaining;
}

export class ReviewService{
  readonly events=new MediaJobEvents();
  private shutdown=new AbortController();
  close(){this.shutdown.abort();}
  constructor(readonly repo:ProductionRepository,readonly runRoot:(run:Run)=>string){}
  runtimeDiagnostic(reviewId:string,message:string|null){this.repo.transaction(()=>{const row=this.repo.db.prepare('SELECT data FROM reviews WHERE id=?').get(reviewId) as any;if(row)this.repo.db.prepare('UPDATE reviews SET data=? WHERE id=?').run(canonical({...JSON.parse(row.data),runtimeDiagnostic:message}),reviewId);});this.events.notify(reviewId);}
  sessionDiagnostic(id:string,message:string|null){const session=this.repo.db.prepare('SELECT review_id FROM review_sessions WHERE id=?').get(id) as any;this.repo.db.prepare('UPDATE review_sessions SET diagnostic=? WHERE id=?').run(message,id);if(session)this.events.notify(session.review_id);}
  private notifyRun(runId:string){for(const row of this.repo.db.prepare('SELECT id FROM reviews WHERE run_id=?').all(runId) as any[])this.events.notify(row.id);}
  /** 观测字段留在原计划中；调用方已有事务时合并更新，计数不发送进展通知。 */
  private updateMetrics(reviewId:string,update:(metrics:ReviewMetrics)=>void){
    const row=this.repo.db.prepare('SELECT data,created_at FROM reviews WHERE id=?').get(reviewId) as any;
    ensure(row,'REVIEW_NOT_FOUND','审片计划不存在');const data=JSON.parse(row.data) as ReviewData;
    const metrics=data.metrics??{preparedAt:row.created_at,firstClaimedAt:null,lastAcceptedSubmissionAt:null,readQueryCount:0,readTimeoutCount:0};
    update(metrics);data.metrics=metrics;this.repo.db.prepare('UPDATE reviews SET data=? WHERE id=?').run(canonical(data),reviewId);
  }
  private review(id:string,runId:string){const row=this.repo.db.prepare('SELECT * FROM reviews WHERE id=? AND run_id=?').get(id,runId) as any;ensure(row,'REVIEW_NOT_FOUND','审片计划不属于当前任务');return row;}
  authenticate(runId:string,credential:string,allowStarting=false):Session{
    const row=this.repo.db.prepare('SELECT * FROM review_sessions WHERE run_id=? AND credential_digest=?').get(runId,sha256(credential)) as Session|undefined;
    ensure(row&&((row.state==='active'&&row.thread_id)||(allowStarting&&row.state==='starting')),'REVIEW_AUTH_INVALID','审片凭证未绑定真实线程或已经撤销');
    const run=this.repo.get(runId);ensure(run.state==='running','REVIEW_RUN_STOPPED','任务已停止审片写入');return row;
  }
  createSession(runId:string,reviewId:string){
    ensure(this.review(reviewId,runId).state==='active','REVIEW_SUPERSEDED','不能为已替换计划启动审片者');const id=randomUUID(),credential=randomBytes(32).toString('hex');
    this.repo.db.prepare("INSERT INTO review_sessions(id,run_id,review_id,credential_digest,state) VALUES(?,?,?,?,'starting')").run(id,runId,reviewId,sha256(credential));
    this.events.notify(reviewId);return {id,credential};
  }
  bindSession(id:string,threadId:string){ensure(threadId,'REVIEW_THREAD_MISSING','审片线程尚未建立');this.repo.db.prepare("UPDATE review_sessions SET thread_id=?,state='active' WHERE id=? AND state='starting'").run(threadId,id);const row=this.repo.db.prepare('SELECT review_id FROM review_sessions WHERE id=?').get(id) as any;if(row)this.events.notify(row.review_id);}
  releaseSession(id:string,reason:string){
    this.repo.transaction(()=>{
      this.repo.db.prepare("UPDATE review_sessions SET state='revoked',diagnostic=? WHERE id=?").run(reason,id);
      this.repo.db.prepare("UPDATE review_work SET state='pending',session_id=NULL,assignment_token=NULL WHERE session_id=? AND state='assigned'").run(id);
    });const session=this.repo.db.prepare('SELECT review_id FROM review_sessions WHERE id=?').get(id) as any;if(session)this.events.notify(session.review_id);
  }
  recoverSessions(runId:string){
    this.repo.transaction(()=>{
      // 新连接不能假称旧线程已恢复；先隔离旧凭证，已有观察继续保留。
      this.repo.db.prepare("UPDATE review_work SET state='pending',session_id=NULL,assignment_token=NULL WHERE state='assigned' AND session_id IN (SELECT id FROM review_sessions WHERE run_id=?)").run(runId);
      this.repo.db.prepare("UPDATE review_sessions SET state='revoked',diagnostic='原审片连接不可恢复，新连接已隔离旧凭证并接替未完成范围' WHERE run_id=? AND state IN ('active','starting')").run(runId);
    });this.notifyRun(runId);
  }
  /** 文件读取在事务外，事务只负责计划替换与分派隔离。 */
  async prepare(run:Run,input:unknown,options:{events?:MediaJobEvents;signal?:AbortSignal;isRunning?:(id:string)=>boolean}={}):Promise<any>{
    const request=prepareReviewSchema.parse(input),root=this.runRoot(run);
    options={...options,signal:options.signal?AbortSignal.any([options.signal,this.shutdown.signal]):this.shutdown.signal};
    ensure(run.stage==='render'&&run.state==='running','REVIEW_STAGE_INVALID','审片只属于运行中的 Render');
    const ids=[...new Set(request.renderRequestIds)].sort(),deadline=Date.now()+request.waitMs;
    let jobs:any[]=[];
    // 先订阅全部原作业，再读取；任何一批更新都只触发重读，不提交新媒体任务。
    while(true){
      const subscriptions=ids.map(id=>(options.events??this.events).subscribe(`${run.runId}:${id}`,Math.max(0,deadline-Date.now()),options.signal));
      try{
        ensure(!options.signal?.aborted,'PROCESS_CANCELLED','审片准备等待已取消');
        const current=this.repo.get(run.runId);this.repo.guard(current,run.token!);ensure(current.state==='running','REVIEW_RUN_STOPPED','任务已停止');
        jobs=await Promise.all(ids.map(async id=>{
          const job=await json(await regular(root,join('render-jobs',`${id}.json`)));
          ensure(job.runId===run.runId&&job.id===id&&job.kind==='frame-preview','REVIEW_JOB_INVALID','必须使用当前 Run 已受理的原静帧作业');
          if(['running','queued'].includes(job.state)&&options.isRunning&&!options.isRunning(id))return {...job,state:'unknown',error:'无法确认原静帧执行状态，请核查原作业'};return job;
        }));
        const failed=jobs.filter(job=>['failed','cancelled','unknown'].includes(job.state));
        if(failed.length)return {state:'media_failed',jobs:failed.map(({id,state,error,sourceDigest})=>({renderRequestId:id,state,error,sourceDigest})),pendingJobs:jobs.filter(j=>!['succeeded','failed','cancelled','unknown'].includes(j.state)).map(j=>({renderRequestId:j.id,state:j.state}))};
        const pendingJobs=jobs.filter(job=>job.state!=='succeeded').map(job=>({renderRequestId:job.id,state:job.state}));
        if(!pendingJobs.length)break;
        if(Date.now()>=deadline)return {state:'waiting_media',pendingJobs,timedOut:request.waitMs>0};
        await Promise.race(subscriptions.map(s=>s.promise));
      }finally{for(const subscription of subscriptions)subscription.dispose();}
    }
    jobs=await Promise.all(jobs.map(async job=>{
      ensure(job.sourceDigest,'REVIEW_JOB_INVALID','成功静帧必须含冻结快照身份');
      const project=join(root,'preview-snapshots',job.id,'project');
      ensure(await treeDigest(project)===job.sourceDigest,'REVIEW_SOURCE_CHANGED','冻结工程摘要已改变');return {...job,project};
    }));
    const sourceDigest=jobs[0].sourceDigest;ensure(jobs.every(j=>j.sourceDigest===sourceDigest),'REVIEW_MIXED_SOURCE','检查材料必须属于同一冻结版本');
    let timelineRef=request.timelineRef??jobs.find(j=>j.input.timelineRef)?.input.timelineRef;
    if(!timelineRef){
      const audit=this.repo.get(run.runId).checkpoint.sentenceAudioAudits?.[sourceDigest];timelineRef=audit?.timelineRef;
    }
    const checked=await preflightTimeline(jobs[0].project,(run.request as RenderRequest).dataList,{timelineRef});
    const {timeline,manifest,ranges:scenes,chapters}=checked;timelineRef=checked.timelineRef;
    const evidence:ReviewEvidence[]=[];
    for(const job of jobs){
      for(const f of job.readyFrames??[]){
        const path=await regular(root,f.path);ensure(sha256(await fs.readFile(path))===f.sha256,'REVIEW_EVIDENCE_CHANGED','登记静帧摘要不符');
        ensure(Number.isInteger(f.frame)&&f.frame>=0&&f.frame<timeline.totalFrames,'REVIEW_EVIDENCE_RANGE','登记静帧超出时间线');
        evidence.push({evidenceId:`ev-${sha256(canonical(['image',f.frame,f.sha256])).slice(0,24)}`,kind:'image',sceneId:scenes.find(s=>f.frame>=s.fromFrame&&f.frame<s.toFrame)!.id,path,sha256:f.sha256,frame:f.frame,fps:timeline.fps,width:manifest.width,height:manifest.height});
      }
    }
    const actualEvidence=[...new Map(evidence.map(e=>[e.evidenceId,e])).values()],snapshot:ReviewSnapshot={sourceDigest,timeline,files:await snapshotFiles(jobs[0].project),timelineRef};
    const plan=createReviewPlan({runId:run.runId,sourceDigest,scenes:scenes.map(s=>({sceneId:s.id,...s})),chapters,readyFrames:actualEvidence.filter(e=>e.kind==='image').map(e=>({frame:e.frame!,sourceDigest}))});
    const works:ReviewWork[]=plan.units.map(unit=>{
      const images=actualEvidence.filter(e=>e.kind==='image'&&e.frame!>=unit.fromFrame&&e.frame!<unit.toFrame);
      // 当前宿主只做静帧观察；完成图片检查不要求也不声称完成连续视听。
      const checks:ReviewCheck[]=
        [{checkId:'visual-layout',purpose:'文字、图表语义、空间遮挡与真实字形',ruleVersion:1,mode:'image',evidenceIds:images.map(e=>e.evidenceId)},
         {checkId:'caption-layout',purpose:'字幕分卡、断行、字号和背景叠加',ruleVersion:1,mode:'image',evidenceIds:images.map(e=>e.evidenceId)}];
      return {unitId:unit.unitId,sceneIds:unit.sceneIds,fromFrame:unit.fromFrame,toFrame:unit.toFrame,fps:timeline.fps,checks,evidence:images,observations:[],issues:[],pendingIssues:[],context:{confirmedScenes:(run.request as RenderRequest).dataList.filter(s=>unit.sceneIds.includes(s.id)),chapter:timeline.chapters?.find((c:any)=>`chapter-${c.id}`===unit.unitId)??null},reused:[]};
    });
    const data:ReviewData={metrics:{preparedAt:Date.now(),firstClaimedAt:null,lastAcceptedSubmissionAt:null,readQueryCount:0,readTimeoutCount:0},snapshot,evidence:actualEvidence,renderRequestIds:jobs.map(j=>j.id),missing:works.flatMap(w=>w.checks.filter(c=>!c.evidenceIds.length).map(c=>`${w.unitId}/${c.checkId} 缺少材料`))};
    const inputDigest=sha256(canonical({phase:request.phase,sourceDigest,timelineRef,evidence:actualEvidence.map(({path,...e})=>e),policy:2}));
    const result=this.repo.transaction(()=>{
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
    });this.notifyRun(run.runId);return result;
  }
  private reuse(previous:any,works:ReviewWork[],data:ReviewData){
    const oldData=JSON.parse(previous.data) as ReviewData,changes=compareReviewSnapshots(oldData.snapshot,data.snapshot);data.changes=changes;
    // partial 中服务已接收的观察具有同等证据身份；未观察部分仍保留 remaining。
    const rows=this.repo.db.prepare('SELECT * FROM review_work WHERE review_id=?').all(previous.id) as any[];
    for(const work of works){
      const old=rows.find(r=>JSON.parse(r.data).unitId===work.unitId);if(!old)continue;
      const before=JSON.parse(old.data) as ReviewWork;
      const sameContext=canonical(before.context??null)===canonical(work.context??null)&&canonical(before.sceneIds)===canonical(work.sceneIds);
      for(const check of work.checks)for(const id of check.evidenceIds){
        const e=work.evidence.find(e=>e.evidenceId===id)!;
        const matched=before.evidence.find(p=>p.sha256===e.sha256&&p.kind===e.kind&&p.width===e.width&&p.height===e.height&&p.fps===e.fps&&p.frame===e.frame&&p.sceneId===e.sceneId&&p.fromFrame===e.fromFrame&&p.toFrame===e.toFrame);
        if(!matched||!sameContext)continue;
        if(!before.checks.some(c=>c.checkId===check.checkId&&c.mode===check.mode&&c.purpose===check.purpose&&c.ruleVersion===check.ruleVersion))continue;
        if(changes.some(c=>c.checkIds.includes(check.checkId)&&(c.chapterWide?c.sceneIds.some(id=>work.sceneIds.includes(id)):c.sceneIds.includes(e.sceneId??'')&&(!c.frameRanges||c.frameRanges.some(r=>e.frame!>=r.fromFrame&&e.frame!<r.toFrame)))))continue;
        if(check.mode!=='image'||!before.observations.some(o=>o.checkId===check.checkId&&o.evidenceId===matched.evidenceId)&&!before.reused.some(r=>r.checkId===check.checkId&&r.evidenceId===matched.evidenceId))continue;
        work.reused.push({reviewId:previous.id,workId:old.id,checkId:check.checkId,evidenceId:id,basis:'相同媒体字节、尺寸、帧率、帧号、目的规则、场景章节语义及未变相关依赖；引用原已接收观察，未声称重新看听'});
        work.issues.push(...before.issues.filter(i=>i.checkId===check.checkId&&i.evidenceId===matched.evidenceId).map(i=>({...i,evidenceId:id})));
      }
      for(const issue of before.issues){
        if(work.reused.some(r=>r.checkId===issue.checkId&&r.evidenceId===issue.evidenceId))continue;
        const oldEvidence=before.evidence.find(e=>e.evidenceId===issue.evidenceId);
        const current=work.evidence.find(e=>e.sceneId===oldEvidence?.sceneId&&e.frame===oldEvidence?.frame);
        work.pendingIssues!.push({...issue,issueId:sha256(canonical([previous.id,old.id,issue])),sourceReviewId:previous.id,sourceWorkId:old.id,currentEvidenceId:current?.evidenceId});
      }
      // 旧待复查问题不因新数组为空消失；只有显式处置才能关闭。
      for(const issue of before.pendingIssues??[])if(!issue.resolution)work.pendingIssues!.push({...issue,currentEvidenceId:work.evidence.some(e=>e.evidenceId===issue.currentEvidenceId)?issue.currentEvidenceId:undefined});
    }
    for(const row of rows){
      const before=JSON.parse(row.data) as ReviewWork;
      if(works.some(w=>w.unitId===before.unitId))continue;
      const target=works.find(w=>w.sceneIds.some(id=>before.sceneIds.includes(id)))??works[0];
      if(!target)continue;
      target.pendingIssues!.push(...before.issues.map(issue=>({...issue,issueId:sha256(canonical([previous.id,row.id,issue])),sourceReviewId:previous.id,sourceWorkId:row.id})),...(before.pendingIssues??[]).filter(i=>!i.resolution).map(i=>({...i,currentEvidenceId:undefined})));
    }
  }
  private claimInside(session:Session){
    const review=this.review(session.review_id,session.run_id);ensure(review.state==='active','REVIEW_SUPERSEDED','计划已被替换，请读取当前分派');
    let row=this.repo.db.prepare("SELECT * FROM review_work WHERE session_id=? AND state='assigned'").get(session.id) as any;
    if(!row){
      row=this.repo.db.prepare("SELECT * FROM review_work WHERE review_id=? AND state='pending' ORDER BY ordinal LIMIT 1").get(session.review_id) as any;
      if(!row)return null;
      this.updateMetrics(session.review_id,metrics=>{metrics.firstClaimedAt??=Date.now();});
      const token=randomUUID();this.repo.db.prepare("UPDATE review_work SET state='assigned',session_id=?,assignment_token=?,generation=generation+1 WHERE id=?").run(session.id,token,row.id);row={...row,state:'assigned',session_id:session.id,assignment_token:token};
    }
    const work=JSON.parse(row.data) as ReviewWork;
    return {assignmentToken:row.assignment_token,reviewId:session.review_id,...work,remaining:remainingChecks(work)};
  }
  claim(runId:string,credential:string,input:unknown={}){claimReviewSchema.parse(input);const result=this.repo.transaction(()=>this.claimInside(this.authenticate(runId,credential)));this.notifyRun(runId);return result;}
  async verifySubmissionEvidence(runId:string,credential:string,input:unknown){
    const body=submitReviewSchema.parse(input),session=this.authenticate(runId,credential);
    const row=this.repo.db.prepare("SELECT data FROM review_work WHERE assignment_token=? AND session_id=? AND state='assigned' AND review_id=?").get(body.assignmentToken,session.id,session.review_id) as any;
    if(!row)return;const work=JSON.parse(row.data) as ReviewWork,root=this.runRoot(this.repo.get(runId));
    // 大文件摘要在提交事务外核对；事务内还会重新确认当前版本和分派。
    for(const id of new Set([...body.observations,...body.issues].map(item=>item.evidenceId).concat((body.issueResolutions??[]).flatMap(item=>{const id=item.evidenceId??work.pendingIssues?.find(issue=>issue.issueId===item.issueId)?.currentEvidenceId;return id?[id]:[];})))){const e=work.evidence.find(e=>e.evidenceId===id);if(e)ensure(sha256(await fs.readFile(await regular(root,e.path)))===e.sha256,'REVIEW_EVIDENCE_CHANGED','观察期间媒体证据发生改变，请保留观察并重新准备本版材料');}
  }
  submit(runId:string,credential:string,input:unknown){
    const body=submitReviewSchema.parse(input),digest=sha256(canonical(body));
    const result=this.repo.transaction(()=>{
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
      for(const resolution of body.issueResolutions??[]){
        const issue=work.pendingIssues?.find(i=>i.issueId===resolution.issueId);
        ensure(issue&&!issue.resolution,'REVIEW_ISSUE_SCOPE','待复查问题不属于当前包或已经处置');
        const evidenceId=resolution.evidenceId??issue.currentEvidenceId;
        ensure(evidenceId&&work.observations.some(o=>o.checkId===issue.checkId&&o.evidenceId===evidenceId),'REVIEW_ISSUE_UNOBSERVED','问题处置须先查看当前对应图片；旧帧已删除时指定新证据编号');
        issue.currentEvidenceId=evidenceId;
        issue.resolution=resolution.resolution;issue.resolutionNote=resolution.note;
        if(resolution.resolution==='retained')work.issues=unique([...work.issues,{checkId:issue.checkId,evidenceId:issue.currentEvidenceId,severity:issue.severity,problem:issue.problem}]);
      }
      const remaining=remainingChecks(work),completed=body.status==='complete'&&!remaining.length;
      this.repo.db.prepare('UPDATE review_work SET data=?,state=? WHERE id=?').run(canonical(work),completed?'completed':'assigned',row.id);
      const response={accepted:true,status:completed?'complete':'partial',remaining,next:completed?this.claimInside(session):null};
      this.updateMetrics(session.review_id,metrics=>{metrics.lastAcceptedSubmissionAt=Date.now();});
      this.saveSubmission(session,body,digest,response,true);return response;
    });this.notifyRun(runId);return result;
  }
  private saveSubmission(session:Session,body:z.infer<typeof submitReviewSchema>,digest:string,response:unknown,accepted:boolean){this.repo.db.prepare('INSERT INTO review_submissions(session_id,assignment_token,body_digest,body,response,accepted,created_at) VALUES(?,?,?,?,?,?,?)').run(session.id,body.assignmentToken,digest,canonical(body),canonical(response),Number(accepted),Date.now());}
  read(runId:string,reviewId:string){
    const review=this.review(reviewId,runId),rows=this.repo.db.prepare('SELECT state,data FROM review_work WHERE review_id=? ORDER BY ordinal').all(reviewId) as any[],data=JSON.parse(review.data) as ReviewData;
    const work=rows.map(r=>({...JSON.parse(r.data) as ReviewWork,state:r.state})),issues=work.flatMap(w=>w.issues.map(i=>({unitId:w.unitId,...i})));
    const summary={reviewId,runState:this.repo.get(runId).state,phase:review.phase,sourceDigest:review.source_digest,state:review.state,total:rows.length,remaining:rows.filter(r=>r.state!=='completed').length,missing:data.missing,changes:data.changes??[],requiredObservationCount:work.reduce((n,w)=>n+w.checks.reduce((n,c)=>n+c.evidenceIds.length,0),0),issues,pendingIssues:work.flatMap(w=>(w.pendingIssues??[]).filter(i=>!i.resolution).map(i=>({unitId:w.unitId,...i}))),observationCount:new Set(work.flatMap(w=>w.observations.map(o=>canonical([o.checkId,o.evidenceId])))).size,reusedCount:work.reduce((n,w)=>n+w.reused.length,0),...(data.runtimeDiagnostic?{runtimeDiagnostic:data.runtimeDiagnostic}:{}),sessions:this.repo.db.prepare('SELECT thread_id,state,diagnostic FROM review_sessions WHERE review_id=? ORDER BY id').all(reviewId),unobserved:work.filter(w=>w.state!=='completed').map(w=>({unitId:w.unitId,remaining:remainingChecks(w)}))};
    const metrics=data.metrics??{preparedAt:review.created_at,firstClaimedAt:null,lastAcceptedSubmissionAt:null,readQueryCount:0,readTimeoutCount:0};
    const {readQueryCount,readTimeoutCount,...progress}=metrics;
    // 查询次数只用于耗时分析；不能让本次查询本身改变摘要、提前唤醒等待。
    return {...summary,metrics,statusDigest:sha256(canonical({...summary,metrics:progress})),timedOut:false};
  }
  async readWait(runId:string,input:unknown,signal?:AbortSignal){
    const request=readReviewSchema.parse(input),deadline=Date.now()+request.waitMs;
    signal=signal?AbortSignal.any([signal,this.shutdown.signal]):this.shutdown.signal;
    ensure(!signal.aborted,'PROCESS_CANCELLED','审片等待已取消');
    this.repo.transaction(()=>{this.review(request.reviewId,runId);this.updateMetrics(request.reviewId,metrics=>{metrics.readQueryCount++;});});
    while(true){
      const wake=this.events.subscribe(request.reviewId,Math.max(0,deadline-Date.now()),signal);
      try{
        ensure(!signal?.aborted,'PROCESS_CANCELLED','审片等待已取消');
        const result=this.read(runId,request.reviewId);
        if(!request.afterDigest||result.statusDigest!==request.afterDigest||result.state!=='active'||result.runState!=='running'||!result.remaining)return result;
        if(Date.now()>=deadline){
          if(request.waitMs>0)this.repo.transaction(()=>this.updateMetrics(request.reviewId,metrics=>{metrics.readTimeoutCount++;}));
          return {...this.read(runId,request.reviewId),timedOut:request.waitMs>0};
        }
        await wake.promise;
      }finally{wake.dispose();}
    }
  }
}
