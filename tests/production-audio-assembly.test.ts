import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assembleSentenceAudio,audioFrames} from '../packages/production-service/src/sentence-audio-assembly.js';
import {json,writeJson,type PcmMeasurement} from '../packages/production-service/src/files.js';
import {sha256} from '../packages/production-service/src/contracts.js';
import {registerProductionTools} from '../apps/server/src/production/speech-tools.js';
import {sentenceAssemblyPlanJsonSchema} from '../packages/production-service/src/sentence-audio-assembly.js';

const measure=(count:number,hash='a'.repeat(64)):PcmMeasurement=>({ruleVersion:'mono-48000-s16le/1',decoderId:'fixture',audioSha256:hash,sampleFormat:'s16le',sampleRate:48000,channels:1,sampleCount:count,duration:count/48000});
async function fixture(){
 const root=await fs.mkdtemp(join(tmpdir(),'audio-assembly-')),project=join(root,'project'),pub=join(project,'renderer/public');await fs.mkdir(pub,{recursive:true});
 await fs.writeFile(join(project,'renderer/index.ts'),'export {};');await fs.writeFile(join(project,'renderer/instructions.md'),'隔离测试');
 await fs.writeFile(join(pub,'intro.mp4'),'片头');await fs.writeFile(join(pub,'outro.mp4'),'片尾');
 await writeJson(join(project,'renderer/renderer-manifest.json'),{schemaVersion:1,templateVersion:'test',instructions:['instructions.md'],entry:'index.ts',wholeComposition:'Test',timelineModule:'index.ts',timelineDataRef:'timeline.json',timelineContract:'sentence-timeline/1',publicAssetRoot:'public',width:320,height:180,fps:30});
 const utterances=[{id:'u1',text:'甲。',src:'old1.mp3',startFrame:4,endFrameExclusive:7},{id:'u2',text:'乙。',src:'old2.mp3',startFrame:9,endFrameExclusive:12}];
 const timeline:any={fps:30,totalFrames:17,chapters:[{id:'c',from:4,endFrameExclusive:15,title:'保持视觉时钟'}],scenes:[{id:'s',from:0,frames:15,intro:{src:'intro.mp4',frames:4,fromFrame:0},utterances,captions:utterances.map(u=>({utteranceId:u.id,text:u.text,startFrame:u.startFrame,endFrameExclusive:u.endFrameExclusive})),visualBlocks:[{from:6,event:'不要缩放'}]}],ending:{narrationEndFrame:15,outro:{src:'outro.mp4',frames:2}},bgm:[],sfx:[]};
 const timelinePath=join(project,'renderer/timeline.json');await writeJson(timelinePath,timeline);
 const planPath=join(project,'plan.json');await writeJson(planPath,{scenes:[{sceneId:'s',utterances:[{id:'u1'},{id:'u2',captionText:'乙。'}]}]});
 const jobs:any[]=[];for(const [i,u]of utterances.entries()){const bytes=Buffer.from(`音频${i}`),audioRef=join(root,`voice${i}.mp3`);await fs.writeFile(audioRef,bytes);jobs.push({id:`job${i}`,state:'succeeded',audioRef,sha256:sha256(bytes),request:{segmentId:u.id,sceneId:'s',text:u.text}});}
 const speech:any={readBatch:async()=>({state:'succeeded',jobs:[...jobs].reverse()}),measurement:async(id:string)=>({measurement:measure(4800,jobs.find(j=>j.id===id).sha256),reused:true})};
 const run:any={runId:'isolated',accountId:'a',stage:'render',state:'running',request:{dataList:[{id:'s',content:'甲。乙。'}]}};
 const input={assemblyRequestId:'a1',speechBatchRequestIds:['batch'],planRef:'plan.json',expectedTimelineSha256:sha256(await fs.readFile(timelinePath))};
 return {root,project,pub,timeline,timelinePath,planPath,jobs,speech,run,input,close:()=>fs.rm(root,{recursive:true,force:true})};
}

test('音频整数帧取整只覆盖真实PCM，整数及分数fps边界可靠',()=>{assert.equal(audioFrames(measure(4800),30),3);assert.equal(audioFrames(measure(4801),30),4);assert.equal(audioFrames(measure(48048),30000/1001),30);});

test('工具发现提供同源计划结构，错误计划返回完整结构且不写入',async()=>{
 const tools=new Map<string,any>();registerProductionTools({registerTool:(name:string,config:any)=>tools.set(name,config)} as any,async()=>({}));
 const description=tools.get('assemble_sentence_audio').inputSchema.planRef.description;
 assert.deepEqual(JSON.parse(description.slice(description.indexOf('{'))),sentenceAssemblyPlanJsonSchema);
 const f=await fixture();try{
  await writeJson(f.planPath,{scenes:[{sceneId:'s',segments:[{segmentId:'u1'}]}]});
  await assert.rejects(assembleSentenceAudio(f.run,f.root,f.input,f.speech),(e:any)=>{
   assert.equal(e.code,'SENTENCE_ASSEMBLY_PLAN_INVALID');
   assert.deepEqual(JSON.parse(e.message.split('完整结构：')[1]),sentenceAssemblyPlanJsonSchema);return true;
  });
  assert.equal(sha256(await fs.readFile(f.timelinePath)),f.input.expectedTimelineSha256);
  assert.equal(await fs.stat(join(f.root,'audio-assemblies')).catch(()=>null),null);
 }finally{await f.close();}
});

test('窄装配按稳定ID重排，保留停顿、视觉、章节时钟和包装；同键重查不覆盖作者新稿',async()=>{
 const f=await fixture();try{
  const result=await assembleSentenceAudio(f.run,f.root,f.input,f.speech),out=await json(f.timelinePath);
  assert.equal(out.totalFrames,17);assert.deepEqual(out.chapters,f.timeline.chapters);assert.deepEqual(out.scenes[0].visualBlocks,f.timeline.scenes[0].visualBlocks);assert.deepEqual(out.scenes[0].intro,f.timeline.scenes[0].intro);assert.deepEqual(out.ending,f.timeline.ending);
  assert.deepEqual(out.scenes[0].utterances.map((u:any)=>[u.id,u.startFrame,u.endFrameExclusive]),[['u1',4,7],['u2',9,12]]);assert.deepEqual(result.timingChangedSceneIds,[]);
  const record=await json(result.detailsRef);assert.equal(record.measurementHits,2);assert.equal(record.copiedAudio,2);
  out.scenes[0].visualBlocks[0].event='作者新稿';await writeJson(f.timelinePath,out);assert.deepEqual(await assembleSentenceAudio(f.run,f.root,f.input,f.speech),result);assert.equal((await json(f.timelinePath)).scenes[0].visualBlocks[0].event,'作者新稿');
  await writeJson(f.planPath,{scenes:[{sceneId:'s',tailFrames:4}]});await assert.rejects(assembleSentenceAudio(f.run,f.root,f.input,f.speech),/不可改变输入/);
 }finally{await f.close();}
});

test('装配缺段、重号、正文、摘要、无依据分页和旧基线明确拒绝',async()=>{
 for(const mode of ['missing','duplicate','text','bytes','paging','baseline']){const f=await fixture();try{
  if(mode==='missing')f.jobs.pop();if(mode==='duplicate')f.jobs[1].request.segmentId='u1';if(mode==='text')f.jobs[0].request.text='改稿。';if(mode==='bytes')await fs.writeFile(f.jobs[0].audioRef,'被替换');
  if(mode==='paging'){await writeJson(join(f.pub,'timing.json'),{method:'proportional'});await writeJson(f.planPath,{scenes:[{sceneId:'s',captionTiming:{src:'timing.json',sha256:sha256(await fs.readFile(join(f.pub,'timing.json')))}}]});}
  if(mode==='baseline')await fs.appendFile(f.timelinePath,' ');
  await assert.rejects(assembleSentenceAudio(f.run,f.root,f.input,f.speech));assert.equal(await fs.stat(join(f.root,'audio-assemblies/a1.json')).catch(()=>null),null);
 }finally{await f.close();}}
});

test('可靠分页按绑定记录装配，音频时长变化报告范围且不拉伸动作',async()=>{
 const f=await fixture();try{
  const aligned={method:'reviewed_timestamps',utterances:{u1:{audioSha256:f.jobs[0].sha256,captions:[{text:'甲',startFrame:4,endFrameExclusive:6},{text:'。',startFrame:6,endFrameExclusive:8}]},u2:{audioSha256:f.jobs[1].sha256,captions:[{text:'乙。',startFrame:10,endFrameExclusive:13}]}}};
  await writeJson(join(f.pub,'timing.json'),aligned);await writeJson(f.planPath,{scenes:[{sceneId:'s',utterances:[{id:'u1'},{id:'u2'}],captionTiming:{src:'timing.json',sha256:sha256(await fs.readFile(join(f.pub,'timing.json')))}}]});
  f.speech.measurement=async(id:string)=>({measurement:measure(id==='job0'?6000:4800,f.jobs.find(j=>j.id===id).sha256),reused:true});
  const result=await assembleSentenceAudio(f.run,f.root,f.input,f.speech),out=await json(f.timelinePath);assert.deepEqual(result.timingChangedSceneIds,['s']);assert.equal(out.totalFrames,18);assert.equal(out.chapters[0].from,4);assert.equal(out.chapters[0].endFrameExclusive,16);assert.deepEqual(out.scenes[0].visualBlocks,f.timeline.scenes[0].visualBlocks);assert.equal(out.scenes[0].captions.length,3);
 }finally{await f.close();}
});

test('替换前后中断沿原记录恢复；冲突保留当前稿，不调用新的配音',async()=>{
 const f=await fixture();try{
  const result=await assembleSentenceAudio(f.run,f.root,f.input,f.speech),record=await json(result.detailsRef);record.state='committing';await writeJson(result.detailsRef,record);
  f.speech.readBatch=async()=>{throw Error('不应重读或重配')};assert.deepEqual(await assembleSentenceAudio(f.run,f.root,f.input,f.speech),result);
  await writeJson(result.detailsRef,record);await writeJson(f.timelinePath,f.timeline);assert.deepEqual(await assembleSentenceAudio(f.run,f.root,f.input,f.speech),result);assert.equal(sha256(await fs.readFile(f.timelinePath)),result.timelineSha256);
  await writeJson(result.detailsRef,record);await fs.appendFile(f.timelinePath,' ');await assert.rejects(assembleSentenceAudio(f.run,f.root,f.input,f.speech),/恢复遇到新稿/);
 }finally{await f.close();}
});


test('取消禁止初次写入及恢复提交；成功后计划已删除仍可查回原结果',async()=>{
 const f=await fixture();try{
  await assert.rejects(assembleSentenceAudio(f.run,f.root,f.input,f.speech,AbortSignal.abort()),/取消/);
  assert.equal(await fs.stat(join(f.root,'audio-assemblies')).catch(()=>null),null);assert.equal(await fs.stat(join(f.pub,'speech')).catch(()=>null),null);
  const result=await assembleSentenceAudio(f.run,f.root,f.input,f.speech),record=await json(result.detailsRef);await writeJson(result.detailsRef,{...record,state:'committing'});await writeJson(f.timelinePath,f.timeline);
  await assert.rejects(assembleSentenceAudio(f.run,f.root,f.input,f.speech,AbortSignal.abort()),/取消/);assert.equal(sha256(await fs.readFile(f.timelinePath)),f.input.expectedTimelineSha256);assert.equal((await json(result.detailsRef)).state,'committing');
  await assembleSentenceAudio(f.run,f.root,f.input,f.speech);await fs.unlink(f.planPath);assert.deepEqual(await assembleSentenceAudio(f.run,f.root,f.input,f.speech),result);
 }finally{await f.close();}
});
