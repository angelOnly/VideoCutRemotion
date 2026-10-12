import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyInstance } from "fastify";
import type { EditingApplication } from "@videocut/application";
import { createDefaultAssetProviderRegistry, soundSourceCapabilities } from "@videocut/acquisition";
import { DomainError } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import { z } from "zod";
import { audioDesignSchema, manageSoundPlan, soundPlanInputSchema, soundRequirementSchema } from "../../../packages/edit-application/src/sound-design.js";
import { assetRequestVersion, digest } from "../../../packages/media-intelligence/src/index.js";
import { soundComparisonSchema, reviewSoundMix, soundDependencySignature } from "../../../packages/edit-application/src/sound-review.js";
import { audioMixGainSchema, setAudioMixGain } from "../../../packages/edit-application/src/audio-mix-gain.js";
import { setDialogueMuted } from "../../../packages/edit-application/src/dialogue-muted.js";

const rankSchema = z.object({ assetRequestId: z.string().min(1), candidateIds: z.array(z.string().min(1)).min(1).max(30), analyzeTop: z.number().int().min(0).max(5).default(3) }).strict();
function rank(app: EditingApplication, projectId: string, input: z.infer<typeof rankSchema>) {
  const state = app.readProject(projectId), request = state.snapshot.assetRequests.find((entry) => entry.id === input.assetRequestId);
  if (!request || request.mediaKind !== "audio" || request.status === "closed") throw new DomainError("需要有效声音需求", "ASSET_REQUEST_NOT_FOUND");
  const config = readRuntimeConfig();
  const modelConfig = { ...config.semantic, apiBaseUrl: config.bridge.apiBaseUrl };
  const requestVersion = assetRequestVersion(request);
  const job = app.repository.createJob({ projectId, kind: "sound_ranking", payload: { ...input, requestVersion, modelConfig }, idempotencyKey: `sound_ranking:${digest([input, requestVersion, modelConfig])}` });
  app.publish({ projectId, revision: state.revision.number, type: "job" });
  return job;
}
function compare(app: EditingApplication, projectId: string, value: z.infer<typeof soundComparisonSchema>) {
  const input = soundComparisonSchema.parse(value);
  const state = app.readProject(projectId);
  if (input.revision !== state.revision.number) throw new DomainError("试听请求版本已过期", "REVISION_CONFLICT");
  if (input.toFrame > state.snapshot.timeline.durationInFrames) throw new DomainError("试听范围超出成片", "INVALID_PREVIEW_RANGE");
  const job = app.repository.createJob({ projectId, kind: "sound_comparison", payload: { ...input, dependencySignature: soundDependencySignature(state.snapshot) }, idempotencyKey: `sound_comparison:${digest(input)}` });
  app.publish({ projectId, revision: state.revision.number, type: "job" });
  return job;
}
const mixReviewSchema = z.object({ baseRevision: z.number().int().positive(), previewJobId: z.string().min(1), outcome: z.enum(["passed", "failed", "inconclusive"]), method: z.enum(["audio", "audiovisual"]), note: z.string().trim().min(16).max(4000) }).strict();
const audioOutputTargetSchema = z.object({ targetLufs: z.number().min(-32).max(-8), toleranceLu: z.number().min(0.1).max(10), maxTruePeakDbfs: z.number().min(-12).max(0) }).strict();
function outputTarget(app: EditingApplication, projectId: string, baseRevision: number, target: z.infer<typeof audioOutputTargetSchema>) {
  const state = app.repository.commit(projectId, baseRevision, "设置音频输出测量目标", (snapshot, impact) => { snapshot.audioOutputTarget = audioOutputTargetSchema.parse(target); impact.changed.push("audioOutputTarget"); });
  app.publish({ projectId, revision: state.revision.number, type: "revision" });
  return state;
}

export function registerSoundTools(server: McpServer, app: EditingApplication, projectIdFrom: (value?: string) => string) {
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const safely = async (work: () => unknown) => { try { return result(await work()); } catch (error) { return { ...result({ error: error instanceof Error ? error.message : String(error), code: error instanceof DomainError ? error.code : undefined }), isError: true }; } };
  server.registerTool("set_dialogue_muted", { title: "设置旁白轨静音", description: "可逆设置整个 Dialogue 轨的静音状态，Preview、Export 和 Web 共用轨道 muted 合同；保留音频素材、Script、字幕、时序和其他音轨。字幕需另行显隐，其他轨原声仍可能可听；恢复后不会自动获得声音来源或用途批准。写入当前 Revision 并使整片声音待复核。", inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), muted: z.boolean() } }, async (args) => safely(() => setDialogueMuted(app, projectIdFrom(args.project_id), args.base_revision_id, args.muted)));
  server.registerTool("set_audio_output_target", { title: "设置最终音频指标", description: "保存项目响度与 true peak 目标，正式输出按实际文件测量。此操作不改变音量，不把规范化当成素材选择或混合听审。", inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), target: audioOutputTargetSchema } }, async (args) => safely(() => outputTarget(app, projectIdFrom(args.project_id), args.base_revision_id, args.target)));
  server.registerTool("set_audio_mix_gain", { title: "设置整体混合增益", description: "将最终混合增益设为绝对 dB 值（-48 到 24，0 为恢复原混合），不会累加或修改各轨比例、时间、Duck 与包络。写入新 Revision 并使全片混合待复核；正式 Preview 与 Export 在最终混合后应用一次。不会自动限制峰值或归一化，需重新读取全片实际响度和 true peak。", inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), gain_db: audioMixGainSchema } }, async (args) => safely(() => setAudioMixGain(app, projectIdFrom(args.project_id), args.base_revision_id, args.gain_db)));
  server.registerTool("manage_sound_plans", { title: "管理段落声音计划", description: "在真实旁白和作品制作前确定段落主声音、表演意图、动作功能、音乐与留白。create 必须提供完整 startFrame/endFrame、narrationDirection、dominantRole、musicDirection 和 intents；配音前按项目 fps 提交预估帧范围，配音后用 update 按实测时长修订。update/remove 必须提供 soundPlanId，update 可只传待改字段。无 input 只读；写入必须提供当前 base_revision_id。", inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive().optional(), input: soundPlanInputSchema.optional() } }, async (args) => safely(() => {
    const id = projectIdFrom(args.project_id);
    if (!args.input) return { revision: app.readProject(id).revision.number, plans: app.readProject(id).snapshot.soundPlans ?? [] };
    if (!args.base_revision_id) throw new DomainError("写计划需要当前 Revision", "REVISION_REQUIRED");
    return manageSoundPlan(app, id, args.base_revision_id, args.input);
  }));
  server.registerTool("recommend_sound_candidates", { title: "比较有限声音候选", description: "对同一需求的至多30条在线元数据用 Qwen 排序，最多为前5条创建原音频分析 Job。排名不是听感成绩；完成子任务后用 read_media_observations/search_media_fragments 检查实际声音、范围和排除条件，再获取及复核原文件。", inputSchema: { project_id: z.string().optional(), input: rankSchema } }, async (args) => safely(() => rank(app, projectIdFrom(args.project_id), args.input)));
  server.registerTool("preview_sound_alternatives", { title: "同段声画比较", description: "固定 Revision、旁白、音乐和上下文范围，对已入库原文件生成A/B及不使用该音效的试听。使用正式 manage_audio 的计算和同一渲染器，不改变 Timeline。", inputSchema: { project_id: z.string().optional(), input: soundComparisonSchema } }, async (args) => safely(() => compare(app, projectIdFrom(args.project_id), args.input)));
  server.registerTool("review_sound_mix", { title: "记录实际混合复核", description: "根据已经实际听过或看听过的正式 Preview 记录结论，校验文件版本和覆盖。模型推测或候选试听不能自动使正式混合通过。", inputSchema: { project_id: z.string().optional(), input: mixReviewSchema } }, async (args) => safely(() => reviewSoundMix(app, projectIdFrom(args.project_id), args.input)));
}

export function registerSoundRoutes(server: FastifyInstance, app: EditingApplication) {
  const id = (params: unknown) => z.object({ projectId: z.string().min(1) }).parse(params).projectId;
  server.post("/api/projects/:projectId/dialogue-muted", async (request) => { const input = z.object({ baseRevision: z.number().int().positive(), muted: z.boolean() }).strict().parse(request.body); return setDialogueMuted(app, id(request.params), input.baseRevision, input.muted); });
  server.get("/api/sound-sources", async () => soundSourceCapabilities());
  server.get("/api/projects/:projectId/sound-library", async (request) => {
    const projectId = id(request.params), state = app.readProject(projectId);
    return { revision: state.revision.number, plans: state.snapshot.soundPlans ?? [], sessions: app.repository.mediaIntelligence.searches(projectId).filter((session) => session.candidates.some((candidate) => candidate.kind === "audio")), sources: soundSourceCapabilities(), requests: state.snapshot.assetRequests.filter((entry) => entry.mediaKind === "audio") };
  });
  server.post("/api/projects/:projectId/sound-plans", async (request) => { const input = z.object({ baseRevision: z.number().int().positive(), plan: soundPlanInputSchema }).strict().parse(request.body); return manageSoundPlan(app, id(request.params), input.baseRevision, input.plan); });
  server.post("/api/projects/:projectId/sound-search", async (request) => {
    const input = z.object({ assetRequestId: z.string().min(1), provider: z.string().min(1), query: z.string().min(1).max(400) }).strict().parse(request.body);
    const projectId = id(request.params), state = app.readProject(projectId), requirement = state.snapshot.assetRequests.find((entry) => entry.id === input.assetRequestId);
    if (!requirement || requirement.mediaKind !== "audio") throw new DomainError("需要已有声音需求", "ASSET_REQUEST_NOT_FOUND");
    if (requirement.status === "closed") throw new DomainError("素材需求已关闭，不能发起新搜索", "ASSET_REQUEST_CLOSED");
    const candidates = await createDefaultAssetProviderRegistry().get(input.provider).search({ request: requirement, query: input.query });
    return app.recordAssetSearch({ projectId, baseRevision: state.revision.number, ...input, candidates, requestVersion: assetRequestVersion(requirement), requestSnapshot: requirement });
  });
  server.post("/api/projects/:projectId/sound-rank", async (request, reply) => reply.code(202).send(rank(app, id(request.params), rankSchema.parse(request.body))));
  server.post("/api/projects/:projectId/sound-comparison", async (request, reply) => reply.code(202).send(compare(app, id(request.params), soundComparisonSchema.parse(request.body))));
  server.post("/api/projects/:projectId/sound-mix-review", async (request) => reviewSoundMix(app, id(request.params), mixReviewSchema.parse(request.body)));
  server.post("/api/projects/:projectId/sound-acquire", async (request, reply) => { const input = z.object({ baseRevision: z.number().int().positive(), assetCandidateId: z.string().min(1) }).strict().parse(request.body); return reply.code(202).send(app.acquireAssetCandidate({ projectId: id(request.params), ...input })); });
  server.post("/api/projects/:projectId/sound-requirement", async (request) => {
    const input = z.object({ baseRevision: z.number().int().positive(), title: z.string().min(1).max(160), audioBrief: z.string().min(1).max(1600), role: z.enum(["sfx", "bgm"]), sound: soundRequirementSchema.optional() }).strict().parse(request.body);
    return app.manageAssetRequirement({ projectId: id(request.params), ...input, action: "create", mediaKind: "audio", purpose: input.audioBrief, queryHints: [], excludedTerms: [], fallbackPlan: "ask_user" });
  });
  server.post("/api/projects/:projectId/audio-output-target", async (request) => { const input = z.object({ baseRevision: z.number().int().positive(), target: audioOutputTargetSchema }).strict().parse(request.body); return outputTarget(app, id(request.params), input.baseRevision, input.target); });
  server.post("/api/projects/:projectId/audio-mix-gain", async (request) => { const input = z.object({ baseRevision: z.number().int().positive(), gainDb: audioMixGainSchema }).strict().parse(request.body); return setAudioMixGain(app, id(request.params), input.baseRevision, input.gainDb); });
}
