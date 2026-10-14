import {processFile} from './files.js';
import {ProductionError} from './contracts.js';
import {withMediaSpan, type MetricContext} from './media-metrics.js';
import {validateVideoOutput, type VideoExtent} from './video-output.js';

export type SceneCutMode='accurate'|'stream_copy'|'local_transcode';
export type SceneCutMetadata={cutMode:SceneCutMode;requestedStartSec:number;requestedEndSec:number;measuredDurationSec:number;startDeviationMs:number;endDeviationMs:number;mediaValidationVersion:'scene-cut-v1';fallbackReason?:string;boundaryValidation:'packet-pts-and-decoded-boundaries'|'decoded-boundaries'|'accurate-frame-trim';videoToleranceMs:number;audioToleranceMs:number};
const ffmpeg=()=>process.env.FFMPEG_PATH??'ffmpeg';
const fail=(message:string):never=>{throw new ProductionError('SCENE_BOUNDARY_MISMATCH',message);};
async function binary(path:string,at:number,args:string[],signal?:AbortSignal){
 const chunks:Buffer[]=[];
 await processFile(ffmpeg(),['-v','error','-xerror','-threads','1','-ss',String(Math.max(0,at)),'-i',path,...args,'-'],{signal,captureOutput:false,maxBytes:64*1024*1024,onOutput:c=>chunks.push(c)});
 return Buffer.concat(chunks);
}
async function packets(path:string,signal?:AbortSignal,interval?:string){
 return JSON.parse(await processFile(process.env.FFPROBE_PATH??'ffprobe',['-v','error',...(interval?['-read_intervals',interval]:[]),'-show_packets','-show_data_hash','sha256','-show_entries','packet=codec_type,pts_time,duration_time,data_hash','-of','json',path],{signal,maxBytes:64*1024*1024})).packets as {codec_type:string;pts_time:string;duration_time:string;data_hash:string}[];
}

/** 流拷贝用原压缩包身份和源 PTS 定位；静止画面或重复语音不能伪造切点证据。 */
async function packetBounds(path:string,whole:string,extent:VideoExtent,signal?:AbortSignal){
 const start=extent.fromFrame/extent.fps,end=extent.toFrame/extent.fps;
 const source=await packets(whole,signal,`${Math.max(0,start-1)}%${end+1}`),candidate=await packets(path,signal);
 const visible=candidate.filter(p=>p.codec_type==='video'&&Number(p.pts_time)>=-0.000001).sort((a,b)=>Number(a.pts_time)-Number(b.pts_time));
 if(!visible.length)fail('快速切片没有可显示的视频包');
 const sourceByHash=new Map<string,typeof source>();
 for(const packet of source)if(packet.codec_type==='video')sourceByHash.set(packet.data_hash,[...(sourceByHash.get(packet.data_hash)??[]),packet]);
 const match=(packet:typeof visible[number])=>{
  const matches=sourceByHash.get(packet.data_hash)??[];
  if(matches.length!==1)fail('源视频包身份缺失或有歧义，改用准确转码');
  return matches[0];
 };
 const first=match(visible[0]),last=match(visible.at(-1)!);
 const offset=Number(first.pts_time)-Number(visible[0].pts_time);
 for(const packet of visible){const original=match(packet);if(Math.abs(Number(original.pts_time)-Number(packet.pts_time)-offset)>.0001)fail('快速切片包时钟与原整片不连续');}
 const actualStart=Number(first.pts_time),actualEnd=Number(last.pts_time)+Number(last.duration_time);
 // 首版只接受一帧以内的视觉边界差异；台词仍独立按原计划起止核对。
 if(!Number.isFinite(actualStart)||!Number.isFinite(actualEnd)||Math.abs(actualStart-start)>1/extent.fps+.0001||Math.abs(actualEnd-end)>1/extent.fps+.0001)fail('快速切片的源 PTS 超出一帧边界容差');
 return {actualStart,actualEnd,frames:visible.length};
}
async function compareBoundaries(path:string,whole:string,extent:VideoExtent,videoStart:number,frames:number,copy:boolean,audioChannels:number,signal?:AbortSignal){
 const duration=(extent.toFrame-extent.fromFrame)/extent.fps;
 for(const frame of [...new Set([0,frames-1])]){
  const args=['-map','0:v:0','-frames:v','1',...(copy?[]:['-vf','scale=64:64']),'-pix_fmt','yuv420p','-f','rawvideo'];
  const original=await binary(whole,videoStart+frame/extent.fps,args,signal),cut=await binary(path,frame/extent.fps,args,signal);
  if(!original.length||original.length!==cut.length)fail('切片首尾帧缺失');
  if(copy){if(!original.equals(cut))fail('流拷贝首尾解码画面与原帧不一致');}
  else {let error=0;for(let i=0;i<cut.length;i++)error+=Math.abs(cut[i]-original[i]);if(error/cut.length>5)fail('局部转码首尾画面偏离源帧');}
 }
 // 保留独立声道，防止左右反相信号混成静音后掩盖错误音频。
 const window=Math.min(.4,duration),positions=[...new Set([0,Math.max(0,duration-window)])];
 for(const at of positions){
  const args=['-t',String(window),'-map','0:a:0','-ar','12000','-f','s16le'];
  const original=await binary(whole,extent.fromFrame/extent.fps+at,args,signal),cut=await binary(path,at,args,signal);
  const count=Math.min(original.length,cut.length)/2;
  if(count<Math.floor(window*12000)*audioChannels-2*audioChannels||Math.abs(original.length-cut.length)>8)fail('切片边界有效音频采样不足');
  let error=0,power=0;for(let i=0;i<count;i++){const x=original.readInt16LE(i*2)/32768,y=cut.readInt16LE(i*2)/32768;error+=(x-y)**2;power+=x*x;}
  // AAC 重编码有有限失真；同步比较而非寻找最相似位移，防止漏字被相关性搜索掩盖。
  if(Math.sqrt(error/count)>Math.max(.003,Math.sqrt(power/count)*.22))fail('切片首尾音频与目标源采样不对齐');
 }
}

export async function validateSceneFastCut(path:string,whole:string,expected:VideoExtent,signal?:AbortSignal,cutMode:'stream_copy'|'local_transcode'='stream_copy',metrics?:MetricContext){
 return withMediaSpan(metrics,'scene_boundary_validation',async child=>{
  const start=expected.fromFrame/expected.fps,end=expected.toFrame/expected.fps;
  const bounds=cutMode==='stream_copy'?await packetBounds(path,whole,expected,signal):{actualStart:start,actualEnd:end,frames:expected.toFrame-expected.fromFrame};
  // 整片严格验证函数保持原合同；流拷贝按真实包帧数验证，业务范围另由源 PTS 判断。
  const media=await validateVideoOutput(path,{...expected,toFrame:expected.fromFrame+bounds.frames},signal,child);
  const audioChannels=Number(media.streams.find((s:any)=>s.codec_type==='audio')?.channels);
  if(!Number.isInteger(audioChannels)||audioChannels<1)fail('切片音频声道数无效');
  await compareBoundaries(path,whole,expected,bounds.actualStart,bounds.frames,cutMode==='stream_copy',audioChannels,signal);
  return {...media,startDeviationMs:(bounds.actualStart-start)*1000,endDeviationMs:(bounds.actualEnd-end)*1000};
 });
}

export function sceneCutMetadata(media:{duration:number;startDeviationMs?:number;endDeviationMs?:number},extent:VideoExtent,cutMode:SceneCutMode,fallbackReason?:string):SceneCutMetadata{
 return {cutMode,requestedStartSec:extent.fromFrame/extent.fps,requestedEndSec:extent.toFrame/extent.fps,measuredDurationSec:media.duration,startDeviationMs:media.startDeviationMs??0,endDeviationMs:media.endDeviationMs??0,mediaValidationVersion:'scene-cut-v1',boundaryValidation:cutMode==='stream_copy'?'packet-pts-and-decoded-boundaries':cutMode==='local_transcode'?'decoded-boundaries':'accurate-frame-trim',videoToleranceMs:cutMode==='stream_copy'?1000/extent.fps:0,audioToleranceMs:0,...(fallbackReason?{fallbackReason}:{} )};
}
