import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProductionError, type Run } from './contracts.js';
import type { ProductionRepository } from './repository.js';
import type { ProductionConfig } from './config.js';
import { json, processFile, treeDigest, writeJson } from './files.js';
import { taskInstruction, INSTRUCTION_VERSION } from './task-instructions.js';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams.js';
import type { TurnStartParams } from './protocol/v2/TurnStartParams.js';
import { ToolObserver } from './tool-observer.js';
import { collectMainTurn } from './turn-events.js';
import { CodexUsageObserver } from './codex-usage.js';
export const handoffSchema={type:'object',additionalProperties:false,required:['taskId','runId','inputDigest','resultPath'],properties:{taskId:{type:'string'},runId:{type:'string'},inputDigest:{type:'string'},resultPath:{type:'string'}}};
export class AppServerClient {
  child:ChildProcessWithoutNullStreams;private seq=0;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:any)=>void;timer:NodeJS.Timeout}>();
  private closing?:Promise<void>;
  private closed:Promise<void>;
  onEvent:(event:any)=>void=()=>{};onClose:(error:Error)=>void=()=>{};
  constructor(command:string,args:string[],env:NodeJS.ProcessEnv,cwd:string){
    this.child=spawn(command,args,{env,cwd,windowsHide:true,detached:process.platform!=='win32',stdio:'pipe'});
    this.closed=new Promise(resolve=>{this.child.once('close',()=>resolve());this.child.once('error',()=>resolve());});
    this.child.stdin.on('error',e=>this.connectionClosed(e));
    createInterface({input:this.child.stdout}).on('line',line=>{try{const msg=JSON.parse(line);if(msg.id!==undefined&&this.pending.has(msg.id)){const p=this.pending.get(msg.id)!;clearTimeout(p.timer);this.pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}else if(msg.id!==undefined){this.child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'后台执行不支持交互确认'}})+'\n');}else this.onEvent(msg);}catch(e){this.onClose(new Error(`App Server 协议错误：${e}`));}});
    this.child.on('error',e=>this.connectionClosed(e));this.child.on('exit',()=>this.connectionClosed(new Error('App Server 连接结束')));
  }
  private connectionClosed(error:Error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.onClose(error);}
  call(method:string,params:any={},timeoutMs=60000):Promise<any>{if(this.closing||this.child.stdin.destroyed)return Promise.reject(new Error('App Server 连接已关闭'));const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} 响应未知`));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
  notify(method:string,params:any={}){this.child.stdin.write(JSON.stringify({method,params})+'\n');}
  async init(){await this.call('initialize',{clientInfo:{name:'textvideo_studio',version:'1.0.0'},capabilities:{experimentalApi:true}});this.notify('initialized');}
  close(){
    if(this.closing)return this.closing;
    this.closing=(async()=>{
      this.child.stdin.end();
      const kill=(force:boolean)=>{if(!this.child.pid)return;if(process.platform==='win32'){const p=spawn('taskkill',['/PID',String(this.child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});p.on('error',()=>{});}else{try{process.kill(-this.child.pid,force?'SIGKILL':'SIGTERM');}catch{}}};
      const soft=setTimeout(()=>kill(false),2000),hard=setTimeout(()=>kill(true),5000);
      try{await this.closed;}finally{clearTimeout(soft);clearTimeout(hard);kill(true);}
    })();return this.closing;
  }
}
type DiscoveredSkill={name:string;path:string;scope:string;enabled:boolean};
type StageSkillConfig={stage:Run['stage'];sourceDigest:string;paths:string[];overrides:Array<{path:string;enabled:boolean}>};
export function discoveredSkills(result:any):DiscoveredSkill[]{
  if(!Array.isArray(result?.data)||result.data.some((entry:any)=>!Array.isArray(entry.skills)||entry.errors?.length))throw new ProductionError('SKILL_DISCOVERY_INVALID','宿主技能发现结构无效或包含读取错误',503);
  return result.data.flatMap((entry:any)=>entry.skills);
}
export function verifyStageSkills(result:any,paths:string[]){
  const enabled=discoveredSkills(result).filter(skill=>skill.enabled),expected=new Set(paths);
  const unexpected=enabled.filter(skill=>!expected.has(skill.path)&&skill.scope!=='system');
  const missing=paths.filter(path=>!enabled.some(skill=>skill.path===path));
  if(unexpected.length||missing.length)throw new ProductionError('STAGE_SKILLS_INVALID',`阶段技能目录不符：额外 ${unexpected.map(s=>s.name).join(',')}；缺少 ${missing.join(',')}`,503);
  // 系统若拒绝禁用，保留真实条目供验收，不伪装为未发现。
  return {enabled:enabled.map(({name,path,scope})=>({name,path,scope})),forcedSystem:enabled.filter(skill=>!expected.has(skill.path)&&skill.scope==='system')};
}
export function verifyStageTools(statuses:any,stage:Run['stage']){
  const servers=Array.isArray(statuses?.data)?statuses.data:[statuses];
  const names=new Set<string>(servers.flatMap((server:any)=>Object.entries(server?.tools??{}).map(([key,value])=>(value as any)?.name??key)));
  const required=stage==='analysis'?['read_runtime_release','read_production_task']:['read_runtime_release','read_production_task','synthesize_speech_batch','verify_sentence_audio','render_template'];
  if(required.some(name=>!names.has(name)))throw new ProductionError('PLUGIN_NOT_LOADED',`后台会话未加载 ${stage} 阶段必要工具`,503);
  if(stage==='analysis'&&[...names].some(name=>!required.includes(name)))throw new ProductionError('ANALYSIS_TOOLS_EXPOSED','Analysis 发现了制作或动效等阶段外工具',503);
}
export async function prepareStageSkills(stage:Run['stage'],root:string,pluginRoot:string,executable:string,env:NodeJS.ProcessEnv):Promise<StageSkillConfig>{
  const saved=join(root,'stage-skills.json'),existing=await fs.stat(saved).catch(()=>null);
  if(existing){const config=await json(saved) as StageSkillConfig;if(config.stage!==stage||await treeDigest(join(root,'.agents/skills'))!==config.sourceDigest)throw new ProductionError('STAGE_SKILLS_CHANGED','本 Run 固定阶段技能已改变，不重置活动会话配置');return config;}
  const source=join(pluginRoot,'skills-stages',stage),destination=join(root,'.agents/skills');
  if(!(await fs.stat(source).catch(()=>null))?.isDirectory())throw new ProductionError('STAGE_SKILLS_MISSING',`发行缺少 ${stage} 技能视图`,503);
  await fs.mkdir(dirname(destination),{recursive:true});await fs.cp(source,destination,{recursive:true});
  const paths:string[]=[];
  for(const item of await fs.readdir(destination,{withFileTypes:true}))if(item.isDirectory()&&await fs.stat(join(destination,item.name,'SKILL.md')).catch(()=>null))paths.push(await fs.realpath(join(destination,item.name,'SKILL.md')));
  if(!paths.some(path=>path.endsWith(`${process.platform==='win32'?'\\':'/'}production-coordinator${process.platform==='win32'?'\\':'/'}SKILL.md`)))throw new ProductionError('STAGE_SKILLS_MISSING','阶段视图缺少生产入口',503);
  // skills.config 只切换已发现技能，不能添加发现根；按正式 repo 发现机制装入本 Run。
  const probe=new AppServerClient(executable,['app-server','-c','web_search="disabled"','-c','features.apps=false'],env,root);let baseline:any;
  try{await probe.init();baseline=await probe.call('skills/list',{cwds:[root],forceReload:true});}finally{await probe.close();}
  await writeJson(join(root,'skill-discovery-baseline.json'),baseline);
  const overrides:Array<{path:string;enabled:boolean}>=[],wanted=new Set(paths);
  for(const skill of discoveredSkills(baseline)){
    // 已测 CLI 需要 SKILL.md 路径；同时写文档规定的目录路径，兼容宿主版本差异。
    for(const path of [skill.path,dirname(skill.path)])overrides.push({path,enabled:wanted.has(skill.path)});
  }
  const config:StageSkillConfig={stage,sourceDigest:await treeDigest(destination),paths:paths.sort(),overrides};await writeJson(saved,config);return config;
}
function skillConfigArgument(config:StageSkillConfig){return `skills.config=[${config.overrides.map(item=>`{path=${JSON.stringify(item.path)},enabled=${item.enabled}}`).join(',')}]`;}
export async function executeCodex(run:Run,root:string,repo:ProductionRepository,config:ProductionConfig,signal:AbortSignal){
  // 后台只继承运行所需环境；供应商密钥留在 Runtime，不交给创作会话。
  const env:NodeJS.ProcessEnv={...process.env,CODEX_HOME:config.codexHome,TEXTVIDEO_RUNTIME_URL:`http://${config.host}:${config.port}`,TEXTVIDEO_RUN_ID:run.runId,TEXTVIDEO_RUN_TOKEN:run.token!,TEXTVIDEO_PLUGIN_ROOT:config.pluginRoot};
  delete env.DOUBAO_API_KEY;delete env.CALLBACK_SECRET;delete env.TEXTVIDEO_API_TOKEN;delete env.DOUBAO_VOICES_FILE;
  const log=join(root,'logs','codex-events.jsonl');await fs.mkdir(join(root,'logs'),{recursive:true});
  const observer=new ToolObserver();
  const usage=new CodexUsageObserver();
  if(await fs.stat(log).catch(()=>null))for await(const line of createInterface({input:createReadStream(log),crlfDelay:Infinity})){try{usage.observe(JSON.parse(line));}catch{}}
  let eventWrites:Promise<unknown>=Promise.resolve();
  const stageSkills=await prepareStageSkills(run.stage,root,config.pluginRoot,config.codexExecutable,env);
  const client=new AppServerClient(config.codexExecutable,['app-server','-c','web_search="disabled"','-c','features.apps=false','-c',skillConfigArgument(stageSkills)],env,root);
  client.child.stderr.on('data',data=>{observer.observeTransport(String(data));void fs.appendFile(join(root,'logs','codex-stderr.log'),data).catch(()=>{});});
  let threadId=run.checkpoint.codex?.threadId,turnId=run.checkpoint.codex?.turnId;
  let finish!:(value:any)=>void,fail!:(reason:any)=>void;const completed=new Promise<any>((resolve,reject)=>{finish=resolve;fail=reject;});
  completed.catch(()=>{});
  // 先安装事件处理，再发 turn/start，避免极短 turn 完成事件早于响应。
  const collect=collectMainTurn(()=>({threadId,turnId}),finish,fail);
  const saveDiagnostics=()=>{try{repo.checkpoint(run.runId,run.token!,{stalledTools:observer.stalled(),transportDiagnostics:observer.transportDiagnostics()});}catch{}};
  const observeTimer=setInterval(saveDiagnostics,15000);
  let discoveryChecks:Promise<unknown>=Promise.resolve();
  client.onEvent=event=>{
    eventWrites=eventWrites.then(()=>fs.appendFile(log,JSON.stringify(event)+'\n')).catch(()=>{});usage.observe(event);observer.observe(event);collect(event);
    const started=event.method==='thread/started'?event.params?.thread:null;
    if(started?.id&&started?.cwd){
      // 每次宿主通知新主/子会话都核对实际 cwd 的目录，结果单独留证。
      discoveryChecks=discoveryChecks.then(async()=>{
        const listed=await client.call('skills/list',{cwds:[started.cwd],forceReload:true});
        const record={threadId:started.id,cwd:started.cwd,skills:listed};
        await fs.appendFile(join(root,'logs','thread-skill-discovery.jsonl'),JSON.stringify(record)+'\n');
        verifyStageSkills(listed,stageSkills.paths);
      }).catch(error=>{fail(error);void client.close();});
    }
  };
  client.onClose=e=>{observer.observeTransport(e.message,'connection');saveDiagnostics();fail(new ProductionError('CODEX_RESULT_UNKNOWN',e.message,503));};
  const abort=()=>{if(threadId&&turnId)void client.call('turn/interrupt',{threadId,turnId},5000).catch(()=>{});void client.close().then(()=>fail(new ProductionError('CODEX_RESULT_UNKNOWN','会话已停止，原工具结果需核查',503)));};signal.addEventListener('abort',abort,{once:true});
  try{
    await client.init();
    const skills=await client.call('skills/list',{cwds:[root],forceReload:true}),skillEvidence=verifyStageSkills(skills,stageSkills.paths);
    await writeJson(join(root,'stage-discovery.json'),{stage:run.stage,configuration:stageSkills,skills,evidence:skillEvidence,recovery:!!threadId});
    if(threadId){
      const stored=await client.call('thread/read',{threadId,includeTurns:true}),turn=stored.thread.turns?.find((t:any)=>t.id===turnId);
      if(turn?.status==='completed'){const item=[...(turn.items??[])].reverse().find((i:any)=>i.type==='agentMessage');return JSON.parse(item?.text??'');}
      // stdio 进程丢失后不能证明原工具已停止；不新开 turn 重放。
      throw new ProductionError('CODEX_RESULT_UNKNOWN','原会话未得到确定完成结果，保留句柄等待核查',503);
    }
    // 后台 MCP 的绝对发行入口和允许继承的环境必须显式提供，不能依赖桌面进程环境。
    const toolConfig={command:process.execPath,args:[join(config.pluginRoot,'scripts/production-mcp-launcher.mjs')],cwd:config.pluginRoot,env:{TEXTVIDEO_PLUGIN_ROOT:config.pluginRoot,TEXTVIDEO_DEPENDENCY_ROOT:config.dependencyRoot,TEXTVIDEO_RUNTIME_URL:env.TEXTVIDEO_RUNTIME_URL!,TEXTVIDEO_RUN_ID:run.runId,TEXTVIDEO_RUN_TOKEN:run.token!},startup_timeout_sec:60,tool_timeout_sec:180,default_tools_approval_mode:'approve'};
    const startParams:ThreadStartParams={cwd:root,approvalPolicy:'never',sandbox:'workspace-write',...(config.model?{model:config.model}:{}),config:{web_search:'disabled',features:{apps:false},skills:{config:stageSkills.overrides},...(process.platform==='win32'?{windows:{sandbox:'unelevated'}}:{}),mcp_servers:{'textvideo-studio':toolConfig}},developerInstructions:'这是已授权的隔离模板视频生产。只使用本 Run .agents/skills 阶段入口及工具；子代理继承同一阶段配置和目录，开工先核对实际可发现目录，不得重新加载其他插件技能。禁止读取凭据或访问其他任务。完成本阶段并按结构化协议交付。'};
    const started=await client.call('thread/start',startParams);
    threadId=started.thread.id;repo.checkpoint(run.runId,run.token!,{codex:{threadId},instructionVersion:INSTRUCTION_VERSION});
    const statuses=await client.call('mcpServerStatus/list',{threadId,detail:'toolsAndAuthOnly'});
    await writeJson(join(root,'plugin-discovery.json'),{skills,statuses});
    verifyStageTools(statuses,run.stage);
    const runtime=await client.call('mcpServer/tool/call',{threadId,server:'textvideo-studio',tool:'read_runtime_release',arguments:{}});
    if(runtime?.isError)throw new ProductionError('PLUGIN_NOT_LOADED','后台 MCP 发行读取失败',503);
    if(!JSON.stringify(runtime).includes(config.release.releaseId))throw new ProductionError('RELEASE_MISMATCH','后台 MCP 与 Runtime 不同版',503);
    const instruction=taskInstruction(run,root,config.pluginRoot,config);await fs.writeFile(join(root,'codex-instruction.txt'),instruction);
    await writeJson(join(root,'plugin-evidence.json'),{release:config.release,skills,statuses,runtime,model:{requested:config.model??null,actual:started.model??started.thread?.model??null,reasoningEffort:'low'},codexVersion:await processFile(config.codexExecutable,['--version'])});
    const turnParams:TurnStartParams={threadId,input:[{type:'text',text:instruction,text_elements:[]}],effort:'low',approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:[root],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false},outputSchema:handoffSchema};
    const response=await client.call('turn/start',turnParams);turnId=response.turn.id;repo.checkpoint(run.runId,run.token!,{codex:{threadId,turnId}});
    if(signal.aborted)abort();const result=await completed;return JSON.parse(result.text);
  }finally{clearInterval(observeTimer);signal.removeEventListener('abort',abort);client.onClose=()=>{};await discoveryChecks;await client.close();await eventWrites;await writeJson(join(root,'logs','codex-usage.json'),usage.summary(log));completed.catch(()=>{});}
}
