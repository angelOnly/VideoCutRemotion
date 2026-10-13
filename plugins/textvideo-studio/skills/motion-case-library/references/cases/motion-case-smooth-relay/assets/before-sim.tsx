import React from 'react';
import {AbsoluteFill,useCurrentFrame,interpolate,Easing} from 'remotion';

const ease=(f:number,a:number,b:number)=>interpolate(f,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.inOut(Easing.cubic)});
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const shape='polygon(15% 0,100% 0,100% 100%,0 100%,0 14%)';
// 对照原片 38—46.3 秒的落点重建九张卡，而不是复用上一轮扇形排布。
const cards=[
 {x:176,y:188,r:-35,label:''}, {x:350,y:187,r:17,label:''},
 {x:448,y:229,r:30,label:'QCI 6'}, {x:398,y:273,r:-34,label:'QCI 7'},
 {x:260,y:304,r:-34,label:''}, {x:223,y:373,r:16,label:'QCI 9'},
 {x:470,y:435,r:-24,label:'',back:true}, {x:555,y:447,r:-12,label:'QCI 8'},
 {x:387,y:502,r:8,label:''}
];

function Contact({id}:{id:number}){
 return <svg width="112" height="137" viewBox="0 0 112 137">
  <defs><linearGradient id={'g'+id} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#d3cba3"/><stop offset=".42" stopColor="#e7dfb3"/><stop offset=".74" stopColor="#c9c09a"/><stop offset="1" stopColor="#ded5a9"/></linearGradient></defs>
  <rect x="2" y="2" width="108" height="133" rx="20" fill={'url(#g'+id+')'}/>
  <path d="M39 42 Q39 34 48 34 H71 Q80 34 80 44 V92 Q80 101 70 101 H48 Q39 101 39 92Z M2 39 H39 M2 69 H39 M2 101 H39 M80 39 H110 M80 69 H110 M80 101 H110 M40 2 V34 M79 2 V34 M40 101 V135 M79 101 V135" stroke="#a59b72" strokeWidth="1.4" fill="none"/>
 </svg>;
}

function Card({i,f,push}:{i:number;f:number;push:number}){
 const c=cards[i], delay=[1,0,2,4,2,5,1,4,6][i];
 const t=Math.max(0,Math.min(1,(f-4-delay)/17));
 // 下落加速，触地后仅一次衰减回弹；阴影跟随离地高度，而不是固定投影。
 const airborne=(1-t*t)*470;
 const bounce= f>21+delay&&f<37+delay ? Math.sin((f-21-delay)/16*Math.PI)*19 : 0;
 const settle=ease(f,17+delay,40+delay);
 const x=mix(360+(i%3-1)*45,c.x,settle), y=mix(245+(i%2)*60,c.y,settle);
 const lift=airborne+bounce;
 const rot=mix(c.r+(i%2===0?105:-100),c.r,settle);
 const tilt=mix(i%2===0?135:-45,49,settle);
 const dim=ease(f,60,81);
 const z=1+push*.66, px=451+(x-451)*z-push*50,py=255+(y-255)*z+push*45;
 const points='M-49 -88 H62 Q70 -88 70 -80 V80 Q70 88 62 88 H-62 Q-70 88 -70 80 V-63Z';
 // 把透视投影写成确定性的 SVG 坐标，避免 CSS 3D 合成层的重复定位像素漂移。
 return <svg width="720" height="660" style={{position:'absolute',inset:0,overflow:'hidden'}}>
  <defs><linearGradient id={'s'+i} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#d9dcd4"/><stop offset=".5" stopColor="#aeb7b0"/><stop offset="1" stopColor="#cdd2c9"/></linearGradient></defs>
  <g transform={`translate(${px+lift*.15} ${py+7+lift*.28}) scale(${z*.8} ${z*.51}) rotate(${c.r})`} opacity={mix(.17,.46,1-lift/490)}><path d={points} fill="#161b16"/></g>
  <g transform={`translate(${px} ${py-lift*z}) scale(${z*.8} ${z*.8*Math.cos(tilt*Math.PI/180)}) rotate(${rot})`}>
   <path d={points} transform="translate(0 7)" fill="#40483f"/>
   <path d={points} fill={c.back?'#d8dbd4':'url(#s'+i+')'}/>
   {!c.back&&<g transform="translate(-56 -68)"><Contact id={i}/></g>}
   <path d={points} fill="#1b241d" opacity={dim*.6}/>
  </g>
 </svg>;
}

export default function Replica(){
 const f=useCurrentFrame();
 const dim=ease(f,60,81), push=ease(f,181,201);
 const zoom=1+push*.66;
 return <AbsoluteFill style={{overflow:'hidden',background:'radial-gradient(ellipse at 58% 60%,#93968e 0%,#6a6c65 60%,#4f514b 100%)',fontFamily:'Arial,"Microsoft YaHei",sans-serif'}}>
  <AbsoluteFill style={{background:'#101812',opacity:dim*.52}}/>
  <div style={{position:'absolute',inset:0}}>
   {cards.map((c,i)=><Card key={i} i={i} f={f} push={push}/>)}
   {cards.map((c,i)=>{
    if(!c.label)return null;
    const start=c.label==='QCI 9'?66:c.label==='QCI 7'?77:c.label==='QCI 8'?88:99;
    const a=ease(f,start,start+12), crown=ease(f,204,216);
    return <div key={i} style={{position:'absolute',left:451+(c.x-56-451)*zoom-push*50,top:255+(c.y-48-255)*zoom+push*45-(1-a)*10,opacity:a,color:'#1ff5a2',fontSize:33*zoom,fontWeight:500,letterSpacing:-1,transform:'rotate(13deg) skewY(4deg)',textShadow:'0 0 6px #22e99d,0 0 19px #1df896b0'}}>
     <span style={{clipPath:`inset(0 ${(1-a)*100}% 0 0)`,display:'block',whiteSpace:'nowrap'}}>{c.label}</span>
     {c.label==='QCI 6'&&<svg width={56*zoom} height={37*zoom} viewBox="0 0 56 37" style={{position:'absolute',left:11*zoom,top:-39*zoom-(1-crown)*17,opacity:crown,filter:'drop-shadow(0 0 9px #16ff9b)'}}><path d="M3 5 L16 15 L28 0 L40 15 L53 5 L46 33 H10Z" fill="#21ffad"/></svg>}
    </div>;
   })}
  </div>
 </AbsoluteFill>;
}
