import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { ProductionRepository } from '../packages/production-service/src/repository.js';
import { DoubaoService } from '../packages/speech-services/src/doubao.js';
import { writeJson,processFile } from '../packages/production-service/src/files.js';
test('T17/T27/T28/T29：配音阶段限制、同键防重、完整性复用与未知结果不重发',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'vfc-speech-')),repo=new ProductionRepository(join(root,'tasks.sqlite')),voiceFile=join(root,'voices.json'),audio=join(root,'voice.mp3');await writeJson(voiceFile,{female:{speaker:'test-voice'}});await processFile('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.3','-c:a','libmp3lame',audio]);const bytes=await fs.readFile(audio);let calls=0,mode='ok';
  const provider=createServer(async(req,res)=>{for await(const _ of req){}calls++;if(mode==='lost'){res.destroy();return;}res.end(JSON.stringify({code:0,data:bytes.toString('base64')})+JSON.stringify({code:20000000}));});await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
  const speech=new DoubaoService(repo,root,voiceFile,'test-key',`http://127.0.0.1:${(provider.address() as any).port}`),a=repo.accept('a','analysis',{taskId:'t',content:'正文',otherRequirements:'',plugin:{customTemplateId:'3'}}),ac=repo.claim()!;
  const baseInput={speechRequestId:'voice-1',segmentId:'u1',text:'正文',voiceRef:'female',speed:0};
  try{
    await assert.rejects(speech.submit({...baseInput,runId:a.runId},'a'),/仅运行中的 Render/);repo.finish(a.runId,ac.token,'succeeded',{});
    const request={taskId:'t',basePlanVersion:1,otherRequirements:'',dataList:[{id:'s1',content:'正文'}]},r=repo.accept('a','render',request),c=repo.claim()!;repo.checkpoint(c.runId,c.token!,{template:{manifest:{voiceRefs:['female']}}});
    const first=await speech.submit({...baseInput,runId:r.runId},'a');await speech.drain();const ready=await speech.read(first.id,r.runId,'a');assert.equal(ready.state,'succeeded');assert.ok(ready.duration>0);assert.equal((await speech.submit({...baseInput,runId:r.runId},'a')).id,first.id);assert.equal(calls,1);await assert.rejects(speech.submit({...baseInput,runId:r.runId,text:'新文'},'a'),/同一配音键/);
    repo.finish(r.runId,c.token,'succeeded',{});const next=repo.accept('a','render',{...request,baseRenderRunId:r.runId,revisionInstructions:'只改图形'}),nc=repo.claim()!;repo.checkpoint(nc.runId,nc.token!,{template:{manifest:{voiceRefs:['female']}}});const reused=await speech.submit({...baseInput,runId:next.runId,reuseJobId:first.id},'a');assert.equal(reused.reusedFrom,first.id);assert.equal(calls,1);
    await assert.rejects(speech.submit({...baseInput,speechRequestId:'changed',runId:next.runId,reuseJobId:first.id,text:'更改正文'},'a'),/不一致/);
    mode='lost';const lost=await speech.submit({...baseInput,speechRequestId:'lost',runId:next.runId,text:'连接丢失'},'a');await speech.drain();assert.equal((await speech.read(lost.id,next.runId,'a')).state,'unknown');assert.equal((await speech.submit({...baseInput,speechRequestId:'lost',runId:next.runId,text:'连接丢失'},'a')).id,lost.id);assert.equal(calls,2);
    // 主制作失败后，确定成功的声音仍能显式复用；未知声音不能借复用重发。
    repo.finish(next.runId,nc.token,'failed');
    const retry=repo.accept('a','render',{...request,otherRequirements:'修复后的明确复测'}),rc=repo.claim()!;
    repo.checkpoint(rc.runId,rc.token!,{template:{manifest:{voiceRefs:['female']}}});
    const recovered=await speech.submit({...baseInput,runId:retry.runId,reuseRunId:next.runId,reuseJobId:reused.id},'a');
    assert.equal(recovered.reusedFromRunId,next.runId);assert.equal(recovered.state,'succeeded');assert.equal(calls,2);
    await assert.rejects(speech.submit({...baseInput,runId:retry.runId,speechRequestId:'unknown-reuse',text:'连接丢失',reuseRunId:next.runId,reuseJobId:lost.id},'a'),/不一致/);
    await assert.rejects(speech.submit({...baseInput,runId:retry.runId,speechRequestId:'wrong-stage',reuseRunId:a.runId,reuseJobId:first.id},'a'),/同任务的 Render/);
  }finally{await speech.drain();await new Promise<void>(r=>provider.close(()=>r()));repo.close();}
});
