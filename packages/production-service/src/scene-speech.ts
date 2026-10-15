import {ProductionError,sceneSchema,type RenderRequest} from './contracts.js';
type Scene=RenderRequest['dataList'][number];
export const isVisualScene=(scene:Scene)=>scene.directing?.kind==='visual';
export function visualSceneFrames(scene:Scene,fps:number){
  sceneSchema.parse(scene);
  if(!isVisualScene(scene))throw new ProductionError('SCENE_KIND_INVALID',`${scene.id} 未声明无口播`);
  return Math.ceil(scene.directing!.durationSec!*fps);
}
import type {TemplatePerformanceContract} from './template-package.js';
const normalized=(v:string)=>v.replace(/\s+/gu,'');
/** 按已确认发言边界逐段消费；返回的绑定同时用于装配与核验。 */
export function speechBindings(scene:Scene,segments:Array<{id:string;text:string;voiceRef?:string;speaker?:string;turnId?:string}>,checkSpeaker=false,template:TemplatePerformanceContract={}){
  const fail=(message:string):never=>{throw new ProductionError('SPEECH_BINDING_INVALID',`${scene.id}：${message}`);};
  sceneSchema.parse(scene);
  if(isVisualScene(scene)){if(segments.length)fail('无口播画面不能带配音');return [];}
  if(!segments.length||normalized(segments.map(s=>s.text).join(''))!==normalized(scene.content))fail('配音正文或顺序与确认稿不一致');
  const turns=scene.directing?.speechTurns;
  if(!turns)return segments.map(()=>undefined);
  let turnIndex=0,offset=0;
  return segments.map(segment=>{
    const turn=turns[turnIndex],text=normalized(segment.text);
    if(!turn||!text)fail(`${segment.id} 不属于有效发言`);
    const expected=normalized(scene.content.slice(turn.start,turn.end));
    if(!expected.startsWith(text,offset))fail(`${segment.id} 改字或跨越人物发言边界`);
    const binding=turn.speakerId?template.speakerBindings?.[turn.speakerId]:undefined;
    if(turn.speakerId&&!binding)fail(`${turn.id} 未知模板人物 ${turn.speakerId}`);
    if(binding&&segment.voiceRef!==undefined&&segment.voiceRef!==binding.voiceRef)fail(`${segment.id} 音色与指定人物不符`);
    if(checkSpeaker&&binding&&segment.speaker!==binding.speaker)fail(`${segment.id} 画面人物与指定人物不符`);
    if(checkSpeaker&&segment.turnId!==turn.id)fail(`${segment.id} 发言归属不符`);
    offset+=text.length;if(offset===expected.length){turnIndex++;offset=0;}
    return {turnId:turn.id,...binding};
  });
}
