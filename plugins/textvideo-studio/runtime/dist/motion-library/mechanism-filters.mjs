import {queryMechanisms} from './mechanism-search.mjs';

export const filterFields=['categories','actions','entry','holds','case'];
const matches=(m,state,omit)=>filterFields.every(f=>f===omit||!state[f]||(f==='case'?String(m.case_number)===state[f]:m.retrieval[f].includes(state[f])));

export function createMechanismBrowser(index){
  const all=[...index.mechanisms].sort((a,b)=>a.id.localeCompare(b.id));
  let cachedQuery,cachedRows,cachedWarnings;
  function queryRows(query=''){
    if(query===cachedQuery)return {rows:cachedRows,warnings:cachedWarnings};
    const rows=[],warnings=[];
    if(!query.trim())rows.push(...all);
    else{
      // 复用正式查询的文字匹配；缓存当前查询，切换筛选或翻页无需重新召回。
      let offset=0;
      do{
        const result=queryMechanisms(index,{query,offset,limit:50});
        rows.push(...result.cards);if(offset===0)warnings.push(...result.warnings);
        offset=result.next_offset;
      }while(offset!==null);
    }
    cachedQuery=query;cachedRows=rows;cachedWarnings=warnings;
    return {rows,warnings};
  }
  return function browse(state={},page=0){
    const {rows,warnings}=queryRows(state.query),filtered=rows.filter(m=>matches(m,state));
    const facets={};
    for(const field of filterFields){
      // 本组选项按“其余条件”计数，既能继续缩小，也能直接换选同组条件。
      const available=rows.filter(m=>matches(m,state,field)),counts={};
      for(const m of available)for(const value of field==='case'?[String(m.case_number)]:m.retrieval[field])counts[value]=(counts[value]??0)+1;
      facets[field]={total:available.length,counts};
    }
    const recovery=[];
    if(!filtered.length){
      const active=['query',...filterFields].filter(f=>state[f]?.trim());
      // 最多六项条件，穷举解除组合，优先提供改动最少且确实有结果的方案。
      for(let size=1;size<=active.length&&!recovery.length;size++){
        for(let mask=1;mask<2**active.length;mask++){
          const remove=active.filter((_,i)=>mask&(1<<i));if(remove.length!==size)continue;
          const next={...state};for(const field of remove)delete next[field];
          const total=(remove.includes('query')?all:rows).filter(m=>matches(m,next)).length;
          if(total)recovery.push({remove,total});
        }
      }
      recovery.sort((a,b)=>b.total-a.total);
    }
    const currentPage=Math.max(0,Math.min(page,Math.ceil(filtered.length/24)-1));
    return {total:filtered.length,page:currentPage,cards:filtered.slice(currentPage*24,(currentPage+1)*24),
      exhausted:(currentPage+1)*24>=filtered.length,warnings,facets,recovery:recovery.slice(0,3)};
  };
}
