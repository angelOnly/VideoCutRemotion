import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {processFile,treeDigest} from '../packages/production-service/src/files.js';
import {validateVideoOutput} from '../packages/production-service/src/video-output.js';
import {publishDelivery} from '../packages/production-service/src/delivery.js';
import {sha256,type Run} from '../packages/production-service/src/contracts.js';
import type {MediaSpanRecord,MetricContext} from '../packages/production-service/src/media-metrics.js';

const extent={fromFrame:0,toFrame:12,width:64,height:64,fps:24};
async function fixture(root:string){
 const path=join(root,'source.mp4');
 await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=24','-f','lavfi','-i','sine=frequency=531:sample_rate=48000','-t','0.5','-c:v','mpeg4','-threads:v','1','-pix_fmt','yuv420p','-c:a','aac',path]);
 return path;
}

test('技术复用要求实际字节和规则参数一致，仍核对当前规格与取消状态',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'trusted-validation-')),records:MediaSpanRecord[]=[];
 const metrics:MetricContext={runId:'isolated',renderRequestId:'isolated',onMetric:record=>{records.push(record);}};
 try{
  const source=await fixture(root),copy=join(root,'copy.mp4');await fs.copyFile(source,copy);
  await validateVideoOutput(source,extent,undefined,metrics);
  await validateVideoOutput(copy,extent,undefined,metrics);
  assert.equal(records.filter(r=>r.stage==='video_full_decode').length,1);
  assert.equal(records.filter(r=>r.stage==='video_full_decode_reused').length,1);
  assert.equal(records.filter(r=>r.stage==='video_ffprobe').length,2);
  // 摆放参数变化采取保守失效；同一文件不能靠旧核验跳过新的范围合同。
  await validateVideoOutput(copy,{...extent,fromFrame:12,toFrame:24},undefined,metrics);
  assert.equal(records.filter(r=>r.stage==='video_full_decode').length,2);
  await assert.rejects(validateVideoOutput(copy,{...extent,toFrame:13},undefined,metrics),/规格/);
  // 只改容器元数据也必须按新字节重验，不能用路径或音画看似相同作缓存身份。
  await processFile(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-y','-i',source,'-map','0','-c','copy','-metadata','comment=changed',copy]);
  await validateVideoOutput(copy,extent,undefined,metrics);
  assert.equal(records.filter(r=>r.stage==='video_full_decode').length,3);
  const original=process.env.FFMPEG_PATH;
  try{process.env.FFMPEG_PATH=join(root,'missing-decoder');await assert.rejects(validateVideoOutput(copy,extent,undefined,metrics));}
  finally{if(original===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=original;}
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(validateVideoOutput(copy,extent,cancelled.signal,metrics));
  await fs.writeFile(copy,Buffer.alloc(128));await assert.rejects(validateVideoOutput(copy,extent,undefined,metrics));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('未听审仍可发布，技术复用后仍验证复制摘要',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'delivery-review-gate-'));
 try{
  const source=await fixture(root),project=join(root,'render-snapshots','formal','project');
  await fs.mkdir(project,{recursive:true});await fs.writeFile(join(project,'timeline.json'),'{}');
  const sourceDigest=await treeDigest(project),runId='00000000-0000-4000-8000-000000000081';
  const run={runId,taskId:'review-test',taskKey:'review-test',inputDigest:'input',checkpoint:{template:{digest:'template'}},request:{dataList:[{id:'s1',content:'测试'}]}} as unknown as Run;
  const file={file:source,sha256:sha256(await fs.readFile(source)),dur:0.5,...extent};
  const delivery={taskId:run.taskId,runId,inputDigest:run.inputDigest,templateDigest:'template',renderRequestId:'formal',sourceDigest,timelineRef:'timeline.json',checks:['作者自报已通过'],files:[{...file,id:'whole-video',content:'测试'},{...file,id:'s1',content:'测试'}]};
  const taskRoot=join(root,'task');
  delivery.checks=['未进行连续观看与听审'];
  const result=await publishDelivery(run,root,taskRoot,'http://localhost/media',delivery);
  assert.equal(result.dataList.length,2);assert.deepEqual(result.checks,delivery.checks);
  // 在复制完成后模拟落盘字节被改写，仍须拒绝发布，不能靠移除审片门槛放宽技术检查。
  const copy=fs.copyFile;
  try{
    fs.copyFile=async(...args:Parameters<typeof fs.copyFile>)=>{await copy(...args);await fs.appendFile(args[1],'被替换的字节');};
    const otherRoot=join(root,'changed');
    await assert.rejects(publishDelivery(run,root,otherRoot,'http://localhost/media',delivery),/发布副本/);
    assert.equal(await fs.stat(join(otherRoot,'results',runId)).catch(()=>null),null);
  }finally{fs.copyFile=copy;}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
