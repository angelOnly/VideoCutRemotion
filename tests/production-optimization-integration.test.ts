import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderFrames,openBrowser} from '@remotion/renderer';
import {readOptimizationConfig} from '../packages/production-service/src/config.js';
import {sceneRangesFromTimeline,verifyCutTimeline} from '../packages/production-service/src/scene-cut-timeline.js';
import {processFile,writeJson,treeDigest} from '../packages/production-service/src/files.js';
import {sha256} from '../packages/production-service/src/contracts.js';
import {publishDelivery} from '../packages/production-service/src/delivery.js';
import {renderTemplate,retryRenderSlices,type MediaJob} from '../apps/render-worker/src/template-renderer.js';
import {type MediaSpanRecord} from '../packages/production-service/src/media-metrics.js';

test('新任务配置默认动画优化路径，拒绝拼错开关或无效预算',()=>{
 assert.deepEqual(readOptimizationConfig({}),{qaParallelReview:true,qaMaxReviewers:3,previewOnDemand:true,sceneCutMode:'accurate',mediaTiming:true,renderStrategy:'scene-chunks',mediaGlobalConcurrency:16,mediaRunConcurrency:2,mediaProcessConcurrency:4});
 assert.equal(readOptimizationConfig({TEXTVIDEO_SCENE_CUT_MODE:'hybrid',TEXTVIDEO_MEDIA_TIMING:'false'}).mediaTiming,false);
 for(const env of [{TEXTVIDEO_SCENE_CUT_MODE:'copy'},{TEXTVIDEO_QA_PARALLEL_REVIEW:'yes'},{TEXTVIDEO_QA_MAX_REVIEWERS:'4'},{TEXTVIDEO_QA_MAX_REVIEWERS:'0'},{TEXTVIDEO_PREVIEW_ON_DEMAND:''},{TEXTVIDEO_RENDER_STRATEGY:'invalid'},{TEXTVIDEO_MEDIA_GLOBAL_CONCURRENCY:'0'},{TEXTVIDEO_MEDIA_RUN_CONCURRENCY:'9'},{TEXTVIDEO_MEDIA_PROCESS_CONCURRENCY:'bad'}])assert.throws(()=>readOptimizationConfig(env));
});

test('33句TTS仍交付11镜，保留67帧片头片尾及句间停顿',()=>{
 const dataList=Array.from({length:11},(_,i)=>({id:`scene_${i}`,content:'甲乙丙'}));
 let from=0;
 const scenes=dataList.map((scene,index)=>{const lead=index===0?67:0,frames=lead+36;const value={id:scene.id,from,frames,utterances:[0,1,2].map(i=>({startFrame:lead+i*12,endFrameExclusive:lead+i*12+10}))};from+=frames;return value;});
 const timeline={fps:30,totalFrames:from+67,scenes,ending:{narrationEndFrame:from,outro:{frames:67}}};
 const ranges=sceneRangesFromTimeline(timeline,dataList,timeline.totalFrames,30);
 assert.equal(ranges.length,11);assert.equal(ranges[0].fromFrame,0);assert.equal(ranges.at(-1)?.toFrame,from+67);assert.equal(ranges[0].toFrame,103);
 assert.throws(()=>sceneRangesFromTimeline({...timeline,totalFrames:from+66},dataList,from+66,30),/片尾/);
 const changed=structuredClone(timeline);changed.scenes[1].utterances[0].endFrameExclusive=100;
 assert.throws(()=>sceneRangesFromTimeline(changed,dataList,timeline.totalFrames,30),/句段/);
 assert.throws(()=>sceneRangesFromTimeline(timeline,[...dataList].reverse(),timeline.totalFrames,30),/顺序/);
});

test('同版时间轴审计、混合切片失败续做、元数据复验和发布复制完整性闭环',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'optimization-integrated-')),runId='00000000-0000-4000-8000-000000000010';
 const project=join(root,'project'),renderer=join(project,'renderer');let draws=0;
 const records:MediaSpanRecord[]=[],files:any[]=[];
 try{
  await fs.mkdir(join(renderer,'public'),{recursive:true});
  await fs.writeFile(join(project,'说明.md'),'隔离集成夹具，不代表真实配音或专业审片');
  await fs.writeFile(join(renderer,'index.tsx'),'export {};');await fs.writeFile(join(renderer,'timeline.ts'),'export default {};');
  await writeJson(join(renderer,'renderer-manifest.json'),{schemaVersion:1,templateVersion:'fixture',instructions:['../说明.md'],entry:'index.tsx',timelineModule:'timeline.ts',wholeComposition:'Main',publicAssetRoot:'public',width:96,height:64,fps:30,voiceRefs:[]});
  const dataList=[{id:'a',content:'甲'},{id:'b',content:'乙'}];
  const timeline={fps:30,totalFrames:90,scenes:dataList.map((s,i)=>({id:s.id,from:i*45,frames:45,utterances:[{startFrame:0,endFrameExclusive:40}]}))};
  await writeJson(join(project,'timeline.json'),timeline);
  const input={runId,renderRequestId:'hybrid',timelineRef:'timeline.json',ranges:sceneRangesFromTimeline(timeline,dataList,90,30),checks:['仅隔离技术验证'],previewOnly:false};
  const digest=await treeDigest(project);
  const audioAudits={[digest]:{timelineSha256:sha256(JSON.stringify(timeline))}};
  await assert.rejects(verifyCutTimeline(root,project,'timeline.json',digest,'hybrid',dataList,90,30,input.ranges),/verify_sentence_audio/);
  await writeJson(join(root,'checks/sentence-audio-working.json'),{sourceDigest:digest,timelineSha256:sha256(JSON.stringify(timeline))});
  await verifyCutTimeline(root,project,'timeline.json',digest,'hybrid',dataList,90,30,input.ranges,audioAudits);
  await assert.rejects(verifyCutTimeline(root,project,'timeline.json','stale','hybrid',dataList,90,30,input.ranges),/verify_sentence_audio/);
  const source=join(root,'fixture.mp4');
  await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=30','-f','lavfi','-i','aevalsrc=0.2*sin(2*PI*(220*t+110*t*t)):s=48000','-t','3','-c:v','libx264','-threads:v','1','-g','60','-bf','3','-pix_fmt','yuv420p','-c:a','aac',source]);
  const run={stage:'render',state:'running',runId,taskId:'fixture',taskKey:runId,inputDigest:'input',checkpoint:{template:{digest:'template'}},request:{dataList}} as any;
  const job:MediaJob={id:'hybrid',runId,kind:'template-render',state:'failed',inputDigest:'fixture',input,sceneCutMode:'hybrid',readyFiles:files,readyFrames:[]};
  const metrics={runId,renderRequestId:'hybrid',onMetric:(record:MediaSpanRecord)=>{records.push(record);}};
  const options={dependencyRoot:process.cwd(),concurrency:1,sceneCutMode:'hybrid' as const,audioAudits,metrics,onSourceFrozen:async(d:string)=>{job.sourceDigest=d;},onFileReady:async(f:any)=>{files.push(f);}};
  const backend={renderFrames,openBrowser,bundle:async()=> 'isolated',selectComposition:async()=>({id:'Main',width:96,height:64,fps:30,durationInFrames:90,props:{},defaultProps:{}} as any),renderMedia:async(o:any)=>{draws++;await fs.copyFile(source,o.outputLocation);return {} as any;}};
  await assert.rejects(renderTemplate(run,root,input,{...options,onOutputStart:async id=>{if(id==='b')throw new Error('注入分镜失败');}},backend),/注入分镜失败/);
  assert.equal(draws,1);assert.deepEqual(files.map(f=>f.id),['whole-video','a']);
  const first=await fs.stat(files[1].file);
  for(const state of ['running','unknown','cancelled'] as const)await assert.rejects(retryRenderSlices(run,root,{...job,state},options),/明确失败/);
  // 模拟部署期间关闭灰度；原作业仍按自身保存的混合模式补缺片。
  const completed=await retryRenderSlices(run,root,job,{...options,sceneCutMode:'accurate'});
  assert.equal(draws,1);assert.equal((await fs.stat(files[1].file)).mtimeMs,first.mtimeMs);
  assert.deepEqual(completed.delivery.files.map(f=>f.id),['whole-video','a','b']);
  for(const stage of ['freeze_project','bundle','select_composition','render_media','video_ffprobe','video_full_decode','scene_slice','file_record_sha'])assert.ok(records.some(r=>r.stage===stage),stage);
  const tampered=structuredClone(completed.delivery);tampered.files[1].cutMetadata!.startDeviationMs=999;
  await assert.rejects(publishDelivery(run,root,join(root,'tampered'),'http://localhost/media',tampered),/切片实测记录/);
  const result=await publishDelivery(run,root,join(root,'task'),'http://localhost/media',completed.delivery,undefined,metrics);
  assert.equal(result.dataList.length,3);assert.equal(result.dataList[1].dur,completed.delivery.files[1].dur);assert.ok(result.dataList[1].extraData.cutMetadata);
  const bytes=await fs.readFile(files[1].file);let checked=0;
  await assert.rejects(publishDelivery(run,root,join(root,'changed'),'http://localhost/media',completed.delivery,undefined,{...metrics,onMetric:async r=>{if(r.stage==='publication_media_validation'&&++checked===3)await fs.appendFile(files[1].file,'模拟校验后被替换');}}),/发布副本/);
  assert.equal(await fs.stat(join(root,'changed/results',runId)).catch(()=>null),null);
  await fs.writeFile(files[1].file,bytes);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
