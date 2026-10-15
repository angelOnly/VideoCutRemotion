import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, type Run } from './contracts.js';
import { remainingChecks, type ReviewService } from './review-service.js';

/** 查询计数不属于业务进展；完整结果按内容寻址保存，摘要不重复搬运观察正文。 */
export async function reviewResultSummary(root:string,result:ReturnType<ReviewService['read']>,details=false,afterDigest?:string){
  const text=JSON.stringify(result,null,2),directory=join(root,'tool-results');
  await fs.mkdir(directory,{recursive:true});
  const detailsRef=join(directory,`review-${sha256(text)}.json`),temporary=join(directory,`${randomUUID()}.tmp`);
  try{await fs.writeFile(temporary,text);await fs.rename(temporary,detailsRef);}finally{await fs.rm(temporary,{force:true});}
  const changed=afterDigest===undefined||afterDigest!==result.statusDigest;
  if(details)return {...result,changed,detailsRef};
  const {units,changes,unobserved,...summary}=result;
  const remainingObservationCount=units.reduce((count,unit)=>count+remainingChecks(unit).reduce((n,check)=>n+(check.evidenceIds?.length??unit.checks.find(c=>c.checkId===check.checkId)!.evidenceIds.length),0),0);
  return {...summary,changed,detailsRef,remainingObservationCount,completedObservationCount:result.requiredObservationCount-remainingObservationCount,
    units:units.map(unit=>({unitId:unit.unitId,state:unit.state,reviewerAgentId:unit.reviewerAgentId,assignmentToken:unit.assignmentToken,generation:unit.generation,assignedAt:unit.assignedAt??null,lastProgressAt:unit.lastProgressAt??null,
      remainingCheckCount:remainingChecks(unit).length,pendingIssueCount:unit.pendingIssues?.filter(i=>!i.resolution).length??0})),
    changeCounts:{files:changes.changedFiles.length,scenes:changes.changedScenes.length,timelineFields:changes.changedTimelineFields.length}};
}

/** 原响应留在本 Run；模型默认只收状态和可追溯引用，诊断不截断。 */
export async function speechBatchSummary(root:string,result:any,details=false){
  const text=JSON.stringify(result,null,2),directory=join(root,'tool-results');
  await fs.mkdir(directory,{recursive:true});
  const detailsRef=join(directory,`speech-${sha256(text)}.json`);
  // 同批次可能被并行读取；独立临时文件再替换，避免返回正在写入的半份 JSON。
  const temporary=join(directory,`${randomUUID()}.tmp`);
  try{await fs.writeFile(temporary,text);await fs.rename(temporary,detailsRef);}finally{await fs.rm(temporary,{force:true});}
  if(details)return {...result,detailsRef};
  return {id:result.id,runId:result.runId,state:result.state,total:result.total,counts:result.counts,unknownReservations:result.unknownReservations,detailsRef,
    issues:result.jobs.filter((job:any)=>['failed','unknown','validation_failed','cancelled'].includes(job.state)).map((job:any)=>({id:job.id,segmentId:job.request.segmentId,state:job.state,diagnostic:job.diagnostic,error:job.error}))};
}

export function mediaJobSummary(job:any,detailsRef:string,details=false){
  const freezeState=job.sourceDigest?'frozen':['running','queued'].includes(job.state)?'waiting':'not_frozen';
  if(details)return {...job,freezeState,detailsRef};
  const {input,delivery,continuousAudio,chunks,...summary}=job;
  return {...summary,detailsRef,freezeState,readyFrameCount:job.readyFrames?.length??0,requestedFrameCount:input?.frames?.length,readyFrames:input&&'reviewPlan' in input?undefined:job.readyFrames,readyFiles:job.readyFiles?.map(({content,...file}:any)=>file),
    completedChunks:chunks?.map(({id,fromFrame,toFrame,sha256}:any)=>({id,fromFrame,toFrame,sha256})),
    failedChunks:job.state==='failed'&&job.renderStrategy==='scene-chunks'?(job.resolvedRanges??input?.ranges)?.filter((range:any)=>!chunks?.some((chunk:any)=>chunk.id===range.id)).map((range:any)=>range.id):undefined};
}

export function productionTaskSummary(run:Run){
  const template=run.checkpoint.template;
  if(run.stage==='analysis')return {taskId:run.taskId,runId:run.runId,stage:run.stage,state:run.state,inputDigest:run.inputDigest,planVersion:run.planVersion,request:run.request,
    template:template?{templateVersion:template.manifest?.templateVersion??template.manifest?.version,archiveDigest:template.digest,analysisContractDigest:template.analysisContract?.digest,analysisContract:template.analysisContract,speakerBindings:template.manifest?.speakerBindings??{},width:template.manifest?.width,height:template.manifest?.height,fps:template.manifest?.fps}:undefined};
  return {taskId:run.taskId,runId:run.runId,stage:run.stage,state:run.state,inputDigest:run.inputDigest,planVersion:run.planVersion,
    template:template?{digest:template.digest,sourceDigest:template.sourceDigest,version:template.manifest?.templateVersion,timelineDataRef:template.manifest?.timelineDataRef,timelineContract:template.manifest?.timelineContract}:undefined};
}
