import {searchCases,facets} from './search.mjs';
const $=id=>document.getElementById(id), key='skillry-selected-slugs-v2';
let catalogue, page=0, matches=[], selected=new Set();
const pageSize=12;
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
try { selected=new Set(JSON.parse(localStorage.getItem(key)||'[]')); } catch {}
function selectionCount(){ $('selected-count').textContent=`已收藏 ${selected.size} 条`; }
function options(){return {query:$('query').value,filters:Object.fromEntries(Object.keys(facets).map(k=>[k,$(k).value]))};}
function updateURL(){const p=new URLSearchParams();const o=options();if(o.query)p.set('q',o.query);for(const [k,v] of Object.entries(o.filters))if(v)p.set(k,v);if($('selected-only').checked)p.set('selected','1');history.replaceState(null,'',location.pathname+(p.size?'?'+p:''));}
function filter(){page=0;matches=searchCases(catalogue.cases,options()).filter(c=>!$('selected-only').checked||selected.has(c.slug));updateURL();render();}
function render(){
  // 翻页前暂停旧视频，防止移出页面后仍播放声音。
  document.querySelectorAll('video').forEach(v=>v.pause());$('results').replaceChildren();
  $('count').textContent=`找到 ${matches.length} / ${catalogue.count} 条案例`;
  const pages=Math.max(1,Math.ceil(matches.length/pageSize));page=Math.min(page,pages-1);
  $('page').textContent=`${page+1} / ${pages}`;$('prev').disabled=page===0;$('next').disabled=page===pages-1;
  if(!matches.length)$('results').append(el('div','没有直接匹配。试着减少一个筛选条件，或将问题写成“素材 + 动作”，例如“手机 照片”。','empty'));
  for(const c of matches.slice(page*pageSize,(page+1)*pageSize)){
    const card=el('article');card.classList.toggle('chosen',selected.has(c.slug));
    const video=el('video');video.controls=true;video.playsInline=true;video.preload='metadata';video.src=c.media+'#t=0.1';video.setAttribute('aria-label',`${c.case_number} ${c.title}`);
    const failure=el('p','视频无法播放，请确认仓库已完整拉取；也可查看拆解中的原作链接。','play-error');failure.hidden=true;
    video.addEventListener('error',()=>failure.hidden=false);
    video.addEventListener('play',()=>document.querySelectorAll('video').forEach(v=>{if(v!==video)v.pause();}));
    const info=el('div',null,'info'),title=el('h2',c.title);title.prepend(el('span',String(c.case_number).padStart(3,'0'),'num'));
    info.append(title,el('p',`${c.original_form} · ${c.duration.toFixed(1)} 秒 · @${c.author}`,'meta'));
    const tags=el('div',null,'tags');c.video_types.forEach(t=>tags.append(el('span',t,'tag')));
    info.append(tags,el('p',c.scenario,'scenario'),el('p','原片实见：'+c.materials.join(' · '),'meta'));
    let segmentEnd=null;
    video.addEventListener('timeupdate',()=>{if(segmentEnd!==null && video.currentTime>=segmentEnd){video.pause();segmentEnd=null;}});
    for(const seg of (c.analysis_kind==='mechanisms-v1'?[]:c.recommended_segments)){const b=el('button',`▶ ${Number(seg.start.toFixed(2))}–${Number(seg.end.toFixed(2))} 秒 · ${seg.reason}`,'segment');b.addEventListener('click',async()=>{video.currentTime=seg.start;segmentEnd=seg.end;try{await video.play();}catch{failure.hidden=false;}});info.append(b);}
    const detail=el('details'),summary=el('summary','方法、美术与迁移要求');detail.append(summary);
    for(const [label,value] of [['动效方法',c.methods.join('、')],['美术特点',c.art.join('、')],['需要的材料',c.material_requirements],['迁移代价',c.transfer_cost]])detail.append(el('p',label+'：'+value));
    const actions=el('div',null,'actions'),label=el('label'),box=el('input');box.type='checkbox';box.checked=selected.has(c.slug);box.setAttribute('aria-label',`收藏 ${c.case_number}`);label.append(box,document.createTextNode(' 收藏'));
    box.addEventListener('change',()=>{if(box.checked)selected.add(c.slug);else selected.delete(c.slug);try{localStorage.setItem(key,JSON.stringify([...selected]));}catch{$('error').textContent='浏览器存储不可用，本次收藏无法跨会话保存。';}card.classList.toggle('chosen',box.checked);selectionCount();if($('selected-only').checked)filter();});
    const link=el('a',c.analysis_kind==='mechanisms-v1'?'总览与子机制 ↗':'查看完整拆解 ↗');link.href=c.detail;link.target='_blank';link.rel='noopener';actions.append(label,link);info.append(detail,actions);card.append(video,failure,info);$('results').append(card);
  }
  selectionCount();
}
try{
  const response=await fetch('case-catalogue.json');if(!response.ok)throw new Error('索引读取失败');catalogue=await response.json();
  const params=new URLSearchParams(location.search);$('query').value=params.get('q')||'';$('selected-only').checked=params.get('selected')==='1';
  for(const [name,labelText] of Object.entries(facets)){
    if(['methods','art'].includes(name)){
      const label=el('label',labelText),input=el('input');input.type='search';input.id=name;input.placeholder=name==='methods'?'例如：遮挡 / 视窗 / 聚焦':'例如：纸 / 低饱和 / 留白';input.value=params.get(name)||'';input.addEventListener('input',filter);label.append(input);$('filters').append(label);continue;
    }
    const label=el('label',labelText),select=el('select');select.id=name;
    select.append(new Option('全部',''));const values=[...new Set(catalogue.cases.flatMap(c=>c[name]))].sort((a,b)=>a.localeCompare(b,'zh'));
    values.forEach(v=>select.append(new Option(v,v)));select.value=values.includes(params.get(name))?params.get(name):'';
    select.addEventListener('change',filter);label.append(select);$('filters').append(label);
  }
  $('query').addEventListener('input',filter);$('selected-only').addEventListener('change',filter);
  $('reset').addEventListener('click',()=>{$('query').value='';Object.keys(facets).forEach(k=>$(k).value='');$('selected-only').checked=false;filter();});
  $('prev').addEventListener('click',()=>{page--;render();});$('next').addEventListener('click',()=>{page++;render();});
  $('copy-selection').addEventListener('click',async()=>{const text=catalogue.cases.filter(c=>selected.has(c.slug)).map(c=>`${String(c.case_number).padStart(3,'0')} ${c.title}`).join('\n');try{await navigator.clipboard.writeText(text);$('selected-count').textContent='收藏编号已复制';}catch{$('error').textContent='请手动复制：'+text;}});
  filter();
}catch(error){$('count').textContent='参考库未加载';$('error').textContent='请通过项目内预览服务打开此页；确认 case-catalogue.json 存在。'+error.message;}
