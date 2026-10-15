import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, type Run } from './contracts.js';

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
  if(details)return {...job,detailsRef};
  const {input,delivery,continuousAudio,chunks,...summary}=job;
  return {...summary,detailsRef,readyFiles:job.readyFiles?.map(({content,...file}:any)=>file),
    completedChunks:chunks?.map(({id,fromFrame,toFrame,sha256}:any)=>({id,fromFrame,toFrame,sha256})),
    failedChunks:job.state==='failed'&&job.renderStrategy==='scene-chunks'?(job.resolvedRanges??input?.ranges)?.filter((range:any)=>!chunks?.some((chunk:any)=>chunk.id===range.id)).map((range:any)=>range.id):undefined};
}

export function productionTaskSummary(run:Run){
  const template=run.checkpoint.template;
  if(run.stage==='analysis')return {taskId:run.taskId,runId:run.runId,stage:run.stage,state:run.state,inputDigest:run.inputDigest,planVersion:run.planVersion,request:run.request,
    template:template?{templateVersion:template.manifest?.templateVersion??template.manifest?.version,archiveDigest:template.digest,analysisContractDigest:template.analysisContract?.digest,analysisContract:template.analysisContract,width:template.manifest?.width,height:template.manifest?.height,fps:template.manifest?.fps}:undefined};
  return {taskId:run.taskId,runId:run.runId,stage:run.stage,state:run.state,inputDigest:run.inputDigest,planVersion:run.planVersion,
    template:template?{digest:template.digest,sourceDigest:template.sourceDigest,version:template.manifest?.templateVersion,timelineDataRef:template.manifest?.timelineDataRef,timelineContract:template.manifest?.timelineContract}:undefined};
}
