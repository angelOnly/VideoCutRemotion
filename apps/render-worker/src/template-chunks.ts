import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { renderMedia } from '@remotion/renderer';
import type { VideoConfig } from 'remotion';
import { canonical, ProductionError, sha256, type Run } from '../../../packages/production-service/src/contracts.js';
import { probe, processFile, regular } from '../../../packages/production-service/src/files.js';
import { validateVideoOutput, type VideoExtent } from '../../../packages/production-service/src/video-output.js';
import { withMediaSpan } from '../../../packages/production-service/src/media-metrics.js';
import type { MediaJob, RenderOptions, TemplateRenderInput, VideoFile } from './template-renderer.js';

export type RenderChunk = VideoExtent & {id:string;path:string;sha256:string;sourceDigest:string;parametersDigest:string};
export type RenderAudio = {path:string;sha256:string;sourceDigest:string;parametersDigest:string;sampleRate:number;samples:number;sourceSamples?:number;normalizationSamples?:number};
const sampleRate=48000;
/** 边界统一从全局帧换算，不能把各段四舍五入后的时长累加。 */
export const frameSample=(frame:number,fps:number)=>Math.round(frame*sampleRate/fps);

/** Remotion 的 adelay 按毫秒取整，末尾 apad 按采样取整；混音取最长轨，误差不随句段累加。 */
export function checkContinuousPcmSource(audio:{codec_name?:unknown;sample_rate?:unknown;time_base?:unknown;duration_ts?:unknown}|undefined,expectedSamples:number){
  const sourceSamples=Number(audio?.duration_ts),toleranceSamples=Math.ceil(sampleRate/2000)+1;
  const validFormat=audio?.codec_name==='pcm_s16le'&&Number(audio.sample_rate)===sampleRate&&audio.time_base===`1/${sampleRate}`;
  const normalizationSamples=expectedSamples-sourceSamples;
  // 仅吸收半毫秒延迟量化与一次采样舍入；大缺口仍失败，不能用整帧容差或任意静音补齐。
  if(!validFormat||!Number.isSafeInteger(sourceSamples)||sourceSamples<=0||Math.abs(normalizationSamples)>toleranceSamples)throw new ProductionError('PCM_SOURCE_LENGTH_MISMATCH',`原连续音轨格式或采样范围不符：${JSON.stringify({expectedSamples,sourceSamples:Number.isFinite(sourceSamples)?sourceSamples:null,normalizationSamples:Number.isFinite(normalizationSamples)?normalizationSamples:null,toleranceSamples,sampleRate,validFormat})}`);
  return {sourceSamples,normalizationSamples,toleranceSamples};
}


/** 出错后停止派发，等待已启动任务收口，避免上层提前释放预算或发布结果。 */
export async function mapMediaLimited<T,R>(items:T[],limit:number,work:(item:T,index:number)=>Promise<R>):Promise<R[]>{
  if(!Number.isInteger(limit)||limit<1)throw new ProductionError('MEDIA_CONCURRENCY_INVALID','媒体并发须为正整数');
  const result=new Array<R>(items.length);let cursor=0,failure:unknown;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(!failure){const index=cursor++;if(index>=items.length)return;try{result[index]=await work(items[index],index);}catch(error){failure??=error;}}
  }));
  if(failure)throw failure;return result;
}
async function budgetWork<T>(kind:'drawing'|'process',runId:string,options:RenderOptions,work:()=>Promise<T>){
  if(!options.budget)return work();
  return withMediaSpan(options.metrics,`${kind}_queue_and_work`,async child=>{
    let leaveQueue!:()=>void;const queued=new Promise<void>(resolve=>{leaveQueue=resolve;});
    const measuredQueue=withMediaSpan(child,`${kind}_queue`,()=>queued);
    const execute=()=>{leaveQueue();return withMediaSpan(child,`${kind}_work`,work);};
    try{return await (kind==='drawing'?options.budget!.withDrawing(runId,options.concurrency,options.signal,execute):options.budget!.withProcess(runId,options.signal,execute));}
    finally{leaveQueue();await measuredQueue;}
  });
}
export function drawingWork<T>(runId:string,options:RenderOptions,work:()=>Promise<T>){return budgetWork('drawing',runId,options,work);}
export function processWork<T>(runId:string,options:RenderOptions,work:()=>Promise<T>){return budgetWork('process',runId,options,work);}

function cancelled(options:RenderOptions){if(options.signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','媒体作业已取消');}
const ffmpeg=(args:string[],options:RenderOptions)=>processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-xerror','-y','-threads','1',...args],{signal:options.signal,timeoutMs:3600000});

export async function validateVisualChunk(path:string,extent:VideoExtent,options:Pick<RenderOptions,'signal'|'metrics'>){
  const media=await probe(path,false,options.signal),video=media.streams.find((s:any)=>s.codec_type==='video');
  const rate=(s:string)=>{const [n,d=1]=s.split('/').map(Number);return n/d;};
  if(!video||media.streams.some((s:any)=>s.codec_type==='audio')||video.codec_name!=='h264'||video.width!==extent.width||video.height!==extent.height||Math.abs(rate(video.avg_frame_rate)-extent.fps)>0.0001||Math.abs(Number(video.duration)-(extent.toFrame-extent.fromFrame)/extent.fps)>0.002||Math.abs(Number(video.start_time))>0.001)throw new ProductionError('CHUNK_MEDIA_INVALID','画面块编码、规格、时长或时间戳不符');
  const decoded=await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-xerror','-threads','1','-i',path,'-map','0:v:0','-threads:v','1','-fps_mode:v','passthrough','-progress','pipe:1','-nostats','-f','null','-'],{signal:options.signal,timeoutMs:3600000});
  if(!decoded.includes('progress=end')||Number([...decoded.matchAll(/^frame=(\d+)\s*$/gm)].at(-1)?.[1])!==extent.toFrame-extent.fromFrame)throw new ProductionError('CHUNK_FRAME_COUNT_MISMATCH','画面块完整解码帧数不符');
}
async function validatePcm(path:string,samples:number,options:RenderOptions){
  const media=await probe(path,false,options.signal),audio=media.streams.find((s:any)=>s.codec_type==='audio');
  if(!audio||audio.codec_name!=='pcm_s16le'||Number(audio.sample_rate)!==sampleRate||Number(audio.duration_ts)!==samples||audio.time_base!==`1/${sampleRate}`)throw new ProductionError('PCM_SAMPLE_MISMATCH','连续 PCM 音轨采样数或格式不符');
  await ffmpeg(['-i',path,'-map','0:a:0','-f','null','-'],options);
}

export async function renderSceneChunks(args:{run:Run;root:string;input:TemplateRenderInput;sourceDigest:string;composition:VideoConfig;serveUrl:string;options:RenderOptions;render:typeof renderMedia;cancelSignal:NonNullable<Parameters<typeof renderMedia>[0]['cancelSignal']>;record:(id:string,path:string,extent:VideoExtent,dur:number)=>Promise<VideoFile>;previous?:MediaJob}){
  const {run,root,input,sourceDigest,composition,serveUrl,options,render,cancelSignal,record,previous}=args;
  const output=join(root,'output-staging',input.renderRequestId),chunkRoot=join(output,'chunks');await fs.mkdir(chunkRoot,{recursive:true});
  const dependencies=await Promise.all(['@remotion/renderer','remotion'].map(async name=>{const p=JSON.parse(await fs.readFile(join(options.dependencyRoot,'node_modules',name,'package.json'),'utf8'));return [name,p.version];}));
  const parametersDigest=sha256(canonical({version:1,releaseId:options.releaseId??null,dependencies,codec:'h264',crf:18,preset:'medium',pixelFormat:'yuv420p',bFrames:0,timebase:90000,width:composition.width,height:composition.height,fps:composition.fps,sampleRate}));
  const full={fromFrame:0,toFrame:composition.durationInFrames,width:composition.width,height:composition.height,fps:composition.fps};
  const extents=input.ranges.map(r=>({...r,width:full.width,height:full.height,fps:full.fps}));
  const oldChunks=previous?.chunks??[],chunks=new Map<string,RenderChunk>();
  if(new Set(oldChunks.map(c=>c.id)).size!==oldChunks.length)throw new ProductionError('CHUNK_IDENTITY_INVALID','原画面块包含重复编号');
  for(const chunk of oldChunks){
    const index=extents.findIndex(e=>e.id===chunk.id),extent=extents[index];
    if(!extent||chunk.parametersDigest!==parametersDigest||chunk.sourceDigest!==sourceDigest||resolve(chunk.path)!==resolve(chunkRoot,`${index}.mp4`)||Object.entries(extent).some(([k,v])=>chunk[k as keyof RenderChunk]!==v))throw new ProductionError('CHUNK_IDENTITY_INVALID','原画面块来源、范围、参数或位置不符');
    await regular(root,relative(root,chunk.path));if(sha256(await fs.readFile(chunk.path))!==chunk.sha256)throw new ProductionError('CHUNK_DIGEST_MISMATCH','原画面块摘要不符');
    await processWork(run.runId,options,()=>validateVisualChunk(chunk.path,extent,options));chunks.set(chunk.id,chunk);
  }
  let audio=previous?.continuousAudio;
  const pcm=join(chunkRoot,'continuous.wav'),samples=frameSample(full.toFrame,full.fps);
  if(audio){
    if(audio.path!==pcm||audio.sourceDigest!==sourceDigest||audio.parametersDigest!==parametersDigest||audio.samples!==samples||audio.sampleRate!==sampleRate)throw new ProductionError('PCM_IDENTITY_INVALID','原连续音轨身份不符');
    await regular(root,relative(root,pcm));if(sha256(await fs.readFile(pcm))!==audio.sha256)throw new ProductionError('PCM_DIGEST_MISMATCH','原连续音轨摘要不符');
    await processWork(run.runId,options,()=>validatePcm(pcm,samples,options));
  }
  // PCM 也沿完整 Composition 收集音频；图像块始终使用全局 frameRange。
  // 先记录失败再清理临时文件，避免清理期间继续派发下一段。
  let failure:{error:unknown}|undefined;
  const visualTasks:Array<()=>Promise<void>>=extents.map((extent,index)=>async()=>{
    if(chunks.has(extent.id))return;cancelled(options);await options.onOutputStart?.(extent.id);
    const path=join(chunkRoot,`${index}.mp4`),pending=join(chunkRoot,`${index}.pending.mp4`);
    try{
      await drawingWork(run.runId,options,()=>processWork(run.runId,options,()=>withMediaSpan(options.metrics,'scene_visual_render',()=>render({serveUrl,composition,outputLocation:pending,codec:'h264',muted:true,crf:18,x264Preset:'medium',pixelFormat:'yuv420p',frameRange:[extent.fromFrame,extent.toFrame-1],browserExecutable:options.browser,concurrency:options.concurrency,cancelSignal,overwrite:true,ffmpegOverride:({args})=>[...args.slice(0,-1),'-bf','0','-video_track_timescale','90000',args.at(-1)!]}),{fromFrame:extent.fromFrame,toFrame:extent.toFrame,concurrency:options.concurrency})));
      await processWork(run.runId,options,()=>validateVisualChunk(pending,extent,options));cancelled(options);await fs.rename(pending,path);
      const chunk={...extent,path,sha256:sha256(await fs.readFile(path)),sourceDigest,parametersDigest};await options.onChunkReady?.(chunk);chunks.set(extent.id,chunk);
    }catch(error){failure??={error};}finally{await fs.rm(pending,{force:true});}
  });
  const audioTask=audio?undefined:async()=>{
    const raw=join(chunkRoot,'continuous.raw.wav'),pending=join(chunkRoot,'continuous.pending.wav');
    try{
      await drawingWork(run.runId,options,()=>processWork(run.runId,options,()=>withMediaSpan(options.metrics,'continuous_audio_render',()=>render({serveUrl,composition,outputLocation:raw,codec:'wav',sampleRate,enforceAudioTrack:true,frameRange:[0,full.toFrame-1],browserExecutable:options.browser,concurrency:options.concurrency,cancelSignal,overwrite:true}))));
      const rawMedia=await processWork(run.runId,options,()=>probe(raw,false,options.signal)),rawAudio=rawMedia.streams.find((stream:any)=>stream.codec_type==='audio');
      const sourceRange=checkContinuousPcmSource(rawAudio,samples);
      await processWork(run.runId,options,()=>withMediaSpan(options.metrics,'continuous_audio_normalize',()=>ffmpeg(['-i',raw,'-af',`apad,atrim=end_sample=${samples},asetpts=PTS-STARTPTS`,'-ar',String(sampleRate),'-c:a','pcm_s16le',pending],options),{sourceSamples:sourceRange.sourceSamples,expectedSamples:samples,normalizationSamples:sourceRange.normalizationSamples,toleranceSamples:sourceRange.toleranceSamples}));
      await processWork(run.runId,options,()=>validatePcm(pending,samples,options));cancelled(options);await fs.rename(pending,pcm);
      audio={path:pcm,sha256:sha256(await fs.readFile(pcm)),sourceDigest,parametersDigest,sampleRate,samples,sourceSamples:sourceRange.sourceSamples,normalizationSamples:sourceRange.normalizationSamples};await options.onAudioReady?.(audio);
    }catch(error){failure??={error};}finally{await fs.rm(raw,{force:true});await fs.rm(pending,{force:true});}
  };
  // 连续音轨不占画面派发位，仍与画面共用绘图及进程预算。
  // 任一分支失败后不派发新画面，已开始的声音和画面都收口后才返回。
  const finishTask=async(task:()=>Promise<unknown>)=>{
    if(failure)return;
    try{await task();}catch(error){failure??={error};}
  };
  await Promise.all([
    finishTask(async()=>{if(audioTask)await audioTask();}),
    finishTask(()=>mapMediaLimited(visualTasks,options.runConcurrency??4,task=>finishTask(task)))
  ]);
  if(failure)throw failure.error;
  cancelled(options);
  // concat 仅复制视频码流；整片音频只编码一次，绝不拼接独立 AAC 段。
  const list=join(chunkRoot,'concat.txt');await fs.writeFile(list,extents.map((_,i)=>`file '${i}.mp4'`).join('\n')+'\n');
  const expected=[{id:'whole-video',...full},...extents],files=new Map<string,VideoFile>();
  for(const file of previous?.readyFiles??[]){
    const index=expected.findIndex(e=>e.id===file.id),extent=expected[index];
    if(!extent||files.has(file.id)||resolve(file.file)!==resolve(output,`${index}.mp4`)||Object.entries(extent).some(([k,v])=>file[k as keyof VideoFile]!==v))throw new ProductionError('FILE_IDENTITY_INVALID','原封装文件范围、规格或位置不符');
    await regular(root,relative(root,file.file));if(sha256(await fs.readFile(file.file))!==file.sha256)throw new ProductionError('FILE_DIGEST_MISMATCH','原封装文件摘要不符');
    const media=await processWork(run.runId,options,()=>validateVideoOutput(file.file,extent,options.signal,options.metrics));
    if((await record(file.id,file.file,extent,media.duration)).content!==file.content)throw new ProductionError('FILE_IDENTITY_INVALID','原封装文件正文不符');files.set(file.id,file);
  }
  await mapMediaLimited(expected,options.runConcurrency??4,async(extent,index)=>{
    if(files.has(extent.id))return;cancelled(options);await options.onOutputStart?.(extent.id);
    const path=join(output,`${index}.mp4`),pending=join(output,`${index}.pending.mp4`);
    try{
      await processWork(run.runId,options,()=>withMediaSpan(options.metrics,index===0?'whole_video_mux':'scene_video_mux',()=>ffmpeg([
        ...(index===0?['-f','concat','-safe','0','-i',list]:['-i',chunks.get(extent.id)!.path]),'-i',pcm,
        '-filter_complex_threads','1','-filter_complex',`[1:a:0]atrim=start_sample=${frameSample(extent.fromFrame,extent.fps)}:end_sample=${frameSample(extent.toFrame,extent.fps)},asetpts=PTS-STARTPTS[a]`,
        '-map','0:v:0','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-ar',String(sampleRate),'-threads:a','1','-video_track_timescale','90000','-movflags','+faststart',pending
      ],options),{fromFrame:extent.fromFrame,toFrame:extent.toFrame,videoReencoded:false}));
      const media=await processWork(run.runId,options,()=>validateVideoOutput(pending,extent,options.signal,options.metrics));cancelled(options);await fs.rename(pending,path);
      const file=await record(extent.id,path,extent,media.duration);await options.onFileReady?.(file);files.set(extent.id,file);
    }finally{await fs.rm(pending,{force:true});}
  });
  return expected.map(e=>files.get(e.id)!);
}
