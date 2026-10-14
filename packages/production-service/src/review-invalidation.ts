import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { canonical, sha256, ProductionError } from './contracts.js';

export type ReviewSnapshot={sourceDigest:string;timeline:any;timelineRef:string;files:Record<string,string>};
export type ReviewChange={sceneIds:string[];checkIds:string[];reason:string};
const visual=['visual-layout','caption-layout','caption-reading','motion','av-sync','continuity'];
const all=[...visual,'audio'];
export async function snapshotFiles(root:string){
  const result:Record<string,string>={};
  async function walk(directory:string){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    if(['node_modules','.cache'].includes(entry.name))continue;const path=join(directory,entry.name);
    if(entry.isSymbolicLink())throw new ProductionError('LINK_FORBIDDEN','审片快照不得包含链接');
    if(entry.isDirectory())await walk(path);else result[relative(root,path).replaceAll('\\','/')]=sha256(await fs.readFile(path));
  }}await walk(root);return result;
}
const same=(a:unknown,b:unknown)=>canonical(a??null)===canonical(b??null);
/** 只理解已发布的时间线结构；未知源码保守扩大视觉，绝不推断通用代码依赖。 */
export function compareReviewSnapshots(before:ReviewSnapshot,after:ReviewSnapshot):ReviewChange[]{
  if(before.sourceDigest===after.sourceDigest)return [];
  const scenes=after.timeline.scenes as any[],ids=scenes.map(s=>s.id),changes:ReviewChange[]=[];
  const push=(sceneIds:string[],checkIds:string[],reason:string)=>changes.push({sceneIds,checkIds,reason});
  if(before.timeline.fps!==after.timeline.fps||before.timeline.totalFrames!==after.timeline.totalFrames||!same(before.timeline.scenes.map((s:any)=>s.id),ids))push(ids,all,'全局时长、帧率或分镜结构改变');
  for(const scene of scenes){
    const previous=before.timeline.scenes.find((s:any)=>s.id===scene.id);
    if(!previous){push([scene.id],all,'新增真实分镜');continue;}
    if(previous.from!==scene.from||previous.frames!==scene.frames){push([scene.id],all,'场景全局摆放或持续时间改变');continue;}
    if(!same(previous.utterances,scene.utterances))push([scene.id],all,'实际配音绑定或句段时间改变');
    if(!same(previous.captions,scene.captions)){
      const timing=(s:any)=>s.captions?.map((c:any)=>[c.startFrame,c.endFrameExclusive,c.utteranceId]);
      push([scene.id],same(timing(previous),timing(scene))?['caption-layout','caption-reading']:['caption-layout','caption-reading','av-sync','continuity'],'字幕内容、断行或换卡时序改变');
    }
    const rest=({captions,utterances,...value}:any)=>value;
    if(!same(rest(previous),rest(scene)))push([scene.id],visual,'本场景图形、动作或其他数据改变');
  }
  const top=({scenes,...value}:any)=>value;
  if(!same(top(before.timeline),top(after.timeline)))push(ids,all,'共享时间线参数或跨章关系改变');
  const changed=[...new Set([...Object.keys(before.files),...Object.keys(after.files)])].filter(path=>before.files[path]!==after.files[path]&&path!==before.timelineRef&&path!==after.timelineRef);
  // 对音频使用时间线中真实 src 引用定位；其他未解释文件不能由作者声明缩小影响。
  for(const path of changed){
    const affected=scenes.filter(s=>s.utterances?.some((u:any)=>typeof u.src==='string'&&(path===u.src||path.endsWith(`/public/${u.src}`)))).map(s=>s.id);
    if(affected.length)push(affected,['audio','av-sync','caption-reading','continuity'],'当前配音文件字节改变');
    else push(ids,/\.(wav|mp3|aac|m4a|flac|ogg)$/i.test(path)?all:visual,`未能可靠归属的共享文件改变：${path}`);
  }
  return changes;
}
