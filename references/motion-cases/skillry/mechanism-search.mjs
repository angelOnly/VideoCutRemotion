import {taxonomy,termsFor,validateRetrieval} from './taxonomy.mjs';
import {restoreSelection,encodeSelection} from './selection.mjs';
const fields=['categories','actions','entry','exit','holds'];
const intersect=(a,b)=>a.filter(x=>b.includes(x));
const unique=a=>[...new Set(a)];
const textOf=m=>[m.search_text??[m.summary,m.purpose,m.relation,m.start_state,m.end_state].join(' '),m.title,...m.tags].join(' ').toLowerCase();
const segments=text=>{
  const parts=[...new Intl.Segmenter('zh',{granularity:'word'}).segment(text)],result=[];
  for(let i=0;i<parts.length;i++){
    const part=parts[i];if(part.isWordLike&&part.segment.length>1)result.push(part.segment);
    // 只合并相邻的孤立汉字，避免把“内部上滚”跨词拼成无意义的“部上”。
    if(/^[\u3400-\u9fff]$/.test(part.segment)&&/^[\u3400-\u9fff]$/.test(parts[i+1]?.segment??''))result.push(part.segment+parts[i+1].segment);
  }
  return unique(result);
};
export function understandQuery(query=''){
  const warnings=[];
  // 否定句不参与正向召回；“外框别动”不能被误译成禁止所有内部位移。
  const positive=query.toLowerCase().replace(/(?:不要|不能|不想|不许|避免|排除|别)[^，,。；;！!？?]*(?=[，,。；;！!？?]|$)/g,clause=>{warnings.push(`需核对否定条件：${clause}`);return ' ';});
  const concepts={};
  for(const field of ['categories','actions','states','holds','anchors'])concepts[field]=taxonomy[field].filter(row=>unique([row[0],...row.at(-1).split(',')]).some(word=>positive.includes(word))).map(row=>row[0]);
  const aliases=unique(Object.entries(concepts).flatMap(([field,values])=>taxonomy[field].filter(row=>values.includes(row[0])).flatMap(row=>[row[0],...row.at(-1).split(',')]))).sort((a,b)=>b.length-a.length);
  let remainder=positive;for(const alias of aliases)remainder=remainder.replaceAll(alias,' ');
  return {positive,tokens:segments(remainder),concepts,warnings};
}
export function connection(left,right){
  const common=intersect(left.retrieval.exit,right.retrieval.entry);
  return {from:left.id,to:right.id,left_end:left.end_state,right_start:right.start_state,
    shared_states:common,shared_anchors:intersect(left.retrieval.anchors,right.retrieval.anchors),
    next_holds:right.retrieval.holds,
    checks:[`前段留下：${left.end_state}`,`后段要求：${right.start_state}`,`后段关系：${right.relation}`],
    gap:common.length?'仅确认状态类型重合；须核对对象身份、位置、方向，安排多余层退让与缺失层建立。':'没有已标注的共同起止状态，需要额外连接或更换候选。',
    continuous_verified:false};
}
function validateOptions(o){
  if(!o||typeof o!=='object'||Array.isArray(o))throw new Error('查询必须为对象');
  const allowed=[...fields,'exclude_actions','query','stages','similar_to','before','after','ids','selection','offset','limit','source_sha256'];
  for(const k of Object.keys(o))if(!allowed.includes(k))throw new Error(`未知查询字段：${k}`);
  for(const f of [...fields,'exclude_actions'])if(o[f]!==undefined){
    const values=o[f],valid=termsFor(f==='exclude_actions'?'actions':f);
    if(!Array.isArray(values)||values.length>20||values.some(v=>!valid.includes(v)))throw new Error(`未知 ${f} 条件；请先读取词表`);
  }
  if(o.query!==undefined&&(typeof o.query!=='string'||o.query.length>1000))throw new Error('查询文字过长或格式无效');
  if(o.source_sha256!==undefined&&(typeof o.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(o.source_sha256)))throw new Error('来源指纹格式无效');
  const modes=['similar_to','before','after','ids','selection','stages'].filter(k=>o[k]!==undefined);
  if(modes.length>1)throw new Error('一次查询只能指定一种定位方式');
  if(['ids','selection'].some(k=>o[k]!==undefined)&&['query',...fields,'exclude_actions','offset','limit'].some(k=>o[k]!==undefined))throw new Error('清单或编号定位不能混用筛选和分页');
  for(const f of ['similar_to','before','after'])if(o[f]!==undefined&&(typeof o[f]!=='string'||!/^\d{3}-m\d{2}$/.test(o[f])))throw new Error('机制编号格式无效');
  if(o.ids!==undefined&&(!Array.isArray(o.ids)||!o.ids.length||o.ids.length>40||o.ids.some(v=>typeof v!=='string')||unique(o.ids).length!==o.ids.length))throw new Error('编号列表无效或重复');
  if(o.stages!==undefined&&(!Array.isArray(o.stages)||!o.stages.length||o.stages.length>8||o.stages.some(v=>typeof v!=='string'||!v.trim()||v.length>1000)))throw new Error('阶段应为 1—8 段独立的运动描述');
  for(const [f,min,max] of [['offset',0,100000],['limit',1,50]])if(o[f]!==undefined&&(!Number.isSafeInteger(o[f])||o[f]<min||o[f]>max))throw new Error('分页范围无效');
}
export function queryMechanisms(index,options={},semantic={}){
  validateOptions(options);
  if(index.schema_version!==2)throw new Error('索引版本不支持检索，请重新生成');
  if(options.source_sha256&&options.source_sha256!==index.source_sha256)throw new Error('资料已经变化，请重新查询并核读采用项');
  for(const m of index.mechanisms)validateRetrieval(m.retrieval,m.id);
  const byId=new Map(index.mechanisms.map(m=>[m.id,m]));
  const get=id=>{const m=byId.get(id);if(!m)throw new Error(`未知机制：${id}`);return m;};
  const base={scope:index.scope,source_sha256:index.source_sha256,library_count:index.count,
    notice:'动作全文召回；匹配分数不代表观感或直接可衔接。先读候选指令与分镜，再由当前作者决定。'};
  if(options.stages){
    const {stages,...rest}=options;
    return {...base,groups:stages.map(stage=>({stage,...queryMechanisms(index,{...rest,query:stage},semantic[stage]?{candidates:semantic[stage]}:{})}))};
  }
  if(options.selection){
    const selection=restoreSelection(options.selection,index);
    return {...base,selection,cards:selection.ids.filter(id=>byId.has(id)).map(get),
      connections:selection.ids.slice(1).map((id,i)=>byId.has(id)&&byId.has(selection.ids[i])?connection(get(selection.ids[i]),get(id)):{from:selection.ids[i],to:id,gap:'未知编号，无法比较'}),
      warnings:[...(selection.stale?['清单来源已变化，重新核读后再确认采用。']:[]),...selection.unknown_ids.map(id=>`未知机制：${id}`)]};
  }
  if(options.ids){const cards=options.ids.map(get);return {...base,total:cards.length,cards,comparison:`compare.html?${encodeSelection({v:1,source_sha256:index.source_sha256,ids:options.ids,adopted:[]})}`};}
  const sourceId=options.similar_to??options.before??options.after,source=sourceId?get(sourceId):null;
  const intent=understandQuery(options.query);
  const hasQuery=intent.positive.trim().length>0;
  const texts=new Map(index.mechanisms.map(m=>[m.id,textOf(m)]));
  // 稀少的具体关系比“内部、保持”等通用词更有区分力，不要求所有词同时命中。
  const weights=new Map(intent.tokens.map(t=>[t,Math.log(1+(index.mechanisms.length+1)/(1+[...texts.values()].filter(text=>text.includes(t)).length))]));
  const scored=[];
  const semanticById=new Map((semantic.candidates??[]).map(row=>[row.id,row.score]));
  for(const m of index.mechanisms){
    if(m.id===sourceId)continue;
    const r=m.retrieval;
    if(fields.some(f=>(options[f]??[]).some(v=>!r[f].includes(v)))||(options.exclude_actions??[]).some(v=>r.actions.includes(v)))continue;
    let score=0;const reasons=[],text=texts.get(m.id);
    for(const field of fields){const chosen=options[field]??[];if(chosen.length)reasons.push(`满足${field}：${chosen.join('、')}`);}
    let queryScore=0;
    for(const f of ['categories','actions','holds']){
      const hits=intersect(r[f],intent.concepts[f]);queryScore+=hits.length*(f==='holds'?4:3);
      if(hits.length)reasons.push(`运动词对应：${hits.join('、')}`);
    }
    const stateHits=intersect(unique([...r.entry,...r.exit]),intent.concepts.states);queryScore+=stateHits.length;
    const hits=intent.tokens.filter(t=>text.includes(t));queryScore+=hits.reduce((sum,t)=>sum+weights.get(t),0);
    if(hits.length)reasons.push(`描述对应：${hits.slice(0,8).join('、')}`);
    if(hasQuery&&!queryScore&&!semanticById.has(m.id))continue;
    score+=queryScore;
    let difference,join;
    if(options.similar_to){
      let similarity=0;
      for(const [f,w] of [['categories',4],['actions',3],['entry',2],['exit',2],['holds',3],['anchors',1]]){
        const common=intersect(r[f],source.retrieval[f]);const union=unique([...r[f],...source.retrieval[f]]);
        similarity+=union.length?w*common.length/union.length:0;
      }
      // 同样“会移动”不足以成为相似方案，需有同类变化关系。
      score+=similarity;reasons.push(`相同变化类：${intersect(r.categories,source.retrieval.categories).join('、')}`);
      difference={source_relation:source.relation,candidate_relation:m.relation,added_actions:r.actions.filter(v=>!source.retrieval.actions.includes(v)),absent_actions:source.retrieval.actions.filter(v=>!r.actions.includes(v))};
    }
    if(options.after||options.before){
      join=options.after?connection(source,m):connection(m,source);
      score+=join.shared_states.length*3+join.shared_anchors.length;
      reasons.push(join.shared_states.length?`起止状态可比较：${join.shared_states.join('、')}`:join.gap);
    }
    scored.push({...m,score,match_reasons:unique(reasons),...(difference?{difference}:{}),...(join?{connection:join}:{})});
  }
  scored.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  if(semanticById.size){
    // 两路各自在全库召回，再按排名融合；余弦与词法分数不直接相加。
    // 固定召回池后分页；翻页扩大召回池会改变前页排序，造成重复或漏项。
    const budget=50;
    const lexical=scored.filter(card=>card.score>0).slice(0,budget);
    const vectors=scored.filter(card=>semanticById.has(card.id)).sort((a,b)=>semanticById.get(b.id)-semanticById.get(a.id)||a.id.localeCompare(b.id)).slice(0,budget);
    const lr=new Map(lexical.map((card,i)=>[card.id,i+1])),vr=new Map(vectors.map((card,i)=>[card.id,i+1]));
    for(let i=scored.length-1;i>=0;i--){
      const card=scored[i],l=lr.get(card.id),v=vr.get(card.id);
      if(!l&&!v){scored.splice(i,1);continue;}
      card.retrieval={...card.retrieval};
      card.retrieval_evidence={lexical_rank:l,semantic_rank:v,lexical_score:card.score,semantic_score:semanticById.get(card.id)};
      card.score=(l?1/(60+l):0)+(v?1/(60+v):0);
      if(v)card.match_reasons.push(`动作关系向量召回：第${v}位`);
    }
    scored.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  }
  const offset=options.offset??0,limit=options.limit??12;
  if(offset>scored.length)throw new Error('分页超出结果范围，请重新查询');
  const cards=scored.slice(offset,offset+limit),next=offset+cards.length;
  return {...base,total:scored.length,offset,next_offset:next<scored.length?next:null,exhausted:next>=scored.length,
    warnings:intent.warnings,cards,comparison:`compare.html?${encodeSelection({v:1,source_sha256:index.source_sha256,ids:cards.slice(0,40).map(m=>m.id),adopted:[]})}`};
}
