import { probe, processFile } from './files.js';
import { ProductionError } from './contracts.js';
import {withMediaSpan,type MetricContext} from './media-metrics.js';
export {validateSceneFastCut} from './fast-cut-validation.js';

export type VideoExtent = {fromFrame:number;toFrame:number;width:number;height:number;fps:number};
const rate = (value:string) => {const [n,d=1]=String(value).split('/').map(Number);return n/d;};

/** 一次完整解码同时数帧，不用容器时长推测帧数，也不重复做第二遍计数。 */
export async function validateVideoOutput(path:string, expected:VideoExtent, signal?:AbortSignal, metrics?:MetricContext) {
  const frames=expected.toFrame-expected.fromFrame;
  if(!Number.isInteger(frames)||frames<1||!Number.isFinite(expected.fps)||expected.fps<=0)throw new ProductionError('RANGE_INVALID','视频期望帧范围无效');
  const media=await withMediaSpan(metrics,'video_ffprobe',()=>probe(path,false,signal));
  const video=media.streams.find((s:any)=>s.codec_type==='video'),audio=media.streams.find((s:any)=>s.codec_type==='audio');
  const seconds=frames/expected.fps;
  const audioTolerance=3*1024/(Number(audio?.sample_rate)||48000)+1/expected.fps;
  if(!video||!audio||video.width!==expected.width||video.height!==expected.height||
    !Number.isFinite(rate(video.avg_frame_rate))||Math.abs(rate(video.avg_frame_rate)-expected.fps)>0.0001||
    !Number.isFinite(Number(video.start_time))||Math.abs(Number(video.start_time))>0.001||
    !Number.isFinite(Number(video.duration))||Math.abs(Number(video.duration)-seconds)>0.002||
    !Number.isFinite(Number(audio.start_time))||Math.abs(Number(audio.start_time))>audioTolerance||
    !Number.isFinite(Number(audio.duration))||Math.abs(Number(audio.duration)-seconds)>audioTolerance) {
    throw new ProductionError('MEDIA_CHECK_FAILED',`视频规格、时间戳或有效音频范围不符：${JSON.stringify({expected,video:video&&{width:video.width,height:video.height,fps:video.avg_frame_rate,start:video.start_time,duration:video.duration},audio:audio&&{start:audio.start_time,duration:audio.duration},audioTolerance})}`);
  }
  const output=await withMediaSpan(metrics,'video_full_decode',()=>processFile(process.env.FFMPEG_PATH??'ffmpeg',[
    '-v','error','-xerror','-threads','1','-i',path,'-map','0:v:0','-map','0:a:0',
    '-filter_threads','1','-filter_complex_threads','1','-threads:v','1','-threads:a','1',
    '-fps_mode:v','passthrough','-progress','pipe:1','-nostats','-f','null','-'
  ],{signal,timeoutMs:Math.max(600000,seconds*10000)}));
  const counts=[...output.matchAll(/^frame=(\d+)\s*$/gm)];
  const actualFrames=Number(counts.at(-1)?.[1]);
  if(!output.includes('progress=end')||actualFrames!==frames)throw new ProductionError('VIDEO_FRAME_COUNT_MISMATCH',`实际解码 ${actualFrames} 帧，要求 ${frames} 帧`);
  return {...media,actualFrames};
}
