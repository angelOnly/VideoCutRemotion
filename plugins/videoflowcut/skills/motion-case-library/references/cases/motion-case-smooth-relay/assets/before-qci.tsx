import React from 'react';
import {AbsoluteFill,Img,useCurrentFrame,interpolate,Easing} from 'remotion';
const p=(f:number,a:number,b:number)=>interpolate(f,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.inOut(Easing.cubic)});
const m=(a:number,b:number,t:number)=>a+(b-a)*t;

function Clock({f}:{f:number}){
 const establish=p(f,0,19),flip=p(f,129,158),forward=p(f,167,235),back=p(f,271,294);
 const phase=flip<.5?0:1;
 const sx=flip>0&&flip<1?Math.max(.06,Math.abs(Math.cos(flip*Math.PI)))*.9:m(.35,.90,establish);
 const rot=m(-9,-13,establish)+phase*2;
 const hour=phase===0?190:30+60*forward-30*back;
 const minute=phase===0?58:720*forward-360*back;
 const label=phase===0?p(f,42,57):p(f,156,170);
 return <AbsoluteFill style={{background:'linear-gradient(#a1adbc,#b7b4b4 62%,#c6b7ab)',overflow:'hidden'}}>
  <svg width="720" height="660" viewBox="0 0 720 660">
   <defs><linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop stopColor={phase?'#a77c6b':'#30323a'}/><stop offset=".28" stopColor={phase?'#efb09a':'#76717a'}/><stop offset=".6" stopColor={phase?'#c48e79':'#222832'}/><stop offset="1" stopColor="#584942"/></linearGradient><linearGradient id="dial" x1="0" y1="0" x2=".4" y2="1"><stop stopColor="#adb3c6"/><stop offset=".6" stopColor="#b7b5c5"/><stop offset="1" stopColor="#d3b5ab"/></linearGradient></defs>
   <g transform={`translate(353 327) rotate(${rot}) scale(${sx*1.1} 1.1)`}>
    <ellipse cx="7" cy="9" rx="266" ry="270" fill="#252729"/>
    <circle r="266" fill="url(#rim)"/>
    <circle r="249" fill="#383b42"/>
    <circle r="242" fill="url(#dial)"/>
    {Array.from({length:60},(_,i)=><path key={i} d={`M0 -236 V${i%5===0?-221:-230}`} transform={`rotate(${i*6})`} stroke="#676775" strokeWidth={i%5===0?2:1}/>)}
    {Array.from({length:12},(_,i)=>{const a=(i+1)*Math.PI/6;return <text key={i} x={Math.sin(a)*206} y={-Math.cos(a)*206+17} textAnchor="middle" fill="#4e5166" fontFamily="Arial,sans-serif" fontSize="55" fontWeight="400">{i+1}</text>;})}
    <path d="M-9 31 L-13 -38 L0 -142 L13 -38 L9 31Z" fill="#42495d" transform={`rotate(${hour})`}/>
    <path d="M-5 34 L-7 -112 L0 -209 L7 -112 L5 34Z" fill="#444c5e" transform={`rotate(${minute})`}/>
    <circle r="10" fill="#596174"/>
    <path d="M-160 -174 Q-110 -224 -55 -229" stroke="#e4d7d0" strokeWidth="4" fill="none" opacity=".45"/>
   </g>
   <g transform={`translate(${phase?466:435} ${phase?95:221}) rotate(-6)`} opacity={label}>
    <rect x="-8" y="-6" width={phase?158:236} height="57" rx="3" fill="#20ffb7" opacity=".2"/>
    <rect width={phase?142:220} height="43" rx="2" fill="#30ffc2"/>
    <text x={phase?71:110} y="30" textAnchor="middle" fontSize="26" fontFamily="Microsoft YaHei" fill="#329987">{phase?'双时制':'世界协调时间'}</text>
   </g>
  </svg>
 </AbsoluteFill>;
}

function Qci({f,assets}:{f:number;assets:Record<string,string>}){
 const rise=p(f,0,30),word=p(f,62,80),page=p(f,130,153),dark=p(f,278,295),next=p(f,280,305);
 const drift=p(f,153,449), glitch=f>=62&&f<79;
 return <AbsoluteFill style={{background:'radial-gradient(ellipse at 50% 30%,#202920,#070c08)',overflow:'hidden'}}>
  <svg width="720" height="660" style={{position:'absolute',inset:0}}>
   <g transform={`translate(${212-page*720} ${215-rise*92}) skewX(-15) rotate(-3) scale(${1+rise*.08})`}>
    <rect width="382" height="662" rx="23" fill="#bfc7bc"/>
    <path d="M121 26 H208 V174 H100 V26 H111 M104 144 H205 M122 25 V40 M191 25 V38" fill="none" stroke="#192720" strokeWidth="7"/>
    <rect width="382" height="662" rx="23" fill="#05291d" opacity={word*.64}/>
    <g transform={`translate(0 ${-word*35})`}><rect x="132" y="44" width="65" height="91" rx="10" fill="#e4e4cb"/>
    <path d="M149 44 V135 M178 44 V135 M132 72 H197 M132 104 H197" stroke="#d0d3b7" strokeWidth="1"/></g>
   </g>
   {Array.from({length:16},(_,i)=>{const a=p(f,35+i%5*3,46+i%5*3)*(1-p(f,64,76));return <g key={i} opacity={a} fill="#dce7da"><circle cx={120+(i*97)%480} cy={90+(i*53)%400} r="2"/><path d={`M${120+(i*97)%480} ${90+(i*53)%400} l14 -8`} stroke="#c7d6c6" strokeWidth=".7"/></g>;})}
  </svg>
  <div style={{position:'absolute',left:60-page*720,top:207,opacity:word,color:'#09f5ab',font:'italic 900 280px Arial',letterSpacing:-13,textShadow:'0 0 20px #00e69c,0 0 65px #00d28b',transform:glitch?`translateX(${Math.sin(f*2)*17}px)`:'none'}}>QCI</div>
  {glitch&&[0,1,2,3].map(i=><div key={i} style={{position:'absolute',left:80+(i%2)*44,top:245+i*45,width:470-i*32,height:10,background:'#11ffc0',transform:`translateX(${Math.sin(f+i)*30}px)`}}/>)}
  <div style={{position:'absolute',left:239-page*720,top:447,opacity:p(f,81,93),color:'#46f4b1',font:'italic bold 23px Arial',letterSpacing:1,textShadow:'0 0 10px #05ffac'}}>QoS Class Identifier</div>
  <div style={{position:'absolute',left:258-page*720,top:514,opacity:p(f,91,103),background:'#13f9b5',color:'#1e886b',padding:'8px 14px',font:'20px Microsoft YaHei'}}>服务质量等级标识符</div>
  {page>0&&<div style={{position:'absolute',left:(1-page)*750-drift*14,top:-drift*8,width:748,height:686}}><Img src={assets.paper} style={{width:'100%',height:'100%'}}/><div style={{position:'absolute',inset:0,background:'#090f0d',opacity:dark*.78}}/></div>}
  <div style={{position:'absolute',left:66,top:215,opacity:next,color:'#40ffc4',font:'900 279px Arial',letterSpacing:-13,textShadow:'0 0 7px #16e5ad',transform:next===1?'none':`translateY(${(1-next)*28}px)`}}>5QI</div>
  <div style={{position:'absolute',right:64,top:193,opacity:p(f,323,347),color:'#43ffc5',font:'bold 32px Microsoft YaHei',textShadow:'0 0 5px #16d5ab'}}>5G QoS 标识符</div>
 </AbsoluteFill>;
}
export default function Motion(props:{mode:string;assets:Record<string,string>}){
 const f=useCurrentFrame();
 return props.mode==='clock'?<Clock f={f}/>:<Qci f={f} assets={props.assets}/>;
}
