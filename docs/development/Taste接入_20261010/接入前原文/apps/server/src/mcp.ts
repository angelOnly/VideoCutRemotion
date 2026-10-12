import { readJobDiagnostics } from "./job-diagnostics.js";
import { toolErrorResult } from "./tool-error.js";
import { captionPlacementSchema, captionDisplaySchema } from "../../../packages/contracts/src/caption-presentation.js";
import { projectFrameRateSchema } from "../../../packages/contracts/src/frame-rate.js";
import { explainerPlanWithContent } from "../../../packages/contracts/src/explainer-inputs.js";
import { sourceCaptionTextReviewSchema, } from "../../../packages/contracts/src/editorial-inputs.js";
import { registerSourceResearchTools } from "./source-research-tools.js";
import { registerSoundTools } from "./sound-tools.js";
import { audioDesignSchema, soundRequirementSchema } from "../../../packages/edit-application/src/sound-design.js";
import { assetRequestVersion } from "../../../packages/media-intelligence/src/index.js";
import { soundSourceCapabilities } from "@videocut/acquisition";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fontPreviewSchema } from "../../../packages/motion-work/src/font-preview.js";
import { listMotionFonts } from "../../../packages/motion-work/src/fonts.js";
import { decodeSearchCursor } from "../../../packages/asset-acquisition/src/cursor.js";
import { AssetProviderError, createDefaultAssetProviderRegistry } from "@videocut/acquisition";
import { assetSearchErrorResult } from "./asset-search-errors.js";
import { createApplication, PROJECT_DATABASE_TABLES } from "@videocut/application";
import { DomainError } from "@videocut/domain";
import { getProjectOverview, readRuntimeConfig } from "@videocut/project-overview";
import { evaluateQuality, evaluateQualityWithBrowser } from "@videocut/quality";
import { EFFECT_QUALITY_RULES, EFFECT_TYPES, type Asset, type AssetProvenance } from "@videocut/contracts";
import { inspectComposedFrames } from "./preview-inspection.js";
import { inspectAsset } from "./source-review.js";
import { registerMotionTools } from "./motion-tools.js";
import { registerMotionLibraryTools } from "./motion-library-tools.js";
import { registerMediaIntelligenceTools } from "./media-intelligence-tools.js";
import { sha256File } from "./media-hash.js";
import { extractSourceAudio } from "./extract-source-audio.js";
import { browseLocalSoundEffects, inspectLocalSoundEffect, resolveLocalSoundEffectForImport } from "./local-sound-effects.js";
import { SOUND_SOURCES, MIXKIT_SOUND_CATEGORIES } from "../../../packages/asset-acquisition/src/sound-catalog.js";

const runtimeConfig = readRuntimeConfig();
const workspaceRoot = runtimeConfig.workspace.root;
const webOrigin = runtimeConfig.http.webOrigin;
const application = createApplication(workspaceRoot);
const assetProviders = createDefaultAssetProviderRegistry();
let targetProjectId: string | undefined;

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const asError = toolErrorResult;
const projectIdFrom = (projectId?: string) => {
  const resolved = projectId ?? targetProjectId;
  if (!resolved) throw new DomainError("请先调用 target_project 或显式传入 project_id", "PROJECT_NOT_TARGETED");
  return resolved;
};

type RuntimeReleaseStatus = {
  status: "ready" | "stopping";
  runtimeId: string;
  releaseId: string;
  workers: { media: boolean; render: boolean };
};

/** Runtime 状态接口没有控制令牌；它只提供版本一致性所需的最小健康事实。 */
async function readRuntimeReleaseStatus(): Promise<RuntimeReleaseStatus> {
  const endpoint = new URL("/api/runtime/status", `${webOrigin.replace(/\/$/u, "")}/`).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) throw new DomainError(`Runtime 版本状态不可用（HTTP ${response.status}）`, "RUNTIME_RELEASE_UNAVAILABLE");
    const value = await response.json() as Partial<RuntimeReleaseStatus>;
    if ((value.status !== "ready" && value.status !== "stopping") || typeof value.runtimeId !== "string"
      || typeof value.releaseId !== "string" || typeof value.workers?.media !== "boolean"
      || typeof value.workers?.render !== "boolean") {
      throw new DomainError("Runtime 返回了无效的版本状态", "RUNTIME_RELEASE_STATUS_INVALID");
    }
    return value as RuntimeReleaseStatus;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(`无法连接 Runtime 版本状态：${error instanceof Error ? error.message : String(error)}`, "RUNTIME_RELEASE_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 真正改变工单部署状态前，MCP 与 Runtime 必须报告同一个发行摘要。
 * 这让旧会话即使还持有工具名，也不能为新版 Runtime 或候选版伪造“已部署”。
 */
async function requireAlignedRuntimeRelease(): Promise<RuntimeReleaseStatus> {
  const runtime = await readRuntimeReleaseStatus();
  const mcpReleaseId = runtimeConfig.runtime.releaseId;
  if (runtime.releaseId !== mcpReleaseId) {
    throw new DomainError("当前 MCP 与 Runtime 不是同一发行版本；请重新部署并重新连接 MCP", "RUNTIME_RELEASE_MISMATCH");
  }
  if (runtime.status !== "ready" || !runtime.workers.media || !runtime.workers.render) {
    throw new DomainError("当前 Runtime 未完成 API、媒体 Worker 与渲染 Worker 健康检查", "RUNTIME_NOT_READY");
  }
  return runtime;
}
const kindFromPath = (path: string) => {
  const extension = extname(path).toLowerCase();
  if ([".mp4", ".mov", ".webm", ".mkv"].includes(extension)) return "video" as const;
  if ([".mp3", ".wav", ".flac", ".m4a", ".aac"].includes(extension)) return "audio" as const;
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return "image" as const;
  if (extension === ".pdf") return "document" as const;
  throw new DomainError(`不支持的素材格式：${extension}`, "UNSUPPORTED_MEDIA");
};

const assetRoleSchema = z.enum(["a_roll", "b_roll", "vlog_source", "actor_mask", "voice_reference", "sfx", "bgm", "evidence", "cutaway", "style_reference", "generated_visual"]);
const assetProvenanceSchema = z.object({
  source: z.enum(["local_import", "generated", "provider"]),
  provider: z.string().max(240).optional(),
  source_url: z.string().url().max(2_000).optional(),
  original_asset_id: z.string().max(240).optional(),
  creator: z.string().max(240).optional(),
}).strict();
type McpAssetProvenance = z.infer<typeof assetProvenanceSchema>;

const actorAnchorSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  source: z.literal("manual_static")
}).strict();
const actorLayoutSchema = z.object({
  actor_head: actorAnchorSchema.optional(),
  actor_hands: actorAnchorSchema.optional()
}).strict().refine((layout) => Boolean(layout.actor_head || layout.actor_hands), {
  message: "人物布局至少需要一个头部或手部锚点"
});
const actorGenerationRangeSchema = z.object({
  start_frame: z.number().int().nonnegative(),
  end_frame: z.number().int().positive(),
  speech_segment_ids: z.array(z.string().min(1)).min(1).max(200)
}).strict().refine((range) => range.end_frame > range.start_frame, {
  message: "人物生成范围的结束帧必须大于开始帧"
});
const actorPlacementSchema = z.object({
  scene_id: z.string().min(1),
  start_frame: z.number().int().nonnegative(),
  end_frame: z.number().int().positive()
}).strict().refine((placement) => placement.end_frame > placement.start_frame, {
  message: "人物放置范围的结束帧必须大于开始帧"
});

const multicamMarkerSchema = z.object({
  asset_id: z.string().min(1),
  label: z.string().min(1).max(80),
  source_frame: z.number().int().nonnegative(),
  note: z.string().min(1).max(1_200)
}).strict();

const evidenceHighlightSchema = z.object({
  x: z.number().min(0).max(1).describe("页面快照左边缘到高亮框左边缘的距离 / 页面快照宽度，0到1；不是像素"),
  y: z.number().min(0).max(1).describe("页面快照上边缘到高亮框上边缘的距离 / 页面快照高度，0到1；不是像素"),
  width: z.number().positive().max(1).describe("高亮框宽度 / 页面快照宽度，大于0且x+width<=1"),
  height: z.number().positive().max(1).describe("高亮框高度 / 页面快照高度，大于0且y+height<=1"),
  label: z.string().min(1).max(160).optional()
}).strict().refine((highlight) => highlight.x + highlight.width <= 1 && highlight.y + highlight.height <= 1, {
  message: "证据高亮必须位于归一化页面范围内"
});
const explainerStateSchema = z.object({
  id: z.string().min(1).optional(),
  phase: z.enum(["entry", "progressive", "settled", "exit"]),
  start_frame: z.number().int().nonnegative(),
  end_frame: z.number().int().positive(),
  label: z.string().min(1).max(500),
  detail: z.string().min(1).max(2_000).optional()
}).strict().refine((state) => state.end_frame > state.start_frame, {
  message: "Explainer 状态结束帧必须大于开始帧"
});
const explainerVisualTreatmentSchema = z.object({
  mode: z.enum(["keep_presenter", "quiet", "light_overlay", "remotion", "b_roll", "cutaway", "evidence"]).optional(),
  intensity: z.enum(["low", "medium", "high"]).optional(),
  primary_attention: z.string().min(1).max(500).optional(),
  narrative_purpose: z.string().min(1).max(800).optional(),
  quiet_reason: z.string().min(1).max(800).optional(),
  fallback_plan: z.string().min(1).max(800).optional()
}).strict();

function provenanceFromMcp(input?: McpAssetProvenance): Omit<AssetProvenance, "acquiredAt"> | undefined {
  if (!input) return undefined;
  const optional = (value?: string) => value?.trim() || undefined;
  return {
    source: input.source,
    provider: optional(input.provider),
    sourceUrl: optional(input.source_url),
    originalAssetId: optional(input.original_asset_id),
    creator: optional(input.creator),
  };
}

async function importLocalMedia(projectId: string, baseRevision: number, filePath: string, metadata: {
  role?: Asset["role"];
  tags?: string[];
  provenance?: Omit<AssetProvenance, "acquiredAt">;
} = {}) {
  const sourcePath = resolve(filePath);
  // 导入原片可能很大；哈希用于去重，但不能为此占满进程内存。
  const sourceHash = await sha256File(sourcePath);
  const current = application.readProject(projectId);
  const duplicate = current.snapshot.assets.find((asset) => asset.sourceHash === sourceHash);
  if (duplicate) return { duplicate: true, asset: duplicate, state: current };
  const fileName = basename(sourcePath).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const relativePath = join("assets", "source", `${Date.now()}-${sourceHash.slice(0, 10)}${extname(fileName)}`);
  const destination = join(current.snapshot.project.rootPath, relativePath);
  await mkdir(join(current.snapshot.project.rootPath, "assets", "source"), { recursive: true });
  await copyFile(sourcePath, destination);
  return application.registerImportedAsset({
    projectId,
    baseRevision,
    name: fileName,
    kind: kindFromPath(fileName),
    managedPath: relativePath,
    originalPath: sourcePath,
    sourceHash,
    role: metadata.role,
    tags: metadata.tags,
    provenance: metadata.provenance ? { ...metadata.provenance, acquiredAt: new Date().toISOString() } : undefined
  });
}

const server = new McpServer({ name: "video-editor-mcp", version: "0.1.0" });

server.registerTool("read_project_overview", {
  title: "读取项目总览",
  description: "只读返回运行配置、顶层生产流程、关键入口、数据库表结构和 MCP 能力分组；不会执行视频任务。",
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, async () => asText({
  ...getProjectOverview(),
  assetProviders: assetProviders.catalog(),
  // 表结构来自真实 DDL 的唯一来源，不在总览中复制一份易漂移的 Schema。
  database: {
    engine: "SQLite",
    databasePath: join(workspaceRoot, "app.sqlite"),
    schemaSource: "packages/edit-application/src/persistence/schema.ts",
    tables: PROJECT_DATABASE_TABLES
  }
}));

server.registerTool("read_runtime_release", {
  title: "读取 MCP 与 Runtime 发行版本",
  description: "只读核对当前 MCP 和 Runtime 的 Release ID、Worker 健康状态；不会部署、重启或修改视频项目。",
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, async () => {
  try {
    const runtime = await readRuntimeReleaseStatus();
    return asText({
      mcpReleaseId: runtimeConfig.runtime.releaseId,
      runtime,
      aligned: runtime.releaseId === runtimeConfig.runtime.releaseId
    });
  } catch (error) { return asError(error); }
});

server.registerTool("open_web_workbench", {
  title: "打开剪辑工作台",
  description: "返回当前 VideoFlowCut Web 工作台地址。插件启动器已确保同一工作区的 API、Worker、Render 与静态工作台可用。",
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, async () => asText({ url: webOrigin, workspaceRoot }));

server.registerTool("list_projects", {
  title: "列出视频项目",
  description: "读取本地 Editing Application 中的项目摘要。",
  inputSchema: {}
}, async () => {
  try { return asText(application.listProjects()); } catch (error) { return asError(error); }
});

server.registerTool("create_project", {
  title: "创建视频项目",
  description: "创建含 Revision 1 的项目与受管媒体目录。",
  inputSchema: {
    name: z.string().min(1),
    fps: projectFrameRateSchema.optional(),
    brief: z.object({ captionMode: z.enum(["stable", "none"]).optional() }).strict().optional(),
    profile: z.enum(["presenter_motion", "visual_explainer", "vlog", "hybrid"]).optional()
  }
}, async (input) => {
  try {
    const state = application.createProject(input);
    targetProjectId = state.snapshot.project.id;
    return asText(state);
  } catch (error) { return asError(error); }
});

server.registerTool("preview_project_frame_rate_change", {
  title: "预检查项目帧率变更",
  description: "只读计算保持实际时间的帧率变更；返回取整误差、阻挡对象和需重建结果，不创建Revision。支持15至60整数帧率。",
  inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), fps: projectFrameRateSchema },
  annotations: { readOnlyHint: true }
}, async ({ project_id, base_revision_id, fps }) => {
  try { return asText(application.previewProjectFrameRateChange({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, fps })); }
  catch (error) { return asError(error); }
});

server.registerTool("set_project_frame_rate", {
  title: "设置项目帧率",
  description: "按当前Revision原子修改项目帧率并保持实际时间；重算项目坐标，保留源文件、固定作品帧率和真实毫秒证据。零帧范围或相关Job未终态时拒绝。相同帧率不创建Revision；修改后需新预览及声画复核。",
  inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), fps: projectFrameRateSchema }
}, async ({ project_id, base_revision_id, fps }) => {
  try { return asText(application.setProjectFrameRate({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, fps })); }
  catch (error) { return asError(error); }
});

server.registerTool("target_project", {
  title: "设定当前项目",
  description: "将 MCP 会话绑定到已存在的项目；不会修改项目内容。",
  inputSchema: { project_id: z.string().min(1) },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try {
    const state = application.readProject(project_id);
    targetProjectId = project_id;
    return asText({ projectId: project_id, revision: state.revision.number, name: state.snapshot.project.name });
  } catch (error) { return asError(error); }
});

server.registerTool("read_project", {
  title: "读取项目",
  description: "读取 Project、Story/Scene/Timeline 的同一 Revision 快照。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try { return asText(application.readProject(projectIdFrom(project_id))); } catch (error) { return asError(error); }
});

server.registerTool("read_story", {
  title: "读取 Story",
  description: "读取与 Scene、Timeline 同一 Revision 的 StoryDocument。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try {
    const state = application.readProject(projectIdFrom(project_id));
    return asText({ revision: state.revision.number, story: state.snapshot.story });
  } catch (error) { return asError(error); }
});

server.registerTool("manage_story", {
  title: "管理 Story",
  description: "原子更新 Story 标题、摘要或 Beat；不会直接改写 Timeline。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    title: z.string().max(160).optional(),
    summary: z.string().max(2_000).optional(),
    beats: z.array(z.object({ id: z.string().optional(), title: z.string().max(160), purpose: z.string().max(800), semantic_unit_ids: z.array(z.string()).optional(), scene_ids: z.array(z.string()).optional() })).max(40).optional()
  }
}, async (input) => {
  try {
    return asText(application.updateStory({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      title: input.title,
      summary: input.summary,
      beats: input.beats?.map((beat) => ({ id: beat.id, title: beat.title, purpose: beat.purpose, semanticUnitIds: beat.semantic_unit_ids, sceneIds: beat.scene_ids }))
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("get_editor_url", {
  title: "获取工作台链接",
  description: "只读返回项目或对象的工作台URL；panel=fonts可打开字体库，font_preview提供实际文案、预期字体、用途及原视觉作者推荐的最多3款已登记字体和理由。链接只展示候选，不自动选择或修改项目；主任务等待用户在聊天确认后续接原作者。",
  inputSchema: {
    project_id: z.string().optional(),
    scene_id: z.string().optional(),
    item_id: z.string().optional(),
    effect_cue_id: z.string().optional(),
    frame: z.number().int().nonnegative().optional(),
    panel: z.literal("fonts").optional(),
    font_preview: fontPreviewSchema.optional()
  },
  annotations: { readOnlyHint: true }
}, async (input) => {
  try {
    const projectId = projectIdFrom(input.project_id);
    const state = application.readProject(projectId);
    const url = new URL(webOrigin);
    url.searchParams.set("projectId", projectId);
    if (input.scene_id) url.searchParams.set("sceneId", input.scene_id);
    if (input.item_id) url.searchParams.set("itemId", input.item_id);
    if (input.effect_cue_id) url.searchParams.set("effectCueId", input.effect_cue_id);
    if (input.frame !== undefined) url.searchParams.set("frame", String(input.frame));
    if (input.panel || input.font_preview) url.searchParams.set("panel", "fonts");
    if (input.font_preview) {
      const available = new Set(listMotionFonts().map(font => font.id));
      for (const candidate of input.font_preview.candidates) if (!available.has(candidate.font_id)) throw new Error(`MOTION_FONT_UNKNOWN: 推荐字体${candidate.font_id}未登记，请重新查询字体库`);
      url.searchParams.set("fontPreview", JSON.stringify(input.font_preview));
    }
    return asText({ editorUrl: url.toString(), revision: state.revision.number });
  } catch (error) { return asError(error); }
});

server.registerTool("focus_editor_object", {
  title: "定位工作台对象",
  description: "生成指向指定 Scene、Timeline Item、EffectCue 或帧的稳定工作台 URL；不会修改项目。",
  inputSchema: {
    project_id: z.string().optional(),
    scene_id: z.string().optional(),
    item_id: z.string().optional(),
    effect_cue_id: z.string().optional(),
    frame: z.number().int().nonnegative().optional()
  },
  annotations: { readOnlyHint: true }
}, async (input) => {
  try {
    const projectId = projectIdFrom(input.project_id);
    const state = application.readProject(projectId);
    const url = new URL(webOrigin);
    url.searchParams.set("projectId", projectId);
    if (input.scene_id) url.searchParams.set("sceneId", input.scene_id);
    if (input.item_id) url.searchParams.set("itemId", input.item_id);
    if (input.effect_cue_id) url.searchParams.set("effectCueId", input.effect_cue_id);
    if (input.frame !== undefined) url.searchParams.set("frame", String(input.frame));
    return asText({ editorUrl: url.toString(), revision: state.revision.number, focus: input });
  } catch (error) { return asError(error); }
});

server.registerTool("read_impact_report", {
  title: "读取改动影响",
  description: "读取某个 Revision 的 ImpactReport、脏区与失效对象。",
  inputSchema: { project_id: z.string().optional(), revision: z.number().int().positive().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id, revision }) => {
  try {
    const projectId = projectIdFrom(project_id);
    const current = application.readProject(projectId);
    const target = revision ? application.repository.getRevision(projectId, revision) : current.revision;
    return asText({ revision: target.number, summary: target.summary, impact: target.impact });
  } catch (error) { return asError(error); }
});

server.registerTool("list_revisions", {
  title: "列出 Revision",
  description: "读取不可变 Revision 历史，不会改变当前项目。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try { return asText(application.readRevisions(projectIdFrom(project_id))); } catch (error) { return asError(error); }
});

server.registerTool("read_agent_work_orders", {
  title: "读取 Agent 工作单",
  description: "读取 Web 用户提交的意图、关联对象 ID 与当前状态；工作单不复制 Timeline，接手前请使用返回的 revision。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try { return asText(application.readAgentWorkOrders(projectIdFrom(project_id))); } catch (error) { return asError(error); }
});

server.registerTool("claim_agent_work_order", {
  title: "接手 Agent 工作单",
  description: "由 Codex 使用当前 Revision 原子接手一条待处理工作单；不会自动执行剪辑或调用 LLM。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    work_order_id: z.string().min(1),
    agent_id: z.string().trim().min(1).max(160)
  }
}, async ({ project_id, base_revision_id, work_order_id, agent_id }) => {
  try {
    return asText(application.claimAgentWorkOrder({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      workOrderId: work_order_id,
      agentId: agent_id
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("complete_agent_work_order", {
  title: "完成 Agent 工作单",
  description: "由原接手 Codex 回写完成摘要。edited 必须从 Revision 历史取得实际对象变化；reviewed_no_change 只记录明确审查结论。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    work_order_id: z.string().min(1),
    agent_id: z.string().trim().min(1).max(160),
    completion_summary: z.string().trim().min(1).max(4_000),
    completion_kind: z.enum(["edited", "reviewed_no_change"])
  }
}, async ({ project_id, base_revision_id, work_order_id, agent_id, completion_summary, completion_kind }) => {
  try {
    return asText(application.completeAgentWorkOrder({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      workOrderId: work_order_id,
      agentId: agent_id,
      completionSummary: completion_summary,
      completionKind: completion_kind
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("release_agent_work_order", {
  title: "释放 Agent 工作单",
  description: "原接手 Codex 无法继续时，用当前 Revision 将 claimed 工作单释放回 open；不会伪造完成。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    work_order_id: z.string().min(1),
    agent_id: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(2_000)
  }
}, async ({ project_id, base_revision_id, work_order_id, agent_id, reason }) => {
  try {
    return asText(application.releaseAgentWorkOrder({
      projectId: projectIdFrom(project_id), baseRevision: base_revision_id, workOrderId: work_order_id, agentId: agent_id, reason
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("report_editing_blocker", {
  title: "报告剪辑阻断",
  description: "剪辑 Agent 因现有 MCP 工具缺失、报错、Runtime 故障或工作流无法继续时创建修复工单；不会创建视频 Revision、修改源码或尝试临时绕过。",
  inputSchema: {
    project_id: z.string().optional(),
    reported_revision: z.number().int().positive(),
    category: z.enum(["tool_missing", "tool_error", "runtime_failure", "workflow_blocker"]),
    summary: z.string().trim().min(1).max(1_000),
    detail: z.string().trim().min(1).max(8_000).optional(),
    tool_name: z.string().trim().min(1).max(160).optional(),
    job_id: z.string().min(1).optional(),
    reporter_id: z.string().trim().min(1).max(160),
    idempotency_key: z.string().trim().min(1).max(240)
  }
}, async (input) => {
  try {
    // Runtime 恰好已不可达时仍必须能留下故障记录；报告保存 MCP 自己携带的发行摘要，
    // 而“已部署/已恢复”两类状态才强制要求 Runtime 在线且版本一致。
    return asText(application.reportEditingBlocker({
      projectId: projectIdFrom(input.project_id),
      reportedRevision: input.reported_revision,
      category: input.category,
      summary: input.summary,
      detail: input.detail,
      toolName: input.tool_name,
      jobId: input.job_id,
      reporterId: input.reporter_id,
      reportedReleaseId: runtimeConfig.runtime.releaseId,
      idempotencyKey: input.idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("list_repair_tickets", {
  title: "读取修复工单",
  description: "读取独立于视频 Revision 的平台修复工单和当前视频 Revision；只读，不会接手、部署或改动 Timeline。",
  inputSchema: {
    project_id: z.string().optional(),
    statuses: z.array(z.enum(["open", "claimed", "ready_for_cutover", "deployed", "acknowledged", "resolved_without_deployment"])).max(6).optional()
  },
  annotations: { readOnlyHint: true }
}, async ({ project_id, statuses }) => {
  try { return asText(application.readRepairTickets({ projectId: projectIdFrom(project_id), statuses })); } catch (error) { return asError(error); }
});

server.registerTool("claim_repair_ticket", {
  title: "接手平台修复工单",
  description: "修复 Agent 接手一条待处理平台工单。报告剪辑 Agent 不能自行接手，且接手不授予修改正式视频项目的权限。",
  inputSchema: {
    ticket_id: z.string().min(1),
    repairer_id: z.string().trim().min(1).max(160)
  }
}, async ({ ticket_id, repairer_id }) => {
  try { return asText(application.claimRepairTicket({ ticketId: ticket_id, repairerId: repairer_id })); } catch (error) { return asError(error); }
});

server.registerTool("release_repair_ticket", {
  title: "释放平台修复工单",
  description: "原接手修复 Agent 无法继续时释放工单，保留原因供下一位修复者复现；不会把未完成修复伪装成已部署。",
  inputSchema: {
    ticket_id: z.string().min(1),
    repairer_id: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(4_000)
  }
}, async ({ ticket_id, repairer_id, reason }) => {
  try { return asText(application.releaseRepairTicket({ ticketId: ticket_id, repairerId: repairer_id, reason })); } catch (error) { return asError(error); }
});

server.registerTool("resolve_repair_ticket_without_deployment", {
  title: "按非部署原因收口修复工单",
  description: "仅原接手修复 Agent 可在核实输入错误、重复报告或宿主外部恢复后，用具体证据收口；不会宣称平台代码已部署，也不会因 Job 后来成功自动关闭。",
  inputSchema: {
    ticket_id: z.string().min(1),
    repairer_id: z.string().trim().min(1).max(160),
    kind: z.enum(["invalid_input", "duplicate", "external_recovery"]),
    evidence: z.string().trim().min(16).max(8_000)
  }
}, async ({ ticket_id, repairer_id, kind, evidence }) => {
  try { return asText(application.resolveRepairTicketWithoutDeployment({ ticketId: ticket_id, repairerId: repairer_id, kind, evidence })); }
  catch (error) { return asError(error); }
});

server.registerTool("mark_repair_candidate_ready", {
  title: "标记修复候选版就绪",
  description: "记录已在独立工作区和独立端口完成复现与回归的候选 Release ID；不切换正式 Runtime，也不修改正式视频数据。",
  inputSchema: {
    ticket_id: z.string().min(1),
    repairer_id: z.string().trim().min(1).max(160),
    candidate_release_id: z.string().regex(/^release-[a-f0-9]{64}$/u),
    validation_summary: z.string().trim().min(1).max(8_000)
  }
}, async ({ ticket_id, repairer_id, candidate_release_id, validation_summary }) => {
  try {
    return asText(application.markRepairTicketReadyForCutover({
      ticketId: ticket_id,
      repairerId: repairer_id,
      candidateReleaseId: candidate_release_id,
      validationSummary: validation_summary
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("mark_repair_deployed", {
  title: "确认修复版已部署",
  description: "仅当当前 MCP 与 Runtime 均报告同一健康 Release ID 时，才把已验证候选版记为部署完成；旧 MCP 或旧 Runtime 无法确认。",
  inputSchema: {
    ticket_id: z.string().min(1),
    repairer_id: z.string().trim().min(1).max(160),
    deployment_evidence: z.string().trim().min(1).max(8_000)
  }
}, async ({ ticket_id, repairer_id, deployment_evidence }) => {
  try {
    const runtime = await requireAlignedRuntimeRelease();
    return asText(application.markRepairTicketDeployed({
      ticketId: ticket_id,
      repairerId: repairer_id,
      releaseId: runtime.releaseId,
      deploymentEvidence: deployment_evidence
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("acknowledge_repair_deployment", {
  title: "确认新版 MCP 后恢复剪辑",
  description: "原报告阻断的剪辑 Agent 在重新连接 MCP 后，用当前 Revision 与实际 Runtime Release ID 确认恢复；确认后才可继续剪辑。",
  inputSchema: {
    ticket_id: z.string().min(1),
    editor_id: z.string().trim().min(1).max(160),
    observed_revision: z.number().int().positive()
  }
}, async ({ ticket_id, editor_id, observed_revision }) => {
  try {
    const runtime = await requireAlignedRuntimeRelease();
    return asText(application.acknowledgeRepairTicketDeployment({
      ticketId: ticket_id,
      editorId: editor_id,
      releaseId: runtime.releaseId,
      observedRevision: observed_revision
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("rollback_revision", {
  title: "回退 Revision",
  description: "以明确 base_revision_id 原子恢复指定快照，并生成新的 Revision。",
  inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), target_revision: z.number().int().positive() }
}, async ({ project_id, base_revision_id, target_revision }) => {
  try { return asText(application.rollbackToRevision({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, targetRevision: target_revision })); } catch (error) { return asError(error); }
});

server.registerTool("browse_assets", {
  title: "浏览素材库",
  description: "读取项目素材、媒体元数据和处理状态。",
  inputSchema: { project_id: z.string().optional(), kind: z.enum(["video", "audio", "image", "document", "actor_video", "speech", "derived"]).optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id, kind }) => {
  try {
    const state = application.readProject(projectIdFrom(project_id));
    return asText(kind ? state.snapshot.assets.filter((asset) => asset.kind === kind) : state.snapshot.assets);
  } catch (error) { return asError(error); }
});

server.registerTool("inspect_asset", {
  title: "审阅原素材",
  description: "只读地按 overview、range 或 dense 获取原素材的连续声画、联系表、声音辅助证据、转写、Shot 与当前使用位置。overview覆盖素材全长的概览，不生成完整连续代理；range最长60秒，dense最长12秒，源范围按项目fps的半开区间[start,end)计，range/dense必须提供起止帧。联系表上限分别为25/24/48帧。overview的声音只确认音轨；range/dense提供当前窗口的波形、静音和meanVolumeDb/maxVolumeDb（dBFS），均不提供LUFS或true peak，不能拼接短窗口读数推断全片响度。需要实际合成响度时，通过render_preview_range生成目标范围，再读取成功Job.result.audio；只有覆盖完整Timeline的输出才是全片混合测量，当前没有直接测原素材全长LUFS的独立MCP入口。音视频返回 reviewPath，只读审阅页面提供播放、暂停、重播和进度控件，浏览器优先打开此路径。派生文件只写入可重建缓存，不会创建 Revision 或自动做剪辑判断。返回diagnostics.status（complete/partial/unavailable/not_ready）、requestedFrames/generatedFrames、components、continuousReview、issues及recovery，sideEffects=review_cache_only。单张预览失败保留其他有效图片，代理和声音证据分别返回；空输出/超时不证明原视频损坏。inspect_available_evidence交原作者查看证据与缺口；select_another_candidate暂不采用当前候选、继续正常选材；只有report_platform_failure停止受影响步骤并报修，其他无依赖工作继续。wait_for_media_analysis等待媒体分析。没有连续代理的range/dense不能以截图宣称正式选段审阅通过；不自动改Asset状态、Revision、Job或创建工单，不授权重放旧下载/生成。",
  inputSchema: {
    project_id: z.string().optional(),
    asset_id: z.string().min(1),
    mode: z.enum(["overview", "range", "dense"]).default("overview").describe("overview为全长概览；range最长60秒，dense最长12秒；后两者必填源起止帧。"),
    source_start_frame: z.number().int().nonnegative().optional().describe("源起始帧（含），按项目fps计；range/dense必填。"),
    source_end_frame: z.number().int().positive().optional().describe("源结束帧（不含），按项目fps计；range/dense必填，差值分别≤60×fps/12×fps，且不超过素材真实范围。"),
    // 与 HTTP 合同保持一致；不同入口不能对同一请求给出不同的帧数边界。
    contact_sheet_frames: z.number().int().positive().max(48).optional().describe("联系表采样数：overview为1–25，range为1–24，dense为1–48。")
  },
  annotations: { readOnlyHint: true }
}, async ({ project_id, asset_id, mode, source_start_frame, source_end_frame, contact_sheet_frames }) => {
  try {
    return asText(await inspectAsset(application, {
      projectId: projectIdFrom(project_id),
      assetId: asset_id,
      mode,
      sourceStartFrame: source_start_frame,
      sourceEndFrame: source_end_frame,
      contactSheetFrames: contact_sheet_frames
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("browse_sound_sources", {
  title: "在线音效候选来源",
  description: "返回当前在线音效/音乐 Provider 的实际搜索、试听、原文件、分类、访问能力；不下载，也不表示已试听或适合成片。",
  inputSchema: {}, annotations: { readOnlyHint: true }
}, async () => asText({ sources: soundSourceCapabilities(), workflow: "段落计划 → 在线需求 → 搜索 → Qwen候选排序 → 原音频观察 → 原文件获取与复核 → manage_audio → 正式Preview与实际复核", listening: "来源可用不代表音效合适；模型观察与最终混合听审分别保存。" }));

server.registerTool("manage_asset_requirements", {
  title: "管理素材需求",
  description: "在当前 Revision 创建、更新或关闭视觉/声音需求。音频用 media_kind=audio、audio_brief、role=sfx/bgm，不填画幅；候选不会自动进入 Timeline。",
  inputSchema: z.object({
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "close"]),
    asset_request_id: z.string().min(1).optional(),
    title: z.string().max(160).optional(),
    purpose: z.string().max(800).optional(),
    visual_brief: z.string().max(1_600).optional(),
    media_kind: z.enum(["visual", "audio"]).optional(),
    audio_brief: z.string().max(1_600).optional(),
    sound: soundRequirementSchema.optional(),
    role: assetRoleSchema.optional(),
    query_hints: z.array(z.string().min(1).max(160)).max(12).optional(),
    excluded_terms: z.array(z.string().min(1).max(160)).max(20).optional(),
    target_aspect_ratio: z.enum(["9:16", "16:9", "1:1"]).optional(),
    min_duration_ms: z.number().int().positive().max(300_000).nullable().optional().describe("最终采用的视频或音频连续范围要求，单位毫秒；不拦截搜索或下载，图片不应用该条件。null 清空，省略保持原值，0 无效。"),
    fallback_plan: z.enum(["keep_presenter", "remotion", "minimax", "ask_user", "local_audio", "omit_audio"]).optional(),
    close_reason: z.string().max(800).optional()
  }).strict()
}, async ({ project_id, base_revision_id, action, asset_request_id, title, purpose, visual_brief, media_kind, audio_brief, sound, role, query_hints, excluded_terms, target_aspect_ratio, min_duration_ms, fallback_plan, close_reason }) => {
  try {
    return asText(application.manageAssetRequirement({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      action,
      assetRequestId: asset_request_id,
      title,
      purpose,
      visualBrief: visual_brief,
      mediaKind: media_kind,
      audioBrief: audio_brief,
      sound,
      role,
      queryHints: query_hints,
      excludedTerms: excluded_terms,
      targetAspectRatio: target_aspect_ratio,
      minDurationMs: min_duration_ms,
      fallbackPlan: fallback_plan,
      closeReason: close_reason
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("list_asset_providers", {
  title: "读取素材服务目录",
  description: "只读返回真实注册服务的准确 id、支持媒体类型、查询形式与配置缺口；enabled 表示已注册，不代表外网或下载器已通过连通性验证。",
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, async () => asText({ providers: assetProviders.catalog(), network: { proxyConfigured: Boolean(process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY), scope: "素材外网请求；本地地址直连" } }));

server.registerTool("search_media_candidates", {
  title: "搜索素材候选",
  description: "先从 list_asset_providers 选择准确 provider id。media_type 明确筛选图片/视频/音频；youtube 的 query 是选中的单条 HTTPS 视频页面；pexels 无 API Key 时也只接受选定的单视频页 URL，关键词需要 Key。返回 diagnostics.complete 和 warnings，部分结果不能视为完整搜索。仅保存独立搜索会话，不改变创作 Revision，不下载或自动采用素材。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
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
    if (state.revision.number !== base_revision_id) {
      throw new DomainError(`Revision 已过期：请求基于 ${base_revision_id}，当前为 ${state.revision.number}`, "REVISION_CONFLICT");
    }
    const request = state.snapshot.assetRequests.find((entry) => entry.id === asset_request_id);
    if (!request) throw new DomainError(`素材需求不存在：${asset_request_id}`, "ASSET_REQUEST_NOT_FOUND");
    const source = assetProviders.get(provider);
    if (media_type && !assetProviders.catalog().find(entry => entry.id === provider)?.mediaTypes.includes(media_type)) throw new AssetProviderError("该素材服务不支持所选媒体类型，请查看服务目录", "ASSET_MEDIA_TYPE_UNSUPPORTED", { provider, stage: "provider", recovery: "change_media_type" });
    const input = { request, query, mediaType: media_type, cursor };
    decodeSearchCursor(provider, input);
    const result = source.searchDetailed ? await source.searchDetailed(input) : { candidates: await source.search(input), complete: true, warnings: [] };
    const candidates = result.candidates.filter(candidate => !media_type || (candidate.kind ?? "video") === media_type);
    beforePersistence = false;
    return asText(application.recordAssetSearch({ projectId, baseRevision: base_revision_id, assetRequestId: asset_request_id, provider, query, candidates, cursor, nextCursor: "nextCursor" in result ? result.nextCursor as string | undefined : undefined, mediaType: media_type, diagnostics: { complete: result.complete, warnings: result.warnings }, requestVersion: assetRequestVersion(request) }));
  } catch (error) { return assetSearchErrorResult(error, beforePersistence); }
});

server.registerTool("inspect_media_candidate", {
  title: "检查素材候选",
  description: "读取候选的来源、时长、画幅、技术过滤理由及其对应素材需求；只读，不代表候选已被采用。",
  inputSchema: { project_id: z.string().optional(), asset_candidate_id: z.string().min(1) },
  annotations: { readOnlyHint: true }
}, async ({ project_id, asset_candidate_id }) => {
  try { return asText(application.readAssetCandidate({ projectId: projectIdFrom(project_id), assetCandidateId: asset_candidate_id })); } catch (error) { return asError(error); }
});

server.registerTool("acquire_media_asset", {
  title: "下载并本地化素材候选",
  description: "取得候选并自动探测真实媒体信息，缺省时长或短文件不阻止下载。quality_height 按目标画幅和裁切选择画质，省略使用项目高度；source_range_ms 仅用于 YouTube 已定位原片范围，省略取得整文件。返回 Job，完成后带原片范围、本地时间与已有候选观察。Worker 保留 MIME、文件头、哈希与媒体验证。未知或执行中任务只查原 Job；不同范围不冒充同一次获取。故障修复确认部署后才恢复明确失败的任务。",
  inputSchema: z.object({
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    asset_candidate_id: z.string().min(1),
    quality_height: z.number().int().min(144).max(8640).optional(),
    source_range_ms: z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() }).strict()
      .refine(range => range.endMs > range.startMs, "原片结束时间必须大于开始时间").optional(),
    idempotency_key: z.string().min(1).max(240).optional()
  }).strict()
}, async ({ project_id, base_revision_id, asset_candidate_id, idempotency_key, quality_height, source_range_ms }) => {
  try {
    return asText(application.acquireAssetCandidate({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, assetCandidateId: asset_candidate_id, idempotencyKey: idempotency_key,
      options: { qualityHeight: quality_height, sourceRange: source_range_ms } }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_asset_provenance", {
  title: "读取素材来源",
  description: "读取已经本地化 Asset 的 Provider、来源页面、作者、原始素材 ID、取得时间和对应候选；只读。",
  inputSchema: { project_id: z.string().optional(), asset_id: z.string().min(1) },
  annotations: { readOnlyHint: true }
}, async ({ project_id, asset_id }) => {
  try { return asText(application.readAssetProvenance({ projectId: projectIdFrom(project_id), assetId: asset_id })); } catch (error) { return asError(error); }
});

server.registerTool("import_media", {
  title: "导入本地素材",
  description: "复制本地媒体到受管项目目录并创建媒体分析任务；可同时登记 A/B-roll 角色、来源信息。",
  inputSchema: z.object({
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    file_path: z.string().min(1),
    role: assetRoleSchema.optional(),
    tags: z.array(z.string().min(1).max(80)).max(30).optional(),
    provenance: assetProvenanceSchema.optional()
  }).strict()
}, async ({ project_id, base_revision_id, file_path, role, tags, provenance }) => {
  try {
    return asText(await importLocalMedia(projectIdFrom(project_id), base_revision_id, file_path, {
      role,
      tags,
      provenance: provenanceFromMcp(provenance)
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("extract_source_audio", {
  title: "提取已入库视频原声",
  description: "从已就绪视频的明确毫秒源范围提取独立 WAV 并登记来源；随后由媒体分析 Job 验证。不会自动写入声音轨，需读回 Asset 后再使用 manage_audio。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    source_asset_id: z.string().min(1),
    source_start_ms: z.number().int().nonnegative(),
    source_end_ms: z.number().int().positive()
  }
}, async ({ project_id, base_revision_id, source_asset_id, source_start_ms, source_end_ms }) => {
  try { return asText(await extractSourceAudio(application, { projectId: projectIdFrom(project_id), baseRevision: base_revision_id,
    sourceAssetId: source_asset_id, startMs: source_start_ms, endMs: source_end_ms })); }
  catch (error) { return asError(error); }
});

server.registerTool("browse_local_sound_effects", {
  title: "浏览本地音效库",
  description: "只浏览由 VIDEOFLOWCUT_SFX_ROOTS 显式配置的本地音效根目录；返回相对路径、时长与格式，不泄漏根目录外文件。",
  inputSchema: {
    query: z.string().trim().min(1).max(160).optional(),
    max_results: z.number().int().min(1).max(100).optional()
  },
  annotations: { readOnlyHint: true }
}, async ({ query, max_results }) => {
  try {
    return asText(await browseLocalSoundEffects({
      configuredRoots: runtimeConfig.localSoundEffects.roots,
      query,
      maxResults: max_results
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("inspect_local_sound_effect", {
  title: "检测本地音效起点",
  description: "读取一个已配置根目录内的音效，并用 silencedetect 提供可复核的非静音起点候选；该检测不等于人工确认。",
  inputSchema: {
    root_id: z.string().regex(/^sfx-root-\d+$/u),
    relative_path: z.string().min(1).max(1_000)
  },
  annotations: { readOnlyHint: true }
}, async ({ root_id, relative_path }) => {
  try {
    return asText(await inspectLocalSoundEffect({
      configuredRoots: runtimeConfig.localSoundEffects.roots,
      rootId: root_id,
      relativePath: relative_path
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("import_local_sound_effect", {
  title: "导入本地音效",
  description: "将已检测、且仍位于配置音效根目录内的文件复制到项目受管目录并创建媒体分析任务。",
  inputSchema: z.object({
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    root_id: z.string().regex(/^sfx-root-\d+$/u),
    relative_path: z.string().min(1).max(1_000),
    tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  }).strict()
}, async ({ project_id, base_revision_id, root_id, relative_path, tags, }) => {
  try {
    const local = await resolveLocalSoundEffectForImport({
      configuredRoots: runtimeConfig.localSoundEffects.roots,
      rootId: root_id,
      relativePath: relative_path
    });
    const result = await importLocalMedia(projectIdFrom(project_id), base_revision_id, local.absolutePath, {
      role: "sfx",
      tags: [...new Set(["local_sound_effect", ...(tags ?? [])])],
      provenance: {
        source: "local_import",
      }
    });
    return asText({
      ...result,
      importedSoundEffect: {
        rootId: local.effect.rootId,
        relativePath: local.effect.relativePath,
      }
    });
  } catch (error) { return asError(error); }
});

server.registerTool("update_asset_metadata", {
  title: "标注素材角色与来源",
  description: "为已导入素材记录叙事角色、标签、来源信息；不改变媒体文件或分析任务。",
  inputSchema: z.object({
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    asset_id: z.string().min(1),
    role: assetRoleSchema.optional(),
    tags: z.array(z.string().min(1).max(80)).max(30).optional(),
    provenance: assetProvenanceSchema.optional()
  }).strict()
}, async ({ project_id, base_revision_id, asset_id, role, tags, provenance }) => {
  try {
    const normalizedProvenance = provenanceFromMcp(provenance);
    return asText(application.updateAssetEditorialMetadata({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      assetId: asset_id,
      role,
      tags,
      provenance: normalizedProvenance ? { ...normalizedProvenance, acquiredAt: new Date().toISOString() } : undefined
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("submit_transcription", {
  title: "提交 FunASR 转写",
  description: "使用动态读取 Schema 的 ComfyUI Bridge 工作流提交音频转写。",
  inputSchema: { project_id: z.string().optional(), asset_id: z.string().min(1), idempotency_key: z.string().optional() }
}, async ({ project_id, asset_id, idempotency_key }) => {
  try { return asText(application.submitTranscription({ projectId: projectIdFrom(project_id), assetId: asset_id, idempotencyKey: idempotency_key })); } catch (error) { return asError(error); }
});

server.registerTool("generate_source_audio_captions", {
  title: "生成原声 A-roll 字幕",
  description: "为已登记 use_source_audio 的 A-roll 提交 FunASR 段级对齐。Provider 返回的每个 segment 会自动生成一屏带真实原声时间的字幕；不生成旁白、不改 Script，也不需要手工逐条提交字幕 Program。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    timeline_item_id: z.string().min(1),
    idempotency_key: z.string().min(1).max(240).optional()
  }
}, async ({ project_id, base_revision_id, timeline_item_id, idempotency_key }) => {
  try {
    return asText(application.generateSourceAudioCaptions({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      timelineItemId: timeline_item_id,
      idempotencyKey: idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("generate_speech_captions", {
  title: "从最终旁白生成真实分屏字幕",
  description: "对当前已就绪 SpeechAsset 的完整 Dialogue 音频使用 FunASR 生成真实时间字幕段，原子替换未人工改写的整段默认卡。保留 Script、自然语音段、声音、Scene 与动效；不伪装原声 A-roll，不按字符估时。完成后用 read_source_audio_alignment、read_captions 核查；有可靠 token 时间时才可用 apply_source_caption_program 重分溢出卡。",
  inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), idempotency_key: z.string().min(1).max(240).optional() }
}, async ({ project_id, base_revision_id, idempotency_key }) => {
  try {
    return asText(application.generateSpeechCaptions({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, idempotencyKey: idempotency_key }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_source_audio_alignment", {
  title: "读取原声字幕段对齐",
  description: "读取指定音频使用的 Provider 字幕段、内部 token 时间证据和 Bridge 审计；speechSource 明确标注最终旁白版本，缺省为原声 A-roll。正常生成已自动完成；仅在排版溢出、错分段或回听纠错时用于诊断，不执行项目写入。",
  inputSchema: {
    project_id: z.string().optional(),
    alignment_id: z.string().min(1).optional(),
    timeline_item_id: z.string().min(1).optional()
  },
  annotations: { readOnlyHint: true }
}, async ({ project_id, alignment_id, timeline_item_id }) => {
  try {
    return asText({ sourceAudioAlignments: application.readSourceAudioAlignment({
      projectId: projectIdFrom(project_id),
      alignmentId: alignment_id,
      timelineItemId: timeline_item_id
    }) });
  } catch (error) { return asError(error); }
});

server.registerTool("apply_source_caption_program", {
  title: "覆盖原声字幕分屏",
  description: "仅在 Provider 单段实际超过两行、分段明显破坏语义、已回听确认错字或用户明确要求重新分屏时使用。根据已读取的内部时间证据原子替换当前默认 Program；不能手填时间、删词、补词或伪造时间。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    alignment_id: z.string().min(1),
    cards: z.array(z.object({
      token_start_index: z.number().int().min(0),
      token_end_index: z.number().int().positive(),
      display_text: z.string().trim().min(1).max(2_000).optional(),
      rationale: z.string().trim().min(1).max(240)
    })).min(1).max(300)
  }
}, async ({ project_id, base_revision_id, alignment_id, cards }) => {
  try {
    return asText(application.applySourceCaptionProgram({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      alignmentId: alignment_id,
      cards: cards.map((card) => ({
        tokenStartIndex: card.token_start_index,
        tokenEndIndex: card.token_end_index,
        displayText: card.display_text,
        rationale: card.rationale
      }))
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("apply_manual_transcript", {
  title: "写入人工校正转写",
  description: "在 FunASR 不可用、结果需要修正或用户提供文稿时，基于明确 Revision 写入全文和候选句；不会伪造词级时间。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    asset_id: z.string().min(1),
    text: z.string().trim().min(1).max(20_000)
  }
}, async ({ project_id, base_revision_id, asset_id, text }) => {
  try {
    return asText(application.applyTranscript({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      assetId: asset_id,
      text,
      source: "manual"
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_script", {
  title: "读取最终 Script",
  description: "读取转写候选、经语义判断的 SemanticUnit、最终 Script 和 SpeechSegment；不把标点候选伪装成语义或词级时序。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try {
    const snapshot = application.readProject(projectIdFrom(project_id)).snapshot;
    return asText({ transcriptSentenceCandidates: snapshot.transcriptSentenceCandidates, semanticUnits: snapshot.semanticUnits, script: snapshot.script, speechSegments: snapshot.speechSegments });
  } catch (error) { return asError(error); }
});

server.registerTool("apply_semantic_units", {
  title: "应用语义单元判断",
  description: "由 semantic-continuity 根据上下文将转写候选编译为完整 SemanticUnit，并明确停顿理由；这一步才会生成 SpeechSegment。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    units: z.array(z.object({
      candidate_ids: z.array(z.string()).min(1),
      text: z.string().min(1).max(2_000),
      kind: z.enum(["statement", "question", "answer", "cause", "conclusion", "contrast", "list_item", "setup", "payoff", "retake", "intentional_repetition"]),
      dependencies: z.array(z.string()).optional(),
      preceding_context: z.string().max(2_000).optional(),
      following_context: z.string().max(2_000).optional(),
      retake_group_id: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      pause_before: z.object({ duration_ms: z.number().int().min(0).max(10_000), reason: z.enum(["sentence", "contrast", "emotion", "breath", "chapter"]) }).optional()
    })).max(200)
  }
}, async (input) => {
  try {
    return asText(application.applySemanticUnits({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      units: input.units.map((unit) => ({
        candidateIds: unit.candidate_ids,
        text: unit.text,
        kind: unit.kind,
        dependencies: unit.dependencies,
        precedingContext: unit.preceding_context,
        followingContext: unit.following_context,
        retakeGroupId: unit.retake_group_id,
        confidence: unit.confidence,
        pauseBefore: unit.pause_before ? { durationMs: unit.pause_before.duration_ms, reason: unit.pause_before.reason } : undefined
      }))
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("apply_authored_script", {
  title: "应用原创新稿",
  description: "将已经过语义审阅的原创新稿整体替换为当前 Script，生成无时间估算的 SpeechSegment。填写 source_note 说明来源；不需要也不允许把新稿绑定到音色素材或转写候选。不是局部追加：旧旁白、字幕和声音包装会按既有 Script 规则失效，写后读取 Revision、Script 与 Impact，再用 VoiceReference 合成真实旁白。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    source_note: z.string().trim().min(1).max(2_000),
    units: z.array(z.object({
      text: z.string().trim().min(1).max(2_000),
      kind: z.enum(["statement", "question", "answer", "cause", "conclusion", "contrast", "list_item", "setup", "payoff", "retake", "intentional_repetition"]),
      dependencies: z.array(z.string()).optional(),
      preceding_context: z.string().max(2_000).optional(),
      following_context: z.string().max(2_000).optional(),
      confidence: z.number().min(0).max(1).optional(),
      pause_before: z.object({ duration_ms: z.number().int().min(0).max(10_000), reason: z.enum(["sentence", "contrast", "emotion", "breath", "chapter"]) }).optional()
    }).strict()).min(1).max(200)
  }
}, async (input) => {
  try {
    return asText(application.applyAuthoredScript({
      projectId: projectIdFrom(input.project_id), baseRevision: input.base_revision_id, sourceNote: input.source_note,
      units: input.units.map((unit) => ({
        text: unit.text, kind: unit.kind, dependencies: unit.dependencies,
        precedingContext: unit.preceding_context, followingContext: unit.following_context, confidence: unit.confidence,
        pauseBefore: unit.pause_before ? { durationMs: unit.pause_before.duration_ms, reason: unit.pause_before.reason } : undefined
      }))
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("apply_script", {
  title: "应用语义 Script",
  description: "按完整语义单元更新最终 Script，并返回新 Revision 与 ImpactReport。",
  inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), semantic_unit_ids: z.array(z.string()) }
}, async ({ project_id, base_revision_id, semantic_unit_ids }) => {
  try { return asText(application.applyScript({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, semanticUnitIds: semantic_unit_ids })); } catch (error) { return asError(error); }
});

server.registerTool("read_speech_asset", {
  title: "读取语音资产",
  description: "读取 SpeechSegment、SegmentAsset、最终 SpeechAsset、可选真实词级对齐与本地 VoiceReference；不会伪造远端 Voice ID。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try {
    const snapshot = application.readProject(projectIdFrom(project_id)).snapshot;
    return asText({
      scriptRevision: snapshot.script.revision,
      voiceReferences: snapshot.voiceReferences,
      speechSegments: snapshot.speechSegments,
      speechSegmentAssets: snapshot.speechSegmentAssets,
      speechAsset: snapshot.speechAsset,
      speechAlignment: snapshot.speechAlignment
    });
  } catch (error) { return asError(error); }
});

server.registerTool("manage_voice_references", {
  title: "登记 VoiceReference",
  description: "将已就绪本地音频 Asset 作为 VoiceReference 登记；不会创建远端 Voice ID。",
  inputSchema: z.object({
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    asset_id: z.string().min(1),
    label: z.string().max(160).optional(),
    usage_note: z.string().max(500).optional()
  }).strict()
}, async ({ project_id, base_revision_id, asset_id, label, usage_note }) => {
  try {
    return asText(application.registerVoiceReference({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      assetId: asset_id,
      label,
      usageNote: usage_note
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_speech_timing", {
  title: "读取语音时序",
  description: "读取 SpeechTiming 的当前精度、段级范围和可选真实词级对齐摘要；没有对齐审计时不会描述成词级时序。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try {
    const snapshot = application.readProject(projectIdFrom(project_id)).snapshot;
    return asText(snapshot.speechAsset
      ? { scriptRevision: snapshot.speechAsset.scriptRevision, timing: snapshot.speechAsset.timing, speechAlignment: snapshot.speechAlignment }
      : { timing: undefined, speechAlignment: undefined, reason: "尚未组装 SpeechAsset" });
  } catch (error) { return asError(error); }
});

server.registerTool("submit_speech_alignment", {
  title: "提交真实词级强制对齐",
  description: "对当前 SpeechAsset 以明确 Bridge workflow 提交强制对齐。Worker 会动态读取 Schema、上传本地音频和当前 Script，只接收明确 JSON 时间戳；run_id 丢失时不会自动重复提交。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    workflow_id: z.string().min(1).max(240),
    speech_asset_id: z.string().min(1).optional(),
    output_slot_id: z.string().min(1).max(240).optional(),
    idempotency_key: z.string().min(1).max(240).optional()
  }
}, async (input) => {
  try {
    return asText(application.submitSpeechAlignment({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      workflowId: input.workflow_id,
      speechAssetId: input.speech_asset_id,
      outputSlotId: input.output_slot_id,
      idempotencyKey: input.idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_speech_alignment", {
  title: "读取真实词级对齐",
  description: "读取当前 Revision 绑定的词/字时间戳、SpeechAsset、Script Revision 和 Bridge 审计；没有结果时返回空，不把段级时间升级为词级。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try { return asText({ speechAlignment: application.readSpeechAlignment(projectIdFrom(project_id)) }); } catch (error) { return asError(error); }
});

server.registerTool("rebuild_speech_timeline", {
  title: "修复 SpeechAsset 时间线",
  description: "为旧 Revision 将已就绪 SpeechAsset 重新写入 Dialogue 轨并恢复稳定字幕；不重新调用 OmniVoice。",
  inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive() }
}, async ({ project_id, base_revision_id }) => {
  try {
    return asText(application.rebuildSpeechAssetTimeline({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("submit_speech_placement", {
  title: "按帧编排已生成旁白",
  description: "按 Script 顺序给全部已就绪 SpeechSegment 指定起始帧；可给 duration_frames 为末段后补静音，令总轨覆盖完整场景。媒体 Worker 复用段音频并插入静音，完成后在同一 Revision 更新 Dialogue 总轨、SpeechTiming 和字幕；不重新合成声音。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    placements: z.array(z.object({ speech_segment_id: z.string().min(1), start_frame: z.number().int().nonnegative() })).min(1),
    duration_frames: z.number().int().positive().optional(),
    idempotency_key: z.string().trim().min(1)
  }
}, async ({ project_id, base_revision_id, placements, duration_frames, idempotency_key }) => {
  try {
    return asText(application.submitSpeechPlacement({
      projectId: projectIdFrom(project_id), baseRevision: base_revision_id,
      placements: placements.map((placement) => ({ speechSegmentId: placement.speech_segment_id, startFrame: placement.start_frame })),
      durationFrames: duration_frames,
      idempotencyKey: idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("submit_voice_synthesis", {
  title: "提交段级声音合成",
  description: "按当前 SpeechSegment 文本调用 OmniVoice；省略参考参数时由服务端使用已配置的本地音色，不必向用户索要音频路径。指定 VoiceReference 时上传该参考覆盖默认音色。返回可跟踪 Job；默认音色工作流未配置时明确报错。",
  inputSchema: {
    project_id: z.string().optional(),
    voice_reference_id: z.string().min(1).optional(),
    voice_reference_asset_id: z.string().min(1).optional(),
    speech_segment_ids: z.array(z.string()).optional(),
    idempotency_key: z.string().optional()
  }
}, async ({ project_id, voice_reference_id, voice_reference_asset_id, speech_segment_ids, idempotency_key }) => {
  try {
    return asText(application.submitVoiceSynthesis({
      projectId: projectIdFrom(project_id),
      voiceReferenceId: voice_reference_id,
      voiceReferenceAssetId: voice_reference_asset_id,
      speechSegmentIds: speech_segment_ids,
      idempotencyKey: idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("submit_dialogue_processing", {
  title: "生成对白处理试听候选",
  description: "仅处理当前完整 SpeechAsset。必须先通过真实复听明确噪声、低频、齿音、响度或峰值问题并说明依据；Worker 生成原声、最小处理和强处理的对比候选，但不会自动替换当前 Dialogue。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    issue_types: z.array(z.enum(["noise", "low_frequency", "sibilance", "loudness", "true_peak"])).min(1).max(5),
    evidence_note: z.string().trim().min(1).max(2_000),
    idempotency_key: z.string().trim().min(1).max(240).optional()
  }
}, async ({ project_id, base_revision_id, issue_types, evidence_note, idempotency_key }) => {
  try {
    return asText(application.submitDialogueProcessing({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      issueTypes: issue_types,
      evidenceNote: evidence_note,
      idempotencyKey: idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("select_dialogue_processing_variant", {
  title: "选择当前对白处理候选",
  description: "在完整试听原声、最小处理和强处理版本后，显式选择要写入 Dialogue 轨的版本。此操作创建新 Revision，并会要求重新复核词级对齐和生成型人物口型。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    profile: z.enum(["original", "minimal", "strong"])
  }
}, async ({ project_id, base_revision_id, profile }) => {
  try {
    return asText(application.selectDialogueProcessingVariant({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      profile
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_captions", {
  title: "读取字幕卡",
  description: "读取最终 Caption Program、语音来源文字与其段级时序精度。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try {
    const snapshot = application.readProject(projectIdFrom(project_id)).snapshot;
    return asText(snapshot.timeline.captions);
  } catch (error) { return asError(error); }
});

server.registerTool("edit_captions", {
  title: "编辑稳定字幕卡",
  description: "可编辑当前 SpeechAsset 或已审计 source_audio Caption Card 的屏幕文案、显隐范围、静态位置和一个连续短语强调；bulk_source_format 可原子统一同一来源使用（sourceTimelineItemId）的明确 Card 集合。不会改 Script、音频、Card 边界或时间范围；chunk_coarse 原声字幕不能被伪拆分或重定时。occurrence 从 0 开始计数。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    caption_id: z.string().min(1).optional(),
    caption_ids: z.array(z.string().min(1)).min(1).max(200).optional(),
    action: z.enum(["update", "reset", "bulk_source_format"]),
    text: z.string().max(80).optional(),
    display: captionDisplaySchema.nullable().optional().describe("仅改变显示。shown 可指定本卡内的时间线绝对帧半开 ranges；hidden 隐藏整卡；null 恢复整卡显示。"),
    source_text_review: sourceCaptionTextReviewSchema.optional().describe("显示纠错依据：listening 实际回听（兼容仅 note）；confirmed_script 须提供 scriptRevision 和 speechSegmentIds 并核验当前配音关系；user_instruction 须提供 instruction 与 source。只改显示，不改变原音频或时间"),
    format: z.object({
      placement: captionPlacementSchema.nullable().optional(),
      font_size: z.number().int().min(16).max(72).optional(),
      font_weight: z.number().int().min(400).max(900).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").optional(),
      background_color: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").nullable().optional(),
      background_opacity: z.number().min(0.1).max(1).nullable().optional().describe("背景透明度0.1–1；取消背景使用background_color:null并省略本字段，不能传0"),
      bottom_percent: z.number().min(0).max(95).optional(),
      horizontal_inset_percent: z.number().min(0).max(45).optional(),
      text_align: z.enum(["left", "center", "right"]).optional()
    }).strict().optional(),
    emphasis: z.object({
      text: z.string().min(1).max(40),
      occurrence: z.number().int().nonnegative(),
      color: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").optional(),
      background_color: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").optional(),
      font_weight: z.number().int().min(400).max(900).optional(),
      scale: z.number().min(0.8).max(1.35).optional()
    }).strict().nullable().optional()
  }
}, async ({ project_id, base_revision_id, caption_id, caption_ids, action, text, format, emphasis, source_text_review, display }) => {
  try {
    return asText(application.editCaptions({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      captionId: caption_id,
      captionIds: caption_ids,
      sourceTextReview: source_text_review,
      display,
      action,
      text,
      format: format === undefined ? undefined : {
        placement: format.placement,
        fontSize: format.font_size,
        fontWeight: format.font_weight,
        color: format.color,
        backgroundColor: format.background_color,
        backgroundOpacity: format.background_opacity,
        bottomPercent: format.bottom_percent,
        horizontalInsetPercent: format.horizontal_inset_percent,
        textAlign: format.text_align
      },
      emphasis: emphasis === undefined || emphasis === null ? emphasis : {
        text: emphasis.text,
        occurrence: emphasis.occurrence,
        color: emphasis.color,
        backgroundColor: emphasis.background_color,
        fontWeight: emphasis.font_weight,
        scale: emphasis.scale
      }
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("manage_audio", {
  title: "管理 BGM 与 SFX",
  description: "将已就绪的本地音频作为 BGM 或 SFX 写入专用轨。BGM 支持有限淡入淡出、循环和 Dialogue Duck。SFX 的 event_frame 是计划同步的事件，onset_offset_frames 是所选源范围内的偏移；检测候选或尚未复听时用 onset_review.status=inconclusive（缺省也是待审）并说明依据，允许草稿混合但阻挡交付。只有实际复听所选原文件范围后才能写 confirmed，仍不代表成片混合声画通过。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "remove"]),
    audio_cue_id: z.string().min(1).optional(),
    kind: z.enum(["bgm", "sfx"]).optional(),
    design: audioDesignSchema.optional(),
    asset_id: z.string().min(1).optional(),
    purpose: z.string().max(800).optional(),
    start_frame: z.number().int().nonnegative().optional(),
    end_frame: z.number().int().positive().optional(),
    source_start_frame: z.number().int().nonnegative().optional(),
    source_end_frame: z.number().int().positive().optional(),
    loop: z.boolean().optional(),
    gain_db: z.number().min(-48).max(12).optional(),
    fade_in_frames: z.number().int().min(0).max(480).optional(),
    fade_out_frames: z.number().int().min(0).max(480).optional(),
    event_frame: z.number().int().nonnegative().optional(),
    onset_offset_frames: z.number().int().nonnegative().optional(),
    onset_review: z.object({ status: z.enum(["confirmed", "inconclusive"]), note: z.string().min(16).max(2400) }).strict().optional(),
    effect_event: z.object({
      effect_cue_id: z.string().min(1),
      event_name: z.string().trim().min(1).max(160),
      local_frame: z.number().int().nonnegative(),
      end_local_frame: z.number().int().positive().optional(),
      event_id: z.string().optional(),
      work_version: z.string().optional(),
      sync_offset_frames: z.number().int().optional()
    }).strict().nullable().optional(),
    ducking: z.object({
      enabled: z.boolean().optional(),
      reduction_db: z.number().min(-36).max(-1).optional(),
      attack_frames: z.number().int().min(0).max(240).optional(),
      release_frames: z.number().int().min(0).max(240).optional(),
      hold_frames: z.number().int().min(0).max(240).optional()
    }).strict().optional()
  }
}, async (input) => {
  try {
    return asText(application.manageAudio({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      action: input.action,
      audioCueId: input.audio_cue_id,
      kind: input.kind,
      design: input.design,
      assetId: input.asset_id,
      purpose: input.purpose,
      startFrame: input.start_frame,
      endFrame: input.end_frame,
      sourceStartFrame: input.source_start_frame,
      sourceEndFrame: input.source_end_frame,
      loop: input.loop,
      gainDb: input.gain_db,
      fadeInFrames: input.fade_in_frames,
      fadeOutFrames: input.fade_out_frames,
      eventFrame: input.event_frame,
      onsetOffsetFrames: input.onset_offset_frames,
      onsetReview: input.onset_review,
      effectEvent: input.effect_event === null ? null : input.effect_event ? {
        effectCueId: input.effect_event.effect_cue_id,
        eventName: input.effect_event.event_name,
        localFrame: input.effect_event.local_frame,
        endLocalFrame: input.effect_event.end_local_frame,
        eventId: input.effect_event.event_id,
        workVersion: input.effect_event.work_version,
        syncOffsetFrames: input.effect_event.sync_offset_frames
      } : undefined,
      ducking: input.ducking === undefined ? undefined : {
        enabled: input.ducking.enabled,
        reductionDb: input.ducking.reduction_db,
        attackFrames: input.ducking.attack_frames,
        releaseFrames: input.ducking.release_frames,
        holdFrames: input.ducking.hold_frames
      }
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("assemble_presenter_track", {
  title: "组装 Presenter A-roll",
  description: "仅将明确选择的已就绪视频拼接到 Actor / A-roll 轨；不会按素材数量猜测叙事 Scene。",
  inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), asset_ids: z.array(z.string()).min(1) }
}, async ({ project_id, base_revision_id, asset_ids }) => {
  try { return asText(application.assemblePresenterTrack({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, assetIds: asset_ids })); } catch (error) { return asError(error); }
});

server.registerTool("edit_presenter_source", {
  title: "裁剪原声人物片段",
  description: "对既有无Mask、use_source_audio导入人物Item按明确保留源区间原子裁剪/拆分，原视频与原声同步；源帧统一使用项目FPS，范围有序且不重叠，空列表仅可删除非最后一条主画面。自动前移后续主轨及准确字幕，保留字幕版式与Provider时间证据；切口跨字幕卡会拒绝，须先按真实token分卡，不能按字数估时。与切口相交的效果、受影响Cutaway/BGM/SFX会标stale待复核，不生成媒体或隐式Job。先审阅源片、记录理由；有未终态Job/锁定轨道/独立Dialogue时拒绝。写后读回Impact并真实预览复听。",
  inputSchema: {
    project_id: z.string().optional(), base_revision_id: z.number().int().positive(), timeline_item_id: z.string(),
    keep_ranges: z.array(z.object({ source_start_frame: z.number().int().nonnegative(), source_end_frame: z.number().int().positive() }).strict()).max(160),
    reason: z.string().trim().min(1).max(2000)
  }
}, async (input) => {
  try { return asText(application.editPresenterSource({ projectId: projectIdFrom(input.project_id), baseRevision: input.base_revision_id,
    timelineItemId: input.timeline_item_id, reason: input.reason,
    keepRanges: input.keep_ranges.map((range) => ({ sourceStartFrame: range.source_start_frame, sourceEndFrame: range.source_end_frame })) })); }
  catch (error) { return asError(error); }
});

server.registerTool("compile_presenter_scenes", {
  title: "编译 Presenter 叙事场景",
  description: "将已建立的 Story Beat、语义判断与视觉方案编译为 PresenterScene；每个 A-roll Item 都必须被明确的 Scene 覆盖。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    scenes: z.array(z.object({
      title: z.string().min(1).max(160),
      purpose: z.string().min(1).max(800),
      start_frame: z.number().int().min(0),
      end_frame: z.number().int().positive(),
      narrative_beat_ids: z.array(z.string()).optional(),
      style_pack_id: z.string().max(160).optional()
    })).min(1).max(80)
  }
}, async (input) => {
  try {
    return asText(application.compilePresenterScenes({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      scenes: input.scenes.map((scene) => ({
        title: scene.title,
        purpose: scene.purpose,
        startFrame: scene.start_frame,
        endFrame: scene.end_frame,
        narrativeBeatIds: scene.narrative_beat_ids,
        stylePackId: scene.style_pack_id
      }))
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("create_presenter_timeline", {
  title: "兼容创建 Presenter 主线",
  description: "旧客户端兼容入口：会按素材数量临时分组。正式创作请依次使用 assemble_presenter_track 与 compile_presenter_scenes。",
  inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), asset_ids: z.array(z.string()).min(1), scene_size: z.number().int().min(1).max(8).optional() }
}, async ({ project_id, base_revision_id, asset_ids, scene_size }) => {
  try { return asText(application.buildPresenterTimeline({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, assetIds: asset_ids, sceneSize: scene_size })); } catch (error) { return asError(error); }
});

server.registerTool("align_presenter_to_speech", {
  title: "按旁白收齐 Presenter 主线",
  description: "将未被 direct_override 保护的 Presenter 主画面裁短到当前 SpeechAsset；遇到缺画面或既有 Cue 时明确拒绝自动改写。",
  inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive() }
}, async ({ project_id, base_revision_id }) => {
  try {
    return asText(application.alignPresenterToSpeech({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_narrative_map", {
  title: "读取视觉解释 NarrativeMap",
  description: "读取当前 Revision 的观众问题、知识状态、递进问题与证据交接；它不另建一份 Story。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try { return asText(application.readNarrativeMap({ projectId: projectIdFrom(project_id) })); } catch (error) { return asError(error); }
});

server.registerTool("manage_narrative_map", {
  title: "管理视觉解释 NarrativeMap",
  description: "将既有 Story Beat 映射为观众已知信息、当前问题、新理解和延迟披露。变更会让依赖该拍的 Explainer Program 明确失效，而不会静默沿用旧画面。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    viewer_question: z.string().min(1).max(800),
    promised_model: z.string().min(1).max(1_200),
    conclusion: z.string().min(1).max(1_200),
    beats: z.array(z.object({
      narrative_beat_id: z.string().min(1),
      entering_knowledge: z.string().min(1).max(1_200),
      question: z.string().min(1).max(1_200),
      new_knowledge: z.string().min(1).max(1_200),
      deferred_information: z.string().min(1).max(1_200),
      claim: z.string().min(1).max(1_200).optional(),
      evidence_capture_ids: z.array(z.string().min(1)).max(40).optional(),
      scene_ids: z.array(z.string().min(1)).max(40).optional()
    }).strict()).min(1).max(80)
  }
}, async (input) => {
  try {
    return asText(application.manageNarrativeMap({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      viewerQuestion: input.viewer_question,
      promisedModel: input.promised_model,
      conclusion: input.conclusion,
      beats: input.beats.map((beat) => ({
        narrativeBeatId: beat.narrative_beat_id,
        enteringKnowledge: beat.entering_knowledge,
        question: beat.question,
        newKnowledge: beat.new_knowledge,
        deferredInformation: beat.deferred_information,
        claim: beat.claim,
        evidenceCaptureIds: beat.evidence_capture_ids,
        sceneIds: beat.scene_ids
      }))
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_evidence_capture", {
  title: "读取证据快照",
  description: "读取已本地化真实来源、页面快照、原文摘录、适用限制和归一化高亮；不会把生成图或网页标题当成证据。",
  inputSchema: { project_id: z.string().optional(), evidence_capture_id: z.string().min(1).optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id, evidence_capture_id }) => {
  try { return asText(application.readEvidenceCapture({ projectId: projectIdFrom(project_id), evidenceCaptureId: evidence_capture_id })); } catch (error) { return asError(error); }
});

server.registerTool("manage_evidence_capture", {
  title: "管理证据快照与页面高亮",
  description: "登记或更新真实来源 Asset、非生成页面截图、原文摘录、主张、限制和页面高亮。create 必须提供 source_asset_id、source_title、source_url、excerpt、claim、limitation 和1到12个 highlights；update/remove 必须提供 evidence_capture_id，update 省略字段会保留原值，remove 无需 highlights。高亮按 snapshot_asset_id 对应页面快照的完整宽高归一化；未指定快照时使用 source_asset_id 页面。x/y为左上角，width/height为框大小，均为0到1比例而非像素，宽高必须大于0，x+width<=1且y+height<=1。更新会让依赖证据的 Explainer Scene 失效，待重新编译和预览。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "remove"]),
    evidence_capture_id: z.string().min(1).optional(),
    source_asset_id: z.string().min(1).optional(),
    snapshot_asset_id: z.string().min(1).optional(),
    source_title: z.string().min(1).max(800).optional(),
    publisher: z.string().min(1).max(400).optional(),
    source_url: z.string().url().max(2_000).optional(),
    captured_at: z.string().datetime({ offset: true }).optional(),
    page_or_range: z.string().min(1).max(500).optional(),
    excerpt: z.string().min(1).max(8_000).optional(),
    claim: z.string().min(1).max(2_000).optional(),
    limitation: z.string().min(1).max(2_000).optional(),
    highlights: z.array(evidenceHighlightSchema).min(1).max(12).optional().describe("create必填1到12个框；update省略时保留现有框，提供时替换全部框；remove无需提供。坐标相对完整页面快照宽高归一化，不包含播放器留白或画布尺寸。")
  }
}, async (input) => {
  try {
    return asText(application.manageEvidenceCapture({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      action: input.action,
      evidenceCaptureId: input.evidence_capture_id,
      sourceAssetId: input.source_asset_id,
      snapshotAssetId: input.snapshot_asset_id,
      sourceTitle: input.source_title,
      publisher: input.publisher,
      sourceUrl: input.source_url,
      capturedAt: input.captured_at,
      pageOrRange: input.page_or_range,
      excerpt: input.excerpt,
      claim: input.claim,
      limitation: input.limitation,
      highlights: input.highlights
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_explainer_scene_programs", {
  title: "读取 Explainer Scene Program",
  description: "读取当前 Revision 中已编译的场景视觉语法、局部状态、素材与缓存键；只读且不把 Program 当成第二份 Timeline。",
  inputSchema: { project_id: z.string().optional(), scene_id: z.string().min(1).optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id, scene_id }) => {
  try { return asText(application.readExplainerScenePrograms({ projectId: projectIdFrom(project_id), sceneId: scene_id })); } catch (error) { return asError(error); }
});

server.registerTool("set_explainer_program_enabled", {
  title: "局部启停场景主视觉",
  description: "只启停指定 ExplainerProgram 的渲染；保留宿主 Scene 语义、ManagedMotion Cue、字幕、音效和素材。不会修复 stale，不会整批重编。停用后需预览检查替代画面及真实退出。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    program_id: z.string().min(1),
    enabled: z.boolean()
  }
}, async (input) => {
  try {
    return asText(application.setExplainerProgramEnabled({
      projectId: projectIdFrom(input.project_id), baseRevision: input.base_revision_id,
      programId: input.program_id, enabled: input.enabled
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("compile_explainer_scenes", {
  title: "编译视觉解释场景",
  description: "将 NarrativeMap Beat 原子编译为带内置主视觉的 ExplainerScene、Program 与 VisualTreatment。按 kind 提供该分支必需的 props 与真实素材，每个场景需四阶段连续局部状态。原创 ManagedMotion 独立承担主视觉时，可用 create_scene 建立基础 ExplainerScene 再放置作品，无需先编译随后停用内置 Program；承载 Scene 必须包含完整作品范围，多 Beat 覆盖声明不允许 Cue 跨 Scene 边界。失败先检查 isError 并保留完整 text；业务错误返回 JSON code/message，协议参数错误可能是文本。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    plans: z.array(explainerPlanWithContent({
      title: z.string().min(1).max(160),
      purpose: z.string().min(1).max(1_200),
      start_frame: z.number().int().nonnegative(),
      end_frame: z.number().int().positive(),
      narrative_map_beat_id: z.string().min(1),
      primary_task: z.string().min(1).max(1_200),
      asset_ids: z.array(z.string().min(1)).max(60).optional(),
      evidence_capture_id: z.string().min(1).optional(),
      states: z.array(explainerStateSchema).min(4).max(12),
      style_pack_id: z.string().min(1).max(160).optional(),
      visual_treatment: explainerVisualTreatmentSchema.optional()
    }).refine((plan) => plan.end_frame > plan.start_frame, {
      message: "Explainer 场景结束帧必须大于开始帧"
    })).min(1).max(80)
  }
}, async (input) => {
  try {
    return asText(application.compileExplainerScenes({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      plans: input.plans.map((plan) => ({
        title: plan.title,
        purpose: plan.purpose,
        startFrame: plan.start_frame,
        endFrame: plan.end_frame,
        narrativeMapBeatId: plan.narrative_map_beat_id,
        kind: plan.kind,
        primaryTask: plan.primary_task,
        assetIds: plan.asset_ids,
        evidenceCaptureId: plan.evidence_capture_id,
        states: plan.states.map((state) => ({
          id: state.id,
          phase: state.phase,
          startFrame: state.start_frame,
          endFrame: state.end_frame,
          label: state.label,
          detail: state.detail
        })),
        props: plan.props,
        stylePackId: plan.style_pack_id,
        visualTreatment: plan.visual_treatment ? {
          mode: plan.visual_treatment.mode,
          intensity: plan.visual_treatment.intensity,
          primaryAttention: plan.visual_treatment.primary_attention,
          narrativePurpose: plan.visual_treatment.narrative_purpose,
          quietReason: plan.visual_treatment.quiet_reason,
          fallbackPlan: plan.visual_treatment.fallback_plan
        } : undefined
      }))
    }));
  } catch (error) { return { ...asText({ code: error instanceof DomainError ? error.code : "EXPLAINER_COMPILE_FAILED", message: error instanceof Error ? error.message : String(error) }), isError: true }; }
});

server.registerTool("read_vlog_plan", {
  title: "读取 Vlog 剪辑计划",
  description: "读取当前 Revision 的镜头边界证据、Event Map、Shot Select、环境声和人工确认的音乐拍点；不会把技术边界解释成事件或自动剪辑。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try { return asText(application.readVlogPlan(projectIdFrom(project_id))); } catch (error) { return asError(error); }
});

server.registerTool("submit_vlog_analysis", {
  title: "提交 Vlog 镜头边界分析",
  description: "对已完成媒体分析的实拍视频执行 FFmpeg 场景变化检测，回传源范围、变化分数与音轨事实。它不会推断人物动作、事件意义，也不会自动选择或剪辑镜头。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    asset_ids: z.array(z.string().min(1)).min(1).max(120),
    scene_threshold: z.number().min(0.05).max(0.9).optional(),
    idempotency_key: z.string().min(1).max(240).optional()
  }
}, async ({ project_id, base_revision_id, asset_ids, scene_threshold, idempotency_key }) => {
  try {
    return asText(application.submitVlogAnalysis({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      assetIds: asset_ids,
      sceneThreshold: scene_threshold,
      idempotencyKey: idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("manage_vlog_events", {
  title: "管理 Vlog 事件地图",
  description: "将已分析的真实 Shot 组织为导演确认的 Event Map。目标、行动、变化、结果和反应都需要明确写入，系统不会按文件名、画质或镜头数量猜故事。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "remove"]),
    event_id: z.string().min(1).optional(),
    order: z.number().int().nonnegative().optional(),
    title: z.string().min(1).max(160).optional(),
    summary: z.string().min(1).max(2_000).optional(),
    shot_analysis_ids: z.array(z.string().min(1)).min(1).max(300).optional(),
    goal: z.string().max(800).optional(),
    action_note: z.string().max(800).optional(),
    change: z.string().max(800).optional(),
    reaction: z.string().max(800).optional(),
    outcome: z.string().max(800).optional(),
    location_note: z.string().max(800).optional(),
    continuity_note: z.string().max(1_200).optional(),
    status: z.enum(["draft", "ready"]).optional()
  }
}, async (input) => {
  try {
    return asText(application.manageVlogEvents({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      action: input.action,
      eventId: input.event_id,
      order: input.order,
      title: input.title,
      summary: input.summary,
      shotAnalysisIds: input.shot_analysis_ids,
      goal: input.goal,
      actionNote: input.action_note,
      change: input.change,
      reaction: input.reaction,
      outcome: input.outcome,
      locationNote: input.location_note,
      continuityNote: input.continuity_note,
      status: input.status
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("manage_vlog_shot_selects", {
  title: "管理 Vlog Shot Select",
  description: "从 Event Map 的真实镜头边界中明确选择主线素材、镜头功能、连续性理由和原始现场声策略；不会因技术分数高就自动入选。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "remove"]),
    shot_select_id: z.string().min(1).optional(),
    event_id: z.string().min(1).optional(),
    shot_analysis_id: z.string().min(1).optional(),
    order: z.number().int().nonnegative().optional(),
    source_start_frame: z.number().int().nonnegative().optional(),
    source_end_frame: z.number().int().positive().optional(),
    function: z.enum(["establish", "action", "detail", "reaction", "transition", "atmosphere"]).optional(),
    selection_reason: z.string().max(1_200).optional(),
    continuity_note: z.string().max(1_200).optional(),
    source_audio_mode: z.enum(["keep", "mute"]).optional(),
    status: z.enum(["planned", "ready"]).optional()
  }
}, async (input) => {
  try {
    return asText(application.manageVlogShotSelects({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      action: input.action,
      shotSelectId: input.shot_select_id,
      eventId: input.event_id,
      shotAnalysisId: input.shot_analysis_id,
      order: input.order,
      sourceStartFrame: input.source_start_frame,
      sourceEndFrame: input.source_end_frame,
      function: input.function,
      selectionReason: input.selection_reason,
      continuityNote: input.continuity_note,
      sourceAudioMode: input.source_audio_mode,
      status: input.status
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("compile_vlog_montage", {
  title: "编译 Vlog Montage 主线",
  description: "将导演已确认的 Shot Select 按 Event 与 Select 顺序编译到 Background 和 Ambient 轨。视频层会静音，只有明确 keep 的现场声才会在独立 Ambient 轨播放；不会自动变速或按音乐拍点改剪。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    shot_select_ids: z.array(z.string().min(1)).min(1).max(300),
    start_frame: z.number().int().nonnegative().optional(),
    title_prefix: z.string().min(1).max(120).optional()
  }
}, async ({ project_id, base_revision_id, shot_select_ids, start_frame, title_prefix }) => {
  try {
    return asText(application.compileVlogMontage({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      shotSelectIds: shot_select_ids,
      startFrame: start_frame,
      titlePrefix: title_prefix
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("manage_vlog_music_beats", {
  title: "管理 Vlog 人工音乐拍点",
  description: "记录已由人试听确认的 BGM 拍点，供导演参考切点。拍点不会自动移动镜头，也不能代替动作、空间、声音和事件变化。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "remove"]),
    beat_id: z.string().min(1).optional(),
    audio_cue_id: z.string().min(1).optional(),
    frame: z.number().int().nonnegative().optional(),
    note: z.string().max(1_000).optional()
  }
}, async ({ project_id, base_revision_id, action, beat_id, audio_cue_id, frame, note }) => {
  try {
    return asText(application.manageVlogMusicBeats({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      action,
      beatId: beat_id,
      audioCueId: audio_cue_id,
      frame,
      note
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_multicam_plan", {
  title: "读取多机位同步与切换计划",
  description: "读取同步 Group、每个机位的结构化证据、候选/确认状态及平铺 Cut。自动相关只是 candidate，不能据此假装已经可剪。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try { return asText(application.readMulticamPlan(projectIdFrom(project_id))); } catch (error) { return asError(error); }
});

server.registerTool("submit_multicam_sync", {
  title: "提交多机位音频同步",
  description: "使用输入机位的共同可解码音轨搜索固定偏移，只生成同步候选。机位名称必须显式提供；不会从文件名、creation_time 或画面相似性推断 A/B/C。当前首版只支持相机内录，不支持独立录音机。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    title: z.string().min(1).max(160).optional(),
    asset_ids: z.array(z.string().min(1)).min(2).max(24),
    angle_labels: z.record(z.string().min(1).max(80)),
    reference_asset_id: z.string().min(1).optional(),
    master_audio_asset_id: z.string().min(1).optional(),
    source_ranges: z.record(z.object({
      start_frame: z.number().int().nonnegative(),
      end_frame: z.number().int().positive()
    }).strict().refine((range) => range.end_frame > range.start_frame, {
      message: "同步源区间的结束帧必须大于开始帧"
    })).optional(),
    max_search_seconds: z.number().int().min(20).max(1_800).optional(),
    idempotency_key: z.string().min(1).max(240).optional()
  }
}, async (input) => {
  try {
    return asText(application.submitMulticamSync({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      title: input.title,
      assetIds: input.asset_ids,
      angleLabels: input.angle_labels,
      referenceAssetId: input.reference_asset_id,
      masterAudioAssetId: input.master_audio_asset_id,
      sourceRanges: input.source_ranges && Object.fromEntries(Object.entries(input.source_ranges).map(([assetId, range]) => [assetId, {
        startFrame: range.start_frame,
        endFrame: range.end_frame
      }])),
      maxSearchSeconds: input.max_search_seconds,
      idempotencyKey: input.idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("create_manual_multicam_group", {
  title: "建立人工多机位同步",
  description: "在所有机位标记同一个拍手、落物或明确动作帧后建立已确认同步 Group。没有共同音轨或自动候选不可信时使用；不允许用文件日期、估算时长或猜测偏移替代同一事件。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    title: z.string().min(1).max(160),
    reference_asset_id: z.string().min(1),
    master_audio_asset_id: z.string().min(1),
    markers: z.array(multicamMarkerSchema).min(2).max(24)
  }
}, async (input) => {
  try {
    return asText(application.createManualMulticamGroup({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      title: input.title,
      referenceAssetId: input.reference_asset_id,
      masterAudioAssetId: input.master_audio_asset_id,
      markers: input.markers.map((marker) => ({
        assetId: marker.asset_id,
        label: marker.label,
        sourceFrame: marker.source_frame,
        note: marker.note
      }))
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("verify_multicam_group", {
  title: "确认多机位同步预览",
  description: "只可确认已由所属同步 Job 生成并绑定受管并排 Preview 的自动 candidate。在该 Preview 的真实连续播放中核对口型、动作和现场声，并将明确人工核对说明写入 preview_evidence 后才标为 verified；缺少受管 Preview 或说明不能开始切机位。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    group_id: z.string().min(1),
    preview_evidence: z.string().min(1).max(2_000)
  }
}, async ({ project_id, base_revision_id, group_id, preview_evidence }) => {
  try { return asText(application.verifyMulticamGroup({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, groupId: group_id, previewEvidence: preview_evidence })); } catch (error) { return asError(error); }
});

server.registerTool("manage_multicam_cuts", {
  title: "管理多机位切换",
  description: "只在已确认 Group 的同步会话坐标中选择主画面机位、范围和连续性理由。源帧范围由同步偏移计算，不能绕过证据直接猜时间；首版不支持速度补偿。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "remove"]),
    group_id: z.string().min(1).optional(),
    cut_id: z.string().min(1).optional(),
    order: z.number().int().nonnegative().optional(),
    angle_asset_id: z.string().min(1).optional(),
    session_start_frame: z.number().int().nonnegative().optional(),
    session_end_frame: z.number().int().positive().optional(),
    reason: z.string().min(1).max(1_200).optional(),
    continuity_note: z.string().min(1).max(1_200).optional()
  }
}, async (input) => {
  try {
    return asText(application.manageMulticamCuts({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      action: input.action,
      groupId: input.group_id,
      cutId: input.cut_id,
      order: input.order,
      angleAssetId: input.angle_asset_id,
      sessionStartFrame: input.session_start_frame,
      sessionEndFrame: input.session_end_frame,
      reason: input.reason,
      continuityNote: input.continuity_note
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("compile_multicam_program", {
  title: "编译多机位主线",
  description: "把同一已确认 Group 的连续 Cut 平铺到 Background，并从唯一 master audio 机位写入一条 Ambient。所有画面源声会静音；不同 Group、同步候选、会话空档和重叠都会被拒绝。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    group_id: z.string().min(1),
    cut_ids: z.array(z.string().min(1)).min(1).max(300),
    start_frame: z.number().int().nonnegative().optional(),
    title_prefix: z.string().min(1).max(120).optional()
  }
}, async ({ project_id, base_revision_id, group_id, cut_ids, start_frame, title_prefix }) => {
  try { return asText(application.compileMulticamProgram({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, groupId: group_id, cutIds: cut_ids, startFrame: start_frame, titlePrefix: title_prefix })); } catch (error) { return asError(error); }
});

server.registerTool("submit_music_generation", {
  title: "提交受控音乐生成",
  description: "用明确的 Bridge workflow、提示词和精确时长提交音乐生成。Worker 会动态读取 Schema、核验音频输出并保存审计；结果需按实际内容采用。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    workflow_id: z.string().min(1).max(240),
    prompt: z.string().min(1).max(4_000),
    duration_seconds: z.number().int().min(1).max(1_800),
    output_slot_id: z.string().min(1).max(240).optional(),
    idempotency_key: z.string().min(1).max(240).optional()
  }
}, async (input) => {
  try {
    return asText(application.submitMusicGeneration({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      workflowId: input.workflow_id,
      prompt: input.prompt,
      durationSeconds: input.duration_seconds,
      outputSlotId: input.output_slot_id,
      idempotencyKey: input.idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("submit_video_generation", {
  title: "提交受控视频生成",
  description: "提交文生、图生、首尾帧或多参考 MiniMax 视频生成。Worker 会动态读取 Bridge Schema、校验受管输入、下载并验证输出；生成结果不自动进入 Timeline。证据类 AssetRequest 不允许用生成画面替代。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    workflow_id: z.string().min(1).max(240),
    mode: z.enum(["text_to_video", "image_to_video", "first_last_frame", "multi_reference"]),
    input_asset_ids: z.array(z.string().min(1)).max(10).optional(),
    prompt: z.string().trim().min(1).max(4_000),
    duration_seconds: z.number().int().min(1).max(1_800),
    aspect_ratio: z.enum(["9:16", "16:9", "1:1"]).optional(),
    output_slot_id: z.string().min(1).max(240).optional(),
    seed: z.number().int().nonnegative().optional(),
    megapixels: z.number().min(0.1).max(16).optional(),
    initial_seed: z.number().int().nonnegative().optional(),
    final_seed: z.number().int().nonnegative().optional(),
    initial_megapixels: z.number().min(0.1).max(16).optional(),
    final_megapixels: z.number().min(0.1).max(16).optional(),
    asset_request_id: z.string().min(1).optional(),
    idempotency_key: z.string().min(1).max(240).optional()
  }
}, async (input) => {
  try {
    return asText(application.submitVideoGeneration({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      workflowId: input.workflow_id,
      mode: input.mode,
      inputAssetIds: input.input_asset_ids,
      prompt: input.prompt,
      durationSeconds: input.duration_seconds,
      aspectRatio: input.aspect_ratio,
      outputSlotId: input.output_slot_id,
      seed: input.seed,
      megapixels: input.megapixels,
      initialSeed: input.initial_seed,
      finalSeed: input.final_seed,
      initialMegapixels: input.initial_megapixels,
      finalMegapixels: input.final_megapixels,
      assetRequestId: input.asset_request_id,
      idempotencyKey: input.idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_actor_performances", {
  title: "读取人物表演",
  description: "读取绑定 Timeline Item 的导入/生成型人物表演、Mask、声音所有权与版本关系。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try {
    const snapshot = application.readProject(projectIdFrom(project_id)).snapshot;
    return asText(snapshot.actorPerformances);
  } catch (error) { return asError(error); }
});

server.registerTool("read_actor_capabilities", {
  title: "读取人物能力档案",
  description: "读取当前项目中已登记的数字人 Provider、输入、Mask、音频驱动口型、局部重生成和隐私信息；参考音频输入本身不等于已验证口型同步，实际提交前仍会读取 Provider 的最新 Schema。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try { return asText(application.listActorCapabilityProfiles(projectIdFrom(project_id))); } catch (error) { return asError(error); }
});

server.registerTool("manage_actor_capabilities", {
  title: "管理人物能力档案",
  description: "创建、更新或移除项目内的 ActorCapabilityProfile。档案只记录已确认能力；上传音频不自动代表口型同步，也不会把静态布局或生成结果伪装成姿态追踪。",
  inputSchema: z.object({
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "remove"]),
    profile_id: z.string().optional(),
    provider: z.literal("minimax_h3_multi_reference").optional(),
    label: z.string().min(1).max(120).optional(),
    workflow_id: z.string().min(1).max(200).optional(),
    input_modes: z.array(z.enum(["audio", "text"])).min(1).max(2).optional(),
    mask_modes: z.array(z.enum(["alpha_asset", "embedded_alpha", "none"])).min(1).max(3).optional(),
    supports_reference_image: z.boolean().optional(),
    supports_reference_video: z.boolean().optional(),
    supports_audio_driven_lip_sync: z.boolean().optional(),
    supports_gaze_control: z.boolean().optional(),
    supports_gesture_control: z.boolean().optional(),
    supports_partial_regeneration: z.boolean().optional(),
    max_duration_seconds: z.number().int().min(1).max(1800).optional(),
    privacy_note: z.string().min(1).max(2000).optional()
  }).strict()
}, async (input) => {
  try {
    return asText(application.manageActorCapabilityProfile({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      action: input.action,
      profileId: input.profile_id,
      provider: input.provider,
      label: input.label,
      workflowId: input.workflow_id,
      inputModes: input.input_modes,
      maskModes: input.mask_modes,
      supportsReferenceImage: input.supports_reference_image,
      supportsReferenceVideo: input.supports_reference_video,
      supportsAudioDrivenLipSync: input.supports_audio_driven_lip_sync,
      supportsGazeControl: input.supports_gaze_control,
      supportsGestureControl: input.supports_gesture_control,
      supportsPartialRegeneration: input.supports_partial_regeneration,
      maxDurationSeconds: input.max_duration_seconds,
      privacyNote: input.privacy_note
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("manage_actor_performance", {
  title: "登记人物表演与 Mask",
  description: "将 Actor / A-roll Item 绑定为人物表演，并明确原声、Dialogue 或静音的声音所有权；无 Mask 时显式使用前景降级。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    timeline_item_id: z.string().min(1),
    source: z.enum(["imported", "generated"]),
    mask_mode: z.enum(["alpha_asset", "embedded_alpha", "none"]),
    audio_mode: z.enum(["use_source_audio", "use_dialogue_track", "muted"]).optional(),
    mask_asset_id: z.string().optional(),
    speech_asset_id: z.string().optional(),
    capability_profile_id: z.string().optional(),
    layout: actorLayoutSchema.optional(),
    note: z.string().max(500).optional()
  }
}, async (input) => {
  try {
    return asText(application.registerActorPerformance({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      timelineItemId: input.timeline_item_id,
      source: input.source,
      maskMode: input.mask_mode,
      audioMode: input.audio_mode,
      maskAssetId: input.mask_asset_id,
      speechAssetId: input.speech_asset_id,
      capabilityProfileId: input.capability_profile_id,
      layout: input.layout ? {
        actorHead: input.layout.actor_head,
        actorHands: input.layout.actor_hands
      } : undefined,
      note: input.note
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("submit_avatar_job", {
  title: "提交数字人生成人物",
  description: "使用当前 SpeechAsset 与已登记的能力档案提交 MiniMax H3 多参考人物生成。提交会固定 base_revision_id；Worker 在实际调用前动态读取 Bridge Schema，不接受或承诺逐帧姿态、目光、手势追踪。当前生成结果仅支持无 Mask 的前景降级，人物声音只能由 Dialogue 或静音承担。完成后用 track_job 和 read_actor_performances 读回。",
  inputSchema: z.object({
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    capability_profile_id: z.string().min(1),
    // 当前已验证的 MiniMax 路径只接受一张本地化人物参考图，不把参考视频能力提前暴露为可用。
    reference_image_asset_id: z.string().min(1),
    speech_asset_id: z.string().min(1).optional(),
    replace_actor_performance_id: z.string().min(1).optional(),
    generation_range: actorGenerationRangeSchema,
    placement: actorPlacementSchema,
    prompt: z.string().trim().min(1).max(4_000).optional(),
    mask_mode: z.literal("none").optional(),
    audio_mode: z.enum(["use_dialogue_track", "muted"]).optional(),
    layout: actorLayoutSchema.optional(),
    note: z.string().trim().max(1_000).optional(),
    idempotency_key: z.string().trim().min(1).max(240).optional()
  }).strict()
}, async (input) => {
  try {
    return asText(application.submitAvatarGeneration({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      capabilityProfileId: input.capability_profile_id,
      referenceImageAssetId: input.reference_image_asset_id,
      speechAssetId: input.speech_asset_id,
      replaceActorPerformanceId: input.replace_actor_performance_id,
      generationRange: {
        startFrame: input.generation_range.start_frame,
        endFrame: input.generation_range.end_frame,
        speechSegmentIds: input.generation_range.speech_segment_ids
      },
      placement: {
        sceneId: input.placement.scene_id,
        startFrame: input.placement.start_frame,
        endFrame: input.placement.end_frame
      },
      prompt: input.prompt,
      maskMode: input.mask_mode,
      audioMode: input.audio_mode,
      layout: input.layout ? {
        actorHead: input.layout.actor_head,
        actorHands: input.layout.actor_hands
      } : undefined,
      note: input.note,
      idempotencyKey: input.idempotency_key
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("browse_scene_types", {
  title: "浏览场景类型",
  description: "读取当前第一版可创建的统一 Scene 类型。",
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, async () => asText(["PresenterScene", "ExplainerScene", "VlogMontageScene", "CutawayScene", "EndCardScene"]));

server.registerTool("create_scene", {
  title: "创建场景",
  description: "基于明确时间范围创建 Scene，并通过 Revision 原子提交。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    type: z.enum(["PresenterScene", "ExplainerScene", "VlogMontageScene", "CutawayScene", "EndCardScene"]),
    title: z.string().min(1),
    purpose: z.string().min(1),
    start_frame: z.number().int().nonnegative(),
    end_frame: z.number().int().positive(),
    asset_ids: z.array(z.string()).optional()
  }
}, async (input) => {
  try {
    return asText(application.createScene({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      type: input.type,
      title: input.title,
      purpose: input.purpose,
      startFrame: input.start_frame,
      endFrame: input.end_frame,
      assetIds: input.asset_ids
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("trim_scene", {
  title: "缩短场景终点",
  description: "在当前 Revision 中安全缩短已有 Scene；绑定内容超出新终点时拒绝提交。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    scene_id: z.string().min(1),
    end_frame: z.number().int().positive()
  }
}, async (input) => {
  try {
    return asText(application.trimScene({ projectId: projectIdFrom(input.project_id), baseRevision: input.base_revision_id, sceneId: input.scene_id, endFrame: input.end_frame }));
  } catch (error) { return asError(error); }
});

server.registerTool("manage_visual_treatment", {
  title: "管理视觉处理计划",
  description: "保存 Story Beat 或 Scene 的主视觉、注意力强度和降级方案；它不直接生成 B-roll 或效果。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["upsert", "remove"]),
    visual_treatment_id: z.string().min(1).optional(),
    narrative_beat_id: z.string().min(1).optional(),
    scene_id: z.string().min(1).optional(),
    mode: z.enum(["keep_presenter", "quiet", "light_overlay", "remotion", "b_roll", "cutaway", "evidence"]).optional(),
    primary_attention: z.string().max(500).optional(),
    narrative_purpose: z.string().max(800).optional(),
    intensity: z.enum(["quiet", "low", "medium", "high"]).optional(),
    quiet_reason: z.string().max(800).optional(),
    fallback_plan: z.string().max(800).optional()
  }
}, async (input) => {
  try {
    return asText(application.manageVisualTreatment({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      action: input.action,
      visualTreatmentId: input.visual_treatment_id,
      narrativeBeatId: input.narrative_beat_id,
      sceneId: input.scene_id,
      mode: input.mode,
      primaryAttention: input.primary_attention,
      narrativePurpose: input.narrative_purpose,
      intensity: input.intensity,
      quietReason: input.quiet_reason,
      fallbackPlan: input.fallback_plan
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("manage_cutaways", {
  title: "管理 Cutaway",
  description: "基于已就绪的本地视频创建、调整或移除 Fullscreen/PiP Cutaway，并同步维护 CutawayScene 与顶层 Timeline Item。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "remove"]),
    cutaway_id: z.string().min(1).optional(),
    host_scene_id: z.string().min(1).optional(),
    asset_id: z.string().min(1).optional(),
    visual_treatment_id: z.string().min(1).optional(),
    title: z.string().max(160).optional(),
    mode: z.enum(["fullscreen", "pip"]).optional(),
    fit: z.enum(["cover", "contain"]).optional(),
    pip_anchor: z.enum(["top_left", "top_right", "middle_left", "middle_right", "bottom_left", "bottom_right", "center"]).optional(),
    pip_scale: z.number().min(0.2).max(0.6).optional(),
    audio_mode: z.enum(["continue_dialogue", "include_source_audio", "mute_source_audio"]).optional(),
    purpose: z.string().max(800).optional(),
    audience_task: z.string().max(800).optional(),
    source_start_frame: z.number().int().nonnegative().optional(),
    source_end_frame: z.number().int().positive().optional(),
    start_frame: z.number().int().nonnegative().optional(),
    end_frame: z.number().int().positive().optional()
  }
}, async (input) => {
  try {
    return asText(application.manageCutaway({
      projectId: projectIdFrom(input.project_id),
      baseRevision: input.base_revision_id,
      action: input.action,
      cutawayId: input.cutaway_id,
      hostSceneId: input.host_scene_id,
      assetId: input.asset_id,
      visualTreatmentId: input.visual_treatment_id,
      title: input.title,
      mode: input.mode,
      fit: input.fit,
      pipAnchor: input.pip_anchor,
      pipScale: input.pip_scale,
      audioMode: input.audio_mode,
      purpose: input.purpose,
      audienceTask: input.audience_task,
      sourceStartFrame: input.source_start_frame,
      sourceEndFrame: input.source_end_frame,
      startFrame: input.start_frame,
      endFrame: input.end_frame
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("replace_scene_asset", {
  title: "替换 Cutaway 素材",
  description: "只替换一个 Cutaway 的已本地化视频与源范围，不改写其主场景、EffectCue 或其他 Timeline Item。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    cutaway_id: z.string().min(1),
    asset_id: z.string().min(1),
    source_start_frame: z.number().int().nonnegative(),
    source_end_frame: z.number().int().positive()
  }
}, async ({ project_id, base_revision_id, cutaway_id, asset_id, source_start_frame, source_end_frame }) => {
  try {
    return asText(application.replaceSceneAsset({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      cutawayId: cutaway_id,
      assetId: asset_id,
      sourceStartFrame: source_start_frame,
      sourceEndFrame: source_end_frame
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("browse_effect_types", {
  title: "浏览效果类型",
  description: "读取当前 Remotion Effect Registry 中可用的效果类型。",
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, async () => asText(EFFECT_TYPES));

registerMotionTools(server, application, projectIdFrom);
registerMotionLibraryTools(server);
registerMediaIntelligenceTools(server, application, projectIdFrom);
registerSourceResearchTools(server, projectIdFrom);
registerSoundTools(server, application, projectIdFrom);

server.registerTool("manage_effect_cues", {
  title: "管理视觉效果",
  description: "创建、按 cue_id 就地更新或移除单个 EffectCue，均须当前 Revision。范围必须满足 Scene.startFrame ≤ start_frame < end_frame ≤ Scene.endFrame；covered_narrative_beat_ids 只声明内容覆盖，不允许跨 Scene 边界。action 默认 create；update 保留 Cue ID 和未指定字段，不能更换 Scene/类型/层级；remove 只移除该 Cue，不删除作品或回退整片。ManagedMotion 的源码、Props、画幅和完整时长仍固定，所属 Scene 必须完整承载作品；改作品需提交新版本。范围拒绝若返回 validation/none/correct_input，按实际 Scene 范围交回原作者修订后纠正一次，不原样重放。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    action: z.enum(["create", "update", "remove"]).default("create"),
    cue_id: z.string().min(1).optional(),
    scene_id: z.string().optional(),
    type: z.enum(["MetricBackdrop", "ProductFan", "GlowCTA", "PortfolioWall", "CommentCloud", "EvidenceCard", "CameraPunch", "FullScreenMeme", "DeviceShowcase", "ContentCarousel", "EndCard", "ManagedMotion"]).optional(),
    layer: z.enum(["rear", "actor", "front", "fullscreen"]).optional(),
    start_frame: z.number().int().nonnegative().optional(),
    end_frame: z.number().int().positive().optional(),
    anchor_target_id: z.string().optional(),
    note: z.string().optional(),
    narrative_purpose: z.string().max(800).optional(),
    audience_task: z.string().max(800).optional(),
    semantic_anchor: z.object({ type: z.enum(["speech_segment", "narrative_beat", "scene", "absolute"]), target_id: z.string().optional(), relation: z.enum(["anticipate", "land_on", "react_after", "hold_through"]) }).optional(),
    covered_narrative_beat_ids: z.array(z.string().min(1)).max(64).optional(),
    spatial_anchor: z.enum(["top_left", "top_right", "middle_left", "middle_right", "bottom_left", "bottom_right", "center", "full_frame"]).optional(),
    asset_bindings: z.array(z.object({ slot: z.string().min(1).max(80), asset_id: z.string().min(1) })).max(12).optional(),
    props: z.record(z.unknown()).optional(),
    motion: z.object({ enter_preset: z.string().max(80).optional(), settle_preset: z.string().max(80).optional(), exit_preset: z.string().max(80).optional(), enter_frames: z.number().int().min(0).max(240).optional(), hold_frames: z.number().int().min(0).max(10_000).optional(), exit_frames: z.number().int().min(0).max(240).optional() }).optional(),
    style_pack_id: z.string().max(160).optional(),
    // 不接受无执行语义的自由文本；具体的创作理由请写入 note / narrative_purpose。
    quality_rules: z.array(z.enum(EFFECT_QUALITY_RULES)).max(EFFECT_QUALITY_RULES.length).optional()
  }
}, async (input) => {
  try {
    const identity = { projectId: projectIdFrom(input.project_id), baseRevision: input.base_revision_id };
    if (input.action !== "create" && !input.cue_id) throw new Error("更新或移除效果必须提供 cue_id");
    if (input.action === "remove") {
      if (Object.entries(input).some(([key, value]) => value !== undefined && !["project_id", "base_revision_id", "action", "cue_id"].includes(key))) throw new Error("移除效果只接受 cue_id 和版本，不接受被忽略的编辑字段");
      return asText(application.removeEffectCue({ ...identity, cueId: input.cue_id! }));
    }
    const details = {
      note: input.note,
      narrativePurpose: input.narrative_purpose,
      audienceTask: input.audience_task,
      semanticAnchor: input.semantic_anchor ? { type: input.semantic_anchor.type, targetId: input.semantic_anchor.target_id, relation: input.semantic_anchor.relation } : undefined,
      coveredNarrativeBeatIds: input.covered_narrative_beat_ids,
      spatialAnchor: input.spatial_anchor,
      assetBindings: input.asset_bindings?.map((binding) => ({ slot: binding.slot, assetId: binding.asset_id })),
      props: input.props,
      motion: input.motion ? Object.fromEntries(Object.entries({
        enterPreset: input.motion.enter_preset,
        settlePreset: input.motion.settle_preset,
        exitPreset: input.motion.exit_preset,
        enterFrames: input.motion.enter_frames,
        holdFrames: input.motion.hold_frames,
        exitFrames: input.motion.exit_frames
      }).filter(([, value]) => value !== undefined)) : undefined,
      stylePackId: input.style_pack_id,
      qualityRules: input.quality_rules
    };
    if (input.action === "update") {
      if (input.scene_id !== undefined || input.type !== undefined || input.layer !== undefined || input.anchor_target_id !== undefined) throw new Error("更新不能更换 Scene/类型/层级；锚点请用 semantic_anchor");
      if (input.start_frame === undefined && input.end_frame === undefined && !Object.values(details).some((value) => value !== undefined)) throw new Error("更新效果至少需要一个明确字段");
      return asText(application.updateEffectCue({ ...identity, cueId: input.cue_id!, startFrame: input.start_frame, endFrame: input.end_frame, ...details }));
    }
    if (input.cue_id !== undefined || !input.scene_id || !input.type || !input.layer || input.start_frame === undefined || input.end_frame === undefined) throw new Error("创建效果须提供 scene_id、type、layer、start_frame、end_frame，且不能指定已有 cue_id");
    return asText(application.createEffectCue({ ...identity, sceneId: input.scene_id, type: input.type, layer: input.layer, startFrame: input.start_frame, endFrame: input.end_frame, anchorTargetId: input.anchor_target_id, ...details }));
  } catch (error) { return asError(error); }
});

server.registerTool("move_item", {
  title: "移动时间线片段",
  description: "以明确 base_revision_id 移动一个 Item；可选择同轨 ripple，冲突会原子回滚。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive(),
    item_id: z.string().min(1),
    start_frame: z.number().int().nonnegative(),
    ripple: z.boolean().optional()
  }
}, async ({ project_id, base_revision_id, item_id, start_frame, ripple }) => {
  try {
    return asText(application.moveItem({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      itemId: item_id,
      startFrame: start_frame,
      ripple
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("preview_timeline", {
  title: "读取时间线窗口",
  description: "读取同一 Revision 的多轨 Timeline、Scene、Caption 与 Cue 结构。",
  inputSchema: { project_id: z.string().optional(), from_frame: z.number().int().nonnegative().optional(), to_frame: z.number().int().positive().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id, from_frame, to_frame }) => {
  try {
    const state = application.readProject(projectIdFrom(project_id));
    const from = from_frame ?? 0;
    const to = to_frame ?? state.snapshot.timeline.durationInFrames;
    const overlaps = <T extends { startFrame: number; endFrame: number }>(entry: T) => entry.endFrame > from && entry.startFrame < to;
    return asText({
      revision: state.revision.number,
      timeline: { ...state.snapshot.timeline, items: state.snapshot.timeline.items.filter(overlaps), captions: state.snapshot.timeline.captions.filter(overlaps) },
      scenes: state.snapshot.scenes.filter(overlaps),
      effectCues: state.snapshot.effectCues.filter(overlaps),
      visualTreatments: state.snapshot.visualTreatments.filter((treatment) => !treatment.sceneId || state.snapshot.scenes.some((scene) => scene.id === treatment.sceneId && overlaps(scene))),
      cutaways: state.snapshot.cutaways.filter(overlaps)
    });
  } catch (error) { return asError(error); }
});

server.registerTool("start_production_run", {
  title: "开始 ProductionRun",
  description: "为本次 Skill 驱动的剪辑创建最小审计报告；报告保存在项目 reports 目录，不复制 Project Snapshot。",
  inputSchema: {
    project_id: z.string().optional(),
    base_revision_id: z.number().int().positive().optional(),
    loaded_skills: z.array(z.string().min(1)).min(1).max(40),
    loaded_references: z.array(z.string().min(1)).max(120).optional()
  }
}, async ({ project_id, base_revision_id, loaded_skills, loaded_references }) => {
  try {
    return asText(await application.startProductionRun({
      projectId: projectIdFrom(project_id),
      baseRevision: base_revision_id,
      loadedSkills: loaded_skills,
      loadedReferences: loaded_references
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("record_creative_decision", {
  title: "记录创作判断",
  description: "将创作决定、依据和证据写入 ProductionRun，不产生视频 Revision。协调者转录子代理结果时填写 delegation，关联真实代理标识、分派和输入历史版本；该来源为审计声明，不认证身份或代替宿主调用与真实审片。",
  inputSchema: {
    project_id: z.string().optional(),
    run_id: z.string().min(1),
    category: z.enum(["story", "semantic", "scene", "visual", "audio", "quality"]),
    decision: z.string().min(1).max(2_000),
    rationale: z.string().min(1).max(4_000),
    object_ids: z.array(z.string()).max(80).optional(),
    evidence: z.array(z.string().max(1_000)).max(80).optional(),
    alternatives: z.array(z.string().max(1_000)).max(20).optional(),
    delegation: z.object({
      agent_id: z.string().trim().min(1).max(160),
      assignment_id: z.string().trim().min(1).max(160),
      role: z.enum(["director", "specialist", "reviewer"]),
      input_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    }).strict().optional(),
    quiet_range: z.object({ start_frame: z.number().int().min(0), end_frame: z.number().int().positive(), reason: z.string().min(1).max(800) }).optional(),
    effect_decision: z.string().max(2_000).optional(),
    rejected_alternative: z.string().max(2_000).optional(),
    mcp_command: z.string().max(160).optional(),
    preview_evidence: z.string().max(2_000).optional(),
    quality_review: z.string().max(2_000).optional()
  }
}, async (input) => {
  try {
    return asText(await application.recordCreativeDecision({
      projectId: projectIdFrom(input.project_id),
      runId: input.run_id,
      category: input.category,
      decision: input.decision,
      rationale: input.rationale,
      objectIds: input.object_ids,
      evidence: input.evidence,
      alternatives: input.alternatives,
      delegation: input.delegation ? {
        agentId: input.delegation.agent_id,
        assignmentId: input.delegation.assignment_id,
        role: input.delegation.role,
        inputRevision: input.delegation.input_revision
      } : undefined,
      quietRange: input.quiet_range ? { startFrame: input.quiet_range.start_frame, endFrame: input.quiet_range.end_frame, reason: input.quiet_range.reason } : undefined,
      effectDecision: input.effect_decision,
      rejectedAlternative: input.rejected_alternative,
      mcpCommand: input.mcp_command,
      previewEvidence: input.preview_evidence,
      qualityReview: input.quality_review
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("record_editorial_quality_review", {
  title: "记录真实审片结论",
  description: "累积局部或全片审片证据与问题；observations 绑定成功 Preview、Revision、范围和真实观察方式。空 findings 不清除旧问题；resolutions 通过已登记的当前证据 ID 逐项复核关闭。记录不改变视频 Revision，不代表自动审美通过。",
  inputSchema: {
    project_id: z.string().optional(),
    run_id: z.string().min(1),
    revision: z.number().int().positive(),
    passes: z.array(z.enum(["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"])).min(1).max(5),
    preview_evidence: z.array(z.string().min(1).max(2_000)).max(40).default([]),
    observations: z.array(z.object({
      pass: z.enum(["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"]),
      preview_job_id: z.string().min(1),
      start_frame: z.number().int().nonnegative(),
      end_frame: z.number().int().positive(),
      method: z.enum(["frames", "continuous_video", "audio", "audiovisual"]),
      observation: z.string().min(1).max(2_000)
    })).max(40).optional(),
    resolutions: z.array(z.object({
      finding_id: z.string().min(1),
      evidence_ids: z.array(z.string().min(1)).min(1).max(40),
      scope: z.literal("caption_text").optional(),
      note: z.string().min(1).max(2_000)
    })).max(120).optional(),
    findings: z.array(z.object({
      pass: z.enum(["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"]),
      severity: z.enum(["blocking", "warning", "major", "minor", "suggestion", "inconclusive"]),
      category: z.enum(["semantic", "pacing", "attention", "motion", "typography", "audio", "mode_specific"]),
      summary: z.string().min(1).max(2_000),
      evidence: z.string().min(1).max(2_000),
      impact: z.string().min(1).max(2_000),
      suggested_fix: z.string().max(2_000).optional(),
      verification_method: z.string().max(2_000).optional(),
      object_id: z.string().optional(),
      frame_range: z.object({ start_frame: z.number().int().min(0), end_frame: z.number().int().positive() }).optional()
    })).max(120)
  }
}, async (input) => {
  try {
    return asText(await application.recordEditorialQualityReview({
      projectId: projectIdFrom(input.project_id),
      runId: input.run_id,
      revision: input.revision,
      passes: input.passes,
      previewEvidence: input.preview_evidence,
      observations: input.observations?.map((entry) => ({ pass: entry.pass, previewJobId: entry.preview_job_id, startFrame: entry.start_frame, endFrame: entry.end_frame, method: entry.method, observation: entry.observation })),
      resolutions: input.resolutions?.map((entry) => ({ findingId: entry.finding_id, evidenceIds: entry.evidence_ids, note: entry.note, scope: entry.scope })),
      findings: input.findings.map((finding) => ({
        pass: finding.pass,
        severity: finding.severity,
        category: finding.category,
        summary: finding.summary,
        evidence: finding.evidence,
        impact: finding.impact,
        suggestedFix: finding.suggested_fix,
        verificationMethod: finding.verification_method,
        objectId: finding.object_id,
        frameRange: finding.frame_range ? { startFrame: finding.frame_range.start_frame, endFrame: finding.frame_range.end_frame } : undefined
      }))
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("complete_production_run", {
  title: "完成 ProductionRun",
  description: "固定本次创作审计对应的最终 Revision，并补充已看过的预览和质量复核证据。",
  inputSchema: {
    project_id: z.string().optional(),
    run_id: z.string().min(1),
    final_revision: z.number().int().positive().optional(),
    quality_review: z.array(z.string().max(2_000)).max(40).optional(),
    preview_evidence: z.array(z.string().max(2_000)).max(40).optional()
  }
}, async ({ project_id, run_id, final_revision, quality_review, preview_evidence }) => {
  try {
    return asText(await application.completeProductionRun({
      projectId: projectIdFrom(project_id),
      runId: run_id,
      finalRevision: final_revision,
      qualityReview: quality_review,
      previewEvidence: preview_evidence
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("read_skill_execution_report", {
  title: "读取 SkillExecutionReport",
  description: "读取某次 ProductionRun 的 Skills、创作判断、MCP 改动与预览/质量证据。",
  inputSchema: { project_id: z.string().optional(), run_id: z.string().min(1) },
  annotations: { readOnlyHint: true }
}, async ({ project_id, run_id }) => {
  try { return asText(await application.readSkillExecutionReport({ projectId: projectIdFrom(project_id), runId: run_id })); } catch (error) { return asError(error); }
});

server.registerTool("validate_project_graph", {
  title: "验证项目对象图",
  description: "检查 Story、Scene、Item、Cue、Caption、Speech 与人物表演是否存在悬空引用；不会修改项目。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try {
    const state = application.readProject(projectIdFrom(project_id));
    const report = evaluateQuality(state.snapshot, state.revision.number);
    return asText({ valid: !report.issues.some((entry) => entry.code === "PROJECT_GRAPH_INVALID"), issues: report.issues.filter((entry) => entry.code === "PROJECT_GRAPH_INVALID") });
  } catch (error) { return asError(error); }
});

server.registerTool("read_quality_report", {
  title: "读取质量报告",
  description: "执行技术检查、从当前Story/VisualTreatment/有效对象推导整片对账，并返回逐轮审阅缺口和跨Run未关闭问题。字幕使用与Renderer相同的已部署Chromium、字体、字号、字重和安全宽度批量实测；浏览器不可用会明确失败，不回退到字符宽度估算。不会把布局通过、对象存在、抽帧或局部审片伪装成整片通过；只读，不创建Job或视频Revision。",
  inputSchema: { project_id: z.string().optional() },
  annotations: { readOnlyHint: true }
}, async ({ project_id }) => {
  try {
    const projectId = projectIdFrom(project_id);
    const state = application.readProject(projectId);
    const editorialReview = await application.readEditorialQualityReview({ projectId, revision: state.revision.number });
    return asText(await evaluateQualityWithBrowser(state.snapshot, state.revision.number, editorialReview));
  } catch (error) { return asError(error); }
});

server.registerTool("render_preview_range", {
  title: "渲染局部预览",
  description: "固定指定 Revision 与帧范围，提交可追踪的 Remotion 预览任务。范围按Timeline的半开区间[from_frame,to_frame)计，省略时默认0到该Revision的timeline.durationInFrames；可覆盖全片，不适用inspect_asset的60秒/12秒短范围限制。track_job成功后的result包含revision/fromFrame/toFrame/sourceHash；有音轨时result.audio包含实际输出文件完整解码的integratedLufs、truePeakDbfs、loudnessRangeLu和method。测量只代表该输出的合成范围，局部值不能当全片值，也不是原WAV的独立测量或真实听审。",
  inputSchema: {
    project_id: z.string().optional(),
    revision: z.number().int().positive().optional(),
    from_frame: z.number().int().nonnegative().optional(),
    to_frame: z.number().int().positive().optional(),
    idempotency_key: z.string().optional()
  }
}, async ({ project_id, revision, from_frame, to_frame, idempotency_key }) => {
  try { return asText(application.submitPreview({ projectId: projectIdFrom(project_id), revision, fromFrame: from_frame, toFrame: to_frame, idempotencyKey: idempotency_key })); } catch (error) { return asError(error); }
});

server.registerTool("inspect_composed_frames", {
  title: "检查真实合成帧",
  description: "从已完成的 Remotion 预览抽取进入、稳定、退出等关键帧；frames若提供，每次必须为1–12个非负整数，使用项目全局帧并落在该Preview的[fromFrame,toFrame)内。合并多个专项证据点后须去重并按最多12帧分批读取同一preview_job_id；省略frames由服务选择关键帧。不会重新渲染或修改视频Revision。",
  inputSchema: {
    project_id: z.string().optional(),
    preview_job_id: z.string().min(1),
    frames: z.array(z.number().int().nonnegative()).min(1).max(12).optional().describe("每次1–12个项目全局帧号，须位于当前Preview范围；更多证据点按最多12帧分批读取同一Preview。")
  },
  annotations: { readOnlyHint: true }
}, async ({ project_id, preview_job_id, frames }) => {
  try {
    const projectId = projectIdFrom(project_id);
    const job = application.trackJob(preview_job_id);
    if (job.projectId !== projectId || job.kind !== "preview") throw new DomainError("该任务不是当前项目的局部预览", "PREVIEW_JOB_NOT_FOUND");
    if (job.status !== "succeeded" || !job.result) throw new DomainError("局部预览尚未成功，不能检查合成帧", "PREVIEW_NOT_READY");
    const revision = Number(job.result.revision ?? job.payload.revision);
    const fromFrame = Number(job.result.fromFrame ?? job.payload.fromFrame);
    const toFrame = Number(job.result.toFrame ?? job.payload.toFrame);
    const previewPath = typeof job.result.path === "string" ? job.result.path : "";
    const state = application.readProject(projectId);
    const targetRevision = application.repository.getRevision(projectId, revision);
    const artifacts = await inspectComposedFrames({
      projectRoot: targetRevision.snapshot.project.rootPath,
      previewPath,
      revision,
      fromFrame,
      toFrame,
      fps: targetRevision.snapshot.timeline.fps,
      frames
    });
    await application.recordPreviewInspection({
      projectId,
      previewJobId: job.id,
      revision,
      frames: artifacts.map((artifact) => ({ frame: artifact.frame, relativePath: artifact.relativePath }))
    });
    return asText({ revision, sourcePreviewJobId: job.id, currentRevision: state.revision.number, frames: artifacts });
  } catch (error) { return asError(error); }
});

server.registerTool("submit_export", {
  title: "提交导出",
  description: "提交 draft 或 delivery 导出。draft 可用于内部审片；delivery 必须有目标 Revision 的完整真实审片与 Preview 证据，且 Remotion 失败绝不静默交付仅主轨文件。",
  inputSchema: { project_id: z.string().optional(), revision: z.number().int().positive().optional(), purpose: z.enum(["draft", "delivery"]).optional(), idempotency_key: z.string().optional() }
}, async ({ project_id, revision, purpose, idempotency_key }) => {
  try { return asText(application.submitExport({ projectId: projectIdFrom(project_id), revision, purpose, idempotencyKey: idempotency_key })); } catch (error) { return asError(error); }
});

server.registerTool("run_render_preflight", {
  title: "执行渲染前检查",
  description: "固定目标 Revision，检查实际引用素材、本地文件、可解码性、Mask 与当前 Remotion 组件依赖；检查通过不替代正式渲染或完整审片。",
  inputSchema: { project_id: z.string().optional(), revision: z.number().int().positive().optional(), purpose: z.enum(["draft", "delivery"]).optional(), idempotency_key: z.string().optional() }
}, async ({ project_id, revision, purpose, idempotency_key }) => {
  try { return asText(application.submitRenderPreflight({ projectId: projectIdFrom(project_id), revision, purpose, idempotencyKey: idempotency_key })); } catch (error) { return asError(error); }
});

server.registerTool("track_export", {
  title: "跟踪导出任务",
  description: "读取指定 Export Job 的状态、Render Preflight、最终文件校验和 Artifact ID；Job 成功不等于用户已批准。",
  inputSchema: { project_id: z.string().optional(), job_id: z.string().min(1) },
  annotations: { readOnlyHint: true }
}, async ({ project_id, job_id }) => {
  try {
    const projectId = projectIdFrom(project_id);
    const job = application.trackJob(job_id);
    if (job.projectId !== projectId || job.kind !== "export") throw new DomainError("该任务不是当前项目的 Export Job", "EXPORT_JOB_NOT_FOUND");
    return asText(job);
  } catch (error) { return asError(error); }
});

server.registerTool("read_export_artifact", {
  title: "读取导出产物",
  description: "读取不可变 ExportArtifact 的目标 Revision、哈希、技术校验、来源清单、成片复核和批准状态。",
  inputSchema: { project_id: z.string().optional(), artifact_id: z.string().min(1) },
  annotations: { readOnlyHint: true }
}, async ({ project_id, artifact_id }) => {
  try { return asText(application.readExportArtifact({ projectId: projectIdFrom(project_id), artifactId: artifact_id })); } catch (error) { return asError(error); }
});

server.registerTool("record_export_artifact_review", {
  title: "记录最终文件复核",
  description: "在实际播放指定 delivery 文件后，记录实际执行的文件复核轮次及问题，辅助审阅不阻挡导出或人工定稿；不会修改 Project Revision。",
  inputSchema: {
    project_id: z.string().optional(),
    artifact_id: z.string().min(1),
    passes: z.array(z.enum(["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"])).min(1).max(5),
    evidence: z.array(z.string().min(1).max(2_000)).min(1).max(40),
    findings: z.array(z.object({
      pass: z.enum(["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"]),
      severity: z.enum(["blocking", "warning", "major", "minor", "suggestion", "inconclusive"]),
      category: z.enum(["semantic", "pacing", "attention", "motion", "typography", "audio", "mode_specific"]),
      summary: z.string().min(1).max(2_000),
      evidence: z.string().min(1).max(2_000),
      impact: z.string().min(1).max(2_000),
      suggested_fix: z.string().max(2_000).optional(),
      verification_method: z.string().max(2_000).optional(),
      object_id: z.string().optional(),
      frame_range: z.object({ start_frame: z.number().int().min(0), end_frame: z.number().int().positive() }).optional()
    })).max(120)
  }
}, async (input) => {
  try {
    return asText(await application.recordExportArtifactReview({
      projectId: projectIdFrom(input.project_id),
      artifactId: input.artifact_id,
      passes: input.passes,
      evidence: input.evidence,
      findings: input.findings.map((finding) => ({
        pass: finding.pass,
        severity: finding.severity,
        category: finding.category,
        summary: finding.summary,
        evidence: finding.evidence,
        impact: finding.impact,
        suggestedFix: finding.suggested_fix,
        verificationMethod: finding.verification_method,
        objectId: finding.object_id,
        frameRange: finding.frame_range ? { startFrame: finding.frame_range.start_frame, endFrame: finding.frame_range.end_frame } : undefined
      }))
    }));
  } catch (error) { return asError(error); }
});

server.registerTool("approve_export_artifact", {
  title: "批准交付产物",
  description: "仅在用户明确确认此文件后登记人工定稿；须传 file_hash 与 confirmed_by_user=true。无需 AI 五轮审阅；导出成功、AI 判断或用户沉默均不表示批准。后续 Revision 不继承此批准。",
  inputSchema: { project_id: z.string().optional(), artifact_id: z.string().min(1), file_hash: z.string().regex(/^[a-f0-9]{64}$/u), confirmed_by_user: z.literal(true), note: z.string().max(1_000).optional() }
}, async ({ project_id, artifact_id, file_hash, confirmed_by_user, note }) => {
  try { return asText(await application.approveExportArtifact({ projectId: projectIdFrom(project_id), artifactId: artifact_id, fileHash: file_hash, confirmedByUser: confirmed_by_user, note })); } catch (error) { return asError(error); }
});

server.registerTool("read_job_diagnostics", {
  title: "读取任务失败诊断", description: "只读获取指定Job的阶段、异常链、浏览器事件和错误输出。仅读取该Job独立诊断目录，不接受文件路径，不改项目或任务。",
  inputSchema: { project_id: z.string().optional(), job_id: z.string() }, annotations: { readOnlyHint: true }
}, async ({ project_id, job_id }) => { try {
  const job = application.trackJob(job_id);
  if (job.projectId !== projectIdFrom(project_id)) throw new DomainError("Job不属于当前项目", "JOB_PROJECT_MISMATCH");
  return asText(await readJobDiagnostics(workspaceRoot, job));
} catch (error) { return asError(error); } });

server.registerTool("track_job", {
  title: "跟踪任务",
  description: "读取异步任务的 queued/running/succeeded/failed 状态与诊断信息。",
  inputSchema: { job_id: z.string().min(1) },
  annotations: { readOnlyHint: true }
}, async ({ job_id }) => {
  try { return asText(application.trackJob(job_id)); } catch (error) { return asError(error); }
});

const transport = new StdioServerTransport();
/** CommonJS 发行构建不能保留顶层 await；开发与发行都从同一启动函数连接 stdio。 */
async function startMcpServer(): Promise<void> {
  await server.connect(transport);
  console.error("video-editor-mcp 已通过 stdio 启动");
}

void startMcpServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
