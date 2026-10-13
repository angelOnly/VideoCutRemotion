/** 从机制 Markdown 派生索引，查询与 MCP 共用本地排序。 */
import {readFileSync,writeFileSync,readdirSync,existsSync,realpathSync,statSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {parseMechanism,resolveLibraryLink} from '../document-format.mjs';
import {taxonomy} from '../taxonomy.mjs';
import {queryMechanisms} from '../mechanism-search.mjs';
// CLI 与正式启动器都从仓库根运行，避免 CJS 发行包依赖 import.meta。
const defaultRoot=resolve(process.cwd(),'references/motion-cases/skillry');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const SEARCH_TEXT_VERSION='motion-relations-v1';
/** 仅派生动作正文；链接、图片和网页外壳不参与语义相似性。 */
export function mechanismSearchText(metadata,body){
  body=body.replace(/\r\n?/g,'\n');
  const sections=[...body.matchAll(/^## (运动指令|组合与调整)[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map(match=>match[2]);
  const lines=[metadata.purpose,metadata.relation,metadata.start_state,...sections,metadata.end_state]
    .join('\n').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').split(/\n+/).map(line=>line.trim()).filter(Boolean);
  return [...new Set(lines)].join('\n');
}
export function localFile(root,path){
  if(typeof path!=='string'||!path||path.includes(':')||path.includes('\\')||isAbsolute(path)||path.split('/').some(p=>p==='..'||p==='.'||!p))throw new Error('资料路径无效');
  const file=resolve(root,path),rel=relative(realpathSync(root),realpathSync(file));
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('资料路径越界');
  return file;
}
export function buildIndex(root=defaultRoot){
  const catalogueBytes=readFileSync(localFile(root,'case-catalogue.json'));
  const catalogue=JSON.parse(catalogueBytes.toString('utf8'));
  const mechanisms=[],sources=[['catalogue',hash(catalogueBytes)],['taxonomy',hash(JSON.stringify(taxonomy))]];
  for(const c of catalogue.cases.filter(c=>c.analysis_kind==='mechanisms-v1')){
    const dir=localFile(root,c.directory+'/mechanisms');
    const files=readdirSync(dir).filter(f=>f.endsWith('.md')).sort();
    if(!files.length)throw new Error(`${c.case_number} 没有机制文档`);
    for(const name of files){
      const document=c.directory+'/mechanisms/'+name;
      const bytes=readFileSync(localFile(root,document));
      const {metadata:m,body}=parseMechanism(bytes.toString('utf8'));
      if(m.case_number!==c.case_number||name!==m.id.split('-')[1]+'.md')throw new Error(`${document} 编号与路径不符`);
      const storyboard=document.replace(/\.md$/,'.jpg');localFile(root,storyboard);
      if(m.clip){
        // 只接纳当前原片、同机制的实际切片；索引不复制媒体或维护第二套边界表。
        if(m.clip.path!==document.replace(/\.md$/,'.mp4')||m.clip.source_sha256!==c.media_sha256||m.clip.end_ms>Math.ceil(c.duration*1000))throw new Error(`${m.id} 切片来源、范围或路径不符`);
        if(statSync(localFile(root,m.clip.path)).size!==m.clip.bytes)throw new Error(`${m.id} 切片文件不完整`);
      }
      const imageLinks=[...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(x=>resolveLibraryLink(x[1],document));
      if(!imageLinks.some(x=>x?.kind==='local'&&x.path===storyboard))throw new Error(`${document} 未嵌入自身分镜`);
      sources.push([document,hash(bytes)]);
      const search_text=mechanismSearchText(m,body);
      mechanisms.push({...m,search_text,search_text_version:SEARCH_TEXT_VERSION,text_sha256:hash(search_text),document,storyboard,case_slug:c.slug,overview:c.analysis,
        detail:`detail.html?case=${encodeURIComponent(c.slug)}&mechanism=${encodeURIComponent(m.id)}`});
    }
  }
  if(new Set(mechanisms.map(m=>m.id)).size!==mechanisms.length)throw new Error('机制编号重复');
  // 覆盖范围随目录声明计算，后续扩充案例不再维护一份手写数量。
  const converted=catalogue.cases.filter(c=>c.analysis_kind==='mechanisms-v1');
  const scope=converted.length===catalogue.cases.length
    ? `已整理 ${converted.length} / ${catalogue.cases.length} 个案例；全部案例均已转换，共 ${mechanisms.length} 条独立机制`
    : `已整理 ${converted.length} / ${catalogue.cases.length} 个案例（${converted.map(c=>String(c.case_number).padStart(3,'0')).join('、')}）；其余 ${catalogue.cases.length-converted.length} 个尚未转换`;
  return {schema_version:2,scope,source_sha256:hash(JSON.stringify(sources)),count:mechanisms.length,mechanisms};
}
export function loadIndex(root=defaultRoot){
  const index=JSON.parse(readFileSync(localFile(root,'mechanism-index.json'),'utf8'));
  const actual=buildIndex(root);
  if(JSON.stringify(index)!==JSON.stringify(actual))throw new Error('机制索引过期或损坏，请维护者重新生成；本次未返回旧结果');
  return index;
}
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
