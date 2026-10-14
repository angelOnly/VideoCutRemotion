/** 从机制 Markdown 派生索引，查询与 MCP 共用本地排序。 */
import {readFileSync,readdirSync,realpathSync,statSync} from 'node:fs';
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
