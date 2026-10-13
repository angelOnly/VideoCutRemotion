import {validateRetrieval} from './taxonomy.mjs';
// 机制元数据使用 YAML 的单行 JSON 值子集，网页与索引构建共用同一解析规则。
export function splitDocument(text){
  const match=text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if(!match)return {metadata:null,body:text};
  const metadata={};
  for(const line of match[1].split(/\r?\n/)){
    if(!line.trim())continue;
    const entry=line.match(/^([a-z_]+):\s*(.+)$/);
    if(!entry||Object.hasOwn(metadata,entry[1]))throw new Error('机制元数据格式错误或字段重复');
    try{metadata[entry[1]]=JSON.parse(entry[2]);}catch{throw new Error('机制元数据值必须是单行 JSON');}
  }
  return {metadata,body:text.slice(match[0].length)};
}

export function parseMechanism(text){
  const result=splitDocument(text),m=result.metadata;
  if(!m)throw new Error('机制文档缺少元数据');
  for(const key of ['id','title','summary','purpose','relation','start_state','end_state']){
    if(typeof m[key]!=='string'||!m[key].trim())throw new Error(`机制缺少 ${key}`);
  }
  if(!Number.isSafeInteger(m.case_number)||m.case_number<1)throw new Error('原片编号无效');
  if(!new RegExp(`^${String(m.case_number).padStart(3,'0')}-m\\d{2}$`).test(m.id))throw new Error('机制编号与原片不符');
  if(!Array.isArray(m.tags)||!m.tags.length||m.tags.some(t=>typeof t!=='string'||!t.trim()))throw new Error('机制标签无效');
  validateRetrieval(m.retrieval,m.id);
  if(m.clip){
    const c=m.clip;
    if(typeof c!=='object'||Array.isArray(c)||!Number.isSafeInteger(c.start_ms)||c.start_ms<0||!Number.isSafeInteger(c.end_ms)||c.end_ms<=c.start_ms
      ||!Number.isSafeInteger(c.bytes)||c.bytes<=0||typeof c.path!=='string'||!/^cases\/[a-zA-Z0-9-]+\/mechanisms\/m\d{2}\.mp4$/.test(c.path)
      ||![c.sha256,c.source_sha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||typeof c.boundary_note!=='string'||!c.boundary_note.trim())throw new Error(`${m.id} 切片元数据无效`);
  }
  return result;
}

export function resolveLibraryLink(href,documentPath){
  if(/^https?:\/\//i.test(href))return {kind:'external',href};
  if(/^[a-z][a-z\d+.-]*:/i.test(href)||href.startsWith('/')||href.includes('\\'))return null;
  const root=new URL('https://reference.invalid/library/');
  const url=new URL(href,new URL(documentPath,root));
  if(url.origin!==root.origin||!url.pathname.startsWith(root.pathname))return null;
  const path=decodeURIComponent(url.pathname.slice(root.pathname.length));
  if(path.split('/').some(p=>p==='..'||p==='.')||path.includes('\\'))return null;
  if(!/\.(md|jpg|jpeg|png|webp|mp4)$/i.test(path))return null;
  return {kind:'local',path,hash:url.hash};
}
