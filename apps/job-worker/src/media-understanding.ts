import { mkdir } from "node:fs/promises";
import { modelText, semanticConfig, restoreModelCheckpoints, rejectModelOutput } from "./model-http.js";
import { deriveMediaInput, documentPageCount, PREPROCESSING_VERSION } from "../../../packages/media-intelligence/src/derive.js";
import { measureAudioWindow } from "../../../packages/media-intelligence/src/acoustics.js";
import { parseSourceCaptionAlignmentOutput } from "@videocut/speech";
import { FUNASR_SOURCE_CAPTION_WORKFLOW_ID } from "@videocut/bridge";
import { assetRequestVersion } from "../../../packages/media-intelligence/src/index.js";
import { join } from "node:path";
import type { AssetProviderRegistry } from "@videocut/acquisition";
import { downloadHttpFile } from "@videocut/acquisition";
import type { EditingApplication } from "@videocut/application";
import { BridgeError, ComfyUIBridgeClient, type BridgeRunRequest, type BridgeWorkflow } from "@videocut/bridge";
import type { JobRecord, MediaAnalysisRecord, MediaObservation, MediaSource } from "@videocut/contracts";
import { assetById, DomainError, now } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";
import { hashMediaFile, managedSourcePath, renderedAnalysisSource } from "../../../packages/edit-application/src/media-intelligence.js";
import { ANALYSIS_VERSION, MODEL_WORKFLOWS, EMBEDDING_VERSION, analysisInputSchema, analysisPrompt, digest, parseObservation, planWindows, searchQuerySchema } from "../../../packages/media-intelligence/src/index.js";
import { mediaId } from "../../../packages/media-intelligence/src/store.js";
import { detectSceneBoundaries } from "../../../packages/media-intelligence/src/structure.js";
import { pruneMediaCache } from "../../../packages/media-intelligence/src/cache.js";

async function resolveSource(app: EditingApplication, job: JobRecord, providers: AssetProviderRegistry): Promise<MediaSource> {
  const input = analysisInputSchema.parse(job.payload.input);
  const state = app.readProject(job.projectId);
  let path: string, kind: MediaSource["kind"], identity: MediaSource["identity"];
  let composition: MediaSource["composition"];
  if (input.assetId) {
    const asset = assetById(state.snapshot, input.assetId);
    path = await managedSourcePath(state.snapshot.project.rootPath, asset.managedPath);
    const hash = await hashMediaFile(path);
    if (asset.sourceHash && hash !== job.payload.sourceVersion) throw new DomainError("源文件在提交分析后发生变化", "MEDIA_SOURCE_CHANGED");
    kind = asset.kind === "image" || asset.kind === "document" ? asset.kind : asset.kind === "audio" || asset.kind === "speech" ? "audio" : "video";
    identity = "original";
  } else if (input.exportArtifactId || input.previewJobId) {
    const rendered = await renderedAnalysisSource(app, job.projectId, input);
    if (rendered.hash !== job.payload.sourceVersion) throw new DomainError("提交后复核文件已变化", "MEDIA_SOURCE_CHANGED");
    path = rendered.path; composition = rendered.composition; kind = "video"; identity = "derived";
  } else {
    const { candidate, request } = app.readAssetCandidate({ projectId: job.projectId, assetCandidateId: input.candidateId! });
    if (digest([candidate.previewUrl, assetRequestVersion(request)]) !== job.payload.sourceVersion) throw new DomainError("候选或需求已更新，请重新分析", "MEDIA_CANDIDATE_CHANGED");
    // 只有 Provider 声明的媒体主机可用；不把任意网页 URL 交给下载器。
    const provider = providers.get(candidate.provider);
    const hosts: Record<string, string[]> = { mixkit: ["assets.mixkit.co"], freesound: ["cdn.freesound.org", "freesound.org"], pexels: ["videos.pexels.com", "images.pexels.com"] };
    const allowed = provider.previewHosts ?? hosts[candidate.provider];
    if (!allowed || !candidate.previewUrl) throw new DomainError("此 Provider 尚未提供受控预览分析", "MEDIA_PREVIEW_PROVIDER_UNSUPPORTED");
    const directory = join(state.snapshot.project.rootPath, "cache", "media-intelligence", job.id);
    const extension = candidate.kind === "audio" ? ".mp3" : candidate.kind === "image" ? ".jpg" : ".mp4";
    const download = await downloadHttpFile(candidate.previewUrl, directory, `preview${extension}`, candidate.kind, undefined, {}, { allowedHosts: allowed });
    path = download.filePath; kind = candidate.kind; identity = "preview";
  }
  const hash = await hashMediaFile(path);
  const metadata = kind === "document" ? undefined : await probeMedia(path);
  const probe = kind === "document" ? { streams: [] } : JSON.parse(await runProcess("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], 120_000));
  const source: MediaSource = {
    id: `media_source_${digest([job.projectId, input.assetId ?? input.candidateId ?? input.exportArtifactId ?? input.previewJobId, identity, hash])}`,
    projectId: job.projectId, target: input.assetId ? { assetId: input.assetId } : input.exportArtifactId ? { exportArtifactId: input.exportArtifactId } : input.previewJobId ? { previewJobId: input.previewJobId } : { candidateId: input.candidateId! }, identity, hash, path, kind, composition,
    durationMs: kind === "image" || kind === "document" ? 0 : metadata?.durationMs ?? 0,
    startSeconds: Number(probe.format?.start_time ?? 0), pageCount: kind === "document" ? await documentPageCount(path) : undefined, hasAudio: metadata?.hasAudio ?? false, width: metadata?.width, height: metadata?.height,
    streams: (probe.streams ?? []).map((stream: Record<string, unknown>) => ({ index: Number(stream.index), kind: String(stream.codec_type), timeBase: stream.time_base as string | undefined, startSeconds: Number(stream.start_time ?? 0), sampleRate: stream.sample_rate ? Number(stream.sample_rate) : undefined, rotation: Number((stream.side_data_list as Array<{ rotation?: number }> | undefined)?.find((entry) => entry.rotation !== undefined)?.rotation ?? 0) })), createdAt: now()
  };
  app.intelligence.store.saveSource(source);
  return source;
}

export const MEDIA_QUERY_INSTRUCTION = "根据中文检索需求，查找描述实际画面、声音或原文的相关素材片段。";
export async function embedBatch(app: EditingApplication, job: JobRecord, bridge: ComfyUIBridgeClient, texts: string[], mode: "document" | "query", key: string, instruction = MEDIA_QUERY_INSTRUCTION): Promise<number[][]> {
  const result = await modelText(app, job, bridge, key, semanticConfig(job).embeddingWorkflowId, async (schema) => {
    for (const id of ["texts_json", "mode"]) if (!schema.fields.some((field) => field.id === id)) throw new DomainError(`向量接口缺少 ${id}`, "MEDIA_MODEL_SCHEMA_UNSUPPORTED");
    const supportsInstruction = schema.fields.some((field) => field.id === "instruction");
    if (mode === "query" && instruction !== MEDIA_QUERY_INSTRUCTION && !supportsInstruction) throw new DomainError("向量工作流未提供任务指令字段，保留全文词法结果", "MOTION_INSTRUCTION_UNSUPPORTED");
    return { fieldValues: { texts_json: JSON.stringify(texts), mode, ...(mode === "query" && supportsInstruction ? { instruction } : {}) } };
  }, undefined, digest([texts, mode, instruction, semanticConfig(job)]));
  try {
    const vectors = JSON.parse(result.text!).embeddings as unknown;
    if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== 1024 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value)) || Math.abs(Math.hypot(...vector) - 1) > 0.02)) throw new DomainError("向量服务没有返回对应数量的归一化 1024 维向量", "MEDIA_EMBEDDING_INVALID");
    return vectors;
  } catch(error) {
    rejectModelOutput(app, job, key, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** 长文字按全部分块编码，再归一化聚合；不截掉否定词或后半段。 */
export async function encodeModelTexts(app: EditingApplication, job: JobRecord, bridge: ComfyUIBridgeClient, texts: string[], mode: "document" | "query", key: string): Promise<number[][]> {
  const pieces = texts.flatMap((text, owner) => Array.from({ length: Math.ceil(text.length / 1500) }, (_, index) => ({ owner, text: text.slice(index * 1500, (index + 1) * 1500) })));
  const sums = texts.map(() => Array<number>(1024).fill(0));
  for (let start = 0; start < pieces.length; start += 8) {
    const batch = pieces.slice(start, start + 8);
    const vectors = await embedBatch(app, job, bridge, batch.map((entry) => entry.text), mode, `${key}:${digest(batch)}`);
    batch.forEach((entry, index) => vectors[index].forEach((value, dimension) => { sums[entry.owner][dimension] += value * entry.text.length; }));
  }
  return sums.map((vector) => { const norm = Math.hypot(...vector); if (!norm) throw new DomainError("向量文本为空或编码无效", "MEDIA_EMBEDDING_INVALID"); return vector.map((value) => value / norm); });
}

export async function runMediaUnderstanding(app: EditingApplication, job: JobRecord, bridge: ComfyUIBridgeClient, providers: AssetProviderRegistry): Promise<Record<string, unknown>> {
  const input = analysisInputSchema.parse(job.payload.input);
  const config = semanticConfig(job);
  if (config.apiBaseUrl !== bridge.apiBaseUrl) bridge = new ComfyUIBridgeClient(config.apiBaseUrl);
  restoreModelCheckpoints(app, job);
  const store = app.intelligence.store;
  const snapshot = app.readProject(job.projectId).snapshot;
  const liveJobs = new Set(app.repository.listJobs(job.projectId).filter((entry) => ["queued", "running", "unknown"].includes(entry.status)).map((entry) => entry.id));
  // 恢复尚未创建新分析记录时，也要保护其旧检查点正在引用的输入。
  for (const id of [...liveJobs]) {
    let cursor = app.trackJob(id); const seen = new Set<string>();
    while (typeof cursor.payload.retryOfJobId === "string" && !seen.has(cursor.id) && seen.size < 100) {
      seen.add(cursor.id); cursor = app.trackJob(cursor.payload.retryOfJobId);
      if (cursor.projectId !== job.projectId) throw new DomainError("恢复引用跨越项目", "MEDIA_RETRY_MISMATCH");
      liveJobs.add(cursor.id);
    }
  }
  const historyAssets = app.repository.listRevisions(job.projectId).flatMap((revision) => app.repository.getRevision(job.projectId, revision.number).snapshot.assets.map((asset) => asset.managedPath));
  const cache = await pruneMediaCache(snapshot.project.rootPath, [...historyAssets, ...store.sources(job.projectId).filter((source) => store.analyses(job.projectId, source.id).some((record) => liveJobs.has(record.id))).map((source) => source.path), ...store.observations(job.projectId).filter((observation) => liveJobs.has(observation.jobId)).flatMap((observation) => observation.inputEvidence ? [observation.inputEvidence.path] : [])]);
  app.recordJobCheckpoint(job.id, { cache });
  let record = store.analysis(job.projectId, job.id);
  if (!record && job.payload.retryOfJobId) {
    const parent = store.analysis(job.projectId, String(job.payload.retryOfJobId));
    if (parent) { record = { ...parent, id: job.id, status: "running", updatedAt: now() }; store.saveAnalysis(record); }
  }
  const source = record ? store.source(job.projectId, record.sourceId)! : await resolveSource(app, job, providers);
  if (await hashMediaFile(source.path) !== source.hash) throw new DomainError("恢复分析时源内容已变化", "MEDIA_SOURCE_CHANGED");
  const modalities = input.modalities.filter((modality) => source.kind === "audio" ? modality === "audio" || modality === "speech" : !source.hasAudio ? modality === "visual" || modality === "text" : true);
  if (!modalities.length) throw new DomainError("实际输入不具备请求的模态", "MEDIA_MODALITY_UNAVAILABLE");
  if (!record) {
    const ranges = source.durationMs ? planWindows(source.durationMs, input.depth, input.range) : [];
    const targetRange = source.durationMs ? input.range ?? { startMs: 0, endMs: source.durationMs } : undefined;
    const boundaries = source.kind === "video" ? await detectSceneBoundaries(source.path) : [];
    const cuts = [...new Set([0, ...boundaries.map((boundary) => boundary.seconds * 1000).filter((time) => time > 0 && time < source.durationMs), source.durationMs])].sort((a, b) => a - b);
    record = { id: job.id, projectId: job.projectId, sourceId: source.id, key: String(job.payload.analysisKey), depth: input.depth, modalities, targetRange, context: input.context,
      windows: ranges.length ? ranges.map((range, index) => ({ id: `${job.id}:${index}`, range, status: "pending" })) : [{ id: `${job.id}:0`, region: input.region, status: "pending" }],
      shotRanges: source.kind === "video" ? cuts.slice(0, -1).map((startMs, index) => ({ startMs, endMs: cuts[index + 1] })) : [], status: "running", updatedAt: now() };
    store.saveAnalysis(record);
  }
  if (source.kind === "document" && !input.region && record.windows.length === 1 && !record.windows[0].region) {
    record.windows = Array.from({ length: source.pageCount! }, (_, index) => ({ id: `${job.id}:page:${index + 1}`, region: { page: index + 1, x: 0, y: 0, width: 1, height: 1 }, status: "pending" }));
    store.saveAnalysis(record);
  }
  let failed = false;
  for (const window of record.windows) {
    if (window.status === "succeeded") continue;
    const currentJob = app.trackJob(job.id);
    if (currentJob.status === "cancelled") throw new DomainError("分析已取消；已完成观察保留", "MEDIA_ANALYSIS_CANCELLED");
    try {
      window.modalityStatus = Object.fromEntries(input.modalities.map((modality) => [modality, modalities.includes(modality) ? "unknown" : "unavailable"]));
      const directory = join(app.readProject(job.projectId).snapshot.project.rootPath, "cache", "mi", digest([job.id, window.id]).slice(0, 24));
      const derived = await deriveMediaInput(source, directory, window.range, window.region, modalities.every((entry) => entry === "audio" || entry === "speech"));
      const kind = derived.kind;
      const workflowId = kind === "audio" ? config.audioWorkflowId : kind === "image" ? config.imageWorkflowId : config.videoWorkflowId;
      const currentSchema = await bridge.getWorkflow(workflowId);
      const reusable = store.observations(job.projectId).find((entry) => !entry.correction && entry.facts.length > 0 && entry.sourceHash === source.hash && digest(entry.range) === digest(window.range) && digest(entry.region) === digest(window.region) && entry.depth === input.depth && entry.context === record!.context && entry.version.model === config.modelRevision && entry.version.prompt === ANALYSIS_VERSION && entry.version.preprocessing === PREPROCESSING_VERSION && entry.version.workflowId === workflowId && entry.version.schemaVersion === currentSchema.schemaVersion && digest(entry.modalities) === digest(modalities));
      const prompt = analysisPrompt(modalities.filter((modality) => modality !== "speech"), window.range, input.depth === "review" ? record.context : undefined);
      const requestIdentity = digest([source.hash, window.range, window.region, modalities, config.modelRevision, ANALYSIS_VERSION, PREPROCESSING_VERSION, prompt]);
      const response = reusable ? { text: reusable.rawText, schemaVersion: reusable.version.schemaVersion, runId: reusable.runId } : await modelText(app, job, bridge, `window:${window.id}`, workflowId, async (schema) => {
        const slot = bridge.findRequiredSlot(schema, kind);
        const fields: Record<string, unknown> = {};
        const available = new Set(schema.fields.map((field) => field.id));
        if (!available.has("prompt")) throw new DomainError("分析工作流缺少 prompt 字段", "MEDIA_MODEL_SCHEMA_UNSUPPORTED");
        fields.prompt = prompt;
        if (available.has("max_new_tokens")) fields.max_new_tokens = 4096;
        if (window.range) {
          if (!available.has("start_seconds") || !available.has("duration_seconds")) throw new DomainError("分析接口缺少真实源时间窗口", "MEDIA_MODEL_SCHEMA_UNSUPPORTED");
          fields.start_seconds = 0;
          fields.duration_seconds = (window.range.endMs - window.range.startMs) / 1000;
        }
        return { fieldValues: fields, files: [{ slot, path: derived.path, mime: kind === "audio" ? "audio/wav" : kind === "image" ? "image/png" : "video/mp4" }] };
      }, undefined, requestIdentity);
      const parsed = parseObservation(response.text!, window.range, modalities.filter((modality) => modality !== "speech"));
      if (!parsed.facts.length && modalities.some((modality) => modality !== "speech")) rejectModelOutput(app, job, `window:${window.id}`, parsed.unknowns.join("；") || "没有可校验的观察事实");
      const observation: MediaObservation = { id: `observation_${digest([window.id, response.runId])}`, projectId: job.projectId, sourceId: source.id, sourceHash: source.hash, range: window.range, region: window.region, depth: input.depth, modalities, ...parsed,
        context: record.context, promptText: prompt, rawText: response.text!, version: { workflowId, schemaVersion: response.schemaVersion, model: config.modelRevision, prompt: ANALYSIS_VERSION, preprocessing: PREPROCESSING_VERSION }, jobId: job.id, runId: response.runId, inputEvidence: { path: derived.path, hash: await hashMediaFile(derived.path), mapping: derived.mapping }, createdAt: now() };
      observation.reusedFromObservationId = reusable?.id;
      if (window.region) observation.facts.forEach((fact) => { fact.region = window.region; });
      for (const fact of observation.facts) window.modalityStatus![fact.modality] = "observed";
      if (source.hasAudio && window.range) {
        observation.audioMeasurements = await measureAudioWindow(source, window.range, directory);
        if (modalities.includes("speech")) {
          try {
            const audio = kind === "audio" ? derived : await deriveMediaInput(source, join(directory, "speech"), window.range, undefined, true);
            const transcript = await modelText(app, job, bridge, `speech:${window.id}`, FUNASR_SOURCE_CAPTION_WORKFLOW_ID, async (schema) => ({ fieldValues: {}, files: [{ slot: bridge.findRequiredSlot(schema, "audio"), path: audio.path, mime: "audio/wav" }] }), "caption-alignment-json");
            const result = parseSourceCaptionAlignmentOutput(transcript.text!);
            for (const segment of result.segments) {
              if (segment.startMs < 0 || segment.endMs > window.range.endMs - window.range.startMs + 50 || segment.endMs <= segment.startMs) throw new DomainError("转写时间超出真实输入窗口", "MEDIA_TRANSCRIPT_RANGE_INVALID");
              observation.facts.push({ modality: "speech", text: segment.displayText, range: { startMs: window.range.startMs + segment.startMs, endMs: Math.min(window.range.endMs, window.range.startMs + segment.endMs) }, basis: "transcript", precision: "provider_timed", keywords: [] });
            }
            observation.speechEvidence = { rawText: transcript.text!, runId: transcript.runId!, schemaVersion: transcript.schemaVersion, tokenPrecision: result.tokenPrecision };
            window.modalityStatus!.speech = "observed";
          } catch (error) {
            if (error instanceof DomainError && ["EXTERNAL_RUN_OUTCOME_UNKNOWN", "MEDIA_ANALYSIS_CANCELLED"].includes(error.code)) throw error;
            observation.unknowns.push(`语音未完成真实转写：${error instanceof Error ? error.message : String(error)}`);
            observation.modalities = modalities.filter((modality) => modality !== "speech");
            window.modalityStatus!.speech = "failed";
          }
        }
      }
      // 恢复可能补回 ASR 等模态；内容改变必须产生新观察，不能被旧不可变 ID 吞掉。
      observation.id = `observation_${digest([window.id, source.id, response.runId, observation.version, observation.facts, observation.unknowns, observation.speechEvidence])}`;
      store.saveObservation(observation);
      window.observationId = observation.id;
      window.runId = response.runId; window.workflowId = workflowId; window.schemaVersion = response.schemaVersion;
      if (!observation.facts.length) throw new DomainError("本窗口没有通过校验的事实，原文可读，覆盖仍未完成", "MEDIA_OBSERVATION_INVALID");
      if (Object.values(window.modalityStatus!).includes("failed")) throw new DomainError("声画观察已保存，但所请求语音转写失败；该模态覆盖未完成", "MEDIA_MODALITY_INCOMPLETE");
      window.status = "succeeded"; window.error = undefined;
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      window.status = error instanceof DomainError && error.code === "EXTERNAL_RUN_OUTCOME_UNKNOWN" ? "unknown" : "failed";
      window.error = message;
      // 接口不可用时不把整个长片队列反复提交；保留剩余窗口供恢复。
      if (error instanceof BridgeError || window.status === "unknown" || error instanceof DomainError && error.code === "MEDIA_MODEL_INPUT_UNAVAILABLE") break;
    } finally {
      record.updatedAt = now(); store.saveAnalysis(record);
      const latest = app.trackJob(job.id);
      app.updateJob(job.id, { status: latest.status, result: { ...latest.result, analysisId: record.id, sourceId: source.id, completedWindows: record.windows.filter((entry) => entry.status === "succeeded").length, totalWindows: record.windows.length } });
    }
  }
  record.status = record.windows.every((window) => window.status === "succeeded") ? "succeeded" : record.windows.some((window) => window.status === "unknown") ? "unknown" : record.windows.some((window) => window.status === "succeeded") ? "partial" : "failed";
  store.saveAnalysis(record);
  if (failed || record.status !== "succeeded") throw new DomainError(record.windows.find((window) => window.error)?.error ?? "分析未完成", record.status === "unknown" ? "EXTERNAL_RUN_OUTCOME_UNKNOWN" : "MEDIA_ANALYSIS_INCOMPLETE");
  return { ...app.trackJob(job.id).result, analysisId: record.id, sourceId: source.id, coverage: app.intelligence.inspect(job.projectId, source.target).coverage };
}

export async function runMediaSearch(app: EditingApplication, job: JobRecord, bridge: ComfyUIBridgeClient): Promise<Record<string, unknown>> {
  const query = searchQuerySchema.parse(job.payload.query);
  const config = semanticConfig(job);
  if (config.apiBaseUrl !== bridge.apiBaseUrl) bridge = new ComfyUIBridgeClient(config.apiBaseUrl);
  const store = app.intelligence.store;
  const sources = new Set(store.sources(job.projectId).filter((source) => (!query.assetIds || Boolean(source.target.assetId && query.assetIds.includes(source.target.assetId))) && (!query.candidateIds || Boolean(source.target.candidateId && query.candidateIds.includes(source.target.candidateId)))).map((source) => source.id));
  const version = `qwen3-embedding-0.6b:${config.embeddingRevision}`;
  const pending = store.observations(job.projectId).filter((observation) => sources.has(observation.sourceId)).flatMap((observation) => observation.facts.filter((fact) => fact.modality === query.modality).map((fact) => ({ observation, text: `${fact.text} ${fact.keywords.join(" ")}` })))
    .filter((entry) => !store.vector(entry.observation.id, `${query.modality}:${digest(entry.text)}`, version, digest(entry.text)));
  for (let start = 0; start < pending.length; start += 8) {
    const batch = pending.slice(start, start + 8);
    const vectors = await encodeModelTexts(app, job, bridge, batch.map((entry) => entry.text), "document", `documents:${digest(batch.map((entry) => [entry.observation.id, entry.text]))}`);
    batch.forEach((entry, index) => store.saveVector(entry.observation.id, `${query.modality}:${digest(entry.text)}`, version, digest(entry.text), vectors[index]));
  }
  const [vector] = await encodeModelTexts(app, job, bridge, [query.query], "query", `query:${digest(query.query)}`);
  return { ...app.trackJob(job.id).result, ...app.intelligence.search(job.projectId, query, vector, version) };
}
