import type { Asset, JobRecord, MulticamSourceRange, ProjectSnapshot, VideoGenerationMode } from "@videocut/contracts";

/** Web 表单只保存尚未提交的输入；真正的同步范围仍由服务端再次校验。 */
export type MulticamRangeDraft = {
  label: string;
  startFrame: string;
  endFrame: string;
};

export type AdvancedWorkflowStatus = {
  explainer: {
    hasNarrativeMap: boolean;
    narrativeBeatCount: number;
    readyEvidenceCount: number;
    staleEvidenceCount: number;
    readyProgramCount: number;
    staleProgramCount: number;
  };
  vlog: {
    readyShotCount: number;
    staleShotCount: number;
    eventCount: number;
    readySelectCount: number;
    staleSelectCount: number;
  };
  multicam: {
    groupCount: number;
    candidateGroupCount: number;
    readyGroupCount: number;
    staleGroupCount: number;
    candidateAngleCount: number;
  };
  generated: {
    assetCount: number;
  };
  speechAlignment: "missing" | "ready" | "stale";
  jobs: JobRecord[];
};

const isReadyVideo = (asset: Asset) => asset.kind === "video" && asset.status === "ready";
/** Vlog / 多机位分析针对实拍源，不把受控生成画面误当作现场事件或共同收音。 */
const isRecordedReadyVideo = (asset: Asset) => isReadyVideo(asset) && asset.provenance?.source !== "generated" && asset.role !== "generated_visual";
const isReadyAudioVideo = (asset: Asset) => isRecordedReadyVideo(asset) && asset.metadata?.hasAudio === true;
const isImageInput = (asset: Asset) => asset.kind === "image" || asset.kind === "derived";

/** 技术分析只接受已可解码的视频；它不把素材默认解释成 Vlog 事件。 */
export function vlogAnalysisCandidates(snapshot: ProjectSnapshot): Asset[] {
  return snapshot.assets.filter(isRecordedReadyVideo);
}

/** 自动同步需要每机位可比较的共同音轨，静音画面不能出现在此入口。 */
export function multicamSyncCandidates(snapshot: ProjectSnapshot): Asset[] {
  return snapshot.assets.filter(isReadyAudioVideo);
}

/** 不固定 Provider 工作流，只在当前项目素材中筛掉尚未就绪的对象。 */
export function videoGenerationCandidates(snapshot: ProjectSnapshot, mode: VideoGenerationMode): Asset[] {
  if (mode === "text_to_video") return [];
  return snapshot.assets.filter((asset) => {
    if (asset.status !== "ready") return false;
    if (mode === "image_to_video" || mode === "first_last_frame") return isImageInput(asset);
    return isImageInput(asset) || asset.kind === "video" || asset.kind === "actor_video" || asset.kind === "audio" || asset.kind === "speech";
  });
}

export function validateVideoGenerationInputs(mode: VideoGenerationMode, assets: Asset[]): string | undefined {
  if (assets.some((asset) => asset.status !== "ready")) {
    return "所选参考素材尚未就绪。";
  }
  if (mode === "text_to_video" && assets.length !== 0) return "文生视频不能提交参考素材。";
  if (mode === "image_to_video" && (assets.length !== 1 || !isImageInput(assets[0]!))) return "图生视频必须且只能选择一张已就绪图片。";
  if (mode === "first_last_frame" && (assets.length !== 2 || assets.some((asset) => !isImageInput(asset)))) return "首尾帧生视频必须按顺序选择两张已就绪图片。";
  if (mode === "multi_reference") {
    const imageCount = assets.filter(isImageInput).length;
    const videoCount = assets.filter((asset) => asset.kind === "video" || asset.kind === "actor_video").length;
    const audioCount = assets.filter((asset) => asset.kind === "audio" || asset.kind === "speech").length;
    if (imageCount + videoCount + audioCount !== assets.length || imageCount > 6 || videoCount > 1 || audioCount > 3) {
      return "多参考仅支持最多 6 张图片、1 条视频和 3 条音频。";
    }
  }
  return undefined;
}

export type MulticamSubmission = {
  angleLabels: Record<string, string>;
  sourceRanges: Record<string, MulticamSourceRange>;
};

/**
 * 不让 Web 用整条长原片偷懒同步：每台机位都要有操作员明确标注的名称和受测范围。
 * 服务端会对同一输入做最终的 Revision、范围和媒体校验。
 */
export function validateMulticamSubmission(input: {
  assetIds: string[];
  drafts: Record<string, MulticamRangeDraft | undefined>;
  candidates: Asset[];
  fps: number;
  referenceAssetId: string;
  masterAudioAssetId: string;
}): { error?: string; submission?: MulticamSubmission } {
  const { assetIds, drafts, candidates, fps, referenceAssetId, masterAudioAssetId } = input;
  if (assetIds.length < 2) return { error: "至少选择两条已就绪且带音轨的视频，才能提交自动同步。" };
  if (!assetIds.includes(referenceAssetId) || !assetIds.includes(masterAudioAssetId)) {
    return { error: "请从已选机位中明确指定参考机位和主声音机位。" };
  }
  const byId = new Map(candidates.map((asset) => [asset.id, asset]));
  const angleLabels: Record<string, string> = {};
  const sourceRanges: Record<string, MulticamSourceRange> = {};
  for (const assetId of assetIds) {
    const asset = byId.get(assetId);
    const draft = drafts[assetId];
    if (!asset || !draft) return { error: "所选机位已经不可用于同步，请重新选择。" };
    if (!draft.label.trim()) return { error: "每台机位必须由操作员明确命名，不能从文件名猜测。" };
    const startFrame = Number(draft.startFrame);
    const endFrame = Number(draft.endFrame);
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame) {
      return { error: `机位「${draft.label.trim()}」的源范围必须是有效的半开帧区间。` };
    }
    const durationMs = asset.metadata?.durationMs;
    if (!Number.isFinite(durationMs) || !durationMs || durationMs <= 0) {
      return { error: `机位「${draft.label.trim()}」仍缺少真实媒体时长，不能安全提交同步。` };
    }
    const maxFrame = Math.floor((durationMs / 1_000) * fps);
    if (endFrame > maxFrame) return { error: `机位「${draft.label.trim()}」的结束帧超出受管素材范围（最多 F${maxFrame}）。` };
    angleLabels[assetId] = draft.label.trim();
    sourceRanges[assetId] = { startFrame, endFrame };
  }
  return { submission: { angleLabels, sourceRanges } };
}

/** 高级面板展示的都是当前 Revision 的事实，不能用历史任务结果覆盖项目状态。 */
export function getAdvancedWorkflowStatus(snapshot: ProjectSnapshot, jobs: JobRecord[]): AdvancedWorkflowStatus {
  const generatedAssets = snapshot.assets.filter((asset) => asset.provenance?.source === "generated");
  const relevantJobs = jobs
    .filter((job) => ["vlog_analysis", "multicam_sync", "video_generation", "music_generation", "speech_alignment"].includes(job.kind))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    explainer: {
      hasNarrativeMap: Boolean(snapshot.narrativeMap),
      narrativeBeatCount: snapshot.narrativeMap?.beats.length ?? 0,
      readyEvidenceCount: snapshot.evidenceCaptures.filter((capture) => capture.status === "ready").length,
      staleEvidenceCount: snapshot.evidenceCaptures.filter((capture) => capture.status === "stale").length,
      readyProgramCount: snapshot.explainerPrograms.filter((program) => program.status === "ready").length,
      staleProgramCount: snapshot.explainerPrograms.filter((program) => program.status === "stale").length
    },
    vlog: {
      readyShotCount: snapshot.vlogShotAnalyses.filter((analysis) => analysis.status === "ready").length,
      staleShotCount: snapshot.vlogShotAnalyses.filter((analysis) => analysis.status === "stale").length,
      eventCount: snapshot.vlogEvents.length,
      readySelectCount: snapshot.vlogShotSelects.filter((selection) => selection.status === "ready").length,
      staleSelectCount: snapshot.vlogShotSelects.filter((selection) => selection.status === "stale").length
    },
    multicam: {
      groupCount: snapshot.multicamGroups.length,
      candidateGroupCount: snapshot.multicamGroups.filter((group) => group.status === "candidate").length,
      readyGroupCount: snapshot.multicamGroups.filter((group) => group.status === "ready").length,
      staleGroupCount: snapshot.multicamGroups.filter((group) => group.status === "stale").length,
      candidateAngleCount: snapshot.multicamGroups.flatMap((group) => group.angleSyncs).filter((angle) => angle.status === "candidate").length
    },
    generated: {
      assetCount: generatedAssets.length,
    },
    speechAlignment: snapshot.speechAlignment?.status ?? "missing",
    jobs: relevantJobs
  };
}
