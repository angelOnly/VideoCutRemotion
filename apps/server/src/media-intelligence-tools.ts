import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";
import type { EditingApplication } from "@videocut/application";
import { z } from "zod";
import { analysisInputSchema, factSchema, regionSchema, searchQuerySchema, timeRangeSchema } from "../../../packages/media-intelligence/src/index.js";
import { projectMotionJob } from "./motion-library-output.js";

const inspectSchema = z.object({ assetId: z.string().min(1).optional(), candidateId: z.string().min(1).optional(), exportArtifactId: z.string().min(1).optional(), previewJobId: z.string().min(1).optional(), range: timeRangeSchema.optional(), region: regionSchema.optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(40) }).strict();
const correctionSchema = z.object({ observationId: z.string().min(1), facts: z.array(factSchema).max(100), unknowns: z.array(z.string().max(1000)).max(100), reason: z.string().trim().min(8).max(3000), author: z.string().trim().min(1).max(120), baseRevision: z.number().int().positive().optional() }).strict();


export function registerMediaIntelligenceTools(server: McpServer, app: EditingApplication, projectIdFrom: (value?: string) => string) {
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const failure = (error: unknown) => ({ ...result({ error: error instanceof Error ? error.message : String(error), code: error && typeof error === "object" && "code" in error ? error.code : undefined }), isError: true });
  server.registerTool("analyze_media", { title: "分析素材声画", description: "对素材、候选、不可变 exportArtifactId 或成功 previewJobId 提交异步多模态分析。review 时 context 是实际发给模型的专项问题；index/discovery 的 context 仅作用途备注，初看保持盲观察。导出/预览只允许 review，range 以该文件起点为零的毫秒计，返回 composition 映射到对应 Revision 和时间线。不重新导入素材、不修改视频 Revision。保存实际指令、源哈希、模型版本、覆盖和未知；模型复核有效但不冒充人工或原生听觉，抽样不能证明精确同步。通过 track_job 和 read_media_observations 读取结果。", inputSchema: { project_id: z.string().optional(), input: analysisInputSchema } }, async ({ project_id, input }) => {
    try { return result(await app.intelligence.submitAnalysis(projectIdFrom(project_id), input)); } catch (error) { return failure(error); }
  });
  server.registerTool("read_media_observations", { title: "读取素材观察与覆盖", description: "分页读取源身份、事实、未知项、分析覆盖和错误；未分析不能当成不存在。", inputSchema: { project_id: z.string().optional(), input: inspectSchema }, annotations: { readOnlyHint: true } }, async ({ project_id, input }) => {
    try { return result(app.intelligence.inspect(projectIdFrom(project_id), input, input.offset, input.limit)); } catch (error) { return failure(error); }
  });
  server.registerTool("search_media_fragments", { title: "检索素材片段", description: "按视觉、声音、语言或原文分开检索，返回源范围及满足/违反/未知条件。hybrid 经共享 Job 调用 Qwen，lexical 只查询已有事实；两者均不自动采用素材。", inputSchema: { project_id: z.string().optional(), query: searchQuerySchema, mode: z.enum(["hybrid", "lexical"]).default("hybrid") } }, async ({ project_id, query, mode }) => {
    try { const id = projectIdFrom(project_id); return result(mode === "hybrid" ? app.intelligence.submitSearch(id, query) : app.intelligence.search(id, query)); } catch (error) { return failure(error); }
  });
  server.registerTool("correct_media_observation", { title: "纠正实际素材观察", description: "基于真实复核修订观察，保留模型原文和旧版本。仅更新分析索引，不修改视频 Revision 或素材使用；索引不会继续使用旧观察。", inputSchema: { project_id: z.string().optional(), input: correctionSchema } }, async ({ project_id, input }) => {
    try { return result(app.intelligence.correct(projectIdFrom(project_id), input)); } catch (error) { return failure(error); }
  });
  server.registerTool("retry_media_job", { title: "恢复素材分析任务", description: "恢复明确失败或已取消的素材分析、检索或选音任务，保留外部运行检查点；已知 run ID 继续读取，未知提交不重放。", inputSchema: { project_id: z.string().optional(), job_id: z.string().min(1) } }, async ({ project_id, job_id }) => {
    try { return result(projectMotionJob(app.intelligence.retry(projectIdFrom(project_id), job_id))); } catch (error) { return failure(error); }
  });
}

export function registerMediaIntelligenceRoutes(server: FastifyInstance, app: EditingApplication) {
  const projectId = (params: unknown) => z.object({ projectId: z.string().min(1) }).parse(params).projectId;
  server.post("/api/projects/:projectId/media-analysis", async (request, reply) => reply.code(202).send(await app.intelligence.submitAnalysis(projectId(request.params), analysisInputSchema.parse(request.body))));
  server.post("/api/projects/:projectId/media-observations/read", async (request) => {
    const input = inspectSchema.parse(request.body ?? {});
    return app.intelligence.inspect(projectId(request.params), input, input.offset, input.limit);
  });
  server.post("/api/projects/:projectId/media-fragments/search", async (request, reply) => {
    const input = z.object({ query: searchQuerySchema, mode: z.enum(["hybrid", "lexical"]).default("hybrid") }).strict().parse(request.body);
    return input.mode === "hybrid" ? reply.code(202).send(app.intelligence.submitSearch(projectId(request.params), input.query)) : app.intelligence.search(projectId(request.params), input.query);
  });
  server.post("/api/projects/:projectId/media-observations/correct", async (request) => app.intelligence.correct(projectId(request.params), correctionSchema.parse(request.body)));
}
