import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProductionError, turnResultSchema, modelTurnOutputSchema, type Run } from './contracts.js';
import type { ProductionRepository } from './repository.js';
import type { ProductionConfig } from './config.js';
import { json, processFile, treeDigest, writeJson } from './files.js';
import { taskInstruction, INSTRUCTION_VERSION } from './task-instructions.js';
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams.js';
import type { TurnStartParams } from './protocol/v2/TurnStartParams.js';
import { ToolObserver } from './tool-observer.js';
import { createTurnReceiver, threadDiscoveries } from './turn-events.js';
import { ExecutionController, type MediaRuntime, type RuntimeOutcome } from './execution-controller.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CodexUsageObserver } from './codex-usage.js';
export const handoffSchema=zodToJsonSchema(modelTurnOutputSchema,{$refStrategy:'none'});
export class AppServerResponseError extends Error {
  constructor(public response:unknown){super(JSON.stringify(response));}
}
export class AppServerClient {
  child:ChildProcessWithoutNullStreams;private seq=0;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:any)=>void;timer:NodeJS.Timeout}>();
  private closing?:Promise<void>;
  private closed:Promise<void>;
  onEvent:(event:any)=>void=()=>{};onClose:(error:Error)=>void=()=>{};
  constructor(command:string,args:string[],env:NodeJS.ProcessEnv,cwd:string){
    this.child=spawn(command,args,{env,cwd,windowsHide:true,detached:process.platform!=='win32',stdio:'pipe'});
    this.closed=new Promise(resolve=>{this.child.once('close',()=>resolve());this.child.once('error',()=>resolve());});
    this.child.stdin.on('error',e=>this.connectionClosed(e));
    createInterface({input:this.child.stdout}).on('line',line=>{try{const msg=JSON.parse(line);if(msg.id!==undefined&&this.pending.has(msg.id)){const p=this.pending.get(msg.id)!;clearTimeout(p.timer);this.pending.delete(msg.id);msg.error?p.reject(new AppServerResponseError(msg.error)):p.resolve(msg.result);}else if(msg.id!==undefined&&msg.method){this.child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'后台执行不支持交互确认'}})+'\n');}else if(msg.method)this.onEvent(msg);}catch(e){this.onClose(new Error(`App Server 协议错误：${e}`));}});
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
  const required=stage==='analysis'?['read_runtime_release','read_production_task']:['read_runtime_release','read_production_task','synthesize_speech_batch','assemble_sentence_audio','verify_sentence_audio','prepare_review','assign_review_work','submit_review','read_review','render_template'];
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
  // 插件可能在线程创建后异步注入；仅本会话关闭自动发现，阶段技能与显式 MCP 仍正常加载。
  const probe=new AppServerClient(executable,['app-server','-c','web_search="disabled"','-c','features.apps=false','-c','features.plugins=false'],env,root);let baseline:any;
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

/** 新宿主使用分页历史；不依赖已经弃用的 includeTurns 全量读取。 */
export async function readThreadTurns(client:Pick<AppServerClient,'call'>,threadId:string,itemsView:'full'|'notLoaded'='full'){
  const turns:any[]=[];let cursor:string|undefined;
  do{const page=await client.call('thread/turns/list',{threadId,itemsView,limit:100,sortDirection:'asc',...(cursor?{cursor}:{})});if(!Array.isArray(page.data))throw new ProductionError('CODEX_RESULT_UNKNOWN','宿主轮次历史结构未知',503);turns.push(...page.data);cursor=page.nextCursor??undefined;}while(cursor);
  return turns;
}
/** 无幂等键的 turn/start 只能认领唯一新增轮次，零个或多个都不猜。 */
export function resolveStartedTurn(turns:any[],priorIds:string[]){
  const added=turns.filter(t=>!priorIds.includes(t.id));
  if(added.length!==1)throw new ProductionError('CODEX_RESULT_UNKNOWN','原启动意图尚无唯一轮次，禁止重发',503);
  return added[0];
}
export function completedTurnResult(turn:any){
  if(turn?.status!=='completed')throw new ProductionError('CODEX_RESULT_UNKNOWN','原轮次没有确定完成，保留句柄核查',503);
  const item=[...(turn.items??[])].reverse().find((i:any)=>i.type==='agentMessage');
  if(!item?.text)throw new ProductionError('CODEX_RESULT_UNKNOWN','原轮次缺少完整输出，禁止重放',503);
  return modelTurnOutputSchema.parse(JSON.parse(item.text)).result;
}
export async function executeCodex(run:Run,root:string,repo:ProductionRepository,config:ProductionConfig,signal:AbortSignal,media?:MediaRuntime){
  const env:NodeJS.ProcessEnv={...process.env,CODEX_HOME:config.codexHome,TEXTVIDEO_RUNTIME_URL:`http://${config.host}:${config.port}`,TEXTVIDEO_RUN_ID:run.runId,TEXTVIDEO_RUN_TOKEN:run.token!,TEXTVIDEO_PLUGIN_ROOT:config.pluginRoot};
  delete env.DOUBAO_API_KEY;delete env.CALLBACK_SECRET;delete env.TEXTVIDEO_API_TOKEN;delete env.DOUBAO_VOICES_FILE;
  const log=join(root,'logs','codex-events.jsonl');await fs.mkdir(join(root,'logs'),{recursive:true});
  const observer=new ToolObserver(),usage=new CodexUsageObserver();
  const knownThreads=new Map<string,{threadId:string;cwd?:string;parentThreadId?:string;source:string}>();
  const discoveryPending=new Set<string>(),discoveryVerified=new Set<string>();
  for(const id of run.checkpoint.codex?.threadIds??[])knownThreads.set(id,{threadId:id,source:'checkpoint'});
  if(await fs.stat(log).catch(()=>null))for await(const line of createInterface({input:createReadStream(log),crlfDelay:Infinity})){try{const event=JSON.parse(line);usage.observe(event);for(const t of threadDiscoveries(event))knownThreads.set(t.threadId,t);}catch{}}
  let eventWrites:Promise<unknown>=Promise.resolve(),discoveryChecks:Promise<unknown>=Promise.resolve();
  const stageSkills=await prepareStageSkills(run.stage,root,config.pluginRoot,config.codexExecutable,env);
  const client=new AppServerClient(config.codexExecutable,['app-server','-c','web_search="disabled"','-c','features.apps=false','-c','features.plugins=false','-c',skillConfigArgument(stageSkills)],env,root);
  client.child.stderr.on('data',data=>{observer.observeTransport(String(data));void fs.appendFile(join(root,'logs','codex-stderr.log'),data).catch(()=>{});});
  let threadId=run.checkpoint.codex?.threadId as string|undefined,turnId=run.checkpoint.codex?.turnId as string|undefined;
  let receiver:ReturnType<typeof createTurnReceiver>|undefined,connectionError:Error|undefined;
  const sessionAbort=new AbortController(),activeSignal=AbortSignal.any([signal,sessionAbort.signal]);
  const controller=new ExecutionController(run,repo,media,activeSignal,30000,root);
  const saveDiagnostics=()=>{try{repo.checkpoint(run.runId,run.token!,{stalledTools:observer.stalled(),transportDiagnostics:observer.transportDiagnostics(),threadDiagnostics:observer.threadDiagnostics()});}catch{}};
  const observeTimer=setInterval(saveDiagnostics,15000);
  client.onEvent=event=>{
    eventWrites=eventWrites.then(()=>fs.appendFile(log,JSON.stringify(event)+'\n')).catch(()=>{});usage.observe(event);observer.observe(event);receiver?.observe(event);
    for(const discovered of threadDiscoveries(event)){
      const isNew=!knownThreads.has(discovered.threadId);knownThreads.set(discovered.threadId,{...knownThreads.get(discovered.threadId),...discovered});
      if(isNew)repo.checkpoint(run.runId,run.token!,{codex:{threadIds:[...knownThreads.keys()]}});
      if(discoveryPending.has(discovered.threadId)||discoveryVerified.has(discovered.threadId))continue;discoveryPending.add(discovered.threadId);
      discoveryChecks=discoveryChecks.then(async()=>{
        // skills/list 仅证明 cwd 的发现目录；MCP 列表来自真实线程，二者分别留证。
        const metadata=discovered.cwd?null:await client.call('thread/read',{threadId:discovered.threadId,includeTurns:false});
        const cwd=discovered.cwd??metadata?.thread?.cwd;
        if(!cwd)throw new ProductionError('SKILL_DISCOVERY_INVALID','子线程缺少可核对的实际目录',503);
        const listed=await client.call('skills/list',{cwds:[cwd],forceReload:true});
        const tools=await client.call('mcpServerStatus/list',{threadId:discovered.threadId,detail:'toolsAndAuthOnly'});
        const record={...discovered,cwd,skills:listed,tools,scope:'实际 cwd 发现与线程 MCP；正文读取以事件日志为准',roleDirectoryIsolationVerified:false};
        await fs.appendFile(join(root,'logs','thread-skill-discovery.jsonl'),JSON.stringify(record)+'\n');verifyStageSkills(listed,stageSkills.paths);discoveryVerified.add(discovered.threadId);
      }).catch(async error=>{
        await fs.appendFile(join(root,'logs','thread-skill-discovery.jsonl'),JSON.stringify({...discovered,verified:false,error:String(error)})+'\n').catch(()=>{});
        // 只读证据暂缺保留诊断，后续线程通知再核对；已证明目录越界才中止。
        if(error instanceof ProductionError&&error.code==='STAGE_SKILLS_INVALID'){connectionError=error;receiver?.fail(error);sessionAbort.abort();}
      }).finally(()=>discoveryPending.delete(discovered.threadId));
    }
  };
  client.onClose=e=>{observer.observeTransport(e.message,'connection');saveDiagnostics();connectionError=new ProductionError('CODEX_RESULT_UNKNOWN',e.message,503);receiver?.fail(connectionError);sessionAbort.abort();};
  const abort=()=>{if(threadId&&turnId)void client.call('turn/interrupt',{threadId,turnId},5000).catch(()=>{});receiver?.fail(new ProductionError('PROCESS_CANCELLED','会话已取消'));};signal.addEventListener('abort',abort,{once:true});
  const ensureActive=()=>{if(connectionError)throw connectionError;if(signal.aborted)throw new ProductionError('PROCESS_CANCELLED','任务已取消');};
  const toolConfig={command:process.execPath,args:[join(config.pluginRoot,'scripts/production-mcp-launcher.mjs')],cwd:config.pluginRoot,env:{TEXTVIDEO_PLUGIN_ROOT:config.pluginRoot,TEXTVIDEO_DEPENDENCY_ROOT:config.dependencyRoot,TEXTVIDEO_RUNTIME_URL:env.TEXTVIDEO_RUNTIME_URL!,TEXTVIDEO_RUN_ID:run.runId,TEXTVIDEO_RUN_TOKEN:run.token!},startup_timeout_sec:60,tool_timeout_sec:180,default_tools_approval_mode:'approve'};
  const startParams:ThreadStartParams={cwd:root,approvalPolicy:'never',sandbox:'workspace-write',...(config.model?{model:config.model}:{}),config:{web_search:'disabled',features:{apps:false,plugins:false},skills:{config:stageSkills.overrides},...(process.platform==='win32'?{windows:{sandbox:'unelevated'}}:{}),mcp_servers:{'textvideo-studio':toolConfig}},developerInstructions:'这是已授权的隔离模板视频生产。只使用本 Run 阶段入口及工具。新作者通过当前完整稿与受管材料引用交接，不默认继承完整父历史；持续作者沿原线程接收真实差异。主协调只读运行合同，专业作者按职责读取完整方法。禁止读取凭据或访问其他任务。明确选定正式导出且无独立创作步骤时返回 await_runtime，成功由 Worker 直接交付原清单；分析结果以 final 交付。'};
  const runTurn=async(text:string,onStarted?:(id:string)=>void,firstTurn=false)=>{
    ensureActive();receiver=createTurnReceiver(threadId!);
    // 刚创建的线程尚未持久化首条消息，宿主不支持读取历史；恢复和续轮仍须实际核查。
    const priorIds=firstTurn?[]:(await readThreadTurns(client,threadId!,'notLoaded')).map(t=>t.id);
    // 外部启动不在数据库事务中；持久化意图并在响应未知时查询，绝不直接重发。
    repo.checkpoint(run.runId,run.token!,{codex:{startIntent:{priorIds,createdAt:Date.now()},threadId}});
    const params:TurnStartParams={threadId:threadId!,input:[{type:'text',text,text_elements:[]}],effort:'low',approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:[root],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false},outputSchema:JSON.parse(JSON.stringify(handoffSchema))};
    let response:any;
    try{response=await client.call('turn/start',params);}catch(error){
      if(error instanceof AppServerResponseError){repo.checkpoint(run.runId,run.token!,{codex:{startIntent:null}});throw new ProductionError('CODEX_REQUEST_REJECTED',`宿主明确拒绝轮次参数：${error.message}`);}
      const turns=await readThreadTurns(client,threadId!).catch(()=>[]);response={turn:resolveStartedTurn(turns,priorIds)};
    }
    turnId=response.turn.id;repo.checkpoint(run.runId,run.token!,{codex:{threadId,turnId,startIntent:null}});onStarted?.(turnId!);receiver.bind(turnId!);
    if(response.turn.status==='completed'){const result=completedTurnResult(response.turn);receiver=undefined;return result;}
    ensureActive();const result=await receiver.promise;receiver=undefined;return modelTurnOutputSchema.parse(JSON.parse(result.text)).result;
  };
  try{
    await client.init();ensureActive();
    const skills=await client.call('skills/list',{cwds:[root],forceReload:true}),skillEvidence=verifyStageSkills(skills,stageSkills.paths);
    await writeJson(join(root,'stage-discovery.json'),{stage:run.stage,configuration:stageSkills,skills,evidence:skillEvidence,recovery:!!threadId});
    let result:any,recoveredResume:Extract<RuntimeOutcome,{kind:'resume'}>|undefined;
    if(threadId){
      const turns=await readThreadTurns(client,threadId);const intent=run.checkpoint.codex?.startIntent;
      if(intent){turnId=resolveStartedTurn(turns,intent.priorIds).id;repo.checkpoint(run.runId,run.token!,{codex:{turnId,startIntent:null}});}
      const turn=turns.find(t=>t.id===turnId);result=completedTurnResult(turn);
      // 已确认最终输出可直接交给 Worker，不需要重启作者。
      if(result.kind==='final')return result;
      const waiting=run.checkpoint.runtimeWait;
      if(waiting?.state==='resuming'&&turnId!==waiting.originTurnId)controller.bind(waiting,turnId!);
      if(waiting?.state==='resuming'&&turnId===waiting.originTurnId){
        // 尚未持久化 startIntent 就中断，按写入顺序可证明还没有发 turn/start。
        if(intent||!repo.compareCheckpoint(run.runId,run.token!,'runtimeWait',waiting,{...waiting,state:'waiting_media'}))throw new ProductionError('CODEX_RESULT_UNKNOWN','续接意图不能安全恢复',503);
      }
      // 已完成主轮次明确选中了原正式作业；先接回媒体，不因作者树不可恢复阻断交付。
      const recovered=await controller.wait(threadId,turnId!,result);
      if(recovered?.kind==='handoff')return recovered.handoff;
      if(recovered?.kind==='resume')recoveredResume=recovered;
      // 宿主没有承诺恢复整棵作者运行树；只有确需继续创作时才要求核查。

      if([...knownThreads.keys()].some(id=>id!==threadId))throw new ProductionError('CODEX_RESULT_UNKNOWN','主线程历史可读，但原作者子线程恢复尚未验证；保留原作业和作者句柄',503);
      await client.call('thread/resume',{...startParams,threadId,excludeTurns:true});
    }else{
      if(run.checkpoint.codex?.threadStartIntent)throw new ProductionError('CODEX_RESULT_UNKNOWN','线程创建响应未知，禁止重复创建',503);
      repo.checkpoint(run.runId,run.token!,{codex:{threadStartIntent:true}});
      let started:any;try{started=await client.call('thread/start',startParams);}catch(e){if(e instanceof AppServerResponseError){repo.checkpoint(run.runId,run.token!,{codex:{threadStartIntent:false}});throw new ProductionError('CODEX_REQUEST_REJECTED',`宿主明确拒绝线程参数：${e.message}`);}throw new ProductionError('CODEX_RESULT_UNKNOWN',`线程创建响应未知：${e}`,503);}
      threadId=started.thread.id;repo.checkpoint(run.runId,run.token!,{codex:{threadId,threadStartIntent:false},instructionVersion:INSTRUCTION_VERSION});
      const statuses=await client.call('mcpServerStatus/list',{threadId,detail:'toolsAndAuthOnly'});await writeJson(join(root,'plugin-discovery.json'),{skills,statuses});verifyStageTools(statuses,run.stage);
      const runtime=await client.call('mcpServer/tool/call',{threadId,server:'textvideo-studio',tool:'read_runtime_release',arguments:{}});
      if(runtime?.isError)throw new ProductionError('PLUGIN_NOT_LOADED','后台 MCP 发行读取失败',503);
      if(!JSON.stringify(runtime).includes(config.release.releaseId))throw new ProductionError('RELEASE_MISMATCH','后台 MCP 与 Runtime 不同版',503);
      const instruction=taskInstruction(run,root,config.pluginRoot,config);await fs.writeFile(join(root,'codex-instruction.txt'),instruction);
      await writeJson(join(root,'plugin-evidence.json'),{release:config.release,skills,statuses,runtime,model:{requested:config.model??null,actual:started.model??started.thread?.model??null,reasoningEffort:'low'},codexVersion:await processFile(config.codexExecutable,['--version'])});
      result=await runTurn(instruction,undefined,true);
    }
    while(true){
      ensureActive();const parsed=turnResultSchema.parse(result);if(parsed.kind==='final'){await discoveryChecks;ensureActive();return parsed;}
      let next;
      try{next=recoveredResume??await controller.wait(threadId!,turnId!,parsed);recoveredResume=undefined;}catch(error){
        // 静帧等非正式导出不能进入媒体休眠；参数拒绝只纠正本轮，不取消仍在执行的原作业。
        if(error instanceof ProductionError&&error.code==='WAIT_JOB_INVALID'){
          result=await runTurn(`等待请求未执行：${error.message}。await_runtime 仅用于已受理的正式导出。请用 read_render_job 读取原编号 ${parsed.renderRequestId} 并继续当前阶段，不重新提交媒体，不把静帧等待当最终交付。`);continue;
        }
        throw error;
      }
      ensureActive();
      if(next!.kind==='handoff'){await discoveryChecks;ensureActive();return next!.handoff;}
      const resume=next!;result=await runTurn(resume.message,id=>controller.bind(resume.wait,id));
    }
  }catch(error){if(connectionError)throw connectionError;throw error;}
  finally{clearInterval(observeTimer);signal.removeEventListener('abort',abort);client.onClose=()=>{};await discoveryChecks;await client.close();await eventWrites;await writeJson(join(root,'logs','codex-usage.json'),usage.summary(log));}
}
