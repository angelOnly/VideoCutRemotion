import { spawn } from 'node:child_process';
import { openSync,closeSync,existsSync,readFileSync,mkdirSync,unlinkSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pluginRoot, deploymentEnvironment } from './production-release.mjs';
const command=process.argv[2]??'status',env=deploymentEnvironment(),data=resolve(env.TEXTVIDEO_DATA_ROOT??'');
if(!env.TEXTVIDEO_DATA_ROOT)throw new Error('必须配置独立 TEXTVIDEO_DATA_ROOT');
const url=`http://${env.TEXTVIDEO_HOST??'127.0.0.1'}:${env.TEXTVIDEO_PORT??3410}`;
if(command==='status'){const r=await fetch(`${url}/healthz`);console.log(JSON.stringify(await r.json()));}
else if(command==='stop'){const r=await fetch(`${url}/internal/shutdown`,{method:'POST',headers:{Authorization:`Bearer ${env.TEXTVIDEO_API_TOKEN}`}});if(!r.ok)throw new Error(`停止失败 ${r.status}`);console.log(await r.text());}
else if(command==='start'){
  mkdirSync(data,{recursive:true});const lock=join(data,'runtime.lock');if(existsSync(lock)){const old=JSON.parse(readFileSync(lock,'utf8'));let alive=true;try{process.kill(old.pid,0);}catch{alive=false;}if(alive)throw new Error('此数据根已有 Runtime，先查询状态');unlinkSync(lock);}
  const fd=openSync(join(data,'runtime.log'),'a');const child=spawn(process.execPath,[join(pluginRoot,'runtime/dist/runtime.cjs')],{cwd:data,env,windowsHide:true,detached:true,stdio:['ignore',fd,fd]});child.unref();closeSync(fd);console.log(JSON.stringify({pid:child.pid,url,state:'starting'}));
}else throw new Error('支持 start、stop、status');
