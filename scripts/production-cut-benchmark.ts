/** 隔离切片基准：同一合成源、交替策略、三轮计时；不触碰生产任务。 */
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {processFile} from '../packages/production-service/src/files.js';
import {cutSceneFromWhole} from '../apps/render-worker/src/template-slices.js';

const root=await mkdtemp(join(tmpdir(),'production-cut-benchmark-')),source=join(root,'source.mp4');
const ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
const version=(await processFile(ffmpeg,['-version'])).split('\n')[0];
await processFile(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=30','-f','lavfi','-i','aevalsrc=0.2*sin(2*PI*(220*t+11*t*t)):s=48000','-t','60','-c:v','libx264','-threads:v','2','-g','120','-bf','3','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k',source]);
const extent={fromFrame:1567,toFrame:1747,width:640,height:360,fps:30};
const results=[];
for(let i=0;i<3;i++)for(const mode of ['accurate','hybrid'] as const){
 const started=performance.now();
 const result=await cutSceneFromWhole(source,join(root,`${mode}-${i+1}.mp4`),extent,undefined,mode);
 results.push({round:i+1,mode,elapsedMs:performance.now()-started,metadata:result.cutMetadata});
}
const report={schemaVersion:1,recordedAt:new Date().toISOString(),description:'同一60秒合成源的后段6秒切片；三轮交替策略，未隔离操作系统文件缓存，首轮不是可靠冷启动。',ffmpegVersion:version,extent,sourceDurationSec:60,results,mediaDirectory:root};
const destination=resolve(process.argv[2]??join(root,'result.json'));
await writeFile(destination,JSON.stringify(report,null,2)+'\n');
console.log(`基准记录：${destination}\n隔离媒体：${root}`);
