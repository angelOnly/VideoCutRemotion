import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {processFile} from '../packages/production-service/src/files.js';
import {cutSceneFromWhole} from '../apps/render-worker/src/template-slices.js';
import {validateSceneFastCut,validateVideoOutput} from '../packages/production-service/src/video-output.js';

async function fixture(root:string,bframes=3,gop=120,fps='30'){
 const file=join(root,`source-${bframes}-${gop}-${fps.replace('/','-')}.mp4`);
 await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-y','-f','lavfi','-i',`testsrc2=size=96x64:rate=${fps}`,'-f','lavfi','-i','aevalsrc=0.2*sin(2*PI*(220*t+110*t*t)):s=48000','-t','6','-c:v','libx264','-threads:v','1','-g',String(gop),'-keyint_min',String(gop),'-sc_threshold','0','-bf',String(bframes),'-pix_fmt','yuv420p','-c:a','aac','-b:a','192k',file]);return file;
}
const extent=(fromFrame:number,toFrame:number)=>({fromFrame,toFrame,width:96,height:64,fps:30});
test('真实快切：B帧/AAC/长GOP非关键帧自动回退，首末与一帧边界完整',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'tts-fast-cut-'));
 try{
  const source=await fixture(root);
  for(const [i,[start,end]] of [[0,60],[67,113],[179,180],[0,1]].entries()){
   const result=await cutSceneFromWhole(source,join(root,`cut-${i}.mp4`),extent(start,end),undefined,'hybrid');
   assert.equal(result.cutMetadata.requestedStartSec,start/30);assert.equal(result.cutMetadata.requestedEndSec,end/30);
   assert.ok(Number.isFinite(result.cutMetadata.measuredDurationSec));assert.equal(result.cutMetadata.mediaValidationVersion,'scene-cut-v1');
   if(start===67){assert.notEqual(result.cutMetadata.cutMode,'stream_copy');assert.ok(result.cutMetadata.fallbackReason);}
   if(result.cutMetadata.cutMode!=='stream_copy')await validateVideoOutput(join(root,`cut-${i}.mp4`),extent(start,end));
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('真实流拷贝成功与源包定位；时长相同的错误内容不能通过复验',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'tts-copy-'));
 try{
  const source=await fixture(root,0,30),out=join(root,'copy.mp4');
  const result=await cutSceneFromWhole(source,out,extent(0,180),undefined,'hybrid');
  assert.equal(result.cutMetadata.cutMode,'stream_copy');assert.equal(result.cutMetadata.startDeviationMs,0);
  assert.equal(result.cutMetadata.boundaryValidation,'packet-pts-and-decoded-boundaries');
  const internal=await cutSceneFromWhole(source,join(root,'internal.mp4'),extent(30,60),undefined,'hybrid');
  assert.equal(internal.cutMetadata.cutMode,'stream_copy',internal.cutMetadata.fallbackReason);
  assert.equal(internal.cutMetadata.startDeviationMs,0);
  await validateSceneFastCut(out,source,extent(0,180));
  const wrong=join(root,'wrong.mp4');await cutSceneFromWhole(source,wrong,extent(30,60));
  await assert.rejects(validateSceneFastCut(wrong,source,extent(90,120),undefined,'local_transcode'),/画面|音频/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('取消不落正式或pending文件；旧准确路径不受开关影响',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'tts-cancel-'));
 try{
  const source=await fixture(root),out=join(root,'cancel.mp4'),controller=new AbortController();controller.abort();
  await assert.rejects(cutSceneFromWhole(source,out,extent(0,30),controller.signal,'hybrid'));
  assert.equal(await fs.stat(out).catch(()=>null),null);assert.equal(await fs.stat(join(root,'cancel.pending.mp4')).catch(()=>null),null);
  const accurate=await cutSceneFromWhole(source,out,extent(67,113));assert.equal(accurate.cutMetadata.cutMode,'accurate');assert.equal(accurate.actualFrames,46);
  const during=new AbortController();let copied=false;
  await assert.rejects(cutSceneFromWhole(source,join(root,'during.mp4'),extent(0,180),during.signal,'hybrid',{runId:'isolated',renderRequestId:'cancel',onMetric:record=>{if(record.stage==='scene_stream_copy'){copied=true;during.abort();}}}));
  assert.equal(copied,true);assert.equal(await fs.stat(join(root,'during.mp4')).catch(()=>null),null);
  assert.equal(await fs.stat(join(root,'during.pending.mp4')).catch(()=>null),null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});


test('真实混合切片：非整数帧率仍按原全局帧定位',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'tts-fractional-'));
 try{
  const source=await fixture(root,3,120,'30000/1001'),expected={...extent(67,113),fps:30000/1001};
  const result=await cutSceneFromWhole(source,join(root,'fractional.mp4'),expected,undefined,'hybrid');
  assert.equal(result.actualFrames,46);assert.equal(result.cutMetadata.requestedStartSec,67/(30000/1001));
  assert.notEqual(result.cutMetadata.cutMode,'stream_copy');
  if(result.cutMetadata.cutMode==='local_transcode')await validateSceneFastCut(join(root,'fractional.mp4'),source,expected,undefined,'local_transcode');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
