import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {bundle} from '@remotion/bundler';
import {selectComposition,renderMedia,renderFrames,openBrowser} from '@remotion/renderer';
import {renderTemplate,retryRenderSlices,templateFrames,type MediaJob,type RenderOptions} from '../apps/render-worker/src/template-renderer.js';
import {cutSceneFromWhole} from '../apps/render-worker/src/template-slices.js';
import {frameSample,mapMediaLimited,checkContinuousPcmSource} from '../apps/render-worker/src/template-chunks.js';
import {processFile,writeJson,treeDigest,probe} from '../packages/production-service/src/files.js';
import {sha256} from '../packages/production-service/src/contracts.js';
import {MediaBudget} from '../packages/production-service/src/run-work.js';
const engine={bundle,selectComposition,renderMedia,renderFrames,openBrowser};
const runId='00000000-0000-4000-8000-000000000001';
const browser=process.env.TEST_BROWSER??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
const ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
async function fixture(root:string){
 const p=join(root,'project'),renderer=join(p,'renderer');await fs.mkdir(join(renderer,'public'),{recursive:true});
 await fs.writeFile(join(p,'说明.md'),'隔离媒体测试');await fs.writeFile(join(renderer,'timeline.ts'),'export default {};');
 await fs.writeFile(join(renderer,'index.tsx'),`import React from 'react';import {Composition,registerRoot,useCurrentFrame,AbsoluteFill,Audio,staticFile} from 'remotion';const Frame=()=>{const f=useCurrentFrame();return <AbsoluteFill style={{backgroundColor:f===0?'red':f<14?'lime':'blue'}}><div style={{position:'absolute',left:f,top:10,width:4,height:4,backgroundColor:'white'}}/><Audio src={staticFile('voice.wav')}/></AbsoluteFill>};registerRoot(()=> <Composition id="Main" component={Frame} width={64} height={64} fps={30} durationInFrames={37}/>);`);
 await processFile(ffmpeg,['-v','error','-f','lavfi','-i','aevalsrc=0.2*sin(2*PI*(220*t+110*t*t)):s=48000','-t','2','-c:a','pcm_s16le',join(renderer,'public/voice.wav')]);
 await writeJson(join(renderer,'renderer-manifest.json'),{schemaVersion:1,templateVersion:'test',instructions:['../说明.md'],entry:'index.tsx',timelineModule:'timeline.ts',wholeComposition:'Main',publicAssetRoot:'public',width:64,height:64,fps:30,voiceRefs:[]});
 const ranges=[{id:'a',fromFrame:0,toFrame:1},{id:'b',fromFrame:1,toFrame:14},{id:'c',fromFrame:14,toFrame:37}];
 const timeline={fps:30,totalFrames:37,scenes:ranges.map(r=>({id:r.id,from:r.fromFrame,frames:r.toFrame-r.fromFrame,utterances:[{startFrame:0,endFrameExclusive:r.toFrame-r.fromFrame}]}))};
 await writeJson(join(p,'timeline.json'),timeline);
 const sourceDigest=await treeDigest(p),timelineSha256=sha256(JSON.stringify(timeline));await writeJson(join(root,'checks/sentence-audio-working.json'),{sourceDigest,timelineSha256});
 const run={runId,taskId:'test',stage:'render',state:'running',inputDigest:'input',checkpoint:{template:{digest:'template'}},request:{dataList:ranges.map((r,i)=>({id:r.id,content:String(i)}))}} as any;
 return {run,ranges,audioAudits:{[sourceDigest]:{timelineSha256}},sourceDigest};
}
async function raw(path:string,audio=false){const chunks:Buffer[]=[];await processFile(ffmpeg,['-v','error','-i',path,...(audio?['-map','0:a:0','-ac','1','-ar','48000','-f','s16le']:['-map','0:v:0','-pix_fmt','rgb24','-f','rawvideo']),'-'],{captureOutput:false,onOutput:b=>chunks.push(b)});return Buffer.concat(chunks);}

test('有限队列乱序完成仍保序；失败停止新增并等待活动工作结束；全局样本没有累计误差',async()=>{
 let active=0,peak=0,finished=0;
 const result=await mapMediaLimited([30,2,1],2,async(t,i)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,t));active--;return i;});assert.deepEqual(result,[0,1,2]);assert.equal(peak,2);
 await assert.rejects(mapMediaLimited([0,1,2],2,async i=>{if(!i){await new Promise(r=>setTimeout(r,10));finished++;return;}throw new Error('明确失败');}),/明确失败/);assert.equal(finished,1);
 const fps=30000/1001,bounds=[0,1,14,37];assert.equal(bounds.slice(1).reduce((sum,b,i)=>sum+frameSample(b,fps)-frameSample(bounds[i],fps),0),frameSample(37,fps));
});

test('连续音轨未完成时两路画面同时派发；任一分支失败后停止新增并等待全部预算收口',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'scene-audio-scheduling-'));
 try{
  const {run,ranges,audioAudits}=await fixture(root);
  for(const failedUnit of ['audio','visual-0']){
   const budget=new MediaBudget(3,3),started:string[]=[],active=new Set<string>(),ready:string[]=[];
   const releases=new Map<string,()=>void>(),firstFailure=new Error(`注入${failedUnit}失败`);
   const gates=new Map(['audio','visual-0','visual-1','visual-14'].map(id=>[id,new Promise<void>(resolve=>releases.set(id,resolve))]));
   let allStarted!:()=>void;const startedThree=new Promise<void>(resolve=>{allStarted=resolve;});
   let settled=false,outcome:Promise<unknown>|undefined;
   const options:RenderOptions={dependencyRoot:process.cwd(),concurrency:1,runConcurrency:2,renderStrategy:'scene-chunks',audioAudits,budget,onFileReady:async f=>{ready.push(f.id);}};
   const backend={...engine,bundle:async()=> 'isolated',selectComposition:async()=>({id:'Main',width:64,height:64,fps:30,durationInFrames:37,props:{},defaultProps:{}} as any),renderMedia:async(o:any)=>{
    const id=o.codec==='wav'?'audio':`visual-${o.frameRange[0]}`;
    started.push(id);active.add(id);if(active.size===3)allStarted();
    try{await gates.get(id);throw id===failedUnit?firstFailure:new Error(`已收口${id}`);}finally{active.delete(id);}
   }};
   try{
    outcome=renderTemplate(run,root,{runId,renderRequestId:`schedule-${failedUnit}`,timelineRef:'timeline.json',ranges,checks:[],previewOnly:false},options,backend).then(()=>{settled=true;return new Error('失败作业不应交付');},error=>{settled=true;return error;});
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([startedThree,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(new Error('声音阻塞了第二路画面派发')),5000);})]);}finally{clearTimeout(timer);}
    assert.deepEqual(new Set(started),new Set(['audio','visual-0','visual-1']));
    assert.deepEqual(budget.active,{drawing:3,processes:3},'声音和两路画面都须领取现有预算');
    releases.get(failedUnit)!();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'不能在其他已启动任务结束前返回失败');
    assert.equal(started.length,3,'失败后不再派发第三段画面');
    assert.deepEqual(budget.active,{drawing:2,processes:2});
    const remaining=[...active];releases.get(remaining[0])!();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(settled,false);assert.deepEqual(budget.active,{drawing:1,processes:1});
    releases.get(remaining[1])!();assert.equal(await outcome,firstFailure);
    assert.equal(active.size,0);assert.deepEqual(budget.active,{drawing:0,processes:0});assert.deepEqual(ready,[]);
   }finally{for(const release of releases.values())release();await outcome;}
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('真实 Remotion：不等长全局块与连续PCM，单块/合并失败续做，画面复用及缓存隔离',async(t)=>{
 const root=await fs.mkdtemp(join(tmpdir(),'scene-chunks-'));let renders=0,bundles=0,fail:'chunk'|'merge'|'none'='chunk';
 try{
  const {run,ranges,audioAudits}=await fixture(root),input={runId,renderRequestId:'chunks',timelineRef:'timeline.json',ranges,checks:['隔离技术验证'],previewOnly:false};
  const job:MediaJob={id:'chunks',runId,kind:'template-render',state:'failed',inputDigest:'fixture',input,renderStrategy:'scene-chunks',concurrency:1,runConcurrency:2,readyFiles:[],readyFrames:[],chunks:[]};
  const budget=new MediaBudget(2,2);
  const options:RenderOptions={dependencyRoot:process.cwd(),browser,concurrency:1,runConcurrency:2,renderStrategy:'scene-chunks',releaseId:'isolated-test',audioAudits,budget,
   onSourceFrozen:async d=>{job.sourceDigest=d;},onChunkReady:async c=>{job.chunks!.push(c);},onAudioReady:async a=>{job.continuousAudio=a;},onFileReady:async f=>{job.readyFiles.push(f);},
   onOutputStart:async id=>{if(fail==='chunk'&&id==='b')throw new Error('注入单块失败');if(fail==='merge'&&id==='whole-video')throw new Error('注入合并失败');}};
  const backend={...engine,bundle:async(...args:Parameters<typeof bundle>)=>{bundles++;return bundle(...args);},renderMedia:async(...args:Parameters<typeof renderMedia>)=>{renders++;return renderMedia(...args);}};
  await assert.rejects(renderTemplate(run,root,input,options,backend),/注入单块失败/);assert.equal(job.readyFiles.length,0);assert.ok(job.chunks!.some(c=>c.id==='a'));assert.ok(job.continuousAudio);assert.deepEqual(budget.active,{drawing:0,processes:0});
  const original=await fs.stat(job.chunks![0].path);fail='merge';await assert.rejects(retryRenderSlices(run,root,job,options,backend),/注入合并失败/);assert.equal(job.chunks!.length,3);const rendered=renders;
  fail='none';const result=await retryRenderSlices(run,root,job,options,backend);assert.equal(renders,rendered,'合并失败不重绘或重做PCM');assert.equal(bundles,1,'同Run同版构建复用');assert.equal((await fs.stat(job.chunks![0].path)).mtimeMs,original.mtimeMs);assert.deepEqual(result.delivery.files.map(f=>f.id),['whole-video','a','b','c']);assert.deepEqual(budget.active,{drawing:0,processes:0});
  const whole=await raw(result.delivery.files[0].file),frameSize=64*64*3;assert.equal(whole.length,37*frameSize);
  const pixelAt=(frame:number,x:number,y:number)=>{const offset=(frame*64*64+y*64+x)*3;return [...whole.subarray(offset,offset+3)];};
  t.diagnostic(JSON.stringify({globalFramePixels:[0,1,13,14,36].map(frame=>({frame,topLeft:pixelAt(frame,0,0),background:pixelAt(frame,63,63),marker:pixelAt(frame,frame+1,11)}))}));
  // 白块附近会受 JPEG/H264 色度压缩影响；纯背景取远离运动对象的固定区域，颜色阈值保持不变。
  for(let frame=0;frame<37;frame++){
   const channel=frame===0?0:frame<14?1:2,pixel=pixelAt(frame,63,63);
   assert.ok(pixel[channel]>240&&pixel.every((value,index)=>index===channel||value<10),`分块必须保持全局画面时钟：frame=${frame}, rgb=${pixel}`);
  }
  for(const frame of [0,1,13,14,36]){
   const pixel=pixelAt(frame,frame+1,11);
   assert.ok(pixel.every(value=>value>220),`跨分镜持续图形沿全局帧移动：frame=${frame}, x=${frame+1}, rgb=${pixel}`);
  }
  for(const [index,range] of ranges.entries()){
   const segment=await raw(result.delivery.files[index+1].file);assert.deepEqual(segment,whole.subarray(range.fromFrame*frameSize,range.toFrame*frameSize),'整片与分镜复用相同视频码流');
   if(index>0){const segmentAudio=await raw(result.delivery.files[index+1].file,true),continuous=await raw(job.continuousAudio!.path,true),offset=frameSample(range.fromFrame,30)*2;let xy=0,xx=0,yy=0;for(let k=2048;k<Math.min(segmentAudio.length,frameSample(range.toFrame-range.fromFrame,30)*2)-2048;k+=2){const x=segmentAudio.readInt16LE(k),y=continuous.readInt16LE(offset+k);xy+=x*y;xx+=x*x;yy+=y*y;}assert.ok(xy/Math.sqrt(xx*yy)>.98,'分镜音频按全局样本边界取段');}
  }
  const decoded=await raw(result.delivery.files[0].file,true),pcm=await raw(job.continuousAudio!.path,true);let xy=0,xx=0,yy=0;for(let k=2048;k<Math.min(decoded.length,pcm.length)-2048;k+=2){const x=decoded.readInt16LE(k),y=pcm.readInt16LE(k);xy+=x*y;xx+=x*x;yy+=y*y;}assert.ok(xy/Math.sqrt(xx*yy)>.98,'整片声音与连续PCM对齐');
  assert.equal(job.continuousAudio!.samples,frameSample(37,30));
  await fs.appendFile(job.chunks![0].path,'损坏');await assert.rejects(retryRenderSlices(run,root,job,options,backend),/摘要/);
  await fs.writeFile(join(root,'project/extra.json'),'{"changed":true}');
  await templateFrames(run,root,{runId,renderRequestId:'new-source',frames:[0]},options,backend);assert.equal(bundles,2,'任何JSON变化使缓存失效');
 }finally{if(process.env.MEDIA_TEST_EVIDENCE_DIR)await fs.cp(root,process.env.MEDIA_TEST_EVIDENCE_DIR,{recursive:true});await fs.rm(root,{recursive:true,force:true});}
});

test('动态预览有限并发、失败收口与原范围续做；取消不登记临时文件',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'preview-pool-'));let active=0,peak=0,fail=true;const rendered:number[]=[];
 try{
  const {run,ranges}=await fixture(root),source=join(root,'source.mp4');
  await processFile(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1.233333333','-c:v','libx264','-threads:v','1','-c:a','aac',source]);
  const input={runId,renderRequestId:'previews',timelineRef:'timeline.json',ranges,checks:[],previewOnly:true};
  const job:MediaJob={id:'previews',runId,kind:'template-render',state:'failed',inputDigest:'fixture',input,renderStrategy:'scene-chunks',concurrency:1,runConcurrency:2,readyFiles:[],readyFrames:[]};
  const options:RenderOptions={dependencyRoot:process.cwd(),concurrency:1,runConcurrency:2,onSourceFrozen:async d=>{job.sourceDigest=d;},onFileReady:async f=>{job.readyFiles.push(f);}};
  const backend={...engine,bundle:async()=> 'isolated',selectComposition:async()=>({id:'Main',width:64,height:64,fps:30,durationInFrames:37,props:{},defaultProps:{}} as any),renderMedia:async(o:any)=>{
   active++;peak=Math.max(peak,active);rendered.push(o.frameRange[0]);
   try{
    if(fail&&o.frameRange[0]===1)throw new Error('注入预览失败');
    await cutSceneFromWhole(source,o.outputLocation,{fromFrame:o.frameRange[0],toFrame:o.frameRange[1]+1,width:64,height:64,fps:30});return {} as any;
   }finally{active--;}
  }};
  await assert.rejects(renderTemplate(run,root,input,options,backend),/注入预览失败/);assert.equal(active,0);assert.equal(peak,2);assert.deepEqual(job.readyFiles.map(f=>f.id),['a']);const stat=await fs.stat(job.readyFiles[0].file);
  fail=false;const result=await retryRenderSlices(run,root,job,options,backend);assert.deepEqual(result.delivery.files.map(f=>f.id),['a','b','c']);assert.equal(rendered.filter(f=>f===0).length,1);assert.equal((await fs.stat(job.readyFiles[0].file)).mtimeMs,stat.mtimeMs);
  const controller=new AbortController(),cancelReady:any[]=[];let launched=0;
  const cancelled={...backend,renderMedia:async(o:any)=>{
    if(++launched===2)setTimeout(()=>controller.abort(),100);
    await processFile(ffmpeg,['-v','error','-re','-f','lavfi','-i','testsrc2=size=64x64:rate=30','-t','5','-c:v','libx264','-threads:v','1',o.outputLocation],{signal:controller.signal});return {} as any;
  }};
  await assert.rejects(renderTemplate(run,root,{...input,renderRequestId:'cancel'},{...options,signal:controller.signal,onFileReady:async f=>{cancelReady.push(f);}},cancelled));assert.equal(launched,2);assert.equal(cancelReady.length,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});


test('连续PCM仅接受毫秒延迟量化边界，拒绝大缺口和错误采样格式',()=>{
 const expected=6870400,source=(delta:number)=>({codec_name:'pcm_s16le',sample_rate:'48000',time_base:'1/48000',duration_ts:expected+delta});
 for(const delta of [-25,-16,0,16,25])assert.equal(checkContinuousPcmSource(source(delta),expected).normalizationSamples,delta===0?0:-delta);
 for(const delta of [-1600,-26,26,1600])assert.throws(()=>checkContinuousPcmSource(source(delta),expected),error=>{assert.match(String(error),/6870400/);assert.match(String(error),/toleranceSamples/);return true;});
 for(const invalid of [undefined,{...source(0),sample_rate:'44100'},{...source(0),time_base:'1/1000'},{...source(0),codec_name:'aac'},{...source(0),duration_ts:NaN}])assert.throws(()=>checkContinuousPcmSource(invalid,expected),/采样范围不符/);
});

test('真实Remotion音频滤镜与FFmpeg：非整数毫秒起点产生正负16采样差，规范化不移动已有音频',async(t)=>{
 const root=await fs.mkdtemp(join(tmpdir(),'pcm-rounding-')),require=createRequire(import.meta.url);
 const {stringifyFfmpegFilter}=require(join(dirname(require.resolve('@remotion/renderer')),'stringify-ffmpeg-filter.js'));
 const expected=frameSample(37,30),evidence=[];
 try{
  for(const start of [1,2]){
   const filter=stringifyFfmpegFilter({channels:1,volume:1,fps:30,assetDuration:2,chunkLengthInSeconds:37/30,forSeamlessAacConcatenation:false,trimLeftOffset:0,trimRightOffset:0,asset:{type:'audio',src:'isolated',id:'isolated',startInVideo:start,duration:13,trimLeft:0,volume:1,playbackRate:1,toneFrequency:1,audioStreamIndex:0,audioStartFrame:0},indent:false,logLevel:'error',presentationTimeOffsetInSeconds:0,sampleRate:48000});
   const original=join(root,`${start}.wav`),normalized=join(root,`${start}-normalized.wav`);
   const filters=`${filter.filter};[a0]${[filter.pad_start,filter.pad_end].filter(Boolean).join(',')}[out]`;
   await processFile(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-filter_complex',filters,'-map','[out]','-c:a','pcm_s16le',original]);
   const source=(await probe(original)).streams.find((stream:any)=>stream.codec_type==='audio'),range=checkContinuousPcmSource(source,expected);
   assert.equal(range.sourceSamples-expected,start===1?-16:16);
   await processFile(ffmpeg,['-v','error','-i',original,'-af',`apad,atrim=end_sample=${expected},asetpts=PTS-STARTPTS`,'-ar','48000','-c:a','pcm_s16le',normalized]);
   const fixed=(await probe(normalized)).streams.find((stream:any)=>stream.codec_type==='audio');assert.equal(Number(fixed.duration_ts),expected);
   const before=await raw(original,true),after=await raw(normalized,true);assert.deepEqual(after.subarray(0,Math.min(before.length,after.length)),before.subarray(0,Math.min(before.length,after.length)));
   if(before.length<after.length)assert.ok(after.subarray(before.length).every(byte=>byte===0));
   evidence.push({fromFrame:start,padStart:filter.pad_start,expectedSamples:expected,sourceSamples:range.sourceSamples,normalizationSamples:range.normalizationSamples,finalSamples:Number(fixed.duration_ts)});
  }
  t.diagnostic(JSON.stringify({pcmMillisecondRounding:evidence}));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
