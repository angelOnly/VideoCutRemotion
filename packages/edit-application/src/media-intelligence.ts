import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { assetById, createId, DomainError, now } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import { probeMedia } from "@videocut/speech";
import { assetRequestVersion, intersection, regionContains } from "../../media-intelligence/src/index.js";
import type { MediaFact, MediaObservation, MediaSearchQuery, MediaSource, SourceRegion, SourceTimeRange } from "@videocut/contracts";
import { analysisInputSchema, ANALYSIS_VERSION, cosine, digest, EMBEDDING_VERSION, factSchema, matchObservation, regionSchema, searchQuerySchema, timeRangeSchema, uncoveredRanges, type AnalysisInput } from "../../media-intelligence/src/index.js";
import type { EditingApplication } from "./index.js";

export async function hashMediaFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function managedSourcePath(root: string, path: string): Promise<string> {
  const base = await realpath(root), source = await realpath(isAbsolute(path) ? path : join(root, path));
  const local = relative(base, source);
  if (local.startsWith("..") || isAbsolute(local)) throw new DomainError("素材必须位于受管项目目录", "MEDIA_SOURCE_OUTSIDE_PROJECT");
  return source;
}

/** 只读绑定不可变输出；不为审片重新导入素材或创建视频版本。 */
export async function renderedAnalysisSource(app: EditingApplication, projectId: string, input: Pick<AnalysisInput, "exportArtifactId" | "previewJobId">) {
  const root = app.getProjectRoot(projectId);
  const artifact = input.exportArtifactId ? app.readExportArtifact({ projectId, artifactId: input.exportArtifactId }) : undefined;
  const job = app.trackJob(artifact?.jobId ?? input.previewJobId!);
  if (job.projectId !== projectId || job.status !== "succeeded" || job.kind !== (artifact ? "export" : "preview")) throw new DomainError("复核来源必须为本项目成功的导出或预览", "MEDIA_REVIEW_SOURCE_INVALID");
  const revision = artifact?.revision ?? Number(job.payload.revision);
  const snapshot = app.repository.getRevision(projectId, revision).snapshot;
  const fromFrame = artifact ? 0 : Number(job.payload.fromFrame), toFrame = artifact ? snapshot.timeline.durationInFrames : Number(job.payload.toFrame);
  const rawPath = artifact?.relativePath ?? job.result?.path;
  if (typeof rawPath !== "string" || !Number.isInteger(fromFrame) || !Number.isInteger(toFrame) || fromFrame < 0 || toFrame <= fromFrame || toFrame > snapshot.timeline.durationInFrames || (!artifact && (job.result?.revision !== revision || job.result?.fromFrame !== fromFrame || job.result?.toFrame !== toFrame))) throw new DomainError("复核文件缺少一致的版本与范围", "MEDIA_REVIEW_SOURCE_INVALID");
  const path = await managedSourcePath(root, rawPath), hash = await hashMediaFile(path), file = await stat(path);
  if (!file.isFile() || file.size <= 0 || artifact && (hash !== artifact.fileHash || file.size !== artifact.fileSizeBytes)) throw new DomainError("成片已丢失或替换，不能沿用原导出身份", "MEDIA_REVIEW_SOURCE_CHANGED");
  return { path, hash, composition: { revision, fromFrame, toFrame, fps: snapshot.timeline.fps } };
}

/** Web、MCP 和 Worker 使用同一可选分析规则，不建立第二份项目快照。 */
export class MediaIntelligenceApplication {
  constructor(private readonly app: EditingApplication) {}
  get store() { return this.app.repository.mediaIntelligence; }

  retry(projectId: string, jobId: string) {
    const previous = this.app.trackJob(jobId);
    if (previous.projectId !== projectId || !["media_understanding", "media_search", "motion_library_search", "motion_reference_analysis", "sound_ranking"].includes(previous.kind) || !["failed", "cancelled"].includes(previous.status)) throw new DomainError("只能恢复此项目明确失败或已取消的素材任务", "MEDIA_RETRY_INVALID");
    const retry = this.app.repository.createJob({ projectId, kind: previous.kind, payload: { ...previous.payload, retryOfJobId: previous.id }, idempotencyKey: `media-retry:${previous.id}` });
    this.app.publish({ projectId, revision: this.app.readProject(projectId).revision.number, type: "job" });
    return retry;
  }

  async submitAnalysis(projectId: string, value: AnalysisInput) {
    const input = analysisInputSchema.parse(value);
    const state = this.app.readProject(projectId);
    let sourceVersion: string;
    if (input.assetId) {
      const asset = assetById(state.snapshot, input.assetId);
      if (asset.status !== "ready") throw new DomainError("先完成源文件技术分析", "MEDIA_SOURCE_NOT_READY");
      if (asset.motion) throw new DomainError("请分析受管作品的真实预览或最终合成文件", "MEDIA_SOURCE_NOT_PLAYABLE");
      if (["image", "document"].includes(asset.kind) && input.range) throw new DomainError("图片和文档使用区域/页码，不使用视频时间", "MEDIA_RANGE_KIND_MISMATCH");
      if (!["image", "document"].includes(asset.kind) && input.region) throw new DomainError("视频/音频分析使用源时间范围", "MEDIA_RANGE_KIND_MISMATCH");
      sourceVersion = asset.sourceHash ?? digest([asset.managedPath, asset.metadata]);
    } else if (input.exportArtifactId || input.previewJobId) {
      const rendered = await renderedAnalysisSource(this.app, projectId, input);
      if (input.range) {
        // 复核范围属于实际文件；编码后的音轨尾部可略长于画面帧范围，不能按帧数截断核听。
        const media = await probeMedia(rendered.path);
        if (!Number.isFinite(media.durationMs) || media.durationMs! <= 0 || input.range.endMs > media.durationMs! + 1) throw new DomainError("复核范围超出所选成片或预览", "MEDIA_REVIEW_RANGE_INVALID");
      }
      sourceVersion = rendered.hash;
    } else {
      const { candidate, request } = this.app.readAssetCandidate({ projectId, assetCandidateId: input.candidateId! });
      if (!candidate.previewUrl) throw new DomainError("候选没有可取得的试听/预览文件", "MEDIA_PREVIEW_UNAVAILABLE");
      sourceVersion = digest([candidate.previewUrl, assetRequestVersion(request)]);
    }
    const config = readRuntimeConfig();
    const modelConfig = { ...config.semantic, apiBaseUrl: config.bridge.apiBaseUrl };
    const key = digest({ ...input, idempotencyKey: undefined, sourceVersion, version: ANALYSIS_VERSION, modelConfig });
    const job = this.app.repository.createJob({ projectId, kind: "media_understanding", payload: { input, sourceVersion, analysisKey: key, modelConfig }, idempotencyKey: input.idempotencyKey ?? `media_understanding:${key}` });
    this.app.publish({ projectId, revision: state.revision.number, type: "job" });
    return job;
  }

  inspect(projectId: string, target: { assetId?: string; candidateId?: string; exportArtifactId?: string; previewJobId?: string; range?: SourceTimeRange; region?: SourceRegion }, offset = 0, limit = 40) {
    const snapshot = this.app.readProject(projectId).snapshot;
    const sources = this.store.sources(projectId).filter((source) => target.assetId ? source.target.assetId === target.assetId : target.candidateId ? source.target.candidateId === target.candidateId : target.exportArtifactId ? source.target.exportArtifactId === target.exportArtifactId : target.previewJobId ? source.target.previewJobId === target.previewJobId : true);
    const currentSources = sources.filter((source) => !source.target.assetId || snapshot.assets.some((asset) => asset.id === source.target.assetId && (!asset.sourceHash || asset.sourceHash === source.hash)));
    const observations = currentSources.flatMap((source) => this.store.observations(projectId, source.id)).filter((observation) => (!target.range || observation.range && intersection(target.range, observation.range)) && (!target.region || observation.region?.page === target.region.page));
    const analyses = currentSources.flatMap((source) => this.store.analyses(projectId, source.id));
    const acquisition = target.assetId ? assetById(snapshot, target.assetId).provenance?.acquisition : undefined;
    const candidateEvidence = acquisition ? this.store.sources(projectId)
      .filter(source => !!source.target.candidateId && [acquisition.candidateId, ...(acquisition.candidateIds ?? [])].includes(source.target.candidateId))
      .map(source => ({ source, observations: this.store.observations(projectId, source.id), originalSourceRange: acquisition.sourceRange,
        mappingRequired: "依据取得片段的原片起点换算本地源时间；观察保留原始来源。" })) : [];
    return {
      requests: snapshot.assetRequests.filter((entry) => entry.status !== "closed").map((entry) => ({ id: entry.id, title: entry.title, version: assetRequestVersion(entry) })),
      sources: currentSources, total: observations.length,
      candidateEvidence,
      evidenceAvailability: observations.slice(offset, offset + limit).map((observation) => ({ observationId: observation.id, inputAvailable: observation.inputEvidence ? existsSync(observation.inputEvidence.path) : undefined, sourceAvailable: existsSync(currentSources.find((source) => source.id === observation.sourceId)!.path) })),
      modalityCoverage: analyses.map((record) => ({ analysisId: record.id, windows: record.windows.map((window) => ({ range: window.range, region: window.region, modalities: window.modalityStatus ?? {}, error: window.error })), facts: record.modalities.map((modality) => {
        const facts = observations.filter((observation) => observation.sourceId === record.sourceId).flatMap((observation) => observation.facts).filter((fact) => fact.modality === modality);
        const localized = facts.flatMap((fact) => fact.range ? [fact.range] : []);
        return { modality, factCount: facts.length, unlocatedFactCount: facts.filter((fact) => !fact.range && record.targetRange).length, unknownRanges: record.targetRange ? uncoveredRanges(record.targetRange, localized) : undefined, precision: [...new Set(facts.map((fact) => fact.precision))] };
      }) })),
      observations: observations.slice(offset, offset + limit), nextOffset: offset + limit < observations.length ? offset + limit : undefined,
      coverage: analyses.map((record) => ({ id: record.id, sourceId: record.sourceId, depth: record.depth, status: record.status, totalWindows: record.windows.length, completedWindows: record.windows.filter((window) => window.status === "succeeded").length, failedWindows: record.windows.filter((window) => ["failed", "unknown"].includes(window.status)), missingRanges: record.targetRange ? uncoveredRanges(record.targetRange, record.windows.filter((window) => window.status === "succeeded" && window.range).map((window) => window.range!)) : [], shotRanges: record.shotRanges.slice(offset, offset + limit), totalShots: record.shotRanges.length })),
      technicalStatus: target.assetId ? assetById(snapshot, target.assetId).status : undefined,
      // 窗口处理完成不等于画面/声音事实完整覆盖，更不等于已经复听。
      semanticStatus: !analyses.length ? "not_analyzed" : observations.some((observation) => observation.facts.length) ? "observations_available" : "no_confirmed_facts",
      processingStatus: !analyses.length ? "not_started" : analyses.every((record) => record.status === "succeeded") ? "requested_windows_processed" : "partial_or_pending"
    };
  }

  submitSearch(projectId: string, input: MediaSearchQuery) {
    this.app.readProject(projectId);
    const query = searchQuerySchema.parse(input);
    const config = readRuntimeConfig();
    const modelConfig = { ...config.semantic, apiBaseUrl: config.bridge.apiBaseUrl };
    const job = this.app.repository.createJob({ projectId, kind: "media_search", payload: { query, modelConfig }, idempotencyKey: `media_search:${digest([query, this.store.observations(projectId).map((observation) => observation.id), modelConfig])}` });
    this.app.publish({ projectId, revision: this.app.readProject(projectId).revision.number, type: "job" });
    return job;
  }

  search(projectId: string, input: MediaSearchQuery, queryVector?: number[], embeddingVersion = EMBEDDING_VERSION) {
    const query = searchQuerySchema.parse(input);
    const snapshot = this.app.readProject(projectId).snapshot;
    const sources = this.store.sources(projectId).filter((source) => (!query.assetIds || Boolean(source.target.assetId && query.assetIds.includes(source.target.assetId))) && (!query.candidateIds || Boolean(source.target.candidateId && query.candidateIds.includes(source.target.candidateId)))
      && (!source.target.assetId || snapshot.assets.some((asset) => asset.id === source.target.assetId && (!asset.sourceHash || asset.sourceHash === source.hash))));
    const matches = sources.flatMap((source) => this.store.observations(projectId, source.id).flatMap((observation) => {
      const scores = observation.facts.map((fact) => {
        const text = `${fact.text} ${fact.keywords.join(" ")}`;
        const vector = queryVector ? this.store.vector(observation.id, `${fact.modality}:${digest(text)}`, embeddingVersion, digest(text)) : undefined;
        return queryVector && vector ? cosine(queryVector, vector) : undefined;
      });
      return matchObservation(source, observation, query, undefined, scores);
    })).sort((a, b) => Number(a.status === "rejected") - Number(b.status === "rejected") || b.score - a.score);
    const unique = matches.filter((match, index) => !matches.slice(0, index).some((earlier) => earlier.source.id === match.source.id && earlier.text === match.text && earlier.range?.startMs === match.range?.startMs && earlier.region?.page === match.region?.page));
    return { mode: queryVector ? "hybrid" : "lexical", total: unique.length, matches: unique.slice(query.offset, query.offset + query.limit), nextOffset: query.offset + query.limit < unique.length ? query.offset + query.limit : undefined, unanalysedAssetIds: snapshot.assets.filter((asset) => !sources.some((source) => source.target.assetId === asset.id)).map((asset) => asset.id) };
  }

  correct(projectId: string, input: { observationId: string; facts: MediaFact[]; unknowns: string[]; reason: string; author: string; baseRevision?: number }) {
    const current = this.app.readProject(projectId);
    const previous = this.store.observation(projectId, input.observationId);
    if (!previous || this.store.isSuperseded(projectId, previous.id)) throw new DomainError("观察不存在或已经被纠正，请重新读取", "MEDIA_OBSERVATION_STALE");
    if (input.reason.trim().length < 8 || !input.author.trim()) throw new DomainError("请记录纠错依据和作者", "MEDIA_CORRECTION_REASON_REQUIRED");
    const facts = input.facts.map((fact) => factSchema.parse(fact));
    for (const fact of facts) {
      if (fact.range && (!previous.range || fact.range.startMs < previous.range.startMs || fact.range.endMs > previous.range.endMs)) throw new DomainError("纠错范围不得超出原观察输入", "MEDIA_CORRECTION_RANGE_INVALID");
      if (!regionContains(previous.region, fact.region ?? previous.region)) throw new DomainError("纠正区域不得超出实际输入页面或裁切区域", "MEDIA_CORRECTION_REGION_INVALID");
      // 只改文字不等于确认整个窗口；未定位事实保持未定位，复核者必须显式提交范围。
      if (previous.region && !fact.region) fact.region = previous.region;
      // 纠错也可能来自模型、测量或转写，保留显式来源和精度，不能自动升级证据。
    }
    const observation: MediaObservation = { ...previous, id: createId("observation"), facts, unknowns: input.unknowns, supersedes: previous.id, correction: { reason: input.reason.trim(), author: input.author.trim() }, createdAt: now() };
    // 分析笔记与剪辑绑定解耦；纠错不创建视频版本，也不改变历史采用记录。
    this.store.saveObservation(observation);
    this.app.publish({ projectId, revision: current.revision.number, type: "job" });
    return { observation, revision: current.revision.number };

  }

}
