import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createProductionServer } from '../apps/server/src/production/routes.js';
import type { ProductionConfig } from '../packages/production-service/src/config.js';
import { processFile,writeJson,treeDigest,json } from '../packages/production-service/src/files.js';
import { canonical, sha256 } from '../packages/production-service/src/contracts.js';
import { extractZip } from '../packages/production-service/src/template-package.js';
import { ExecutionController } from '../packages/production-service/src/execution-controller.js';
import { publishDelivery } from '../packages/production-service/src/delivery.js';
test('T01/T08/T10/T11/T12/T20/T23/T25/T29：真实 API、ZIP、发布及指定版本修改闭环',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'vfc-http-')),template=join(root,'template');await fs.mkdir(join(template,'renderer/public'),{recursive:true});
  await fs.writeFile(join(template,'说明.md'),'此文件是协议测试模板，不是真实创作结果。');await fs.writeFile(join(template,'renderer/src.ts'),'export {};');await fs.writeFile(join(template,'renderer/timeline.json'),'{}');
  await fs.writeFile(join(template,'文字合同.md'),'逐字保留正文、顺序、数字、英文及换行。');
  await writeJson(join(template,'renderer/renderer-manifest.json'),{schemaVersion:1,templateVersion:'1',analysisInstructions:['../文字合同.md'],instructions:['../说明.md'],entry:'src.ts',wholeComposition:'Test',timelineModule:'timeline.json',publicAssetRoot:'public',width:320,height:180,fps:30,voiceRefs:[]});
  const zip=join(root,'template.zip');await processFile('python',['-c',"import pathlib,zipfile,sys; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w'); [z.write(f,f.relative_to(p).as_posix() + ('/' if f.is_dir() else '')) for f in p.rglob('*')]; z.close()",template,zip]);
  const media=join(root,'stub.mp4'),wholeMedia=join(root,'whole.mp4');
  // 接口测试只验证文件与回调，使用 FFmpeg 内建编码器生成隔离小样。
  for(const [path,duration] of [[media,1],[wholeMedia,2]] as const)await processFile('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=blue:s=320x180:r=30:d=${duration}`,'-f','lavfi','-i',`sine=frequency=440:duration=${duration}`,'-c:v','mpeg4','-c:a','aac','-shortest',path]);
  let downloads=0;const callbacks:any[]=[];const platform=createServer(async(req,res)=>{if(req.url?.endsWith('/package')){downloads++;res.end(await fs.readFile(zip));}else {let body='';for await(const chunk of req)body+=chunk;callbacks.push({url:req.url,body:JSON.parse(body)});res.end('{"status":0}');}});await new Promise<void>(r=>platform.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(platform.address() as any).port}`,config={dataRoot:join(root,'data'),apiToken:'test',accountId:'a',templateBase:base,callbackBase:base,callbackSecret:'secret',mediaBase:'http://local/media',release:{releaseId:'release-test'},ready:{codex:true,tts:true,dependencies:true},searchEnabled:false} as ProductionConfig;let calls=0;
  const service=await createProductionServer(config,async(run,runRoot)=>{calls++;const path=join(runRoot,run.stage==='analysis'?'result.json':'delivery.json');let result:any;
    if(run.stage==='analysis'){
      assert.equal((await json(join(runRoot,'result-schema.json'))).properties.context.type,'string');
      const input=await json(join(runRoot,'input.json'));
      assert.equal(input.template.templateVersion,run.checkpoint.template.manifest.templateVersion);
      assert.equal(input.template.analysisInstructions[0].text,'逐字保留正文、顺序、数字、英文及换行。');
      assert.equal(input.template.root,undefined);assert.equal(input.template.manifest,undefined);assert.equal(input.projectRoot,undefined);
      assert.ok(!JSON.stringify(input).includes('src.ts'));
    }
    if(run.stage==='analysis')result={taskId:run.taskId,runId:run.runId,inputDigest:run.inputDigest,dataList:[{id:'s1',content:'第一段。',dur:1,durationSource:'estimated'},{id:'s2',content:'第二段。',dur:1,durationSource:'estimated'}],context:'已读测试模板；执行器为 stub。'};
    else{
      const prepared=await json(join(runRoot,'input.json'));
      assert.equal(prepared.analysisInput.content,'第一段。第二段。');assert.equal(prepared.analysis.dataList[0].content,'第一段。');assert.deepEqual(prepared.request,run.request);
      const scenes=(run.request as any).dataList;
      const timeline={fps:30,totalFrames:60,scenes:scenes.map((s:any,i:number)=>({id:s.id,from:i*30,frames:30,utterances:[{id:`u${i}`,text:s.content,startFrame:0,endFrameExclusive:30}],captions:[{text:s.content,startFrame:0,endFrameExclusive:30}]}))};
      await writeJson(join(runRoot,'project/renderer/timeline.json'),timeline);
      await fs.copyFile(media,join(runRoot,'stub.mp4'));await fs.copyFile(wholeMedia,join(runRoot,'whole.mp4'));
      await fs.cp(join(runRoot,'project'),join(runRoot,'render-snapshots','test-render','project'),{recursive:true});
      result={taskId:run.taskId,runId:run.runId,inputDigest:run.inputDigest,templateDigest:run.checkpoint.template.digest,renderRequestId:'test-render',sourceDigest:await treeDigest(join(runRoot,'project')),timelineRef:'renderer/timeline.json',checks:['未进行连续观看与听审；隔离协议测试'],files:[{id:'whole-video',content:scenes.map((s:any)=>s.content).join('')},...scenes].map((s:any,i:number)=>({...s,file:join(runRoot,i===0?'whole.mp4':'stub.mp4'),sha256:'',dur:i===0?2:1,fromFrame:i===0?0:(i-1)*30,toFrame:i===0?60:i*30,width:320,height:180,fps:30}))};
      for(const f of result.files)f.sha256=sha256(await fs.readFile(f.file));
      const input={timelineRef:result.timelineRef,previewOnly:false,checks:result.checks};
      await writeJson(join(runRoot,'render-jobs/test-render.json'),{id:'test-render',runId:run.runId,kind:'template-render',state:'succeeded',attempt:1,releaseId:config.release.releaseId,sourceDigest:result.sourceDigest,input,inputDigest:sha256(canonical({kind:'template-render',input})),deliveryPath:path,readyFrames:[],readyFiles:result.files});
      // 未建立听审计划也应正常发布；技术文件仍由真实 Worker 核验。
      await fs.writeFile(join(runRoot,'project','post-render-review.md'),'导出后记录，不改变渲染快照。');
    }
    await writeJson(path,result);
    if(run.stage==='render'){const direct=await new ExecutionController(run,service.repo,service.runner.mediaRuntime,new AbortController().signal,5,runRoot).wait('main','selected-final',{kind:'await_runtime',renderRequestId:'test-render'});assert.equal(direct?.kind,'handoff');if(direct?.kind==='handoff')return direct.handoff;}
    return {taskId:run.taskId,runId:run.runId,inputDigest:run.inputDigest,resultPath:path};});
  const post=(path:string,body:any)=>service.app.inject({method:'POST',url:path,headers:{authorization:'Bearer test'},payload:body});
  const aPath='/narrate/ai_video_director/getAiVideoEditingAnalysisData',rPath='/narrate/ai_video_director/getAiVideoEditingData',input={taskId:'t',content:'第一段。第二段。',otherRequirements:'',plugin:{customTemplateId:'3'}};
  try{
    const health=(await service.app.inject({url:'/healthz'})).json();assert.equal(health.configurationReady,true);assert.equal(health.productionReady,null);
    const accepted=await post(aPath,input);assert.equal(accepted.statusCode,202);const a=accepted.json().data;await service.runner.tick();await service.runner.drain();assert.equal(service.repo.get(a.runId).state,'succeeded',JSON.stringify(service.repo.get(a.runId).error));assert.equal(downloads,1);
    const repeated=await Promise.all(Array.from({length:8},()=>post(aPath,input)));assert.ok(repeated.every(r=>r.json().data.runId===a.runId));assert.equal(calls,1);
    const originalTemplate=service.repo.get(a.runId).checkpoint.template.digest;
    assert.equal(service.repo.get(a.runId).checkpoint.analysisBasis.templateDigest,originalTemplate);
    assert.equal(service.repo.get(a.runId).checkpoint.analysisBasis.analysisContractDigest,service.repo.get(a.runId).checkpoint.template.analysisContract.digest);
    const manifestPath=join(template,'renderer/renderer-manifest.json');await writeJson(manifestPath,{...await json(manifestPath),templateVersion:'2'});
    await processFile('python',['-c',"import pathlib,zipfile,sys; p=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w'); [z.write(f,f.relative_to(p).as_posix() + ('/' if f.is_dir() else '')) for f in p.rglob('*')]; z.close()",template,zip]);
    const request={taskId:'t',basePlanVersion:a.planVersion,otherRequirements:'新要求',dataList:[{id:'s2',content:'编辑后的第二段。'},{id:'s1',content:'第一段。'}]};
    const r=(await post(rPath,request)).json().data;await service.runner.tick();await service.runner.drain();const rendered=service.repo.get(r.runId);assert.equal(rendered.state,'succeeded',JSON.stringify(rendered.error));assert.equal(rendered.resultVersion,1);assert.equal(downloads,1);assert.equal(rendered.result.dataList.length,3);
    assert.equal(rendered.result.templateDigest,originalTemplate);
    assert.match(rendered.result.checks[0],/未进行连续观看与听审/);
    assert.equal((service.repo.db.prepare('SELECT count(*) AS n FROM reviews WHERE run_id=?').get(r.runId) as any).n,0);
    await service.callbacks.tick();
    assert.equal((service.repo.db.prepare('SELECT state FROM callback_outbox WHERE run_id=?').get(r.runId) as any).state,'delivered');
    assert.ok(callbacks.some(c=>c.url.endsWith('getAiVideoEditingDataCallback')));
    const runRoot=service.runner.runRoot(rendered),raw=await json(join(runRoot,'delivery.json'));
    const publish=(value:unknown)=>publishDelivery(rendered,runRoot,join(config.dataRoot,'tasks',rendered.taskKey),config.mediaBase,value);
    await assert.rejects(publish({...raw,inputDigest:'错误输入摘要'}),/交付身份/);
    await assert.rejects(publish({...raw,files:raw.files.slice(1)}),/数量、正文或顺序/);
    await assert.rejects(publish({...raw,files:raw.files.map((f:any,i:number)=>i===1?{...f,content:'篡改正文'}:f)}),/数量、正文或顺序/);
    await assert.rejects(publish({...raw,files:raw.files.map((f:any,i:number)=>i===1?{...f,sha256:'错误文件摘要'}:f)}),/视频摘要不符/);
    const url=`/media/${rendered.taskKey}/${rendered.runId}/0.mp4`;
    assert.equal((await service.app.inject({url,method:'HEAD'})).statusCode,200);const partial=await service.app.inject({url,headers:{range:'bytes=0-99'}});assert.equal(partial.statusCode,206);assert.equal(partial.rawPayload.length,100);assert.equal((await service.app.inject({url,headers:{range:'bytes=999999999-'}})).statusCode,416);assert.notEqual((await service.app.inject({url:`/media/${rendered.taskKey}/${rendered.runId}/publication.json`})).statusCode,200);
    const revision=(await post(rPath,{...request,baseRenderRunId:r.runId,revisionInstructions:'仅改图形'})).json().data;const oldDigest=rendered.result.sourceDigest;await service.runner.tick();await service.runner.drain();assert.equal(service.repo.get(revision.runId).resultVersion,2);assert.equal(await treeDigest(join(service.runner.runRoot(rendered),'source-snapshot')),oldDigest);assert.equal(calls,3);
    // 发布失败只恢复既有交付，不再次执行创作或配音。
    const publishFailure=(await post(rPath,{...request,otherRequirements:'发布故障验收'})).json().data;
    const blockedStaging=join(config.dataRoot,'tasks',rendered.taskKey,'results',`${publishFailure.runId}.staging`);
    await fs.writeFile(blockedStaging,'用普通文件模拟发布目录不可写');
    await service.runner.tick();await service.runner.drain();assert.equal(service.repo.get(publishFailure.runId).state,'recovering');assert.equal(calls,4);
    // 模拟转交前中断；即便原作者树不可恢复，原成功作业仍由服务直接接回。
    const pending=service.repo.get(publishFailure.runId);service.repo.checkpoint(pending.runId,pending.token!,{handoff:null,runtimeWait:{state:'waiting_media'},codex:{threadId:'original-main',threadIds:['original-main','original-author']}});
    await fs.unlink(blockedStaging);await service.runner.recover();await service.runner.drain();assert.equal(service.repo.get(publishFailure.runId).state,'succeeded');assert.equal(calls,4);assert.equal((service.repo.db.prepare('SELECT count(*) AS n FROM callback_outbox WHERE run_id=?').get(publishFailure.runId) as any).n,1);

    // 模拟文件发布后、结果事务前中断，恢复时核对原目录而非重新制作。
    const crash=(await post(rPath,{...request,otherRequirements:'发布后登记故障验收'})).json().data;
    const finish=service.repo.finish.bind(service.repo);let crashOnce=true;
    service.repo.finish=(id,token,state,result,error)=>{if(id===crash.runId&&state==='succeeded'&&crashOnce){crashOnce=false;throw new Error('模拟发布后登记中断');}return finish(id,token,state,result,error);};
    await service.runner.tick();await service.runner.drain();assert.equal(service.repo.get(crash.runId).state,'recovering');assert.equal(calls,5);
    const publishedFile=join(config.dataRoot,'tasks',rendered.taskKey,'results',crash.runId,'0.mp4'),before=await fs.stat(publishedFile);
    await service.runner.recover();await service.runner.drain();assert.equal(service.repo.get(crash.runId).state,'succeeded');assert.equal(calls,5);assert.equal((await fs.stat(publishedFile)).mtimeMs,before.mtimeMs);
    assert.equal(service.repo.get(r.runId).resultVersion,1);
    const tokenRun=service.repo.accept('a','analysis',{...input,content:'另一稿'}),claim=service.repo.claim()!;assert.equal(claim.runId,tokenRun.runId);
    const denied=await service.app.inject({method:'POST',url:'/internal/tools/render_template',headers:{'x-run-id':claim.runId,'x-run-token':claim.token!},payload:{renderRequestId:'test',timelineRef:'x',ranges:[{id:'s1',fromFrame:0,toFrame:1}],checks:[]}});assert.equal(denied.statusCode,403);assert.match(denied.body,/ANALYSIS_TOOL_FORBIDDEN/);
    service.repo.finish(claim.runId,claim.token,'cancelled');
    await fs.rename(join(service.runner.runRoot(rendered),'source-snapshot'),join(service.runner.runRoot(rendered),'missing-snapshot'));
    const broken=(await post(rPath,{...request,baseRenderRunId:r.runId,revisionInstructions:'另一修改'})).json().data;await service.runner.tick();await service.runner.drain();assert.equal(service.repo.get(broken.runId).error.code,'BASE_PROJECT_UNAVAILABLE');assert.equal((await service.app.inject({url})).statusCode,200);
    const newer=(await post(aPath,{...input,taskId:'new-template-task'})).json().data;await service.runner.tick();await service.runner.drain();assert.equal(service.repo.get(newer.runId).state,'succeeded');assert.equal(downloads,2);assert.notEqual(service.repo.get(newer.runId).checkpoint.template.digest,originalTemplate);
    assert.equal((await post(aPath,input)).json().data.runId,a.runId);assert.equal(downloads,2);
  }finally{await service.close();await new Promise<void>(r=>platform.close(()=>r()));}
});
test('T09：ZIP 越界和损坏归档拒绝',async()=>{const root=await fs.mkdtemp(join(tmpdir(),'vfc-zip-')),zip=join(root,'bad.zip');await processFile('python',['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('../escape.txt','bad');z.close()",zip]);await assert.rejects(extractZip(zip,join(root,'out')));assert.equal(await fs.stat(join(root,'escape.txt')).catch(()=>null),null);await fs.writeFile(zip,'bad');await assert.rejects(extractZip(zip,join(root,'out2')));});
