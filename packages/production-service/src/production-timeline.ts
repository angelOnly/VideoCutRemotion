import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { ProductionError, sha256, type RenderRequest } from './contracts.js';
import { json, regular } from './files.js';
import { validateTemplate } from './template-package.js';
import { sceneRangesFromTimeline } from './scene-cut-timeline.js';

export const SENTENCE_TIMELINE_CONTRACT='sentence-timeline/1';
const normalized=(value:string)=>value.replace(/\s+/gu,'');
function requireField(value:unknown,field:string,reason:string):asserts value {
  if(!value)throw new ProductionError('PRODUCTION_TIMELINE_INVALID',`${field}：${reason}；请修改该字段后按原流程提交`);
}

/** 视觉章节保留作者时钟；审片包单独把首末包装归入首末章。 */
export function reviewChaptersFromTimeline(timeline:any,ranges:Array<{id:string;fromFrame:number;toFrame:number}>){
  const ensure=(v:unknown,message:string)=>{if(!v)throw new ProductionError('REVIEW_CHAPTER_INVALID',`chapters：${message}`);};
  ensure(timeline.chapters===undefined||Array.isArray(timeline.chapters),'必须是数组');
  if(!timeline.chapters?.length)return undefined;
  let cursor=0;const ids=new Set<string>();
  return timeline.chapters.map((chapter:any,index:number)=>{
    const first=index===0,last=index===timeline.chapters.length-1;
    ensure(chapter&&typeof chapter.id==='string'&&chapter.id.trim()&&!ids.has(chapter.id),'编号缺失或重复');ids.add(chapter.id);
    ensure(Number.isInteger(chapter.from)&&Number.isInteger(chapter.endFrameExclusive)&&chapter.endFrameExclusive>chapter.from,'全局半开范围无效');
    const firstScene=timeline.scenes[0],intro=firstScene.intro;
    const introEnd=intro?(intro.fromFrame??0)+intro.frames:0;
    ensure(chapter.from===cursor||(first&&chapter.from===introEnd),'边界不连续或缺少明确片头依据');
    const end=last&&chapter.endFrameExclusive===timeline.ending?.narrationEndFrame?timeline.totalFrames:chapter.endFrameExclusive;
    const selected=ranges.filter(s=>s.fromFrame>=cursor&&s.toFrame<=end);
    ensure(selected.length&&selected[0].fromFrame===cursor&&selected.at(-1)!.toFrame===end&&(!last||end===timeline.totalFrames),'必须覆盖完整连续分镜，不能猜测场景内部切章');
    cursor=end;return {chapterId:chapter.id,sceneIds:selected.map(s=>s.id)};
  });
}

/** 所有入口共用便宜的结构校验，不承担创意判断，也不改写作者数据。 */
export function validateProductionTimeline(timeline:any,expected:RenderRequest['dataList'],fps:number){
  requireField(Number.isInteger(timeline?.totalFrames)&&timeline.totalFrames>0,'totalFrames','须为正整数');
  requireField(Number.isFinite(fps)&&fps>0&&timeline.fps===fps,'fps','与模板规格不一致');
  const ranges=sceneRangesFromTimeline(timeline,expected,timeline.totalFrames,fps),ids=new Set<string>();
  for(const [index,scene] of timeline.scenes.entries()){
    const field=`scenes[${index}]`,text=normalized(expected[index].content);
    requireField(Array.isArray(scene.captions)&&scene.captions.length,`${field}.captions`,'缺少字幕');
    requireField(scene.captions.every((c:any)=>typeof c.text==='string')&&normalized(scene.captions.map((c:any)=>c.text).join(''))===text,`${field}.captions.text`,'字幕与确认正文或顺序不一致');
    if(scene.utterances.every((u:any)=>typeof u.text==='string'))requireField(normalized(scene.utterances.map((u:any)=>u.text).join(''))===text,`${field}.utterances.text`,'配音正文与确认稿不同');
    for(const u of scene.utterances){requireField(typeof u.id==='string'&&u.id&&!ids.has(u.id),`${field}.utterances.id`,'句段编号缺失或重复');ids.add(u.id);}
    if(scene.captionTiming)requireField(typeof scene.captionTiming==='object'&&typeof scene.captionTiming.src==='string'&&scene.captionTiming.src.length>0&&/^[a-f0-9]{64}$/.test(scene.captionTiming.sha256),`${field}.captionTiming`,'可靠分页必须提供受管引用与 SHA256');
    let previous=0;
    for(const [i,c] of scene.captions.entries()){
      const u=scene.utterances.find((u:any)=>u.id===c.utteranceId);
      requireField(Number.isInteger(c.startFrame)&&Number.isInteger(c.endFrameExclusive)&&c.startFrame>=previous&&c.endFrameExclusive>c.startFrame&&c.endFrameExclusive<=scene.frames,`${field}.captions[${i}]`,'字幕越界、重叠或倒序');
      requireField(u&&c.startFrame>=u.startFrame&&c.endFrameExclusive<=u.endFrameExclusive,`${field}.captions[${i}].utteranceId`,'未绑定正确句段范围');previous=c.endFrameExclusive;
    }
    for(const u of scene.utterances){
      const pages=scene.captions.filter((c:any)=>c.utteranceId===u.id);
      requireField(pages.length&&(!u.text||normalized(pages.map((c:any)=>c.text).join(''))===normalized(u.text)),`${field}.captions`,'句段字幕不完整');
      requireField(scene.captionTiming||(pages.length===1&&pages[0].startFrame===u.startFrame&&pages[0].endFrameExclusive===u.endFrameExclusive),`${field}.captionTiming`,'分页或不同字幕边界须有可靠对齐依据');
    }
    if(scene.intro){const start=scene.intro.fromFrame??0,end=start+scene.intro.frames;
      requireField(Number.isInteger(start)&&start>=0&&Number.isInteger(scene.intro.frames)&&scene.intro.frames>0&&end<=scene.frames,`${field}.intro`,'片头须有实测帧数并位于场景内');
      requireField(!scene.chapter||start>=scene.chapter.frames,`${field}.intro`,'片头与章节转场重叠');
      requireField(scene.utterances.every((u:any)=>u.endFrameExclusive<=start||u.startFrame>=end),`${field}.intro`,'片头遮蔽已确认口播');
    }
  }
  if(timeline.ending?.outro){const ending=timeline.ending;
    requireField(Number.isInteger(ending.narrationEndFrame)&&Number.isInteger(ending.outro.frames)&&ending.outro.frames>0&&ending.narrationEndFrame+ending.outro.frames===timeline.totalFrames,'ending','片尾必须完整纳入总帧数');
    requireField(timeline.scenes.every((s:any)=>s.utterances.every((u:any)=>s.from+u.endFrameExclusive<=ending.narrationEndFrame)),'ending.narrationEndFrame','片尾截断口播');
  }
  return {ranges,chapters:reviewChaptersFromTimeline(timeline,ranges)};
}

export async function preflightTimeline(project:string,expected:RenderRequest['dataList'],options:{timelineRef?:string;frames?:number[]}={}){
  const manifest=await validateTemplate(project);
  const declared=manifest.timelineDataRef?join('renderer',manifest.timelineDataRef).replaceAll('\\','/'):undefined;
  if(manifest.timelineContract&&manifest.timelineContract!==SENTENCE_TIMELINE_CONTRACT)throw new ProductionError('TIMELINE_CONTRACT_UNSUPPORTED','当前服务不支持此时间线合同');
  requireField(!declared||!options.timelineRef||relative(project,join(project,options.timelineRef))===declared,'timelineRef','必须使用模板声明的唯一 JSON 数据源');
  const timelineRef=declared??options.timelineRef;
  requireField(timelineRef,'timelineRef','模板未声明时间线数据源，请提供既有 JSON 引用');
  const timeline=await json(await regular(project,timelineRef));
  const structure=validateProductionTimeline(timeline,expected,manifest.fps);
  requireField(!options.frames?.some(f=>!Number.isInteger(f)||f<0||f>=timeline.totalFrames),'frames','静帧请求越出冻结时间线');
  // 新合同校验已知资源路径；旧冻结模板保持原接口的读取能力。
  if(declared){
    const refs:string[]=[];
    const visit=(value:any)=>{if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(key==='src'&&typeof item==='string')refs.push(item);else visit(item);}};
    visit(timeline);for(const ref of new Set(refs))await regular(join(project,'renderer',manifest.publicAssetRoot),ref);
  }
  for(const scene of timeline.scenes){
    if(!scene.captionTiming)continue;
    const publicRoot=join(project,'renderer',manifest.publicAssetRoot),bytes=await fs.readFile(await regular(publicRoot,scene.captionTiming.src));
    requireField(sha256(bytes)===scene.captionTiming.sha256,`${scene.id}.captionTiming.sha256`,'对齐文件摘要不符');
    const aligned=JSON.parse(bytes.toString('utf8'));
    requireField(['provider_timestamps','forced_alignment','reviewed_timestamps'].includes(aligned.method),`${scene.id}.captionTiming.method`,'不支持按字数比例猜测分页');
    for(const u of scene.utterances){
      const record=aligned.utterances?.[u.id],pages=scene.captions.filter((c:any)=>c.utteranceId===u.id).map(({text,startFrame,endFrameExclusive}:any)=>({text,startFrame,endFrameExclusive}));
      requireField(record?.audioSha256===sha256(await fs.readFile(await regular(publicRoot,u.src)))&&JSON.stringify(record.captions)===JSON.stringify(pages),`${scene.id}.captionTiming.${u.id}`,'对齐记录没有绑定当前音频与真实分页');
    }
  }
  return {timeline,timelineRef,manifest,...structure};
}
