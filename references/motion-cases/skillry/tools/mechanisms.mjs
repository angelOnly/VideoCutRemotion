/** 保留原机制维护 CLI；普通后台只发行纯索引模块。 */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {queryMechanisms} from '../mechanism-search.mjs';
import {buildIndex,loadIndex} from './mechanism-index.mjs';
export {buildIndex,loadIndex,localFile,mechanismSearchText,SEARCH_TEXT_VERSION} from './mechanism-index.mjs';
const defaultRoot=resolve(process.cwd(),'references/motion-cases/skillry');
export function selectMechanisms(index,{offset=0,limit=20,ids=null}={}){
  if(ids){
    if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)throw new Error('机制编号无效或重复');
    const byId=new Map(index.mechanisms.map(m=>[m.id,m]));
    for(const id of ids)if(!byId.has(id))throw new Error(`未知机制：${id}`);
    return {scope:index.scope,source_sha256:index.source_sha256,total:index.count,cards:ids.map(id=>byId.get(id)),notice:'仅返回指定机制，正文及分镜按需读取。'};
  }
  if(!Number.isSafeInteger(offset)||offset<0||offset>index.count||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('分页范围无效');
  const cards=index.mechanisms.slice(offset,offset+limit),next=offset+cards.length;
  return {scope:index.scope,source_sha256:index.source_sha256,total:index.count,offset,next_offset:next<index.count?next:null,exhausted:next>=index.count,cards,notice:'语义理解由模型完成；本脚本不排名、不读取视频。'};
}
export function main(args){
  const path=resolve(defaultRoot,'mechanism-index.json');
  if(args.length===1&&['--build','--check'].includes(args[0])){
    const value=JSON.stringify(buildIndex(),null,2)+'\n';
    if(args[0]==='--build'){writeFileSync(path,value);process.stdout.write('机制索引已更新\n');}
    else if(!existsSync(path)||readFileSync(path,'utf8')!==value)throw new Error('机制索引过期，请重新生成');
    else process.stdout.write('机制索引与文档一致\n');
    return;
  }
  if(args[0]==='--request'&&args.length===2){
    process.stdout.write(JSON.stringify(queryMechanisms(loadIndex(),JSON.parse(args[1])),null,2)+'\n');return;
  }
  const options={},seen=new Set();
  for(let i=0;i<args.length;i+=2){
    const key=args[i],v=args[i+1];
    if(!['--offset','--limit','--ids'].includes(key)||seen.has(key)||v===undefined)throw new Error('仅支持 --build、--check，或 --offset N --limit N / --ids 002-m16');
    seen.add(key);
    if(key==='--ids')options.ids=v.split(',').map(s=>s.trim());
    else {if(!/^\d+$/.test(v))throw new Error('分页必须为非负整数');options[key.slice(2)]=Number(v);}
  }
  if(options.ids&&(seen.has('--offset')||seen.has('--limit')))throw new Error('编号定位不能混用分页');
  const index=loadIndex();
  process.stdout.write(JSON.stringify(selectMechanisms(index,options),null,2)+'\n');
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/tools/mechanisms.mjs')){
  try{main(process.argv.slice(2));}catch(e){process.stderr.write(e.message+'\n');process.exitCode=1;}
}
