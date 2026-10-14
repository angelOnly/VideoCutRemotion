import { promises as fs } from 'node:fs';
import { processFile } from '../../../packages/production-service/src/files.js';
import { validateVideoOutput, validateSceneFastCut, type VideoExtent } from '../../../packages/production-service/src/video-output.js';

import {sceneCutMetadata} from '../../../packages/production-service/src/fast-cut-validation.js';
import {withMediaSpan,type MetricContext} from '../../../packages/production-service/src/media-metrics.js';

/** 从原整片的全局帧裁剪；默认保留准确路径；混合模式只采用通过源边界验证的候选。 */
export async function cutSceneFromWhole(whole:string, output:string, extent:VideoExtent, signal?:AbortSignal, mode:'accurate'|'hybrid'='accurate',metrics?:MetricContext) {
  const pending=output.replace(/\.mp4$/,'.pending.mp4');
  const start=extent.fromFrame/extent.fps,end=extent.toFrame/extent.fps;
  const failures:string[]=[];
  try {
    if(mode==='hybrid')for(const method of ['stream_copy','local_transcode'] as const){
      try {
        await withMediaSpan(metrics,`scene_${method}`,()=>processFile(process.env.FFMPEG_PATH??'ffmpeg',[
          '-v','error','-xerror','-y','-threads','1','-ss',String(start),'-i',whole,'-t',String(end-start),
          '-map','0:v:0','-map','0:a:0',
          ...(method==='stream_copy'?['-c','copy']:['-filter_threads','1','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p','-threads:v','2','-r',String(extent.fps),'-fps_mode:v','cfr','-c:a','aac','-b:a','192k','-threads:a','1']),
          '-movflags','+faststart',pending
        ],{signal,timeoutMs:Math.max(120000,(end-start)*10000)}));
        const media=await validateSceneFastCut(pending,whole,extent,signal,method,metrics);
        signal?.throwIfAborted();await fs.rename(pending,output);
        return {...media,cutMetadata:sceneCutMetadata(media,extent,method,failures.join('; ')||undefined)};
      } catch(error){
        signal?.throwIfAborted();
        failures.push(`${method}: ${error instanceof Error?error.message:String(error)}`.slice(0,2000));
        await fs.rm(pending,{force:true});
      }
    }
    await withMediaSpan(metrics,'scene_accurate',()=>processFile(process.env.FFMPEG_PATH??'ffmpeg',[
      '-v','error','-xerror','-y','-threads','1','-i',whole,
      '-filter_threads','1','-filter_complex_threads','1',
      '-filter_complex',`[0:v:0]trim=start_frame=${extent.fromFrame}:end_frame=${extent.toFrame},setpts=PTS-STARTPTS[v];[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a]`,
      '-map','[v]','-map','[a]','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p',
      // 显式声明恒定帧率，避免短片最后一帧的封装时长丢失。
      '-threads:v','2','-r',String(extent.fps),'-fps_mode:v','cfr','-c:a','aac','-b:a','192k','-threads:a','1',
      '-movflags','+faststart',pending
    ],{signal,timeoutMs:Math.max(120000,end*10000)}));
    const media=await validateVideoOutput(pending,extent,signal,metrics);
    // 核验通过才对后续审片暴露正式文件名；失败不污染已登记的其他分镜。
    signal?.throwIfAborted();await fs.rename(pending,output);
    return {...media,cutMetadata:sceneCutMetadata(media,extent,'accurate',failures.join('; ')||undefined)};
  } finally {await fs.rm(pending,{force:true});}
}
