import React from 'react';
/** 用于继承了描边的 SVG 图解，文字本身明确取消描边。 */
export const DiagramText:React.FC<React.SVGProps<SVGTextElement>>=props=><text {...props} stroke="none" style={{...props.style,stroke:'none'}}/>;
/** 数值以右边缘为基准增长，作者仍需预留最长数值与单位的空间。 */
export const RightAlignedValue:React.FC<{value:string;unit?:string;width:number}>=({value,unit,width})=><div data-fit data-layout-object="right-aligned-value" style={{width,textAlign:'right',whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}><span>{value}</span>{unit?<span style={{marginLeft:8}}>{unit}</span>:null}</div>;

/** 半开区间统一卸载旧状态；传入所属场面的时钟，不重新启动全局时间。 */
export function isVisualFrame(frame:number,fromFrame:number,toFrame:number){
  if(!Number.isInteger(fromFrame)||!Number.isInteger(toFrame)||fromFrame<0||toFrame<=fromFrame)throw new Error('画面状态须声明有效半开帧范围');
  return frame>=fromFrame&&frame<toFrame;
}
export const VisualState:React.FC<{frame:number;fromFrame:number;toFrame:number;children:(localFrame:number)=>React.ReactNode}>=({frame,fromFrame,toFrame,children})=>
  isVisualFrame(frame,fromFrame,toFrame)?<>{children(frame-fromFrame)}</>:null;

/** 稳定标题区复用模板原排版；超出区域由现有 LayoutGuard 报实际尺寸，不缩字或截断。 */
export const PanelTitle:React.FC<{title:string;label:string}>=({title,label})=><div style={{position:'absolute',top:25,left:42,right:42}}>
  <div style={{color:'#ef5258',fontSize:16,letterSpacing:3,fontWeight:800}}>{label}</div>
  <div data-fit data-layout-object="panel-title" style={{marginTop:9,color:'#f1f6fb',fontSize:37,fontWeight:800,lineHeight:1.15,maxHeight:96,overflowWrap:'anywhere'}}>{title}</div>
</div>;

/** 数值卡继承稳定区域及字号；作者决定强调内容和布局，浏览器负责实际文字尺寸。 */
export const MetricCard:React.FC<{label:string;value:string;detail:string;style:React.CSSProperties}>=({label,value,detail,style})=><div style={{...style,width:'100%',textAlign:'center'}}>
  <div data-fit data-layout-object="metric-label" style={{color:'#95a8bd',fontSize:19}}>{label}</div>
  <div data-fit data-layout-object="metric-value" style={{color:'#49c7df',fontSize:42,fontWeight:800,marginTop:9,fontVariantNumeric:'tabular-nums'}}>{value}</div>
  <div data-fit data-layout-object="metric-detail" style={{color:'#d5deea',fontSize:18,marginTop:8}}>{detail}</div>
</div>;
