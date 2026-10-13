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
export function processFile(command: string, args: string[], options: {cwd?:string; signal?:AbortSignal; maxBytes?:number}={}) {
  return new Promise<string>((resolveDone,reject)=>{
    const child=spawn(command,args,{cwd:options.cwd,windowsHide:true,stdio:['ignore','pipe','pipe']}); let stdout='',stderr=''; let cancelled=false;
    const abort=()=>{cancelled=true; if(process.platform==='win32'&&child.pid) spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); else child.kill('SIGTERM');};
    options.signal?.addEventListener('abort',abort,{once:true}); if(options.signal?.aborted)abort();
    child.stdout.on('data',d=>{stdout+=d; if(stdout.length>(options.maxBytes??8e6))abort();}); child.stderr.on('data',d=>{stderr=(stderr+d).slice(-16000);});
    child.once('error',reject); child.once('close',code=>{options.signal?.removeEventListener('abort',abort); if(code===0&&!cancelled)resolveDone(stdout);else reject(new ProductionError(cancelled?'PROCESS_CANCELLED':'PROCESS_FAILED',`${command} 退出 ${code}：${stderr}`,500));});
  });
}
export async function probe(path: string, decode=false, signal?:AbortSignal) {
  const data=JSON.parse(await processFile(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_format','-show_streams','-of','json',path],{signal}));
  const dur=Number(data.format?.duration); if(!Number.isFinite(dur)||dur<=0)throw new ProductionError('MEDIA_INVALID','媒体没有有效时长');
  if(decode)await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-xerror','-i',path,'-f','null','-'],{signal});
  return {...data,duration:dur};
}
