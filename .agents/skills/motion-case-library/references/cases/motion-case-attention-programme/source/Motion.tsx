import React from 'react';
import {AbsoluteFill,Img,useCurrentFrame} from 'remotion';
import {TimelineVideo} from '@videoflowcut/motion';
const lim=(v:number)=>Math.max(0,Math.min(1,v));
const phase=(f:number,a:number,b:number)=>lim((f-a)/(b-a));
const settle=(v:number)=>1-Math.pow(1-lim(v),3);
const blend=(a:number,b:number,v:number)=>a+(b-a)*v;
const rect=(x:number,y:number,w:number,h:number):any=>({position:'absolute',left:x,top:y,width:w,height:h});
const ff=(p:any,k:string):any=>({fontFamily:p.fonts[k].family,fontWeight:p.fonts[k].weight,fontStyle:p.fonts[k].style});
const grid={backgroundColor:'#111615',backgroundImage:'linear-gradient(rgba(170,195,180,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(170,195,180,.018) 1px,transparent 1px)',backgroundSize:'32px 32px'};
function People({p,f}:{p:any,f:number}){
 const e=p.events,entry=settle(phase(f,e.douyu-5,e.stay)),release=settle(phase(f,e.phone,e.phone+23)),rear=settle(phase(f,e.chair-6,e.chair+15));
 return <div style={{...rect(0,0,480,436),opacity:entry*(1-release),transform:'translateY('+((1-entry)*30+release*42)+'px) scale('+(1-rear*.05)+')',transformOrigin:'240px 240px'}}>
 <svg style={rect(0,0,480,436)} viewBox="0 0 480 436"><defs><linearGradient id="beamRerun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8EC9A7" stopOpacity=".15"/><stop offset="1" stopColor="#8EC9A7" stopOpacity=".01"/></linearGradient></defs><path d="M230 183L72 436H409L250 183Z" fill="url(#beamRerun)"/></svg>
 {[0,1,2,3].map(r=>[0,1,2,3,4,5,6].map(c=>{
 const h=45+r*7,x=35+c*65+(r%2)*16,y=279+r*35,en=settle(phase(f,e.douyu-4+r*4,e.douyu+14+r*4));
 return <svg key={r+'-'+c} style={{...rect(x-20,y+(1-en)*27,42,h),opacity:en*(1-rear*.22)}} viewBox="0 0 70 100"><circle cx="35" cy="19" r="14" fill={'rgba(198,220,204,'+(.20+r*.13)+')'}/><path d="M5 100V74Q5 44 35 44Q65 44 65 74V100" fill={'rgba(184,210,193,'+(.18+r*.13)+')'}/></svg>;
 }))}
 {[104,240,376].map((x,i)=>{
 const change=i===1?settle(phase(f,e.leave,e.leave+9)):0,d=i===1?82+change*8:68;
 return <div key={i} style={{...rect(x-d/2,152-d/2,d,d),borderRadius:'50%',border:'1.5px solid #759D82',background:'#263A2E',overflow:'hidden',display:'flex',alignItems:'center',justifyContent:'center',color:'#E0E7DE',...ff(p,'body'),fontSize:14,lineHeight:1.3,textAlign:'center'}}>
 {i===1?(f<e.leave?<Img src={p.assets.identity} style={{width:d,height:d,objectFit:'contain'}}/>:<span style={{opacity:change}}>主播<br/>暂时离开</span>):<span>{i===0?'娱乐直播':'户外直播'}</span>}
 </div>;
 })}
 {f<e.leave&&<div style={{...rect(194,197,92,22),textAlign:'center',...ff(p,'body'),fontSize:16,color:'#D4E1D5'}}>大司马</div>}
 </div>;
}
function Opening({p,f}:{p:any,f:number}){
 const gone=settle(phase(f,p.events.douyu-2,p.events.douyu+12));
 if(gone===1)return null;
 return <div style={{...rect(0,0,480,436),opacity:1-gone}}>
 {[{text:'时代不同',y:96,size:88,start:0,w:380},{text:'平台的观众变了',y:185,size:61,start:4,w:448}].map((t,i)=>{
 const inP=settle(phase(f,t.start,t.start+13));
 return <div key={t.text} style={{...rect((480-t.w)/2,t.y-gone*50+(1-inP)*12,t.w,i===0?105:76),...ff(p,i===0?'display':'serif'),fontSize:t.size,lineHeight:(i===0?'105px':'76px'),textAlign:'center',letterSpacing:i===0?-2:0,color:'#EEEAE0',opacity:inP,transform:'scale('+blend(1.035,1,inP)+')',textShadow:'1px 2px 2px rgba(0,0,0,.2)'}}>{t.text}</div>;
 })}
 </div>;
}
function RealChair({p,f}:{p:any,f:number}){
 const start=p.events.chair-6,outStart=p.events.phone;
 if(f<start||f>=outStart+23)return null;
 const a=settle(phase(f,start,start+20)),b=settle(phase(f,outStart,outStart+23));
 // 摄影椅外轮廓与气杆两侧空隙同属原图坐标；灰色绗缝背布保留。
 const silhouette='M .36 .012 L .49 .007 L .55 .016 L .58 .034 L .604 .08 L .619 .14 L .65 .18 L .73 .215 L .758 .25 L .761 .29 L .729 .333 L .699 .365 L .690 .398 L .710 .482 L .845 .482 L .872 .494 L .873 .505 L .856 .520 L .838 .522 L .832 .679 L .75 .700 L .667 .708 L .652 .850 L .790 .886 L .809 .908 L .803 .959 L .770 .975 L .750 .962 L .739 .940 L .48 .867 L .452 .975 L .417 .993 L .382 .983 L .379 .956 L .414 .900 L .17 .930 L .181 .958 L .154 .973 L .135 .955 L .134 .904 L .350 .854 L .433 .850 L .432 .708 L .270 .697 L .206 .650 L .180 .539 L .145 .522 L .135 .504 L .136 .491 L .161 .482 L .240 .489 L .247 .377 L .210 .333 L .166 .283 L .166 .248 L .182 .218 L .255 .170 L .303 .108 Z M .267 .719 L .422 .719 L .425 .846 L .278 .874 L .252 .886 L .269 .866 Z M .569 .719 L .746 .713 L .726 .851 L .657 .841 L .575 .824 Z';
 return <div style={{...rect(0,0,480,436),opacity:a*(1-b),transform:'translateY('+((1-a)*80+b*90)+'px) scale('+(blend(.79,1,a)-b*.12)+')',transformOrigin:'240px 280px'}}>
 <svg width="0" height="0" style={{position:'absolute'}}><defs><clipPath id="chairPhotoContourV2" clipPathUnits="objectBoundingBox"><path d={silhouette} fillRule="evenodd" clipRule="evenodd"/></clipPath></defs></svg>
 <div style={{...rect(158,413,164,10),background:'rgba(0,0,0,.3)',borderRadius:'50%',filter:'blur(3px)'}}/>
 <Img src={p.assets.chair} style={{...rect(120,104,240,320),objectFit:'contain',clipPath:'url(#chairPhotoContourV2)'}}/>
 </div>;
}
function SourceWindow({slot,crop,w,h}:{slot:string,crop:number[],w:number,h:number}){
 const [x,y,cw,ch]=crop;
 const scale=Math.max(w/(1280*cw),h/(720*ch)),sw=1280*scale,sh=720*scale;
 return <div style={{...rect(0,0,w,h),overflow:'hidden'}}>
 <TimelineVideo slot={slot} fit="fill" style={{position:'absolute',width:sw,height:sh,left:-x*sw+(w-cw*sw)/2,top:-y*sh+(h-ch*sh)/2}}/>
 </div>;
}
function LivePage({p,f,page,index}:{p:any,f:number,page:any,index:number}){
 const entering=index===0?1:settle(phase(f,page.a,page.a+11));
 const exit=page.turn<900?settle(phase(f,page.turn,page.turn+11)):0;
 const y=(1-entering)*430-exit*430;
 return <div style={{...rect(0,y,212,430),background:'#16221B'}}>
 <div style={rect(0,0,212,304)}><SourceWindow slot={page.slot} crop={page.game} w={212} h={304}/></div>
 <div style={rect(0,304,212,126)}><SourceWindow slot={page.slot} crop={page.face} w={212} h={126}/></div>
 </div>;
}
function Handset({p,f}:{p:any,f:number}){
 const e=p.events;
 if(f<e.phone||f>=e.phoneEnd)return null;
 const enter=settle(phase(f,e.phone,e.phone+22)),near=settle(phase(f,e.effect,e.effect+24)),leave=phase(f,e.pressure,e.phoneEnd);
 const exit=leave*leave;
 const w=blend(214,232,near),h=blend(426,462,near),cx=blend(248,240,near)+(1-enter)*130,cy=blend(220,205,near)+exit*535;
 return <div style={{...rect(cx-w/2,cy-h/2,w,h),boxSizing:'border-box',borderRadius:23,padding:5,background:'#929D97',boxShadow:'4px 6px 0 #36423C,0 7px 12px rgba(0,0,0,.30)',transform:'perspective(850px) rotateY('+(-31*(1-enter))+'deg) rotateZ('+(6*(1-enter))+'deg)'}}>
 <div style={{position:'relative',width:'100%',height:'100%',borderRadius:19,overflow:'hidden',background:'#18271D'}}>
 <div style={{...rect(0,0,212,430),transform:'scale('+((w-10)/212)+','+((h-10)/430)+')',transformOrigin:'0 0'}}>
 {p.pages.map((page:any,i:number)=>f>=page.a&&f<page.b?<LivePage key={page.slot} p={p} f={f} page={page} index={i}/>:null)}
 </div>
 <div style={{...rect((w-10)/2-20,5,40,5),background:'#142119',borderRadius:4}}/>
 </div></div>;
}
function LetterAct({p,f}:{p:any,f:number}){
 const start=p.events.effect,retire=p.events.pressure-3,end=retire+14;
 if(f<start||f>=end)return null;
 const letters=[{t:'不',x:99,d:0,r:-68,dx:-12,dy:3,len:14},{t:'能',x:193,d:3,r:64,dx:-5,dy:-4,len:14},{t:'冷',x:287,d:8,r:72,dx:5,dy:3,len:14},{t:'场',x:381,d:5,r:-70,dx:12,dy:2,len:13}];
 const out=settle(phase(f,retire,end));
 return <div style={{...rect(0,0,480,436),perspective:780}}>
 {letters.map((l,i)=>{
 const first=start+l.d,a=settle(phase(f,first,first+l.len)),side=i<2?-1:1;
 return <div key={l.t} style={{...rect(l.x-58,154,116,140),...ff(p,'display'),fontSize:120,lineHeight:'140px',textAlign:'center',color:'#EEEAE0',textShadow:'1px 3px 2px rgba(0,0,0,.28)',opacity:phase(f,first,first+3)*(1-out),transformOrigin:'50% 50%',transform:'translate('+(l.dx*(1-a)+side*out*20)+'px,'+(l.dy*(1-a))+'px) rotateY('+(l.r*(1-a)+side*out*28)+'deg)'}}>{l.t}</div>;
 })}
 </div>;
}
function Programme({p,f}:{p:any,f:number}){
 const e=p.events,plate=settle(phase(f,e.board,e.board+22)),photo=settle(phase(f,e.art,e.art+20)),line=phase(f,e.plan,e.plan+22);
 return <div style={rect(0,0,480,436)}>
 <div style={{...rect(48,126+(1-photo)*110,384,216),opacity:photo,borderRadius:4,overflow:'hidden',transform:'scale('+blend(.92,1,photo)+')',transformOrigin:'50% 0',boxShadow:'0 4px 7px rgba(0,0,0,.24)'}}>
 <Img src={p.assets.art} style={{...rect(-72,0,448,252.11),objectFit:'cover'}}/>
 </div>
 <div style={{...rect(40,40,400,96),borderRadius:16,background:'#65716A',borderTop:'1px solid #859087',boxShadow:'0 5px 8px rgba(0,0,0,.28)',opacity:plate,transform:'scaleX('+blend(.72,1,plate)+') scaleY('+blend(.90,1,plate)+')',transformOrigin:'48px 48px'}}>
 <div style={{...rect(108,21,272,54),borderRadius:7,background:'#263A2E',boxShadow:'inset 0 2px 3px rgba(0,0,0,.35)',display:'flex',alignItems:'center',justifyContent:'center',color:'#A6CDAE',...ff(p,'body'),fontSize:29,whiteSpace:'nowrap'}}>欢迎来到直播间</div>
 <svg style={rect(8,8,80,80)} viewBox="0 0 80 80"><circle cx="40" cy="40" r="39" fill="#D0D9D0" stroke="#8FC79E" strokeWidth="2"/><circle cx="40" cy="32" r="15" fill="#486454"/><path d="M18 69Q18 48 40 48Q62 48 62 69" fill="#486454"/><path d="M18 35V29Q18 8 40 8Q62 8 62 29V35" stroke="#253E2E" strokeWidth="5" fill="none"/><rect x="14" y="27" width="9" height="21" rx="4" fill="#253E2E"/><rect x="57" y="27" width="9" height="21" rx="4" fill="#253E2E"/></svg>
 </div>
 <svg style={rect(0,0,480,436)} viewBox="0 0 480 436">
 <defs><clipPath id="arrowGrowth"><rect x="65" y="125" width={155*line} height="100"/></clipPath></defs>
 <g clipPath="url(#arrowGrowth)"><path d="M88 129Q74 159 82 178Q93 204 130 208L207 211" fill="none" stroke="#86BE9A" strokeWidth="2" strokeDasharray="3 6"/><path d="M199 205L210 211L199 217" fill="none" stroke="#86BE9A" strokeWidth="2"/></g>
 </svg>
 {p.strips.map((s:any,i:number)=>{
 const start=e.plan+i*4,en=settle(phase(f,start,start+12));
 return <div key={s.text} style={{...rect(s.x-s.w/2,s.y-s.h/2,s.w,s.h),opacity:en,transform:'translateY('+((1-en)*(348-s.y))+'px)',background:'#E8E8E1',border:'1.2px solid #435046',borderBottom:'2px solid #435046',borderRadius:5,boxSizing:'border-box',boxShadow:'2px 3px 3px rgba(0,0,0,.24)',display:'flex',alignItems:'center',justifyContent:'center',...ff(p,'serif'),fontSize:s.size,color:'#202821',whiteSpace:'nowrap',letterSpacing:s.size===22?-.5:0}}>{s.text}</div>;
 })}
 </div>;
}
// 本轮语义点共用切线连接，源场景时刻不因镜片路径改变。
function ReadingPoint(p:any,f:number){
 const nodes=p.lensNodes;
 if(f<=nodes[0].f)return [nodes[0].x,nodes[0].y];
 const last=nodes.length-1;
 if(f>=nodes[last].f)return [nodes[last].x,nodes[last].y];
 let k=0;while(k<last-1&&f>=nodes[k+1].f)k++;
 const duration=nodes[k+1].f-nodes[k].f,t=(f-nodes[k].f)/duration;
 const tangent=(i:number,key:string)=>{
 if(i===last)return 0;
 if(i===0)return (nodes[1][key]-nodes[0][key])/(nodes[1].f-nodes[0].f)*.7;
 return (nodes[i+1][key]-nodes[i-1][key])/(nodes[i+1].f-nodes[i-1].f);
 };
 return ['x','y'].map(key=>(2*t*t*t-3*t*t+1)*nodes[k][key]+(t*t*t-2*t*t+t)*duration*tangent(k,key)+(-2*t*t*t+3*t*t)*nodes[k+1][key]+(t*t*t-t*t)*duration*tangent(k+1,key));
}
function Observer({p,f}:{p:any,f:number}){
 const e=p.events;if(f<e.lens)return null;
 const a=settle(phase(f,e.lens,e.lensSettled)),point=ReadingPoint(p,f),x=blend(360,point[0],a),y=blend(85,point[1],a),d=blend(292,216,a),r=d/2,z=1.42;
 return <div style={{...rect(x-r,y-r,d,d),borderRadius:'50%',overflow:'hidden',opacity:phase(f,e.lens,e.lens+4),border:'1.8px solid #94CBA4',boxSizing:'border-box',boxShadow:'0 4px 7px rgba(0,0,0,.24)'}}>
 {/* 同时刻同状态，programme不包含Observer，因此没有递归镜片。 */}
 <div style={{...rect(r-z*x,r-z*y,480,436),...grid,transform:'scale('+z+')',transformOrigin:'0 0'}}><Programme p={p} f={f}/></div>
 </div>;
}
export default function AttentionFilm(p:any){
 const f=useCurrentFrame();
 return <AbsoluteFill style={{background:'#111615',overflow:'hidden'}}>
 <div style={{...rect(3.2,0,544,960),transform:'scale(1.4)',transformOrigin:'0 0',background:'#111615'}}>
 <div style={{...rect(32,163,480,436),...grid,overflow:'hidden'}}>
 <People p={p} f={f}/><Opening p={p} f={f}/><RealChair p={p} f={f}/><Handset p={p} f={f}/><LetterAct p={p} f={f}/>
 {f>=p.events.board&&<Programme p={p} f={f}/>}<Observer p={p} f={f}/>
 </div>
 {/* 正式固定白带由作品承担，文字仅由原生Caption轨绘制。 */}
 <div style={{...rect(32,600,480,60),background:'#F5F4F0'}}/>
 </div></AbsoluteFill>;
}