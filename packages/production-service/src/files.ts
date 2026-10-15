import { promises as fs } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { sha256, canonical, ProductionError } from './contracts.js';

export function inside(root: string, name: string) { const p=resolve(root,name), r=relative(resolve(root),p); if (r.startsWith('..') || isAbsolute(r)) throw new ProductionError('PATH_OUTSIDE_ROOT','路径越界'); return p; }
export async function regular(root: string, name: string) {
  const p=inside(root,name); const real=await fs.realpath(p); inside(await fs.realpath(root),real);
  if (!(await fs.lstat(p)).isFile()) throw new ProductionError('FILE_INVALID',`不是普通文件：${name}`); return p;
}
export async function json(path: string) { return JSON.parse(await fs.readFile(path,'utf8')); }
export async function writeJson(path: string, value: unknown) { await fs.mkdir(dirname(path),{recursive:true}); const tmp=`${path}.tmp`; await fs.writeFile(tmp,JSON.stringify(value,null,2)); await fs.rename(tmp,path); }
export async function treeDigest(root: string): Promise<string> {
  const entries: [string,string][]=[];
  async function walk(dir: string) { for (const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (['node_modules','.cache'].includes(entry.name)) continue;
    const p=join(dir,entry.name); if (entry.isSymbolicLink()) throw new ProductionError('LINK_FORBIDDEN','工程不允许链接');
    if (entry.isDirectory()) await walk(p); else entries.push([relative(root,p).replaceAll('\\','/'),sha256(await fs.readFile(p))]);
  }} await walk(root); return sha256(canonical(entries));
}
export function processFile(command: string, args: string[], options: {cwd?:string; signal?:AbortSignal; maxBytes?:number; timeoutMs?:number; onOutput?:(chunk:Buffer)=>void; captureOutput?:boolean}={}) {
  return new Promise<string>((resolveDone,reject)=>{
    if(options.signal?.aborted){reject(new ProductionError('PROCESS_CANCELLED','操作开始前已取消'));return;}
    // 每次检查拥有独立进程组；超时先请求退出，再升级终止，但始终等 close 后返回。
    const child=spawn(command,args,{cwd:options.cwd,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',bytes=0,reason='',upgrade:NodeJS.Timeout|undefined;
    const kill=(force:boolean)=>{
      if(!child.pid)return;
      if(process.platform==='win32'){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>{});}
      else {try{process.kill(-child.pid,force?'SIGKILL':'SIGTERM');}catch(error:any){if(error.code!=='ESRCH')child.kill(force?'SIGKILL':'SIGTERM');}}
    };
    const terminate=(code:string)=>{if(reason)return;reason=code;kill(false);upgrade=setTimeout(()=>kill(true),3000);};
    const abort=()=>terminate('PROCESS_CANCELLED');
    const timeout=setTimeout(()=>terminate('PROCESS_TIMEOUT'),options.timeoutMs??120000);
    const clean=()=>{clearTimeout(timeout);if(upgrade)clearTimeout(upgrade);options.signal?.removeEventListener('abort',abort);};
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    child.stdout.on('data',(d:Buffer)=>{bytes+=d.length;if(bytes>(options.maxBytes??8e6)){terminate('PROCESS_OUTPUT_LIMIT');return;}options.onOutput?.(d);if(options.captureOutput!==false)stdout+=d.toString('utf8');});
    child.stderr.on('data',d=>{stderr=(stderr+d).slice(-16000);});
    child.once('error',error=>{clean();reject(error);});
    child.once('close',code=>{if(reason)kill(true);clean();if(code===0&&!reason)resolveDone(stdout);else reject(new ProductionError(reason||'PROCESS_FAILED',`${command} 退出 ${code}：${stderr}`,500));});
  });
}
export const pcmMeasurementRule='mono-48000-s16le/1';
export type PcmMeasurement={ruleVersion:string;decoderId:string;audioSha256:string;sampleFormat:'s16le';sampleRate:48000;channels:1;sampleCount:number;duration:number};
const decoderIdentities=new Map<string,Promise<string>>();
export async function audioDecoderId(){
  const command=process.env.FFMPEG_PATH??'ffmpeg';
  let pending=decoderIdentities.get(command);
  if(!pending){pending=processFile(command,['-version'],{timeoutMs:30000}).then(version=>sha256(canonical({command,version,parameters:['-map','0:a:0','-ac','1','-ar','48000','-f','s16le']})));decoderIdentities.set(command,pending);pending.catch(()=>decoderIdentities.delete(command));}
  return pending;
}
export async function measureDecodedAudio(path:string,signal?:AbortSignal):Promise<PcmMeasurement>{
  if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','音频测量已取消');
  const audioSha256=sha256(await fs.readFile(path)),decoderId=await audioDecoderId();let bytes=0;
  await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-xerror','-i',path,'-map','0:a:0','-ac','1','-ar','48000','-f','s16le','-'],{signal,timeoutMs:120000,maxBytes:64*1024*1024,captureOutput:false,onOutput:chunk=>{bytes+=chunk.length;}});
  const sampleCount=bytes/2,duration=sampleCount/48000;
  if(!Number.isSafeInteger(sampleCount)||sampleCount<=0)throw new ProductionError('MEDIA_INVALID','音频没有有效解码采样');
  if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','音频测量已取消');
  if(sha256(await fs.readFile(path))!==audioSha256)throw new ProductionError('AUDIO_CHANGED','测量期间音频字节发生变化');
  return {ruleVersion:pcmMeasurementRule,decoderId,audioSha256,sampleFormat:'s16le',sampleRate:48000,channels:1,sampleCount,duration};
}
export function validPcmMeasurement(value:any,hash:string,decoderId:string):value is PcmMeasurement{
  return value?.ruleVersion===pcmMeasurementRule&&value.decoderId===decoderId&&value.audioSha256===hash&&value.sampleFormat==='s16le'&&value.sampleRate===48000&&value.channels===1&&Number.isSafeInteger(value.sampleCount)&&value.sampleCount>0&&value.duration===value.sampleCount/48000;
}
export async function decodedAudioSeconds(path:string,signal?:AbortSignal){return (await measureDecodedAudio(path,signal)).duration;}
export async function probe(path: string, decode=false, signal?:AbortSignal) {
  const data=JSON.parse(await processFile(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_format','-show_streams','-of','json',path],{signal,timeoutMs:30000}));
  const dur=Number(data.format?.duration); if(!Number.isFinite(dur)||dur<=0)throw new ProductionError('MEDIA_INVALID','媒体没有有效时长');
  if(decode)await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-xerror','-i',path,'-f','null','-'],{signal,timeoutMs:600000});
  return {...data,duration:dur};
}
