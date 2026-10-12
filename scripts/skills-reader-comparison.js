// 双栏原文来自固定快照；现文来自同一次页面生成读取的唯一源。
const snapshots=JSON.parse(document.querySelector('#comparison-data').textContent).snapshots;
let comparison=snapshots[0],beforeByPath=new Map(comparison.originals.map(f=>[f.path,f]));
function selectBaseline(id){comparison=snapshots.find(s=>s.id===id)||snapshots[0];beforeByPath=new Map(comparison.originals.map(f=>[f.path,f]))}
let plainComparison=false,syncComparison=false;
function compareFile(path){
  const match=beforeByPath.get(path)||comparison.originals.find(f=>f.targets.includes(path));
  const args={view:'compare',baseline:comparison.id};
  if(match)args.before=match.path;
  if(path&&byPath.has(path)&&byPath.get(path).source!==undefined)args.after=path;
  location.hash=new URLSearchParams(args).toString();
}
function compareNavigate(before,after){location.hash=new URLSearchParams({view:'compare',baseline:comparison.id,...(before?{before}:{}),...(after?{after}:{})}).toString()}
function showComparison(params){
  selectBaseline(params.get('baseline'));
  const afterArg=params.get('after');
  const old=beforeByPath.get(params.get('before'))||(!afterArg?beforeByPath.get('production-coordinator/SKILL.md'):null);
  const targets=old?.targets||[];
  const after=afterArg==='all'?'all':byPath.has(afterArg)?afterArg:targets[0]||'';
  const active=after==='all'?targets:[after].filter(Boolean);
  current=active[0]||'';article.className='comparison';article.replaceChildren();
  document.querySelector('#path').textContent='修改前原文 / 当前内容 · 双栏对照';document.querySelector('#original').hidden=true;document.querySelector('#compare-current').hidden=true;
  const controls=document.createElement('div');controls.className='compare-controls';
  const makeSelect=(label,options,value,change,id)=>{const wrap=document.createElement('label');wrap.textContent=label;const select=document.createElement('select');select.id=id;for(const [v,t] of options){const o=document.createElement('option');o.value=v;o.textContent=t;select.append(o)}select.value=value;select.onchange=()=>change(select.value);wrap.append(select);controls.append(wrap)};
  makeSelect('对照哪个版本',snapshots.map(s=>[s.id,s.label]),comparison.id,value=>{selectBaseline(value);compareFile(current||old?.path)},'compare-baseline');
  makeSelect('修改前文件',[[ '', '无对应旧文件（新增内容）'],...comparison.originals.map(f=>[f.path,`${f.label} · ${f.path}`])],old?.path||'',value=>compareNavigate(value,''),'compare-before');
  const options=targets.map(p=>[p,`${byPath.get(p).label} · ${p}`]);
  if(targets.length>1)options.unshift(['all',`合并阅读 ${targets.length} 份关联新文件`]);
  if(after&&!options.some(([p])=>p===after))options.unshift([after,`${byPath.get(after)?.label||after} · ${after}`]);
  if(!options.length)options.push(['','没有对应的活动文件']);
  for(const file of files)if(file.source!==undefined&&!options.some(([p])=>p===file.path))options.push([file.path,`其他新文件：${file.label} · ${file.path}`]);
  makeSelect('当前对应内容',options,after,value=>compareNavigate(old?.path,value),'compare-after');
  for(const [label,checked,setter] of [['显示原始文本（含元数据）',plainComparison,v=>{plainComparison=v;showComparison(params)}],['同步滚动',syncComparison,v=>{syncComparison=v}]]){const wrap=document.createElement('label');wrap.className='compare-check';const input=document.createElement('input');input.type='checkbox';input.checked=checked;input.onchange=()=>setter(input.checked);wrap.append(input,document.createTextNode(label));controls.append(wrap)}
  article.append(controls);
  const note=document.createElement('p');note.className='compare-note';
  note.textContent=`左栏：${comparison.baseline}。右栏：本页面生成时读取的最新文件。${old?'状态：'+old.state+'。':''}${targets.length>1?'原长文已拆到多处，可切换右侧文件或合并阅读；两栏默认独立滚动，位置不代表逐段一一对应。':'两栏展示完整内容，可分别滚动。'}`;
  article.append(note);
  if(old?.notes.length){const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('p');summary.textContent='查看这份原文的迁移与删改说明';body.textContent=old.notes.join('；');details.append(summary,body);article.append(details)}
  const columns=document.createElement('div');columns.className='compare-columns';
  function pane(title,path,side){const shell=document.createElement('section');shell.className='compare-pane';const head=document.createElement('header');head.textContent=title;const sub=document.createElement('small');sub.textContent=path;head.append(sub);const content=document.createElement('div');content.className='compare-content';content.id='compare-'+side+'-content';shell.append(head,content);columns.append(shell);return content}
  const left=pane('修改前 · 完整原文',old?.path||'无对应旧文件','old');
  const right=pane('修改后 · 当前内容',after==='all'?`合并显示 ${active.length} 份文件（非原文件结构）`:after||'已移出活动资料','new');
  function renderInto(container,file,historical){
    if(plainComparison||!file.html){const pre=document.createElement('pre');pre.textContent=file.source;container.append(pre);return}
    const section=document.createElement('div');section.innerHTML=file.html;
    if(historical&&file.metadata){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='文件元数据';pre.textContent=file.metadata;details.append(summary,pre);section.prepend(details)}
    // 历史文字中的链接优先打开同版快照，不能冒充为当前正文。
    for(const node of section.querySelectorAll('[href],[src]')){
      const attr=node.hasAttribute('href')?'href':'src',raw=node.getAttribute(attr);
      if(/^https?:/i.test(raw)){if(attr==='href'){node.target='_blank';node.rel='noopener'}continue}
      if(/^[a-z][a-z\d+.-]*:/i.test(raw)){node.removeAttribute(attr);continue}
      const url=new URL(raw,sourceURL(file.path));const target=decodeURIComponent(url.pathname.slice(sourceRoot.pathname.length));
      if(raw.startsWith('#')){node.onclick=e=>{e.preventDefault();[...section.querySelectorAll('[id]')].find(n=>n.id===decodeURIComponent(raw.slice(1)))?.scrollIntoView()};continue}
      if(attr==='href'&&historical&&beforeByPath.has(target)){node.href='#';node.onclick=e=>{e.preventDefault();compareNavigate(target,'')};continue}
      const mapped=historical?(comparison.moves[target]||target):target;
      if(byPath.has(mapped)){node.setAttribute(attr,sourceURL(mapped));if(attr==='href'&&byPath.get(mapped).source!==undefined)node.onclick=e=>{e.preventDefault();compareFile(mapped)}}
      else{node.removeAttribute(attr);node.title='历史引用：'+raw}
    }
    container.append(section);
  }
  if(old)renderInto(left,old,true);else left.textContent='此文件为本轮新增，没有同路径的旧文件。可从上方选择相关的原文对照。';
  for(const path of active){const file=byPath.get(path);if(!file||file.source===undefined)continue;if(active.length>1){const h=document.createElement('h2');h.className='compare-file-heading';h.textContent=file.label;const p=document.createElement('small');p.textContent=path;right.append(h,p)}renderInto(right,file,false)}
  if(!active.length){right.textContent='该旧文件已不在活动技能中。';if(old?.notes.length){const p=document.createElement('p');p.textContent=old.notes.join('；');right.append(p)}}
  let scrollLock=false;for(const [a,b] of [[left,right],[right,left]])a.onscroll=()=>{if(!syncComparison||scrollLock)return;scrollLock=true;const span=a.scrollHeight-a.clientHeight;b.scrollTop=span>0?a.scrollTop/span*(b.scrollHeight-b.clientHeight):0;requestAnimationFrame(()=>{scrollLock=false})};
  article.append(columns);tree(document.querySelector('#search').value);main.scrollTop=0;
}
