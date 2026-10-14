import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {bundle} from '@remotion/bundler';
import {selectComposition,renderMedia,renderFrames,openBrowser} from '@remotion/renderer';
import {PNG} from 'pngjs';
import {processFile,writeJson,treeDigest} from '../packages/production-service/src/files.js';
import {validateVideoOutput} from '../packages/production-service/src/video-output.js';
import {cutSceneFromWhole} from '../apps/render-worker/src/template-slices.js';
import {renderTemplate,retryRenderSlices,templateFrames,previewFramesSchema,type MediaJob} from '../apps/render-worker/src/template-renderer.js';
import {introRange,isIntroFrame,bodyRanges} from '../scripts/finance-template-patches/intro-timing.js';
const engine={bundle,selectComposition,renderMedia,renderFrames,openBrowser};
const runId='00000000-0000-4000-8000-000000000001';
const options={dependencyRoot:process.cwd(),concurrency:5,browser:process.env.TEST_BROWSER??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)};
async function fixture(root:string,fps='30',frames=60){
 const path=join(root,'source.mp4');
 await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-y','-f','lavfi','-i',`testsrc2=size=64x64:rate=${fps}`,'-f','lavfi','-i','aevalsrc=0.2*sin(2*PI*(220*t+110*t*t)):s=48000','-t',String(frames/(fps.includes('/')?30000/1001:Number(fps))),'-c:v','libx264','-threads:v','1','-g','60','-bf','0','-pix_fmt','yuv420p','-c:a','aac',path]);return path;
}

async function raw(path:string,audio=false){
 const chunks:Buffer[]=[];await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-i',path,...(audio?['-map','0:a:0','-ac','1','-ar','48000','-f','s16le']:['-map','0:v:0','-pix_fmt','rgb24','-f','rawvideo']),'-'],{captureOutput:false,onOutput:c=>chunks.push(c)});return Buffer.concat(chunks);
}
async function project(root:string){
 const p=join(root,'project'),renderer=join(p,'renderer');await fs.mkdir(join(renderer,'public'),{recursive:true});
 await fs.writeFile(join(p,'说明.md'),'隔离测试');await fs.writeFile(join(p,'timeline.json'),'{}');
 await fs.writeFile(join(renderer,'timeline.ts'),'export default {};');
 await fs.writeFile(join(renderer,'index.tsx'),`import React from 'react';import {Composition,registerRoot,useCurrentFrame,AbsoluteFill} from 'remotion';const Frame=()=>{const f=useCurrentFrame();return <AbsoluteFill style={{backgroundColor:f<10?'red':f<20?'lime':'blue'}}/>};registerRoot(()=> <Composition id="Main" component={Frame} width={64} height={64} fps={30} durationInFrames={60}/>);`);
 await writeJson(join(renderer,'renderer-manifest.json'),{schemaVersion:1,templateVersion:'test',instructions:['../说明.md'],entry:'index.tsx',timelineModule:'timeline.ts',wholeComposition:'Main',publicAssetRoot:'public',width:64,height:64,fps:30,voiceRefs:[]});
 return p;
}
const run=()=>({stage:'render',state:'running',runId,taskId:'test',inputDigest:'input',checkpoint:{template:{digest:'template'}},request:{dataList:[{id:'s1',content:'甲'},{id:'s2',content:'乙'}]}} as any);
const input=(id='formal')=>({runId,renderRequestId:id,timelineRef:'timeline.json',ranges:[{id:'s1',fromFrame:0,toFrame:23},{id:'s2',fromFrame:23,toFrame:60}],checks:['隔离验证'],previewOnly:false});

test('片头前后正文使用原时钟，片头末帧后恢复；拒绝默认长度、越界和转场重叠',()=>{
 const scene={frames:100,intro:{fromFrame:20,frames:30}};assert.deepEqual(introRange(scene),[20,50]);
 assert.equal(isIntroFrame(scene,19),false);assert.equal(isIntroFrame(scene,20),true);assert.equal(isIntroFrame(scene,49),true);assert.equal(isIntroFrame(scene,50),false);
 assert.deepEqual(bodyRanges(scene,100),[[0,20],[50,100]]);assert.deepEqual(bodyRanges(scene,35),[[0,20]]);
 assert.deepEqual(bodyRanges({frames:100,chapter:{frames:10},intro:{fromFrame:20,frames:30}},100),[[10,20],[50,100]]);
 for(const s of [{frames:100,intro:{}},{frames:100,intro:{fromFrame:90,frames:30}},{frames:100,chapter:{frames:21},intro:{fromFrame:20,frames:30}}])assert.throws(()=>introRange(s));
});

test('真实FFmpeg：非关键帧、首末帧、短切片、重叠区间和非整数帧率准确计数',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'slice-edges-'));
 try{
  for(const fps of [30,30000/1001]){
   const src=await fixture(root,fps===30?'30':'30000/1001');const original=await raw(src),originalAudio=await raw(src,true);
   for(const [i,[fromFrame,toFrame]] of [[0,1],[7,23],[23,60],[59,60],[10,35]].entries()){
    const extent={fromFrame,toFrame,width:64,height:64,fps};const media=await cutSceneFromWhole(src,join(root,`cut-${i}.mp4`),extent);assert.equal(media.actualFrames,toFrame-fromFrame);
    const cut=await raw(join(root,`cut-${i}.mp4`)),size=64*64*3;
    for(const n of [0,toFrame-fromFrame-1]){let error=0;for(let k=0;k<size;k++)error+=Math.abs(cut[n*size+k]-original[(fromFrame+n)*size+k]);assert.ok(error/size<5,`首尾画面与原帧不符：${error/size}`);}
    if(toFrame-fromFrame>10){const audio=await raw(join(root,`cut-${i}.mp4`),true),offset=Math.round(fromFrame/fps*48000)*2;let xy=0,xx=0,yy=0;
      for(let k=2048;k<Math.min(audio.length-2048,originalAudio.length-offset);k+=2){const x=audio.readInt16LE(k),y=originalAudio.readInt16LE(offset+k);xy+=x*y;xx+=x*x;yy+=y*y;}
      assert.ok(xy/Math.sqrt(xx*yy)>.98,`声音没有对齐原区间：${xy/Math.sqrt(xx*yy)}`);
    }
   }
   await assert.rejects(validateVideoOutput(src,{fromFrame:0,toFrame:59,width:64,height:64,fps}));
  }
  const c=new AbortController();c.abort();await assert.rejects(cutSceneFromWhole(join(root,'source.mp4'),join(root,'cancel.mp4'),{fromFrame:0,toFrame:30,width:64,height:64,fps:30},c.signal));
  assert.equal(await fs.stat(join(root,'cancel.pending.mp4')).catch(()=>null),null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('正式整片只绘制一次；续做复用冻结快照并拒绝篡改，保留已完成分镜',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'render-once-'));let renderCount=0;const files:any[]=[];
 try{
  const src=await fixture(root);await project(root);
  const backend={...engine,bundle:async()=> 'isolated',selectComposition:async()=>({id:'Main',width:64,height:64,fps:30,durationInFrames:60,props:{},defaultProps:{}} as any),renderMedia:async(o:any)=>{renderCount++;await fs.copyFile(src,o.outputLocation);return {} as any;}};
  const job={id:'formal',runId,kind:'template-render',state:'failed',inputDigest:'test',input:input(),readyFiles:files,readyFrames:[]} as MediaJob;
  await assert.rejects(renderTemplate(run(),root,input(),{...options,onSourceFrozen:async d=>{job.sourceDigest=d;},onFileReady:async f=>{files.push(f);},onOutputStart:async id=>{if(id==='s2')throw new Error('模拟第二镜失败');}},backend),/模拟第二镜失败/);
  assert.equal(renderCount,1);assert.deepEqual(files.map(f=>f.id),['whole-video','s1']);const firstStat=await fs.stat(files[1].file);
  await fs.writeFile(join(root,'project/timeline.json'),'作者在之后的工作目录改稿');
  const result=await retryRenderSlices(run(),root,job,{...options,onFileReady:async f=>{files.push(f);}});
  assert.deepEqual(result.delivery.files.map(f=>f.id),['whole-video','s1','s2']);assert.equal(renderCount,1);assert.equal((await fs.stat(files[1].file)).mtimeMs,firstStat.mtimeMs);
  await fs.appendFile(files[0].file,'破坏原文件');await assert.rejects(retryRenderSlices(run(),root,job,options),/摘要/);
  await fs.writeFile(join(root,'render-snapshots/formal/project/timeline.json'),'破坏快照');await assert.rejects(retryRenderSlices(run(),root,job,options),/固定工程/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('静帧参数限制与真实批量渲染：一次构建、一浏览器、五并发、固定快照、PNG和概览',async()=>{
 assert.equal(previewFramesSchema.safeParse({runId,renderRequestId:'x',frames:[0,0]}).success,false);
 assert.equal(previewFramesSchema.safeParse({runId,renderRequestId:'x',frames:Array.from({length:13},(_,i)=>i)}).success,false);
 const root=await fs.mkdtemp(join(tmpdir(),'real-preview-'));let bundles=0,browsers=0,closed=0;
 try{
  await project(root);
  const backend={...engine,bundle:async(...args:Parameters<typeof bundle>)=>{bundles++;return bundle(...args);},openBrowser:async(...args:Parameters<typeof openBrowser>)=>{browsers++;const b=await openBrowser(...args);const close=b.close.bind(b);b.close=async(...a)=>{closed++;return close(...a);};return b;},renderFrames:async(o:Parameters<typeof renderFrames>[0])=>{assert.equal(o.concurrency,5);return renderFrames(o);}};
  const result=await templateFrames(run(),root,{runId,renderRequestId:'batch',frames:[20,0,10]}, {...options,onSourceFrozen:async()=>{await fs.writeFile(join(root,'project/renderer/index.tsx'),'工作目录后续更改不影响已冻结批次');}},backend);
  assert.equal(bundles,1);assert.equal(browsers,1);assert.equal(closed,1);assert.deepEqual(result.readyFrames.map(f=>f.frame),[20,0,10]);assert.equal(result.overviewPaths.length,1);
  for(const [i,expected] of [[0,0,255],[255,0,0],[0,255,0]].entries()){const png=PNG.sync.read(await fs.readFile(result.readyFrames[i].path));assert.deepEqual([...png.data.subarray(0,3)],expected);assert.equal(png.width,64);}
  assert.equal(await treeDigest(join(root,'preview-snapshots/batch/project')),result.sourceDigest);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('批量静帧中途失败或取消仍关闭浏览器，保留原图且不返回成功',async()=>{
 for(const mode of ['failed','cancelled','out-of-range']){
  const root=await fs.mkdtemp(join(tmpdir(),'preview-failure-')),controller=new AbortController();let closed=0;const ready:number[]=[];let buildRoot='';
  try{
   await project(root);const buffer=PNG.sync.write(new PNG({width:64,height:64}));
   const backend={...engine,bundle:async(...args:Parameters<typeof bundle>)=>{buildRoot=(args[0] as any).outDir;return 'isolated';},openBrowser:async()=>({close:async()=>{closed++;}} as any),selectComposition:async()=>({width:64,height:64,fps:30,durationInFrames:60} as any),renderFrames:async(o:any)=>{await o.onFrameBuffer(buffer,0);if(mode==='cancelled')controller.abort();throw new Error('模拟绘制中断');}};
   await assert.rejects(templateFrames(run(),root,{runId,renderRequestId:'fail',frames:mode==='out-of-range'?[60]:[0,1]},{...options,signal:controller.signal,onFrameReady:async f=>{ready.push(f.frame);}},backend));
   assert.equal(closed,1);assert.deepEqual(ready,mode==='out-of-range'?[]:[0]);assert.equal(await fs.stat(buildRoot).catch(()=>null),null);
   assert.equal(await fs.stat(join(root,'previews/fail/delivery.json')).catch(()=>null),null);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 }
});

test('真实Remotion整片到分镜再到正式发布的隔离闭环',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'native-delivery-'));let calls=0;
 try{
  const p=await project(root),entry=join(p,'renderer/index.tsx');let source=await fs.readFile(entry,'utf8');
  source=source.replace("AbsoluteFill} from 'remotion'", "AbsoluteFill,Audio,staticFile} from 'remotion'").replace("'blue'}}/>", "'blue'}}><Audio src={staticFile('voice.wav')}/></AbsoluteFill>");await fs.writeFile(entry,source);
  await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:duration=2','-c:a','pcm_s16le',join(p,'renderer/public/voice.wav')]);
  const result=await renderTemplate(run(),root,input('native'),options,{...engine,renderMedia:async(...args:Parameters<typeof renderMedia>)=>{calls++;return renderMedia(...args);}});
  assert.equal(calls,1);assert.equal(result.delivery.files.length,3);assert.equal(result.delivery.files[0].toFrame,60);
  const {publishDelivery}=await import('../packages/production-service/src/delivery.js');
  const current=run();current.taskKey=runId;const published=await publishDelivery(current,root,join(root,'task'),'http://localhost/media',result.delivery);
  assert.equal(published.dataList.length,3);assert.equal(published.dataList[1].extraData.toFrame,23);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
