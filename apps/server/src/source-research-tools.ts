import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";
import type { EditingApplication } from "@videocut/application";
import { DomainError } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import { z } from "zod";
import { sourceMaterialSchema } from "../../../packages/asset-acquisition/src/source-research.js";

export async function researchViaRuntime(projectId: string, action: string, input: unknown, config = readRuntimeConfig()) {
  const response = await fetch(new URL(`/api/projects/${encodeURIComponent(projectId)}/research/${action}`, config.http.webOrigin), { method: "POST", headers: { "content-type": "application/json", "x-videoflowcut-release-id": config.runtime.releaseId }, body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(45000) });
  if (response.headers.get("x-videoflowcut-release-id") !== config.runtime.releaseId) throw new DomainError("研究入口 Runtime 与 MCP 版本不一致", "RUNTIME_RELEASE_MISMATCH");
  const value = await response.json();
  if (!response.ok) throw new DomainError(value.message ?? "来源操作失败", value.error ?? "SOURCE_RESEARCH_FAILED");
  return value;
}
export function registerSourceResearchTools(server: McpServer, projectIdFrom: (id?: string) => string) {
  const handler = (action: string) => async ({ project_id, input }: { project_id?: string; input: unknown }) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await researchViaRuntime(projectIdFrom(project_id), action, input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: error instanceof DomainError ? error.code : "SOURCE_RESEARCH_FAILED", message: error instanceof Error ? error.message : "来源操作失败" }) }] }; }
  };
  server.registerTool("acquire_source_material", { title: "取得选定来源材料", description: "异步取得公开页面、直接图片或 PDF。web_snapshot 固定1440像素视口，不传 pages/pageWidth；这两个参数仅用于 PDF，选定页登记独立 PNG。网页子资源失败允许保存截图，Job.result.capture 返回 complete、warnings 与 reviewStatus=pending，必须核对正文后再用作证据；主页面、验证码、安全及预算失败仍拒绝。返回 Job，不创建场景或证据采用。", inputSchema: { project_id: z.string().optional(), input: sourceMaterialSchema } }, handler("acquire"));
}
export function registerSourceResearchRoutes(server: FastifyInstance, app: EditingApplication) {
  const projectId = (params: unknown) => z.object({ projectId: z.string() }).parse(params).projectId;
  const releaseId = readRuntimeConfig().runtime.releaseId;
  const options = { preHandler: async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    reply.header("x-videoflowcut-release-id", releaseId);
    if (request.headers["x-videoflowcut-release-id"] !== releaseId) throw new DomainError("来源入口 Runtime 与请求版本不一致", "RUNTIME_RELEASE_MISMATCH");
  } };
  server.post("/api/projects/:projectId/research/acquire", options, request => app.submitSourceMaterial(projectId(request.params), sourceMaterialSchema.parse(request.body)));
}
