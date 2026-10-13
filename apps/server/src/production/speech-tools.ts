import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { speechSchema } from '../../../../packages/speech-services/src/doubao.js';
import { renderToolSchema } from '../../../render-worker/src/template-renderer.js';
export function registerProductionTools(server:McpServer,call:(name:string,input:unknown)=>Promise<any>){
  const register=(name:string,description:string,schema:Record<string,z.ZodTypeAny>)=>server.registerTool(name,{description,inputSchema:schema},async input=>{try{return {content:[{type:'text',text:JSON.stringify(await call(name,input))}]};}catch(e){return {isError:true,content:[{type:'text',text:JSON.stringify({error:String(e)})}]};}});
  register('synthesize_speech','当前 Render 的豆包云端配音；先持久化后异步执行。同键同输入读原任务，unknown 不得重新收费请求。',speechSchema.omit({runId:true}).shape);
  register('read_speech_job','读取本 run 原配音任务、实测句段时长和受管音频。',{speechJobId:z.string().uuid()});
  register('render_template','按模板整片 Composition 的全局帧范围渲染；返回任务 ID，使用 read_render_job 查询，不重复提交。',renderToolSchema.omit({runId:true}).shape);
  register('read_render_job','查询原模板渲染任务和交付文件。',{renderRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)});
  register('preview_template_frame','渲染本 run 模板实际帧，返回图片文件；之后用图像查看工具观察。',{frame:z.number().int().nonnegative()});
  register('read_production_task','读取绑定的真实任务、输入、阶段和检查点。',{});
}
