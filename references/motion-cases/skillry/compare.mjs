import {restoreSelection,encodeSelection,editSelection} from './selection.mjs';
import {connection} from './mechanism-search.mjs';
import {appendMechanismClip} from './mechanism-media.mjs';
const $=id=>document.getElementById(id),el=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
try{
  const response=await fetch('mechanism-index.json');if(!response.ok)throw new Error('无法读取机制索引');
  const index=await response.json(),byId=new Map(index.mechanisms.map(m=>[m.id,m]));
  let selected=location.search?restoreSelection(location.search,index):{v:1,source_sha256:index.source_sha256,ids:[],adopted:[]};
  function render(){
    const state=restoreSelection(selected,index),query=encodeSelection(selected);
    history.replaceState(null,'',location.pathname+'?'+query);$('link').value=location.href;$('browse').href='mechanisms.html?'+query;
    $('status').textContent=[`保留 ${selected.ids.length} 项，采用 ${selected.adopted.length} 项。`,...(state.stale?['资料版本已变化，请重新核读采用项。']:[]),...state.unknown_ids.map(id=>`未知编号 ${id}，请移除或重新选取。`)].join(' ');
    $('recheck').hidden=!state.stale;$('results').replaceChildren();$('connections').replaceChildren();
    if(!selected.ids.length)$('results').append(el('p','清单为空，点击“继续挑选”添加机制。'));
    for(const id of selected.ids){
      const m=byId.get(id),card=el('article','');card.className=selected.adopted.includes(id)?'adopted':'';
      card.append(el('span',id),el('h2',m?.title??'未知机制'));
      if(m){
        const img=document.createElement('img');img.src=m.storyboard;img.alt=m.title+'的分镜';img.loading='lazy';
        if(appendMechanismClip(card,m)){const frames=el('details','');frames.append(el('summary','展开分镜过程'),img);card.append(frames);}else card.append(img);
        card.append(el('p',m.summary));
        const conditions=el('dl','');for(const [label,value] of [['开始',m.start_state],['关系',m.relation],['结束',m.end_state],['保持',m.retrieval.holds.join('、')||'未明确标注']])conditions.append(el('dt',label),el('dd',value));card.append(conditions);
      }
      const actions=el('div','');actions.className='actions';
      for(const [action,label] of [['up','上移'],['down','下移'],['adopt',selected.adopted.includes(id)?'取消采用':'标记采用'],['remove','移除']]){
        const button=el('button',label);button.disabled=(action==='adopt'&&(!m||state.stale))||(action==='up'&&selected.ids[0]===id)||(action==='down'&&selected.ids.at(-1)===id);
        button.addEventListener('click',()=>{selected=editSelection(selected,action,id);render();});actions.append(button);
      }
      if(m){const link=el('a','完整指令与原片');link.href=m.detail;link.target='_blank';link.rel='noopener';actions.append(link);}
      card.append(actions);$('results').append(card);
    }
    for(let i=1;i<selected.ids.length;i++){
      const left=byId.get(selected.ids[i-1]),right=byId.get(selected.ids[i]);
      const card=el('article',`${selected.ids[i-1]} → ${selected.ids[i]}`);
      if(left&&right){const join=connection(left,right);for(const line of join.checks)card.append(el('p',line));card.append(el('p',join.gap));}
      else card.append(el('p','存在未知编号，无法比较。'));
      $('connections').append(card);
    }
  }
  $('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);$('status').textContent='恢复链接已复制。';}catch{$('link-details').open=true;$('link').focus();$('link').select();$('status').textContent='请复制已选中的恢复链接。';}});
  $('recheck').addEventListener('click',()=>{selected.source_sha256=index.source_sha256;render();});render();
}catch(error){$('error').textContent=error.message;}
