type SceneTiming = {frames:number;chapter?:{frames:number};intro?:{fromFrame?:number;frames?:number}};
/** 片头、正文校验与实际播放使用同一个左闭右开区间。 */
export function introRange(scene:SceneTiming):[number,number]|undefined {
  if(!scene.intro)return;
  const start=scene.intro.fromFrame??0, frames=scene.intro.frames;
  if(!Number.isInteger(start)||start<0||!Number.isInteger(frames)||!frames||frames<1||start+frames>scene.frames)throw new Error('片头须有实测正整数帧数，并位于分镜内');
  if(scene.chapter&&start<scene.chapter.frames)throw new Error('片头与章节转场不能重叠');
  return [start,start+frames];
}
export function isIntroFrame(scene:SceneTiming,frame:number){const range=introRange(scene);return !!range&&frame>=range[0]&&frame<range[1];}
export function bodyRanges(scene:SceneTiming,until:number):[number,number][] {
  const intro=introRange(scene),start=scene.chapter?.frames??0,end=Math.min(until,scene.frames);
  if(end<=start)return [];
  if(!intro||intro[0]>=end)return [[start,end]];
  return [[start,Math.min(end,intro[0])],[Math.max(start,intro[1]),end]].filter(([a,b])=>b>a) as [number,number][];
}
