/** 各预览页共用切片播放器，缺片时保留分镜与原片入口。 */
export function appendMechanismClip(parent,m){
  if(!m.clip)return false;
  const section=document.createElement('section');section.className='mechanism-clip';
  const video=document.createElement('video');video.src=m.clip.path;video.controls=true;video.playsInline=true;video.preload='metadata';video.muted=true;
  // 复用现有分镜作待播封面，避免原片从暗场开始时看起来像加载失败。
  video.poster=m.storyboard;
  video.setAttribute('aria-label',m.id+' '+m.title+'的运动切片');
  video.addEventListener('play',()=>{for(const other of document.querySelectorAll('video'))if(other!==video)other.pause();});
  const bar=document.createElement('div');bar.className='clip-controls';
  const label=document.createElement('label');label.textContent='播放速度 ';
  const speed=document.createElement('select');speed.setAttribute('aria-label',m.id+' 切片播放速度');
  for(const value of [0.25,0.5,1])speed.append(new Option(value===1?'原速':value+' 倍速',String(value)));speed.value='1';
  speed.addEventListener('change',()=>{video.playbackRate=Number(speed.value);});label.append(speed);
  const loopLabel=document.createElement('label'),loop=document.createElement('input');loop.type='checkbox';
  loop.addEventListener('change',()=>{video.loop=loop.checked;});loopLabel.append(loop,' 循环播放');
  const open=document.createElement('a');open.href=m.clip.path;open.textContent='打开切片';open.target='_blank';open.rel='noopener';
  bar.append(label,loopLabel,open);section.append(video,bar);
  if(m.clip.end_ms-m.clip.start_ms<1000){
    const hint=document.createElement('p');hint.className='hint';hint.textContent='短切片，建议慢放并循环查看。';section.append(hint);
  }
  video.addEventListener('error',()=>{
    if(section.querySelector('.clip-error'))return;
    const note=document.createElement('p');note.className='clip-error';note.textContent='切片无法播放，可继续查看分镜或';
    const source=document.createElement('a');source.href=m.document.split('/mechanisms/')[0]+'/video.mp4';source.textContent='打开完整原片';note.append(source);section.append(note);
  });
  parent.append(section);return true;
}
