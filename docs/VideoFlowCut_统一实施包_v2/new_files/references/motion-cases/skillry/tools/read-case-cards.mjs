/**
 * Proposed read-only data adapter for the model-led reference Skill.
 * It does NOT perform semantic retrieval, rank candidates, call an LLM, or write files.
 * Target: references/motion-cases/skillry/tools/read-case-cards.mjs
 */
import {readFileSync, realpathSync, existsSync} from 'node:fs';
import {resolve, dirname, isAbsolute, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const fields = ['case_number','slug','title','original_form','video_types','scenario',
  'scenes','materials','methods','art','material_requirements','transfer_cost',
  'analysis','media','recommended_segments'];

function int(value, label, min, max=Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be an integer`);
  const n=Number(value);
  if (!Number.isSafeInteger(n) || n<min || n>max) throw new Error(`${label} must be in [${min}, ${max}]`);
  return n;
}
function safeRelativePath(value, field, root) {
  if (typeof value!=='string' || !value || value.includes('\\') || value.includes(':') || isAbsolute(value)) {
    throw new Error(`Invalid ${field} path`);
  }
  const parts=value.split('/');
  if (parts.some(p=>p==='..'||p==='.'||!p)) throw new Error(`Invalid ${field} path segments`);
  const absolute=resolve(root,value);
  const rel=relative(root,absolute);
  if (rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)) throw new Error(`${field} escapes the catalogue directory`);
  // Existing symlinks must also stay under the real catalogue directory.
  if (existsSync(absolute)) {
    const realRel=relative(realpathSync(root),realpathSync(absolute));
    if (realRel==='..'||realRel.startsWith('..'+sep)||isAbsolute(realRel)) throw new Error(`${field} symlink escapes the catalogue directory`);
  }
}
export function loadCards(cataloguePath) {
  const absolute=resolve(cataloguePath);
  const bytes=readFileSync(absolute);
  let catalogue;
  try { catalogue=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')); }
  catch { throw new Error('Catalogue is not valid UTF-8 JSON'); }
  if (!Array.isArray(catalogue.cases)) throw new Error('Catalogue must have a cases array');
  if (catalogue.count!==undefined && catalogue.count!==catalogue.cases.length) throw new Error('Declared count differs from cases length');
  const numbers=new Set(), slugs=new Set();
  const root=dirname(absolute);
  const cases=catalogue.cases.map(c=>{
    if (!c || typeof c!=='object' || Array.isArray(c)) throw new Error('Invalid case record');
    if (!Number.isSafeInteger(c.case_number)||c.case_number<1||numbers.has(c.case_number)) throw new Error('Invalid or duplicate case_number');
    if (typeof c.slug!=='string'||!c.slug||slugs.has(c.slug)) throw new Error('Invalid or duplicate slug');
    if (typeof c.title!=='string'||typeof c.scenario!=='string') throw new Error('Missing case title or scenario');
    for (const key of ['video_types','scenes','materials','methods','art']) {
      if (c[key]!==undefined && (!Array.isArray(c[key])||c[key].some(v=>typeof v!=='string'))) throw new Error(`Invalid ${key}`);
    }
    safeRelativePath(c.analysis,'analysis',root); safeRelativePath(c.media,'media',root);
    if (c.recommended_segments!==undefined) {
      if (!Array.isArray(c.recommended_segments)) throw new Error('Invalid recommended_segments');
      for (const segment of c.recommended_segments) {
        if (!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.end<=segment.start) throw new Error('Invalid source segment');
        if (Number.isFinite(c.duration)&&segment.end>c.duration) throw new Error('Source segment exceeds duration');
      }
    }
    numbers.add(c.case_number); slugs.add(c.slug);
    // Lossless projection of known fields: no rewriting, clipping, inferred labels or ranking.
    return Object.fromEntries(fields.filter(key=>Object.hasOwn(c,key)).map(key=>[key,c[key]]));
  });
  return {catalogue_path:absolute,catalogue_sha256:createHash('sha256').update(bytes).digest('hex'),
    total:cases.length,path_base:root,cases};
}
export function selectCards(loaded,{offset=0,limit=20,ids=null}={}) {
  if (ids!==null) {
    if (!Array.isArray(ids)||!ids.length||ids.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(ids).size!==ids.length) throw new Error('Invalid or duplicate requested IDs');
    const byId=new Map(loaded.cases.map(c=>[c.case_number,c]));
    const missing=ids.filter(n=>!byId.has(n));
    if (missing.length) throw new Error(`Unknown case IDs: ${missing.join(',')}`);
    return {mode:'by_id',catalogue_path:loaded.catalogue_path,catalogue_sha256:loaded.catalogue_sha256,
      total:loaded.total,path_base:loaded.path_base,requested_ids:ids,returned:ids.length,
      notice:'Exact source records only. Semantic judgment is performed by the model; by-ID output is not full-catalogue coverage.',
      cards:ids.map(n=>byId.get(n))};
  }
  offset=int(offset,'offset',0); limit=int(limit,'limit',1,50);
  if (offset>loaded.total) throw new Error('offset exceeds catalogue length');
  const cards=loaded.cases.slice(offset,offset+limit);
  const next=offset+cards.length;
  return {mode:'page',catalogue_path:loaded.catalogue_path,catalogue_sha256:loaded.catalogue_sha256,
    total:loaded.total,path_base:loaded.path_base,offset,returned:cards.length,
    next_offset:next<loaded.total?next:null,exhausted:next>=loaded.total,
    notice:'No keyword filtering, semantic inference, ranking or media inspection performed. Read all returned fields before claiming coverage.',cards};
}
export function main(argv) {
  const options={};
  const seen=new Set();
  for (let i=0;i<argv.length;i+=2) {
    const key=argv[i];
    if (!['--catalogue','--offset','--limit','--ids'].includes(key)||seen.has(key)||i+1>=argv.length) throw new Error('Use --catalogue PATH, --offset N, --limit 1..50, or --ids 12,60');
    seen.add(key); options[key]=argv[i+1];
  }
  if (seen.has('--ids')&&(seen.has('--offset')||seen.has('--limit'))) throw new Error('Use either IDs or pagination, not both');
  const path=options['--catalogue']??fileURLToPath(new URL('../case-catalogue.json',import.meta.url));
  const ids=seen.has('--ids')?options['--ids'].split(',').map(s=>int(s.trim(),'id',1)):null;
  const result=selectCards(loadCards(path),{
    offset:seen.has('--offset')?int(options['--offset'],'offset',0):0,
    limit:seen.has('--limit')?int(options['--limit'],'limit',1,50):20,ids});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {main(process.argv.slice(2));}
  catch (error) {process.stderr.write(`read-case-cards: ${error.message}\n`);process.exitCode=1;}
}
