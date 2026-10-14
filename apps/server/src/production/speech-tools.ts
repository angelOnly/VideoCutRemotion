import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { speechSchema, speechBatchSchema } from '../../../../packages/speech-services/src/doubao.js';
import { sentenceAuditSchema } from '../../../../packages/production-service/src/sentence-audio.js';
import { renderToolSchema, previewFramesSchema, renderRequestIdSchema } from '../../../render-worker/src/template-renderer.js';
export function registerProductionTools(server:McpServer,call:(name:string,input:unknown)=>Promise<any>){
  const register=(name:string,description:string,schema:Record<string,z.ZodTypeAny>)=>server.registerTool(name,{description,inputSchema:schema},async input=>{try{return {content:[{type:'text',text:JSON.stringify(await call(name,input))}]};}catch(e){return {isError:true,content:[{type:'text',text:JSON.stringify({error:String(e)})}]};}});
  register('synthesize_speech','当前 Render 的豆包云端配音；先持久化后异步执行。同键同输入读原任务，unknown 不得重新收费请求。',speechSchema.omit({runId:true}).shape);
  register('synthesize_speech_batch','一次登记本 run 的整批句段，服务按视频轮流派发；同批次同输入返回原任务，不重复收费。',speechBatchSchema.omit({runId:true}).shape);
  register('read_speech_batch','读取本 run 配音批次及按原句段编号排列的结果；未知结果不得重发。',{speechBatchRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)});
  register('retry_speech_validation','仅恢复已经取得音频的本地检查，不请求供应商重新生成。',{speechJobId:z.string().uuid()});
  register('verify_sentence_audio','固定核对当前确认正文、批次音频、字幕和 PCM 实测时长；不执行模板任意脚本，不代替听审。',sentenceAuditSchema.shape);
  register('read_speech_job','读取本 run 原配音任务、实测句段时长和受管音频。',{speechJobId:z.string().uuid()});
  register('render_template','正式导出只绘制一次整片，再按全局帧区间生成分镜；局部动态预览直接绘制所选范围。返回任务ID，使用read_render_job查询。',renderToolSchema.omit({runId:true}).shape);
  register('read_render_job','查询原媒体作业。视频看readyFiles，静帧看readyFrames与sourceDigest；仅已核验文件可审查。图片与局部动态预览不能作为正式交付。',{renderRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)});
  register('preview_template_frames','一次登记1～12个唯一全局帧，异步生成同一固定版本的原尺寸图片与概览；用read_render_job读取，原编号不重复生成。',previewFramesSchema.omit({runId:true}).shape);
  register('retry_render_slices','仅在本Run活动期间，续做明确失败的原正式作业中未完成分镜；须原整片和快照可信。未知、取消及局部预览不可续切。',{renderRequestId:renderRequestIdSchema});
  register('read_production_task','读取绑定的真实任务、输入、阶段和检查点。',{});
}
