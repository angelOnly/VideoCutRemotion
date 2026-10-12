import React from 'react';
import {useCurrentFrame} from 'remotion';
import {TimelineVideo} from '@videoflowcut/motion';

/** 开发对照：背景使用同一实际源；改版只调整交叠的层级、面积和接入。 */
export default function Motion(props: {offset?: number; fonts: {title: {family: string; weight: number; style: string}; body: {family: string; weight: number; style: string}}}) {
  const frame = useCurrentFrame() + (props.offset || 0);
  const repaired = true;
  const entry = Math.min(1, Math.max(0, (frame - 12) / 24));
  const progress = Math.min(1, Math.max(0, (frame - 96) / 72));
  const ease = progress * progress * (3 - 2 * progress);
  const oldAlpha = repaired ? entry * (1 - ease * 0.82) * (1 - Math.min(1, Math.max(0, (frame - 160) / 8))) : entry * (1 - Math.min(1, Math.max(0, (frame - 154) / 14)));
  const newAlpha = Math.min(1, Math.max(0, (frame - 100) / 24));
  const oldX = repaired ? 90 - 670 * ease : 90;
  const newX = repaired ? 940 - 850 * ease : 110;
  const oldScale = repaired ? 1 - ease * 0.22 : 1;
  const newSub = repaired ? Math.min(1, Math.max(0, (frame - 152) / 24)) : newAlpha;
  const captionFirst = frame < 120;
  return <div style={{position:'absolute',inset:0,width:960,height:540,overflow:'hidden',background:'#121820'}}>
    <TimelineVideo slot="footage" style={{position:'absolute',inset:0,width:960,height:540,objectFit:'cover',opacity:0.45}}/>
    <div style={{position:'absolute',inset:0,background:'linear-gradient(180deg,rgba(8,15,22,.16),rgba(8,15,22,.48) 70%,rgba(8,15,22,.9))'}}/>
    <div style={{position:'absolute',left:44,top:30,color:'#b6c6d4',fontSize:18,fontFamily:props.fonts.body.family,fontWeight:props.fonts.body.weight,fontStyle:props.fonts.body.style}}>连续表达 · 开发对照</div>
    <div style={{position:'absolute',left:oldX,top:175,width:680,opacity:oldAlpha,transform:'scale('+oldScale+')',transformOrigin:'left center',fontFamily:props.fonts.title.family,fontWeight:props.fonts.title.weight,fontStyle:props.fonts.title.style,color:'#fff3d4'}}>
      <div style={{fontSize:62,lineHeight:1.25}}>代码复用</div>
      <div style={{fontSize:42,lineHeight:1.5}}>不会自动延续状态</div>
    </div>
    <div style={{position:'absolute',left:newX,top:repaired?175:188,width:680,opacity:newAlpha,fontFamily:props.fonts.title.family,fontWeight:props.fonts.title.weight,fontStyle:props.fonts.title.style,color:'#b6efef'}}>
      <div style={{fontSize:58,lineHeight:1.32}}>分段输出可以保留</div>
      <div style={{fontSize:40,lineHeight:1.5,opacity:newSub}}>共同状态继续发展</div>
    </div>
    <div style={{position:'absolute',left:44,right:44,bottom:28,fontFamily:props.fonts.body.family,fontWeight:props.fonts.body.weight,fontStyle:props.fonts.body.style,fontSize:21,lineHeight:1.5,color:'#f3f7fa',whiteSpace:'pre-line'}}>
      {captionFirst ? '同一源码中使用多个 props.part 分支返回互不衔接的完整画面，仍然属于独立页面；\n代码复用不会自动延续对象和源时间。' : '分段输出本身没有错，\n需要改变的是设计与状态被文件边界切开的做法。'}
    </div>
  </div>;
}

