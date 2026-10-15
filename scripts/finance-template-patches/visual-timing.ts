/** 省略止帧表示跟随所属镜头或章节；显式动作点保持原帧数，不按新时长缩放。 */
export function resolveVisualBlocks<T extends {endFrameExclusive?:number}>(blocks:T[], frames:number):Array<T & {endFrameExclusive:number}> {
  return blocks.map(block=>({...block,endFrameExclusive:block.endFrameExclusive===undefined?frames:block.endFrameExclusive}));
}
