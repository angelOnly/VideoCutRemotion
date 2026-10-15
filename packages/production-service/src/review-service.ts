import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { canonical, sha256, ProductionError, type Run, type RenderRequest } from './contracts.js';
import type { ProductionRepository } from './repository.js';
import { json, regular, treeDigest } from './files.js';
import { preflightTimeline } from './production-timeline.js';
import { MediaJobEvents } from './run-work.js';
import { compareReviewSnapshots, snapshotFiles, type ReviewSnapshot } from './review-invalidation.js';

const text=z.string().trim().min(1).max(4000),frame=z.number().int().nonnegative();
const requestId=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const reviewRangeSchema=z.object({fromFrame:frame,toFrame:frame}).strict().refine(v=>v.toFrame>v.fromFrame,'止帧必须大于起帧');
const evidenceSelector=z.union([
  z.object({renderRequestId:requestId,frame}).strict(),
  z.object({renderRequestId:requestId,fileId:text}).strict(),
]);
const checkPlan=z.object({checkId:text,purpose:text,mode:z.enum(['image','video','audio','audiovisual']),evidence:z.array(evidenceSelector).min(1),range:reviewRangeSchema.optional()}).strict();
export const prepareReviewSchema=z.object({renderRequestIds:z.array(requestId).min(1).max(100),phase:z.enum(['pre_export','post_export']),timelineRef:text.optional(),waitMs:z.number().int().min(0).max(60000).default(0),
  units:z.array(z.object({unitId:text,sceneIds:z.array(text).min(1),checks:z.array(checkPlan).min(1)}).strict()).min(1),
  reuse:z.array(z.object({sourceReviewId:z.string().uuid(),unitId:text,checkId:text,evidenceId:text,reason:text}).strict()).default([]),
}).strict();
// agentId 是主协调报告的宿主标识，仅用于追溯；写入鉴权仍使用当前 Run 凭证。
export const assignReviewSchema=z.object({reviewId:z.string().uuid(),unitId:text,reviewerAgentId:text,assignmentRequestId:requestId,previousAssignmentToken:z.string().uuid().nullable().default(null),reason:text.optional()}).strict();
export const readReviewSchema=z.object({details:z.boolean().default(false),reviewId:z.string().uuid(),afterDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),waitMs:z.number().int().min(0).max(60000).default(0)}).strict();
export const submitReviewSchema=z.object({reviewId:z.string().uuid(),assignmentToken:z.string().uuid(),observations:z.array(z.object({checkId:text,evidenceId:text,note:text,range:reviewRangeSchema.optional()}).strict()).max(1000),issues:z.array(z.object({checkId:text,evidenceId:text,severity:z.enum(['blocking','warning','suggestion']),problem:text,range:reviewRangeSchema.optional()}).strict()).max(1000),issueResolutions:z.array(z.object({issueId:text,evidenceId:text.optional(),checkId:text.optional(),resolution:z.enum(['resolved','retained']),note:text}).strict()).max(1000).optional(),status:z.enum(['partial','complete'])}).strict();
// 报告只承载审片者的决定；主协调传文件引用，不再重抄观察与分派编号。
export const reviewReportSchema=z.object({reviewId:submitReviewSchema.shape.reviewId,results:z.array(submitReviewSchema.omit({reviewId:true})).min(1).max(100)}).strict();
export const reviewReportJsonSchema=zodToJsonSchema(reviewReportSchema,{$refStrategy:'none'});
export const submitReviewReportsSchema=z.object({reportRefs:z.array(text.describe('相对当前 Run 根目录的独立审片 JSON 文件，建议 records/review-results/ 下；完整结构：'+JSON.stringify(reviewReportJsonSchema))).min(1).max(100)}).strict();
export type ReviewRange=z.infer<typeof reviewRangeSchema>;
type Observation=z.infer<typeof submitReviewSchema>['observations'][number];
type Issue=z.infer<typeof submitReviewSchema>['issues'][number];
// 材料来自原媒体作业，专业检查目的和观察方式由主协调提供。
export type ReviewEvidence={evidenceId:string;kind:'image'|'video';path:string;sha256:string;sceneId?:string;frame?:number;fromFrame?:number;toFrame?:number;fps:number;width:number;height:number;renderRequestId?:string;fileId?:string};
export type ReviewCheck={checkId:string;purpose:string;mode:'image'|'video'|'audio'|'audiovisual';ruleVersion?:number;evidenceIds:string[];range?:ReviewRange};
type PendingIssue=Issue&{issueId:string;sourceReviewId:string;sourceWorkId:string;currentEvidenceId?:string;resolution?:'resolved'|'retained';resolutionNote?:string};
type Reuse={reviewId:string;workId:string;checkId:string;evidenceId:string;basis:string};
export type ReviewWork={assignedAt?:number;lastProgressAt?:number;unitId:string;sceneIds:string[];fromFrame:number;toFrame:number;fps:number;checks:ReviewCheck[];evidence:ReviewEvidence[];observations:Observation[];issues:Issue[];pendingIssues?:PendingIssue[];context?:{confirmedScenes:{id:string;content:string}[];chapter:unknown};reused:Reuse[]};
type ReviewMetrics={preparedAt:number;firstClaimedAt:number|null;lastAcceptedSubmissionAt:number|null;readQueryCount:number;readTimeoutCount:number};
type ReviewData={metrics?:ReviewMetrics;changes?:ReturnType<typeof compareReviewSnapshots>;snapshot:ReviewSnapshot;evidence:ReviewEvidence[];renderRequestIds:string[];missing:string[];previousReviewId?:string;runtimeDiagnostic?:string|null};
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
  return remaining;
}

export class ReviewService{
  readonly events=new MediaJobEvents();
  private shutdown=new AbortController();
  close(){this.shutdown.abort();}
  constructor(readonly repo:ProductionRepository,readonly runRoot:(run:Run)=>string){}
  private notifyRun(runId:string){for(const row of this.repo.db.prepare('SELECT id FROM reviews WHERE run_id=?').all(runId) as any[])this.events.notify(row.id);}
  /** 观测字段留在原计划中；调用方已有事务时合并更新，计数不发送进展通知。 */
  private updateMetrics(reviewId:string,update:(metrics:ReviewMetrics)=>void){
    const row=this.repo.db.prepare('SELECT data,created_at FROM reviews WHERE id=?').get(reviewId) as any;
    ensure(row,'REVIEW_NOT_FOUND','审片计划不存在');const data=JSON.parse(row.data) as ReviewData;
    const metrics=data.metrics??{preparedAt:row.created_at,firstClaimedAt:null,lastAcceptedSubmissionAt:null,readQueryCount:0,readTimeoutCount:0};
    update(metrics);data.metrics=metrics;this.repo.db.prepare('UPDATE reviews SET data=? WHERE id=?').run(canonical(data),reviewId);
  }
  private review(id:string,runId:string){const row=this.repo.db.prepare('SELECT * FROM reviews WHERE id=? AND run_id=?').get(id,runId) as any;ensure(row,'REVIEW_NOT_FOUND','审片计划不属于当前任务');return row;}
  private current(runId:string){const run=this.repo.get(runId);ensure(run.stage==='render'&&run.state==='running','REVIEW_RUN_STOPPED','仅运行中的 Render 可登记审片');return run;}
  private assignment(runId:string,reviewId:string,token:string):Session{
    const session=this.repo.db.prepare('SELECT * FROM review_sessions WHERE id=? AND run_id=? AND review_id=?').get(token,runId,reviewId) as Session|undefined;
    ensure(session,'REVIEW_ASSIGNMENT_INVALID','分派不属于当前任务与计划');return session;
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
          ensure(job.runId===run.runId&&job.id===id&&['frame-preview','template-render'].includes(job.kind),'REVIEW_JOB_INVALID','必须使用当前 Run 已受理的原媒体作业');
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
      const project=join(root,job.kind==='frame-preview'||job.input.previewOnly?'preview-snapshots':'render-snapshots',job.id,'project');
      ensure(await treeDigest(project)===job.sourceDigest,'REVIEW_SOURCE_CHANGED','冻结工程摘要已改变');return {...job,project};
    }));
    const sourceDigest=jobs[0].sourceDigest;ensure(jobs.every(j=>j.sourceDigest===sourceDigest),'REVIEW_MIXED_SOURCE','检查材料必须属于同一冻结版本');
    let timelineRef=request.timelineRef??jobs.find(j=>j.input.timelineRef)?.input.timelineRef;
    if(!timelineRef){
      const audit=this.repo.get(run.runId).checkpoint.sentenceAudioAudits?.[sourceDigest];timelineRef=audit?.timelineRef;
    }
    const checked=await preflightTimeline(jobs[0].project,(run.request as RenderRequest).dataList,{timelineRef});
    const {timeline,manifest,ranges:scenes}=checked;timelineRef=checked.timelineRef;
    const evidence:ReviewEvidence[]=[];
    for(const job of jobs){
      for(const f of job.readyFrames??[]){
        const path=await regular(root,f.path);ensure(sha256(await fs.readFile(path))===f.sha256,'REVIEW_EVIDENCE_CHANGED','登记静帧摘要不符');
        ensure(Number.isInteger(f.frame)&&f.frame>=0&&f.frame<timeline.totalFrames,'REVIEW_EVIDENCE_RANGE','登记静帧超出时间线');
        evidence.push({renderRequestId:job.id,evidenceId:`ev-${sha256(canonical(['image',f.frame,f.sha256])).slice(0,24)}`,kind:'image',sceneId:scenes.find(s=>f.frame>=s.fromFrame&&f.frame<s.toFrame)!.id,path,sha256:f.sha256,frame:f.frame,fps:timeline.fps,width:manifest.width,height:manifest.height});
      }
    }
    for(const job of jobs)for(const file of job.readyFiles??[]){
      const path=await regular(root,file.file);ensure(sha256(await fs.readFile(path))===file.sha256,'REVIEW_EVIDENCE_CHANGED','登记视频摘要不符');
      ensure(Number.isInteger(file.fromFrame)&&Number.isInteger(file.toFrame)&&file.fromFrame>=0&&file.toFrame>file.fromFrame&&file.toFrame<=timeline.totalFrames&&file.fps===timeline.fps,'REVIEW_EVIDENCE_RANGE','登记视频范围或帧率无效');
      evidence.push({evidenceId:`ev-${sha256(canonical(['video',file.sha256,file.fromFrame,file.toFrame])).slice(0,24)}`,kind:'video',path,sha256:file.sha256,fromFrame:file.fromFrame,toFrame:file.toFrame,fps:file.fps,width:file.width,height:file.height,renderRequestId:job.id,fileId:file.id});
    }
    const actualEvidence=[...new Map(evidence.map(e=>[e.evidenceId,e])).values()],snapshot:ReviewSnapshot={sourceDigest,timeline,files:await snapshotFiles(jobs[0].project),timelineRef};
    ensure(new Set(request.units.map(u=>u.unitId)).size===request.units.length,'REVIEW_PLAN_INVALID','检查单元编号重复');
    const works:ReviewWork[]=request.units.map(unit=>{
      const selected=unit.sceneIds.map(id=>scenes.find(s=>s.id===id));
      ensure(selected.every(Boolean)&&new Set(unit.sceneIds).size===unit.sceneIds.length,'REVIEW_PLAN_INVALID','检查单元包含未知或重复分镜');
      const fromFrame=Math.min(...selected.map(s=>s!.fromFrame)),toFrame=Math.max(...selected.map(s=>s!.toFrame));
      ensure(new Set(unit.checks.map(c=>c.checkId)).size===unit.checks.length,'REVIEW_PLAN_INVALID','单元检查编号重复');
      const checks:ReviewCheck[]=unit.checks.map(check=>{
        const items=check.evidence.map(ref=>evidence.find(e=>e.renderRequestId===ref.renderRequestId&&('frame' in ref?e.kind==='image'&&e.frame===ref.frame:e.kind==='video'&&e.fileId===ref.fileId)));
        ensure(items.every(Boolean),'REVIEW_EVIDENCE_SCOPE','检查引用不属于本轮已登记媒体');
        if(check.mode==='image')ensure(!check.range&&items.every(e=>e!.kind==='image'&&unit.sceneIds.includes(e!.sceneId!)),'REVIEW_MODE_INVALID','静帧检查仅能引用本单元实际图片');
        else {
          ensure(check.range&&check.range.fromFrame>=fromFrame&&check.range.toFrame<=toFrame&&items.every(e=>e!.kind==='video'),'REVIEW_RANGE_INVALID','连续观察须指定本单元的实际范围和视频');
          ensure(!missingRanges(check.range,items.map(e=>({fromFrame:e!.fromFrame!,toFrame:e!.toFrame!}))).length,'REVIEW_RANGE_INVALID','媒体未覆盖声明的检查范围');
          ensure(!missingRanges(check.range,selected.map(s=>({fromFrame:s!.fromFrame,toFrame:s!.toFrame}))).length,'REVIEW_RANGE_INVALID','连续检查不能跨越未选定分镜');
        }
        return {checkId:check.checkId,purpose:check.purpose,mode:check.mode,evidenceIds:[...new Set(items.map(e=>e!.evidenceId))],...(check.range?{range:check.range}:{})};
      });
      const ids=new Set(checks.flatMap(c=>c.evidenceIds));
      return {unitId:unit.unitId,sceneIds:unit.sceneIds,fromFrame,toFrame,fps:timeline.fps,checks,evidence:actualEvidence.filter(e=>ids.has(e.evidenceId)),observations:[],issues:[],pendingIssues:[],context:{confirmedScenes:(run.request as RenderRequest).dataList.filter(s=>unit.sceneIds.includes(s.id)),chapter:null},reused:[]};
    });
    const data:ReviewData={metrics:{preparedAt:Date.now(),firstClaimedAt:null,lastAcceptedSubmissionAt:null,readQueryCount:0,readTimeoutCount:0},snapshot,evidence:actualEvidence,renderRequestIds:jobs.map(j=>j.id),missing:[]};
    const inputDigest=sha256(canonical({phase:request.phase,sourceDigest,timelineRef,units:request.units,reuse:request.reuse,evidence:actualEvidence.map(({path,...e})=>e),policy:4}));
    ensure(!options.signal?.aborted,'PROCESS_CANCELLED','审片材料核验期间已取消，不提交检查计划');
    const result=this.repo.transaction(()=>{
      const current=this.repo.get(run.runId);this.repo.guard(current,run.token!);ensure(current.state==='running','REVIEW_RUN_STOPPED','任务已停止');
      const existing=this.repo.db.prepare('SELECT id FROM reviews WHERE run_id=? AND input_digest=?').get(run.runId,inputDigest) as any;
      if(existing)return this.read(run.runId,existing.id);
      const previous=this.repo.db.prepare("SELECT * FROM reviews WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(run.runId) as any;
      if(previous?.state==='active'&&previous.input_digest===inputDigest)return this.read(run.runId,previous.id);
      if(previous){
        this.inheritIssues(previous,works,data);
      }
      this.applyReuse(run.runId,request.reuse,works);
      this.repo.db.prepare("UPDATE review_work SET state='obsolete' WHERE review_id IN (SELECT id FROM reviews WHERE run_id=? AND state='active') AND state!='completed'").run(run.runId);
      this.repo.db.prepare("UPDATE reviews SET state='superseded' WHERE run_id=? AND state='active'").run(run.runId);
      const reviewId=randomUUID();this.repo.db.prepare("INSERT INTO reviews(id,run_id,input_digest,source_digest,phase,state,data,created_at) VALUES(?,?,?,?,?,'active',?,?)").run(reviewId,run.runId,inputDigest,sourceDigest,request.phase,canonical(data),Date.now());
      works.forEach((work,index)=>this.repo.db.prepare('INSERT INTO review_work(id,review_id,ordinal,state,data) VALUES(?,?,?,?,?)').run(randomUUID(),reviewId,index,remainingChecks(work).length?'pending':'completed',canonical(work)));
      // 旧分派保持原计划身份，不能跨版续写。
      this.repo.db.prepare("UPDATE review_sessions SET state='revoked' WHERE run_id=? AND review_id!=?").run(run.runId,reviewId);
      return this.read(run.runId,reviewId);
    });this.notifyRun(run.runId);return result;
  }
  private inheritIssues(previous:any,works:ReviewWork[],data:ReviewData){
    const oldData=JSON.parse(previous.data) as ReviewData,changes=compareReviewSnapshots(oldData.snapshot,data.snapshot);data.changes=changes;data.previousReviewId=previous.id;
    // partial 中服务已接收的观察具有同等证据身份；未观察部分仍保留 remaining。
    const rows=this.repo.db.prepare('SELECT * FROM review_work WHERE review_id=?').all(previous.id) as any[];
    for(const work of works){
      const old=rows.find(r=>JSON.parse(r.data).unitId===work.unitId);if(!old)continue;
      const before=JSON.parse(old.data) as ReviewWork;
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
  /** 只按协调者明确选择复用，字节与检查目的仍由服务核验，绝不自动宣布新版通过。 */
  private applyReuse(runId:string,requests:z.infer<typeof prepareReviewSchema>['reuse'],works:ReviewWork[]){
    for(const request of requests){
      this.review(request.sourceReviewId,runId);
      const row=(this.repo.db.prepare('SELECT * FROM review_work WHERE review_id=?').all(request.sourceReviewId) as any[]).find(r=>JSON.parse(r.data).unitId===request.unitId);
      const before:ReviewWork|undefined=row?JSON.parse(row.data):undefined,work=works.find(w=>w.unitId===request.unitId);
      const old=before?.evidence.find(e=>e.evidenceId===request.evidenceId),current=work?.evidence.find(e=>e.evidenceId===request.evidenceId);
      const oldCheck=before?.checks.find(c=>c.checkId===request.checkId),check=work?.checks.find(c=>c.checkId===request.checkId);
      ensure(before&&work&&old&&current&&check&&oldCheck&&check.mode==='image'&&oldCheck.mode==='image'&&check.evidenceIds.includes(current.evidenceId)&&oldCheck.evidenceIds.includes(old.evidenceId)&&check.purpose===oldCheck.purpose,'REVIEW_REUSE_INVALID','复用必须引用原有同目的静帧观察');
      const identity=({kind,sha256,frame,fps,width,height,sceneId}:ReviewEvidence)=>({kind,sha256,frame,fps,width,height,sceneId});
      ensure(canonical(identity(old))===canonical(identity(current))&&before.observations.some(o=>o.checkId===check.checkId&&o.evidenceId===old.evidenceId),'REVIEW_REUSE_INVALID','图片身份改变或原始观察不存在');
      work.reused.push({reviewId:request.sourceReviewId,workId:row.id,checkId:check.checkId,evidenceId:current.evidenceId,basis:request.reason});
    }
  }
  assign(runId:string,input:unknown){
    const body=assignReviewSchema.parse(input),digest=sha256(canonical(body)),key=sha256(canonical([runId,body.assignmentRequestId]));
    const result=this.repo.transaction(()=>{
      this.current(runId);const review=this.review(body.reviewId,runId);
      const old=this.repo.db.prepare('SELECT * FROM review_sessions WHERE credential_digest=? AND run_id=?').get(key,runId) as any;
      if(old){ensure(JSON.parse(old.diagnostic).inputDigest===digest,'REVIEW_ASSIGNMENT_CONFLICT','同一分派请求不可改变输入');const row=this.repo.db.prepare('SELECT * FROM review_work WHERE assignment_token=?').get(old.id) as any;return {assignmentToken:old.id,reviewId:old.review_id,reviewerAgentId:old.thread_id,provenance:'coordinator_reported',active:review.state==='active'&&row?.state==='assigned',...(row?{...JSON.parse(row.data),remaining:remainingChecks(JSON.parse(row.data))}:{})};}
      ensure(review.state==='active','REVIEW_SUPERSEDED','计划已被替换');
      const row=(this.repo.db.prepare('SELECT * FROM review_work WHERE review_id=?').all(body.reviewId) as any[]).find(r=>JSON.parse(r.data).unitId===body.unitId);
      ensure(row&&(row.state!=='completed'||(JSON.parse(row.data) as ReviewWork).pendingIssues?.some(i=>!i.resolution)),'REVIEW_ASSIGNMENT_INVALID','单元不存在或已完成且没有待处置问题');
      ensure((row.assignment_token??null)===body.previousAssignmentToken,'REVIEW_ASSIGNMENT_STALE','当前负责人已经变化，请读回后再分派');
      if(row.assignment_token){ensure(body.reason,'REVIEW_TAKEOVER_REASON','接替须记录真实原因');this.repo.db.prepare("UPDATE review_sessions SET state='revoked' WHERE id=?").run(row.session_id);}
      const id=randomUUID();
      // 沿用旧表保存分派历史；credential_digest 只作请求幂等键，不再签发审片凭证。
      this.repo.db.prepare("INSERT INTO review_sessions(id,run_id,review_id,credential_digest,thread_id,state,diagnostic) VALUES(?,?,?,?,?,'active',?)").run(id,runId,body.reviewId,key,body.reviewerAgentId,canonical({inputDigest:digest,reason:body.reason,provenance:'coordinator_reported'}));
      const work=JSON.parse(row.data) as ReviewWork;work.assignedAt=Date.now();
      this.repo.db.prepare("UPDATE review_work SET state='assigned',session_id=?,assignment_token=?,generation=generation+1,data=? WHERE id=?").run(id,id,canonical(work),row.id);
      this.updateMetrics(body.reviewId,m=>{m.firstClaimedAt??=work.assignedAt!;});
      return {assignmentToken:id,reviewId:body.reviewId,reviewerAgentId:body.reviewerAgentId,provenance:'coordinator_reported',active:true,...work,remaining:remainingChecks(work)};
    });this.events.notify(body.reviewId);return result;
  }
  async verifySubmissionEvidence(runId:string,input:unknown){
    const body=submitReviewSchema.parse(input),session=this.assignment(runId,body.reviewId,body.assignmentToken);
    // 已接收的相同请求只恢复原响应，不因后来的媒体变化改写历史结果。
    if(this.repo.db.prepare('SELECT 1 FROM review_submissions WHERE session_id=? AND assignment_token=? AND body_digest=?').get(session.id,body.assignmentToken,sha256(canonical(body))))return;
    const row=this.repo.db.prepare("SELECT data FROM review_work WHERE assignment_token=? AND session_id=? AND state='assigned' AND review_id=?").get(body.assignmentToken,session.id,session.review_id) as any;
    if(!row)return;const work=JSON.parse(row.data) as ReviewWork,root=this.runRoot(this.repo.get(runId));
    // 大文件摘要在提交事务外核对；事务内还会重新确认当前版本和分派。
    for(const id of new Set([...body.observations,...body.issues].map(item=>item.evidenceId).concat((body.issueResolutions??[]).flatMap(item=>{const id=item.evidenceId??work.pendingIssues?.find(issue=>issue.issueId===item.issueId)?.currentEvidenceId;return id?[id]:[];})))){const e=work.evidence.find(e=>e.evidenceId===id);if(e)ensure(sha256(await fs.readFile(await regular(root,e.path)))===e.sha256,'REVIEW_EVIDENCE_CHANGED','观察期间媒体证据发生改变，请保留观察并重新准备本版材料');}
  }
  async submitReports(runId:string,input:unknown){
    const request=submitReviewReportsSchema.parse(input),root=this.runRoot(this.current(runId));
    const reports=await Promise.all(request.reportRefs.map(async reportRef=>({reportRef,report:reviewReportSchema.parse(await json(await regular(root,reportRef)))})));
    const reviewId=reports[0].report.reviewId;
    ensure(reports.every(item=>item.report.reviewId===reviewId),'REVIEW_REPORT_MIXED','一次提交的报告必须属于同一轮审片计划');
    const submissions=reports.flatMap(({reportRef,report})=>report.results.map(result=>({reportRef,body:{reviewId,...result}})));
    await Promise.all(submissions.map(({body})=>this.verifySubmissionEvidence(runId,body)));
    // 文件和证据在事务外读取；单批登记全部成功或回滚，重试仍沿原分派内容恢复。
    const results=this.repo.transaction(()=>submissions.map(({reportRef,body})=>({reportRef,assignmentToken:body.assignmentToken,...this.acceptSubmission(runId,body)})));
    this.notifyRun(runId);return {reviewId,results};
  }
  submit(runId:string,input:unknown){
    const body=submitReviewSchema.parse(input),result=this.repo.transaction(()=>this.acceptSubmission(runId,body));
    this.notifyRun(runId);return result;
  }
  private acceptSubmission(runId:string,body:z.infer<typeof submitReviewSchema>){
      const digest=sha256(canonical(body));
      this.current(runId);const session=this.assignment(runId,body.reviewId,body.assignmentToken);
      // 先恢复原接收结果，完成后的正常重试不应被误判为过期。
      const old=this.repo.db.prepare('SELECT response FROM review_submissions WHERE session_id=? AND assignment_token=? AND body_digest=?').get(session.id,body.assignmentToken,digest) as any;
      if(old)return JSON.parse(old.response);
      const row=this.repo.db.prepare('SELECT * FROM review_work WHERE assignment_token=? AND session_id=?').get(body.assignmentToken,session.id) as any;
      if(!row||row.state!=='assigned'||row.review_id!==session.review_id||session.state!=='active'||this.review(body.reviewId,runId).state!=='active'){
        const response={accepted:false,code:'REVIEW_ASSIGNMENT_STALE',reason:'分派已结束或版本已改变，仅保存迟到记录',nextStep:'主协调读取当前计划，核对真实负责人后调用 assign_review_work'};this.saveSubmission(session,body,digest,response,false);return response;
      }
      const work=JSON.parse(row.data) as ReviewWork;
      const validate=(item:Observation|Issue)=>{
        const check=work.checks.find(c=>c.checkId===item.checkId),e=work.evidence.find(e=>e.evidenceId===item.evidenceId);
        ensure(check&&e&&check.evidenceIds.includes(e.evidenceId),'REVIEW_EVIDENCE_SCOPE','观察或问题必须属于当前检查和证据');
        if(check.mode==='image')ensure(!item.range&&e.kind==='image','REVIEW_MODE_INVALID','静帧使用登记帧号，不能冒充连续看听');
        else ensure(item.range&&e.kind==='video'&&item.range.fromFrame>=Math.max(check.range!.fromFrame,e.fromFrame!)&&item.range.toFrame<=Math.min(check.range!.toFrame,e.toFrame!),'REVIEW_RANGE_INVALID','连续媒体必须提交实际观察的全局半开区间');
      };
      const before=canonical([work.observations,work.issues,work.pendingIssues]);
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
        const evidenceId=resolution.evidenceId??issue.currentEvidenceId,checkId=resolution.checkId??issue.checkId;
        ensure(evidenceId&&work.observations.some(o=>o.checkId===checkId&&o.evidenceId===evidenceId),'REVIEW_ISSUE_UNOBSERVED','问题处置须先查看当前对应图片；旧帧已删除时指定新证据编号');
        issue.currentEvidenceId=evidenceId;
        issue.resolution=resolution.resolution;issue.resolutionNote=resolution.note;
        if(resolution.resolution==='retained')work.issues=unique([...work.issues,{checkId,evidenceId:issue.currentEvidenceId,severity:issue.severity,problem:issue.problem}]);
      }
      // 只有有效观察或问题变化更新单元进展；空提交、轮询与接替不伪装观察完成。
      if(before!==canonical([work.observations,work.issues,work.pendingIssues]))work.lastProgressAt=Date.now();
      const remaining=remainingChecks(work),completed=body.status==='complete'&&!remaining.length;
      this.repo.db.prepare('UPDATE review_work SET data=?,state=? WHERE id=?').run(canonical(work),completed?'completed':'assigned',row.id);
      const response={accepted:true,status:completed?'complete':'partial',remaining,next:null};
      this.updateMetrics(session.review_id,metrics=>{metrics.lastAcceptedSubmissionAt=Date.now();});
      this.saveSubmission(session,body,digest,response,true);return response;
  }
  private saveSubmission(session:Session,body:z.infer<typeof submitReviewSchema>,digest:string,response:unknown,accepted:boolean){this.repo.db.prepare('INSERT INTO review_submissions(session_id,assignment_token,body_digest,body,response,accepted,created_at) VALUES(?,?,?,?,?,?,?)').run(session.id,body.assignmentToken,digest,canonical(body),canonical(response),Number(accepted),Date.now());}
  read(runId:string,reviewId:string){
    const review=this.review(reviewId,runId),rows=this.repo.db.prepare('SELECT state,data,assignment_token,session_id,generation FROM review_work WHERE review_id=? ORDER BY ordinal').all(reviewId) as any[],data=JSON.parse(review.data) as ReviewData;
    const work=rows.map(r=>({...JSON.parse(r.data) as ReviewWork,state:r.state,assignmentToken:r.assignment_token,generation:r.generation,reviewerAgentId:r.session_id?(this.repo.db.prepare('SELECT thread_id FROM review_sessions WHERE id=?').get(r.session_id) as any)?.thread_id:null})),issues=work.flatMap(w=>w.issues.map(i=>({unitId:w.unitId,...i})));
    const summary={reviewId,runState:this.repo.get(runId).state,phase:review.phase,sourceDigest:review.source_digest,state:review.state,total:rows.length,remaining:rows.filter(r=>r.state!=='completed').length,missing:data.missing,units:work,previousReviewId:data.previousReviewId,changes:data.changes??{changedFiles:[],changedScenes:[],changedTimelineFields:[]},requiredObservationCount:work.reduce((n,w)=>n+w.checks.reduce((n,c)=>n+c.evidenceIds.length,0),0),issues,pendingIssues:work.flatMap(w=>(w.pendingIssues??[]).filter(i=>!i.resolution).map(i=>({unitId:w.unitId,...i}))),observationCount:new Set(work.flatMap(w=>w.observations.map(o=>canonical([w.unitId,o.checkId,o.evidenceId])))).size,reusedCount:work.reduce((n,w)=>n+w.reused.length,0),...(data.runtimeDiagnostic?{runtimeDiagnostic:data.runtimeDiagnostic}:{}),provenance:'coordinator_reported',unobserved:work.filter(w=>w.state!=='completed').map(w=>({unitId:w.unitId,remaining:remainingChecks(w)}))};
    const metrics=data.metrics??{preparedAt:review.created_at,firstClaimedAt:null,lastAcceptedSubmissionAt:null,readQueryCount:0,readTimeoutCount:0};
    const {readQueryCount,readTimeoutCount,lastAcceptedSubmissionAt,...progress}=metrics;
    // 查询与空提交计时只用于诊断；实际进展由单元内容、状态和 lastProgressAt 表达。
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
