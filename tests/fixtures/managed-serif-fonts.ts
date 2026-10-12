import { motionSubmissionSchema } from "../../packages/motion-work/src/schema.js";

/** 字体审阅子代理提供的独立样张；只用于平台候选验证，不作为正式视频创作输入。 */
export const serifFontFixture = motionSubmissionSchema.parse({
  name: "受管宋体600与900字样核查", width: 1920, height: 1280, fps: 30, durationInFrames: 2,
  fontBindings: { semi: "noto-serif-sc-semibold", black: "noto-serif-sc-black" },
  props: { titleA: "时代不同", titleB: "平台的观众变了", hero: "不能冷场", paper: "终极PK、抽奖" },
  creativeBrief: "平台字体目录补全的独立技术与轮廓字样。左右列分别使用平台注入的Noto Serif SC实际600与900字重，以相同字号、正常字宽展示时代不同、平台的观众变了、不能冷场；禁用字体合成，无描边、阴影与非等比变形。纸条分别展示24px与26px工作字号、184×36纸面，并以3倍等比字号展示26px字样细节。检验真实加载后的中文宋体横竖反差、尖角收笔、主干重量、最长纸条标点及拉丁字母，不等于正式项目窄高排印、侧转、手机合成、镜片阅读与整片审美通过。首帧与次帧相同，加载记录与字体源哈希由候选渲染结果核对。",
  source: `import React from 'react';
import {AbsoluteFill} from 'remotion';
export default function FontSpecimen(props) {
  const columns = [
    {slot:'semi', label:'Noto Serif SC · 600', x:64},
    {slot:'black', label:'Noto Serif SC · 900', x:976}
  ];
  return <AbsoluteFill style={{backgroundColor:'#111615'}}>
    {columns.map((column) => {
      const font = props.fonts[column.slot];
      const face = {fontFamily:font.family, fontWeight:font.weight, fontStyle:font.style, fontSynthesis:'none', letterSpacing:0, whiteSpace:'nowrap'};
      const text = {...face, color:'#EEEAE0', lineHeight:1.35};
      const label = {...text, position:'absolute', left:0, fontSize:24};
      return <div key={column.slot} style={{position:'absolute', left:column.x, top:0, width:880, height:1280}}>
        <div style={{...text, position:'absolute', left:0, top:48, fontSize:42}}>{column.label}</div>
        <div style={{...label, top:120}}>96px / 正常字宽 / 无描边</div>
        <div style={{...text, position:'absolute', left:0, top:160, fontSize:96}}>{props.titleA}</div>
        <div style={{...label, top:310}}>96px / 正常字宽</div>
        <div style={{...text, position:'absolute', left:0, top:350, fontSize:96}}>{props.titleB}</div>
        <div style={{...label, top:500}}>128px / 正常字宽</div>
        <div style={{...text, position:'absolute', left:0, top:540, fontSize:128}}>{props.hero}</div>
        <div style={{...label, top:735}}>最长纸条 / 184×36 / 24px 与 26px</div>
        {[24,26].map((size,index) => <div key={size} style={{...face, position:'absolute', left:index*240, top:790, width:184, height:36, borderRadius:5, backgroundColor:'#E8E8E1', color:'#151917', fontSize:size, lineHeight:'36px', textAlign:'center'}}>{props.paper}</div>)}
        <div style={{...label, top:865}}>26px 字样的 3 倍等比细节 / 不挤压字形</div>
        <div style={{...face, position:'absolute', left:0, top:915, width:552, height:108, borderRadius:15, backgroundColor:'#E8E8E1', color:'#151917', fontSize:78, lineHeight:'108px', textAlign:'center'}}>{props.paper}</div>
        <div style={{...label, top:1100}}>静态候选：字形检查，不代表正式作品验收</div>
      </div>;
    })}
  </AbsoluteFill>;
}`
});
