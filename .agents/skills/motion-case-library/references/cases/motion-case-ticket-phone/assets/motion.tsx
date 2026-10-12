import React from 'react';
import {AbsoluteFill,useCurrentFrame,interpolate,Easing} from 'remotion';
const p=(f:number,a:number,b:number)=>interpolate(f,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.inOut(Easing.cubic)});
const m=(a:number,b:number,t:number)=>a+(b-a)*t;

function TicketFace({highlight=0}:{highlight?:number}){
 return <g>
  <rect width="540" height="218" rx="12" fill="#f6f8ef"/>
  <path d="M403 0 H528 Q540 0 540 12 V206 Q540 218 528 218 H403Z" fill="#2616bd"/>
  <path d="M403 0 V218" stroke="#25232c" strokeWidth="3" strokeDasharray="3 5"/>
  <rect x="23" width="208" height="24" rx="4" fill="#2418bd"/>
  <text x="35" y="18" fill="white" fontFamily="Arial" fontSize="18">BOARDING PASS</text>
  <rect x="290" y="0" width="103" height="13" fill="#2515b7"/>
  <text x="298" y="10" fill="white" fontFamily="Arial" fontSize="8">ECONOMY CLASS</text>
  <rect x="16" y="43" width="11" height="144" fill="#101511"/>
  <text x="48" y="78" fill="#141917" fontFamily="Arial" fontWeight="bold" fontSize="22">NEW YORK</text>
  <path d="M168 70 H274" stroke="#222" strokeDasharray="2 4"/>
  <circle cx="215" cy="67" r="24" fill="#2b18c2"/>
  <path d="M202 58 L212 62 L225 49 L230 53 L221 66 L225 80 L220 83 L213 72 L203 79 L199 76 L207 66 L198 62Z" fill="white"/>
  <text x="282" y="78" fill="#141917" fontFamily="Arial" fontSize="22" fontWeight="bold">BEIJING</text>
  <rect x="45" y="88" width={165*highlight} height="19" fill="#20f5a6"/>
  <text x="48" y="103" fill="#151a16" fontFamily="Arial" fontSize="13">OCTOBER 01-2026</text>
  <text x="70" y="121" fill="#151a16" fontFamily="Arial" fontSize="13">10:30 PM</text>
  {['PASSENGER','CLASS','DATE','SEAT'].map((t,i)=><g key={i}><text x={47+i*86} y="160" fill="#171c18" fontFamily="Arial" fontSize="11">{t}</text><text x={50+i*86} y="181" fill="#586158" fontFamily="Arial" fontSize="10">{['','N','10-01','23A'][i]}</text></g>)}
  {['PASSENGER','FLIGHT','GATE','SEAT'].map((t,i)=><text key={i} x="424" y={56+i*34} fill="white" fontSize="10" fontFamily="Arial">{t}</text>)}
  <rect x="423" y="188" width="99" height="12" fill="white"/>
 </g>;
}

function Ticket({f}:{f:number}){
 const enter=p(f,0,29),price=p(f,14,35),refund=p(f,50,73),phone=p(f,66,95),turn=p(f,83,105),push=p(f,104,137),retreat=p(f,162,193),date=p(f,190,239),highlight=p(f,223,243);
 const phoneScale=(1+push*1.28)*(1-retreat*.43);
 const px=m(293,162,push)+retreat*350,py=m(217,0,push)+(1-phone)*650;
 return <AbsoluteFill style={{background:'radial-gradient(ellipse at 57% 37%,#123328,#060b08 76%)',overflow:'hidden'}}>
  <svg width="720" height="660" viewBox="0 0 720 660">
   <g opacity={(1-phone*.5)*(1-date*.15)} transform={`translate(${-date*55} ${-date*45}) scale(${1+date*.28})`}>
    <text x="32" y="235" fontFamily="Arial" fontSize="174" fontWeight="900" fill="#17ffae" opacity={price}>¥640</text>
    <text x="469" y={235+refund*220} fontFamily="Arial" fontSize="174" fontWeight="900" fill="#17ffae" opacity={price*(1-refund)}>9</text>
   </g>
   <g transform={`translate(${87-date*135} ${m(371,286,enter)+date*50}) rotate(${-8+date*3}) scale(${1+date*.65})`}>
    <TicketFace highlight={highlight}/>
   </g>
   <g transform={`translate(${px} ${py}) scale(${phoneScale})`} opacity={phone*(1-p(f,194,208))}>
    {/* 手机翻面保持同一中心，推近在翻面收势前开始。 */}
    <g transform={`translate(122 0) scale(${Math.max(.035,Math.abs(Math.cos(turn*Math.PI)))} 1) translate(-122 0)`}>
     <rect x="4" y="7" width="247" height="456" rx="27" fill="#6d756c"/>
     <rect width="245" height="456" rx="27" fill={turn<.5?'#d7dace':'#080b09'} stroke="#a7afa4" strokeWidth="2"/>
     {turn<.5?<g>{[0,1,2].map(i=><circle key={i} cx={i===2?58:27} cy={i===1?61:28} r="12" fill="#20251e"/>)}<circle cx="57" cy="61" r="5" fill="#f3f2cf"/></g>:<g fontFamily="Microsoft YaHei">
      <text x="122" y="45" textAnchor="middle" fill="white" fontSize="19" fontWeight="bold">纽约-北京</text>
      <rect x="12" y="62" width="221" height="40" fill="#202321"/>
      <text x="18" y="87" fill="white" fontSize="14">经济舱</text><text x="77" y="86" fill="#bfc3bb" fontSize="10">公务/头等舱</text>
      <text x="20" y="132" fill="#1dffa9" fontSize="23" fontWeight="bold">¥6409</text>
      <text x="18" y="155" fill="white" fontSize="10">托运行李1×23kg，手提行李1×8kg</text>
      <rect x="16" y="164" width={p(f,127,150)*157} height="21" fill="#dbc440" opacity=".24"/>
      <text x="18" y="179" fill="#f4d448" fontSize="11" fontWeight="bold">！不支持退票，不支持改期</text>
      {['航班机型：9420B','舱位类型：超值特价','中转经停：航变免费退改'].map((t,i)=><text key={i} x="18" y={201+i*19} fill="#d7dcd2" fontSize="10">{t}</text>)}
      <rect x="181" y="113" width="47" height="48" rx="8" fill="#20fb94"/><text x="204" y="149" textAnchor="middle" fill="#052313" fontSize="34" fontWeight="bold">订</text>
      <rect x="14" y="263" width="216" height="27" fill="#282c28"/><text x="19" y="281" fill="#babfb7" fontSize="9">起飞前：请核对退改规则与电子凭证</text>
     </g>}
    </g>
   </g>
  </svg>
 </AbsoluteFill>;
}

function Magnet({f}:{f:number}){
 const entry=p(f,0,30),field=p(f,18,50),ghost=p(f,43,80),lift=p(f,62,115),switcher=p(f,119,157),tube=p(f,120,140),travel=p(f,151,250);
 return <AbsoluteFill style={{background:'#cbc9bb',overflow:'hidden'}}>
  <svg width="960" height="540" viewBox="0 0 960 540">
   <defs>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#172b75"/><stop offset=".5" stopColor="#3c58bf"/><stop offset="1" stopColor="#172965"/></linearGradient>
    <linearGradient id="red" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#822829"/><stop offset=".5" stopColor="#c64943"/><stop offset="1" stopColor="#7d2027"/></linearGradient>
    <linearGradient id="copper" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#62421f"/><stop offset=".23" stopColor="#a46c2f"/><stop offset=".5" stopColor="#d5a754"/><stop offset=".72" stopColor="#b58439"/><stop offset="1" stopColor="#543b24"/></linearGradient>
   </defs>
   <g transform={`translate(${-switcher*1040} ${(1-entry)*160}) translate(475 240) scale(${1+p(f,44,112)*.18}) translate(-475 -240)`}>
    <path d="M462 0 V532 M488 0 V532" stroke="#888f81" strokeWidth="11"/>
    <path d="M454 20 Q475 -18 496 20 V117 Q475 146 454 117Z" stroke="#808a7b" strokeWidth="7" fill="none"/>
    <g opacity={1-ghost*.64}>
     <path d="M253 501 V239 Q253 150 400 150 H441" stroke="url(#blue)" strokeWidth="108" fill="none"/>
     <path d="M696 501 V239 Q696 150 549 150 H509" stroke="url(#red)" strokeWidth="108" fill="none"/>
     {Array.from({length:19},(_,i)=><g key={i} opacity=".23"><path d={`M208 ${275+i*11} H299`} stroke="#7d90c9" strokeWidth="3"/><path d={`M650 ${275+i*11} H741`} stroke="#e78470" strokeWidth="3"/></g>)}
     <rect x="200" y="490" width="112" height="26" fill="#40433e"/><rect x="640" y="490" width="115" height="26" fill="#40433e"/>
    </g>
    {[0,1,2,3,4].map(i=><g key={i} opacity={field}>
     <path d={`M550 180 C${580+i*13} ${38-i*8},${372-i*13} ${38-i*8},400 180 M550 205 C${578+i*12} ${361+i*12},${372-i*12} ${361+i*12},400 205`} fill="none" stroke="#b64b52" strokeWidth="1.8"/>
     <path d="M0 0 L8 -4 L7 5Z" fill="#b64b52" transform={`translate(${480+Math.sin(f*.055+i)*65} ${69-i*9}) rotate(180)`}/>
    </g>)}
    <g fontFamily="Microsoft YaHei" fontSize="36" fontWeight="bold"><rect x="336" y="158" width="58" height="55" fill="#e3e3d8"/><text x="365" y="200" textAnchor="middle" fill="#242828">南</text><rect x="555" y="158" width="58" height="55" fill="#e3e3d8"/><text x="584" y="200" textAnchor="middle" fill="#242828">北</text></g>
    <g transform={`translate(475 ${320-lift*120})`}>
     <ellipse rx="31" ry="85" fill="none" stroke="#76866e" strokeWidth="9"/>
     <ellipse rx="26" ry="82" fill="none" stroke="#b7c19d" strokeWidth="3"/>
     <path d="M-20 58 Q-47 -10 -8 -73 M20 -58 Q47 10 8 73" fill="none" stroke="#224e92" strokeWidth="4" opacity={field}/>
     <path d="M-10 -77 L-9 -60 L-23 -69 M10 77 L9 60 L23 69" fill="#224e92" opacity={field}/>
    </g>
    <path d={`M475 ${274-lift*100} v-88 m0 0 l-11 17 m11 -17 l11 17`} stroke="#295889" strokeWidth="8" fill="none" opacity={p(f,81,102)}/>
   </g>
   <g transform={`translate(${(1-switcher)*1040} 0)`} opacity={tube}>
    <rect x="305" y="-30" width="349" height="635" fill="url(#copper)"/>
    {Array.from({length:16},(_,i)=><path key={i} d={`M307 ${i*38} Q480 ${i*38+24} 652 ${i*38}`} fill="none" stroke="#694a28" strokeWidth="2" opacity=".6"/>)}
    <g transform={`translate(480 ${93+travel*310})`}>
     <rect x="-49" y="-66" width="98" height="134" rx="8" fill="#c3b68a" stroke="#5e5d4b" strokeWidth="3"/>
     <text x="0" y="-23" textAnchor="middle" fontSize="32" fontFamily="Microsoft YaHei" fill="#263544">南</text>
     <path d="M-46 1 H46" stroke="#6d6c50"/>
     <text x="0" y="48" textAnchor="middle" fontSize="32" fontFamily="Microsoft YaHei" fill="#263544">北</text>
     {[-94,99].map((y,i)=><g key={i}><ellipse cy={y} rx="153" ry="20" fill="none" stroke="#244883" strokeWidth="3"/><path d={`M-147 ${y} l12 -10 v14Z`} fill="#244883"/><path d={`M153 ${y} H213`} stroke="#535445"/><text x="219" y={y+7} fontSize="19" fontFamily="Microsoft YaHei" fill="#343b36">磁场</text></g>)}
    </g>
   </g>
  </svg>
 </AbsoluteFill>;
}
export default function Motion(props:{mode:string}){
 const f=useCurrentFrame();
 return props.mode==='ticket'?<Ticket f={f}/>:<Magnet f={f}/>;
}
