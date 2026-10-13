import React from 'react';
import {AbsoluteFill, useCurrentFrame, interpolate, Easing} from 'remotion';

const lime = '#bcff42';
const ink = '#151716';
const face = 'polygon(0 0, 76% 0, 100% 19%, 100% 100%, 0 100%)';
const ease = (f:number,a:number,b:number) => interpolate(f,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.inOut(Easing.cubic)});
const out = (f:number,a:number,b:number) => interpolate(f,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.out(Easing.cubic)});
const mix = (a:number,b:number,t:number) => a+(b-a)*t;

function Chip({id}:{id:number}) {
  return <svg width="150" height="146" viewBox="0 0 150 146">
    <defs><linearGradient id={'gold'+id} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#f3e4a6"/><stop offset=".28" stopColor="#ac843c"/><stop offset=".55" stopColor="#e8d79a"/><stop offset="1" stopColor="#9f7334"/></linearGradient></defs>
    <rect x="3" y="3" width="144" height="140" rx="22" fill={'url(#gold'+id+')'} stroke="#9b824e" strokeWidth="3"/>
    <rect x="55" y="38" width="40" height="70" rx="12" fill="none" stroke="#78622e" strokeWidth="3"/>
    <path d="M3 46H55M3 99H55M95 46H147M95 99H147M55 3V38M95 3V38M55 108V143M95 108V143M3 72H55M95 72H147" stroke="#78622e" strokeWidth="3" fill="none"/>
    <path d="M12 17H107M12 20H109M12 23H113" stroke="#fff4c8" opacity=".36"/>
  </svg>;
}

function Sim({index,frame}:{index:number;frame:number}) {
  const spread=out(frame,10+index*4,50+index*4);
  const select=ease(frame,108,148);
  const take=ease(frame,163,199);
  const pos=[[-193,-85,-28],[130,-180,16],[-123,160,-9],[199,133,29],[6,-18,-6]][index];
  const picked=index===4;
  const x=mix(0,pos[0],spread)*(1-select*.24);
  const y=mix(index*9,pos[1],spread) + (picked ? -select*40 : select*125);
  const z=picked ? select*140 : 0;
  const scale=1+(picked ? select*.15+take*3.5 : 0);
  const opacity=picked ? 1-take : 1-select*.58;
  const label=out(frame,72+index*5,85+index*5)*(1-take);
  return <div style={{position:'absolute',left:249+x,top:173+y,width:230,height:300,transformStyle:'preserve-3d',transform:`translateZ(${z}px) rotateZ(${mix(-6,pos[2],spread)*(1-take)}deg) scale(${scale})`,opacity}}>
    <div style={{position:'absolute',inset:6,background:'#12170c',filter:`blur(${12+select*8}px)`,opacity:.25,transform:`translate3d(${26+z*.32}px,${35+z*.32}px,-18px)`,clipPath:face}}/>
    {[0,1,2,3,4,5,6,7].map(k=><div key={k} style={{position:'absolute',inset:0,background:k===7?'linear-gradient(145deg,#fafaf5 0%,#d1d4cb 48%,#eef0e9 100%)':['#95988e','#a6a99f'][k%2],clipPath:face,transform:`translateZ(${k*1.4}px)`,borderRadius:10}}>
      {k===7&&<><div style={{position:'absolute',left:37,top:73}}><Chip id={index}/></div><div style={{position:'absolute',left:28,top:25,fontSize:14,color:'#677063',letterSpacing:4}}>SIM / 0{index+1}</div><div style={{position:'absolute',left:28,top:244,fontSize:23,fontWeight:800,color:ink}}>方案 {String.fromCharCode(65+index)}</div></>}
    </div>)}
    <div style={{position:'absolute',left:15,top:-60,transform:`translateZ(${55+select*25}px) rotateX(-35deg) translateY(${(1-label)*22}px)`,opacity:label,background:picked?lime:'#292f29',color:picked?ink:'#e8eddf',padding:'9px 17px',fontSize:22,fontWeight:800,whiteSpace:'nowrap',boxShadow:'0 8px 18px #12180e30'}}>{picked?'优先处理':'接入请求'}</div>
    {picked&&<div style={{position:'absolute',inset:-12,border:`3px solid ${lime}`,transform:'translateZ(14px)',opacity:select*(1-take),boxShadow:'0 0 24px #bcff4244'}}/>}
  </div>;
}

function Page({frame}:{frame:number}) {
  const highlight=out(frame,278,298);
  return <div style={{position:'absolute',inset:0,background:'#f5f3e9',color:ink,padding:'76px 48px',boxSizing:'border-box'}}>
    <div style={{fontSize:18,letterSpacing:4,color:'#73776d',marginBottom:32}}>阅读之前 · 先找适用条件</div>
    <div style={{fontSize:52,fontWeight:900,lineHeight:1.2,letterSpacing:-2}}>流量套餐<br/>服务说明</div>
    <div style={{height:2,background:ink,margin:'30px 0 18px'}}/>
    <div style={{display:'flex',justifyContent:'space-between',fontSize:16,color:'#777c70'}}><span>演示页面 / 非运营商原文</span><span>01—03</span></div>
    <div style={{marginTop:44,fontSize:25,fontWeight:800}}>01　套餐包含什么</div>
    <div style={{fontSize:21,lineHeight:1.8,color:'#6b7066',marginTop:16}}>流量额度、服务范围及有效期，<br/>请以实际购买页面为准。</div>
    <div style={{marginTop:38,fontSize:25,fontWeight:800}}>02　网络繁忙的时候</div>
    <div style={{fontSize:29,lineHeight:1.85,marginTop:15,fontWeight:650}}>
      <span style={{position:'relative',display:'inline-block'}}><span style={{position:'absolute',left:-5,top:7,bottom:5,width:(highlight*100)+'%',background:lime,transform:'rotate(-1deg)'}}/><span style={{position:'relative'}}>接入请求可能有不同优先级</span></span><br/>
      <span style={{fontSize:22,color:'#6b7066'}}>是否适用，需要核对具体条款。</span>
    </div>
    <div style={{marginTop:39,fontSize:25,fontWeight:800}}>03　别漏掉限定条件</div>
    <div style={{fontSize:21,lineHeight:1.8,color:'#6b7066',marginTop:16}}>网络负载、终端能力、信号质量，<br/>都可能影响最终使用体验。</div>
    <div style={{marginTop:44,paddingTop:20,borderTop:'1px solid #c8cbbb',fontSize:16,color:'#7a8074'}}>本页为原创视觉机制测试，不作为事实证据。</div>
  </div>;
}

export default function ContinuousMotion(props:{title?:string}) {
  const f=useCurrentFrame();
  const focus=ease(f,108,148);
  const stageAway=ease(f,166,205);
  const phoneIn=out(f,187,225);
  const push=ease(f,227,274);
  const rip=ease(f,326,354);
  const open=ease(f,385,426);
  const exitText=ease(f,396,414);
  const paperX=mix(64,64,push),paperY=mix(260,112,push);
  const paperScale=mix(.85,1.18,push);
  const gap=rip*185+open*850;
  // 固定多尺度纸边：避免规则三角齿，也保证每帧形状完全一致。
  const ridge=Array.from({length:81},(_,i)=>`${i*1.25}% ${53+Math.sin(i*2.71)*.28+Math.sin(i*.54)*.45+Math.sin(i*5.21)*.12}%`);
  const upper='polygon(0 0,100% 0,'+[...ridge].reverse().join(',')+')';
  const lower='polygon('+ridge.join(',')+',100% 100%,0 100%)';
  const wipeIn=out(f,468,479),wipeOut=out(f,480,497);
  const last=out(f,494,514);
  return <AbsoluteFill style={{fontFamily:'"Microsoft YaHei", "Noto Sans CJK SC", sans-serif',color:'#f5f5ed',overflow:'hidden'}}>
    {/* 退出后保留真实 Alpha，让时间轴视频接管；作品本身不嵌音视频。 */}
    <AbsoluteFill style={{background:'#151716',opacity:1-open}}/>
    <AbsoluteFill style={{backgroundImage:'repeating-linear-gradient(0deg,transparent,transparent 3px,#ffffff05 4px)',opacity:(1-open)*.6}}/>
    <div style={{position:'absolute',left:44,right:44,top:62,display:'flex',justifyContent:'space-between',fontSize:16,fontWeight:700,letterSpacing:3,opacity:1-open}}><span>网络现场　/　视觉实验</span><span style={{color:lime}}>01 — 02</span></div>
    {f<210&&<>
      <div style={{position:'absolute',left:46,top:147,fontSize:60,fontWeight:900,lineHeight:1.22,letterSpacing:-2,transform:`translateY(${-stageAway*120}px)`,opacity:1-stageAway}}>看起来相似，<br/><span style={{color:lime}}>待遇未必相同。</span></div>
      <div style={{position:'absolute',left:0,top:388,width:768,height:690,perspective:1300,opacity:1-stageAway,transform:`scale(${1+stageAway*.12})`,background:'radial-gradient(ellipse at 45% 35%,#d8ddd1,#b1b7a9 65%,#909988)',overflow:'hidden'}}>
        <div style={{position:'absolute',left:20,top:48,width:728,height:610,transformStyle:'preserve-3d',transform:`rotateX(${mix(46,35,focus)}deg) rotateZ(${mix(-8,0,focus)}deg) scale(${mix(.84,1.03,focus)})`}}>
          {[0,1,2,3,4].map(i=><Sim key={i} index={i} frame={f}/>)}
        </div>
      </div>
      <div style={{position:'absolute',left:46,right:46,top:1130,opacity:out(f,65,85)*(1-stageAway),fontSize:27,lineHeight:1.5}}>{f<144?'同一个网络里，请求也有先后。':'优先处理 ≠ 凭空增加带宽'}<div style={{marginTop:12,color:'#a9b19e',fontSize:17}}>机制示意 · 方案字母不代表真实套餐等级</div></div>
    </>}
    {f>=184&&f<428&&<>
      <div style={{position:'absolute',left:paperX,top:paperY+(1-phoneIn)*850,width:640,height:1050,transformOrigin:'50% 54%',transform:`perspective(1400px) rotateY(${(1-phoneIn)*-32}deg) rotateZ(${(1-push)*-7}deg) scale(${paperScale})`}}>
        {rip===0&&<div style={{position:'absolute',inset:-17,border:'10px solid #444b41',borderRadius:48,boxShadow:'16px 30px 70px #0009',opacity:1-push}}/>}
        {rip===0?<Page frame={f}/>:['upper','lower'].map((part,i)=><div key={part} style={{position:'absolute',inset:0,clipPath:i===0?upper:lower,transform:`translateY(${i===0?-gap:gap}px) rotate(${(i===0?-1:1)*rip*1.6}deg)`,filter:'drop-shadow(0 12px 12px #0007)'}}><Page frame={f}/></div>)}
      </div>
      <div style={{position:'absolute',left:38,right:38,top:566,textAlign:'center',transform:`scale(${mix(.88,1,out(f,340,364))}) translateY(${exitText*-70}px)`,opacity:out(f,340,354)*(1-exitText)}}>
        <div style={{fontSize:23,color:'#dce3d1',letterSpacing:6,marginBottom:14}}>真正要看的是</div>
        <div style={{fontSize:86,fontWeight:950,lineHeight:1.14,color:lime,letterSpacing:-3,textShadow:'2px 5px 0 #477410'}}>忙的时候<br/>谁先被处理？</div>
      </div>
    </>}
    {f>=413&&f<469&&<div style={{position:'absolute',left:42,right:42,bottom:160,opacity:out(f,413,430),background:'#131713de',padding:'24px 26px',borderLeft:`6px solid ${lime}`}}><div style={{fontSize:21,color:lime,marginBottom:9}}>从规则，回到真实网络</div><div style={{fontSize:40,fontWeight:850}}>还要看基站的实际负载。</div></div>}
    {f>=468&&f<500&&<div style={{position:'absolute',left:-160,top:-150,width:1100,height:1700,background:lime,transform:`translateX(${mix(1120,0,wipeIn)+wipeOut*-1260}px) skewX(-9deg)`}}/>}
    {f>=498&&<div style={{position:'absolute',left:42,right:42,bottom:134,opacity:last,transform:`translateY(${(1-last)*50}px)`,background:'#151716ec',padding:'28px 28px 30px'}}><div style={{fontSize:18,letterSpacing:4,color:'#bac3ae',marginBottom:12}}>再回到你的手机</div><div style={{fontSize:49,fontWeight:900,lineHeight:1.25}}>信号、负载、套餐<br/><span style={{color:lime}}>一起看，才完整。</span></div></div>}
    <div style={{position:'absolute',left:44,bottom:43,fontSize:15,letterSpacing:2,color:'#cdd5c2',textShadow:'0 1px 5px #000'}}>独立动效样段　/　纯视觉测试</div>
  </AbsoluteFill>;
}
