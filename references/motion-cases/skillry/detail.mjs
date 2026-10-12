import {splitDocument,resolveLibraryLink} from './document-format.mjs';
import {appendMechanismClip} from './mechanism-media.mjs';
const $=id=>document.getElementById(id);
const element=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
let catalogue=[],mechanisms=[],documentPath='README.md';
function linkTarget(href){
  const target=resolveLibraryLink(href,documentPath);if(!target)return null;
  if(target.kind==='external')return target.href;
  const mechanism=mechanisms.find(m=>m.document===target.path);
  if(mechanism)return mechanism.detail+target.hash;
  const c=catalogue.find(c=>c.analysis===target.path);
  if(c)return c.detail+target.hash;
  if(target.path==='README.md')return 'detail.html';
  return target.path+target.hash;
}
// 使用文本节点与受限相对链接，不执行 Markdown 中的 HTML。
function inline(parent,text){
  const pattern=/\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;let last=0;
  for(const m of text.matchAll(pattern)){
    parent.append(document.createTextNode(text.slice(last,m.index)));
    if(m[1])parent.append(element('strong',m[1]));
    else {const href=linkTarget(m[3]);if(href){const a=element('a',m[2]);a.href=href;if(/^https?:/.test(href)){a.target='_blank';a.rel='noopener noreferrer';}parent.append(a);}else parent.append(document.createTextNode(m[2]));}
    last=m.index+m[0].length;
  }
  parent.append(document.createTextNode(text.slice(last)));
}
function render(text){
  let code=null,paragraph=[],list=null;
  function flush(){if(paragraph.length){const p=element('p','');inline(p,paragraph.join('\n'));$('report').append(p);paragraph=[];}}
  const {body}=splitDocument(text);
  for(const line of body.split(/\r?\n/)){
    if(line.startsWith('```')){flush();list=null;if(code){$('report').append(element('pre',code.join('\n')));code=null;}else code=[];continue;}
    if(code){code.push(line);continue;}
    if(!line.trim()){flush();list=null;continue;}
    const picture=line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if(picture){
      flush();list=null;const target=resolveLibraryLink(picture[2],documentPath);
      if(target?.kind==='local'&&/\.(jpg|jpeg|png|webp)$/i.test(target.path)){
        const figure=element('figure',''),a=element('a',''),img=element('img','');
        a.href=target.path;a.target='_blank';a.rel='noopener';img.src=target.path;img.alt=picture[1];img.decoding='async';
        img.addEventListener('error',()=>{$('error').textContent='分镜图加载失败，请检查案例文件是否完整。';});
        a.append(img);figure.append(a,element('figcaption',picture[1]+' · 点击可打开大图'));$('report').append(figure);
      }
      continue;
    }
    const heading=line.match(/^(#{1,3})\s+(.+)/);
    if(heading){flush();list=null;if(heading[1].length>1)$('report').append(element('h'+heading[1].length,heading[2]));continue;}
    if(line.startsWith('- ')){flush();if(!list){list=element('ul','');$('report').append(list);}const li=element('li','');inline(li,line.slice(2));list.append(li);continue;}
    paragraph.push(line);
  }
  flush();if(code)$('report').append(element('pre',code.join('\n')));
}
async function readJson(path){const r=await fetch(path);if(!r.ok)throw new Error('索引读取失败');return r.json();}
try{
  const params=new URLSearchParams(location.search),slug=params.get('case'),id=params.get('mechanism');
  if(slug){
    catalogue=(await readJson('case-catalogue.json')).cases;
    const c=catalogue.find(c=>c.slug===slug);if(!c)throw new Error('没有这个案例');
    if(c.analysis_kind==='mechanisms-v1')mechanisms=(await readJson('mechanism-index.json')).mechanisms;
    const mechanism=id?mechanisms.find(m=>m.id===id&&m.case_slug===slug):null;
    if(id&&!mechanism)throw new Error('没有这个运动机制');
    documentPath=mechanism?.document??c.analysis;
    $('title').textContent=mechanism?`${mechanism.id} ${mechanism.title}`:`${String(c.case_number).padStart(3,'0')} ${c.title}`;
    $('document').href=documentPath;$('document').hidden=false;
    $('download').href=c.media;$('source').href=c.source_url;$('source').target='_blank';$('source').rel='noopener';
    $('media-note').textContent=mechanism?mechanism.summary:c.media_note;
    if(mechanism){
      if(appendMechanismClip($('segments'),mechanism))$('media-note').textContent=mechanism.summary+' 切片保留原速与原画幅，默认静音，可用播放器开启声音。';
      else $('segments').append(element('p','本机制尚未提供独立切片，可通过上方“打开视频”查看完整原片。'));
      $('overview').href=c.detail;$('overview').hidden=false;
      const info=$('mechanism-info');info.hidden=false;
      for(const [label,value] of [['变化目的',mechanism.purpose],['起始状态',mechanism.start_state],['结束状态',mechanism.end_state]])info.append(element('p',`${label}：${value}`));
      info.append(element('p',`动作关系：${mechanism.relation} · ${mechanism.tags.join(' / ')}`));
    }else{
    const video=$('video');video.hidden=false;video.src=c.media;
    let end=null;video.addEventListener('timeupdate',()=>{if(end!==null&&video.currentTime>=end){video.pause();end=null;}});
    video.addEventListener('error',()=>{$('error').textContent='视频无法加载，请确认仓库已完整拉取，或打开网站原作。';});
    if(c.analysis_kind!=='mechanisms-v1')for(const s of c.recommended_segments){const button=element('button',`播放 ${s.start.toFixed(2)}–${s.end.toFixed(2)} 秒 · ${s.reason}`);button.className='segment';button.addEventListener('click',async()=>{video.currentTime=s.start;end=s.end;try{await video.play();}catch{$('error').textContent='播放未成功，请使用视频控件重试。';}});$('segments').append(button);}
    const t=Number(new URLSearchParams(location.hash.slice(1)).get('t'));if(t>0&&t<c.duration)video.currentTime=t;
    if(c.storyboard&&c.analysis_kind!=='mechanisms-v1'){$('storyboard-section').hidden=false;$('storyboard-link').href=c.storyboard;$('storyboard').src=c.storyboard;$('storyboard').alt='完整64宫格分镜';}
    }
  }else{$('title').textContent='参考库使用说明';$('download').hidden=true;$('source').hidden=true;}
  document.title=$('title').textContent+' · 动效参考库';
  const report=await fetch(documentPath);if(!report.ok)throw new Error('拆解文档读取失败');render(await report.text());
}catch(error){$('title').textContent='资料未加载';$('error').textContent=error.message+'。请从参考库首页重新选择。';}
