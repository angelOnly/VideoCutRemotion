// 统一词表同时供文档校验、检索和预览使用；自由描述仍保留在机制正文。
export const taxonomy = {
  categories: [
    ['建立与累积','逐项出现、填充、数量增长','建立,累积,填充,铺满,陆续出现,增加'],
    ['排列与重组','同一集合换位、归队或重新排布','排列,重组,归队,排齐,重排'],
    ['聚焦与展开','集合突出一项、局部放大、内部展开','聚焦,突出,挑出,选中,展开,放大细节'],
    ['覆盖与揭示','遮挡、开口、内层显露','覆盖,揭示,露出,揭开,遮挡,开口'],
    ['替换与接管','新旧交替、保持参照换层','替换,接管,切换,交接,换场,过渡'],
    ['形变与分合','轮廓改变、分裂、合并','形变,变形,分裂,合并,伸缩,融入'],
    ['路径与连接','沿线运行、连接建立、持续引导','路径,连接,连线,描画,引导,沿线'],
    ['触发与反馈','接触后反应、由接点传播','触发,反馈,碰撞,接触,波动,扩散'],
    ['环绕与往复','环绕、循环、摆动、反复经过','环绕,循环,往复,摆动,转动,流动'],
    ['回收与退出','收拢、归位、缩回、退场','回收,退出,收拢,归位,缩回,退场']
  ],
  actions: [
    ['位移','移动,滑入,滑出,平移,横移,上移,下移,退让'],
    ['缩放','放大,缩小,推近,拉远,变大,变小'],
    ['旋转','转正,转动,倾转,翻转,侧转'],
    ['错开','错开,依次,逐项,陆续,分批,交错'],
    ['显隐','淡入,淡出,减淡,消隐,出现,消失'],
    ['描画','划线,画线,连线,描边,延伸'],
    ['填充','填充,铺满,填满,累积,增长'],
    ['遮挡','遮住,遮挡,覆盖,盖住,掠过'],
    ['开合','打开,合拢,开口,揭开,展开,折叠'],
    ['形变','形变,拉伸,挤压,变形,弯曲'],
    ['分合','分离,分裂,合并,组合,散开,收拢'],
    ['回弹','回调,回弹,过冲,回摆,落稳'],
    ['环绕','环绕,绕行,轨道,公转'],
    ['替换','替换,接管,换入,匹配,交替'],
    ['穿行','穿过,穿入,经过,越过,穿行'],
    ['起伏','起伏,摆动,波动,弹动,抖动'],
    ['传播','传播,扩散,连锁,逐层'],
    ['取景变化','镜头,取景,推近,拉远,跟随,俯视']
  ],
  states: ['空区域','单项','集合','网格','外框','文字组','轮廓','路径','开口','内层','前景','平面','并置','散置','堆叠','展开','覆盖'].map(x=>[x,x]),
  holds: ['外框保持','底层保持','主体保持','集合保持','参照保持','结果保持','内部连续'].map(x=>[x,x]),
  anchors: ['位置接点','轮廓接点','方向接点','对象延续','路径接点','开口接点','接触点'].map(x=>[x,x])
};
export const retrievalFields = ['categories','actions','entry','exit','holds','anchors'];
export function termsFor(field) { return taxonomy[field === 'entry' || field === 'exit' ? 'states' : field].map(x=>x[0]); }
export function validateRetrieval(value, id='机制') {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`${id} 缺少检索分类`);
  if(Object.keys(value).some(k=>!retrievalFields.includes(k))) throw new Error(`${id} 检索分类存在未知字段`);
  for(const field of retrievalFields){
    const values=value[field],allowed=termsFor(field);
    if(!Array.isArray(values) || values.some(v=>!allowed.includes(v)) || new Set(values).size!==values.length) throw new Error(`${id} 的 ${field} 不属于统一词表或重复`);
    if(['categories','actions'].includes(field)&&!values.length) throw new Error(`${id} 的 ${field} 不能为空`);
  }
  return value;
}
