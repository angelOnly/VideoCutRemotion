import React from 'react';
/** 用于继承了描边的 SVG 图解，文字本身明确取消描边。 */
export const DiagramText:React.FC<React.SVGProps<SVGTextElement>>=props=><text {...props} stroke="none" style={{...props.style,stroke:'none'}}/>;
/** 数值以右边缘为基准增长，作者仍需预留最长数值与单位的空间。 */
export const RightAlignedValue:React.FC<{value:string;unit?:string;width:number}>=({value,unit,width})=><div style={{width,textAlign:'right',whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}><span>{value}</span>{unit?<span style={{marginLeft:8}}>{unit}</span>:null}</div>;
