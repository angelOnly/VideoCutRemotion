import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";
import { z } from "zod";
import { searchLibrary, readLibraryMechanism } from "../../../references/motion-cases/skillry/tools/library-store.mjs";
import { termsFor } from "../../../references/motion-cases/skillry/taxonomy.mjs";
import type { EditingApplication } from "@videocut/application";
import { readRuntimeConfig } from "@videocut/project-overview";
import { DomainError } from "@videocut/domain";
import { digest, timeRangeSchema } from "../../../packages/media-intelligence/src/index.js";
import { MOTION_TEXT_VERSION, MOTION_INSTRUCTION_VERSION } from "../../../packages/media-intelligence/src/motion-library.js";
import { motionJobRecovery, projectMotionJob, projectMotionMechanismResult, projectMotionSearchResult } from "./motion-library-output.js";

const id = z.string().regex(/^\d{3}-m\d{2}$/u);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const choices = (field: string) => z.array(z.enum(termsFor(field) as [string, ...string[]])).max(20).optional();
const failure = (error: unknown, sideEffects: "none" | "unknown" = "none") => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({code:error instanceof DomainError?error.code:"MOTION_LIBRARY_UNAVAILABLE",message:error instanceof Error?error.message:"参考资料读取失败",sideEffects}) }] });

function latestAttempt(app: EditingApplication, projectId: string, submitted: ReturnType<EditingApplication["trackJob"]>) {
  let job = submitted;
  const jobs = app.listJobs(projectId);
  for (let i=0;i<100;i++) { const next=jobs.find(entry=>entry.payload.retryOfJobId===job.id); if(!next)break; job=next; }
  return job;
}

export function registerMotionLibraryTools(server: McpServer, root = resolve(process.cwd(), "references/motion-cases/skillry"), app?: EditingApplication, projectIdFrom?: (id?: string) => string) {
  // 启动器将 cwd 固定到源码仓库；只接收编号，调用方不能指定磁盘路径。
  server.registerTool("search_motion_mechanisms", {
    title:"查找运动机制",
    description:"用于本场动画制作：在主要源码之前，依据实际材料与演出目标只读检索120库运动机制；普通研究、写稿、取材与初步分镜不主动调用。按自然语言、当前状态/保持条件、相似机制或前后接续召回，stages 分阶段查找。selection 恢复网页清单的顺序与采用项。互斥方式：stages/similar_to/before/after/ids/selection。全文词法与任务级向量经现有 Job 混合召回，首次查询返回词法结果与语义 Job，track_job 完成后以相同输入读回；失败如实降级，不自动重放。返回词表、来源指纹、比较页和原文入口；入围后读取指令与分镜再适配对象和连接，命中不证明连贯或观感。",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true},
    inputSchema:{project_id:z.string().optional(),query:z.string().max(1000).optional(),stages:z.array(z.string().min(1).max(1000)).min(1).max(8).optional(),
      categories:choices('categories'),actions:choices('actions'),entry:choices('entry'),exit:choices('exit'),holds:choices('holds'),exclude_actions:choices('actions'),
      similar_to:id.optional(),before:id.optional(),after:id.optional(),ids:z.array(id).min(1).max(40).optional(),
      selection:z.string().max(16000).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(50).optional(),source_sha256:fingerprint.optional()}
  }, async ({project_id,...request}) => {
    let sideEffects: "none" | "unknown" = "none";
    try {
      const lexical=searchLibrary(root,request);
      let result:Record<string,unknown>={...lexical,diagnostics:{mode:"lexical",semantic_used:false,reason:"精确定位或无文本需求"}};
      if(!request.ids&&!request.selection&&(request.query?.trim()||request.stages||request.similar_to||request.before||request.after)) {
        if(!app||!projectIdFrom) result.diagnostics={mode:"lexical",semantic_used:false,reason:"当前入口未连接语义任务服务"};
        else {
          let projectId: string;
          try { projectId=projectIdFrom(project_id); }
          catch(error) {
            if(project_id || !(error instanceof DomainError) || error.code!=="PROJECT_NOT_TARGETED") throw error;
            return {content:[{type:"text" as const,text:JSON.stringify(projectMotionSearchResult({...lexical,diagnostics:{mode:"lexical",semantic_used:false,reason:"未指定项目，返回全文词法结果；指定 project_id 后可使用现有语义 Job"}}))}]};
          }
          const config=readRuntimeConfig();
          const payload={request,source_sha256:lexical.source_sha256,modelConfig:{...config.semantic,apiBaseUrl:config.bridge.apiBaseUrl},textVersion:MOTION_TEXT_VERSION,instructionVersion:MOTION_INSTRUCTION_VERSION};
          sideEffects="unknown";
          const submitted=app.repository.createJob({projectId,kind:"motion_library_search",payload,idempotencyKey:`motion-library:${digest(payload)}`});
          // 显式恢复后沿同一请求返回最新尝试，不自动重放失败或未知提交。
          const job=latestAttempt(app,projectId,submitted);
          if(job.status==="succeeded"&&job.result) result={...job.result,diagnostics:{...(job.result.diagnostics as Record<string,unknown>),job_id:job.id,status:job.status}};
          else result={...lexical,diagnostics:{mode:"lexical",semantic_used:false,source_sha256:lexical.source_sha256,job_id:job.id,status:job.status,reason:job.error??"语义索引或查询正在准备；可使用全文词法结果，track_job 后以相同输入读回",failure:job.result?.diagnostic,recovery:motionJobRecovery(job)}};
        }
      }
      return {content:[{type:"text" as const,text:JSON.stringify(projectMotionSearchResult(result))}]};
    }catch(error){return failure(error,sideEffects);}
  });
  server.registerTool("read_motion_mechanism", {
    title:"读取运动指令和分镜",
    description:"动画制作选型后、主要源码编写前，核读入围机制的完整 Markdown 与 JPEG 分镜，供当前作者适配真实对象和连接；局部修订可沿用未变资料。必要时 part=overview 读取原片总览与64宫格。传查询的 source_sha256 拒绝过期采用。资料是运动描述，不是现成源码；不会播放、生成或修改视频。",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:{id,part:z.enum(['mechanism','overview']).optional(),source_sha256:fingerprint.optional(),include_storyboard:z.boolean().optional()}
  }, async (request) => {
    try {
      const loaded=readLibraryMechanism(root,request);
      const content: Array<{type:"text";text:string}|{type:"image";data:string;mimeType:string}>=[{type:"text",text:JSON.stringify(projectMotionMechanismResult(loaded.result))}];
      if(loaded.image)content.push({type:"image",data:loaded.image,mimeType:"image/jpeg"});
      return {content};
    } catch(error) {return failure(error);}
  });
  if(app&&projectIdFrom) server.registerTool("analyze_motion_reference", {
    title:"读取原片运动范围",
    description:"仅在速度、交叠或观察位置影响机制选择时，按库编号和原片毫秒范围提交异步理解，最多15秒。track_job 读取真实描述、来源与采样边界；不修改机制原文或项目 Revision，不创建素材审核。失败任务沿 retry_media_job 显式恢复。",
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true},
    inputSchema:{project_id:z.string().optional(),id,source_sha256:fingerprint,range:timeRangeSchema}
  },async({project_id,...request})=>{
    let sideEffects: "none" | "unknown" = "none";
    try{
      if(request.range.endMs-request.range.startMs>15000)throw new Error("原片范围不能超过15秒");
      readLibraryMechanism(root,{id:request.id,source_sha256:request.source_sha256,include_storyboard:false});
      const config=readRuntimeConfig(),payload={...request,modelConfig:{...config.semantic,apiBaseUrl:config.bridge.apiBaseUrl}};
      const projectId=projectIdFrom(project_id);
      sideEffects="unknown";
      const submitted=app.repository.createJob({projectId,kind:"motion_reference_analysis",payload,idempotencyKey:`motion-reference:${digest(payload)}`});
      const job=latestAttempt(app,projectId,submitted);
      return {content:[{type:"text" as const,text:JSON.stringify(projectMotionJob(job))}]};
    }catch(error){return failure(error,sideEffects);}
  });
}
