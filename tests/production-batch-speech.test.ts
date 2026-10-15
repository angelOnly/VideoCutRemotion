import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type ServerResponse } from 'node:http';
import { ProductionRepository } from '../packages/production-service/src/repository.js';
import { DoubaoService } from '../packages/speech-services/src/doubao.js';
import { verifySentenceAudio } from '../packages/production-service/src/sentence-audio.js';
import { writeJson, json } from '../packages/production-service/src/files.js';
import { sha256 } from '../packages/production-service/src/contracts.js';

const until=async(check:()=>boolean)=>{for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('等待本地模拟任务超时');};
function audio(text:string){
  const data=Buffer.alloc(44+4800);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(24000,24);data.writeUInt32LE(48000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(4800,40);
  const value=parseInt(sha256(text).slice(0,4),16)%30000;for(let i=44;i<data.length;i+=2)data.writeInt16LE(value,i);return data;
}
async function fixture(options:{concurrency?:number;perRunConcurrency?:number;signalFor?:(id:string)=>AbortSignal|undefined}={}){
  const root=await fs.mkdtemp(join(tmpdir(),'vfc-batch-')),repo=new ProductionRepository(join(root,'tasks.sqlite')),voices=join(root,'voices.json');await writeJson(voices,{female:{speaker:'test'}});
  const requests:{text:string;res:ServerResponse}[]=[];let immediate=false,active=0,peak=0;const activeByRun=new Map<string,number>(),peakByRun=new Map<string,number>();
  const send=(item:{text:string;res:ServerResponse})=>item.res.end(JSON.stringify({code:0,data:audio(item.text).toString('base64')})+JSON.stringify({code:20000000}));
  const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const text=JSON.parse(raw).req_params.text,id=text.split('-')[0];requests.push({text,res});active++;peak=Math.max(peak,active);activeByRun.set(id,(activeByRun.get(id)??0)+1);peakByRun.set(id,Math.max(peakByRun.get(id)??0,activeByRun.get(id)!));res.on('finish',()=>{active--;activeByRun.set(id,activeByRun.get(id)!-1);});if(immediate)send(requests.at(-1)!);});
  await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
  const endpoint=`http://127.0.0.1:${(provider.address() as any).port}`,speech=new DoubaoService(repo,root,voices,'test',endpoint,options);
  const run=(id:string,count=6)=>{const segments=Array.from({length:count},(_,i)=>({speechRequestId:`q${i}`,segmentId:`u${i}`,sceneId:'s1',text:`${id}-${i}。`,voiceRef:'female',speed:0}));const a=repo.accept('a','analysis',{taskId:id,content:segments.map(s=>s.text).join(''),otherRequirements:'',plugin:{customTemplateId:'3'}}),ac=repo.claim()!;repo.finish(a.runId,ac.token,'succeeded',{});const r=repo.accept('a','render',{taskId:id,basePlanVersion:1,otherRequirements:'',dataList:[{id:'s1',content:segments.map(s=>s.text).join('')}]});const claimed=repo.claim()!;repo.checkpoint(claimed.runId,claimed.token!,{template:{manifest:{voiceRefs:['female']}}});return {run:repo.get(r.runId),input:{runId:r.runId,speechBatchRequestId:'batch',segments}};};
  return {root,repo,speech,voices,endpoint,requests,run,send,peak:()=>peak,peakByRun,release(){immediate=true;for(const item of [...requests].reverse())if(!item.res.writableEnded)send(item);},async close(){speech.stop();this.release();await speech.drain();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));repo.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('批量配音：四批各五条、全局二十、乱序回传按原句段匹配，整批防重及冲突前置',async()=>{
  const f=await fixture();try{
    const tasks=['A','B','C','D'].map(id=>f.run(id));
    for(const task of tasks)await f.speech.submitBatch(task.input,'a');
    await until(()=>f.requests.length===20);assert.equal(f.peak(),20);assert.deepEqual([...f.peakByRun.values()],[5,5,5,5]);
    const single=await f.speech.submit({...tasks[3].input.segments[0],runId:tasks[3].run.runId,speechRequestId:'single',segmentId:'single',text:'D-局部。'},'a');assert.equal(single.state,'queued');assert.equal(f.requests.length,20);
    const duplicate=await Promise.all(Array.from({length:4},()=>f.speech.submitBatch(tasks[0].input,'a')));assert.ok(duplicate.every(b=>b.jobs[0].id===duplicate[0].jobs[0].id));assert.equal(f.requests.length,20);
    await assert.rejects(f.speech.submitBatch({...tasks[0].input,segments:tasks[0].input.segments.map((s,i)=>i? s:{...s,text:'改稿'})},'a'),/不可更改/);
    await assert.rejects(f.speech.submitBatch({...tasks[0].input,speechBatchRequestId:'invalid',segments:[{...tasks[0].input.segments[0],speechRequestId:'new'}, {...tasks[0].input.segments[1],voiceRef:'missing'}]},'a'),/未声明/);
    assert.equal(f.repo.get(tasks[0].run.runId).checkpoint.speech.new,undefined);
    f.release();await f.speech.drain();assert.equal(f.requests.length,25);assert.equal(f.peak(),20);assert.equal((await f.speech.read(single.id,tasks[3].run.runId,'a')).state,'succeeded');
    for(const task of tasks){const result=await f.speech.readBatch('batch',task.run.runId,'a');assert.equal(result.state,'succeeded');assert.deepEqual(result.jobs.map(j=>j.request.segmentId),task.input.segments.map(s=>s.segmentId));for(const job of result.jobs)assert.equal(job.sha256,sha256(audio(job.request.text)));}
  }finally{await f.close();}
});

test('配音公平分配：后来小批次参与下一空位；取消仅清除所属待派发段',async()=>{
  const f=await fixture({concurrency:2,perRunConcurrency:2});try{
    const a=f.run('A',8),b=f.run('B',1);await f.speech.submitBatch(a.input,'a');await until(()=>f.requests.length===2);await f.speech.submitBatch(b.input,'a');
    f.send(f.requests[0]);await until(()=>f.requests.length===3);f.send(f.requests[1]);await until(()=>f.requests.length===4);assert.ok(f.requests.slice(2,4).some(r=>r.text.startsWith('B-')));
    f.speech.cancelQueued(a.run.runId);f.release();await f.speech.drain(b.run.runId);await f.speech.drain(a.run.runId);
    assert.equal((await f.speech.readBatch('batch',b.run.runId,'a')).state,'succeeded');assert.ok((await f.speech.readBatch('batch',a.run.runId,'a')).counts.cancelled>0);assert.equal(f.requests.length,4);
  }finally{await f.close();}
});

test('供应商未知跨重启保留原编号及额度，待发请求不突破限额、不自动收费重放',async()=>{
  const f=await fixture({concurrency:1,perRunConcurrency:1});let restored:DoubaoService|undefined;
  try{const a=f.run('A',1);const original=await f.speech.submitBatch(a.input,'a');await until(()=>f.requests.length===1);
    await assert.rejects(f.speech.retryValidation(original.jobs[0].id,a.run.runId,'a'),/只能恢复/);
    f.requests[0].res.destroy();await f.speech.drain();assert.equal((await f.speech.readBatch('batch',a.run.runId,'a')).state,'unknown');
    restored=new DoubaoService(f.repo,f.root,f.voices,'test',f.endpoint,{concurrency:1,perRunConcurrency:1});await restored.recover();const again=await restored.submitBatch(a.input,'a');assert.equal(again.jobs[0].id,original.jobs[0].id);assert.equal(again.unknownReservations,1);
    const b=f.run('B',1);await restored.submitBatch(b.input,'a');await new Promise(r=>setImmediate(r));assert.equal(f.requests.length,1);assert.equal((await restored.readBatch('batch',b.run.runId,'a')).jobs[0].state,'queued');
  }finally{restored?.stop();await restored?.drain();await f.close();}
});

test('音频已收妥后本地检查失败与改名后中断：仅恢复检查，供应商调用不增加',async()=>{
  let signal:AbortSignal|undefined=AbortSignal.abort();const f=await fixture({signalFor:()=>signal});try{
    const a=f.run('A',1);f.release();const batch=await f.speech.submitBatch(a.input,'a');await f.speech.drain();const job=await f.speech.read(batch.jobs[0].id,a.run.runId,'a');assert.equal(job.state,'validation_failed');assert.equal(job.providerComplete,true);assert.ok(await fs.stat(job.receivedAudioRef));
    signal=undefined;await f.speech.retryValidation(job.id,a.run.runId,'a');await f.speech.drain();assert.equal((await f.speech.read(job.id,a.run.runId,'a')).state,'succeeded');assert.equal(f.requests.length,1);
    const path=join(f.root,'tasks',a.run.taskKey,'runs',a.run.runId,'speech',`${job.id}.json`),stored=await json(path);await writeJson(path,{...stored,state:'validating'});
    assert.equal((await f.speech.read(job.id,a.run.runId,'a')).state,'validation_failed');await f.speech.retryValidation(job.id,a.run.runId,'a');await f.speech.drain();assert.equal((await f.speech.read(job.id,a.run.runId,'a')).state,'succeeded');assert.equal(f.requests.length,1);
  }finally{await f.close();}
});

test('固定句段审计：真实 PCM、正文和原音频绑定；错时序、错字幕和越界文件拒绝',async()=>{
  const f=await fixture();try{
    const a=f.run('A',1);f.release();await f.speech.submitBatch(a.input,'a');await f.speech.drain();const job=(await f.speech.readBatch('batch',a.run.runId,'a')).jobs[0];
    const root=join(f.root,'tasks',a.run.taskKey,'runs',a.run.runId),project=join(root,'project'),pub=join(project,'renderer/public');await fs.mkdir(pub,{recursive:true});await fs.writeFile(join(project,'说明.md'),'测试');await fs.writeFile(join(project,'renderer/src.ts'),'export {};');await fs.copyFile(job.audioRef,join(pub,'voice.mp3'));
    await writeJson(join(project,'renderer/renderer-manifest.json'),{schemaVersion:1,templateVersion:'test',instructions:['../说明.md'],entry:'src.ts',wholeComposition:'Test',timelineModule:'timeline.json',publicAssetRoot:'public',width:320,height:180,fps:30,voiceRefs:['female']});
    const utterance={id:'u0',text:a.input.segments[0].text,src:'voice.mp3',startFrame:0,endFrameExclusive:3},caption={utteranceId:'u0',text:utterance.text,startFrame:0,endFrameExclusive:3};
    const timeline={fps:30,totalFrames:3,scenes:[{id:'s1',from:0,frames:3,utterances:[utterance],captions:[caption]}]},timelinePath=join(project,'renderer/timeline.json'),input={timelineRef:'renderer/timeline.json',speechBatchRequestIds:['batch']};await writeJson(timelinePath,timeline);
    const firstAudit=await verifySentenceAudio(a.run,root,input,f.speech);assert.equal(firstAudit.scenes[0].sentenceCount,1);assert.equal(firstAudit.measurementHits,1);
    await fs.appendFile(join(project,'renderer/src.ts'),'// 仅视觉修改');const secondAudit=await verifySentenceAudio(a.run,root,input,f.speech);assert.notEqual(secondAudit.sourceDigest,firstAudit.sourceDigest);assert.equal(secondAudit.measurementHits,1);assert.equal(secondAudit.measurementMisses,0);
    timeline.scenes[0].captions[0].text='错误';await writeJson(timelinePath,timeline);await assert.rejects(verifySentenceAudio(a.run,root,input,f.speech),/字幕.*不一致/);caption.text=utterance.text;
    utterance.endFrameExclusive=10;caption.endFrameExclusive=10;timeline.scenes[0].frames=10;timeline.totalFrames=10;await writeJson(timelinePath,timeline);await assert.rejects(verifySentenceAudio(a.run,root,input,f.speech),/实际.*不符/);
    utterance.src=job.audioRef;await writeJson(timelinePath,timeline);await assert.rejects(verifySentenceAudio(a.run,root,input,f.speech),/相对路径/);
    utterance.src='voice.mp3';await fs.writeFile(join(pub,'voice.mp3'),audio('其他台词'));await writeJson(timelinePath,timeline);await assert.rejects(verifySentenceAudio(a.run,root,input,f.speech),/真实音频/);
  }finally{await f.close();}
});

test('PCM凭据首次写入、重复复用、旧记录并发补测与取消；字节变化不静默采用',async()=>{
 const f=await fixture();try{
  const a=f.run('A',1);f.release();await f.speech.submitBatch(a.input,'a');await f.speech.drain();const job=(await f.speech.readBatch('batch',a.run.runId,'a')).jobs[0];
  assert.equal(job.pcmMeasurement.audioSha256,job.sha256);assert.equal(job.pcmMeasurement.sampleCount,4800);assert.ok(job.pcmMeasurement.decoderId.length===64);
  const hit=await f.speech.measurement(job.id,a.run.runId,'a');assert.equal(hit.reused,true);assert.deepEqual(hit.measurement,job.pcmMeasurement);
  const path=join(f.root,'tasks',a.run.taskKey,'runs',a.run.runId,'speech',`${job.id}.json`),old=await json(path);delete old.pcmMeasurement;await writeJson(path,old);
  const concurrent=await Promise.all(Array.from({length:8},()=>f.speech.measurement(job.id,a.run.runId,'a')));assert.ok(concurrent.every(value=>value===concurrent[0]));assert.equal(concurrent[0].reused,false);assert.equal((await f.speech.measurement(job.id,a.run.runId,'a')).reused,true);assert.equal(f.requests.length,1);
  await writeJson(path,old);await assert.rejects(f.speech.measurement(job.id,a.run.runId,'a',AbortSignal.abort()),/取消/);assert.equal((await json(path)).pcmMeasurement,undefined);
  await fs.writeFile(job.audioRef,audio('另一份字节'));await assert.rejects(f.speech.measurement(job.id,a.run.runId,'a'),/字节与登记摘要不符/);assert.equal((await json(path)).pcmMeasurement,undefined);assert.equal(f.requests.length,1);
 }finally{await f.close();}
});
