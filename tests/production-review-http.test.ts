import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {PNG} from 'pngjs';
import {createProductionServer} from '../apps/server/src/production/routes.js';
import {ProductionRepository} from '../packages/production-service/src/repository.js';
import {ReviewService} from '../packages/production-service/src/review-service.js';
import type {ProductionConfig} from '../packages/production-service/src/config.js';
import {sha256,type Run} from '../packages/production-service/src/contracts.js';
import {treeDigest,writeJson} from '../packages/production-service/src/files.js';

function running(repo:ProductionRepository,taskId:string){
 repo.accept('test','analysis',{taskId,content:'甲乙',otherRequirements:'',plugin:{customTemplateId:'test'}});const analysis=repo.claim()!;repo.finish(analysis.runId,analysis.token,'succeeded',{});
 repo.accept('test','render',{taskId,basePlanVersion:analysis.planVersion,otherRequirements:'',dataList:[{id:'s0',content:'甲'},{id:'s1',content:'乙'}]});return repo.claim()!;
}
async function prepare(service:ReviewService,run:Run,id='preview',modified=false){
 const root=service.runRoot(run),project=join(root,'preview-snapshots',id,'project'),renderer=join(project,'renderer');
 await fs.mkdir(join(renderer,'public'),{recursive:true});await fs.writeFile(join(project,'说明.md'),'隔离权限测试');await fs.writeFile(join(renderer,'index.tsx'),'// 隔离夹具');await fs.writeFile(join(renderer,'timeline.ts'),'export default {};');
 await writeJson(join(renderer,'renderer-manifest.json'),{schemaVersion:1,templateVersion:'test',instructions:['../说明.md'],entry:'index.tsx',timelineModule:'timeline.ts',wholeComposition:'Main',publicAssetRoot:'public',width:64,height:64,fps:24});
 await writeJson(join(project,'timeline.json'),{fps:24,totalFrames:12,scenes:[0,1].map(i=>({id:`s${i}`,from:i*6,frames:6,utterances:[{id:`u${i}`,startFrame:0,endFrameExclusive:6}],captions:[{utteranceId:`u${i}`,startFrame:0,endFrameExclusive:6,text:(i?'乙':'甲')+(modified?'\n':'')}]}))});
 const readyFrames=[];for(const frame of [0,6]){const path=join(root,`${id}-${frame}.png`),png=new PNG({width:64,height:64});png.data.fill(modified?128:255);const bytes=PNG.sync.write(png);await fs.writeFile(path,bytes);readyFrames.push({frame,path,sha256:sha256(bytes)});}
 await writeJson(join(root,'render-jobs',`${id}.json`),{id,runId:run.runId,kind:'frame-preview',state:'succeeded',sourceDigest:await treeDigest(project),input:{previewOnly:true},readyFrames,readyFiles:[]});
 return service.prepare(run,{renderRequestIds:[id],phase:'pre_export',timelineRef:'timeline.json',units:[0,1].map(i=>({unitId:`unit-${i}`,sceneIds:[`s${i}`],checks:[{checkId:'meaning',purpose:'场面关系',mode:'image',evidence:[{renderRequestId:id,frame:i*6}]}]}))});
}

test('HTTP 仅主 Run 凭证可登记审片，不接受旧审片凭证或跨任务分派',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'review-http-'))),config={dataRoot:root,apiToken:'isolated-token',accountId:'test',callbackBase:'http://localhost',callbackSecret:'isolated-secret',release:{},ready:{},codexExecutable:'/no-model-process'} as unknown as ProductionConfig;
 const service=await createProductionServer(config);
 try{
  const run=running(service.repo,'one'),plan=await prepare(service.reviews,run);
  const call=(name:string,payload:Record<string,unknown>={},headers:Record<string,string>={'x-run-id':run.runId,'x-run-token':run.token!})=>service.app.inject({method:'POST',url:`/internal/tools/${name}`,headers,payload});
  assert.notEqual((await call('read_review',{reviewId:plan.reviewId},{'x-run-id':run.runId,'x-review-token':'old'})).statusCode,200);
  assert.equal(service.repo.db.prepare('SELECT COUNT(*) AS n FROM review_sessions').get()?.n,0);
  const body={reviewId:plan.reviewId,unitId:'unit-0',reviewerAgentId:'native-agent',assignmentRequestId:'first'};
  const assigned=await call('assign_review_work',body);assert.equal(assigned.statusCode,200);const work=assigned.json();assert.equal(work.provenance,'coordinator_reported');
  assert.deepEqual((await call('assign_review_work',body)).json(),work);
  const otherRun=running(service.repo,'two'),otherPlan=await prepare(service.reviews,otherRun);
  assert.notEqual((await call('assign_review_work',{...body,reviewId:otherPlan.reviewId})).statusCode,200);
  assert.notEqual((await call('read_review',{reviewId:plan.reviewId},{'x-run-id':otherRun.runId,'x-run-token':run.token!})).statusCode,200);
  const evidence=work.evidence[0],submission={reviewId:plan.reviewId,assignmentToken:work.assignmentToken,observations:[{checkId:'meaning',evidenceId:evidence.evidenceId,note:'隔离 HTTP 观察夹具'}],issues:[],status:'complete'};
  await fs.writeFile(evidence.path,'tampered');assert.notEqual((await call('submit_review',submission)).statusCode,200);
  assert.equal(service.repo.db.prepare('SELECT COUNT(*) AS n FROM review_submissions').get()?.n,0);
  assert.equal((await call('read_review',{reviewId:plan.reviewId})).json().observationCount,0);
 }finally{await service.close();await fs.rm(root,{recursive:true,force:true});}
});

test('两个独立进程显式分派和提交，重启读回与幂等不丢观察',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'review-processes-'))),database=join(root,'tasks.sqlite'),repo=new ProductionRepository(database),service=new ReviewService(repo,()=>root);
 const children:ReturnType<typeof spawn>[]=[];
 try{
  const run=running(repo,'parallel'),plan=await prepare(service,run);
  const sessions=[0,1].map(i=>({unitId:`unit-${i}`,reviewerAgentId:`native-${i}`,assignmentRequestId:`assign-${i}`}));
  // 子进程只跑协议夹具；每个进程单独连接同一隔离数据库，以 IPC 同时放行事务。
  const source=`
    import assert from 'node:assert/strict';
    import {ProductionRepository} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'packages/production-service/src/repository.ts')).href)};
    import {ReviewService} from ${JSON.stringify(pathToFileURL(join(process.cwd(),'packages/production-service/src/review-service.ts')).href)};
    let repo,service,input,work;
    process.on('message',message=>{try{
      if(message.action==='init'){input=message;repo=new ProductionRepository(input.database);service=new ReviewService(repo,()=>input.root);process.send({event:'ready'});}
      if(message.action==='claim'){work=service.assign(input.runId,input.assignment);const again=service.assign(input.runId,input.assignment);if(again.assignmentToken!==work.assignmentToken)throw new Error('重复领取改变分派');process.send({event:'claimed',token:work.assignmentToken,unitId:work.unitId});}
      if(message.action==='submit'){const observations=work.checks.flatMap(check=>check.evidenceIds.map(evidenceId=>({checkId:check.checkId,evidenceId,note:'隔离子进程协议观察'})));const body={reviewId:work.reviewId,assignmentToken:work.assignmentToken,observations,issues:[],status:'complete'};const result=service.submit(input.runId,body);const replay=service.submit(input.runId,body);assert.equal(result.status,'complete');assert.deepEqual(replay,result);repo.close();process.send({event:'submitted'});process.disconnect();}
    }catch(error){process.send({event:'failure',message:String(error)});process.exit(1);}});
  `;
  const clients=sessions.map(session=>{
   const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{cwd:process.cwd(),stdio:['ignore','pipe','pipe','ipc']});children.push(child);
   let stderr='';child.stderr?.on('data',chunk=>{stderr+=chunk;});
   const wait=(event:string)=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error(`子进程 ${event} 超时：${stderr}`));},15000);
    const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('error',failed);child.off('exit',exited);};
    const failed=(error:unknown)=>{cleanup();reject(error);},exited=(code:number|null)=>failed(new Error(`子进程提前退出 ${code}：${stderr}`));
    const message=(data:any)=>{if(data.event==='failure')failed(new Error(data.message));else if(data.event===event){cleanup();resolve(data);}};
    child.on('message',message);child.once('error',failed);child.once('exit',exited);
   });
   const ready=wait('ready');child.send({action:'init',database,root,runId:run.runId,assignment:{...session,reviewId:plan.reviewId}});return {child,wait,ready};
  });
  await Promise.all(clients.map(c=>c.ready));const claims=clients.map(c=>c.wait('claimed'));clients.forEach(c=>c.child.send({action:'claim'}));const assigned=await Promise.all(claims);
  assert.equal(new Set(assigned.map(a=>a.token)).size,2);assert.equal(new Set(assigned.map(a=>a.unitId)).size,2);
  const submitted=clients.map(c=>c.wait('submitted'));clients.forEach(c=>c.child.send({action:'submit'}));await Promise.all(submitted);
  assert.equal(service.read(run.runId,plan.reviewId).remaining,0);
  const works=repo.db.prepare('SELECT data FROM review_work WHERE review_id=?').all(plan.reviewId) as Array<{data:string}>;
  assert.equal(works.length,2);assert.ok(works.every(w=>JSON.parse(w.data).observations.length===1));
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM review_submissions').get()?.n,2);
 }finally{for(const child of children)if(child.exitCode===null)child.kill();repo.close();await fs.rm(root,{recursive:true,force:true});}
});
