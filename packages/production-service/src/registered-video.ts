import { ProductionError, type Delivery } from './contracts.js';
import { validateVideoOutput, validateSceneFastCut } from './video-output.js';
import { sceneCutMetadata } from './fast-cut-validation.js';
import type { MetricContext } from './media-metrics.js';

/** 发布和续切都重算切点证据，不相信交付 JSON 自报的“已核验”。 */
export async function validateRegisteredVideo(file:Delivery['files'][number],whole:Delivery['files'][number],signal?:AbortSignal,metrics?:MetricContext){
  const cut=file.cutMetadata;
  if(file.id==='whole-video'&&cut)throw new ProductionError('MEDIA_CHECK_FAILED','整片不能使用分镜快速校验');
  const media=cut&&cut.cutMode!=='accurate'
    ?await validateSceneFastCut(file.file,whole.file,file,signal,cut.cutMode,metrics)
    :await validateVideoOutput(file.file,file,signal,metrics);
  if(Math.abs(media.duration-file.dur)>(cut?0.001:0.1))throw new ProductionError('MEDIA_CHECK_FAILED','媒体登记时长不符');
  if(cut){
    const measured=sceneCutMetadata(media,file,cut.cutMode,cut.fallbackReason);
    for(const key of Object.keys(measured) as (keyof typeof measured)[]){
      if(measured[key]!==cut[key])throw new ProductionError('CUT_METADATA_MISMATCH',`切片实测记录不符：${key}`);
    }
  }
  return media;
}
