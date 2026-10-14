import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { speechSchema, speechBatchSchema } from '../../../../packages/speech-services/src/doubao.js';
import { sentenceAuditSchema } from '../../../../packages/production-service/src/sentence-audio.js';
import { renderToolSchema, previewFramesSchema, renderRequestIdSchema } from '../../../render-worker/src/template-renderer.js';
export function registerProductionTools(server:McpServer,call:(name:string,input:unknown)=>Promise<any>,stage:'analysis'|'render'='render'){
  const register=(name:string,description:string,schema:Record<string,z.ZodTypeAny>)=>server.registerTool(name,{description,inputSchema:schema},async input=>{try{return {content:[{type:'text',text:JSON.stringify(await call(name,input))}]};}catch(e){return {isError:true,content:[{type:'text',text:JSON.stringify({error:String(e)})}]};}});
  register('read_production_task','读取绑定的真实任务、阶段和必要模板依据；完整输入沿本 Run 的 input.json 读取。',{});
  if(stage==='analysis')return;
  register('synthesize_speech','当前 Render 的豆包云端配音；先持久化后异步执行。同键同输入读原任务，unknown 不得重新收费请求。',speechSchema.omit({runId:true}).shape);
  register('synthesize_speech_batch','一次登记本 run 的整批句段，服务按视频轮流派发；同批次同输入返回原任务，不重复收费。',speechBatchSchema.omit({runId:true}).shape);
  register('read_speech_batch','默认返回配音批次计数、异常与完整音频清单引用；需要具体句段时可请求详情，未知结果不得重发。',{speechBatchRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),details:z.boolean().default(false)});
  register('retry_speech_validation','仅恢复已经取得音频的本地检查，不请求供应商重新生成。',{speechJobId:z.string().uuid()});
  register('verify_sentence_audio','固定核对当前确认正文、批次音频、字幕和 PCM 实测时长；不执行模板任意脚本，不代替听审。',sentenceAuditSchema.shape);
  register('read_speech_job','读取本 run 原配音任务、实测句段时长和受管音频。',{speechJobId:z.string().uuid()});
  register('render_template','按作业固定策略输出：新任务并行绘制全局分镜画面、连续音轨合成整片；动态预览绘制所选范围。返回任务ID，使用read_render_job有界等待。',renderToolSchema.omit({runId:true}).shape);
  register('read_render_job','读取原媒体作业摘要；waitMs 最多60000，携带 afterDigest 时仅在状态变化或超时返回。readyFiles/readyFrames 仅含已核验文件，详情沿 detailsRef 读取。',{renderRequestId:renderRequestIdSchema,waitMs:z.number().int().min(0).max(60000).default(0),afterDigest:z.string().optional(),details:z.boolean().default(false)});
  register('preview_template_frames','一次登记1～12个唯一全局帧，异步生成同一固定版本的原尺寸图片与概览；用read_render_job读取，原编号不重复生成。',previewFramesSchema.omit({runId:true}).shape);
  register('retry_render_slices','恢复明确失败的原媒体作业。新策略核验原快照与成功块后续做缺失块或合成；旧策略须可信整片。未知、取消作业不能重放。',{renderRequestId:renderRequestIdSchema});
}
