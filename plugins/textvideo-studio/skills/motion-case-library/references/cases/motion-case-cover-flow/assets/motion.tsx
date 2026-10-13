import React from 'react';
import {AbsoluteFill,useCurrentFrame,interpolate,Easing} from 'remotion';
const p=(f:number,a:number,b:number)=>interpolate(f,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.inOut(Easing.cubic)});
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const colors=['#b7a5cf','#eee8df','#a9c8dc','#747982'];
// 后一动作在前一动作收束前启动，持续保留主物体身份，不插入空白场景。
function Product({f}:{f:number}){
 const fan=p(f,30,100),gather=p(f,150,210),drop=p(f,222,288);
 return <><rect width="960" height="540" fill="#19232d"/><ellipse cx="480" cy="447" rx="260" ry="25" fill="#101820"/>
 <text x="480" y={mix(290,180,p(f,68,127))} textAnchor="middle" fontSize="210" fontWeight="900" fill="#f4f5f2" opacity={p(f,65,95)*(1-p(f,182,220))}>70</text>
 {[0,1,2,3].map((i)=>{const spread=(i-1.5)*125*fan*(1-gather);return <g key={i} transform={`translate(${480+spread} ${mix(660,320,p(f,i*4,48+i*4))+drop*300}) rotate(${(i-1.5)*13*fan*(1-gather)}) scale(${1-.38*gather})`}>
 <rect x="-103" y="-141" width="206" height="282" rx="15" fill="#080c10" stroke="#c3c8ca" strokeWidth="3"/><rect x="-97" y="-135" width="194" height="270" rx="11" fill={colors[i]}/><circle cx="-76" cy="-113" r="11" fill="#171b20"/><circle cx="-76" cy="-113" r="5" fill="#37424f"/><path d="M-40 15 Q0-35 40 15 Q0 80-40 15" fill="none" stroke="#ffffff" strokeOpacity=".25" strokeWidth="3"/></g>})}
 <g transform={`translate(480 ${mix(160,260,p(f,193,249))})`} opacity={p(f,194,224)}><path d="M-30-60H30V0H65L0 65-65 0H-30Z" fill="#b5ff35"/></g></>;
}
const titles=['深空来信','山海之间','城市切片','隐秘世界','时间之外','蓝色星球','声音档案','旷野日记'];
function Wall({f}:{f:number}){
 const spread=p(f,0,65),focus=p(f,163,236),travel=Math.round(Math.min(f,183)*2.3);
 return <><rect width="960" height="540" fill="#101610"/>
 <g transform={`translate(0 ${Math.round(mix(380,0,spread))})`}>
 {[0,1,2].map(row=>Array.from({length:8},(_,i)=>{const x=i*196-230+(row%2?-travel:travel)-row*45;const c=['#be5438','#647a9b','#d8ba68','#6d8570'][(i+row)%4];return <g key={`${row}-${i}`} transform={`translate(${x} ${row*176-2})`}><rect width="184" height="164" fill={c}/><circle cx={50+i%3*36} cy="62" r={34+i%2*22} fill="#202a30"/><path d="M0 140L60 70 125 128 184 45V164H0Z" fill="#101e24" opacity=".65"/><text x="14" y="146" fill="white" fontSize="22" fontWeight="800">{titles[(i+row)%8]}</text></g>}))}
 <path d="M0 4H960M0 530H960" stroke="#aeff50" strokeWidth="5"/></g>
 <rect width="960" height="540" fill="#101610" opacity={focus*.92}/>
 <g transform={`translate(${Math.round(mix(1200,480,focus))} 270)`}><rect x="-182" y="-232" width="364" height="464" fill="#b7bc81"/><circle cx="0" cy="-52" r={mix(45,102,p(f,222,290))} fill="#263d3c"/><path d="M-182 180L-65-30 45 115 182-55V232H-182Z" fill="#567265"/><text x="0" y="184" textAnchor="middle" fill="#fffbe8" fontSize="46" fontWeight="900">山海之间</text></g></>;
}
function Comments({f}:{f:number}){
 const gather=p(f,119,210),zoom=p(f,218,295);const words=['原来如此','这下看懂了','等一下','还有这种操作','重点来了','为什么呢','再看一遍','懂了'];
 return <><rect width="960" height="540" fill="#eee9de"/>{Array.from({length:24},(_,i)=>{const row=i%6,col=Math.floor(i/6),x=240+col*310+row*27-f*(4+row*.5),targetX=100+(i%4)*225,targetY=135+Math.floor(i/4)*51;return <text key={i} x={mix(x,targetX,gather)} y={mix(58+row*87,targetY,gather)} opacity={(1-p(f,175,229))*.82} fill="#303735" fontSize={25+row%3*7} fontWeight="700">{words[i%8]}</text>})}
 <g transform={`translate(480 270) scale(${mix(.75,1.12,zoom)})`} opacity={p(f,164,220)}><path d="M-238-81Q-253-81-253-66V65Q-253 81-237 81H-44L-74 123 0 81H237Q253 81 253 65V-65Q253-81 237-81Z" fill="#ed482d"/><text textAnchor="middle" y="22" fill="#fff8eb" fontSize="62" fontWeight="900">这下看懂了</text></g></>;
}
function Grid({f}:{f:number}){
 const enter=p(f,0,55),move=p(f,50,131),tight=p(f,124,208),out=p(f,218,298),gap=mix(115,65,tight);const cx=mix(390,520,move),cy=mix(255,300,move);
 return <><rect width="960" height="540" fill="#edece8"/><g transform={`translate(${-out*760} 0)`}>
 {[-1,1].map(i=><React.Fragment key={i}><line x1={cx+i*gap} y1={mix(-400,-50,enter)} x2={cx+i*gap} y2={mix(-400,600,enter)} stroke="#202322" strokeWidth="7"/><line x1={mix(1300,-60,enter)} y1={cy+i*gap} x2="1030" y2={cy+i*gap} stroke="#202322" strokeWidth="7"/></React.Fragment>)}
 <circle cx={cx} cy={cy} r={mix(0,55,p(f,82,146))} fill="#282b29"/><circle cx={cx} cy={cy} r={mix(95,66,tight)} stroke="#5a665d" strokeWidth="2" fill="none" opacity={p(f,143,174)}/></g>
 <g transform={`translate(${mix(1250,480,out)} 270) rotate(${mix(8,-3,out)})`}><rect x="-190" y="-232" width="380" height="464" fill="#fff" stroke="#b8b9b2"/><text x="-154" y="-177" fontSize="27" fontWeight="800" fill="#252d28">让结构适应物体</text><path d="M-154-150H150M-154-138H100" stroke="#a4aaa3" strokeWidth="4"/>{Array.from({length:10},(_,i)=><line key={i} x1="-154" x2={i%3?145:100} y1={-110+i*25} y2={-110+i*25} stroke="#c5c8c1" strokeWidth="5"/>)}<rect x="-161" y="-122" width={310*p(f,267,298)} height="42" fill="#d3ec86" opacity=".65"/></g></>;
}
function Road({f}:{f:number}){
 const zoom=p(f,35,115),ride=p(f,99,278),roadY=mix(245,350,zoom);const carX=mix(80,860,ride);
 return <><rect width="960" height="540" fill="#f2f0e9"/><path d={`M-40 ${roadY}H1000`} stroke="#222722" strokeWidth={mix(3,8,zoom)}/>
 <g opacity={1-zoom}><path d="M80 210V180H880V210" fill="none" stroke="#be3f36" strokeWidth="3"/><text x="480" y="160" textAnchor="middle" fontSize="61" fontWeight="800" fill="#be3f36">500 KM</text></g>
 {[0,1,2,3,4].map(i=>{const x=80+i*200;return <g key={i}><circle cx={x} cy={roadY} r={mix(5,8,zoom)} fill="#252b26"/><g opacity={p(f,48+i*6,85+i*6)} transform={`translate(${x} ${roadY})`}><path d="M0-8V-150" stroke="#292e2a" strokeWidth="5"/><rect x="-17" y="-160" width="34" height="76" rx="9" fill="#292e2a"/><circle cy="-142" r="8" fill={carX<x-85?'#df4437':'#4c554b'}/><circle cy="-102" r="8" fill={carX>=x-85?'#7fc776':'#4c554b'}/></g></g>})}
 <g transform={`translate(${carX} ${roadY-23})`} opacity={p(f,77,111)}><path d="M-53-10L-34-37H20L40-14H57V8H-57V-10Z" fill="#c9362c"/><path d="M-27-31H-4V-13H-37ZM2-31H16L33-13H2Z" fill="#e5e8df"/><circle cx="-33" cy="9" r="12" fill="#242925"/><circle cx="35" cy="9" r="12" fill="#242925"/><circle cx="-33" cy="9" r="5" fill="#e3ded0"/><circle cx="35" cy="9" r="5" fill="#e3ded0"/></g>
 <text x="480" y="455" textAnchor="middle" fontSize="30" fill="#42463e" opacity={p(f,204,243)}>距离之外，还有一路的等待</text></>;
}
export default function Motion({mode}:{mode:string}){const f=useCurrentFrame();return <AbsoluteFill><svg width="960" height="540" viewBox="0 0 960 540" style={{fontFamily:'Microsoft YaHei, sans-serif'}}>{mode==='product'?<Product f={f}/>:mode==='wall'?<Wall f={f}/>:mode==='comments'?<Comments f={f}/>:mode==='grid'?<Grid f={f}/>:<Road f={f}/>}</svg></AbsoluteFill>;}
