import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
const [action,requestFile,outputDirectory]=process.argv.slice(2),root=resolve(outputDirectory??'.candidate/textvideo-studio-client'),base=process.env.TEXTVIDEO_RUNTIME_URL??'http://127.0.0.1:3410';
await mkdir(root,{recursive:true});const token=process.env.TEXTVIDEO_API_TOKEN;if(!token)throw new Error('缺少 API 令牌');
const request=JSON.parse(await readFile(requestFile,'utf8')),headers={'Content-Type':'application/json',Authorization:`Bearer ${token}`};
if(['analysis','render'].includes(action)){
  const path=action==='analysis'?'getAiVideoEditingAnalysisData':'getAiVideoEditingData';const response=await fetch(`${base}/narrate/ai_video_director/${path}`,{method:'POST',headers,body:JSON.stringify(request)});const raw=await response.text();await writeFile(join(root,`${action}-request.json`),JSON.stringify(request,null,2));await writeFile(join(root,`${action}-response.json`),raw);if(response.status!==202)throw new Error(raw);console.log(raw);
}else if(action==='status'){
  const response=await fetch(`${base}/ai_video_director/tasks/${encodeURIComponent(request.taskId)}`,{headers});const data=await response.json();await writeFile(join(root,'task-status.json'),JSON.stringify(data,null,2));console.log(JSON.stringify(data));
}else if(action==='download'){
  const response=await fetch(`${base}/ai_video_director/tasks/${encodeURIComponent(request.taskId)}`,{headers});const data=await response.json(),run=data.data.runs.find(r=>r.runId===request.runId);if(run?.state!=='succeeded')throw new Error('指定版本未成功');const report=[];
  for(const item of run.result.dataList){const r=await fetch(item.url);if(!r.ok)throw new Error(`下载失败 ${r.status}`);const bytes=Buffer.from(await r.arrayBuffer()),digest=createHash('sha256').update(bytes).digest('hex');if(digest!==item.extraData.sha256)throw new Error('下载摘要不符');await writeFile(join(root,`${item.id}.mp4`),bytes);const head=await fetch(item.url,{method:'HEAD'}),range=await fetch(item.url,{headers:{Range:'bytes=0-99'}});if(head.status!==200||range.status!==206)throw new Error('媒体协议检查失败');report.push({id:item.id,bytes:bytes.length,sha256:digest,head:head.status,range:range.status});}
  await writeFile(join(root,'download-report.json'),JSON.stringify({runId:run.runId,report},null,2));console.log(JSON.stringify(report));
}else throw new Error('支持 analysis、render、status、download');
