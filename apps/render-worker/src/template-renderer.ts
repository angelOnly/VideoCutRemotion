import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, renderFrames, openBrowser, makeCancelSignal } from '@remotion/renderer';
import { promises as fs } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { validateTemplate } from '../../../packages/production-service/src/template-package.js';
import { regular, inside, treeDigest, writeJson } from '../../../packages/production-service/src/files.js';
import { sha256, canonical, ProductionError, deliverySchema, type Delivery, type Run, type RenderRequest } from '../../../packages/production-service/src/contracts.js';
import { validateVideoOutput, type VideoExtent } from '../../../packages/production-service/src/video-output.js';
import { cutSceneFromWhole } from './template-slices.js';
import { withMediaSpan, type MetricContext } from '../../../packages/production-service/src/media-metrics.js';
import { validateRegisteredVideo } from '../../../packages/production-service/src/registered-video.js';
import { mapMediaLimited, drawingWork, processWork, renderSceneChunks, type RenderChunk, type RenderAudio } from './template-chunks.js';
import { verifyCutTimeline, type AudioAuditEvidence } from '../../../packages/production-service/src/scene-cut-timeline.js';

export const renderRequestIdSchema=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const dynamicPreviewRequestSchema=z.object({sourceDigest:z.string().min(1),question:z.string().min(1),fromFrame:z.number().int().nonnegative(),toFrame:z.number().int().positive(),consumer:z.string().min(1),passCriteria:z.string().min(1),needsVideo:z.boolean(),needsAudio:z.boolean(),continuousVideoAvailable:z.boolean(),continuousAudioAvailable:z.boolean()}).strict();
export const renderToolSchema=z.object({runId:z.string().uuid(),renderRequestId:renderRequestIdSchema,timelineRef:z.string(),ranges:z.array(z.object({id:z.string(),fromFrame:z.number().int().nonnegative(),toFrame:z.number().int().positive()}).strict()).min(1),checks:z.array(z.string()),previewRequests:z.array(dynamicPreviewRequestSchema).optional(),previewOnly:z.boolean().default(false)}).strict();
export const previewFramesSchema=z.object({runId:z.string().uuid(),renderRequestId:renderRequestIdSchema,frames:z.array(z.number().int().nonnegative()).min(1).max(12).refine(v=>new Set(v).size===v.length,'帧号不可重复')}).strict();
export type TemplateRenderInput=z.infer<typeof renderToolSchema>;
export type PreviewFramesInput=z.infer<typeof previewFramesSchema>;
export type VideoFile=Delivery['files'][number];
export type ReadyFrame={frame:number;path:string;sha256:string};
export type MediaJob={attempt?:number;id:string;runId:string;kind:'template-render'|'frame-preview';state:'running'|'succeeded'|'failed'|'cancelled'|'unknown';inputDigest:string;input:TemplateRenderInput|PreviewFramesInput;sourceDigest?:string;releaseId?:string;rendererVersion?:'scene-chunks/1';renderStrategy?:'scene-chunks'|'whole-slices';concurrency?:number;runConcurrency?:number;chunks?:RenderChunk[];continuousAudio?:RenderAudio;sceneCutMode?:'accurate'|'hybrid';readyFiles:VideoFile[];readyFrames:ReadyFrame[];currentOutput?:string;deliveryPath?:string;delivery?:Delivery;overviewPaths?:string[];warnings?:string[];missingFrames?:number[];error?:string};
export type RenderOptions={releaseId?:string;bundleCacheRoot?:string;renderStrategy?:'scene-chunks'|'whole-slices';runConcurrency?:number;budget?:{withDrawing<T>(runId:string,slots:number,signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T>;withProcess<T>(runId:string,signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T>};onChunkReady?:(chunk:RenderChunk)=>Promise<void>;onAudioReady?:(audio:RenderAudio)=>Promise<void>;dependencyRoot:string;browser?:string;concurrency:number;sceneCutMode?:'accurate'|'hybrid';audioAudits?:AudioAuditEvidence;metrics?:MetricContext;signal?:AbortSignal;onFileReady?:(file:VideoFile)=>Promise<void>;onFrameReady?:(frame:ReadyFrame)=>Promise<void>;onOutputStart?:(id:string)=>Promise<void>;onSourceFrozen?:(digest:string)=>Promise<void>};
const engine={bundle,selectComposition,renderMedia,renderFrames,openBrowser};
function checkCancelled(signal?:AbortSignal){if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','渲染操作已取消');}
function assertRun(run:Run,options:RenderOptions){checkCancelled(options.signal);if(run.stage!=='render'||run.state!=='running')throw new ProductionError('RENDER_STAGE_FORBIDDEN','仅运行中的 Render 可生成媒体',409);if(!Number.isInteger(options.concurrency)||options.concurrency<1||options.concurrency>32)throw new ProductionError('RENDER_CONCURRENCY_INVALID','每片段绘图并发须为1到32');if(options.runConcurrency!==undefined&&(!Number.isInteger(options.runConcurrency)||options.runConcurrency<1||options.runConcurrency>32))throw new ProductionError('RENDER_CONCURRENCY_INVALID','片段并发须为1到32');}

async function freezeProject(root:string,destination:string,signal?:AbortSignal){
  const working=join(root,'project');checkCancelled(signal);const digest=await treeDigest(working);
  if(await fs.stat(destination).catch(()=>null))throw new ProductionError('RENDER_SNAPSHOT_EXISTS','快照已存在，请查询原作业');
  await fs.mkdir(dirname(destination),{recursive:true});
  await fs.cp(working,destination,{recursive:true,filter:p=>!p.split(/[\\/]/).some(s=>['node_modules','.cache'].includes(s))});
  if(await treeDigest(working)!==digest||await treeDigest(destination)!==digest)throw new ProductionError('SOURCE_CHANGED','复制期间工程发生变化，请原作者结束写入后生成新批次');
  checkCancelled(signal);return digest;
}
async function prepare(project:string,options:RenderOptions,backend=engine){
  const manifest=await withMediaSpan(options.metrics,'template_validation',()=>validateTemplate(project)),renderer=join(project,'renderer');
  const entryPoint=await regular(renderer,manifest.entry);
  let cache:string|undefined;
  // 缓存只覆盖当前 Run 的不可变快照；所有源码和 JSON 均参与摘要。
  if(options.releaseId&&options.bundleCacheRoot){
    const dependencyFiles=['package-lock.json','node_modules/@remotion/bundler/package.json','node_modules/@remotion/renderer/package.json','node_modules/remotion/package.json'];
    const dependencies=await Promise.all(dependencyFiles.map(async p=>[p,sha256(await fs.readFile(join(options.dependencyRoot,p)).catch(()=>Buffer.from('missing')))]));
    const key=sha256(canonical({source:await treeDigest(project),releaseId:options.releaseId,dependencies,dependencyRoot:options.dependencyRoot,entry:manifest.entry,publicRoot:manifest.publicAssetRoot,version:1}));
    cache=join(options.bundleCacheRoot,key);
    try{
      const receipt=JSON.parse(await fs.readFile(`${cache}.json`,'utf8'));
      if(receipt.key===key&&receipt.digest===await treeDigest(cache))return {manifest,serveUrl:cache,buildRoot:cache,keepBuild:true};
    }catch(error:any){if(error.code==='PATH_OUTSIDE_ROOT'||error.code==='LINK_FORBIDDEN')throw error;}
    await fs.rm(cache,{recursive:true,force:true});await fs.rm(`${cache}.json`,{force:true});
  }
  const buildRoot=await fs.mkdtemp(join(tmpdir(),'textvideo-bundle-'));
  try {
    const serveUrl=await withMediaSpan(options.metrics,'bundle',()=>backend.bundle({outDir:buildRoot,entryPoint,publicDir:inside(renderer,manifest.publicAssetRoot),webpackOverride:c=>({...c,resolve:{...c.resolve,modules:[join(options.dependencyRoot,'node_modules'),'node_modules']}})}));
    checkCancelled(options.signal);
    if(cache){
      await fs.mkdir(dirname(cache),{recursive:true});await fs.cp(buildRoot,cache,{recursive:true});
      await writeJson(`${cache}.json`,{key:cache.split(/[\\/]/).at(-1),digest:await treeDigest(cache)});await fs.rm(buildRoot,{recursive:true,force:true});
      return {manifest,serveUrl:cache,buildRoot:cache,keepBuild:true};
    }
    return {manifest,serveUrl,buildRoot,keepBuild:false};
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
    const media=await processWork(run.runId,options,()=>withMediaSpan(options.metrics,'scene_slice',child=>cutSceneFromWhole(whole.file,path,extent,options.signal,options.sceneCutMode??'accurate',child),{fromFrame:r.fromFrame,toFrame:r.toFrame}));
    const file={...await withMediaSpan(options.metrics,'file_record_sha',()=>fileRecord(run,r.id,path,extent,media.duration)),cutMetadata:media.cutMetadata};checkCancelled(options.signal);
    await options.onFileReady?.(file);files.push(file);
  }
  return completeDelivery(run,join(root,'render-snapshots',input.renderRequestId,'project'),output,input,digest,[whole,...input.ranges.map(r=>files.find(f=>f.id===r.id)!)],options.signal);
}

export async function renderTemplate(run:Run,root:string,input:TemplateRenderInput,options:RenderOptions,backend=engine){
  assertRun(run,options);const project=join(root,input.previewOnly?'preview-snapshots':'render-snapshots',input.renderRequestId,'project');
  const digest=await withMediaSpan(options.metrics,'freeze_project',async child=>{const digest=await freezeProject(root,project,options.signal);if(child)child.sourceDigest=digest;return digest;});
  options={...options,bundleCacheRoot:join(root,'.bundle-cache'),metrics:options.metrics?{...options.metrics,sourceDigest:digest}:undefined};
  // 冻结前的策略判断不能替代本快照核验，防止作者在排队窗口修改源码。
  if(input.previewOnly&&input.previewRequests?.some(request=>request.sourceDigest!==digest))throw new ProductionError('PREVIEW_SCOPE_CHANGED','预览冻结版本与检查疑点不同，请按实际变更重新规划',409);
  await options.onSourceFrozen?.(digest);await regular(project,input.timelineRef);
  const {manifest,serveUrl,buildRoot,keepBuild}=await withMediaSpan(options.metrics,'prepare',child=>prepare(project,{...options,metrics:child},backend));
  const cancellation=makeCancelSignal(),abort=()=>cancellation.cancel();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  try{
    const composition=await withMediaSpan(options.metrics,'select_composition',()=>backend.selectComposition({serveUrl,id:manifest.wholeComposition,browserExecutable:options.browser}));
    checkComposition({...composition,fromFrame:0,toFrame:composition.durationInFrames},manifest);checkRanges(run,input,composition.durationInFrames);
    if(!input.previewOnly&&(options.sceneCutMode==='hybrid'||options.renderStrategy==='scene-chunks'))await verifyCutTimeline(root,project,input.timelineRef,digest,input.renderRequestId,(run.request as RenderRequest).dataList,composition.durationInFrames,composition.fps,input.ranges,options.audioAudits);
    const output=join(root,input.previewOnly?'previews':'output-staging',input.renderRequestId);await fs.mkdir(output,{recursive:true});
    if(!input.previewOnly&&options.renderStrategy==='scene-chunks'){
      const files=await renderSceneChunks({run,root,input,sourceDigest:digest,composition,serveUrl,options,render:backend.renderMedia,cancelSignal:cancellation.cancelSignal,record:(id,path,extent,dur)=>fileRecord(run,id,path,extent,dur)});
      return await completeDelivery(run,project,output,input,digest,files,options.signal);
    }
    // 旧作业保持整片切分；动态预览在统一资源预算内有限并行。
    const ranges=input.previewOnly?input.ranges:[{id:'whole-video',fromFrame:0,toFrame:composition.durationInFrames}];const files:VideoFile[]=[];
    await mapMediaLimited(ranges,input.previewOnly?(options.runConcurrency??2):1,async(r,i)=>{
      checkCancelled(options.signal);await options.onOutputStart?.(r.id);const path=join(output,`${i}.mp4`);
      await drawingWork(run.runId,options,()=>processWork(run.runId,options,()=>withMediaSpan(options.metrics,'render_media',()=>backend.renderMedia({serveUrl,composition,outputLocation:path,codec:'h264',audioCodec:'aac',frameRange:[r.fromFrame,r.toFrame-1],browserExecutable:options.browser,concurrency:options.concurrency,cancelSignal:cancellation.cancelSignal,overwrite:true}),{fromFrame:r.fromFrame,toFrame:r.toFrame,concurrency:options.concurrency})));
      const extent={...r,width:composition.width,height:composition.height,fps:composition.fps},media=await processWork(run.runId,options,()=>withMediaSpan(options.metrics,'video_validation',child=>validateVideoOutput(path,extent,options.signal,child)));
      const file=await withMediaSpan(options.metrics,'file_record_sha',()=>fileRecord(run,r.id,path,extent,media.duration));checkCancelled(options.signal);await options.onFileReady?.(file);files[i]=file;
    });
    if(!input.previewOnly)return await renderMissingSlices(run,root,input,digest,files,options);
    return await completeDelivery(run,project,output,input,digest,files,options.signal);
  }finally{options.signal?.removeEventListener('abort',abort);if(!keepBuild)await fs.rm(buildRoot,{recursive:true,force:true});}
}

export async function retryRenderSlices(run:Run,root:string,job:MediaJob,options:RenderOptions,backend=engine){
  assertRun(run,options);
  // 原作业保存切法；部署后切换灰度开关也不改变失败续做的合同。
  options={...options,bundleCacheRoot:join(root,'.bundle-cache'),renderStrategy:z.enum(['scene-chunks','whole-slices']).default('whole-slices').parse(job.renderStrategy),concurrency:job.concurrency??options.concurrency,runConcurrency:job.runConcurrency??1,sceneCutMode:z.enum(['accurate','hybrid']).default('accurate').parse(job.sceneCutMode),metrics:options.metrics?{...options.metrics,sourceDigest:job.sourceDigest}:undefined};
  assertRun(run,options);
  if(job.state!=='failed'||job.kind!=='template-render'||!job.sourceDigest)throw new ProductionError('SLICE_RETRY_FORBIDDEN','仅明确失败且具备固定工程依据的作业可以续切');
  if(job.rendererVersion&&job.rendererVersion!=='scene-chunks/1')throw new ProductionError('RENDER_VERSION_UNSUPPORTED','原作业渲染版本不受支持');
  if(job.releaseId&&options.releaseId&&job.releaseId!==options.releaseId)throw new ProductionError('RENDER_RELEASE_MISMATCH','原作业必须使用创建时的发行版本恢复');
  const input=renderToolSchema.parse(job.input);
  if(input.runId!==run.runId||input.renderRequestId!==job.id)throw new ProductionError('SLICE_RETRY_FORBIDDEN','仅原正式视频作业可续切');
  const project=join(root,input.previewOnly?'preview-snapshots':'render-snapshots',job.id,'project');
  if(await treeDigest(project)!==job.sourceDigest)throw new ProductionError('SOURCE_CHANGED','原固定工程不一致，不能续切');
  const manifest=await validateTemplate(project);await regular(project,input.timelineRef);
  if(job.renderStrategy==='scene-chunks'||input.previewOnly)return resumeSegmented(run,root,job,input,project,options,backend);
  const files=z.array(deliverySchema.shape.files.element).min(1).parse(job.readyFiles),whole=files.find(f=>f.id==='whole-video');
  if(!whole||whole.fromFrame!==0)throw new ProductionError('SLICE_RETRY_FORBIDDEN','原整片没有核验成功');
  checkComposition(whole,manifest);checkRanges(run,input,whole.toFrame);
  if(options.sceneCutMode==='hybrid')await verifyCutTimeline(root,project,input.timelineRef,job.sourceDigest,input.renderRequestId,(run.request as RenderRequest).dataList,whole.toFrame,whole.fps,input.ranges,options.audioAudits);
  const expected=[{id:'whole-video',fromFrame:0,toFrame:whole.toFrame},...input.ranges];
  if(new Set(files.map(f=>f.id)).size!==files.length)throw new ProductionError('FILE_IDENTITY_INVALID','已完成清单包含重复文件');
  for(const file of files){
    const index=expected.findIndex(r=>r.id===file.id),range=expected[index];
    if(!range||file.fromFrame!==range.fromFrame||file.toFrame!==range.toFrame||file.width!==whole.width||file.height!==whole.height||file.fps!==whole.fps||resolve(file.file)!==resolve(root,'output-staging',job.id,`${index}.mp4`))throw new ProductionError('FILE_IDENTITY_INVALID','已完成文件范围、规格或位置不符');
    const path=await regular(root,relative(root,file.file));
    const record=await withMediaSpan(options.metrics,'retry_file_sha',()=>fileRecord(run,file.id,path,file,file.dur));
    if(record.sha256!==file.sha256||record.content!==file.content)throw new ProductionError('FILE_DIGEST_MISMATCH','原已完成文件摘要或正文不符');
    const media=await processWork(run.runId,options,()=>withMediaSpan(options.metrics,'retry_video_validation',child=>validateRegisteredVideo(file,whole,options.signal,child)));
    if(Math.abs(media.duration-file.dur)>0.1)throw new ProductionError('MEDIA_CHECK_FAILED','原文件实测时长不符');
  }
  // 不读取工作目录，不重建快照，也不重新绘制整片。
  return renderMissingSlices(run,root,input,job.sourceDigest,[...files],options);
}

/** 新策略失败续做不依赖整片；先复核不可变输入，再复用已登记的块。 */
async function resumeSegmented(run:Run,root:string,job:MediaJob,input:TemplateRenderInput,project:string,options:RenderOptions,backend=engine){
  const digest=job.sourceDigest!,{manifest,serveUrl,buildRoot,keepBuild}=await prepare(project,options,backend);
  const cancellation=makeCancelSignal(),abort=()=>cancellation.cancel();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  try{
    const composition=await backend.selectComposition({serveUrl,id:manifest.wholeComposition,browserExecutable:options.browser});
    checkComposition({...composition,fromFrame:0,toFrame:composition.durationInFrames},manifest);checkRanges(run,input,composition.durationInFrames);
    const output=join(root,input.previewOnly?'previews':'output-staging',input.renderRequestId);
    let files:VideoFile[];
    if(!input.previewOnly){
      await verifyCutTimeline(root,project,input.timelineRef,digest,input.renderRequestId,(run.request as RenderRequest).dataList,composition.durationInFrames,composition.fps,input.ranges,options.audioAudits);
      files=await renderSceneChunks({run,root,input,sourceDigest:digest,composition,serveUrl,options,render:backend.renderMedia,cancelSignal:cancellation.cancelSignal,record:(id,path,extent,dur)=>fileRecord(run,id,path,extent,dur),previous:job});
    }else{
      const ready=new Map<string,VideoFile>();
      for(const file of job.readyFiles){
        const index=input.ranges.findIndex(r=>r.id===file.id),range=input.ranges[index];
        if(!range||ready.has(file.id)||file.fromFrame!==range.fromFrame||file.toFrame!==range.toFrame||file.width!==composition.width||file.height!==composition.height||file.fps!==composition.fps||resolve(file.file)!==resolve(output,`${index}.mp4`))throw new ProductionError('FILE_IDENTITY_INVALID','原预览文件范围、规格或位置不符');
        await regular(root,relative(root,file.file));
        const record=await fileRecord(run,file.id,file.file,file,file.dur);
        if(record.sha256!==file.sha256||record.content!==file.content)throw new ProductionError('FILE_DIGEST_MISMATCH','原预览文件摘要或正文不符');
        await processWork(run.runId,options,()=>validateVideoOutput(file.file,file,options.signal,options.metrics));ready.set(file.id,file);
      }
      files=await mapMediaLimited(input.ranges,options.runConcurrency??2,async(range,index)=>{
        if(ready.has(range.id))return ready.get(range.id)!;
        checkCancelled(options.signal);await options.onOutputStart?.(range.id);
        const path=join(output,`${index}.mp4`),extent={...range,width:composition.width,height:composition.height,fps:composition.fps};
        await drawingWork(run.runId,options,()=>processWork(run.runId,options,()=>backend.renderMedia({serveUrl,composition,outputLocation:path,codec:'h264',audioCodec:'aac',frameRange:[range.fromFrame,range.toFrame-1],browserExecutable:options.browser,concurrency:options.concurrency,cancelSignal:cancellation.cancelSignal,overwrite:true})));
        const media=await processWork(run.runId,options,()=>validateVideoOutput(path,extent,options.signal,options.metrics)),file=await fileRecord(run,range.id,path,extent,media.duration);
        checkCancelled(options.signal);await options.onFileReady?.(file);return file;
      });
    }
    return await completeDelivery(run,project,output,input,digest,files,options.signal);
  }finally{options.signal?.removeEventListener('abort',abort);if(!keepBuild)await fs.rm(buildRoot,{recursive:true,force:true});}
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
  const project=join(root,'preview-snapshots',input.renderRequestId,'project'),sourceDigest=await withMediaSpan(options.metrics,'freeze_project',async child=>{const digest=await freezeProject(root,project,options.signal);if(child)child.sourceDigest=digest;return digest;});
  options={...options,bundleCacheRoot:join(root,'.bundle-cache'),metrics:options.metrics?{...options.metrics,sourceDigest}:undefined};
  await options.onSourceFrozen?.(sourceDigest);const {manifest,serveUrl,buildRoot,keepBuild}=await withMediaSpan(options.metrics,'prepare',child=>prepare(project,{...options,metrics:child},backend));
  const output=join(root,'previews',input.renderRequestId);
  let browser:Awaited<ReturnType<typeof openBrowser>>|undefined;
  const cancellation=makeCancelSignal(),abort=()=>cancellation.cancel();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const ready=new Map<number,ReadyFrame>();const writes:Promise<void>[]=[];
  try{
    await fs.mkdir(output,{recursive:true});checkCancelled(options.signal);
    browser=await withMediaSpan(options.metrics,'open_browser',()=>backend.openBrowser('chrome',{browserExecutable:options.browser}));
    checkCancelled(options.signal);
    const composition=await withMediaSpan(options.metrics,'select_composition',()=>backend.selectComposition({serveUrl,id:manifest.wholeComposition,puppeteerInstance:browser}));
    checkComposition({...composition,fromFrame:0,toFrame:composition.durationInFrames},manifest);
    if(input.frames.some(f=>f>=composition.durationInFrames))throw new ProductionError('RANGE_INVALID','静帧超出Composition范围');
    await drawingWork(run.runId,options,()=>withMediaSpan(options.metrics,'render_frames',()=>backend.renderFrames({serveUrl,composition,inputProps:{},frames:input.frames,concurrency:options.concurrency,puppeteerInstance:browser,imageFormat:'png',outputDir:null,muted:true,cancelSignal:cancellation.cancelSignal,onStart:()=>{},onFrameUpdate:()=>{},onFrameBuffer:(buffer,frame)=>{
      const work=(async()=>{
        checkCancelled(options.signal);const png=PNG.sync.read(buffer);
        if(!input.frames.includes(frame)||png.width!==composition.width||png.height!==composition.height)throw new ProductionError('PREVIEW_FRAME_INVALID','预览图片帧号或规格不符');
        const path=join(output,`frame-${frame}.png`);await fs.writeFile(`${path}.tmp`,buffer);await fs.rename(`${path}.tmp`,path);
        const item={frame,path,sha256:sha256(buffer)};checkCancelled(options.signal);await options.onFrameReady?.(item);ready.set(frame,item);
      })();writes.push(work);void work.catch(abort);return work;
    }}),{frameCount:input.frames.length,concurrency:options.concurrency}));
    await Promise.all(writes);checkCancelled(options.signal);
    if(ready.size!==input.frames.length)throw new ProductionError('PREVIEW_INCOMPLETE','部分静帧未生成');
    if(await treeDigest(project)!==sourceDigest)throw new ProductionError('SOURCE_CHANGED','预览固定快照发生变化');
    const frames=input.frames.map(f=>ready.get(f)!);let overviewPaths:string[]=[],warnings:string[]=[];
    try{overviewPaths=await overview(frames,output);}catch(e){warnings=[`概览生成失败，原图仍可查看：${String(e)}`];}
    checkCancelled(options.signal);return {sourceDigest,readyFrames:frames,overviewPaths,warnings};
  }finally{
    abort();await Promise.allSettled(writes);
    try{await browser?.close({silent:true});}finally{options.signal?.removeEventListener('abort',abort);if(!keepBuild)await fs.rm(buildRoot,{recursive:true,force:true});}
  }
}
