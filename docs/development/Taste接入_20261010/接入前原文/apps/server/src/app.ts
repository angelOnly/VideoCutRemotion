import { captionPlacementSchema, captionDisplaySchema } from "../../../packages/contracts/src/caption-presentation.js";
import { MotionSubmissionValidationError } from "../../../packages/edit-application/src/motion-submission-validation.js";
import { toolError } from "./tool-error.js";
import { explainerPlanWithContent } from "../../../packages/contracts/src/explainer-inputs.js";
import { sourceCaptionTextReviewSchema, exportApprovalSchema } from "../../../packages/contracts/src/editorial-inputs.js";
import { audioDesignSchema } from "../../../packages/edit-application/src/sound-design.js";
import { registerSourceResearchRoutes } from "./source-research-tools.js";
import { registerSoundRoutes } from "./sound-tools.js";
import { listMotionFonts } from "../../../packages/motion-work/src/fonts.js";
import { registerFontLibraryRoutes } from "./font-library.js";
import { motionAllowedImports, MOTION_ENGINE_VERSION } from "../../../packages/motion-work/src/compiler.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import { createApplication, NotFoundError, RevisionConflictError } from "@videocut/application";
import { DomainError } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import { evaluateQualityWithBrowser } from "@videocut/quality";
import { measureCaptionTextInBrowser } from "../../../packages/quality-system/src/caption-measurement.js";
import type { AssetKind, EditorFocus, ProjectSnapshot } from "@videocut/contracts";
import { inspectAsset } from "./source-review.js";
import { mediaReviewPage } from "./media-review-page.js";
import { registerMediaIntelligenceRoutes } from "./media-intelligence-tools.js";
import { MOTION_SOURCES } from "../../../packages/motion-work/src/catalog.js";
import { motionSubmissionSchema, motionReviewFields } from "../../../packages/motion-work/src/schema.js";
import { projectFrameRateSchema } from "../../../packages/contracts/src/frame-rate.js";
import { inspectMotionReference } from "./motion-reference.js";

const idSchema = z.string().min(1);
const baseRevisionSchema = z.number().int().positive();
/**
 * 素材审阅是只读派生请求，不带 baseRevision；缓存不会进入项目 Revision。
 * range / dense 的范围合法性和时长上限由共享服务按真实素材时长二次校验。
 */
const sourceReviewRequestSchema = z.object({
  mode: z.enum(["overview", "range", "dense"]).default("overview"),
  sourceStartFrame: z.number().int().nonnegative().optional(),
  sourceEndFrame: z.number().int().positive().optional(),
  contactSheetFrames: z.number().int().positive().max(48).optional()
}).strict();
/**
 * 对白处理只接受人工复听后明确的问题与依据。首版固定整条 SpeechAsset，
 * Worker 生成候选但不会在这里悄悄替换当前 Dialogue。
 */
const dialogueProcessingIssueSchema = z.enum(["noise", "low_frequency", "sibilance", "loudness", "true_peak"]);
const dialogueProcessingSubmitSchema = z.object({
  baseRevision: baseRevisionSchema,
  issueTypes: z.array(dialogueProcessingIssueSchema).min(1).max(5),
  evidenceNote: z.string().trim().min(1).max(2_000),
  idempotencyKey: z.string().trim().min(1).max(240).optional()
}).strict();
const dialogueProcessingSelectionSchema = z.object({
  baseRevision: baseRevisionSchema,
  profile: z.enum(["original", "minimal", "strong"])
}).strict();
const actorAnchorSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  source: z.literal("manual_static")
}).strict();
const actorLayoutSchema = z.object({
  actorHead: actorAnchorSchema.optional(),
  actorHands: actorAnchorSchema.optional()
}).strict().refine((layout) => Boolean(layout.actorHead || layout.actorHands), {
  message: "人物布局至少需要一个头部或手部锚点"
});
const actorGenerationRangeSchema = z.object({
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().positive(),
  speechSegmentIds: z.array(idSchema).min(1).max(200)
}).strict().refine((range) => range.endFrame > range.startFrame, {
  message: "人物生成范围的结束帧必须大于开始帧"
});
const actorPlacementSchema = z.object({
  sceneId: idSchema,
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().positive()
}).strict().refine((placement) => placement.endFrame > placement.startFrame, {
  message: "人物放置范围的结束帧必须大于开始帧"
});

/**
 * Avatar 请求只表达项目内已确认的意图。Worker 会在真正调用前动态读取 Bridge Schema，
 * 因而这里不接受或承诺未验证的姿态、目光、手势与 Provider 字段。
 */
const avatarGenerationRequestSchema = z.object({
  baseRevision: baseRevisionSchema,
  capabilityProfileId: idSchema,
  referenceImageAssetId: idSchema,
  speechAssetId: idSchema.optional(),
  replaceActorPerformanceId: idSchema.optional(),
  generationRange: actorGenerationRangeSchema,
  placement: actorPlacementSchema,
  prompt: z.string().trim().min(1).max(4_000).optional(),
  // 当前 Bridge 尚未验证 Alpha / Mask 输出，生成型人物只能明确走无 Mask 前景降级。
  maskMode: z.literal("none").optional(),
  // 生成画面默认由当前 Dialogue 承担声音，避免与人物视频原声重复播放。
  audioMode: z.enum(["use_dialogue_track", "muted"]).optional(),
  layout: actorLayoutSchema.optional(),
  note: z.string().trim().max(1_000).optional(),
  idempotencyKey: z.string().trim().min(1).max(240).optional()
}).strict();

/**
 * 视频生成只接收已登记的 Asset ID 与受控参数。动态 Schema 的字段/槽位映射留给 Worker，
 * HTTP 层不接受 Provider 私有字段、下载 URL、文件路径或任意代码。
 */
const videoGenerationRequestSchema = z.object({
  baseRevision: baseRevisionSchema,
  workflowId: z.string().trim().min(1).max(240),
  mode: z.enum(["text_to_video", "image_to_video", "first_last_frame", "multi_reference"]),
  inputAssetIds: z.array(idSchema).max(10).optional(),
  prompt: z.string().trim().min(1).max(4_000),
  durationSeconds: z.number().int().min(1).max(1_800),
  aspectRatio: z.enum(["9:16", "16:9", "1:1"]).optional(),
  outputSlotId: z.string().trim().min(1).max(240).optional(),
  seed: z.number().int().nonnegative().optional(),
  megapixels: z.number().min(0.1).max(16).optional(),
  initialSeed: z.number().int().nonnegative().optional(),
  finalSeed: z.number().int().nonnegative().optional(),
  initialMegapixels: z.number().min(0.1).max(16).optional(),
  finalMegapixels: z.number().min(0.1).max(16).optional(),
  assetRequestId: idSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(240).optional()
}).strict();

const multicamMarkerSchema = z.object({
  assetId: idSchema,
  label: z.string().trim().min(1).max(80),
  sourceFrame: z.number().int().nonnegative(),
  note: z.string().trim().min(1).max(1_200)
}).strict();

/** Web 只创建可审计意图；接手和完成必须通过 MCP，由 Codex 用当前 Revision 回写。 */
const agentWorkOrderCreateSchema = z.object({
  baseRevision: baseRevisionSchema,
  title: z.string().trim().min(1).max(160),
  intent: z.string().trim().min(1).max(4_000),
  relatedObjectIds: z.array(idSchema).max(80).optional()
}).strict();
const agentWorkOrderCancelSchema = z.object({
  baseRevision: baseRevisionSchema,
  reason: z.string().trim().min(1).max(2_000)
}).strict();

const evidenceHighlightSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
  label: z.string().trim().min(1).max(160).optional()
}).strict().refine((highlight) => highlight.x + highlight.width <= 1 && highlight.y + highlight.height <= 1, {
  message: "证据高亮必须位于归一化页面范围内"
});
const explainerStateSchema = z.object({
  id: idSchema.optional(),
  phase: z.enum(["entry", "progressive", "settled", "exit"]),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
  label: z.string().trim().min(1).max(500),
  detail: z.string().trim().min(1).max(2_000).optional()
}).strict().refine((state) => state.endFrame > state.startFrame, {
  message: "Explainer 状态结束帧必须大于开始帧"
});
const explainerVisualTreatmentSchema = z.object({
  mode: z.enum(["keep_presenter", "quiet", "light_overlay", "remotion", "b_roll", "cutaway", "evidence"]).optional(),
  intensity: z.enum(["low", "medium", "high"]).optional(),
  primaryAttention: z.string().trim().min(1).max(500).optional(),
  narrativePurpose: z.string().trim().min(1).max(800).optional(),
  quietReason: z.string().trim().min(1).max(800).optional(),
  fallbackPlan: z.string().trim().min(1).max(800).optional()
}).strict();

const mimeByExtension: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf"
};

const assetKindFromFile = (fileName: string): AssetKind => {
  const extension = extname(fileName).toLowerCase();
  if ([".mp4", ".mov", ".webm", ".mkv"].includes(extension)) return "video";
  if ([".mp3", ".wav", ".flac", ".m4a", ".aac"].includes(extension)) return "audio";
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return "image";
  if (extension === ".pdf") return "document";
  throw new DomainError(`不支持的素材格式：${extension || "无扩展名"}`, "UNSUPPORTED_MEDIA");
};

const safeFileName = (fileName: string) => basename(fileName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
/** 大素材导入和去重都以流式哈希完成，不能为了计算 sourceHash 把整段视频读入内存。 */
const hashFile = async (path: string): Promise<string> => new Promise((resolveHash, rejectHash) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
  stream.once("error", rejectHash);
  stream.once("end", () => resolveHash(hash.digest("hex")));
});

const parseBaseRevision = (value: unknown) => baseRevisionSchema.parse(Number(value));

function assertPathWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || resolve(root, rel) !== resolve(candidate)) {
    throw new DomainError("文件路径不在允许的项目目录内", "UNSAFE_FILE_PATH");
  }
}

/**
 * 原素材播放器需要按字节跳转，尤其是 range / dense 反复复核时不能每次下载整段长视频。
 * 第一版只接受一段标准 bytes Range；多段响应会显著增加流式实现和浏览器兼容复杂度，直接返回 416。
 */
function parseSingleByteRange(value: string | undefined, size: number): { start: number; end: number } | undefined | null {
  if (!value) return undefined;
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const parseInteger = (input: string): number | undefined => {
    if (!input) return undefined;
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const requestedStart = parseInteger(match[1]);
  const requestedEnd = parseInteger(match[2]);
  if (match[1] && requestedStart === undefined || match[2] && requestedEnd === undefined) return null;
  if (requestedStart === undefined) {
    if (!requestedEnd || requestedEnd <= 0) return null;
    return { start: Math.max(0, size - requestedEnd), end: size - 1 };
  }
  if (requestedStart >= size) return null;
  const end = requestedEnd === undefined ? size - 1 : Math.min(requestedEnd, size - 1);
  return end < requestedStart ? null : { start: requestedStart, end };
}

export interface ServerOptions {
  workspaceRoot?: string;
  webOrigin?: string;
  serveWeb?: boolean;
  /**
   * 插件发行版把 Vite 产物复制到 runtime/dist/web；显式路径避免 Node 进程
   * 从安装缓存的 cwd 误回退到仓库源码目录。
   */
  webRoot?: string;
}

export async function createServer(options: ServerOptions = {}): Promise<{ app: FastifyInstance; application: ReturnType<typeof createApplication> }> {
  const runtimeConfig = readRuntimeConfig();
  const workspaceRoot = options.workspaceRoot ?? runtimeConfig.workspace.root;
  const webOrigin = options.webOrigin ?? runtimeConfig.http.webOrigin;
  const application = createApplication(workspaceRoot);
  const bridge = new ComfyUIBridgeClient();
  const app = Fastify({ logger: { level: runtimeConfig.http.logLevel } });
  registerMediaIntelligenceRoutes(app, application);

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { files: 18, fileSize: 512 * 1024 * 1024 } });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MotionSubmissionValidationError) return reply.status(400).send(toolError(error));
    if (error instanceof RevisionConflictError) {
      return reply.status(409).send({ error: "REVISION_CONFLICT", message: error.message, expectedRevision: error.expected, currentRevision: error.actual });
    }
    if (error instanceof NotFoundError) return reply.status(404).send({ error: "NOT_FOUND", message: error.message });
    if (error instanceof DomainError || error instanceof z.ZodError) {
      return reply.status(400).send({ error: error instanceof DomainError ? error.code : "VALIDATION_ERROR", message: error.message });
    }
    app.log.error(error);
    return reply.status(500).send({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "未知服务器错误" });
  });

  // 声音路由在错误处理器之后注册，参数校验才能返回 400，而不是默认的 500。
  registerSoundRoutes(app, application);
  registerSourceResearchRoutes(app, application);

  app.get("/health", async () => {
    let bridgeStatus: unknown;
    try {
      bridgeStatus = await bridge.health();
    } catch (error) {
      bridgeStatus = { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
    return { status: "ready", bridge: bridgeStatus };
  });

  app.get("/api/projects", async () => application.listProjects());

  app.post("/api/projects", async (request, reply) => {
    const body = z.object({
      name: z.string().trim().min(1).max(100),
      fps: projectFrameRateSchema.optional(),
      profile: z.enum(["presenter_motion", "visual_explainer", "vlog", "hybrid"]).optional(),
      brief: z.object({
        platform: z.string().optional(),
        aspectRatio: z.enum(["9:16", "16:9", "1:1"]).optional(),
        targetDurationSeconds: z.number().positive().optional(),
        audience: z.string().optional(),
        tone: z.string().optional(),
        captionMode: z.enum(["stable", "none"]).optional(),
        allowHighDensityMotion: z.boolean().optional()
      }).optional()
    }).parse(request.body);
    const state = application.createProject(body);
    return reply.status(201).send(state);
  });

  app.get("/api/projects/:projectId", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return application.readProject(projectId);
  });

  app.post("/api/projects/:projectId/frame-rate/preview", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const input = z.object({ baseRevision: baseRevisionSchema, fps: projectFrameRateSchema }).strict().parse(request.body);
    return application.previewProjectFrameRateChange({ projectId, ...input });
  });

  app.post("/api/projects/:projectId/frame-rate", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const input = z.object({ baseRevision: baseRevisionSchema, fps: projectFrameRateSchema }).strict().parse(request.body);
    return application.setProjectFrameRate({ projectId, ...input });
  });

  app.get("/api/projects/:projectId/story", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const state = application.readProject(projectId);
    return { revision: state.revision.number, story: state.snapshot.story };
  });

  app.patch("/api/projects/:projectId/story", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      title: z.string().max(160).optional(),
      summary: z.string().max(2_000).optional(),
      beats: z.array(z.object({
        id: idSchema.optional(),
        title: z.string().max(160),
        purpose: z.string().max(800),
        semanticUnitIds: z.array(idSchema).optional(),
        sceneIds: z.array(idSchema).optional()
      })).max(40).optional()
    }).refine((value) => value.title !== undefined || value.summary !== undefined || value.beats !== undefined, { message: "至少提供一个 Story 修改字段" }).parse(request.body);
    return application.updateStory({ projectId, ...body });
  });

  app.get("/api/projects/:projectId/revisions", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return application.readRevisions(projectId);
  });

  app.get("/api/projects/:projectId/agent-work-orders", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return application.readAgentWorkOrders(projectId);
  });

  app.post("/api/projects/:projectId/agent-work-orders", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = agentWorkOrderCreateSchema.parse(request.body);
    const result = application.createAgentWorkOrder({ projectId, ...body });
    return reply.status(201).send(result);
  });

  app.post("/api/projects/:projectId/agent-work-orders/:workOrderId/cancel", async (request) => {
    const { projectId, workOrderId } = z.object({ projectId: idSchema, workOrderId: idSchema }).parse(request.params);
    const body = agentWorkOrderCancelSchema.parse(request.body);
    return application.cancelAgentWorkOrder({ projectId, workOrderId, ...body });
  });

  app.get("/api/projects/:projectId/jobs", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return application.listJobs(projectId);
  });

  app.get("/api/jobs/:jobId", async (request) => {
    const { jobId } = z.object({ jobId: idSchema }).parse(request.params);
    return application.trackJob(jobId);
  });

  app.post("/api/captions/measure-text", async (request, reply) => {
    if (request.headers["x-videoflowcut-release-id"] !== runtimeConfig.runtime.releaseId) {
      throw new DomainError("字幕测量必须使用同版 Runtime", "RUNTIME_RELEASE_MISMATCH");
    }
    const inputs = z.array(z.object({ font: z.string().min(1), texts: z.array(z.string()) }).strict()).parse(request.body);
    const widths = await measureCaptionTextInBrowser(inputs);
    return reply.header("x-videoflowcut-release-id", runtimeConfig.runtime.releaseId).send(widths);
  });

  app.get("/api/projects/:projectId/quality", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const state = application.readProject(projectId);
    const editorialReview = await application.readEditorialQualityReview({ projectId, revision: state.revision.number });
    return evaluateQualityWithBrowser(state.snapshot, state.revision.number, editorialReview);
  });

  app.get("/api/projects/:projectId/editor-url", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const query = z.object({ sceneId: z.string().optional(), itemId: z.string().optional(), effectCueId: z.string().optional(), frame: z.coerce.number().int().min(0).optional() }).parse(request.query);
    const state = application.readProject(projectId);
    const focus: EditorFocus = { projectId, revision: state.revision.number, ...query };
    const url = new URL(webOrigin);
    url.searchParams.set("projectId", projectId);
    if (query.sceneId) url.searchParams.set("sceneId", query.sceneId);
    if (query.itemId) url.searchParams.set("itemId", query.itemId);
    if (query.effectCueId) url.searchParams.set("effectCueId", query.effectCueId);
    if (query.frame !== undefined) url.searchParams.set("frame", String(query.frame));
    return { editorUrl: url.toString(), focus };
  });

  async function importFile(input: { projectId: string; baseRevision: number; sourcePath: string; originalPath?: string }): Promise<unknown> {
    const state = application.readProject(input.projectId);
    const sourceName = safeFileName(basename(input.sourcePath));
    const kind = assetKindFromFile(sourceName);
    const sourceHash = await hashFile(input.sourcePath);
    const duplicate = state.snapshot.assets.find((asset) => asset.sourceHash === sourceHash);
    if (duplicate) return { duplicate: true, asset: duplicate, state };
    const extension = extname(sourceName);
    const storedName = `${Date.now()}-${sourceHash.slice(0, 10)}${extension}`;
    const relativePath = join("assets", "source", storedName);
    const targetPath = join(state.snapshot.project.rootPath, relativePath);
    await mkdir(join(state.snapshot.project.rootPath, "assets", "source"), { recursive: true });
    await copyFile(input.sourcePath, targetPath);
    return application.registerImportedAsset({
      projectId: input.projectId,
      baseRevision: input.baseRevision,
      name: sourceName,
      kind,
      managedPath: relativePath,
      originalPath: input.originalPath,
      sourceHash
    });
  }

  app.post("/api/projects/:projectId/assets/import-path", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, filePath: z.string().min(1) }).parse(request.body);
    const sourcePath = resolve(body.filePath);
    if (!existsSync(sourcePath)) throw new NotFoundError(`本地文件不存在：${sourcePath}`);
    return importFile({ projectId, baseRevision: body.baseRevision, sourcePath, originalPath: sourcePath });
  });

  app.post("/api/projects/:projectId/assets/upload", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const query = z.object({ baseRevision: z.coerce.number().int().positive() }).parse(request.query);
    const state = application.readProject(projectId);
    const uploadDirectory = join(state.snapshot.project.rootPath, "cache", "uploads");
    await mkdir(uploadDirectory, { recursive: true });
    const results: unknown[] = [];
    for await (const part of request.files()) {
      const filename = safeFileName(part.filename);
      const tempPath = join(uploadDirectory, `${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`);
      try {
        // multipart 流直接落盘；512MB 限制仍由 Fastify 执行，避免 toBuffer 造成堆内存峰值。
        await pipeline(part.file, createWriteStream(tempPath, { flags: "wx" }));
        if (part.file.truncated) throw new DomainError(`上传文件超过大小限制：${filename}`, "UPLOAD_FILE_TOO_LARGE");
        results.push(await importFile({ projectId, baseRevision: query.baseRevision, sourcePath: tempPath, originalPath: filename }));
        const latest = application.readProject(projectId);
        query.baseRevision = latest.revision.number;
      } finally {
        // importFile 已把源文件复制进受管 assets/source；临时上传文件不应长期占用 cache/uploads。
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
    return { imports: results };
  });

  /**
   * 原素材审阅只生成项目 cache/source-review 下可重建的代理与证据，
   * 不注册 Asset、不改 Revision；MCP 复用同一 inspectAsset 服务与 diagnostics 分流。
   */
  app.post("/api/projects/:projectId/assets/:assetId/inspect", async (request) => {
    const { projectId, assetId } = z.object({ projectId: idSchema, assetId: idSchema }).parse(request.params);
    const body = sourceReviewRequestSchema.parse(request.body ?? {});
    return inspectAsset(application, { projectId, assetId, ...body });
  });

  app.post("/api/projects/:projectId/transcription", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ assetId: idSchema, idempotencyKey: z.string().optional() }).parse(request.body);
    const job = application.submitTranscription({ projectId, ...body });
    return reply.status(202).send(job);
  });

  /** 原声字幕单独异步处理，既不创建 Script / Transcript，也不替换当前 Dialogue。 */
  app.post("/api/projects/:projectId/source-audio-captions", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      timelineItemId: idSchema,
      idempotencyKey: z.string().trim().min(1).max(240).optional()
    }).strict().parse(request.body);
    return reply.status(202).send(application.generateSourceAudioCaptions({ projectId, ...body }));
  });

  app.post("/api/projects/:projectId/speech-captions", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, idempotencyKey: z.string().trim().min(1).max(240).optional() }).strict().parse(request.body);
    return reply.status(202).send(application.generateSpeechCaptions({ projectId, ...body }));
  });

  app.post("/api/projects/:projectId/transcripts/manual", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema.optional(), assetId: idSchema, text: z.string().trim().min(1) }).parse(request.body);
    return application.applyTranscript({ projectId, ...body, source: "manual" });
  });

  app.post("/api/projects/:projectId/script", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, semanticUnitIds: z.array(idSchema) }).parse(request.body);
    return application.applyScript({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/script/authored", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      sourceNote: z.string().trim().min(1).max(2_000),
      units: z.array(z.object({
        text: z.string().trim().min(1).max(2_000),
        kind: z.enum(["statement", "question", "answer", "cause", "conclusion", "contrast", "list_item", "setup", "payoff", "retake", "intentional_repetition"]),
        dependencies: z.array(idSchema).optional(),
        precedingContext: z.string().max(2_000).optional(),
        followingContext: z.string().max(2_000).optional(),
        confidence: z.number().min(0).max(1).optional(),
        pauseBefore: z.object({ durationMs: z.number().int().min(0).max(10_000), reason: z.enum(["sentence", "contrast", "emotion", "breath", "chapter"]) }).optional()
      }).strict()).min(1).max(200)
    }).strict().parse(request.body);
    return application.applyAuthoredScript({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/semantic-units", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      units: z.array(z.object({
        candidateIds: z.array(idSchema).min(1),
        text: z.string().trim().min(1).max(2_000),
        kind: z.enum(["statement", "question", "answer", "cause", "conclusion", "contrast", "list_item", "setup", "payoff", "retake", "intentional_repetition"]),
        dependencies: z.array(idSchema).optional(),
        precedingContext: z.string().max(2_000).optional(),
        followingContext: z.string().max(2_000).optional(),
        retakeGroupId: idSchema.optional(),
        confidence: z.number().min(0).max(1).optional(),
        pauseBefore: z.object({ durationMs: z.number().int().min(0).max(10_000), reason: z.enum(["sentence", "contrast", "emotion", "breath", "chapter"]) }).optional()
      })).max(200)
    }).parse(request.body);
    return application.applySemanticUnits({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/timeline/assemble-presenter", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, assetIds: z.array(idSchema).min(1) }).parse(request.body);
    return application.assemblePresenterTrack({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/timeline/compile-presenter-scenes", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      scenes: z.array(z.object({
        title: z.string().trim().min(1).max(160),
        purpose: z.string().trim().min(1).max(800),
        startFrame: z.number().int().min(0),
        endFrame: z.number().int().positive(),
        narrativeBeatIds: z.array(idSchema).optional(),
        stylePackId: z.string().max(160).optional()
      })).min(1).max(80)
    }).parse(request.body);
    return application.compilePresenterScenes({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/timeline/edit-presenter-source", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, timelineItemId: idSchema, reason: z.string().trim().min(1).max(2000),
      keepRanges: z.array(z.object({ sourceStartFrame: z.number().int().nonnegative(), sourceEndFrame: z.number().int().positive() }).strict()).max(160)
    }).strict().parse(request.body);
    return application.editPresenterSource({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/timeline/build-presenter", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, assetIds: z.array(idSchema).min(1), sceneSize: z.number().int().min(1).max(8).optional() }).parse(request.body);
    return application.buildPresenterTimeline({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/timeline/align-presenter-to-speech", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema }).parse(request.body);
    return application.alignPresenterToSpeech({ projectId, ...body });
  });

  app.get("/api/projects/:projectId/actor-capabilities", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return application.listActorCapabilityProfiles(projectId);
  });

  app.get("/api/projects/:projectId/actor-performances", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const state = application.readProject(projectId);
    return { revision: state.revision.number, actorPerformances: state.snapshot.actorPerformances };
  });

  app.post("/api/projects/:projectId/actor-capabilities", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["create", "update", "remove"]),
      profileId: idSchema.optional(),
      provider: z.literal("minimax_h3_multi_reference").optional(),
      label: z.string().min(1).max(120).optional(),
      workflowId: z.string().min(1).max(200).optional(),
      inputModes: z.array(z.enum(["audio", "text"])).min(1).max(2).optional(),
      maskModes: z.array(z.enum(["alpha_asset", "embedded_alpha", "none"])).min(1).max(3).optional(),
      supportsReferenceImage: z.boolean().optional(),
      supportsReferenceVideo: z.boolean().optional(),
      // 参考音频可上传不等于已验证口型；只有实测通过时才允许声明 true。
      supportsAudioDrivenLipSync: z.boolean().optional(),
      supportsGazeControl: z.boolean().optional(),
      supportsGestureControl: z.boolean().optional(),
      supportsPartialRegeneration: z.boolean().optional(),
      maxDurationSeconds: z.number().int().min(1).max(1800).optional(),
      privacyNote: z.string().min(1).max(2_000).optional()
    }).strict().parse(request.body);
    return application.manageActorCapabilityProfile({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/actor-performances", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      timelineItemId: idSchema,
      source: z.enum(["imported", "generated"]),
      maskMode: z.enum(["alpha_asset", "embedded_alpha", "none"]),
      audioMode: z.enum(["use_source_audio", "use_dialogue_track", "muted"]).optional(),
      maskAssetId: idSchema.optional(),
      speechAssetId: idSchema.optional(),
      capabilityProfileId: idSchema.optional(),
      layout: actorLayoutSchema.optional(),
      note: z.string().max(500).optional()
    }).parse(request.body);
    return application.registerActorPerformance({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/avatar-jobs", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = avatarGenerationRequestSchema.parse(request.body);
    return reply.status(202).send(application.submitAvatarGeneration({ projectId, ...body }));
  });

  app.post("/api/projects/:projectId/video-generation", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = videoGenerationRequestSchema.parse(request.body);
    return reply.status(202).send(application.submitVideoGeneration({ projectId, ...body }));
  });

  /** 视觉解释主线：NarrativeMap 只表达观众理解路径，Scene 仍由后续编译接口原子生成。 */
  app.get("/api/projects/:projectId/narrative-map", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return application.readNarrativeMap({ projectId });
  });

  app.post("/api/projects/:projectId/narrative-map", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      viewerQuestion: z.string().trim().min(1).max(800),
      promisedModel: z.string().trim().min(1).max(1_200),
      conclusion: z.string().trim().min(1).max(1_200),
      beats: z.array(z.object({
        narrativeBeatId: idSchema,
        enteringKnowledge: z.string().trim().min(1).max(1_200),
        question: z.string().trim().min(1).max(1_200),
        newKnowledge: z.string().trim().min(1).max(1_200),
        deferredInformation: z.string().trim().min(1).max(1_200),
        claim: z.string().trim().min(1).max(1_200).optional(),
        evidenceCaptureIds: z.array(idSchema).max(40).optional(),
        sceneIds: z.array(idSchema).max(40).optional()
      }).strict()).min(1).max(80)
    }).strict().parse(request.body);
    return application.manageNarrativeMap({ projectId, ...body });
  });

  app.get("/api/projects/:projectId/evidence-captures", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const { evidenceCaptureId } = z.object({ evidenceCaptureId: idSchema.optional() }).parse(request.query);
    return application.readEvidenceCapture({ projectId, evidenceCaptureId });
  });

  app.post("/api/projects/:projectId/evidence-captures", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["create", "update", "remove"]),
      evidenceCaptureId: idSchema.optional(),
      sourceAssetId: idSchema.optional(),
      snapshotAssetId: idSchema.optional(),
      sourceTitle: z.string().trim().min(1).max(800).optional(),
      publisher: z.string().trim().min(1).max(400).optional(),
      sourceUrl: z.string().url().max(2_000).optional(),
      capturedAt: z.string().datetime({ offset: true }).optional(),
      pageOrRange: z.string().trim().min(1).max(500).optional(),
      excerpt: z.string().trim().min(1).max(8_000).optional(),
      claim: z.string().trim().min(1).max(2_000).optional(),
      limitation: z.string().trim().min(1).max(2_000).optional(),
      highlights: z.array(evidenceHighlightSchema).min(1).max(12).optional()
    }).strict().parse(request.body);
    return application.manageEvidenceCapture({ projectId, ...body });
  });

  app.get("/api/projects/:projectId/explainer-scenes", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const { sceneId } = z.object({ sceneId: idSchema.optional() }).parse(request.query);
    return application.readExplainerScenePrograms({ projectId, sceneId });
  });

  app.post("/api/projects/:projectId/explainer-scenes/compile", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      plans: z.array(explainerPlanWithContent({
        title: z.string().trim().min(1).max(160),
        purpose: z.string().trim().min(1).max(1_200),
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().positive(),
        narrativeMapBeatId: idSchema,
        primaryTask: z.string().trim().min(1).max(1_200),
        assetIds: z.array(idSchema).max(60).optional(),
        evidenceCaptureId: idSchema.optional(),
        states: z.array(explainerStateSchema).min(4).max(12),
        stylePackId: z.string().trim().min(1).max(160).optional(),
        visualTreatment: explainerVisualTreatmentSchema.optional()
      }).refine((plan) => plan.endFrame > plan.startFrame, {
        message: "Explainer 场景结束帧必须大于开始帧"
      })).min(1).max(80)
    }).strict().parse(request.body);
    return application.compileExplainerScenes({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/explainer-programs/:programId/enabled", async (request) => {
    const { projectId, programId } = z.object({ projectId: idSchema, programId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, enabled: z.boolean() }).strict().parse(request.body);
    return application.setExplainerProgramEnabled({ projectId, programId, ...body });
  });

  app.get("/api/projects/:projectId/vlog-plan", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return application.readVlogPlan(projectId);
  });

  app.post("/api/projects/:projectId/vlog-analysis", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      assetIds: z.array(idSchema).min(1).max(120),
      sceneThreshold: z.number().min(0.05).max(0.9).optional(),
      idempotencyKey: z.string().trim().min(1).max(240).optional()
    }).parse(request.body);
    // 分析任务只产出可测量的边界；事件与剪辑意图仍由后续 Event / Select 接口明确写入。
    return reply.status(202).send(application.submitVlogAnalysis({ projectId, ...body }));
  });

  app.post("/api/projects/:projectId/vlog-events", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["create", "update", "remove"]),
      eventId: idSchema.optional(),
      order: z.number().int().nonnegative().optional(),
      title: z.string().trim().min(1).max(160).optional(),
      summary: z.string().trim().min(1).max(2_000).optional(),
      shotAnalysisIds: z.array(idSchema).min(1).max(300).optional(),
      goal: z.string().max(800).optional(),
      actionNote: z.string().max(800).optional(),
      change: z.string().max(800).optional(),
      reaction: z.string().max(800).optional(),
      outcome: z.string().max(800).optional(),
      locationNote: z.string().max(800).optional(),
      continuityNote: z.string().max(1_200).optional(),
      status: z.enum(["draft", "ready"]).optional()
    }).parse(request.body);
    return application.manageVlogEvents({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/vlog-shot-selects", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["create", "update", "remove"]),
      shotSelectId: idSchema.optional(),
      eventId: idSchema.optional(),
      shotAnalysisId: idSchema.optional(),
      order: z.number().int().nonnegative().optional(),
      sourceStartFrame: z.number().int().nonnegative().optional(),
      sourceEndFrame: z.number().int().positive().optional(),
      function: z.enum(["establish", "action", "detail", "reaction", "transition", "atmosphere"]).optional(),
      selectionReason: z.string().max(1_200).optional(),
      continuityNote: z.string().max(1_200).optional(),
      sourceAudioMode: z.enum(["keep", "mute"]).optional(),
      status: z.enum(["planned", "ready"]).optional()
    }).parse(request.body);
    return application.manageVlogShotSelects({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/timeline/compile-vlog-montage", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      shotSelectIds: z.array(idSchema).min(1).max(300),
      startFrame: z.number().int().nonnegative().optional(),
      titlePrefix: z.string().trim().min(1).max(120).optional()
    }).parse(request.body);
    return application.compileVlogMontage({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/vlog-music-beats", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["create", "update", "remove"]),
      beatId: idSchema.optional(),
      audioCueId: idSchema.optional(),
      frame: z.number().int().nonnegative().optional(),
      note: z.string().max(1_000).optional()
    }).parse(request.body);
    return application.manageVlogMusicBeats({ projectId, ...body });
  });

  app.get("/api/projects/:projectId/multicam", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return application.readMulticamPlan(projectId);
  });

  app.post("/api/projects/:projectId/multicam/sync", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      title: z.string().trim().min(1).max(160).optional(),
      assetIds: z.array(idSchema).min(2).max(24),
      angleLabels: z.record(z.string().trim().min(1).max(80)),
      referenceAssetId: idSchema.optional(),
      masterAudioAssetId: idSchema.optional(),
      sourceRanges: z.record(z.object({
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().positive()
      }).strict().refine((range) => range.endFrame > range.startFrame, {
        message: "同步源区间的结束帧必须大于开始帧"
      })).optional(),
      maxSearchSeconds: z.number().int().min(20).max(1_800).optional(),
      idempotencyKey: z.string().trim().min(1).max(240).optional()
    }).strict().parse(request.body);
    // 自动相关只会生成 candidate；之后仍须调用 verify 写入连续预览确认。
    return reply.status(202).send(application.submitMulticamSync({ projectId, ...body }));
  });

  app.post("/api/projects/:projectId/multicam/manual", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      title: z.string().trim().min(1).max(160),
      referenceAssetId: idSchema,
      masterAudioAssetId: idSchema,
      markers: z.array(multicamMarkerSchema).min(2).max(24)
    }).strict().parse(request.body);
    return application.createManualMulticamGroup({ projectId, ...body });
  });

  /**
   * 仅确认已由所属同步 Job 生成并绑定受管并排 Preview 的自动 candidate；
   * previewEvidence 必须记录人工连续核对说明，不能用接口成功替代预览。
   */
  app.post("/api/projects/:projectId/multicam/verify", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      groupId: idSchema,
      previewEvidence: z.string().trim().min(1).max(2_000)
    }).strict().parse(request.body);
    return application.verifyMulticamGroup({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/multicam/cuts", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["create", "update", "remove"]),
      groupId: idSchema.optional(),
      cutId: idSchema.optional(),
      order: z.number().int().nonnegative().optional(),
      angleAssetId: idSchema.optional(),
      sessionStartFrame: z.number().int().nonnegative().optional(),
      sessionEndFrame: z.number().int().positive().optional(),
      reason: z.string().trim().min(1).max(1_200).optional(),
      continuityNote: z.string().trim().min(1).max(1_200).optional()
    }).strict().parse(request.body);
    return application.manageMulticamCuts({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/timeline/compile-multicam", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      groupId: idSchema,
      cutIds: z.array(idSchema).min(1).max(300),
      startFrame: z.number().int().nonnegative().optional(),
      titlePrefix: z.string().trim().min(1).max(120).optional()
    }).strict().parse(request.body);
    return application.compileMulticamProgram({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/music-generation", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      workflowId: z.string().trim().min(1).max(240),
      prompt: z.string().trim().min(1).max(4_000),
      durationSeconds: z.number().int().min(1).max(1_800),
      outputSlotId: z.string().trim().min(1).max(240).optional(),
      idempotencyKey: z.string().trim().min(1).max(240).optional()
    }).strict().parse(request.body);
    return reply.status(202).send(application.submitMusicGeneration({ projectId, ...body }));
  });

  app.post("/api/projects/:projectId/scenes", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      type: z.enum(["PresenterScene", "ExplainerScene", "VlogMontageScene", "CutawayScene", "EndCardScene"]),
      title: z.string().min(1),
      purpose: z.string().min(1),
      startFrame: z.number().int().min(0),
      endFrame: z.number().int().positive(),
      assetIds: z.array(idSchema).optional()
    }).parse(request.body);
    return application.createScene({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/scenes/:sceneId/trim", async (request) => {
    const { projectId, sceneId } = z.object({ projectId: idSchema, sceneId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, endFrame: z.number().int().positive() }).strict().parse(request.body);
    return application.trimScene({ projectId, sceneId, ...body });
  });

  app.post("/api/projects/:projectId/visual-treatments", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["upsert", "remove"]),
      visualTreatmentId: idSchema.optional(),
      narrativeBeatId: idSchema.optional(),
      sceneId: idSchema.optional(),
      mode: z.enum(["keep_presenter", "quiet", "light_overlay", "remotion", "b_roll", "cutaway", "evidence"]).optional(),
      primaryAttention: z.string().max(500).optional(),
      narrativePurpose: z.string().max(800).optional(),
      intensity: z.enum(["quiet", "low", "medium", "high"]).optional(),
      quietReason: z.string().max(800).optional(),
      fallbackPlan: z.string().max(800).optional()
    }).parse(request.body);
    return application.manageVisualTreatment({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/cutaways", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["create", "update", "remove"]),
      cutawayId: idSchema.optional(),
      hostSceneId: idSchema.optional(),
      assetId: idSchema.optional(),
      visualTreatmentId: idSchema.optional(),
      title: z.string().max(160).optional(),
      mode: z.enum(["fullscreen", "pip"]).optional(),
      fit: z.enum(["cover", "contain"]).optional(),
      pipAnchor: z.enum(["top_left", "top_right", "middle_left", "middle_right", "bottom_left", "bottom_right", "center"]).optional(),
      pipScale: z.number().min(0.2).max(0.6).optional(),
      audioMode: z.enum(["continue_dialogue", "include_source_audio", "mute_source_audio"]).optional(),
      purpose: z.string().max(800).optional(),
      audienceTask: z.string().max(800).optional(),
      sourceStartFrame: z.number().int().min(0).optional(),
      sourceEndFrame: z.number().int().positive().optional(),
      startFrame: z.number().int().min(0).optional(),
      endFrame: z.number().int().positive().optional()
    }).parse(request.body);
    return application.manageCutaway({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/cutaways/:cutawayId/replace-asset", async (request) => {
    const { projectId, cutawayId } = z.object({ projectId: idSchema, cutawayId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      assetId: idSchema,
      sourceStartFrame: z.number().int().min(0),
      sourceEndFrame: z.number().int().positive()
    }).parse(request.body);
    return application.replaceSceneAsset({ projectId, cutawayId, ...body });
  });

  app.post("/api/projects/:projectId/effects", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      coveredNarrativeBeatIds: z.array(idSchema).max(64).optional(),
      sceneId: idSchema,
      type: z.enum(["MetricBackdrop", "ProductFan", "GlowCTA", "PortfolioWall", "CommentCloud", "EvidenceCard", "CameraPunch", "FullScreenMeme", "DeviceShowcase", "ContentCarousel", "EndCard", "ManagedMotion"]),
      layer: z.enum(["rear", "actor", "front", "fullscreen"]),
      startFrame: z.number().int().min(0),
      endFrame: z.number().int().positive(),
      anchorTargetId: z.string().optional(),
      note: z.string().optional(),
      assetBindings: z.array(z.object({ slot: z.string(), assetId: idSchema })).optional()
    }).parse(request.body);
    return application.createEffectCue({ projectId, ...body });
  });

  app.get("/api/motion/sources", async () => ({ sources: MOTION_SOURCES }));
  app.get("/api/motion/capabilities", async () => ({ engineVersion: MOTION_ENGINE_VERSION, allowedImports: motionAllowedImports(), fonts: listMotionFonts() }));
  registerFontLibraryRoutes(app);
  // 与渲染 Worker 共用部署前验证的浏览器；此只读服务不创建 Project、Revision 或 Job。
  app.post("/api/motion/inspect-reference", async (request, reply) => {
    if (request.headers["x-videoflowcut-release-id"] !== runtimeConfig.runtime.releaseId) {
      throw new DomainError("当前 MCP 与动效审阅 Runtime 版本不一致", "RUNTIME_RELEASE_MISMATCH");
    }
    const body = z.object({
      sourceUrl: z.string().url(),
      previewIndex: z.number().int().nonnegative().max(300).optional(),
      sampleDurationMs: z.number().int().min(1000).max(20000).default(6000)
    }).strict().parse(request.body);
    const evidence = await inspectMotionReference(body.sourceUrl, body.previewIndex, body.sampleDurationMs);
    return reply.header("x-videoflowcut-release-id", runtimeConfig.runtime.releaseId).send(evidence);
  });
  app.post("/api/projects/:projectId/motion-works", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, idempotencyKey: z.string().min(1).max(160), work: motionSubmissionSchema }).strict().parse(request.body);
    return application.submitManagedMotion({ projectId, ...body });
  });
  app.get("/api/projects/:projectId/motion-works/:jobId", async (request) => {
    const { projectId, jobId } = z.object({ projectId: idSchema, jobId: idSchema }).parse(request.params);
    return application.readManagedMotion(projectId, jobId);
  });
  app.post("/api/projects/:projectId/motion-works/:assetId/review", async (request) => {
    const { projectId, assetId } = z.object({ projectId: idSchema, assetId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, ...motionReviewFields }).strict().parse(request.body);
    return application.reviewManagedMotion({ projectId, assetId, ...body });
  });

  app.patch("/api/projects/:projectId/effects/:cueId", async (request) => {
    const { projectId, cueId } = z.object({ projectId: idSchema, cueId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, coveredNarrativeBeatIds: z.array(idSchema).max(64).optional(), startFrame: z.number().int().min(0).optional(), endFrame: z.number().int().positive().optional(), intensity: z.number().min(0).max(1).optional(), note: z.string().optional() }).parse(request.body);
    return application.updateEffectCue({ projectId, cueId, ...body });
  });

  app.post("/api/projects/:projectId/items/:itemId/move", async (request) => {
    const { projectId, itemId } = z.object({ projectId: idSchema, itemId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, startFrame: z.number().int().min(0), ripple: z.boolean().optional() }).parse(request.body);
    return application.moveItem({ projectId, itemId, ...body });
  });

  app.post("/api/projects/:projectId/voice-synthesis", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ voiceReferenceId: idSchema.optional(), voiceReferenceAssetId: idSchema.optional(), speechSegmentIds: z.array(idSchema).optional(), idempotencyKey: z.string().optional() })
      .parse(request.body);
    return reply.status(202).send(application.submitVoiceSynthesis({ projectId, ...body }));
  });

  /**
   * 生成原声 / 最小处理 / 强处理三个可比较版本。提交只创建异步 Job，
   * 任何候选都必须由操作者试听并经下一条显式选择接口才会进入 Dialogue 轨。
   */
  app.post("/api/projects/:projectId/dialogue-processing", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = dialogueProcessingSubmitSchema.parse(request.body);
    return reply.status(202).send(application.submitDialogueProcessing({ projectId, ...body }));
  });

  /** 选择候选会创建新 Revision；不得由 Job 完成或 Web 自动调用。 */
  app.post("/api/projects/:projectId/dialogue-processing/select", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = dialogueProcessingSelectionSchema.parse(request.body);
    return application.selectDialogueProcessingVariant({ projectId, ...body });
  });

  /** 词级对齐是可选异步任务；没有明确 workflow 时不把段级时序伪装成 word_exact。 */
  app.post("/api/projects/:projectId/speech-alignment", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      workflowId: z.string().trim().min(1).max(240),
      speechAssetId: idSchema.optional(),
      outputSlotId: z.string().trim().min(1).max(240).optional(),
      idempotencyKey: z.string().trim().min(1).max(240).optional()
    }).strict().parse(request.body);
    return reply.status(202).send(application.submitSpeechAlignment({ projectId, ...body }));
  });

  app.get("/api/projects/:projectId/speech-alignment", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return { speechAlignment: application.readSpeechAlignment(projectId) };
  });

  app.post("/api/projects/:projectId/voice-references", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema, assetId: idSchema, label: z.string().max(160).optional(), usageNote: z.string().max(500).optional() }).strict().parse(request.body);
    return application.registerVoiceReference({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/speech-asset/rebuild-timeline", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema }).parse(request.body);
    return application.rebuildSpeechAssetTimeline({ projectId, ...body });
  });

  app.patch("/api/projects/:projectId/captions/:captionId", async (request) => {
    const { projectId, captionId } = z.object({ projectId: idSchema, captionId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["update", "reset"]),
      text: z.string().max(80).optional(),
      sourceTextReview: sourceCaptionTextReviewSchema.optional(),
      display: captionDisplaySchema.nullable().optional(),
      format: z.object({
        placement: captionPlacementSchema.nullable().optional(),
        fontSize: z.number().int().min(16).max(72).optional(),
        fontWeight: z.number().int().min(400).max(900).optional(),
        color: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").optional(),
        backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").nullable().optional(),
        backgroundOpacity: z.number().min(0.1).max(1).nullable().optional(),
        bottomPercent: z.number().min(0).max(95).optional(),
        horizontalInsetPercent: z.number().min(0).max(45).optional(),
        textAlign: z.enum(["left", "center", "right"]).optional()
      }).strict().optional(),
      emphasis: z.object({
        text: z.string().min(1).max(40),
        occurrence: z.number().int().nonnegative(),
        color: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").optional(),
        backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").optional(),
        fontWeight: z.number().int().min(400).max(900).optional(),
        scale: z.number().min(0.8).max(1.35).optional()
      }).strict().nullable().optional()
    }).parse(request.body);
    return application.editCaptions({ projectId, captionId, ...body });
  });

  /** 批量接口仅统一同一原声 A-roll 的安全版式，不允许借此重写文字或伪造卡片时间。 */
  app.patch("/api/projects/:projectId/captions/source-format", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      captionIds: z.array(idSchema).min(1).max(200),
      format: z.object({
        placement: captionPlacementSchema.nullable().optional(),
        fontSize: z.number().int().min(16).max(72).optional(),
        fontWeight: z.number().int().min(400).max(900).optional(),
        color: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").optional(),
        backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/iu, "颜色必须是 #RRGGBB").nullable().optional(),
        backgroundOpacity: z.number().min(0.1).max(1).nullable().optional(),
        bottomPercent: z.number().min(0).max(95).optional(),
        horizontalInsetPercent: z.number().min(0).max(45).optional(),
        textAlign: z.enum(["left", "center", "right"]).optional()
      }).strict()
    }).strict().parse(request.body);
    return application.editCaptions({
      projectId,
      baseRevision: body.baseRevision,
      captionIds: body.captionIds,
      action: "bulk_source_format",
      format: body.format
    });
  });

  app.post("/api/projects/:projectId/audio", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({
      baseRevision: baseRevisionSchema,
      action: z.enum(["create", "update", "remove"]),
      audioCueId: idSchema.optional(),
      kind: z.enum(["bgm", "sfx"]).optional(),
      design: audioDesignSchema.optional(),
      assetId: idSchema.optional(),
      purpose: z.string().max(800).optional(),
      startFrame: z.number().int().min(0).optional(),
      endFrame: z.number().int().positive().optional(),
      sourceStartFrame: z.number().int().min(0).optional(),
      sourceEndFrame: z.number().int().positive().optional(),
      loop: z.boolean().optional(),
      gainDb: z.number().min(-48).max(12).optional(),
      fadeInFrames: z.number().int().min(0).max(480).optional(),
      fadeOutFrames: z.number().int().min(0).max(480).optional(),
      eventFrame: z.number().int().min(0).optional(),
      onsetOffsetFrames: z.number().int().min(0).optional(),
      onsetReview: z.object({ status: z.enum(["confirmed", "inconclusive"]), note: z.string().min(16).max(2400) }).strict().optional(),
      effectEvent: z.object({
        effectCueId: idSchema,
        eventName: z.string().trim().min(1).max(160),
        localFrame: z.number().int().nonnegative(), endLocalFrame: z.number().int().positive().optional(), eventId: z.string().optional(), workVersion: z.string().optional(),
        syncOffsetFrames: z.number().int().optional()
      }).strict().nullable().optional(),
      ducking: z.object({
        enabled: z.boolean().optional(),
        reductionDb: z.number().min(-36).max(-1).optional(),
        attackFrames: z.number().int().min(0).max(240).optional(),
        releaseFrames: z.number().int().min(0).max(240).optional(), holdFrames: z.number().int().min(0).max(240).optional()
      }).strict().optional()
    }).parse(request.body);
    return application.manageAudio({ projectId, ...body });
  });

  app.post("/api/projects/:projectId/previews", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ revision: z.number().int().positive().optional(), fromFrame: z.number().int().nonnegative().optional(), toFrame: z.number().int().positive().optional(), idempotencyKey: z.string().optional() }).parse(request.body);
    return reply.status(202).send(application.submitPreview({ projectId, ...body }));
  });

  app.post("/api/projects/:projectId/export", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ revision: z.number().int().positive().optional(), purpose: z.enum(["draft", "delivery"]).optional(), idempotencyKey: z.string().optional() }).parse(request.body);
    return reply.status(202).send(application.submitExport({ projectId, ...body }));
  });

  app.post("/api/projects/:projectId/render-preflight", async (request, reply) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    const body = z.object({ revision: z.number().int().positive().optional(), purpose: z.enum(["draft", "delivery"]).optional(), idempotencyKey: z.string().optional() }).parse(request.body);
    return reply.status(202).send(application.submitRenderPreflight({ projectId, ...body }));
  });

  app.get("/api/projects/:projectId/export-artifacts", async (request) => {
    const { projectId } = z.object({ projectId: idSchema }).parse(request.params);
    return application.listExportArtifacts(projectId);
  });

  app.get("/api/projects/:projectId/export-artifacts/:artifactId", async (request) => {
    const { projectId, artifactId } = z.object({ projectId: idSchema, artifactId: idSchema }).parse(request.params);
    return application.readExportArtifact({ projectId, artifactId });
  });

  const artifactFindingSchema = z.object({
    pass: z.enum(["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"]),
    severity: z.enum(["blocking", "warning", "major", "minor", "suggestion", "inconclusive"]),
    category: z.enum(["semantic", "pacing", "attention", "motion", "typography", "audio", "mode_specific"]),
    summary: z.string().min(1).max(2_000),
    evidence: z.string().min(1).max(2_000),
    impact: z.string().min(1).max(2_000),
    suggestedFix: z.string().max(2_000).optional(),
    verificationMethod: z.string().max(2_000).optional(),
    objectId: idSchema.optional(),
    frameRange: z.object({ startFrame: z.number().int().min(0), endFrame: z.number().int().positive() }).optional()
  });

  app.post("/api/projects/:projectId/export-artifacts/:artifactId/review", async (request) => {
    const { projectId, artifactId } = z.object({ projectId: idSchema, artifactId: idSchema }).parse(request.params);
    const body = z.object({
      passes: z.array(z.enum(["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"])).min(1).max(5),
      evidence: z.array(z.string().min(1).max(2_000)).min(1).max(40),
      findings: z.array(artifactFindingSchema).max(120)
    }).parse(request.body);
    return application.recordExportArtifactReview({ projectId, artifactId, ...body });
  });

  app.post("/api/projects/:projectId/export-artifacts/:artifactId/approve", async (request) => {
    const { projectId, artifactId } = z.object({ projectId: idSchema, artifactId: idSchema }).parse(request.params);
    const body = exportApprovalSchema.parse(request.body);
    return application.approveExportArtifact({ projectId, artifactId, ...body });
  });

  app.post("/api/projects/:projectId/revisions/:revision/rollback", async (request) => {
    const { projectId, revision } = z.object({ projectId: idSchema, revision: z.coerce.number().int().positive() }).parse(request.params);
    const body = z.object({ baseRevision: baseRevisionSchema }).parse(request.body);
    return application.rollbackToRevision({ projectId, targetRevision: revision, ...body });
  });

  app.post("/api/jobs/:jobId/retry", async (request, reply) => {
    const { jobId } = z.object({ jobId: idSchema }).parse(request.params);
    const oldJob = application.trackJob(jobId);
    // 只有明确未完成的终态可以重新入队。unknown 代表外部调用结果未对账，
    // 直接重试可能重复生成、重复扣费或造成两份不可区分的副作用。
    if (oldJob.status === "unknown") {
      throw new DomainError("任务结果未知；请先对账外部 Provider 或人工确认后再决定是否重试", "JOB_RETRY_REQUIRES_RECONCILIATION");
    }
    if (oldJob.status === "running" || oldJob.status === "queued") {
      throw new DomainError("任务仍在执行或等待执行，不能创建重复重试任务", "JOB_RETRY_NOT_TERMINAL");
    }
    if (oldJob.status === "succeeded") {
      throw new DomainError("任务已成功完成，不能创建重试任务", "JOB_RETRY_SUCCEEDED");
    }
    if (oldJob.status !== "failed" && oldJob.status !== "cancelled") {
      throw new DomainError(`任务状态 ${oldJob.status} 不支持重试`, "JOB_RETRY_STATUS_UNSUPPORTED");
    }
    if (oldJob.kind === "dialogue_processing") {
      const requestedRevision = (oldJob.payload as { requestedRevision?: unknown }).requestedRevision;
      const currentRevision = application.readProject(oldJob.projectId).revision.number;
      if (!Number.isInteger(requestedRevision) || requestedRevision !== currentRevision) {
        throw new DomainError("对白处理绑定的 SpeechAsset / Script Revision 已变化；请基于当前 Revision 重新试听并提交，而不是重试旧任务", "DIALOGUE_PROCESSING_RETRY_STALE");
      }
    }
    // 旧 VAD / token-only Job 只允许历史读取，不能通过通用重试重新创建。
    if (oldJob.kind === "source_caption_generation" || oldJob.kind === "source_caption_sentence_alignment") {
      throw new DomainError("旧原声字幕 Job 已停用；请读取当前 A-roll 后使用 generate_source_audio_captions", "SOURCE_CAPTION_LEGACY_JOB_DISABLED");
    }
    if (oldJob.kind === "source_caption_alignment") {
      const requestedRevision = oldJob.payload.requestedRevision;
      const currentRevision = application.readProject(oldJob.projectId).revision.number;
      if (!Number.isInteger(requestedRevision) || requestedRevision !== currentRevision) {
        throw new DomainError("原声字幕绑定的 A-roll Revision 已变化；请读取当前 Timeline 后明确重新提交，不能重试旧字幕任务", "SOURCE_CAPTION_RETRY_STALE");
      }
    }
    const retry = application.repository.createJob({
      projectId: oldJob.projectId,
      kind: oldJob.kind,
      // 转写和段级原声字幕重试必须携带来源 Job，Worker 才能恢复其 run_id，避免超时后重复提交外部运行。
      payload: ["transcription", "source_caption_alignment", "media_understanding", "media_search", "sound_ranking"].includes(oldJob.kind)
        ? { ...oldJob.payload, retryOfJobId: oldJob.id }
        : oldJob.payload,
      idempotencyKey: `${oldJob.idempotencyKey}:retry:${Date.now()}`
    });
    return reply.status(202).send(retry);
  });

  app.get("/api/events", async (request, reply) => {
    const query = z.object({ projectId: idSchema }).parse(request.query);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    reply.raw.write("retry: 1500\n\n");
    const unsubscribe = application.subscribe((event) => {
      if (event.projectId === query.projectId) reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on("close", unsubscribe);
    return reply;
  });

  // 审阅页面只包装现有受管文件；不导入素材、不创建 Job 或 Revision。
  app.get("/review/*", async (request, reply) => {
    const wildcard = (request.params as { "*": string })["*"];
    const mediaRoot = join(workspaceRoot, "projects");
    const filePath = resolve(mediaRoot, wildcard);
    assertPathWithin(mediaRoot, filePath);
    if (!existsSync(filePath) || !(await stat(filePath)).isFile()) throw new NotFoundError("媒体文件不存在");
    const mime = mimeByExtension[extname(filePath).toLowerCase()] ?? "";
    if (!mime.startsWith("video/") && !mime.startsWith("audio/")) throw new DomainError("审阅页面只支持音视频文件", "UNSUPPORTED_REVIEW_MEDIA");
    const mediaPath = `/media/${relative(mediaRoot, filePath).replace(/\\/gu, "/").split("/").map(encodeURIComponent).join("/")}`;
    const nonce = randomUUID();
    return reply.type("text/html; charset=utf-8")
      .header("content-security-policy", `default-src 'none'; media-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'self'`)
      .header("cache-control", "no-store")
      .send(mediaReviewPage(mediaPath, basename(filePath), mime.startsWith("audio/") ? "audio" : "video", nonce));
  });

  app.get("/media/*", async (request, reply) => {
    const wildcard = (request.params as { "*": string })["*"];
    const mediaRoot = join(workspaceRoot, "projects");
    const filePath = resolve(mediaRoot, wildcard);
    assertPathWithin(mediaRoot, filePath);
    if (!existsSync(filePath)) throw new NotFoundError("媒体文件不存在");
    const file = await stat(filePath);
    if (!file.isFile()) throw new NotFoundError("媒体路径不是可读取文件");
    const mime = mimeByExtension[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const byteRange = parseSingleByteRange(request.headers.range, file.size);
    if (byteRange === null) {
      return reply.code(416).header("content-range", `bytes */${file.size}`).send();
    }
    if (!byteRange) {
      return reply
        .code(200)
        .type(mime)
        .header("accept-ranges", "bytes")
        .header("content-length", String(file.size))
        .send(createReadStream(filePath));
    }
    const length = byteRange.end - byteRange.start + 1;
    return reply
      .code(206)
      .type(mime)
      .header("accept-ranges", "bytes")
      .header("content-range", `bytes ${byteRange.start}-${byteRange.end}/${file.size}`)
      .header("content-length", String(length))
      .send(createReadStream(filePath, byteRange));
  });

  if (options.serveWeb) {
    // 发行 Runtime 一定传入或设置 VIDEOFLOWCUT_WEB_ROOT。开发模式才允许沿用
    // 仓库 cwd 下的 Vite 目录，保证本地 `npm run runtime` 仍可直接调试。
    const configuredWebRoot = options.webRoot ?? runtimeConfig.runtime.webRoot;
    const webRoot = configuredWebRoot
      ? resolve(configuredWebRoot)
      : join(process.cwd(), "apps", "web", "dist");
    if (existsSync(webRoot)) {
      await app.register(staticPlugin, { root: webRoot, prefix: "/" });
      app.get("/", async (_request, reply) => reply.sendFile("index.html"));
    }
  }

  return { app, application };
}
