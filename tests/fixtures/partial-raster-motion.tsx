// 从失败作品提取的纯视觉回归：覆盖渐变透明度、采样曲线和移动虚线共同形成的脏区。
import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
const COLORS={background:'#F3F1EA',paper:'#FFFEFA',ink:'#192A35',muted:'#718089',line:'#D4D9D6',blue:'#2775B8',water:'#C4E0F1',orange:'#CB742D'};
const LABELS={quantity:'本月总量',rate:'每秒速率',sharing:'忙时分配',analogy:'水的比喻示意',throughput:'每秒能通过多少',second:'1 秒',sameSecond:'同样 1 秒',sameOutlet:'出口不变',twiceQuantity:'总量 ×2',conclusionLeft:'流量翻倍',conclusionRight:'速度翻倍'};
// 所有值都是本件局部帧；画面与事件直接共用，不借用全片偏移。
const T={model:[0,28],fill:[27,54],flow:[92,112],sampleBefore:[115,139],expand:[157,181],outlet:[179,199],clearSample:[181,189],sampleAfter:[189,213],quantityTwice:[229,241],inequality:[259,271],conclusionRight:[271,283],settle:289,last:316};
function p(frame:number,range:number[]){const value=Math.max(0,Math.min(1,(frame-range[0])/Math.max(1,range[1]-range[0])));return value*value*(3-2*value);}
function mix(a:number,b:number,value:number){return a+(b-a)*value;}
function dropPath(x:number,y:number){return [`M ${x} ${y-21}`,`C ${x-5} ${y-12}, ${x-16} ${y-2}, ${x-16} ${y+8}`,`C ${x-16} ${y+29}, ${x+16} ${y+29}, ${x+16} ${y+8}`,`C ${x+16} ${y-2}, ${x+5} ${y-12}, ${x} ${y-21}`,'Z'].join(' ');}
export default function PartialRasterFixture(props:any){
 const f=useCurrentFrame();const c={...COLORS,...(props.palette||{})};const l={...LABELS,...(props.labels||{})};
 const model=p(f,T.model),expand=p(f,T.expand),flow=p(f,T.flow),twice=p(f,T.quantityTwice);
 const tankLeft=mix(310,130,expand),tankRight=490,tankCenter=(tankLeft+tankRight)/2,waterY=mix(731,538,p(f,T.fill));
 const family='"Noto Sans CJK SC","Microsoft YaHei",sans-serif';const sampleXs=[348,404,460];
 return <AbsoluteFill style={{backgroundColor:c.background}}><svg width="100%" height="100%" viewBox="0 0 768 1344" style={{fontFamily:family,overflow:'hidden'}}>
 {/* 局部0帧精确承接A1末态，随后才开始本件的解释动作。 */}
 <rect x="77" y="322" width="624" height="684" rx="28" fill={c.ink} opacity={0.06*(1-model*0.65)}/>
 <rect x="72" y="312" width="624" height="684" rx="28" fill={c.paper} stroke={c.ink} strokeWidth={mix(7,2,model)} strokeOpacity={mix(1,0.2,model)}/>
 <g><text x={mix(384,tankCenter,model)} y={mix(465,435,model)} textAnchor="middle" fontSize={mix(40,34,model)} fontWeight="800" fill={c.ink} opacity={1-twice}>{l.quantity}</text>
 <text x={tankCenter} y="435" textAnchor="middle" fontSize="36" fontWeight="800" fill={c.blue} opacity={twice}>{l.twiceQuantity}</text>
 <path d="M132 507 H636" stroke={c.line} strokeWidth="2" opacity={1-model}/></g>
 <g><text x={mix(384,270,model)} y={mix(645,812,model)} textAnchor="middle" fontSize={mix(40,32,model)} fontWeight="800" fill={c.ink} opacity={1-model}>{l.rate}</text>
 <text x="270" y="812" textAnchor="middle" fontSize="32" fontWeight="800" fill={c.ink} opacity={model}>{l.throughput}</text>
 <path d="M132 687 H636" stroke={c.line} strokeWidth="2" opacity={1-model}/></g>
 <g opacity={mix(1,0.46,model)}><text x={mix(384,557,model)} y={mix(825,355,model)} textAnchor="middle" fontSize={mix(40,22,model)} fontWeight="700" fill={c.orange}>{l.sharing}</text>
 <path d="M132 867 H636" stroke={c.line} strokeWidth="2" opacity={1-model}/></g>
 <g opacity={model}>
 <text x="110" y="355" fontSize="22" fill={c.muted}>{l.analogy}</text>
 {/* 水面和出口固定；只移动左壁，虚线保留原容量边界。 */}
 <rect x={tankLeft+7} y={waterY} width={tankRight-tankLeft-14} height={Math.max(0,731-waterY-7)} fill={c.water}/>
 <line x1={tankLeft+7} x2={tankRight-7} y1={waterY} y2={waterY} stroke={c.blue} strokeWidth="3" opacity={p(f,T.fill)}/>
 <path d={`M${tankLeft} 472 V731 H490 V676 M490 648 V472`} fill="none" stroke={c.ink} strokeWidth="6" strokeLinejoin="round" strokeLinecap="round"/>
 <line x1="310" x2="310" y1="480" y2="726" stroke={c.blue} strokeWidth="2" strokeDasharray="7 8" opacity={expand*0.56}/>
 <path d={`M${tankLeft} 754 H490 M${tankLeft} 746 V762 M490 746 V762`} fill="none" stroke={c.muted} strokeWidth="2" opacity={0.4+expand*0.2}/>
 <g opacity={flow}>
 <path d="M490 662 H590 V872 H486" fill="none" stroke={c.line} strokeWidth="36" strokeLinejoin="round" strokeLinecap="butt"/>
 <path d="M490 662 H590 V872 H486" fill="none" stroke={c.paper} strokeWidth="24" strokeLinejoin="round" strokeLinecap="butt"/>
 <path d="M490 662 H590 V872 H486" fill="none" stroke={c.blue} strokeWidth="12" strokeDasharray="14 18" strokeDashoffset={-(Math.min(f,T.settle)-T.flow[0])*3} strokeLinejoin="round" strokeLinecap="round"/></g>
 <g opacity={p(f,T.outlet)}><rect x="484" y="643" width="47" height="38" rx="4" fill="none" stroke={c.orange} strokeWidth="3"/>
 <path d="M550 620 L516 641" fill="none" stroke={c.orange} strokeWidth="2.5"/>
 <text x="568" y="610" textAnchor="middle" fontSize="25" fontWeight="700" fill={c.orange}>{l.sameOutlet}</text></g>
 {/* 两次采样共用位置、每滴8帧与完整24帧窗口。 */}
 <g opacity={p(f,[T.sampleBefore[0]-8,T.sampleBefore[0]])}>
 <text x="133" y="884" fontSize="28" fontWeight="700" fill={c.ink}>{f<T.sampleAfter[0]?l.second:l.sameSecond}</text>
 <line x1="325" x2="483" y1="910" y2="910" stroke={c.line} strokeWidth="2"/>
 {sampleXs.map((x,i)=>{const before=p(f,[T.sampleBefore[0]+i*8,T.sampleBefore[0]+(i+1)*8]);const after=p(f,[T.sampleAfter[0]+i*8,T.sampleAfter[0]+(i+1)*8]);const amount=f<T.sampleAfter[0]?before*(1-p(f,T.clearSample)):after;return <g key={`sample-${i}`}>
 <path d={dropPath(x,871)} fill="none" stroke={c.blue} strokeWidth="2" strokeDasharray="4 4" opacity={f>=T.sampleBefore[1]?0.6:0.18}/>
 <path d={dropPath(x,871)} fill={c.blue} opacity={amount} transform={`translate(0 ${(1-amount)*7})`}/></g>;})}
 </g></g>
 {/* 结论完整后稳定阅读；最后八帧不增加新内容。 */}
 <g fontSize="40" fontWeight="800">
 <text x="329" y="976" textAnchor="end" fill={c.ink} opacity={twice}>{l.conclusionLeft}</text>
 <text x="384" y="979" textAnchor="middle" fontSize="52" fill={c.orange} opacity={p(f,T.inequality)}>≠</text>
 <text x="438" y="976" textAnchor="start" fill={c.ink} opacity={p(f,T.conclusionRight)}>{l.conclusionRight}</text>
 </g></svg></AbsoluteFill>;
}
