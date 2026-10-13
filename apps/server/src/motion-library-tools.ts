import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { searchLibrary, readLibraryMechanism } from '../../../references/motion-cases/skillry/tools/library-store.mjs';
import { termsFor } from '../../../references/motion-cases/skillry/taxonomy.mjs';
import { projectMotionSearchResult, projectMotionMechanismResult } from './motion-library-output.js';
const id=z.string().regex(/^\d{3}-m\d{2}$/),fingerprint=z.string().regex(/^[a-f0-9]{64}$/);
const choices=(field:string)=>z.array(z.enum(termsFor(field) as [string,...string[]])).max(20).optional();
export function registerMotionLibraryTools(server:McpServer,root=resolve(process.cwd(),'references/motion-cases/skillry'),..._removedProjectArguments:unknown[]){
  const failure=(e:unknown)=>({isError:true,content:[{type:'text' as const,text:JSON.stringify({code:'MOTION_LIBRARY_UNAVAILABLE',message:String(e),sideEffects:'none'})}]});
  server.registerTool('search_motion_mechanisms',{description:'按实际内容和演出关系查询本地机制词法库；返回实际查询、命中与限制，无向量、模型或网络回退。',inputSchema:{query:z.string().max(1000).optional(),stages:z.array(z.string().min(1).max(1000)).min(1).max(8).optional(),categories:choices('categories'),actions:choices('actions'),entry:choices('entry'),exit:choices('exit'),holds:choices('holds'),exclude_actions:choices('actions'),similar_to:id.optional(),before:id.optional(),after:id.optional(),ids:z.array(id).min(1).max(40).optional(),selection:z.string().max(16000).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(50).optional(),source_sha256:fingerprint.optional()}},async request=>{try{const result=searchLibrary(root,request);return {content:[{type:'text',text:JSON.stringify({...projectMotionSearchResult(result),query:request,diagnostics:{mode:'lexical',semantic_used:false,reason:'仅词法检索；无结果时调整词语或筛选'}})}]};}catch(e){return failure(e);}});
  server.registerTool('read_motion_mechanism',{description:'读取本地机制原文及静态分镜，静态图片不代表连续审片。',inputSchema:{id,part:z.enum(['mechanism','overview']).optional(),source_sha256:fingerprint.optional(),include_storyboard:z.boolean().optional()}},async request=>{try{const loaded=readLibraryMechanism(root,request);const content:any[]=[{type:'text',text:JSON.stringify(projectMotionMechanismResult({...loaded.result,preview_url:undefined,video_path:undefined}))}];if(loaded.image)content.push({type:'image',data:loaded.image,mimeType:'image/jpeg'});return {content};}catch(e){return failure(e);}});
}
