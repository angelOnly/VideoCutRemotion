import {ProductionError,sceneSchema,type RenderRequest} from './contracts.js';

/** 网页仍只传当前文本；仅解释明确的标签，不猜人物，也不删除普通括号。 */
export function parseSceneScript(scene:{id:string;content:string}):RenderRequest['dataList'][number]{
  const submittedContent=scene.content;
  if(!/[【】]/u.test(submittedContent))return sceneSchema.parse({id:scene.id,content:submittedContent});
  const fail=(message:string):never=>{throw new ProductionError('SCRIPT_TAG_INVALID',`${scene.id}：${message}`);};
  let content='',speakerId:string|null=null,cursor=0,durationSec:number|undefined,chapter:string|undefined;
  const speechTurns:Array<{id:string;speakerId:string|null;start:number;end:number}>=[],visualDirections:string[]=[];
  const append=(part:string)=>{
    if(/[【】]/u.test(part))fail('标签括号不完整，请检查【】');
    if(!part.trim())return; // 标签之间的排版空行不构成发言。
    const start=content.length;content+=part;
    const previous=speechTurns.at(-1);
    if(previous?.speakerId===speakerId)previous.end=content.length;
    else speechTurns.push({id:`turn_${speechTurns.length+1}`,speakerId,start,end:content.length});
  };
  for(const match of submittedContent.matchAll(/【([^【】]*)】/gu)){
    append(submittedContent.slice(cursor,match.index));cursor=match.index!+match[0].length;
    const label=match[1].trim();
    if(label==='财小策'||label==='室长'){speakerId=label==='财小策'?'caixiaoce':'shizhang';continue;}
    const direction=/^画面\s*[:：]\s*(.+)$/su.exec(label);
    if(direction){visualDirections.push(direction[1].trim());continue;}
    const title=/^章节\s*[:：]\s*(.+)$/su.exec(label);
    if(title){if(chapter!==undefined)fail('同一分镜只能有一个章节标签');chapter=title[1].trim();continue;}
    const visual=/^无口播\s*[:：]\s*(\d+(?:\.\d+)?)\s*秒$/u.exec(label);
    if(visual){if(durationSec!==undefined)fail('同一分镜只能有一个无口播时长');durationSec=Number(visual[1]);continue;}
    fail(`无法识别标签【${label}】，请使用人物、画面、章节或无口播标签`);
  }
  append(submittedContent.slice(cursor));
  if(durationSec!==undefined&&content.trim())fail('无口播分镜不能同时包含台词');
  if(!content.trim()&&durationSec===undefined)fail('纯画面需要明确时长，例如【无口播：3秒】');
  // 内部范围从本次文本重新计算，绝不套用 Analysis 的旧偏移。
  return sceneSchema.parse({id:scene.id,content,submittedContent,directing:{
    kind:durationSec===undefined?'speech':'visual',speechTurns,visualDirections,
    ...(chapter===undefined?{}:{chapter}),...(durationSec===undefined?{}:{durationSec})
  }});
}
