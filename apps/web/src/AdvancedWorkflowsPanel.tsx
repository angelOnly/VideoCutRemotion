import { useEffect, useMemo, useState } from "react";
import type { Asset, JobRecord, ProjectSnapshot, VideoGenerationMode } from "@videocut/contracts";
import { API_BASE, api } from "./api";
import {
  getAdvancedWorkflowStatus,
  multicamSyncCandidates,
  type MulticamRangeDraft,
  validateMulticamSubmission,
  validateVideoGenerationInputs,
  videoGenerationCandidates,
  vlogAnalysisCandidates
} from "./advanced-workflow-state";

type RunAction = (label: string, operation: () => Promise<unknown>) => void;

type AdvancedWorkflowsPanelProps = {
  snapshot: ProjectSnapshot;
  currentRevision: number;
  jobs: JobRecord[];
  busy: boolean;
  onRunAction: RunAction;
};

const videoModes: Array<{ value: VideoGenerationMode; label: string; help: string }> = [
  { value: "text_to_video", label: "文生视频", help: "不带参考素材；生成内容不能冒充原始证据。" },
  { value: "image_to_video", label: "图生视频", help: "只选一张已就绪图片作为参考。" },
  { value: "first_last_frame", label: "首尾帧", help: "按顺序选两张已就绪图片。" },
  { value: "multi_reference", label: "多参考", help: "最多 6 张图片、1 条视频和 3 条音频。" }
];

const advancedJobLabels: Partial<Record<JobRecord["kind"], string>> = {
  vlog_analysis: "Vlog 镜头技术分析",
  multicam_sync: "多机位同步",
  video_generation: "视频生成",
  music_generation: "音乐生成",
  speech_alignment: "词级对齐"
};
const jobLabel = (kind: JobRecord["kind"]) => advancedJobLabels[kind] ?? kind;

const jobStatusLabel = (status: JobRecord["status"]) => ({
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  unknown: "结果未知",
  cancelled: "已取消"
}[status] ?? status);

const rangeEndFrame = (asset: Asset, fps: number) => {
  const durationMs = asset.metadata?.durationMs;
  return durationMs && durationMs > 0 ? Math.floor((durationMs / 1_000) * fps) : 0;
};

const titleForAsset = (asset: Asset) => `${asset.name} · ${asset.metadata?.durationMs ? `${(asset.metadata.durationMs / 1_000).toFixed(1)} 秒` : "时长未知"}`;

type MulticamPreviewView = { relativePath: string; durationMs: number; fps: number; sessionStartFrame: number; sessionEndFrame: number };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Job 的 Preview 路径必须仍是项目内相对路径；Web 不能把不受管 URL 直接塞入 video 标签。 */
function multicamPreviewForJob(job: JobRecord | undefined): MulticamPreviewView | undefined {
  const raw = job?.result?.multicamSyncPreview;
  if (!isRecord(raw)
    || typeof raw.relativePath !== "string"
    || typeof raw.durationMs !== "number"
    || typeof raw.fps !== "number"
    || typeof raw.sessionStartFrame !== "number"
    || typeof raw.sessionEndFrame !== "number") return undefined;
  const relativePath = raw.relativePath.trim().replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("/") || /^[A-Za-z]:\//u.test(relativePath)
    || /^[a-z][a-z0-9+.-]*:/iu.test(relativePath)
    || !relativePath.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")) return undefined;
  return {
    relativePath,
    durationMs: raw.durationMs,
    fps: raw.fps,
    sessionStartFrame: raw.sessionStartFrame,
    sessionEndFrame: raw.sessionEndFrame
  };
}

function multicamPreviewUrl(projectId: string, relativePath: string): string {
  const path = relativePath.split("/").map(encodeURIComponent).join("/");
  return `${API_BASE.replace(/\/$/, "")}/media/${encodeURIComponent(projectId)}/${path}`;
}

/**
 * 这里仅暴露已有高级能力的事实状态和可测量任务入口。
 * NarrativeMap、事件语义、Cut 理由和连续预览结论仍由主工作流 / MCP 记录，不能在 Web 表单里伪造。
 */
export function AdvancedWorkflowsPanel({ snapshot, currentRevision, jobs, busy, onRunAction }: AdvancedWorkflowsPanelProps) {
  const status = useMemo(() => getAdvancedWorkflowStatus(snapshot, jobs), [snapshot, jobs]);
  const [selectedVlogAssetIds, setSelectedVlogAssetIds] = useState<string[]>([]);
  const [selectedMulticamAssetIds, setSelectedMulticamAssetIds] = useState<string[]>([]);
  const [multicamDrafts, setMulticamDrafts] = useState<Record<string, MulticamRangeDraft | undefined>>({});
  const [referenceAssetId, setReferenceAssetId] = useState("");
  const [masterAudioAssetId, setMasterAudioAssetId] = useState("");
  const [multicamTitle, setMulticamTitle] = useState("多机位同步候选");
  const [videoMode, setVideoMode] = useState<VideoGenerationMode>("text_to_video");
  const [videoWorkflowId, setVideoWorkflowId] = useState("");
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoDurationSeconds, setVideoDurationSeconds] = useState("5");
  const [selectedVideoInputIds, setSelectedVideoInputIds] = useState<string[]>([]);
  const [videoAcknowledged, setVideoAcknowledged] = useState(false);
  const [musicWorkflowId, setMusicWorkflowId] = useState("");
  const [musicPrompt, setMusicPrompt] = useState("");
  const [musicDurationSeconds, setMusicDurationSeconds] = useState("30");
  const [musicAcknowledged, setMusicAcknowledged] = useState(false);
  const [alignmentWorkflowId, setAlignmentWorkflowId] = useState("");
  const [multicamPreviewEvidence, setMulticamPreviewEvidence] = useState<Record<string, string>>({});

  const vlogCandidates = useMemo(() => vlogAnalysisCandidates(snapshot), [snapshot]);
  const multicamCandidates = useMemo(() => multicamSyncCandidates(snapshot), [snapshot]);
  const videoCandidates = useMemo(() => videoGenerationCandidates(snapshot, videoMode), [snapshot, videoMode]);
  const selectedMulticamAssets = multicamCandidates.filter((asset) => selectedMulticamAssetIds.includes(asset.id));
  const selectedVideoInputs = videoCandidates.filter((asset) => selectedVideoInputIds.includes(asset.id));
  const videoInputError = validateVideoGenerationInputs(videoMode, selectedVideoInputs);
  const multicamValidation = validateMulticamSubmission({
    assetIds: selectedMulticamAssetIds,
    drafts: multicamDrafts,
    candidates: multicamCandidates,
    fps: snapshot.timeline.fps,
    referenceAssetId,
    masterAudioAssetId
  });
  const multicamPreviewGroups = useMemo(() => snapshot.multicamGroups.flatMap((group) => {
    const preview = multicamPreviewForJob(group.syncJobId ? jobs.find((job) => job.id === group.syncJobId) : undefined);
    return preview ? [{ group, preview }] : [];
  }), [jobs, snapshot.multicamGroups]);
  const validVideoDuration = Number.isInteger(Number(videoDurationSeconds)) && Number(videoDurationSeconds) >= 1 && Number(videoDurationSeconds) <= 1_800;
  const validMusicDuration = Number.isInteger(Number(musicDurationSeconds)) && Number(musicDurationSeconds) >= 1 && Number(musicDurationSeconds) <= 1_800;
  const alignmentAvailable = Boolean(
    snapshot.speechAsset?.status === "ready"
      && snapshot.speechAsset.scriptRevision === snapshot.script.revision
      && status.speechAlignment !== "ready"
  );

  // Revision 刷新后清掉已删除或失败的选择，不覆盖用户仍有效的表单输入。
  useEffect(() => {
    const vlogIds = new Set(vlogCandidates.map((asset) => asset.id));
    const multicamIds = new Set(multicamCandidates.map((asset) => asset.id));
    const videoIds = new Set(videoCandidates.map((asset) => asset.id));
    setSelectedVlogAssetIds((current) => current.filter((assetId) => vlogIds.has(assetId)));
    setSelectedMulticamAssetIds((current) => current.filter((assetId) => multicamIds.has(assetId)));
    setSelectedVideoInputIds((current) => current.filter((assetId) => videoIds.has(assetId)));
    setReferenceAssetId((current) => multicamIds.has(current) ? current : "");
    setMasterAudioAssetId((current) => multicamIds.has(current) ? current : "");
  }, [vlogCandidates, multicamCandidates, videoCandidates]);

  const toggleMulticam = (asset: Asset) => {
    setSelectedMulticamAssetIds((current) => current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id]);
    setMulticamDrafts((current) => current[asset.id]
      ? current
      : {
          ...current,
          [asset.id]: { label: "", startFrame: "0", endFrame: String(rangeEndFrame(asset, snapshot.timeline.fps)) }
        });
  };

  const setMulticamDraft = (assetId: string, patch: Partial<MulticamRangeDraft>) => {
    setMulticamDrafts((current) => ({
      ...current,
      [assetId]: { label: "", startFrame: "0", endFrame: "", ...current[assetId], ...patch }
    }));
  };

  const changeVideoMode = (mode: VideoGenerationMode) => {
    setVideoMode(mode);
    setSelectedVideoInputIds([]);
  };

  const toggleVideoInput = (assetId: string) => {
    setSelectedVideoInputIds((current) => current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]);
  };

  const submitMulticam = () => {
    if (!multicamValidation.submission) return;
    onRunAction("提交多机位同步候选", () => api.submitMulticamSync(snapshot.project.id, {
      baseRevision: currentRevision,
      title: multicamTitle.trim() || undefined,
      assetIds: selectedMulticamAssetIds,
      angleLabels: multicamValidation.submission!.angleLabels,
      referenceAssetId,
      masterAudioAssetId,
      sourceRanges: multicamValidation.submission!.sourceRanges
    }));
  };

  return <>
    <PanelTitle title="高级工作流" meta={`R${currentRevision} · 状态与受控任务`} />
    <p className="empty-panel">此处展示阶段 3–5 已落地的对象和可测量任务。内容判断仍应通过 Agent 工作单和 MCP 交给对应主工作流；页面不会替你写 NarrativeMap、Vlog 事件、机位切换理由或连续预览结论。</p>

    <AdvancedSection title="视觉解释片" meta="只读导演状态">
      {!status.explainer.hasNarrativeMap
        ? <WorkflowNotice tone="neutral">尚未建立 NarrativeMap。请由视觉解释主工作流明确观众问题、认知路径、事实来源和 Scene 语法后再编译。</WorkflowNotice>
        : <>
          <SummaryGrid values={[
            ["认知拍", status.explainer.narrativeBeatCount],
            ["可用证据", status.explainer.readyEvidenceCount],
            ["可渲染 Scene", status.explainer.readyProgramCount]
          ]} />
          {(status.explainer.staleEvidenceCount > 0 || status.explainer.staleProgramCount > 0) && <WorkflowNotice tone="warning">有 {status.explainer.staleEvidenceCount} 条证据或 {status.explainer.staleProgramCount} 个 Explainer Scene 已过期。它们不能作为当前 Revision 的成片依据。</WorkflowNotice>}
          <div className="advanced-read-list">
            {snapshot.narrativeMap?.beats.map((beat, index) => <article key={beat.id} className="advanced-read-card" data-object-id={beat.id}>
              <strong>第 {index + 1} 拍 · {beat.question}</strong>
              <small>新增理解：{beat.newKnowledge}</small>
              <small>证据 {beat.evidenceCaptureIds.length} · Scene {beat.sceneIds.length}</small>
            </article>)}
          </div>
        </>}
    </AdvancedSection>

    <AdvancedSection title="Vlog" meta="技术镜头分析入口">
      <SummaryGrid values={[
        ["已分析镜头", status.vlog.readyShotCount],
        ["事件", status.vlog.eventCount],
        ["可用 Select", status.vlog.readySelectCount]
      ]} />
      {(status.vlog.staleShotCount > 0 || status.vlog.staleSelectCount > 0) && <WorkflowNotice tone="warning">有 {status.vlog.staleShotCount} 条镜头分析或 {status.vlog.staleSelectCount} 个 Shot Select 已过期，需要重新确认。</WorkflowNotice>}
      <p className="advanced-help">只提交 FFmpeg 的镜头边界和现场声可用性分析，不会自动判断事件、反应、节奏或 Montage。</p>
      <AssetCheckboxList
        assets={vlogCandidates}
        selectedIds={selectedVlogAssetIds}
        emptyText="尚无已就绪视频可分析。"
        labelPrefix="分析 Vlog 素材"
        onToggle={(assetId) => setSelectedVlogAssetIds((current) => current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId])}
      />
      <button className="wide-button" type="button" disabled={busy || selectedVlogAssetIds.length === 0} onClick={() => onRunAction("提交 Vlog 镜头技术分析", () => api.submitVlogAnalysis(snapshot.project.id, {
        baseRevision: currentRevision,
        assetIds: selectedVlogAssetIds
      }))}>分析 {selectedVlogAssetIds.length} 条所选视频</button>
    </AdvancedSection>

    <AdvancedSection title="多机位" meta="候选同步，不能直接切机位">
      <SummaryGrid values={[
        ["同步组", status.multicam.groupCount],
        ["已验证", status.multicam.readyGroupCount],
        ["候选", status.multicam.candidateGroupCount]
      ]} />
      {(status.multicam.candidateGroupCount > 0 || status.multicam.candidateAngleCount > 0) && <WorkflowNotice tone="danger">自动音频相关只会产生 candidate。必须在真实连续预览中确认同一事件、口型和声音后，才能通过 MCP 标为 verified 并编译切机位。</WorkflowNotice>}
      {status.multicam.staleGroupCount > 0 && <WorkflowNotice tone="warning">有 {status.multicam.staleGroupCount} 个同步组已过期，不能再用于当前编译。</WorkflowNotice>}
      <p className="advanced-help">仅选择带音轨、已完成媒体分析的视频。为避免整条长原片跨会话误同步，必须逐机位填写实际比较过的源帧范围。</p>
      <label className="advanced-field">同步名称（可选）<input aria-label="多机位同步名称" value={multicamTitle} maxLength={160} onChange={(event) => setMulticamTitle(event.target.value)} /></label>
      <AssetCheckboxList
        assets={multicamCandidates}
        selectedIds={selectedMulticamAssetIds}
        emptyText="尚无带音轨且已就绪的视频。"
        labelPrefix="选择同步机位"
        onToggle={(assetId) => {
          const asset = multicamCandidates.find((candidate) => candidate.id === assetId);
          if (asset) toggleMulticam(asset);
        }}
      />
      {selectedMulticamAssets.length > 0 && <div className="advanced-range-list">
        <label className="advanced-field">参考机位<select aria-label="多机位参考机位" value={referenceAssetId} onChange={(event) => setReferenceAssetId(event.target.value)}><option value="">请选择</option>{selectedMulticamAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
        <label className="advanced-field">主声音机位<select aria-label="多机位主声音机位" value={masterAudioAssetId} onChange={(event) => setMasterAudioAssetId(event.target.value)}><option value="">请选择</option>{selectedMulticamAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
        {selectedMulticamAssets.map((asset) => {
          const draft = multicamDrafts[asset.id] ?? { label: "", startFrame: "0", endFrame: String(rangeEndFrame(asset, snapshot.timeline.fps)) };
          return <article className="advanced-range-card" key={asset.id} data-object-id={asset.id}>
            <strong>{asset.name}</strong><small>受管素材最多 F{rangeEndFrame(asset, snapshot.timeline.fps)} · {snapshot.timeline.fps} fps</small>
            <label>机位名称<input aria-label={`${asset.name} 机位名称`} value={draft.label} placeholder="例如：A 机" maxLength={80} onChange={(event) => setMulticamDraft(asset.id, { label: event.target.value })} /></label>
            <div className="advanced-range-inputs"><label>起始帧<input aria-label={`${asset.name} 同步起始帧`} value={draft.startFrame} inputMode="numeric" onChange={(event) => setMulticamDraft(asset.id, { startFrame: event.target.value })} /></label><label>结束帧<input aria-label={`${asset.name} 同步结束帧`} value={draft.endFrame} inputMode="numeric" onChange={(event) => setMulticamDraft(asset.id, { endFrame: event.target.value })} /></label></div>
          </article>;
        })}
      </div>}
      {selectedMulticamAssetIds.length > 0 && multicamValidation.error && <WorkflowNotice tone="warning">{multicamValidation.error}</WorkflowNotice>}
      <button className="wide-button" type="button" disabled={busy || !multicamValidation.submission} onClick={submitMulticam}>提交自动同步候选</button>
      {multicamPreviewGroups.length > 0 && <div className="multicam-preview-list">
        {multicamPreviewGroups.map(({ group, preview }) => {
          const evidence = multicamPreviewEvidence[group.id] ?? "";
          const isCandidate = group.status === "candidate";
          return <article key={group.id} className="multicam-preview-card" data-object-id={group.id}>
            <div className="multicam-preview-heading"><strong>{group.title}</strong><span className={`status status-${group.status}`}>{isCandidate ? "等待连续核对" : "已验证"}</span></div>
            <small>受管并排预览 · {(preview.durationMs / 1_000).toFixed(1)} 秒 · 会话 F{preview.sessionStartFrame}–F{preview.sessionEndFrame} · {preview.fps} fps</small>
            <video className="multicam-preview-video" controls preload="metadata" src={multicamPreviewUrl(snapshot.project.id, preview.relativePath)}>浏览器无法播放此同步预览。</video>
            {isCandidate ? <>
              <WorkflowNotice tone="warning">完整播放后确认同一事件、口型和现场声；仅看单帧或只看 Job 成功不能验证同步。</WorkflowNotice>
              <label className="advanced-field">连续核对说明<textarea aria-label={`${group.title} 连续核对说明`} value={evidence} maxLength={2_000} rows={3} placeholder="例如：在 00:02–00:08 口型、抬手和现场声到达同一时刻。" onChange={(event) => setMulticamPreviewEvidence((current) => ({ ...current, [group.id]: event.target.value }))} /></label>
              <button className="wide-button" type="button" disabled={busy || !evidence.trim()} onClick={() => onRunAction("确认多机位连续预览", () => api.verifyMulticamGroup(snapshot.project.id, {
                baseRevision: currentRevision,
                groupId: group.id,
                previewEvidence: evidence.trim()
              }))}>确认并标为已验证</button>
            </> : <WorkflowNotice tone="success">此同步组已通过连续预览确认；接下来仍需由 Vlog 主工作流写入每个 Cut 的机位理由和连续性说明。</WorkflowNotice>}
          </article>;
        })}
      </div>}
    </AdvancedSection>

    <AdvancedSection title="受控生成" meta="不会自动进入 Timeline">
      <p className="advanced-help">提交前请先从实时 Bridge Schema 取得 workflow ID。Web 不固化 Provider 字段、临时下载 URL 或未经验证的能力；提交可能产生外部生成费用。</p>
      <section className="advanced-generator-form" data-testid="video-generation-form">
        <h4>视频生成</h4>
        <label className="advanced-field">生成方式<select aria-label="视频生成方式" value={videoMode} onChange={(event) => changeVideoMode(event.target.value as VideoGenerationMode)}>{videoModes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></label>
        <p className="advanced-help">{videoModes.find((mode) => mode.value === videoMode)?.help}</p>
        <label className="advanced-field">Bridge workflow ID<input aria-label="视频生成 workflow ID" value={videoWorkflowId} placeholder="从当前 Bridge Schema 读取" maxLength={240} onChange={(event) => setVideoWorkflowId(event.target.value)} /></label>
        <label className="advanced-field">提示词<textarea aria-label="视频生成提示词" value={videoPrompt} maxLength={4_000} rows={3} onChange={(event) => setVideoPrompt(event.target.value)} /></label>
        <label className="advanced-field">时长（秒）<input aria-label="视频生成时长" value={videoDurationSeconds} inputMode="numeric" onChange={(event) => setVideoDurationSeconds(event.target.value)} /></label>
        <p className="advanced-help">项目比例固定为 {snapshot.project.brief.aspectRatio}；不能在此处绕过 Project Brief。证据类内容必须继续使用原始来源或证据截图。</p>
        {videoMode !== "text_to_video" && <AssetCheckboxList assets={videoCandidates} selectedIds={selectedVideoInputIds} emptyText="没有适合此生成方式的已就绪参考素材。" labelPrefix="选择视频生成参考素材" onToggle={toggleVideoInput} />}
        {videoInputError && <WorkflowNotice tone="warning">{videoInputError}</WorkflowNotice>}
        <label className="advanced-confirm"><input aria-label="确认提交视频生成" type="checkbox" checked={videoAcknowledged} onChange={(event) => setVideoAcknowledged(event.target.checked)} />我确认这是一次受控外部生成请求，生成结果仍需本地化、技术核验和创作采用。</label>
        <button className="primary wide-button" type="button" disabled={busy || !videoAcknowledged || !videoWorkflowId.trim() || !videoPrompt.trim() || !validVideoDuration || Boolean(videoInputError)} onClick={() => onRunAction("提交视频生成", () => api.submitVideoGeneration(snapshot.project.id, {
          baseRevision: currentRevision,
          workflowId: videoWorkflowId.trim(),
          mode: videoMode,
          inputAssetIds: selectedVideoInputIds,
          prompt: videoPrompt.trim(),
          durationSeconds: Number(videoDurationSeconds)
        }))}>提交视频生成 Job</button>
      </section>
      <section className="advanced-generator-form" data-testid="music-generation-form">
        <h4>音乐生成</h4>
        <label className="advanced-field">Bridge workflow ID<input aria-label="音乐生成 workflow ID" value={musicWorkflowId} placeholder="从当前 Bridge Schema 读取" maxLength={240} onChange={(event) => setMusicWorkflowId(event.target.value)} /></label>
        <label className="advanced-field">提示词<textarea aria-label="音乐生成提示词" value={musicPrompt} maxLength={4_000} rows={3} onChange={(event) => setMusicPrompt(event.target.value)} /></label>
        <label className="advanced-field">时长（秒）<input aria-label="音乐生成时长" value={musicDurationSeconds} inputMode="numeric" onChange={(event) => setMusicDurationSeconds(event.target.value)} /></label>
        <label className="advanced-confirm"><input aria-label="确认提交音乐生成" type="checkbox" checked={musicAcknowledged} onChange={(event) => setMusicAcknowledged(event.target.checked)} />我确认这是一次外部音乐生成请求；结果不会自动成为 BGM，仍需按实际内容选择采用。</label>
        <button className="wide-button" type="button" disabled={busy || !musicAcknowledged || !musicWorkflowId.trim() || !musicPrompt.trim() || !validMusicDuration} onClick={() => onRunAction("提交音乐生成", () => api.submitMusicGeneration(snapshot.project.id, {
          baseRevision: currentRevision,
          workflowId: musicWorkflowId.trim(),
          prompt: musicPrompt.trim(),
          durationSeconds: Number(musicDurationSeconds)
        }))}>提交音乐生成 Job</button>
      </section>
    </AdvancedSection>

    <AdvancedSection title="真实词级对齐" meta="可选精度升级">
      {status.speechAlignment === "ready"
        ? <WorkflowNotice tone="success">当前 SpeechAsset 已有真实词级对齐：{snapshot.speechAlignment?.words.length ?? 0} 个 token，精度可作为 word_exact 使用。</WorkflowNotice>
        : status.speechAlignment === "stale"
          ? <WorkflowNotice tone="warning">旧词级对齐已过期。主声音或 Script 改变后，不能继续把旧 token 时间当作 word_exact。</WorkflowNotice>
          : <WorkflowNotice tone="neutral">当前没有真实词级对齐。段级时序仍是 segment_exact，不能伪装成逐词精度。</WorkflowNotice>}
      {!alignmentAvailable && status.speechAlignment !== "ready" && <p className="advanced-help">需要当前 Revision 的已就绪 SpeechAsset，且它必须与当前 Script 一致后才能提交。</p>}
      {alignmentAvailable && <>
        <label className="advanced-field">Bridge workflow ID<input aria-label="词级对齐 workflow ID" value={alignmentWorkflowId} placeholder="从当前 Bridge Schema 读取" maxLength={240} onChange={(event) => setAlignmentWorkflowId(event.target.value)} /></label>
        <button className="wide-button" type="button" disabled={busy || !alignmentWorkflowId.trim()} onClick={() => onRunAction("提交真实词级对齐", () => api.submitSpeechAlignment(snapshot.project.id, {
          baseRevision: currentRevision,
          workflowId: alignmentWorkflowId.trim(),
          speechAssetId: snapshot.speechAsset?.id
        }))}>提交真实词级对齐 Job</button>
      </>}
    </AdvancedSection>

    <AdvancedSection title="高级任务记录" meta={`${status.jobs.length} 条`}>
      {status.jobs.length === 0 ? <p className="empty-panel">当前项目还没有阶段 3–5 的异步任务。</p> : <div className="advanced-job-list">{status.jobs.map((job) => <article key={job.id} className={`advanced-job-card ${job.status}`} data-testid={`advanced-job-${job.id}`} data-object-id={job.id}><div><strong>{jobLabel(job.kind)}</strong><small>{job.id}</small></div><span className={`status status-${job.status}`}>{jobStatusLabel(job.status)}</span>{job.error && <p>{job.error}</p>}</article>)}</div>}
    </AdvancedSection>
  </>;
}

function PanelTitle({ title, meta }: { title: string; meta: string }) {
  return <div className="panel-title"><h2>{title}</h2><span>{meta}</span></div>;
}

function AdvancedSection({ title, meta, children }: { title: string; meta: string; children: React.ReactNode }) {
  return <section className="advanced-section"><div className="advanced-section-heading"><h3>{title}</h3><small>{meta}</small></div>{children}</section>;
}

function WorkflowNotice({ tone, children }: { tone: "neutral" | "warning" | "danger" | "success"; children: React.ReactNode }) {
  return <p className={`workflow-notice ${tone}`}>{children}</p>;
}

function SummaryGrid({ values }: { values: Array<[string, number]> }) {
  return <div className="advanced-summary-grid">{values.map(([label, value]) => <div key={label}><strong>{value}</strong><small>{label}</small></div>)}</div>;
}

function AssetCheckboxList({ assets, selectedIds, emptyText, labelPrefix, onToggle }: {
  assets: Asset[];
  selectedIds: string[];
  emptyText: string;
  labelPrefix: string;
  onToggle: (assetId: string) => void;
}) {
  if (assets.length === 0) return <p className="empty-panel">{emptyText}</p>;
  return <div className="advanced-asset-options">{assets.map((asset) => <label key={asset.id} data-object-id={asset.id}><input type="checkbox" aria-label={`${labelPrefix}：${asset.name}`} checked={selectedIds.includes(asset.id)} onChange={() => onToggle(asset.id)} /><span>{titleForAsset(asset)}</span><small>{asset.role ?? "未分类"}</small></label>)}</div>;
}
