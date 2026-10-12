import type { EditingApplication } from "@videocut/application";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import type { JobRecord } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { assetRequestVersion, cosine } from "../../../packages/media-intelligence/src/index.js";
import { encodeModelTexts } from "./media-understanding.js";
import { semanticConfig } from "./model-http.js";

export async function runSoundRanking(app: EditingApplication, job: JobRecord, bridge: ComfyUIBridgeClient) {
  const config = semanticConfig(job);
  if (config.apiBaseUrl !== bridge.apiBaseUrl) bridge = new ComfyUIBridgeClient(config.apiBaseUrl);
  const request = app.readProject(job.projectId).snapshot.assetRequests.find((entry) => entry.id === job.payload.assetRequestId);
  if (!request || assetRequestVersion(request) !== job.payload.requestVersion) throw new DomainError("声音需求已变化，不能采用旧排序", "MEDIA_REQUEST_STALE");
  const inspected = (job.payload.candidateIds as string[]).map((candidateId) => app.readAssetCandidate({ projectId: job.projectId, assetCandidateId: candidateId }));
  // 当前排序仍跟随当前需求，但旧查询发现的同需求候选可以重新参与比较。
  if (inspected.some((entry) => entry.request.id !== request.id)) throw new DomainError("候选来自不同需求", "MEDIA_REQUEST_STALE");
  const candidates = inspected.map((entry) => entry.candidate).filter((candidate) => candidate.hardFilterPassed && candidate.status === "available");
  const texts = candidates.map((candidate) => `${candidate.name} ${candidate.tags.join(" ")} ${candidate.durationMs ? `全文件时长 ${candidate.durationMs}ms，仅为元数据` : "时长未知"}`);
  if (!texts.length) return { ranked: [], analysisJobIds: [], reason: "没有满足来源与技术条件的候选" };
  const query = `${request.audioBrief} ${request.purpose} ${request.sound?.material ?? ""} ${request.sound?.attack ?? ""} ${request.sound?.tail ?? ""}`;
  const [queryVector] = await encodeModelTexts(app, job, bridge, [query], "query", "sound-query");
  const vectors = await encodeModelTexts(app, job, bridge, texts, "document", "sound-metadata");
  const ranked = candidates.map((candidate, index) => ({ candidateId: candidate.id, score: cosine(vectors[index], queryVector), text: texts[index], basis: "provider_metadata", audioVerified: false })).sort((a, b) => b.score - a.score);
  const analysisJobIds: string[] = [];
  for (const entry of ranked.slice(0, Number(job.payload.analyzeTop))) analysisJobIds.push((await app.intelligence.submitAnalysis(job.projectId, { candidateId: entry.candidateId, depth: "index", modalities: ["audio"], context: `${query}。这是用途背景，不能据此编造实际听到的声音。` })).id);
  return { ...app.trackJob(job.id).result, ranked, analysisJobIds, query, requestVersion: job.payload.requestVersion, embeddingRevision: config.embeddingRevision, nextStep: "待子任务完成，按实际声音与连续范围重新筛选。原文件采用前另做复核。" };
}
