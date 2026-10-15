import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { analysisRequestSchema, renderRequestSchema, canonical, sha256, ProductionError, terminal, type Run, type Stage, type State, type RenderRequest } from './contracts.js';
import { webCallbackFields } from './web-contract.js';

export class ProductionRepository {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, external_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, result_version INTEGER NOT NULL DEFAULT 0, latest_success TEXT, UNIQUE(account_id,external_id));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), stage TEXT NOT NULL, input_digest TEXT NOT NULL, request TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, token TEXT, heartbeat INTEGER, checkpoint TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT, result_version INTEGER, created_at INTEGER NOT NULL, UNIQUE(account_id,task_id,stage,input_digest));
      CREATE TABLE IF NOT EXISTS callback_outbox (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, diagnostic TEXT);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), input_digest TEXT NOT NULL, source_digest TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS reviews_active_input ON reviews(run_id,input_digest) WHERE state='active';
      CREATE TABLE IF NOT EXISTS review_sessions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), review_id TEXT NOT NULL REFERENCES reviews(id), credential_digest TEXT NOT NULL UNIQUE, thread_id TEXT, state TEXT NOT NULL, diagnostic TEXT);
      CREATE TABLE IF NOT EXISTS review_work (id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id), ordinal INTEGER NOT NULL, state TEXT NOT NULL, session_id TEXT REFERENCES review_sessions(id), assignment_token TEXT UNIQUE, generation INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS review_one_active_work ON review_work(session_id) WHERE state='assigned';
      CREATE TABLE IF NOT EXISTS review_submissions (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES review_sessions(id), assignment_token TEXT NOT NULL, body_digest TEXT NOT NULL, body TEXT NOT NULL, response TEXT NOT NULL, accepted INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(session_id,assignment_token,body_digest));`);
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  private decode(row: any): Run { return { runId: row.id, requestId: row.request_id, accountId: row.account_id, taskKey: row.task_id, taskId: row.external_id,
    stage: row.stage, state: row.state, planVersion: row.version, inputDigest: row.input_digest, request: JSON.parse(row.request), token: row.token,
    heartbeat: row.heartbeat, checkpoint: JSON.parse(row.checkpoint), result: row.result ? JSON.parse(row.result) : null, error: row.error ? JSON.parse(row.error) : null,
    resultVersion: row.result_version, createdAt: row.created_at }; }
  get(id: string, accountId?: string): Run {
    const r = this.db.prepare('SELECT r.*, t.external_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?').get(id) as any;
    if (!r || (accountId && r.account_id !== accountId)) throw new ProductionError('RUN_NOT_FOUND', '执行不存在', 404); return this.decode(r);
  }
  list(accountId: string, taskId: string): Run[] { return (this.db.prepare('SELECT r.*,t.external_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.account_id=? AND t.external_id=? ORDER BY r.version').all(accountId,taskId) as any[]).map(r => this.decode(r)); }
  accept(accountId: string, stage: Stage, input: unknown): Run {
    const request = (stage === 'analysis' ? analysisRequestSchema : renderRequestSchema).parse(input);
    const serialized = canonical(request), inputDigest = sha256(canonical({ accountId, stage, request }));
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO tasks(id,account_id,external_id) VALUES(?,?,?)').run(randomUUID(),accountId,request.taskId);
      const task = this.db.prepare('SELECT * FROM tasks WHERE account_id=? AND external_id=?').get(accountId,request.taskId) as any;
      const old = this.db.prepare('SELECT id,request FROM runs WHERE account_id=? AND task_id=? AND stage=? AND input_digest=?').get(accountId,task.id,stage,inputDigest) as any;
      if (old) { if (old.request !== serialized) throw new ProductionError('INPUT_INTEGRITY_CONFLICT','输入摘要冲突',409); return this.get(old.id); }
      if (stage === 'render') {
        const r = request as RenderRequest;
        const base = this.db.prepare("SELECT * FROM runs WHERE task_id=? AND version=? AND stage='analysis' AND state='succeeded'").get(task.id,r.basePlanVersion) as any;
        if (!base) throw new ProductionError('BASE_ANALYSIS_INVALID','基础版本必须是本任务成功的 Analysis',409);
        if (r.baseRenderRunId) {
          const video = this.get(r.baseRenderRunId,accountId);
          if (video.taskKey !== task.id || video.stage !== 'render' || video.state !== 'succeeded' || (video.request as RenderRequest).basePlanVersion !== r.basePlanVersion)
            throw new ProductionError('BASE_RENDER_INVALID','基础成片必须属于同任务和同一 Analysis',409);
        }
      }
      const id = randomUUID();
      this.db.prepare('UPDATE tasks SET version=version+1 WHERE id=?').run(task.id);
      this.db.prepare("INSERT INTO runs(id,request_id,account_id,task_id,stage,input_digest,request,version,state,created_at) VALUES(?,?,?,?,?,?,?,?,'queued',?)").run(id,randomUUID(),accountId,task.id,stage,inputDigest,serialized,task.version+1,Date.now());
      return this.get(id);
    });
  }
  claim(): Run | null {
    return this.transaction(() => {
      // 同一任务未知状态也占用执行序位；不能以租约超时为由重复付费生成。
      const row = this.db.prepare(`SELECT r.id FROM runs r WHERE r.state='queued' AND NOT EXISTS (SELECT 1 FROM runs b WHERE b.task_id=r.task_id AND (b.state IN ('running','recovering','unknown','cancelling') OR (b.state='queued' AND b.version<r.version))) ORDER BY r.created_at,r.version LIMIT 1`).get() as any;
      if (!row) return null;
      this.db.prepare("UPDATE runs SET state='running', token=?,heartbeat=? WHERE id=?").run(randomUUID(),Date.now(),row.id); return this.get(row.id);
    });
  }
  checkpoint(id: string, token: string, patch: Record<string, any>) {
    return this.transaction(() => { const run = this.get(id); this.guard(run,token);
      const next={...run.checkpoint,...patch};
      // 会话和等待记录会被多个事件补充，心跳不得覆盖嵌套句柄。
      for(const key of ['codex','runtimeWait'])if(patch[key]&&typeof patch[key]==='object')next[key]={...run.checkpoint[key],...patch[key]};
      this.db.prepare('UPDATE runs SET checkpoint=?,heartbeat=? WHERE id=? AND token=?').run(JSON.stringify(next),Date.now(),id,token);
      return this.get(id);
    });
  }
  heartbeat(id:string,token:string){const run=this.get(id);this.guard(run,token);this.db.prepare('UPDATE runs SET heartbeat=? WHERE id=? AND token=?').run(Date.now(),id,token);}
  compareCheckpoint(id:string,token:string,key:string,expected:unknown,value:unknown):boolean{
    return this.transaction(()=>{const run=this.get(id);this.guard(run,token);
      if(canonical(run.checkpoint[key]??null)!==canonical(expected??null))return false;
      this.db.prepare('UPDATE runs SET checkpoint=?,heartbeat=? WHERE id=? AND token=?').run(JSON.stringify({...run.checkpoint,[key]:value}),Date.now(),id,token);return true;
    });
  }
  /** 等待与交接是同一提交点；取消或令牌变化不能穿过事务继续发布。 */
  handoffRuntime(id:string,token:string,expected:unknown,wait:unknown,handoff:unknown):boolean{
    return this.transaction(()=>{const run=this.get(id);this.guard(run,token);
      if(run.state==='cancelling')throw new ProductionError('PROCESS_CANCELLED','任务已取消，不保存交付');
      if(run.checkpoint.handoff||canonical(run.checkpoint.runtimeWait??null)!==canonical(expected??null))return false;
      this.db.prepare('UPDATE runs SET checkpoint=?,heartbeat=? WHERE id=? AND token=?').run(JSON.stringify({...run.checkpoint,runtimeWait:wait,handoff}),Date.now(),id,token);return true;
    });
  }
  guard(run: Run, token: string) { if (run.token !== token || terminal(run.state)) throw new ProductionError('EXECUTION_FENCED','执行令牌已失效',409); }
  finish(id: string, token: string | null, state: 'succeeded'|'failed'|'cancelled', result: any = null, error: any = null) {
    return this.transaction(() => {
      const run = this.get(id); if (terminal(run.state)) return run;
      if (run.token !== token) throw new ProductionError('EXECUTION_FENCED','执行令牌已失效',409);
      if(state==='succeeded'&&run.state==='cancelling')throw new ProductionError('PROCESS_CANCELLED','取消先于结果事务，不登记成功或成功回调');
      let resultVersion: number | null = null;
      if (state === 'succeeded' && run.stage === 'render') {
        this.db.prepare('UPDATE tasks SET result_version=result_version+1,latest_success=? WHERE id=?').run(id,run.taskKey);
        resultVersion = (this.db.prepare('SELECT result_version FROM tasks WHERE id=?').get(run.taskKey) as any).result_version;
      }
      this.db.prepare('UPDATE runs SET state=?,result=?,error=?,result_version=?,token=NULL WHERE id=?').run(state,JSON.stringify(result),JSON.stringify(error),resultVersion,id);
      const eventId = randomUUID();
      const analysis=run.stage==='analysis'?run:this.list(run.accountId,run.taskId).find(r=>r.stage==='analysis'&&r.planVersion===(run.request as RenderRequest).basePlanVersion);
      const body = JSON.stringify({ schemaVersion: 1, eventId, taskId: run.taskId, requestId: run.requestId, runId: id, stage: run.stage, state, planVersion: run.planVersion,
        ...webCallbackFields(run.stage,result,(analysis?.request as any)?.plugin?.customTemplateId??''),
        ...('basePlanVersion' in run.request ? { basePlanVersion:run.request.basePlanVersion, baseRenderRunId:run.request.baseRenderRunId } : {}), resultVersion, status:state==='succeeded'?0:1, data:result, error });
      this.db.prepare('INSERT INTO callback_outbox(id,run_id,body) VALUES(?,?,?)').run(eventId,id,body); return this.get(id);
    });
  }
  mark(id: string, token: string, state: State, error?: any) { const run=this.get(id); this.guard(run,token); this.db.prepare('UPDATE runs SET state=?,error=?,heartbeat=? WHERE id=? AND token=?').run(state,JSON.stringify(error??null),Date.now(),id,token); }
  cancel(id: string, accountId: string) { const run=this.get(id,accountId); if (terminal(run.state)) return run;
    if (run.state==='queued') return this.finish(id,null,'cancelled');
    this.db.prepare("UPDATE runs SET state='cancelling' WHERE id=?").run(id); return this.get(id);
  }
  unfinished(): Run[] { return (this.db.prepare("SELECT r.*,t.external_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.state IN ('running','recovering','unknown','cancelling')").all() as any[]).map(r=>this.decode(r)); }
  close() { this.db.close(); }
}
