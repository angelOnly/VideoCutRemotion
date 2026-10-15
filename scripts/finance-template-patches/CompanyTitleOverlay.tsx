import type {DialogueScene} from './types';

// 公司名位于栏目固定标题下方；空值不生成占位层。
export const CompanyTitleOverlay: React.FC<{name?: string | null}> = ({name}) => {
  if(!name?.trim())return null;
  const count=Array.from(name).length;
  return <div data-company-title style={{position:'absolute',left:400,top:690,width:1120,maxHeight:260,
    color:'#fff',fontFamily:'Noto Sans CJK SC, sans-serif',fontSize:count>32?32:count>16?44:58,
    fontWeight:700,lineHeight:1.35,textAlign:'center',overflowWrap:'anywhere',whiteSpace:'pre-wrap',
    textShadow:'0 3px 12px #000',pointerEvents:'none'}}>{name}</div>;
};

// 句段使用镜内真实帧；停顿期间继续沿用模板原场景人物状态。
export function activeSpeaker(scene:DialogueScene,frame:number){
  return scene.utterances.find(u=>frame>=u.startFrame&&frame<u.endFrameExclusive)?.speaker??scene.speaker;
}
