import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { canonical, sha256, ProductionError } from './contracts.js';

export type ReviewSnapshot={sourceDigest:string;timeline:any;timelineRef:string;files:Record<string,string>};
export async function snapshotFiles(root:string){
  const result:Record<string,string>={};
  async function walk(directory:string){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    if(['node_modules','.cache'].includes(entry.name))continue;const path=join(directory,entry.name);
    if(entry.isSymbolicLink())throw new ProductionError('LINK_FORBIDDEN','审片快照不得包含链接');
    if(entry.isDirectory())await walk(path);else result[relative(root,path).replaceAll('\\','/')]=sha256(await fs.readFile(path));
  }}await walk(root);return result;
}
const same=(a:unknown,b:unknown)=>canonical(a??null)===canonical(b??null);
/** 只报告版本差异事实，专业影响与复查范围由 Codex 选择。 */
export function compareReviewSnapshots(before:ReviewSnapshot,after:ReviewSnapshot){
  const changedFiles=[...new Set([...Object.keys(before.files),...Object.keys(after.files)])].filter(path=>before.files[path]!==after.files[path]);
  const sceneIds=[...new Set([...(before.timeline.scenes??[]),...(after.timeline.scenes??[])].map((s:any)=>s.id))] as string[];
  const changedScenes=sceneIds.flatMap(sceneId=>{
    const a=before.timeline.scenes.find((s:any)=>s.id===sceneId),b=after.timeline.scenes.find((s:any)=>s.id===sceneId);
    if(same(a,b))return [];
    const fields=[...new Set([...Object.keys(a??{}),...Object.keys(b??{})])].filter(key=>!same(a?.[key],b?.[key]));
    return [{sceneId,fields,kind:!a?'added':!b?'removed':'changed'}];
  });
  const changedTimelineFields=[...new Set([...Object.keys(before.timeline),...Object.keys(after.timeline)])].filter(key=>key!=='scenes'&&!same(before.timeline[key],after.timeline[key]));
  if(!same(before.timeline.scenes.map((s:any)=>s.id),after.timeline.scenes.map((s:any)=>s.id)))changedTimelineFields.push('sceneOrder');
  return {changedFiles,changedScenes,changedTimelineFields};
}
