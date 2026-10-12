/**
 * 为模型主导的参考检索提供只读卡片；不排序、不调用模型、不写文件。
 * 卡片来自唯一索引，分页不会先按关键词排除候选。
 */
import {readFileSync, realpathSync, existsSync} from 'node:fs';
import {resolve, dirname, isAbsolute, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const fields = ['case_number','slug','title','original_form','video_types','scenario',
  'scenes','materials','methods','art','material_requirements','transfer_cost',
  'analysis','media','recommended_segments'];

function int(value, label, min, max=Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} 必须是整数`);
  const n=Number(value);
  if (!Number.isSafeInteger(n) || n<min || n>max) throw new Error(`${label} 必须位于范围 [${min}, ${max}]`);
  return n;
}
function safeRelativePath(value, field, root) {
  if (typeof value!=='string' || !value || value.includes('\0') || value.includes('\\') || value.includes(':') || isAbsolute(value)) {
    throw new Error(`${field} 路径无效`);
  }
  const parts=value.split('/');
  if (parts.some(p=>p==='..'||p==='.'||!p)) throw new Error(`${field} 路径包含非法分段`);
  const absolute=resolve(root,value);
  const rel=relative(root,absolute);
  if (rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)) throw new Error(`${field} 超出索引目录`);
  // 媒体尚不存在时也检查最近的现存父目录，防止目录链接绕过边界。
  let existing=absolute;
  while (!existsSync(existing) && existing!==root) existing=dirname(existing);
  const realRel=relative(realpathSync(root),realpathSync(existing));
  if (realRel==='..'||realRel.startsWith('..'+sep)||isAbsolute(realRel)) throw new Error(`${field} 符号链接超出索引目录`);
}
export function loadCards(cataloguePath) {
  const absolute=resolve(cataloguePath);
  const bytes=readFileSync(absolute);
  let catalogue;
  try { catalogue=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw new Error('索引不是有效的 UTF-8 JSON'); }
  if (!catalogue || !Array.isArray(catalogue.cases)) throw new Error('索引必须包含 cases 数组');
  if (catalogue.count!==undefined && catalogue.count!==catalogue.cases.length) throw new Error('声明数量与 cases 长度不一致');
  const numbers=new Set(), slugs=new Set();
  const root=dirname(absolute);
  const cases=catalogue.cases.map(c=>{
    if (!c || typeof c!=='object' || Array.isArray(c)) throw new Error('案例记录无效');
    if (!Number.isSafeInteger(c.case_number)||c.case_number<1||numbers.has(c.case_number)) throw new Error('案例编号无效或重复');
    if (typeof c.slug!=='string'||!c.slug||slugs.has(c.slug)) throw new Error('slug 无效或重复');
    if (typeof c.title!=='string'||typeof c.scenario!=='string') throw new Error('缺少案例标题或场景描述');
    for (const key of ['video_types','scenes','materials','methods','art']) {
      if (c[key]!==undefined && (!Array.isArray(c[key])||c[key].some(v=>typeof v!=='string'))) throw new Error(`${key} 字段无效`);
    }
    for (const key of ['original_form','material_requirements','transfer_cost']) {
      if (c[key]!==undefined && typeof c[key]!=='string') throw new Error(`${key} 字段无效`);
    }
    if (c.duration!==undefined && (!Number.isFinite(c.duration)||c.duration<=0)) throw new Error('案例时长必须是正数');
    safeRelativePath(c.analysis,'analysis',root); safeRelativePath(c.media,'media',root);
    if (c.recommended_segments!==undefined) {
      if (!Array.isArray(c.recommended_segments)) throw new Error('推荐源范围无效');
      for (const segment of c.recommended_segments) {
        if (!segment || typeof segment!=='object' || !Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.end<=segment.start) throw new Error('源片段范围无效');
        if (Number.isFinite(c.duration)&&segment.end>c.duration) throw new Error('源片段超出视频时长');
      }
    }
    numbers.add(c.case_number); slugs.add(c.slug);
    // 按原顺序投影已知字段，不改写、裁短或补造标签。
    return Object.fromEntries(fields.filter(key=>Object.hasOwn(c,key)).map(key=>[key,c[key]]));
  });
  return {catalogue_path:absolute,catalogue_sha256:createHash('sha256').update(bytes).digest('hex'),
    total:cases.length,path_base:root,cases};
}
export function selectCards(loaded,options={}) {
  let {offset=0,limit=20,ids=null}=options;
  if (ids!==null) {
    if (Object.hasOwn(options,'offset')||Object.hasOwn(options,'limit')) throw new Error('编号查找不能同时指定分页');
    if (!Array.isArray(ids)||!ids.length||ids.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(ids).size!==ids.length) throw new Error('请求编号无效或重复');
    const byId=new Map(loaded.cases.map(c=>[c.case_number,c]));
    const missing=ids.filter(n=>!byId.has(n));
    if (missing.length) throw new Error(`未知案例编号： ${missing.join(',')}`);
    return {mode:'by_id',catalogue_path:loaded.catalogue_path,catalogue_sha256:loaded.catalogue_sha256,
      total:loaded.total,path_base:loaded.path_base,requested_ids:ids,returned:ids.length,
      notice:'仅返回指定编号的原始记录。语义判断由模型执行；按编号读取不代表全库覆盖。',
      cards:ids.map(n=>byId.get(n))};
  }
  offset=int(offset,'offset',0); limit=int(limit,'limit',1,50);
  if (offset>loaded.total) throw new Error('offset 超出索引长度');
  const cards=loaded.cases.slice(offset,offset+limit);
  const next=offset+cards.length;
  return {mode:'page',catalogue_path:loaded.catalogue_path,catalogue_sha256:loaded.catalogue_sha256,
    total:loaded.total,path_base:loaded.path_base,offset,returned:cards.length,
    next_offset:next<loaded.total?next:null,exhausted:next>=loaded.total,
    notice:'未执行关键词过滤、语义推断、排序或媒体审阅。须实际读完返回字段才能声明覆盖。',cards};
}
export function main(argv) {
  const options={};
  const seen=new Set();
  for (let i=0;i<argv.length;i+=2) {
    const key=argv[i];
    if (!['--catalogue','--offset','--limit','--ids'].includes(key)||seen.has(key)||i+1>=argv.length) throw new Error('参数仅支持 --catalogue PATH、--offset N、--limit 1..50 或 --ids 12,60');
    seen.add(key); options[key]=argv[i+1];
  }
  if (seen.has('--ids')&&(seen.has('--offset')||seen.has('--limit'))) throw new Error('编号查找与分页不能同时使用');
  const path=options['--catalogue']??fileURLToPath(new URL('../case-catalogue.json',import.meta.url));
  const ids=seen.has('--ids')?options['--ids'].split(',').map(s=>int(s.trim(),'id',1)):null;
  const result=selectCards(loadCards(path),ids!==null?{ids}:{
    offset:seen.has('--offset')?int(options['--offset'],'offset',0):0,
    limit:seen.has('--limit')?int(options['--limit'],'limit',1,50):20});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {main(process.argv.slice(2));}
  catch (error) {process.stderr.write(`read-case-cards: ${error.message}\n`);process.exitCode=1;}
}
