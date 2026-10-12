import { isAbsolute, join } from "node:path";
import type { CompletedVlogShotAnalysis, EditingApplication } from "@videocut/application";
import type { Asset, JobRecord, ProjectSnapshot } from "@videocut/contracts";
import { assetById, DomainError, millisecondsToFrames } from "@videocut/domain";
import { detectSceneBoundaries, type SceneBoundary } from "../../../packages/media-intelligence/src/structure.js";

type VlogAnalysisPayload = {
  requestedRevision: number;
  assetIds: string[];
  sceneThreshold: number;
};

const maxSceneBoundariesPerAsset = 600;

const assetPath = (snapshot: ProjectSnapshot, asset: Asset) => (
  isAbsolute(asset.managedPath) ? asset.managedPath : join(snapshot.project.rootPath, asset.managedPath)
);

function readPayload(job: JobRecord): VlogAnalysisPayload {
  const requestedRevision = Number(job.payload.requestedRevision);
  const assetIds = Array.isArray(job.payload.assetIds)
    ? job.payload.assetIds.filter((assetId): assetId is string => typeof assetId === "string" && Boolean(assetId.trim()))
    : [];
  const sceneThreshold = Number(job.payload.sceneThreshold);
  if (!Number.isInteger(requestedRevision) || requestedRevision < 1 || !assetIds.length
    || new Set(assetIds).size !== assetIds.length || !Number.isFinite(sceneThreshold)
    || sceneThreshold < 0.05 || sceneThreshold > 0.9) {
    throw new DomainError("Vlog 镜头分析任务缺少有效的素材、Revision 或场景边界阈值", "VLOG_ANALYSIS_PAYLOAD_INVALID");
  }
  return { requestedRevision, assetIds, sceneThreshold };
}

function analysesForAsset(input: {
  snapshot: ProjectSnapshot;
  asset: Asset;
  boundaries: SceneBoundary[];
}): CompletedVlogShotAnalysis[] {
  const durationFrames = millisecondsToFrames(input.asset.metadata!.durationMs, input.snapshot.timeline.fps);
  if (!Number.isInteger(durationFrames) || durationFrames <= 0) {
    throw new DomainError(`素材“${input.asset.name}”没有可用的真实时长`, "VLOG_ANALYSIS_DURATION_INVALID");
  }
  const seen = new Set<number>();
  const boundaries = input.boundaries
    .map((boundary) => ({ ...boundary, frame: Math.round(boundary.seconds * input.snapshot.timeline.fps) }))
    // 首帧和片尾不是切点；重复或过近的时间戳不能生成零长度 Shot。
    .filter((boundary) => boundary.frame > 0 && boundary.frame < durationFrames && !seen.has(boundary.frame) && Boolean(seen.add(boundary.frame)))
    .sort((left, right) => left.frame - right.frame);
  if (boundaries.length > maxSceneBoundariesPerAsset) {
    throw new DomainError(`素材“${input.asset.name}”识别到 ${boundaries.length} 个场景变化，超过安全上限 ${maxSceneBoundariesPerAsset}；请提高阈值或先拆分素材。`, "VLOG_ANALYSIS_BOUNDARY_LIMIT");
  }

  const cuts = [{ frame: 0, score: undefined }, ...boundaries, { frame: durationFrames, score: undefined }];
  return cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1]!;
    const score = end.score;
    const transitionNote = score === undefined
      ? "末尾范围"
      : `下一处 FFmpeg scene score=${score.toFixed(4)}`;
    return {
      assetId: input.asset.id,
      sourceStartFrame: start.frame,
      sourceEndFrame: end.frame,
      source: "ffmpeg_scene",
      sceneChangeScore: score,
      // FFmpeg 已实际解码，但当前没有清晰度、抖动或表演价值模型，因此保持中性评分。
      technicalScore: 0.5,
      hasAudio: Boolean(input.asset.metadata?.hasAudio),
      evidenceNote: `FFmpeg 场景变化边界（${transitionNote}）；已验证视频可解码${input.asset.metadata?.hasAudio ? "且检测到音轨" : "，未检测到音轨"}，未自动判断动作、事件或画面美学。`
    };
  });
}

/**
 * Vlog Worker 只把源片的可测量边界写回 Application。Event、Select 和 Montage 仍必须由导演显式确认，
 * 防止“FFmpeg 检测到画面变化”被误写为“系统已经理解并剪好了 Vlog”。
 */
export async function runVlogAnalysis(application: EditingApplication, job: JobRecord): Promise<Record<string, unknown>> {
  const payload = readPayload(job);
  const existing = application.readVlogPlan(job.projectId).vlogShotAnalyses.filter((analysis) => analysis.analysisJobId === job.id);
  // Job 续租中断后可能被重新领取；已有原子写入结果时不应再次跑 FFmpeg 或制造第二批 Shot Evidence。
  if (existing.length) {
    return {
      requestedRevision: payload.requestedRevision,
      revision: application.readProject(job.projectId).revision.number,
      analysisIds: existing.map((analysis) => analysis.id),
      assetCount: payload.assetIds.length,
      analysisCount: existing.length,
      duplicate: true
    };
  }
  const state = application.readProject(job.projectId);
  const analyses: CompletedVlogShotAnalysis[] = [];
  const boundaryCounts: Record<string, number> = {};

  for (const assetId of payload.assetIds) {
    const asset = assetById(state.snapshot, assetId);
    if (asset.status !== "ready" || asset.kind !== "video" || !asset.metadata?.videoCodec || asset.metadata.durationMs <= 0) {
      throw new DomainError("Vlog 镜头分析只能处理已完成媒体分析的本地视频素材", "VLOG_ANALYSIS_ASSET_NOT_READY");
    }
    const boundaries = await detectSceneBoundaries(assetPath(state.snapshot, asset), payload.sceneThreshold);
    boundaryCounts[asset.id] = boundaries.length;
    analyses.push(...analysesForAsset({ snapshot: state.snapshot, asset, boundaries }));
  }

  const completed = application.completeVlogAnalysis({ projectId: job.projectId, jobId: job.id, analyses });
  return {
    requestedRevision: payload.requestedRevision,
    revision: completed.state.revision.number,
    analysisIds: completed.analyses.map((analysis) => analysis.id),
    assetCount: payload.assetIds.length,
    analysisCount: completed.analyses.length,
    boundaryCounts,
    duplicate: completed.duplicate
  };
}
