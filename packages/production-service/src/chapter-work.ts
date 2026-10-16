import type {RenderRequest} from './contracts.js';

/** 只按当前确认稿的连续章节分组，不从旧分析恢复已删除的内容。 */
export function chapterWorkPlan(scenes:RenderRequest['dataList']) {
  const units:{id:string;title:string;sceneIds:string[];sourceDirectory:string}[]=[];
  for(const scene of scenes){
    const title=scene.directing?.chapter?.trim();
    let unit=units.at(-1);
    if(!unit || (title && title!==unit.title)){
      const id=`chapter_${String(units.length+1).padStart(3,'0')}`;
      unit={id,title:title||'未标章节',sceneIds:[],sourceDirectory:`renderer/src/chapters/${id}`};
      units.push(unit);
    }
    unit.sceneIds.push(scene.id);
  }
  return {maxConcurrentAuthors:6,units};
}
