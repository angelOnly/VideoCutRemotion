import {termsFor} from './taxonomy.mjs';
import {createMechanismBrowser,filterFields} from './mechanism-filters.mjs';
import {restoreSelection,encodeSelection,editSelection} from './selection.mjs';
import {appendMechanismClip} from './mechanism-media.mjs';
const $=id=>document.getElementById(id),el=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const labels={query:'运动词',categories:'变化类别',actions:'动作特征',entry:'已有画面',holds:'保持条件',case:'来源案例'};
const displayValue=(field,value)=>field==='case'?value.padStart(3,'0'):value;
try{
  const response=await fetch('mechanism-index.json');if(!response.ok)throw new Error('机制索引读取失败');
  const index=await response.json();$('scope').textContent=index.scope;
  const samples=index.mechanisms.filter(m=>m.clip);
  if(samples.length){
    const complete=samples.length===index.count;
    const note=el('p',`已提供 ${samples.length} / ${index.count} 条机制切片；`+(complete?'全部可直接播放、慢放与循环。':'其余仍可查看分镜与完整原片。'));
    $('scope').after(note);
  }
  const browse=createMechanismBrowser(index);
  let page=0,selected={v:1,source_sha256:index.source_sha256,ids:[],adopted:[]};
  const params=new URLSearchParams(location.search);
  if(params.has('selection'))selected=restoreSelection(location.search,index);
  for(const field of ['categories','actions','entry','holds']){
    for(const term of termsFor(field))$(field).append(new Option(term,term));
    if(termsFor(field).includes(params.get(field)))$(field).value=params.get(field);
  }
  for(const number of [...new Set(index.mechanisms.map(m=>m.case_number))])$('case').append(new Option(String(number).padStart(3,'0'),String(number)));
  $('case').value=params.get('case')??'';$('query').value=params.get('q')??params.get('purpose')??'';
  $('advanced').open=Boolean($('holds').value||$('case').value);
  function removeFilters(fields){for(const field of fields)$(field).value='';page=0;render();}
  function render(){
    const state=Object.fromEntries(['query',...filterFields].map(f=>[f,$(f).value]));
    const result=browse(state,page);page=result.page;
    for(const field of filterFields){
      const facet=result.facets[field];
      for(const option of $(field).options){
        const count=option.value?(facet.counts[option.value]??0):facet.total;
        option.text=`${option.value?displayValue(field,option.value):'全部'}（${count}）`;
        // 旧链接中的零结果条件仍保留，用户可以更换或通过标签取消。
        option.disabled=Boolean(option.value&&count===0&&option.value!==state[field]);
        option.title=count===0?'当前其他条件下无匹配':'';
      }
    }
    const advancedCount=['holds','case'].filter(f=>state[f]).length;
    $('advanced-label').textContent='更多筛选'+(advancedCount?`（已选 ${advancedCount} 项）`:'');
    $('active-filters').replaceChildren();
    for(const field of ['query',...filterFields].filter(f=>state[f].trim())){
      const label=`${labels[field]}：${displayValue(field,state[field])}`,remove=el('button',label+' ×');
      remove.className='filter-chip';remove.setAttribute('aria-label','取消'+label);
      remove.addEventListener('click',()=>removeFilters([field]));$('active-filters').append(remove);
    }
    const url=new URLSearchParams(encodeSelection(selected));if(state.query)url.set('q',state.query);
    for(const field of filterFields)if(state[field])url.set(field,state[field]);
    history.replaceState(null,'',location.pathname+'?'+url);$('compare').href='compare.html?'+encodeSelection(selected);$('compare').textContent=`比较候选（${selected.ids.length}）`;
    $('count').textContent=`找到 ${result.total} / ${index.count} 条机制 · 第 ${page+1} 页`;
    const restored=restoreSelection(selected,index);$('error').textContent=[...result.warnings,...(restored.stale?['候选清单版本已变化，请到比较页重新核读。']:[]),...restored.unknown_ids.map(id=>'清单含未知编号：'+id)].join(' ');
    $('previous').disabled=page===0;$('next').disabled=result.exhausted;$('results').replaceChildren();
    if(!result.cards.length){
      const empty=el('div','');empty.className='filter-recovery';empty.append(el('h2','这些条件暂时没有共同匹配'));
      empty.append(el('p','已保留你的选择。以下方案只取消列出的条件，点击即可恢复结果：'));
      for(const choice of result.recovery){
        const label=choice.remove.map(f=>`「${labels[f]}：${displayValue(f,state[f])}」`).join('、');
        const button=el('button',`取消${label} · 查看 ${choice.total} 条`);
        button.addEventListener('click',()=>removeFilters(choice.remove));empty.append(button);
      }
      if(!result.recovery.length)empty.append(el('p','参考库当前没有可浏览的机制。'));
      $('results').append(empty);
    }
    for(const m of result.cards){
      const card=el('article',''),heading=el('div',''),num=el('span',m.id);heading.className='mechanism-heading';num.className='num';heading.append(num,el('h2',m.title));card.append(heading);
      const preview=el('a',''),picture=document.createElement('img');preview.className='mechanism-preview';preview.href=m.detail;picture.src=m.storyboard;picture.alt=m.title+'的分镜预览';picture.loading='lazy';picture.decoding='async';
      picture.addEventListener('error',()=>{picture.remove();preview.append(el('span','分镜未加载，点击查看指令'));},{once:true});preview.append(picture);
      if(appendMechanismClip(card,m)){const frames=el('details','');frames.append(el('summary','展开分镜过程'),preview);card.append(frames);}else card.append(preview);
      const info=el('div','');info.className='mechanism-info';info.append(el('p',m.summary),el('p',m.retrieval.categories.join(' · ')));
      const actions=el('div','');actions.className='actions';const read=el('a','查看运动指令');read.href=m.detail;const overview=el('a',String(m.case_number).padStart(3,'0')+' 原片总览');overview.href='detail.html?case='+encodeURIComponent(m.case_slug);
      const add=el('button',selected.ids.includes(m.id)?'移出候选':'保留候选');add.addEventListener('click',()=>{try{selected=editSelection(selected,selected.ids.includes(m.id)?'remove':'add',m.id);render();}catch(error){$('error').textContent=error.message;}});
      actions.append(read,overview,add);info.append(actions);card.append(info);$('results').append(card);
    }
  }
  for(const f of filterFields)$(f).addEventListener('change',()=>{page=0;render();});
  $('query').addEventListener('input',()=>{page=0;render();});
  $('reset').addEventListener('click',()=>removeFilters(['query',...filterFields]));
  $('previous').addEventListener('click',()=>{page--;render();});$('next').addEventListener('click',()=>{page++;render();});render();
}catch(error){$('count').textContent='机制未加载';$('error').textContent=error.message+'，请检查参考库文件。';}
