/** 维护命令：按已核对的动作边界裁剪，原速、原画幅，音轨存在时保留。 */
import {readFileSync,writeFileSync,existsSync,renameSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildIndex,localFile} from './mechanisms.mjs';
import {parseMechanism} from '../document-format.mjs';
const root=resolve('references/motion-cases/skillry');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function run(command,args){
  const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:8*1024*1024});
  if(r.error||r.status!==0)throw new Error(`${command} 执行失败：${r.error?.message??r.stderr}`);
  return r.stdout;
}
function probe(path){return JSON.parse(run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path]));}
let temporary;
try{
  const args=process.argv.slice(2),batch=args[0]==='--batch';
  if(batch?args.length!==2:args.length!==4)throw new Error('用法：从仓库根运行，传入 编号 起点毫秒 终点毫秒 "边界说明"；或 --batch 已核对范围的JSON文件');
  const requests=batch?JSON.parse(readFileSync(resolve(args[1]),'utf8')):[{id:args[0],start_ms:Number(args[1]),end_ms:Number(args[2]),boundary_note:args[3]}];
  const index=buildIndex(root),byId=new Map(index.mechanisms.map(m=>[m.id,m]));
  const catalogue=JSON.parse(readFileSync(localFile(root,'case-catalogue.json'),'utf8')),sources=new Map();
  // 批量范围先整体校验；暂存清单只负责本次提交，最终边界仍只保存在机制文档。
  if(!Array.isArray(requests)||!requests.length||requests.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw new Error('批量清单必须是非空对象数组');
  if(new Set(requests.map(r=>r.id)).size!==requests.length)throw new Error('批量清单机制编号重复');
  for(const r of requests){
    if(!/^\d{3}-m\d{2}$/.test(r.id??'')||!Number.isSafeInteger(r.start_ms)||r.start_ms<0||!Number.isSafeInteger(r.end_ms)||r.end_ms<=r.start_ms||typeof r.boundary_note!=='string'||!r.boundary_note.trim())throw new Error('切片参数无效');
    const card=byId.get(r.id);if(!card)throw new Error(`未知机制编号：${r.id}`);
    const c=catalogue.cases.find(c=>c.case_number===card.case_number);
    if(r.end_ms>Math.ceil(c.duration*1000)||r.source_sha256&&r.source_sha256!==c.media_sha256)throw new Error(`${r.id} 原片身份或范围不符`);
  }
  for(const request of requests){
  const {id,start_ms:start,end_ms:end,boundary_note:note}=request,card=byId.get(id);
  const document=localFile(root,card.document),target=resolve(root,card.document.replace(/\.md$/,'.mp4'));
  const source=localFile(root,card.document.split('/mechanisms/')[0]+'/video.mp4');
  if(!sources.has(source))sources.set(source,{info:probe(source),hash:hash(readFileSync(source))});
  const {info:sourceInfo,hash:sourceHash}=sources.get(source);
  if(end>Math.ceil(Number(sourceInfo.format.duration)*1000))throw new Error('切片范围超过原片');
  if(sourceHash!==catalogue.cases.find(c=>c.case_number===card.case_number).media_sha256)throw new Error('原片已变化，请重新核对动作边界');
  if(card.clip||existsSync(target)){
    // 中断续跑只跳过内容、边界和哈希都一致的已完成项，不覆盖人工样例或半成品。
    if(batch&&card.clip&&card.clip.start_ms===start&&card.clip.end_ms===end&&card.clip.boundary_note===note&&hash(readFileSync(target))===card.clip.sha256){console.log(JSON.stringify({id,status:'已验证并跳过'}));continue;}
    throw new Error(`${id} 已有切片，停止覆盖；调整边界前请先核对并保存原版本`);
  }
  const originalDoc=readFileSync(document,'utf8');
  if(parseMechanism(originalDoc).metadata.clip||!originalDoc.includes('## 分镜过程'))throw new Error(`${id} 文档状态变化或缺少分镜标题`);
  temporary=target.replace(/\.mp4$/,`.pending-${process.pid}.mp4`);
  // 解码后重编码，避免按关键帧直接拷贝造成切片起点漂移或黑帧。
  run('ffmpeg',['-nostdin','-v','error','-n','-ss',(start/1000).toFixed(3),'-i',source,'-t',((end-start)/1000).toFixed(3),
    '-map','0:v:0','-map','0:a:0?','-map_metadata','-1','-map_chapters','-1','-c:v','libx264','-crf','18','-preset','fast',
    '-threads','2','-pix_fmt','yuv420p','-fps_mode','passthrough','-c:a','aac','-b:a','160k','-movflags','+faststart',temporary]);
  const info=probe(temporary),video=info.streams.find(s=>s.codec_type==='video'),original=sourceInfo.streams.find(s=>s.codec_type==='video');
  const duration=Number(video?.duration??info.format.duration)*1000;
  if(video?.codec_name!=='h264'||video.width!==original.width||video.height!==original.height||Math.abs(duration-(end-start))>100
    ||sourceInfo.streams.some(s=>s.codec_type==='audio')!==info.streams.some(s=>s.codec_type==='audio'))throw new Error('切片时长、画幅、编码或音轨校验失败');
  run('ffmpeg',['-v','error','-i',temporary,'-f','null','-']);
  const bytes=readFileSync(temporary),clip={path:card.document.replace(/\.md$/,'.mp4'),start_ms:start,end_ms:end,source_sha256:sourceHash,sha256:hash(bytes),bytes:bytes.length,boundary_note:note};
  const updated=originalDoc.replace(/^(\uFEFF?---\r?\n[\s\S]*?)(\r?\n---)/,(_,head,tail)=>head+'\nclip: '+JSON.stringify(clip)+tail)
    .replace('## 分镜过程',`## 视频切片\n\n[播放本机制的原片切片](${id.split('-')[1]}.mp4)\n\n${note}\n\n## 分镜过程`);
  if(readFileSync(document,'utf8')!==originalDoc)throw new Error(`${id} 生成期间文档被修改，停止写入`);
  renameSync(temporary,target);temporary=null;
  try{writeFileSync(document,updated);}catch(error){unlinkSync(target);throw error;}
  console.log(JSON.stringify({id,status:'已生成并解码验证',...clip}));
  }
}catch(error){if(temporary&&existsSync(temporary))unlinkSync(temporary);console.error(error.message);process.exitCode=1;}
