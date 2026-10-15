import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { deliverySchema, sha256, ProductionError, type Run, type RenderRequest } from './contracts.js';
import { validateRegisteredVideo } from './registered-video.js';
import { withMediaSpan, type MetricContext } from './media-metrics.js';
import { regular, json, writeJson, treeDigest } from './files.js';
export async function publishDelivery(run:Run,runRoot:string,taskRoot:string,mediaBase:string,raw:unknown,signal?:AbortSignal,metrics?:MetricContext){
  if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','交付已取消');
  const delivery=deliverySchema.parse(raw),request=run.request as RenderRequest;
  if(delivery.runId!==run.runId||delivery.taskId!==run.taskId||delivery.inputDigest!==run.inputDigest||delivery.templateDigest!==run.checkpoint.template.digest)throw new ProductionError('DELIVERY_IDENTITY_INVALID','交付身份或输入摘要不符');
  const expected=[{id:'whole-video',content:request.dataList.map(s=>s.content).join('')},...request.dataList];
  if(delivery.files.length!==expected.length||delivery.files.some((f,i)=>f.id!==expected[i].id||f.content!==expected[i].content))throw new ProductionError('DELIVERY_CONTENT_INVALID','整片和分镜数量、正文或顺序不符');
  const project=join(runRoot,'render-snapshots',delivery.renderRequestId,'project'),snapshot=join(runRoot,'source-snapshot');await regular(project,delivery.timelineRef);
  if(await treeDigest(project)!==delivery.sourceDigest)throw new ProductionError('SOURCE_CHANGED','渲染输入快照发生变化');
  metrics=metrics?{...metrics,sourceDigest:delivery.sourceDigest}:undefined;
  const whole=delivery.files[0];
  // 先核对全部文件身份，再用这份可信整片复核快速切片，不能只信自报元数据。
  for(const f of delivery.files){
    const p=await regular(runRoot,relative(runRoot,f.file));
    const digest=await withMediaSpan(metrics,'publication_source_sha',async()=>sha256(await fs.readFile(p)));
    if(digest!==f.sha256)throw new ProductionError('FILE_DIGEST_MISMATCH','视频摘要不符');
  }
  for(const f of delivery.files)await withMediaSpan(metrics,'publication_media_validation',child=>validateRegisteredVideo(f,whole,signal,child));
  // 发布以真实文件技术核验为准；未进行连续看听只记录检查边界。
  if(!(await fs.stat(snapshot).catch(()=>null)))await fs.cp(project,snapshot,{recursive:true,filter:p=>!p.split(/[\\/]/).includes('node_modules')});
  if(await treeDigest(snapshot)!==delivery.sourceDigest)throw new ProductionError('SNAPSHOT_INVALID','工程快照摘要不符');
  if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','交付已取消');
  const final=join(taskRoot,'results',run.runId),staging=join(taskRoot,'results',`${run.runId}.staging`);
  const dataList=delivery.files.map((f,i)=>({id:f.id,content:f.content,dur:f.dur,durationSource:'measured',url:`${mediaBase}/${run.taskKey}/${run.runId}/${i}.mp4`,extraData:{kind:i===0?'wholeVideo':'scene',sha256:f.sha256,fromFrame:f.fromFrame,toFrame:f.toFrame,width:f.width,height:f.height,fps:f.fps,...(f.cutMetadata?{cutMetadata:f.cutMetadata}:{})}}));
  const result={dataList,templateDigest:delivery.templateDigest,sourceDigest:delivery.sourceDigest,checks:delivery.checks};
  if(!(await fs.stat(final).catch(()=>null))){
    await fs.mkdir(staging,{recursive:true});
    for(const [i,f] of delivery.files.entries()){
      signal?.throwIfAborted();const target=join(staging,`${i}.mp4`);
      await withMediaSpan(metrics,'publication_copy',()=>fs.copyFile(f.file,target));
      // 复制后再次核对真实字节，防止检查与复制之间源文件被替换。
      const copied=await withMediaSpan(metrics,'publication_staging_sha',async()=>sha256(await fs.readFile(target)));
      if(copied!==f.sha256)throw new ProductionError('FILE_DIGEST_MISMATCH','发布副本与已核验源文件不一致');
    }
    signal?.throwIfAborted();await writeJson(join(staging,'publication.json'),{runId:run.runId,inputDigest:run.inputDigest,delivery,result});await fs.rename(staging,final);
  }
  else {const old=await json(join(final,'publication.json'));if(old.runId!==run.runId||old.inputDigest!==run.inputDigest)throw new ProductionError('PUBLICATION_CONFLICT','已发布目录身份不一致');for(const [i,f]of delivery.files.entries())if(sha256(await fs.readFile(join(final,`${i}.mp4`)))!==f.sha256)throw new ProductionError('PUBLICATION_CORRUPT','已发布文件损坏');}
  return result;
}
