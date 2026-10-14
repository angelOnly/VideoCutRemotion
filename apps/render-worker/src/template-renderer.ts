import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, renderFrames, openBrowser, makeCancelSignal } from '@remotion/renderer';
import { promises as fs } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { validateTemplate } from '../../../packages/production-service/src/template-package.js';
import { regular, inside, treeDigest, writeJson } from '../../../packages/production-service/src/files.js';
import { sha256, ProductionError, deliverySchema, type Delivery, type Run, type RenderRequest } from '../../../packages/production-service/src/contracts.js';
import { validateVideoOutput, type VideoExtent } from '../../../packages/production-service/src/video-output.js';
import { cutSceneFromWhole } from './template-slices.js';

export const renderRequestIdSchema=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const renderToolSchema=z.object({runId:z.string().uuid(),renderRequestId:renderRequestIdSchema,timelineRef:z.string(),ranges:z.array(z.object({id:z.string(),fromFrame:z.number().int().nonnegative(),toFrame:z.number().int().positive()}).strict()).min(1),checks:z.array(z.string()),previewOnly:z.boolean().default(false)}).strict();
export const previewFramesSchema=z.object({runId:z.string().uuid(),renderRequestId:renderRequestIdSchema,frames:z.array(z.number().int().nonnegative()).min(1).max(12).refine(v=>new Set(v).size===v.length,'帧号不可重复')}).strict();
export type TemplateRenderInput=z.infer<typeof renderToolSchema>;
export type PreviewFramesInput=z.infer<typeof previewFramesSchema>;
export type VideoFile=Delivery['files'][number];
export type ReadyFrame={frame:number;path:string;sha256:string};
export type MediaJob={id:string;runId:string;kind:'template-render'|'frame-preview';state:'running'|'succeeded'|'failed'|'cancelled'|'unknown';inputDigest:string;input:TemplateRenderInput|PreviewFramesInput;sourceDigest?:string;readyFiles:VideoFile[];readyFrames:ReadyFrame[];currentOutput?:string;deliveryPath?:string;delivery?:Delivery;overviewPaths?:string[];warnings?:string[];missingFrames?:number[];error?:string};
export type RenderOptions={dependencyRoot:string;browser?:string;concurrency:number;signal?:AbortSignal;onFileReady?:(file:VideoFile)=>Promise<void>;onFrameReady?:(frame:ReadyFrame)=>Promise<void>;onOutputStart?:(id:string)=>Promise<void>;onSourceFrozen?:(digest:string)=>Promise<void>};
const engine={bundle,selectComposition,renderMedia,renderFrames,openBrowser};
function checkCancelled(signal?:AbortSignal){if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','渲染操作已取消');}
function assertRun(run:Run,options:RenderOptions){checkCancelled(options.signal);if(run.stage!=='render'||run.state!=='running')throw new ProductionError('RENDER_STAGE_FORBIDDEN','仅运行中的 Render 可生成媒体',409);if(!Number.isInteger(options.concurrency)||options.concurrency<1||options.concurrency>5)throw new ProductionError('RENDER_CONCURRENCY_INVALID','每视频绘图并发须为1到5');}

async function freezeProject(root:string,destination:string,signal?:AbortSignal){
  const working=join(root,'project');checkCancelled(signal);const digest=await treeDigest(working);
  if(await fs.stat(destination).catch(()=>null))throw new ProductionError('RENDER_SNAPSHOT_EXISTS','快照已存在，请查询原作业');
  await fs.mkdir(dirname(destination),{recursive:true});
  await fs.cp(working,destination,{recursive:true,filter:p=>!p.split(/[\\/]/).some(s=>['node_modules','.cache'].includes(s))});
  if(await treeDigest(working)!==digest||await treeDigest(destination)!==digest)throw new ProductionError('SOURCE_CHANGED','复制期间工程发生变化，请原作者结束写入后生成新批次');
  checkCancelled(signal);return digest;
}
async function prepare(project:string,options:RenderOptions,backend=engine){
  const manifest=await validateTemplate(project),renderer=join(project,'renderer');
  const buildRoot=await fs.mkdtemp(join(tmpdir(),'textvideo-bundle-'));
  try {
    const serveUrl=await backend.bundle({outDir:buildRoot,entryPoint:await regular(renderer,manifest.entry),publicDir:inside(renderer,manifest.publicAssetRoot),webpackOverride:c=>({...c,resolve:{...c.resolve,modules:[join(options.dependencyRoot,'node_modules'),'node_modules']}})});
    checkCancelled(options.signal);return {manifest,serveUrl,buildRoot};
  }catch(error){await fs.rm(buildRoot,{recursive:true,force:true});throw error;}
}
function checkComposition(composition:VideoExtent,manifest:{width:number;height:number;fps:number}){
  if(composition.width!==manifest.width||composition.height!==manifest.height||composition.fps!==manifest.fps)throw new ProductionError('COMPOSITION_SPEC_MISMATCH','Composition 与清单规格不一致');
}
function checkRanges(run:Run,input:TemplateRenderInput,total:number){
  const expected=(run.request as RenderRequest).dataList;
  if(new Set(input.ranges.map(r=>r.id)).size!==input.ranges.length||input.ranges.some(r=>r.toFrame<=r.fromFrame||r.toFrame>total))throw new ProductionError('RANGE_INVALID','分镜编号重复或帧范围越界');
  if(!input.previewOnly&&(input.ranges.length!==expected.length||input.ranges.some((r,i)=>r.id!==expected[i].id)))throw new ProductionError('RANGES_INVALID','正式分镜范围必须对应完整确认列表');
}
async function fileRecord(run:Run,id:string,path:string,extent:VideoExtent,dur:number):Promise<VideoFile>{
  const expected=(run.request as RenderRequest).dataList;
  return {...extent,id,file:path,dur,sha256:sha256(await fs.readFile(path)),content:id==='whole-video'?expected.map(s=>s.content).join(''):expected.find(s=>s.id===id)?.content??''};
}
async function completeDelivery(run:Run,project:string,output:string,input:TemplateRenderInput,sourceDigest:string,files:VideoFile[],signal?:AbortSignal){
  checkCancelled(signal);if(await treeDigest(project)!==sourceDigest)throw new ProductionError('SOURCE_CHANGED','渲染输入发生变化');
  const delivery:Delivery={taskId:run.taskId,runId:run.runId,inputDigest:run.inputDigest,templateDigest:run.checkpoint.template.digest,renderRequestId:input.renderRequestId,sourceDigest,timelineRef:input.timelineRef,checks:input.checks,files};
  const deliveryPath=join(output,'delivery.json');await writeJson(deliveryPath,delivery);return {deliveryPath,delivery};
}
async function renderMissingSlices(run:Run,root:string,input:TemplateRenderInput,digest:string,files:VideoFile[],options:RenderOptions){
  const output=join(root,'output-staging',input.renderRequestId),whole=files.find(f=>f.id==='whole-video')!;
  for(const [i,r] of input.ranges.entries()){
    if(files.some(f=>f.id===r.id))continue;
    checkCancelled(options.signal);await options.onOutputStart?.(r.id);
    const extent={...r,width:whole.width,height:whole.height,fps:whole.fps},path=join(output,`${i+1}.mp4`);
    const media=await cutSceneFromWhole(whole.file,path,extent,options.signal);
    const file=await fileRecord(run,r.id,path,extent,media.duration);checkCancelled(options.signal);
    await options.onFileReady?.(file);files.push(file);
  }
  return completeDelivery(run,join(root,'render-snapshots',input.renderRequestId,'project'),output,input,digest,[whole,...input.ranges.map(r=>files.find(f=>f.id===r.id)!)],options.signal);
}

export async function renderTemplate(run:Run,root:string,input:TemplateRenderInput,options:RenderOptions,backend=engine){
  assertRun(run,options);const project=input.previewOnly?join(root,'project'):join(root,'render-snapshots',input.renderRequestId,'project');
  const digest=input.previewOnly?await treeDigest(project):await freezeProject(root,project,options.signal);
  if(!input.previewOnly)await options.onSourceFrozen?.(digest);await regular(project,input.timelineRef);
  const {manifest,serveUrl,buildRoot}=await prepare(project,options,backend);
  const cancellation=makeCancelSignal(),abort=()=>cancellation.cancel();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  try{
    const composition=await backend.selectComposition({serveUrl,id:manifest.wholeComposition,browserExecutable:options.browser});
    checkComposition({...composition,fromFrame:0,toFrame:composition.durationInFrames},manifest);checkRanges(run,input,composition.durationInFrames);
    const output=join(root,input.previewOnly?'previews':'output-staging',input.renderRequestId);await fs.mkdir(output,{recursive:true});
    // 正式任务仅绘制整片；局部动态预览仍直接绘制所选范围。
    const ranges=input.previewOnly?input.ranges:[{id:'whole-video',fromFrame:0,toFrame:composition.durationInFrames}];const files:VideoFile[]=[];
    for(const [i,r] of ranges.entries()){
      checkCancelled(options.signal);await options.onOutputStart?.(r.id);const path=join(output,`${i}.mp4`);
      await backend.renderMedia({serveUrl,composition,outputLocation:path,codec:'h264',audioCodec:'aac',frameRange:[r.fromFrame,r.toFrame-1],browserExecutable:options.browser,concurrency:options.concurrency,cancelSignal:cancellation.cancelSignal,overwrite:true});
      const extent={...r,width:composition.width,height:composition.height,fps:composition.fps},media=await validateVideoOutput(path,extent,options.signal);
      const file=await fileRecord(run,r.id,path,extent,media.duration);checkCancelled(options.signal);await options.onFileReady?.(file);files.push(file);
    }
    if(!input.previewOnly)return await renderMissingSlices(run,root,input,digest,files,options);
    return await completeDelivery(run,project,output,input,digest,files,options.signal);
  }finally{options.signal?.removeEventListener('abort',abort);await fs.rm(buildRoot,{recursive:true,force:true});}
}

export async function retryRenderSlices(run:Run,root:string,job:MediaJob,options:RenderOptions){
  assertRun(run,options);
  if(job.kind!=='template-render'||!job.sourceDigest)throw new ProductionError('SLICE_RETRY_FORBIDDEN','原作业缺少固定工程依据');
  const input=renderToolSchema.parse(job.input);
  if(input.previewOnly||input.runId!==run.runId||input.renderRequestId!==job.id)throw new ProductionError('SLICE_RETRY_FORBIDDEN','仅原正式视频作业可续切');
  const project=join(root,'render-snapshots',job.id,'project');
  if(await treeDigest(project)!==job.sourceDigest)throw new ProductionError('SOURCE_CHANGED','原固定工程不一致，不能续切');
  const manifest=await validateTemplate(project);await regular(project,input.timelineRef);
  const files=z.array(deliverySchema.shape.files.element).min(1).parse(job.readyFiles),whole=files.find(f=>f.id==='whole-video');
  if(!whole||whole.fromFrame!==0)throw new ProductionError('SLICE_RETRY_FORBIDDEN','原整片没有核验成功');
  checkComposition(whole,manifest);checkRanges(run,input,whole.toFrame);
  const expected=[{id:'whole-video',fromFrame:0,toFrame:whole.toFrame},...input.ranges];
  if(new Set(files.map(f=>f.id)).size!==files.length)throw new ProductionError('FILE_IDENTITY_INVALID','已完成清单包含重复文件');
  for(const file of files){
    const index=expected.findIndex(r=>r.id===file.id),range=expected[index];
    if(!range||file.fromFrame!==range.fromFrame||file.toFrame!==range.toFrame||file.width!==whole.width||file.height!==whole.height||file.fps!==whole.fps||resolve(file.file)!==resolve(root,'output-staging',job.id,`${index}.mp4`))throw new ProductionError('FILE_IDENTITY_INVALID','已完成文件范围、规格或位置不符');
    const path=await regular(root,relative(root,file.file));
    const record=await fileRecord(run,file.id,path,file,file.dur);
    if(record.sha256!==file.sha256||record.content!==file.content)throw new ProductionError('FILE_DIGEST_MISMATCH','原已完成文件摘要或正文不符');
    const media=await validateVideoOutput(path,file,options.signal);
    if(Math.abs(media.duration-file.dur)>0.1)throw new ProductionError('MEDIA_CHECK_FAILED','原文件实测时长不符');
  }
  // 不读取工作目录，不重建快照，也不重新绘制整片。
  return renderMissingSlices(run,root,input,job.sourceDigest,[...files],options);
}

async function overview(frames:ReadyFrame[],output:string){
  const paths:string[]=[];
  for(let offset=0;offset<frames.length;offset+=6){
    const group=frames.slice(offset,offset+6),width=480,height=270;
    const sheet=new PNG({width:width*2,height:height*Math.ceil(group.length/2)});sheet.data.fill(255);
    for(const [i,item] of group.entries()){
      const src=PNG.sync.read(await fs.readFile(item.path));
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const a=(Math.floor(y*src.height/height)*src.width+Math.floor(x*src.width/width))*4;
        const b=((Math.floor(i/2)*height+y)*sheet.width+(i%2)*width+x)*4;src.data.copy(sheet.data,b,a,a+4);
      }
    }
    const path=join(output,`overview-${offset/6+1}.png`);await fs.writeFile(path,PNG.sync.write(sheet));paths.push(path);
  }
  return paths;
}
export async function templateFrames(run:Run,root:string,input:PreviewFramesInput,options:RenderOptions,backend=engine){
  assertRun(run,options);input=previewFramesSchema.parse(input);
  const project=join(root,'preview-snapshots',input.renderRequestId,'project'),sourceDigest=await freezeProject(root,project,options.signal);
  await options.onSourceFrozen?.(sourceDigest);const {manifest,serveUrl,buildRoot}=await prepare(project,options,backend);
  const output=join(root,'previews',input.renderRequestId);
  let browser:Awaited<ReturnType<typeof openBrowser>>|undefined;
  const cancellation=makeCancelSignal(),abort=()=>cancellation.cancel();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const ready=new Map<number,ReadyFrame>();const writes:Promise<void>[]=[];
  try{
    await fs.mkdir(output,{recursive:true});checkCancelled(options.signal);
    browser=await backend.openBrowser('chrome',{browserExecutable:options.browser});
    checkCancelled(options.signal);
    const composition=await backend.selectComposition({serveUrl,id:manifest.wholeComposition,puppeteerInstance:browser});
    checkComposition({...composition,fromFrame:0,toFrame:composition.durationInFrames},manifest);
    if(input.frames.some(f=>f>=composition.durationInFrames))throw new ProductionError('RANGE_INVALID','静帧超出Composition范围');
    await backend.renderFrames({serveUrl,composition,inputProps:{},frames:input.frames,concurrency:options.concurrency,puppeteerInstance:browser,imageFormat:'png',outputDir:null,muted:true,cancelSignal:cancellation.cancelSignal,onStart:()=>{},onFrameUpdate:()=>{},onFrameBuffer:(buffer,frame)=>{
      const work=(async()=>{
        checkCancelled(options.signal);const png=PNG.sync.read(buffer);
        if(!input.frames.includes(frame)||png.width!==composition.width||png.height!==composition.height)throw new ProductionError('PREVIEW_FRAME_INVALID','预览图片帧号或规格不符');
        const path=join(output,`frame-${frame}.png`);await fs.writeFile(`${path}.tmp`,buffer);await fs.rename(`${path}.tmp`,path);
        const item={frame,path,sha256:sha256(buffer)};checkCancelled(options.signal);await options.onFrameReady?.(item);ready.set(frame,item);
      })();writes.push(work);void work.catch(abort);return work;
    }});
    await Promise.all(writes);checkCancelled(options.signal);
    if(ready.size!==input.frames.length)throw new ProductionError('PREVIEW_INCOMPLETE','部分静帧未生成');
    if(await treeDigest(project)!==sourceDigest)throw new ProductionError('SOURCE_CHANGED','预览固定快照发生变化');
    const frames=input.frames.map(f=>ready.get(f)!);let overviewPaths:string[]=[],warnings:string[]=[];
    try{overviewPaths=await overview(frames,output);}catch(e){warnings=[`概览生成失败，原图仍可查看：${String(e)}`];}
    checkCancelled(options.signal);return {sourceDigest,readyFrames:frames,overviewPaths,warnings};
  }finally{
    abort();await Promise.allSettled(writes);
    try{await browser?.close({silent:true});}finally{options.signal?.removeEventListener('abort',abort);await fs.rm(buildRoot,{recursive:true,force:true});}
  }
}
