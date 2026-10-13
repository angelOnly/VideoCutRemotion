import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, renderStill, makeCancelSignal } from '@remotion/renderer';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { validateTemplate } from '../../../packages/production-service/src/template-package.js';
import { regular, inside, probe, treeDigest, writeJson } from '../../../packages/production-service/src/files.js';
import { sha256, ProductionError, type Run, type RenderRequest } from '../../../packages/production-service/src/contracts.js';
export const renderToolSchema=z.object({runId:z.string().uuid(),renderRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),timelineRef:z.string(),ranges:z.array(z.object({id:z.string(),fromFrame:z.number().int().nonnegative(),toFrame:z.number().int().positive()}).strict()).min(1),checks:z.array(z.string()),previewOnly:z.boolean().default(false)}).strict();
export type TemplateRenderInput=z.infer<typeof renderToolSchema>;
function checkCancelled(signal?:AbortSignal){if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','渲染操作已取消');}
export async function renderTemplate(run:Run,root:string,input:TemplateRenderInput,options:{dependencyRoot:string;browser?:string;concurrency:number;signal?:AbortSignal;onFileReady?:(file:any)=>Promise<void>;onOutputStart?:(id:string)=>Promise<void>}){
  checkCancelled(options.signal);
  if(run.stage!=='render'||run.state!=='running')throw new ProductionError('RENDER_STAGE_FORBIDDEN','仅运行中的 Render 可渲染',409);
  // 每次正式渲染冻结自己的输入；后续审片记录不能改变已渲染视频的源码身份。
  const workingProject=join(root,'project');
  const project=input.previewOnly?workingProject:join(root,'render-snapshots',input.renderRequestId,'project');
  if(!input.previewOnly){
    await treeDigest(workingProject);
    if(await fs.stat(project).catch(()=>null))throw new ProductionError('RENDER_SNAPSHOT_EXISTS','渲染快照已存在，请查询原任务');
    await fs.mkdir(dirname(project),{recursive:true});
    await fs.cp(workingProject,project,{recursive:true,filter:p=>!p.split(/[\\/]/).some(s=>['node_modules','.cache'].includes(s))});
  }
  const manifest=await validateTemplate(project),renderer=join(project,'renderer');
  await regular(project,input.timelineRef);const entry=await regular(renderer,manifest.entry);
  const expected=(run.request as RenderRequest).dataList;if(!input.previewOnly&&(input.ranges.length!==expected.length||input.ranges.some((r,i)=>r.id!==expected[i].id)))throw new ProductionError('RANGES_INVALID','分镜范围必须对应完整确认列表');
  const serveUrl=await bundle({entryPoint:entry,publicDir:inside(renderer,manifest.publicAssetRoot),webpackOverride:config=>({...config,resolve:{...config.resolve,modules:[join(options.dependencyRoot,'node_modules'),'node_modules']}})});
  checkCancelled(options.signal);
  const composition=await selectComposition({serveUrl,id:manifest.wholeComposition,browserExecutable:options.browser});
  checkCancelled(options.signal);
  if(composition.width!==manifest.width||composition.height!==manifest.height||composition.fps!==manifest.fps)throw new ProductionError('COMPOSITION_SPEC_MISMATCH','Composition 与清单规格不一致');
  for(const range of input.ranges)if(range.toFrame<=range.fromFrame||range.toFrame>composition.durationInFrames)throw new ProductionError('RANGE_INVALID',`分镜 ${range.id} 帧范围越界`);
  const output=join(root,input.previewOnly?'previews':'output-staging',input.renderRequestId);await fs.mkdir(output,{recursive:true});
  const cancellation=makeCancelSignal(),abort=()=>cancellation.cancel();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  try{
    const ranges=input.previewOnly?input.ranges:[{id:'whole-video',fromFrame:0,toFrame:composition.durationInFrames},...input.ranges];const files=[];
    for(const [i,r] of ranges.entries()){
      checkCancelled(options.signal);await options.onOutputStart?.(r.id);
      const path=join(output,`${i}.mp4`);await renderMedia({serveUrl,composition,outputLocation:path,codec:'h264',audioCodec:'aac',frameRange:[r.fromFrame,r.toFrame-1],browserExecutable:options.browser,concurrency:options.concurrency,cancelSignal:cancellation.cancelSignal,overwrite:true});
      const media=await probe(path,true,options.signal);if(!media.streams.some((s:any)=>s.codec_type==='audio'))throw new ProductionError('AUDIO_MISSING','模板成片缺少音轨');
      const content=r.id==='whole-video'?expected.map(s=>s.content).join(''):expected.find(s=>s.id===r.id)?.content??'';
      files.push({...r,file:path,content,sha256:sha256(await fs.readFile(path)),dur:media.duration,width:composition.width,height:composition.height,fps:composition.fps});
      // 只在完整性检查和摘要均完成后允许作者读取该文件。
      checkCancelled(options.signal);await options.onFileReady?.(files[files.length-1]);
    }
    const sourceDigest=await treeDigest(project),delivery={taskId:run.taskId,runId:run.runId,inputDigest:run.inputDigest,templateDigest:run.checkpoint.template.digest,renderRequestId:input.renderRequestId,sourceDigest,timelineRef:input.timelineRef,checks:input.checks,files};
    const deliveryPath=join(output,'delivery.json');await writeJson(deliveryPath,delivery);return {deliveryPath,delivery};
  }finally{options.signal?.removeEventListener('abort',abort);}
}
export async function templateFrame(project:string,frame:number,output:string,dependencyRoot:string,browser?:string,signal?:AbortSignal){
  checkCancelled(signal);
  const manifest=await validateTemplate(project),renderer=join(project,'renderer');
  const serveUrl=await bundle({entryPoint:inside(renderer,manifest.entry),publicDir:inside(renderer,manifest.publicAssetRoot),webpackOverride:c=>({...c,resolve:{...c.resolve,modules:[join(dependencyRoot,'node_modules'),'node_modules']}})});
  checkCancelled(signal);
  const composition=await selectComposition({serveUrl,id:manifest.wholeComposition,browserExecutable:browser});
  checkCancelled(signal);await fs.mkdir(dirname(output),{recursive:true});
  const cancellation=makeCancelSignal(),abort=()=>cancellation.cancel();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{await renderStill({serveUrl,composition,frame,output,browserExecutable:browser,cancelSignal:cancellation.cancelSignal});checkCancelled(signal);return output;}
  finally{signal?.removeEventListener('abort',abort);}
}
