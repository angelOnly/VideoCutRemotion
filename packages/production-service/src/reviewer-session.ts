import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { AppServerClient, discoveredSkills } from './codex-session.js';
import { ProductionError, type Run } from './contracts.js';
import type { ProductionConfig } from './config.js';
import type { ReviewService } from './review-service.js';
import { createTurnReceiver } from './turn-events.js';

type Reviewer={sessionId:string;threadId:string;busy:boolean};
type Pool={client:AppServerClient;reviewers:Reviewer[];starting:Promise<void>;turns:Map<string,{collect:(event:any)=>void;reject:(error:unknown)=>void}>;work:Set<Promise<void>>;closed:boolean;reviewId:string;stopping?:Promise<void>};
/** 每个 Run 复用审片连接；线程级 MCP 配置只携带自身审片凭证。 */
export class ReviewerSessions{
  private pools=new Map<string,Pool>();
  constructor(private service:ReviewService,private config:ProductionConfig,private signalFor:(runId:string)=>AbortSignal|undefined){}
  start(run:Run,reviewId:string){
    let pool=this.pools.get(run.runId);
    if(pool&&!pool.closed){pool.reviewId=reviewId;pool.starting=pool.starting.catch(()=>{}).then(()=>this.dispatch(run,reviewId,pool!)).catch(error=>this.diagnostic(pool!,error));return;}
    if(pool?.closed){void pool.stopping?.then(()=>this.start(run,reviewId));return;}
    this.service.recoverSessions(run.runId);
    const root=this.service.runRoot(run),env={...process.env,CODEX_HOME:this.config.codexHome};
    for(const key of ['TEXTVIDEO_RUN_TOKEN','TEXTVIDEO_REVIEW_TOKEN','DOUBAO_API_KEY','CALLBACK_SECRET','TEXTVIDEO_API_TOKEN','DOUBAO_VOICES_FILE'])delete (env as NodeJS.ProcessEnv)[key];
    const client=new AppServerClient(this.config.codexExecutable,['app-server','-c','web_search="disabled"','-c','features.apps=false','-c','features.plugins=false'],env,root);
    pool={client,reviewers:[],starting:Promise.resolve(),turns:new Map(),work:new Set(),closed:false,reviewId};this.pools.set(run.runId,pool);
    const current=pool;
    client.onEvent=event=>{const threadId=event.params?.threadId;current.turns.get(threadId)?.collect(event);};
    client.onClose=error=>{for(const turn of current.turns.values())turn.reject(error);if(!current.closed){this.diagnostic(current,error);void this.stop(run.runId);}};
    this.signalFor(run.runId)?.addEventListener('abort',()=>{void this.stop(run.runId);},{once:true});
    current.starting=(async()=>{await client.init();await this.dispatch(run,reviewId,current);})().catch(error=>{
      if(error instanceof ProductionError&&error.code==='REVIEW_SUPERSEDED'&&current.reviewId!==reviewId)return;
      this.diagnostic(current,error);void this.stop(run.runId);
    });
  }
  private diagnostic(pool:Pool,error:unknown){this.service.runtimeDiagnostic(pool.reviewId,String(error));for(const reviewer of pool.reviewers)this.service.sessionDiagnostic(reviewer.sessionId,String(error));}
  private async dispatch(run:Run,reviewId:string,pool:Pool){
    if(pool.closed||this.signalFor(run.runId)?.aborted)return;
    const root=this.service.runRoot(run),summary=this.service.read(run.runId,reviewId);
    if(summary.state!=='active'||!summary.remaining)return;
    // 仅占本 Runtime 的有界审片名额；审片线程禁止再分派，不借用桌面主任务的名额。
    const capacity=Math.min(summary.remaining,this.config.qaParallelReview===false?1:this.config.qaMaxReviewers??3);
    while(!pool.closed&&pool.reviewId===reviewId&&pool.reviewers.length<capacity){
      const session=this.service.createSession(run.runId,reviewId);
      try{
        const listed=await pool.client.call('skills/list',{cwds:[root],forceReload:true});
        const overrides=discoveredSkills(listed).flatMap(skill=>[{path:skill.path,enabled:skill.path.includes(`${root}/.agents/skills/`)&&/\/(quality-verification|captions|effect-timing|audio-finishing)\//.test(skill.path)}]);
        const toolConfig={command:process.execPath,args:[join(this.config.pluginRoot,'scripts/production-mcp-launcher.mjs')],cwd:this.config.pluginRoot,env:{TEXTVIDEO_PLUGIN_ROOT:this.config.pluginRoot,TEXTVIDEO_DEPENDENCY_ROOT:this.config.dependencyRoot,TEXTVIDEO_RUNTIME_URL:`http://${this.config.host}:${this.config.port}`,TEXTVIDEO_RUN_ID:run.runId,TEXTVIDEO_REVIEW_TOKEN:session.credential},startup_timeout_sec:60,tool_timeout_sec:180,default_tools_approval_mode:'approve'};
        const started=await pool.client.call('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only',...(this.config.model?{model:this.config.model}:{}),config:{web_search:'disabled',features:{apps:false,plugins:false},skills:{config:overrides},mcp_servers:{'textvideo-studio':toolConfig}},developerInstructions:'你是本 Run 的只读专业审片者。禁止创建子代理、修改文件、请求配音渲染或发布。按当前静帧检查包阅读专业方法并实际查看原尺寸图片；图片未读完或不可读时提交 partial，记录剩余图片。任务只检查图片，不因缺少连续看听能力停工，不声称已完成听审或连续观看。凭证由工具连接携带，不读取环境或其他任务。'});
        if(pool.closed)throw new ProductionError('PROCESS_CANCELLED','审片启动期间 Run 已停止');
        this.service.bindSession(session.id,started.thread.id);
        const reviewer={sessionId:session.id,threadId:started.thread.id,busy:false};pool.reviewers.push(reviewer);
        const status=await pool.client.call('mcpServerStatus/list',{threadId:reviewer.threadId,detail:'toolsAndAuthOnly'});
        const servers=Array.isArray(status?.data)?status.data:[status];
        const names=servers.flatMap((server:any)=>Object.entries(server?.tools??{}).map(([key,value])=>(value as any)?.name??key));
        if(['claim_review_work','submit_review','read_review'].some(name=>!names.includes(name))||names.some((name:string)=>['render_template','synthesize_speech','prepare_review'].includes(name)))throw new ProductionError('REVIEW_TOOLS_INVALID','审片线程没有获得隔离工具集合');
        // 配置文字不足以证明权限，真实越权 HTTP 请求必须被服务拒绝。
        const denied=await fetch(`http://${this.config.host}:${this.config.port}/internal/tools/render_template`,{method:'POST',headers:{'Content-Type':'application/json','X-Run-Id':run.runId,'X-Review-Token':session.credential},body:'{}',signal:AbortSignal.timeout(10000)});
        if(denied.status!==403)throw new ProductionError('REVIEW_AUTH_NOT_ISOLATED','真实越权调用未按合同拒绝');
        await fs.mkdir(join(root,'logs'),{recursive:true});
        await fs.appendFile(join(root,'logs','reviewer-discovery.jsonl'),JSON.stringify({threadId:reviewer.threadId,sessionId:session.id,skills:listed,overrides,status,deniedWriteStatus:denied.status,sandbox:started.sandbox??'requested_read_only',scope:'独立审片连接、线程级 MCP；内置宿主能力按实际发现记录'})+'\n');
      }catch(error){this.service.releaseSession(session.id,String(error));pool.reviewers=pool.reviewers.filter(r=>r.sessionId!==session.id);throw error;}
    }
    if(pool.closed||pool.reviewId!==reviewId)return;this.service.runtimeDiagnostic(reviewId,null);
    for(const reviewer of pool.reviewers)if(!reviewer.busy){
      reviewer.busy=true;
      const work=this.turn(run,reviewId,pool,reviewer).catch(error=>{this.service.releaseSession(reviewer.sessionId,String(error));pool.reviewers=pool.reviewers.filter(r=>r!==reviewer);}).finally(()=>{
        reviewer.busy=false;pool.turns.delete(reviewer.threadId);pool.work.delete(work);
        // 旧轮次收敛后续接真实新版；同版 partial 不自动反复调用模型。
        if(!pool.closed&&pool.reviewId!==reviewId)this.start(run,pool.reviewId);
      });pool.work.add(work);
    }
  }
  private async turn(run:Run,reviewId:string,pool:Pool,reviewer:Reviewer){
    const receiver=createTurnReceiver(reviewer.threadId);
    pool.turns.set(reviewer.threadId,{collect:receiver.observe,reject:error=>receiver.fail(error instanceof Error?error:new Error(String(error)))});
    const result=await pool.client.call('turn/start',{threadId:reviewer.threadId,input:[{type:'text',text:`当前审片计划 ${reviewId}。先 claim_review_work({})，按包读取专业方法和真实证据，使用 submit_review 保存观察。包内 context 是确认正文及章节语义；只对 remaining 指定范围补充真实观察。旧 pendingIssues 不能因本次 issues 为空自动关闭，实际复查对应证据后用 issueResolutions 明确 resolved 或 retained 并说明依据；旧帧已删除时指定新的 evidenceId。suggestion 保留可见但不强制返修。完成响应已有 next 时直接继续，直到 next 为空。图片材料不可读或尚未查看时保存 partial 后说明剩余范围；不能反复请求媒体或伪造观察。各区间是完整 Composition 的全局半开帧区间，媒体文件本地播放时间需减去 evidence.fromFrame。`,text_elements:[]}],approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},effort:'low'});
    receiver.bind(result.turn.id);await receiver.promise;
    const active=this.service.repo.db.prepare("SELECT id FROM review_work WHERE session_id=? AND state='assigned'").get(reviewer.sessionId);
    this.service.sessionDiagnostic(reviewer.sessionId,active?'审片轮次已结束，仍有未完成范围；读取 read_review 并继续读取剩余图片':null);
  }
  async stop(runId?:string){
    for(const [id,pool] of this.pools){if(runId&&id!==runId)continue;
      if(!pool.stopping){pool.closed=true;pool.stopping=(async()=>{
        for(const turn of pool.turns.values())turn.reject(new ProductionError('PROCESS_CANCELLED','审片会话已停止'));
        await pool.client.close();await pool.starting;await Promise.allSettled([...pool.work]);
        for(const reviewer of pool.reviewers)this.service.releaseSession(reviewer.sessionId,'Run 收尾或取消，撤销审片凭证');
        if(this.pools.get(id)===pool)this.pools.delete(id);
      })();}await pool.stopping;
    }
  }
}
