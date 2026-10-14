import { promises as fs } from 'node:fs';
import { processFile } from '../../../packages/production-service/src/files.js';
import { validateVideoOutput, type VideoExtent } from '../../../packages/production-service/src/video-output.js';

/** 从原整片的全局帧裁剪；准确性优先，不用关键帧流拷贝近似切点。 */
export async function cutSceneFromWhole(whole:string, output:string, extent:VideoExtent, signal?:AbortSignal) {
  const pending=output.replace(/\.mp4$/,'.pending.mp4');
  const start=extent.fromFrame/extent.fps,end=extent.toFrame/extent.fps;
  try {
    await processFile(process.env.FFMPEG_PATH??'ffmpeg',[
      '-v','error','-xerror','-y','-threads','1','-i',whole,
      '-filter_threads','1','-filter_complex_threads','1',
      '-filter_complex',`[0:v:0]trim=start_frame=${extent.fromFrame}:end_frame=${extent.toFrame},setpts=PTS-STARTPTS[v];[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a]`,
      '-map','[v]','-map','[a]','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p',
      // 显式声明恒定帧率，避免短片最后一帧的封装时长丢失。
      '-threads:v','2','-r',String(extent.fps),'-fps_mode:v','cfr','-c:a','aac','-b:a','192k','-threads:a','1',
      '-movflags','+faststart',pending
    ],{signal,timeoutMs:Math.max(120000,end*10000)});
    const media=await validateVideoOutput(pending,extent,signal);
    // 核验通过才对后续审片暴露正式文件名；失败不污染已登记的其他分镜。
    signal?.throwIfAborted();await fs.rename(pending,output);
    return media;
  } finally {await fs.rm(pending,{force:true});}
}
