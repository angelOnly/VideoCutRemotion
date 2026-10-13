import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ProductionError, type Run } from './contracts.js';
import type { ProductionRepository } from './repository.js';
import type { ProductionConfig } from './config.js';
import { json, processFile, writeJson } from './files.js';
import { taskInstruction, INSTRUCTION_VERSION } from './task-instructions.js';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams.js';
import type { TurnStartParams } from './protocol/v2/TurnStartParams.js';
import { collectMainTurn } from './turn-events.js';
export const handoffSchema={type:'object',additionalProperties:false,required:['taskId','runId','inputDigest','resultPath'],properties:{taskId:{type:'string'},runId:{type:'string'},inputDigest:{type:'string'},resultPath:{type:'string'}}};
export class AppServerClient {
  child:ChildProcessWithoutNullStreams;private seq=0;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:any)=>void;timer:NodeJS.Timeout}>();
  onEvent:(event:any)=>void=()=>{};onClose:(error:Error)=>void=()=>{};
  constructor(command:string,args:string[],env:NodeJS.ProcessEnv,cwd:string){
    this.child=spawn(command,args,{env,cwd,windowsHide:true,stdio:'pipe'});
    createInterface({input:this.child.stdout}).on('line',line=>{try{const msg=JSON.parse(line);if(msg.id!==undefined&&this.pending.has(msg.id)){const p=this.pending.get(msg.id)!;clearTimeout(p.timer);this.pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}else if(msg.id!==undefined){this.child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'后台执行不支持交互确认'}})+'\n');}else this.onEvent(msg);}catch(e){this.onClose(new Error(`App Server 协议错误：${e}`));}});
    this.child.on('error',e=>this.onClose(e));this.child.on('exit',()=>{const e=new Error('App Server 连接结束');for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.onClose(e);});
  }
  call(method:string,params:any={},timeoutMs=60000):Promise<any>{const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} 响应未知`));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
  notify(method:string,params:any={}){this.child.stdin.write(JSON.stringify({method,params})+'\n');}
  async init(){await this.call('initialize',{clientInfo:{name:'textvideo_studio',version:'1.0.0'},capabilities:{experimentalApi:true}});this.notify('initialized');}
  close(){this.child.stdin.end();}
}
export async function executeCodex(run:Run,root:string,repo:ProductionRepository,config:ProductionConfig,signal:AbortSignal){
  // 后台只继承运行所需环境；供应商密钥留在 Runtime，不交给创作会话。
  const env:NodeJS.ProcessEnv={...process.env,CODEX_HOME:config.codexHome,TEXTVIDEO_RUNTIME_URL:`http://${config.host}:${config.port}`,TEXTVIDEO_RUN_ID:run.runId,TEXTVIDEO_RUN_TOKEN:run.token!,TEXTVIDEO_PLUGIN_ROOT:config.pluginRoot};
  delete env.DOUBAO_API_KEY;delete env.CALLBACK_SECRET;delete env.TEXTVIDEO_API_TOKEN;delete env.DOUBAO_VOICES_FILE;
  const client=new AppServerClient(config.codexExecutable,['app-server','-c','web_search="disabled"'],env,root);
  const log=join(root,'logs','codex-events.jsonl');await fs.mkdir(join(root,'logs'),{recursive:true});
  client.child.stderr.on('data',data=>{void fs.appendFile(join(root,'logs','codex-stderr.log'),data);});
  let threadId=run.checkpoint.codex?.threadId,turnId=run.checkpoint.codex?.turnId;
  let finish!:(value:any)=>void,fail!:(reason:any)=>void;const completed=new Promise<any>((resolve,reject)=>{finish=resolve;fail=reject;});
  completed.catch(()=>{});
  // 先安装事件处理，再发 turn/start，避免极短 turn 完成事件早于响应。
  const collect=collectMainTurn(()=>({threadId,turnId}),finish,fail);
  client.onEvent=event=>{void fs.appendFile(log,JSON.stringify(event)+'\n');collect(event);};
  client.onClose=e=>fail(new ProductionError('CODEX_RESULT_UNKNOWN',e.message,503));
  const abort=()=>{if(threadId&&turnId)void client.call('turn/interrupt',{threadId,turnId}).catch(fail);};signal.addEventListener('abort',abort,{once:true});
  try{
    await client.init();
    if(threadId){
      const stored=await client.call('thread/read',{threadId,includeTurns:true}),turn=stored.thread.turns?.find((t:any)=>t.id===turnId);
      if(turn?.status==='completed'){const item=[...(turn.items??[])].reverse().find((i:any)=>i.type==='agentMessage');return JSON.parse(item?.text??'');}
      // stdio 进程丢失后不能证明原工具已停止；不新开 turn 重放。
      throw new ProductionError('CODEX_RESULT_UNKNOWN','原会话未得到确定完成结果，保留句柄等待核查',503);
    }
    // 后台 MCP 的绝对发行入口和允许继承的环境必须显式提供，不能依赖桌面进程环境。
    const toolConfig={command:process.execPath,args:[join(config.pluginRoot,'scripts/production-mcp-launcher.mjs')],cwd:config.pluginRoot,env:{TEXTVIDEO_PLUGIN_ROOT:config.pluginRoot,TEXTVIDEO_DEPENDENCY_ROOT:config.dependencyRoot,TEXTVIDEO_RUNTIME_URL:env.TEXTVIDEO_RUNTIME_URL!,TEXTVIDEO_RUN_ID:run.runId,TEXTVIDEO_RUN_TOKEN:run.token!},startup_timeout_sec:60,tool_timeout_sec:180,default_tools_approval_mode:'approve'};
    const startParams:ThreadStartParams={cwd:root,approvalPolicy:'never',sandbox:'workspace-write',...(config.model?{model:config.model}:{}),config:{web_search:'disabled',features:{apps:false},...(process.platform==='win32'?{windows:{sandbox:'unelevated'}}:{}),mcp_servers:{'textvideo-studio':toolConfig}},developerInstructions:'这是已授权的隔离模板视频生产。只使用发行插件入口及工具；禁止读取凭据或访问其他任务。完成本阶段并按结构化协议交付。'};
    const started=await client.call('thread/start',startParams);
    threadId=started.thread.id;repo.checkpoint(run.runId,run.token!,{codex:{threadId},instructionVersion:INSTRUCTION_VERSION});
    const skills=await client.call('skills/list',{cwds:[root],forceReload:true});
    const statuses=await client.call('mcpServerStatus/list',{threadId,detail:'toolsAndAuthOnly'});
    await writeJson(join(root,'plugin-discovery.json'),{skills,statuses});
    const statusText=JSON.stringify(statuses);if(!statusText.includes('synthesize_speech')||!statusText.includes('render_template')||!JSON.stringify(skills).includes('production-coordinator'))throw new ProductionError('PLUGIN_NOT_LOADED','后台会话没有加载完整本版插件',503);
    const runtime=await client.call('mcpServer/tool/call',{threadId,server:'textvideo-studio',tool:'read_runtime_release',arguments:{}});
    if(!JSON.stringify(runtime).includes(config.release.releaseId))throw new ProductionError('RELEASE_MISMATCH','后台 MCP 与 Runtime 不同版',503);
    const instruction=taskInstruction(run,root,config.pluginRoot);await fs.writeFile(join(root,'codex-instruction.txt'),instruction);
    await writeJson(join(root,'plugin-evidence.json'),{release:config.release,skills,statuses,runtime,codexVersion:await processFile(config.codexExecutable,['--version'])});
    const turnParams:TurnStartParams={threadId,input:[{type:'text',text:instruction,text_elements:[]}],approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:[root],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false},outputSchema:handoffSchema};
    const response=await client.call('turn/start',turnParams);turnId=response.turn.id;repo.checkpoint(run.runId,run.token!,{codex:{threadId,turnId}});
    if(signal.aborted)abort();const result=await completed;return JSON.parse(result.text);
  }finally{signal.removeEventListener('abort',abort);client.onClose=()=>{};client.close();completed.catch(()=>{});}
}
