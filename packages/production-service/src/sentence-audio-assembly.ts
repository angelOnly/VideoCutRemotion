import {isVisualScene,visualSceneFrames,speechBindings} from './scene-speech.js';
import {promises as fs} from 'node:fs';
import {join,dirname} from 'node:path';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {canonical,sha256,ProductionError,type Run,type RenderRequest} from './contracts.js';
import {inside,regular,json,writeJson,type PcmMeasurement} from './files.js';
import {validateTemplate} from './template-package.js';
import {validateTemplateTimeline} from './template-timeline-validation.js';
import {validateProductionTimeline,reviewChaptersFromTimeline,SENTENCE_TIMELINE_CONTRACT} from './production-timeline.js';
import type {DoubaoService} from '../../speech-services/src/doubao.js';
const key=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),frames=z.number().int().nonnegative();
export const sentenceAssemblyPlanSchema=z.object({scenes:z.array(z.object({sceneId:z.string().min(1),utterances:z.array(z.object({id:z.string().min(1),gapBeforeFrames:frames.optional(),captionText:z.string().min(1).optional()}).strict()).optional(),tailFrames:frames.optional(),captions:z.array(z.object({utteranceId:z.string().min(1),text:z.string().min(1),startFrame:frames,endFrameExclusive:frames}).strict()).optional(),captionTiming:z.object({src:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional()}).strict()).min(1),chapters:z.array(z.object({chapterId:z.string().min(1),sceneIds:z.array(z.string().min(1)).min(1)}).strict()).optional()}).strict();
// 计划文件不在工具入参中，必须把同源结构暴露给作者，避免靠错误猜字段。
export const sentenceAssemblyPlanJsonSchema=zodToJsonSchema(sentenceAssemblyPlanSchema,{$refStrategy:'none'});
export const sentenceAssemblySchema=z.object({assemblyRequestId:key,speechBatchRequestIds:z.array(key),planRef:z.string().min(1).describe('相对 project 的 JSON 计划文件。完整结构：'+JSON.stringify(sentenceAssemblyPlanJsonSchema)),expectedTimelineSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const normalized=(s:unknown)=>String(s??'').replace(/\s+/gu,'');
function ensure(value:unknown,message:string):asserts value{if(!value)throw new ProductionError('SENTENCE_ASSEMBLY_INVALID',message);}
function cancelled(signal?:AbortSignal){if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','装配提交已取消');}
function differences(before:any,after:any,path=''):string[]{if(canonical(before)===canonical(after))return [];if(!before||!after||typeof before!=='object'||typeof after!=='object')return [path||'$'];return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(k=>differences(before[k],after[k],path?`${path}.${k}`:k)).slice(0,30);}
async function changedFields(path:string,before:any){try{return differences(before,await json(path)).join('、');}catch{return '当前文件不是有效 JSON';}}
function conflict(message:string):never{throw new ProductionError('SENTENCE_ASSEMBLY_CONFLICT',message,409);}
export function audioFrames(measurement:PcmMeasurement,fps:number){
  ensure(Number.isFinite(fps)&&fps>0&&Number.isSafeInteger(measurement.sampleCount)&&measurement.sampleCount>0,'音频采样或 fps 无效');
  // 只消除浮点运算的机器误差；不能向下截掉真实存在的采样。
  const exact=measurement.sampleCount*fps/measurement.sampleRate,nearest=Math.round(exact);
  return Math.abs(exact-nearest)<=Number.EPSILON*Math.max(1,exact)*4?nearest:Math.ceil(exact);
}

export async function assembleSentenceAudio(run:Run,runRoot:string,raw:unknown,speech:DoubaoService,signal?:AbortSignal){
  const startedAt=new Date().toISOString(),input=sentenceAssemblySchema.parse(raw);
  ensure(run.stage==='render'&&run.state==='running','只有当前运行中的制作任务可以装配');
  cancelled(signal);
  const project=join(runRoot,'project');inside(await fs.realpath(runRoot),await fs.realpath(project));
  const recordPath=join(runRoot,'audio-assemblies',`${input.assemblyRequestId}.json`),prior=await json(recordPath).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});
  if(prior){ensure(prior.runId===run.runId,'装配记录不属于当前 Run');if(canonical(prior.input)!==canonical(input))conflict('同一装配编号不可改变输入，请读取原记录');}
  const planPath=await regular(project,input.planRef).catch((e:any)=>{if(e.code==='ENOENT'&&prior?.state==='succeeded')return null;throw e;});
  if(!planPath)return prior.result;
  const planBytes=await fs.readFile(planPath),parsedPlan=sentenceAssemblyPlanSchema.safeParse(JSON.parse(planBytes.toString('utf8')));
  if(!parsedPlan.success)throw new ProductionError('SENTENCE_ASSEMBLY_PLAN_INVALID',`计划字段错误：${JSON.stringify(parsedPlan.error.issues)}。完整结构：${JSON.stringify(sentenceAssemblyPlanJsonSchema)}`);
  const plan=parsedPlan.data,digest=sha256(canonical({input,planSha256:sha256(planBytes)}));
  if(prior&&prior.inputDigest!==digest)conflict('同一装配编号不可改变输入或计划，请读取原装配记录');
  if(prior?.state==='succeeded')return prior.result;
  const manifest=await validateTemplate(project);
  ensure(manifest.timelineContract===SENTENCE_TIMELINE_CONTRACT&&typeof manifest.timelineDataRef==='string','模板没有声明支持的 sentence-timeline/1 合同');
  const timelineRef=join('renderer',manifest.timelineDataRef).replaceAll('\\','/'),timelinePath=await regular(project,timelineRef);
  const publicRoot=join(project,'renderer',manifest.publicAssetRoot);inside(await fs.realpath(project),await fs.realpath(publicRoot));
  const currentBytes=await fs.readFile(timelinePath),currentHash=sha256(currentBytes);
  if(prior?.state==='committing'){
    ensure(sha256(prior.outputText)===prior.result.timelineSha256,'原装配输出记录摘要不符');
    for(const binding of prior.audioBindings??[]){const file=await regular(publicRoot,binding.src);ensure(sha256(await fs.readFile(file))===binding.sha256,'装配恢复的受管音频字节发生变化');}
    // 替换后落记录前中断，优先核对原输出；绝不依据新稿重新装配。
    if(currentHash===prior.result.timelineSha256){cancelled(signal);ensure(sha256(await fs.readFile(planPath))===sha256(planBytes),'恢复期间作者计划发生变化');ensure(sha256(await fs.readFile(timelinePath))===currentHash,'恢复期间时间线发生变化');await writeJson(recordPath,{...prior,state:'succeeded'});return prior.result;}
    if(currentHash!==input.expectedTimelineSha256)conflict(`装配恢复遇到新稿：预期 ${input.expectedTimelineSha256}，实际 ${currentHash}，原输出 ${prior.result.timelineSha256}`);
    cancelled(signal);ensure(sha256(await fs.readFile(planPath))===sha256(planBytes),'恢复期间作者计划发生变化');
    await fs.writeFile(`${timelinePath}.assembly.tmp`,prior.outputText);cancelled(signal);
    if(sha256(await fs.readFile(timelinePath))!==currentHash)conflict(`恢复提交前时间线改变，差异字段：${await changedFields(timelinePath,prior.previousTimeline)}`);
    ensure(sha256(await fs.readFile(planPath))===sha256(planBytes),'恢复替换前作者计划发生变化');
    await fs.rename(`${timelinePath}.assembly.tmp`,timelinePath);
    ensure(sha256(await fs.readFile(timelinePath))===prior.result.timelineSha256,'装配恢复写入后文件发生变化');cancelled(signal);await writeJson(recordPath,{...prior,state:'succeeded'});return prior.result;
  }
  if(currentHash!==input.expectedTimelineSha256)conflict(`时间线基线已改变：预期 ${input.expectedTimelineSha256}，实际 ${currentHash}`);
  const old=JSON.parse(currentBytes.toString('utf8')),timeline=structuredClone(old),expected=(run.request as RenderRequest).dataList;
  ensure(old.fps===manifest.fps&&Array.isArray(old.scenes)&&canonical(old.scenes.map((s:any)=>s.id))===canonical(expected.map(s=>s.id)),'时间线场景编号、顺序或 fps 与确认稿不符');
  ensure(canonical(plan.scenes.map(s=>s.sceneId))===canonical(expected.map(s=>s.id)),'计划必须按确认稿顺序完整列出分镜');
  const jobs:any[]=[];const ids=new Set<string>();
  for(const batchId of input.speechBatchRequestIds){
    const batch=await speech.readBatch(batchId,run.runId,run.accountId);ensure(batch.state==='succeeded'&&batch.jobs.length>0,`配音批次 ${batchId} 尚未完整成功`);
    for(const job of batch.jobs){ensure(!ids.has(job.request.segmentId),`句段编号重复：${job.request.segmentId}`);ids.add(job.request.segmentId);jobs.push(job);}
  }
  let cursor=0,hits=0,misses=0,copied=0,reused=0;const consumed=new Set<string>(),copies:Array<{target:string;bytes:Buffer;hash:string}>=[];
  for(const [index,decision] of plan.scenes.entries()){
    const scene=timeline.scenes[index],original=old.scenes[index],selected=jobs.filter(j=>j.request.sceneId===scene.id);
    const ordered:Array<{id:string;gapBeforeFrames?:number;captionText?:string}>=decision.utterances??selected.map(j=>({id:j.request.segmentId}));
    if(isVisualScene(expected[index])){
      ensure(!selected.length&&!ordered.length&&!decision.captionTiming&&!decision.captions?.length&&!decision.tailFrames,`${scene.id} 无口播画面不能带配音、字幕对齐或额外尾帧`);
      const visualFrames=visualSceneFrames(expected[index],manifest.fps);
      Object.assign(scene,{from:cursor,frames:visualFrames,directing:expected[index].directing,utterances:[],captions:[]});delete scene.captionTiming;cursor+=scene.frames;continue;
    }
    ensure(ordered.length===selected.length&&ordered.length>0,`${scene.id} 句段数量缺失或多余`);
    const bindings=speechBindings(expected[index],ordered.map(choice=>{const j=selected.find(j=>j.request.segmentId===choice.id);ensure(j,`${scene.id} 缺少句段 ${choice.id}`);return {id:choice.id,text:j.request.text,voiceRef:j.request.voiceRef};}),false,manifest);
    let end=0;const utterances:any[]=[],captions:any[]=[];
    ensure(!(decision.captions&&decision.captionTiming),`${scene.id} 作者字幕与对齐文件不能同时指定`);
    const timing=decision.captions?undefined:decision.captionTiming??original.captionTiming;
    let aligned:any;
    if(timing){const file=await regular(publicRoot,timing.src);ensure(sha256(await fs.readFile(file))===timing.sha256,`${scene.id} 字幕对齐摘要不符`);aligned=await json(file);ensure(['provider_timestamps','forced_alignment','reviewed_timestamps'].includes(aligned.method),`${scene.id} 分页缺少可靠时间依据`);}
    for(const [i,choice] of ordered.entries()){
      const job=selected.find(j=>j.request.segmentId===choice.id);ensure(job&&!consumed.has(choice.id),`${scene.id} 句段 ${choice.id} 缺失、重复或跨场景`);consumed.add(choice.id);
      const measured=await speech.measurement(job.id,run.runId,run.accountId,signal);if(measured.reused)hits++;else misses++;
      const bytes=await fs.readFile(job.audioRef);ensure(sha256(bytes)===job.sha256&&measured.measurement.audioSha256===job.sha256,`${choice.id} 音频字节绑定错误`);
      const oldIndex=original.utterances?.findIndex((u:any)=>u.id===choice.id)??-1,oldU=oldIndex>=0?original.utterances[oldIndex]:undefined;
      const oldGap=oldU?oldU.startFrame-(oldIndex?original.utterances[oldIndex-1].endFrameExclusive:0):0;
      const gap=choice.gapBeforeFrames??oldGap;ensure(Number.isInteger(gap)&&gap>=0,`${choice.id} 原停顿无效，请在计划指定 gapBeforeFrames`);
      const start=end+gap;end=start+audioFrames(measured.measurement,manifest.fps);
      const src=`speech/${job.id}-${job.sha256}.mp3`;copies.push({target:inside(publicRoot,src),bytes,hash:job.sha256});
      utterances.push({...oldU,...bindings[i],id:choice.id,text:job.request.text,voiceRef:job.request.voiceRef,src,startFrame:start,endFrameExclusive:end});
      if(aligned){const evidence=aligned.utterances?.[choice.id];ensure(evidence?.audioSha256===job.sha256&&Array.isArray(evidence.captions),`${choice.id} 分页对齐没有绑定当前音频`);ensure(!choice.captionText,`${choice.id} 使用可靠分页时请在对齐记录中修改字幕`);captions.push(...evidence.captions.map((c:any)=>({...c,utteranceId:choice.id})));}
      else {const oldCaption=original.captions?.filter((c:any)=>c.utteranceId===choice.id);const text=choice.captionText??(oldCaption?.length===1?oldCaption[0].text:job.request.text);ensure(normalized(text)===normalized(job.request.text),`${choice.id} 字幕只能调整换行，不能改正文`);captions.push({...oldCaption?.[0],utteranceId:choice.id,text,startFrame:start,endFrameExclusive:end});}
    }
    ensure(normalized(utterances.map(u=>u.text).join(''))===normalized(expected[index].content),`${scene.id} 配音正文或顺序与确认稿不一致`);
    const oldTail=original.utterances?.length?original.frames-original.utterances.at(-1).endFrameExclusive:0,tail=decision.tailFrames??oldTail;
    ensure(Number.isInteger(tail)&&tail>=0,`${scene.id} 尾保留帧无效，请指定 tailFrames`);
    Object.assign(scene,{from:cursor,frames:end+tail,utterances,captions:decision.captions??captions,...(expected[index].directing?{directing:expected[index].directing}:{})});if(timing)scene.captionTiming=timing;else delete scene.captionTiming;cursor+=scene.frames;
  }
  ensure(consumed.size===jobs.length,'配音批次含未绑定分镜的条目');
  if(timeline.ending?.outro){timeline.ending.narrationEndFrame=cursor;timeline.totalFrames=cursor+timeline.ending.outro.frames;}else timeline.totalFrames=cursor;
  if(timeline.chapters?.length){
    const oldRanges=old.scenes.map((s:any,i:number)=>({id:s.id,fromFrame:s.from,toFrame:i===old.scenes.length-1?old.totalFrames:s.from+s.frames}));
    const groups=plan.chapters??reviewChaptersFromTimeline(old,oldRanges);ensure(groups?.length===timeline.chapters.length,'章节归属不明确，请提供 chapters 中的 chapterId 和 sceneIds');
    let chapterCursor=0;
    for(const [i,group] of groups.entries()){
      const chapter=timeline.chapters[i],previous=old.chapters[i];ensure(group.chapterId===chapter.id,'计划章节编号或顺序与已有设计不符');
      const scenes=timeline.scenes.slice(chapterCursor,chapterCursor+group.sceneIds.length);ensure(canonical(scenes.map((s:any)=>s.id))===canonical(group.sceneIds),'章节分组必须连续并按确认场景顺序覆盖');
      const offset=i===0?previous.from-old.scenes[0].from:0;chapter.from=scenes[0].from+offset;
      const end=scenes.at(-1).from+scenes.at(-1).frames;
      chapter.endFrameExclusive=i===groups.length-1&&previous.endFrameExclusive===old.totalFrames?timeline.totalFrames:end;chapterCursor+=scenes.length;
    }
    ensure(chapterCursor===timeline.scenes.length,'章节分组未完整覆盖场景');
  }else ensure(!plan.chapters?.length,'计划不能凭空创建章节设计，请先由作者建立章节');
  validateProductionTimeline(timeline,expected,manifest.fps,manifest);
  await validateTemplateTimeline(project,timeline,manifest);
  for(const copy of copies){cancelled(signal);await fs.mkdir(dirname(copy.target),{recursive:true});inside(await fs.realpath(publicRoot),await fs.realpath(dirname(copy.target)));try{await fs.writeFile(copy.target,copy.bytes,{flag:'wx'});copied++;}catch(e:any){if(e.code!=='EEXIST')throw e;await regular(publicRoot,copy.target);ensure(sha256(await fs.readFile(copy.target))===copy.hash,'目标音频已有不同字节，拒绝覆盖');reused++;}}
  const refs:string[]=[];const visit=(v:any)=>{if(!v||typeof v!=='object')return;for(const [k,item]of Object.entries(v)){if(k==='src'&&typeof item==='string')refs.push(item);else visit(item);}};visit(timeline);for(const ref of new Set(refs))await regular(publicRoot,ref);
  if(signal?.aborted)throw new ProductionError('PROCESS_CANCELLED','装配提交前已取消');
  ensure(sha256(await fs.readFile(planPath))===sha256(planBytes),'装配期间作者计划发生变化');
  const before=sha256(await fs.readFile(timelinePath));if(before!==currentHash)conflict(`装配期间时间线发生变化：预期 ${currentHash}，实际 ${before}，差异字段：${await changedFields(timelinePath,old)}`);
  const outputText=JSON.stringify(timeline,null,2),timelineSha256=sha256(outputText);
  const changed=timeline.scenes.filter((s:any,i:number)=>canonical({from:s.from,frames:s.frames,utterances:s.utterances.map((u:any)=>[u.id,u.startFrame,u.endFrameExclusive])})!==canonical({from:old.scenes[i].from,frames:old.scenes[i].frames,utterances:(old.scenes[i].utterances??[]).map((u:any)=>[u.id,u.startFrame,u.endFrameExclusive])})).map((s:any)=>s.id);
  const result={assemblyRequestId:input.assemblyRequestId,state:'succeeded',timelineRef,timelineSha256,sceneCount:timeline.scenes.length,utteranceCount:jobs.length,timingChangedSceneIds:changed,detailsRef:recordPath};
  const timingChanges=timeline.scenes.filter((s:any)=>changed.includes(s.id)).map((s:any)=>{const before=old.scenes.find((v:any)=>v.id===s.id);return {sceneId:s.id,before:{from:before.from,frames:before.frames,utterances:before.utterances},after:{from:s.from,frames:s.frames,utterances:s.utterances},deltaFrames:s.frames-before.frames};});
  const record={startedAt,plan,previousTimeline:old,speechJobs:jobs.map(j=>({jobId:j.id,segmentId:j.request.segmentId,audioSha256:j.sha256})),timingChanges,audioBindings:timeline.scenes.flatMap((s:any)=>s.utterances.map((u:any)=>({src:u.src,sha256:jobs.find(j=>j.request.segmentId===u.id).sha256}))),inputDigest:digest,input,runId:run.runId,state:'committing',outputText,result,previousTimelineSha256:currentHash,measurementHits:hits,measurementMisses:misses,copiedAudio:copied,reusedAudio:reused,completedAt:new Date().toISOString()};
  cancelled(signal);await writeJson(recordPath,record);
  // Run 锁只协调服务调用；提交前后仍核对作者可写文件，调用方须暂停同文件编辑。
  if(sha256(await fs.readFile(timelinePath))!==currentHash)conflict(`提交前时间线被作者修改，差异字段：${await changedFields(timelinePath,old)}；保留原装配记录供恢复`);
  await fs.writeFile(`${timelinePath}.assembly.tmp`,outputText);cancelled(signal);
  ensure(sha256(await fs.readFile(planPath))===sha256(planBytes),'提交前作者计划发生变化');
  if(sha256(await fs.readFile(timelinePath))!==currentHash)conflict(`替换前时间线发生变化，差异字段：${await changedFields(timelinePath,old)}`);
  await fs.rename(`${timelinePath}.assembly.tmp`,timelinePath);
  if(sha256(await fs.readFile(timelinePath))!==timelineSha256)conflict('提交后时间线被并发修改，请读取原装配记录与当前稿');
  cancelled(signal);await writeJson(recordPath,{...record,state:'succeeded'});return result;
}
