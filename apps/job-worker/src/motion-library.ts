import { resolve, join } from "node:path";
import type { EditingApplication } from "@videocut/application";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import type { JobRecord } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";
import { loadLibraryIndex, searchLibraryIndex, libraryVideo } from "../../../references/motion-cases/skillry/tools/library-store.mjs";
import { cosine, digest, timeRangeSchema } from "../../../packages/media-intelligence/src/index.js";
import { mechanismChunks, motionCacheKey, MOTION_QUERY_INSTRUCTION, MOTION_INSTRUCTION_VERSION, MOTION_VIDEO_PROMPT } from "../../../packages/media-intelligence/src/motion-library.js";
import { deriveMediaInput, PREPROCESSING_VERSION } from "../../../packages/media-intelligence/src/derive.js";
import { hashMediaFile } from "../../../packages/edit-application/src/media-intelligence.js";
import { embedBatch } from "./media-understanding.js";
import { semanticConfig, modelText } from "./model-http.js";

const libraryRoot = () => resolve(process.cwd(), "references/motion-cases/skillry");
export async function runMotionLibrarySearch(app: EditingApplication, job: JobRecord, bridge: ComfyUIBridgeClient): Promise<Record<string, unknown>> {
  const started = Date.now(), index = loadLibraryIndex(libraryRoot());
  if (index.source_sha256 !== job.payload.source_sha256) throw new DomainError("机制原文已变化，请重新检索", "MOTION_LIBRARY_STALE");
  const request = job.payload.request as Record<string, unknown>;
  // 参数校验先于任何模型提交。
  searchLibraryIndex(index, request);
  const config = semanticConfig(job);
  if (bridge.apiBaseUrl !== config.apiBaseUrl) bridge = new ComfyUIBridgeClient(config.apiBaseUrl);
  const schema = await bridge.getWorkflow(config.embeddingWorkflowId);
  if (!schema.fields.some(field => field.id === "instruction")) throw new DomainError("向量工作流未提供任务指令字段", "MOTION_INSTRUCTION_UNSUPPORTED");
  const version = { ...config, schema: schema.schemaVersion }, store = app.intelligence.store;
  let encoded = 0, cacheHits = 0;
  const documents = index.mechanisms.flatMap(mechanism => mechanismChunks(mechanism.search_text).map((text, chunk) => ({ id: mechanism.id, chunk, text, key: motionCacheKey(index.source_sha256, [mechanism.id, mechanism.text_sha256, chunk, text], version, "document"), vector: undefined as number[] | undefined })));
  for (const entry of documents) { entry.vector = store.libraryCache<number[]>(entry.key); if (entry.vector) cacheHits++; }
  const missing = documents.filter(entry => !entry.vector);
  for (let i = 0; i < missing.length; i += 8) {
    const batch = missing.slice(i, i + 8);
    const vectors = await embedBatch(app, job, bridge, batch.map(entry => entry.text), "document", `motion-doc:${digest(batch.map(entry => entry.key))}`, MOTION_QUERY_INSTRUCTION);
    batch.forEach((entry, j) => { entry.vector = vectors[j]; store.saveLibraryCache(entry.key, entry.vector); });
    encoded += batch.length;
    app.recordJobCheckpoint(job.id, { motionIndex: { completed: cacheHits + encoded, total: documents.length, source_sha256: index.source_sha256 } });
  }
  const source = index.mechanisms.find(entry => entry.id === (request.similar_to ?? request.before ?? request.after));
  const queries = request.stages as string[] | undefined ?? [String(request.query ?? source?.search_text ?? "")];
  const pools: Record<string, Array<{ id: string; score: number }>> = {};
  for (const query of queries) {
    const key = motionCacheKey(index.source_sha256, query.trim().normalize("NFC"), version, "query");
    let vector = store.libraryCache<number[]>(key);
    if (vector) cacheHits++;
    else { [vector] = await embedBatch(app, job, bridge, [query], "query", key, MOTION_QUERY_INSTRUCTION); store.saveLibraryCache(key, vector); encoded++; }
    // 精确扫描全库，分块保留机制身份，以最佳完整行为命中归并。
    const scores = new Map<string, number>();
    for (const entry of documents) scores.set(entry.id, Math.max(scores.get(entry.id) ?? -1, cosine(vector, entry.vector!)));
    pools[query] = [...scores].map(([id, score]) => ({ id, score }));
  }
  const result = searchLibraryIndex(index, request, request.stages ? pools : { candidates: pools[queries[0]] });
  return { ...result, diagnostics: { mode: "hybrid", semantic_used: true, model: config.embeddingRevision, workflow: config.embeddingWorkflowId, schema: schema.schemaVersion, instruction_version: MOTION_INSTRUCTION_VERSION, source_sha256: index.source_sha256, document_chunks: documents.length, cache_hits: cacheHits, encoded_texts: encoded, elapsed_ms: Date.now() - started } };
}

/** 只允许库编号和源范围；不接收任意文件路径，不创建项目素材或观察。 */
export async function runMotionReferenceAnalysis(app: EditingApplication, job: JobRecord, bridge: ComfyUIBridgeClient): Promise<Record<string, unknown>> {
  const id = String(job.payload.id), fingerprint = String(job.payload.source_sha256);
  const path = libraryVideo(libraryRoot(), id, fingerprint), range = timeRangeSchema.parse(job.payload.range);
  const metadata = await probeMedia(path);
  if (range.endMs > metadata.durationMs || range.endMs - range.startMs > 15000) throw new DomainError("原片分析范围必须在文件内且不超过15秒", "MOTION_REFERENCE_RANGE_INVALID");
  const hash = await hashMediaFile(path), config = semanticConfig(job);
  if (bridge.apiBaseUrl !== config.apiBaseUrl) bridge = new ComfyUIBridgeClient(config.apiBaseUrl);
  const schema = await bridge.getWorkflow(config.videoWorkflowId);
  const key = digest([id, fingerprint, hash, range, config, schema.schemaVersion, MOTION_VIDEO_PROMPT, PREPROCESSING_VERSION]);
  const cached = app.intelligence.store.libraryCache<Record<string, unknown>>(`motion-video:${key}`);
  if (cached) return { ...cached, cache_hit: true };
  const probe = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-show_format", "-of", "json", path], 120000));
  const directory = join(app.getProjectRoot(job.projectId), "cache", "motion-reference", key);
  const derived = await deriveMediaInput({ id: `library:${id}`, hash, path, kind: "video", hasAudio: false, startSeconds: Number(probe.format?.start_time ?? 0) }, directory, range);
  const inputFrames = JSON.parse(await runProcess("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,avg_frame_rate", "-of", "json", derived.path], 120000));
  const response = await modelText(app, job, bridge, `motion-video:${key}`, config.videoWorkflowId, async workflow => {
    for (const field of ["prompt", "start_seconds", "duration_seconds"]) if (!workflow.fields.some(entry => entry.id === field)) throw new DomainError(`原片理解接口缺少${field}`, "MEDIA_MODEL_SCHEMA_UNSUPPORTED");
    return { fieldValues: { prompt: MOTION_VIDEO_PROMPT, start_seconds: 0, duration_seconds: (range.endMs - range.startMs) / 1000 }, files: [{ slot: bridge.findRequiredSlot(workflow, "video"), path: derived.path, mime: "video/mp4" }] };
  }, undefined, key);
  const result = { id, source_sha256: fingerprint, source_hash: hash, range, description: response.text, model: config.modelRevision, schema: response.schemaVersion, run_id: response.runId, input: { path: derived.path, mapping: derived.mapping, streams: inputFrames.streams }, sampling: { model_frame_density: "unknown", limitation: "派生片段帧数不等于模型实际抽样；未返回模型采样证据，快速交叠与精确速度保持未知。" }, cache_hit: false };
  app.intelligence.store.saveLibraryCache(`motion-video:${key}`, result);
  return result;
}
