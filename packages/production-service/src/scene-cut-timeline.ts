import {isVisualScene,visualSceneFrames} from './scene-speech.js';
import { join } from 'node:path';
import { ProductionError, sha256, type RenderRequest } from './contracts.js';
import { json, regular } from './files.js';

type SceneRange={id:string;fromFrame:number;toFrame:number};
export type AudioAuditEvidence=Record<string,{timelineSha256:string}>;
function ensure(value:unknown,message:string):asserts value{if(!value)throw new ProductionError('CUT_TIMELINE_INVALID',message);}

/** 从当前模板的全局分镜范围取切点，句段仅校核归属，不改变业务分镜数量。 */
export function sceneRangesFromTimeline(timeline:any,expected:RenderRequest['dataList'],total:number,fps:number):SceneRange[]{
  ensure(timeline?.fps===fps&&timeline.totalFrames===total,'时间轴与整片规格不一致');
  ensure(Array.isArray(timeline.scenes)&&timeline.scenes.length===expected.length,'时间轴与确认分镜数量不一致');
  let previous=0;
  return timeline.scenes.map((scene:any,index:number)=>{
    ensure(scene.id===expected[index].id,'时间轴分镜编号或顺序与确认稿不一致');
    ensure(Number.isInteger(scene.from)&&scene.from===previous&&Number.isInteger(scene.frames)&&scene.frames>0,'分镜全局范围必须连续且完整');
    const end=scene.from+scene.frames;
    ensure(end<=total,'分镜超出整片');
    ensure(Array.isArray(scene.utterances)&&(isVisualScene(expected[index])?scene.utterances.length===0:scene.utterances.length>0),'分段输出的句段须与口播类型一致');
    if(isVisualScene(expected[index]))ensure(scene.frames===visualSceneFrames(expected[index],fps),'无口播分镜时长与确认稿不同');
    let speechEnd=0;
    for(const utterance of scene.utterances){
      ensure(Number.isInteger(utterance.startFrame)&&Number.isInteger(utterance.endFrameExclusive)&&utterance.startFrame>=speechEnd&&utterance.endFrameExclusive>utterance.startFrame&&utterance.endFrameExclusive<=scene.frames,'句段边界越界或重叠');
      speechEnd=utterance.endFrameExclusive;
    }
    previous=end;
    if(index===expected.length-1&&end<total){
      // 片尾归最后一个确认分镜；不能因口播结束就截掉固定包装。
      ensure(timeline.ending?.narrationEndFrame===end&&Number.isInteger(timeline.ending?.outro?.frames)&&timeline.ending.outro.frames===total-end,'整片尾部须有明确的片尾时间依据');
    }
    return {id:scene.id,fromFrame:scene.from,toFrame:index===expected.length-1?total:end};
  });
}

export async function verifyCutTimeline(root:string,project:string,timelineRef:string,sourceDigest:string,renderRequestId:string,expected:RenderRequest['dataList'],total:number,fps:number,ranges:SceneRange[]|undefined,trustedAudits?:AudioAuditEvidence){
  const timeline=await json(await regular(project,timelineRef));
  const planned=sceneRangesFromTimeline(timeline,expected,total,fps);
  if(ranges)ensure(JSON.stringify(planned)===JSON.stringify(ranges.map(({id,fromFrame,toFrame})=>({id,fromFrame,toFrame}))),'请求切点与已确认时间轴不一致');
  // 服务检查点保留真实核验凭据，作者可写的检查报告不能自行宣布审计成功。
  ensure(trustedAudits?.[sourceDigest]?.timelineSha256===sha256(JSON.stringify(timeline)),'分段输出要求服务确认同版 verify_sentence_audio 结果');
  const reports=await Promise.all([renderRequestId,'working'].map(id=>json(join(root,'checks',`sentence-audio-${id}.json`)).catch((error:any)=>{if(error.code==='ENOENT')return null;throw error;})));
  ensure(reports.some(report=>report?.sourceDigest===sourceDigest&&report.timelineSha256===sha256(JSON.stringify(timeline))),'分段输出要求同一源码版本已通过 verify_sentence_audio；请先核验当前工程');
  return planned;
}
