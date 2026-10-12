import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { createApplication } from "@videocut/application";
import { AssetProviderError, type AssetProviderRegistry } from "@videocut/acquisition";
import { DomainError } from "@videocut/domain";
import { assetRequestVersion } from "../../../packages/media-intelligence/src/index.js";
import { decodeSearchCursor } from "../../../packages/asset-acquisition/src/cursor.js";
import { assetSearchErrorResult } from "./asset-search-errors.js";

/** 生产入口与协议测试共用注册函数，Provider 可在隔离测试中受控返回。 */
export function registerMediaSearchTool(server: McpServer, application: ReturnType<typeof createApplication>, assetProviders: AssetProviderRegistry, projectIdFrom: (id?: string) => string) {
  const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
server.registerTool("search_media_candidates", {
  title: "搜索素材候选",
  description: "先从 list_asset_providers 选择准确 provider id。media_type 仅选择本轮图片/视频/音频入口；旧会话与迟到结果保留原查询输入，改稿不使候选失效；youtube 的 query 是选中的单条 HTTPS 视频页面；pexels 无 API Key 时也只接受选定的单视频页 URL，关键词需要 Key。返回 diagnostics.complete 和 warnings，部分结果不能视为完整搜索。仅保存独立搜索会话，不改变创作 Revision，不下载或自动采用素材。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive().optional().describe("兼容上下文；搜索不要求全局 Revision 一致"),
    asset_request_id: z.string().min(1),
    provider: z.string().trim().min(1).max(80).describe("使用 list_asset_providers 返回的 id，例如 wikimedia-commons"),
    media_type: z.enum(["image", "video", "audio"]).optional(),
    cursor: z.string().min(1).max(500).optional(),
    query: z.string().trim().min(1).max(400)
  }
}, async ({ project_id, base_revision_id, asset_request_id, provider, query, media_type, cursor }) => {
  let beforePersistence = true;
  try {
    const projectId = projectIdFrom(project_id);
    const state = application.readProject(projectId);
    // 在 Provider 请求前固定真实需求；兼容版本不充当搜索锁。
    const request = structuredClone(state.snapshot.assetRequests.find((entry) => entry.id === asset_request_id));
    if (!request) throw new DomainError(`素材需求不存在：${asset_request_id}`, "ASSET_REQUEST_NOT_FOUND");
    if (request.status === "closed") throw new DomainError("素材需求已关闭，不能发起新搜索", "ASSET_REQUEST_CLOSED");
    const source = assetProviders.get(provider);
    if (media_type && !assetProviders.catalog().find(entry => entry.id === provider)?.mediaTypes.includes(media_type)) throw new AssetProviderError("该素材服务不支持所选媒体类型，请查看服务目录", "ASSET_MEDIA_TYPE_UNSUPPORTED", { provider, stage: "provider", recovery: "change_media_type" });
    const input = { request: structuredClone(request), query, mediaType: media_type, cursor };
    decodeSearchCursor(provider, input);
    const result = source.searchDetailed ? await source.searchDetailed(input) : { candidates: await source.search(input), complete: true, warnings: [] };
    const candidates = result.candidates.filter(candidate => !media_type || (candidate.kind ?? "video") === media_type);
    beforePersistence = false;
    return asText(application.recordAssetSearch({ projectId, baseRevision: state.revision.number, assetRequestId: asset_request_id, provider, query, candidates, cursor, nextCursor: "nextCursor" in result ? result.nextCursor as string | undefined : undefined, mediaType: media_type, diagnostics: { complete: result.complete, warnings: result.warnings }, requestVersion: assetRequestVersion(request), requestSnapshot: request }));
  } catch (error) { return assetSearchErrorResult(error, beforePersistence); }
});

}
