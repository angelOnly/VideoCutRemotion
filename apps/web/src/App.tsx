import { CreativeDefaultsSettings } from "./CreativeDefaultsSettings";
import { exportBlockingIssues } from "../../../packages/quality-system/src/export-policy.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { usePreviewInput } from "./use-preview-input";
import { EFFECT_TYPES, type AgentWorkOrder, type Asset, type AudioCue, type CaptionCard, type DialogueProcessingIssue, type DialogueProcessingProfile, type EffectCue, type ExportArtifact, type ProductionProfile, type ProjectSnapshot, type Scene, type SpeechAsset, type TimelineItem } from "@videocut/contracts";
import { ProjectComposition, mediaUrl } from "@videocut/remotion";
import { API_BASE, api, type ProjectState } from "./api";
import { AdvancedWorkflowsPanel } from "./AdvancedWorkflowsPanel";
import { SourceReviewPanel } from "./SourceReviewPanel";
import { MotionLibraryPanel } from "./MotionLibraryPanel";
import { SoundLibraryPanel } from "./SoundLibraryPanel";
import { TimelineEditor } from "./TimelineEditor";
import { FrameRateSettings } from "./FrameRateSettings";
import { FontLibraryPanel } from "./FontLibraryPanel";
import { CaptionFormatEditor } from "./CaptionFormatEditor";
import { captionCardUpdate } from "./caption-editor-state";

type Panel = "assets" | "agent_work_orders" | "script" | "audio" | "actors" | "scenes" | "captions" | "fonts" | "advanced" | "jobs";
type Selection = { kind: "asset" | "scene" | "item" | "cue"; id: string } | undefined;
type EditorFocusQuery = { sceneId?: string; itemId?: string; effectCueId?: string; frame?: number };

const panelMeta: Array<{ id: Panel; label: string; icon: string }> = [
  { id: "assets", label: "素材", icon: "▦" },
  { id: "agent_work_orders", label: "工作单", icon: "✦" },
  { id: "script", label: "文字稿", icon: "¶" },
  { id: "audio", label: "声音", icon: "♬" },
  { id: "actors", label: "人物", icon: "◉" },
  { id: "scenes", label: "场景", icon: "◇" },
  { id: "captions", label: "字幕", icon: "CC" },
  { id: "fonts", label: "字体", icon: "Aa" },
  { id: "advanced", label: "高级", icon: "◆" },
  { id: "jobs", label: "任务 / QC", icon: "✓" }
];

const projectProfileOptions: Array<{ value: ProductionProfile; label: string }> = [
  { value: "presenter_motion", label: "人物口播" },
  { value: "visual_explainer", label: "视觉解释片" },
  { value: "vlog", label: "Vlog" },
  { value: "hybrid", label: "混合视频" }
];

// 每种效果使用固定图层，避免 Web 端再次维护一套效果布局规则。
const effectLayerByType: Record<EffectCue["type"], EffectCue["layer"]> = {
  MetricBackdrop: "rear",
  ProductFan: "front",
  GlowCTA: "front",
  PortfolioWall: "front",
  CommentCloud: "front",
  EvidenceCard: "front",
  CameraPunch: "actor",
  FullScreenMeme: "fullscreen",
  DeviceShowcase: "front",
  ContentCarousel: "front",
  EndCard: "fullscreen",
  ManagedMotion: "front"
};

const formatDuration = (frames: number, fps: number) => `${(frames / fps).toFixed(1)} 秒`;
const formatTimecode = (frame: number, fps: number) => {
  const seconds = Math.floor(frame / fps);
  const frames = frame % fps;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
};
const statusText = (status: string) => ({ queued: "排队中", analyzing: "分析中", ready: "已就绪", failed: "失败", running: "运行中", succeeded: "完成", cancelled: "已取消", unknown: "未知", missing: "缺失", pending: "待生成", stale: "需复核", open: "待处理", claimed: "Codex 已接手", completed: "已完成" }[status] ?? status);
const assetIcon = (asset: Asset) => asset.kind === "video" || asset.kind === "actor_video" ? "▶" : asset.kind === "audio" || asset.kind === "speech" ? "♬" : "▧";

type WorkOrderObjectOption = { id: string; label: string; kind: string };

/** 工作单只允许关联当前快照中真实存在的对象；保存的是 ID，不带走对象副本。 */
function workOrderObjectOptions(snapshot: ProjectSnapshot): WorkOrderObjectOption[] {
  const assetName = (assetId: string) => snapshot.assets.find((asset) => asset.id === assetId)?.name ?? assetId;
  return [
    { id: snapshot.project.id, kind: "项目", label: snapshot.project.name },
    ...snapshot.story.beats.map((beat) => ({ id: beat.id, kind: "Story Beat", label: beat.title })),
    ...snapshot.scenes.map((scene) => ({ id: scene.id, kind: "Scene", label: scene.title })),
    ...snapshot.assets.map((asset) => ({ id: asset.id, kind: "素材", label: asset.name })),
    ...snapshot.timeline.items.filter((item) => !item.disabled).map((item) => ({ id: item.id, kind: "Timeline", label: `${assetName(item.assetId)} · F${item.startFrame}–${item.endFrame}` })),
    ...snapshot.effectCues.map((cue) => ({ id: cue.id, kind: "EffectCue", label: `${cue.type} · F${cue.startFrame}–${cue.endFrame}` })),
    ...snapshot.cutaways.map((cutaway) => ({ id: cutaway.id, kind: "Cutaway", label: cutaway.purpose }))
  ];
}

function readEditorFocus(): EditorFocusQuery {
  const params = new URLSearchParams(window.location.search);
  const frameValue = params.get("frame");
  const frame = frameValue === null ? undefined : Number(frameValue);
  return {
    sceneId: params.get("sceneId") ?? undefined,
    itemId: params.get("itemId") ?? undefined,
    effectCueId: params.get("effectCueId") ?? undefined,
    frame: typeof frame === "number" && Number.isInteger(frame) && frame >= 0 ? frame : undefined
  };
}

function useProjectId(): [string | undefined, (projectId: string | undefined) => void] {
  const initial = new URLSearchParams(window.location.search).get("projectId") ?? undefined;
  const [projectId, setProjectId] = useState<string | undefined>(initial);
  const update = useCallback((next: string | undefined) => {
    setProjectId(next);
    const url = new URL(window.location.href);
    // 推荐文案属于原项目；切项目只保留字体库入口，不带走上一项目的候选上下文。
    if (url.searchParams.get("projectId") !== next) url.searchParams.delete("fontPreview");
    if (next) url.searchParams.set("projectId", next);
    else url.searchParams.delete("projectId");
    window.history.replaceState({}, "", url);
  }, []);
  return [projectId, update];
}

export function App() {
  const [projectId, setProjectId] = useProjectId();
  const [state, setState] = useState<ProjectState>();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [panel, setPanel] = useState<Panel>(() => new URLSearchParams(window.location.search).get("panel") === "fonts" ? "fonts" : "assets");
  const [selection, setSelection] = useState<Selection>();
  const [playhead, setPlayhead] = useState(0);
  const [quality, setQuality] = useState<Awaited<ReturnType<typeof api.quality>>>();
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof api.jobs>>>([]);
  const [exportArtifacts, setExportArtifacts] = useState<ExportArtifact[]>([]);
  const [revisions, setRevisions] = useState<Awaited<ReturnType<typeof api.revisions>>>([]);
  const [newProjectName, setNewProjectName] = useState("数字人口播项目");
  const [newProjectProfile, setNewProjectProfile] = useState<ProductionProfile>("presenter_motion");
  const [newProjectFps, setNewProjectFps] = useState(24);
  const [localPath, setLocalPath] = useState("");
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [selectedARollIds, setSelectedARollIds] = useState<string[]>([]);
  const [workOrderTitle, setWorkOrderTitle] = useState("");
  const [workOrderIntent, setWorkOrderIntent] = useState("");
  const [selectedWorkOrderObjectIds, setSelectedWorkOrderObjectIds] = useState<string[]>([]);
  const [message, setMessage] = useState("准备就绪");
  const [busy, setBusy] = useState(false);
  const playerRef = useRef<PlayerRef>(null);
  const initialFocus = useRef<EditorFocusQuery>(readEditorFocus());
  const initialFocusApplied = useRef(false);
  const hasPendingWork = Boolean(
    state?.snapshot.assets.some((asset) => asset.status === "queued" || asset.status === "analyzing")
    || jobs.some((job) => job.status === "queued" || job.status === "running")
  );

  const load = useCallback(async (id: string) => {
    const [nextState, nextQuality, nextJobs, nextArtifacts, nextRevisions] = await Promise.all([api.project(id), api.quality(id), api.jobs(id), api.exportArtifacts(id), api.revisions(id)]);
    setState(nextState);
    setQuality(nextQuality);
    setJobs(nextJobs);
    setExportArtifacts(nextArtifacts);
    setRevisions(nextRevisions);
    setProjects((previous) => previous.some((project) => project.id === id) ? previous : [...previous, { id, name: nextState.snapshot.project.name }]);
  }, []);

  const refreshProjects = useCallback(async () => {
    const nextProjects = await api.listProjects();
    setProjects(nextProjects.map((project) => ({ id: project.id, name: project.name })));
    if (!projectId && nextProjects[0]) setProjectId(nextProjects[0].id);
  }, [projectId, setProjectId]);

  useEffect(() => { void refreshProjects().catch((error) => setMessage(error.message)); }, [refreshProjects]);
  useEffect(() => { if (projectId) void load(projectId).catch((error) => setMessage(error.message)); }, [projectId, load]);

  useEffect(() => {
    if (!projectId) return;
    const source = new EventSource(`${API_BASE}/api/events?projectId=${encodeURIComponent(projectId)}`);
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(projectId).catch((error) => setMessage(error.message)), 180);
    };
    source.addEventListener("revision", refresh);
    source.addEventListener("job", refresh);
    source.onerror = () => source.close();
    return () => { window.clearTimeout(timer); source.close(); };
  }, [projectId, load]);

  /**
   * Server 与 Worker 可独立运行，Worker 的内存事件无法跨进程推给当前 Web Server。
   * 仅在存在未完成任务时轮询读回，任务结束后自动停止，保证素材和导出状态不会卡在旧快照。
   */
  useEffect(() => {
    if (!projectId || !hasPendingWork) return;
    const timer = window.setInterval(() => void load(projectId).catch((error) => setMessage(error.message)), 1_500);
    return () => window.clearInterval(timer);
  }, [projectId, hasPendingWork, load]);

  useEffect(() => {
    if (!state) return;
    setSelectedUnitIds(state.snapshot.semanticUnits.filter((unit) => unit.status === "included").map((unit) => unit.id));
    const readyVideoIds = new Set(state.snapshot.assets
      .filter((asset) => (asset.kind === "video" || asset.kind === "actor_video") && asset.status === "ready")
      .map((asset) => asset.id));
    setSelectedARollIds((current) => current.filter((assetId) => readyVideoIds.has(assetId)));
    const existingWorkOrderObjectIds = new Set(workOrderObjectOptions(state.snapshot).map((option) => option.id));
    setSelectedWorkOrderObjectIds((current) => current.filter((objectId) => existingWorkOrderObjectIds.has(objectId)));
  }, [state?.revision.id]);

  /**
   * MCP 返回的 editor-url 只在首次打开时应用，避免实时刷新 Revision 时抢走用户正在调整的选中项。
   */
  useEffect(() => {
    if (!state || initialFocusApplied.current) return;
    const focus = initialFocus.current;
    const snapshot = state.snapshot;
    let nextSelection: Selection;
    let targetFrame = focus.frame;
    if (focus.effectCueId) {
      const cue = snapshot.effectCues.find((candidate) => candidate.id === focus.effectCueId);
      if (cue) {
        nextSelection = { kind: "cue", id: cue.id };
        targetFrame ??= cue.startFrame;
        setPanel("scenes");
      }
    } else if (focus.itemId) {
      const item = snapshot.timeline.items.find((candidate) => candidate.id === focus.itemId);
      if (item) {
        nextSelection = { kind: "item", id: item.id };
        targetFrame ??= item.startFrame;
        setPanel("scenes");
      }
    } else if (focus.sceneId) {
      const scene = snapshot.scenes.find((candidate) => candidate.id === focus.sceneId);
      if (scene) {
        nextSelection = { kind: "scene", id: scene.id };
        targetFrame ??= scene.startFrame;
        setPanel("scenes");
      }
    }
    if (nextSelection) setSelection(nextSelection);
    initialFocusApplied.current = true;
    if (targetFrame === undefined) return;
    const safeFrame = Math.max(0, Math.min(targetFrame, Math.max(0, snapshot.timeline.durationInFrames - 1)));
    const timer = window.setTimeout(() => {
      playerRef.current?.seekTo(safeFrame);
      setPlayhead(safeFrame);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [state?.revision.id]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (event: { detail: { frame: number } }) => setPlayhead(event.detail.frame);
    player.addEventListener("frameupdate", onFrame);
    return () => player.removeEventListener("frameupdate", onFrame);
  }, [state?.revision.id]);

  const act = async (label: string, operation: () => Promise<unknown>) => {
    try {
      setBusy(true);
      setMessage(`${label}…`);
      await operation();
      if (projectId) await load(projectId);
      await refreshProjects();
      setMessage(`${label}完成`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const seekTo = (frame: number) => {
    const safeFrame = Math.max(0, Math.min(frame, Math.max(0, (state?.snapshot.timeline.durationInFrames ?? 1) - 1)));
    playerRef.current?.seekTo(safeFrame);
    setPlayhead(safeFrame);
  };

  const snapshot = state?.snapshot;
  const previewInput = usePreviewInput(snapshot, API_BASE);
  const currentRevision = state?.revision.number ?? 0;
  const selectedAsset = selection?.kind === "asset" ? snapshot?.assets.find((asset) => asset.id === selection.id) : undefined;
  const selectedScene = selection?.kind === "scene" ? snapshot?.scenes.find((scene) => scene.id === selection.id) : undefined;
  const selectedItem = selection?.kind === "item" ? snapshot?.timeline.items.find((item) => item.id === selection.id) : undefined;
  const selectedCue = selection?.kind === "cue" ? snapshot?.effectCues.find((cue) => cue.id === selection.id) : undefined;
  const activeScene = useMemo(() => snapshot?.scenes.find((scene) => scene.startFrame <= playhead && playhead < scene.endFrame), [snapshot, playhead]);

  const createProject = async () => {
    try {
      setBusy(true);
      setMessage("创建项目…");
      const created = await api.createProject(newProjectName.trim() || "未命名项目", newProjectProfile, newProjectFps);
      const createdProjectId = created.snapshot.project.id;
      setProjectId(createdProjectId);
      // 新建后直接读回新项目，避免顶部入口仍短暂显示旧项目状态。
      await load(createdProjectId);
      await refreshProjects();
      setMessage("创建项目完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) {
    return (
      <main className="empty-state">
        <div className="empty-mark">▶</div>
        <h1>VideoCut 工作台</h1>
        <p>创建项目后，导入视频并建立可继续编辑的时间线。</p>
        <div className="create-project-row">
          <input aria-label="项目名称" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void createProject()} />
          <select aria-label="项目类型" value={newProjectProfile} onChange={(event) => setNewProjectProfile(event.target.value as ProductionProfile)}>
            {projectProfileOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <input aria-label="新建项目帧率" title="成片帧率：15–60整数" type="number" min={15} max={60} step={1} value={newProjectFps} onChange={event => setNewProjectFps(Number(event.target.value))} />
          <button className="primary" onClick={() => void createProject()} disabled={busy}>创建项目</button>
        </div>
        <CreativeDefaultsSettings />
        {message !== "准备就绪" && <p className="message">{message}</p>}
      </main>
    );
  }

  const videoAssets = snapshot.assets.filter((asset) => (asset.kind === "video" || asset.kind === "actor_video") && asset.status === "ready");
  const selectedForTimeline = selectedARollIds.filter((assetId) => videoAssets.some((asset) => asset.id === assetId));
  const blockingIssues = quality ? exportBlockingIssues(quality, "delivery") : [];
  const draftBlockingIssues = quality ? exportBlockingIssues(quality, "draft") : [];

  return (
    <main className="workbench" data-testid="workbench" data-project-id={snapshot.project.id} data-revision={currentRevision}>
      <header className="topbar">
        <div className="brand"><span className="brand-dot" />VideoCut <span className="brand-sub">创作工作台</span></div>
        <select aria-label="选择项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <input className="new-project-input" aria-label="新建项目名称" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void createProject()} />
        <select className="new-project-profile" aria-label="新建项目类型" value={newProjectProfile} onChange={(event) => setNewProjectProfile(event.target.value as ProductionProfile)}>
          {projectProfileOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <button data-testid="create-project-button" onClick={() => void createProject()} disabled={busy}>新建</button>
        <input className="new-project-fps" aria-label="新建项目帧率" title="成片帧率：15–60整数" type="number" min={15} max={60} step={1} value={newProjectFps} onChange={event => setNewProjectFps(Number(event.target.value))} />
        <strong data-testid="project-name" data-object-id={snapshot.project.id} className="project-name">{snapshot.project.name}</strong>
        <span className="save-state">● 已保存</span>
        <div className="top-spacer" />
        <span className="revision-badge" data-testid="revision">R{currentRevision}</span>
        <span className="canvas-summary">{snapshot.timeline.width}×{snapshot.timeline.height} · {snapshot.timeline.fps} fps · {formatDuration(snapshot.timeline.durationInFrames, snapshot.timeline.fps)}</span>
        <CreativeDefaultsSettings />
        <FrameRateSettings key={snapshot.project.id} projectId={snapshot.project.id} revision={currentRevision} fps={snapshot.timeline.fps} onApplied={async (fromFps, toFps, durationInFrames) => {
          const nextFrame = Math.min(Math.max(0, durationInFrames - 1), Math.round(playhead * toFps / fromFps));
          await load(snapshot.project.id);
          setPlayhead(nextFrame);
          playerRef.current?.seekTo(nextFrame);
          setMessage("帧率已更新，请重新预览并复核声画");
        }} />
        <button onClick={() => playerRef.current?.toggle()} disabled={!snapshot.timeline.durationInFrames}>播放</button>
        <button onClick={() => void act("提交局部预览", () => api.preview(snapshot.project.id, {
          revision: currentRevision,
          fromFrame: Math.max(0, playhead - snapshot.timeline.fps * 2),
          toFrame: Math.min(snapshot.timeline.durationInFrames, Math.max(playhead + snapshot.timeline.fps * 3, snapshot.timeline.fps))
        }))} disabled={busy || !snapshot.timeline.durationInFrames}>局部预览</button>
        <button onClick={() => void act("执行渲染前检查", () => api.renderPreflight(snapshot.project.id, currentRevision))} disabled={busy || !snapshot.timeline.durationInFrames}>渲染预检</button>
        <button onClick={() => void act("提交草稿导出", () => api.export(snapshot.project.id, currentRevision, "draft"))} disabled={busy || draftBlockingIssues.length > 0} title={draftBlockingIssues.map(issue => issue.message).join("；")}>草稿导出</button>
        <button className="primary" data-testid="export-button" onClick={() => void act("提交交付导出", () => api.export(snapshot.project.id, currentRevision, "delivery"))} disabled={busy || blockingIssues.length > 0} title={blockingIssues.map(issue => issue.message).join("；")}>交付导出</button>
      </header>

      <section className="editor-grid">
        <nav className="toolrail" aria-label="工作区">
          {panelMeta.map((entry) => <button key={entry.id} className={panel === entry.id ? "tool active" : "tool"} onClick={() => setPanel(entry.id)} title={entry.label} data-testid={`panel-${entry.id}`}><span>{entry.icon}</span><small>{entry.label}</small></button>)}
        </nav>

        <aside className="content-panel">
          <PanelContent
            panel={panel}
            snapshot={snapshot}
            currentRevision={currentRevision}
            quality={quality}
            jobs={jobs}
            exportArtifacts={exportArtifacts}
            revisions={revisions}
            selectedUnitIds={selectedUnitIds}
            localPath={localPath}
            setLocalPath={setLocalPath}
            onSelect={(next) => setSelection(next)}
            onSeek={seekTo}
            onImportPath={() => void act("导入本地素材", () => api.importPath(snapshot.project.id, currentRevision, localPath))}
            onUpload={(files) => void act("上传素材", () => api.upload(snapshot.project.id, currentRevision, files))}
            onTranscribe={(assetId) => void act("提交转写", () => api.transcribe(snapshot.project.id, assetId))}
            onRegisterVoiceReference={(assetId) => void act("登记 VoiceReference", () => api.registerVoiceReference(snapshot.project.id, currentRevision, assetId))}
            onSubmitVoiceSynthesis={(voiceReferenceId) => void act("提交 OmniVoice 旁白", () => api.voiceSynthesis(snapshot.project.id, voiceReferenceId))}
            onSubmitDialogueProcessing={(issueTypes, evidenceNote) => void act("生成对白处理试听候选", () => api.submitDialogueProcessing(snapshot.project.id, { baseRevision: currentRevision, issueTypes, evidenceNote }))}
            onSelectDialogueProcessingVariant={(profile) => void act("切换当前 Dialogue 候选", () => api.selectDialogueProcessingVariant(snapshot.project.id, { baseRevision: currentRevision, profile }))}
            onRebuildSpeechTimeline={() => void act("修复 SpeechAsset 时间线", () => api.rebuildSpeechTimeline(snapshot.project.id, currentRevision))}
            onEditCaption={(captionId, payload) => void act("更新字幕卡", () => api.editCaption(snapshot.project.id, captionId, { baseRevision: currentRevision, ...payload }))}
            onEditCaptionFormat={(format) => void act("更新全片字幕样式", () => api.editCaptionGlobalFormat(snapshot.project.id, { baseRevision: currentRevision, format }))}
            onManageAudio={(payload) => void act("更新声音包装", () => api.manageAudio(snapshot.project.id, { baseRevision: currentRevision, ...payload }))}
            onAlignPresenterToSpeech={() => void act("按旁白收齐 Presenter 主线", () => api.alignPresenterToSpeech(snapshot.project.id, currentRevision))}
            playhead={playhead}
            busy={busy}
            selectedARollIds={selectedForTimeline}
            onToggleARoll={(assetId) => setSelectedARollIds((old) => old.includes(assetId) ? old.filter((id) => id !== assetId) : [...old, assetId])}
            onBuildTimeline={() => void act("组装所选 Presenter A-roll", () => api.assemblePresenterTrack(snapshot.project.id, currentRevision, selectedForTimeline))}
            onToggleUnit={(unitId) => setSelectedUnitIds((old) => old.includes(unitId) ? old.filter((id) => id !== unitId) : [...old, unitId])}
            onApplyScript={() => void act("应用 Script", () => api.applyScript(snapshot.project.id, currentRevision, selectedUnitIds))}
            workOrderTitle={workOrderTitle}
            workOrderIntent={workOrderIntent}
            selectedWorkOrderObjectIds={selectedWorkOrderObjectIds}
            onChangeWorkOrderTitle={setWorkOrderTitle}
            onChangeWorkOrderIntent={setWorkOrderIntent}
            onToggleWorkOrderObject={(objectId) => setSelectedWorkOrderObjectIds((current) => current.includes(objectId) ? current.filter((id) => id !== objectId) : [...current, objectId])}
            onCreateWorkOrder={() => void act("创建 Agent 工作单", async () => {
              await api.createAgentWorkOrder(snapshot.project.id, {
                baseRevision: currentRevision,
                title: workOrderTitle,
                intent: workOrderIntent,
                relatedObjectIds: selectedWorkOrderObjectIds
              });
              setWorkOrderTitle("");
              setWorkOrderIntent("");
              setSelectedWorkOrderObjectIds([]);
            })}
            onCancelWorkOrder={(workOrderId) => {
              const reason = window.prompt("说明取消原因（将写入项目 Revision）：", "用户撤回该工作单");
              if (!reason?.trim()) return;
              void act("取消 Agent 工作单", () => api.cancelAgentWorkOrder(snapshot.project.id, workOrderId, {
                baseRevision: currentRevision,
                reason: reason.trim()
              }));
            }}
            onRegisterActor={(timelineItemId, maskAssetId) => void act("登记人物表演", () => api.registerActorPerformance(snapshot.project.id, {
              baseRevision: currentRevision,
              timelineItemId,
              source: "imported",
              maskMode: maskAssetId ? "alpha_asset" : "none",
              audioMode: snapshot.speechAsset ? "use_dialogue_track" : "use_source_audio",
              maskAssetId,
              note: "从工作台导入的人物主画面"
            }))}
            // 新增 Cue 不伪造正式文案；内容合同未满足时由质量面板明确提示，不能把工作台提示渲入成片。
            onAddEffect={(scene, type) => void act("添加效果", () => api.createEffect(snapshot.project.id, { baseRevision: currentRevision, sceneId: scene.id, type, layer: effectLayerByType[type], startFrame: scene.startFrame, endFrame: Math.min(scene.endFrame, scene.startFrame + Math.max(48, snapshot.timeline.fps * 3)) }))}
            onRetryJob={(jobId) => void act("重试任务", () => api.retryJob(jobId))}
            onRunAdvancedAction={(label, operation) => void act(label, operation)}
            onApproveExportArtifact={(artifactId) => {
              const artifact = exportArtifacts.find(entry => entry.id === artifactId);
              if (artifact && window.confirm(`确认已观看并同意将 R${artifact.revision} 的这个文件定稿吗？未关闭的辅助审阅提示将保留。`)) {
                void act("批准交付产物", () => api.approveExportArtifact(snapshot.project.id, artifactId, artifact.fileHash));
              }
            }}
            onRollback={(revision) => void act("回退 Revision", () => api.rollback(snapshot.project.id, revision, currentRevision))}
          />
        </aside>

        <section className="preview-panel">
          <div className="preview-toolbar">
            <span>真实合成预览</span>
            <span className="preview-status">{activeScene?.title ?? "未定位场景"}</span>
            <span>{formatTimecode(playhead, snapshot.timeline.fps)} · F{playhead}</span>
          </div>
          <div className="preview-stage" data-testid="preview-stage">
            <Player
              ref={playerRef}
              component={ProjectComposition}
              inputProps={previewInput!}
              durationInFrames={Math.max(1, snapshot.timeline.durationInFrames)}
              compositionWidth={snapshot.timeline.width}
              compositionHeight={snapshot.timeline.height}
              fps={snapshot.timeline.fps}
              controls
              clickToPlay
              acknowledgeRemotionLicense
              style={{ width: "100%", height: "100%" }}
            />
          </div>
          <div className="preview-controls">
            <button onClick={() => seekTo(Math.max(0, playhead - 1))}>‹ 帧</button>
            <button onClick={() => playerRef.current?.toggle()}>{playerRef.current?.isPlaying() ? "暂停" : "播放"}</button>
            <button onClick={() => seekTo(Math.min(snapshot.timeline.durationInFrames - 1, playhead + 1))}>帧 ›</button>
            <button onClick={() => activeScene && seekTo(activeScene.startFrame)}>场景起点</button>
            <span className="message" aria-live="polite">{message}</span>
          </div>
        </section>

        <aside className="inspector" data-testid="inspector" data-selected-kind={selection?.kind ?? "none"} data-selected-id={selection?.id ?? ""}>
          <Inspector
            snapshot={snapshot}
            selection={selection}
            selectedAsset={selectedAsset}
            selectedScene={selectedScene}
            selectedItem={selectedItem}
            selectedCue={selectedCue}
            currentRevision={currentRevision}
            onMoveItem={(item, startFrame) => void act("移动片段", () => api.moveItem(snapshot.project.id, item.id, { baseRevision: currentRevision, startFrame, ripple: false }))}
            onUpdateCue={(cue, intensity) => void act("调整效果", () => api.updateEffect(snapshot.project.id, cue.id, { baseRevision: currentRevision, intensity }))}
            onSeek={seekTo}
          />
        </aside>

        <section className="timeline-area">
          <TimelineEditor key={snapshot.project.id} snapshot={snapshot} selection={selection} playhead={playhead} onSelect={(selectionValue, frame) => { setSelection(selectionValue); seekTo(frame); }} onSeek={seekTo} onScrubStart={() => playerRef.current?.pause()} />
        </section>
      </section>
    </main>
  );
}

interface PanelContentProps {
  panel: Panel;
  snapshot: ProjectSnapshot;
  currentRevision: number;
  quality: Awaited<ReturnType<typeof api.quality>> | undefined;
  jobs: Awaited<ReturnType<typeof api.jobs>>;
  exportArtifacts: ExportArtifact[];
  revisions: Awaited<ReturnType<typeof api.revisions>>;
  selectedUnitIds: string[];
  localPath: string;
  setLocalPath: (value: string) => void;
  onSelect: (selection: Selection) => void;
  onSeek: (frame: number) => void;
  onImportPath: () => void;
  onUpload: (files: File[]) => void;
  onTranscribe: (assetId: string) => void;
  onRegisterVoiceReference: (assetId: string) => void;
  onSubmitVoiceSynthesis: (voiceReferenceId: string) => void;
  onSubmitDialogueProcessing: (issueTypes: DialogueProcessingIssue[], evidenceNote: string) => void;
  onSelectDialogueProcessingVariant: (profile: DialogueProcessingProfile) => void;
  onRebuildSpeechTimeline: () => void;
  onEditCaption: (captionId: string, payload: Record<string, unknown>) => void;
  onEditCaptionFormat: (format: Record<string, unknown>) => void;
  onManageAudio: (payload: Record<string, unknown>) => void;
  onAlignPresenterToSpeech: () => void;
  playhead: number;
  busy: boolean;
  selectedARollIds: string[];
  onToggleARoll: (assetId: string) => void;
  onBuildTimeline: () => void;
  onToggleUnit: (unitId: string) => void;
  onApplyScript: () => void;
  workOrderTitle: string;
  workOrderIntent: string;
  selectedWorkOrderObjectIds: string[];
  onChangeWorkOrderTitle: (value: string) => void;
  onChangeWorkOrderIntent: (value: string) => void;
  onToggleWorkOrderObject: (objectId: string) => void;
  onCreateWorkOrder: () => void;
  onCancelWorkOrder: (workOrderId: string) => void;
  onRegisterActor: (timelineItemId: string, maskAssetId?: string) => void;
  onAddEffect: (scene: Scene, type: EffectCue["type"]) => void;
  onRetryJob: (jobId: string) => void;
  onRunAdvancedAction: (label: string, operation: () => Promise<unknown>) => void;
  onApproveExportArtifact: (artifactId: string) => void;
  onRollback: (revision: number) => void;
}

function PanelContent(props: PanelContentProps) {
  const { panel, snapshot } = props;
  if (panel === "fonts") return <FontLibraryPanel key={snapshot.project.id} />;
  if (panel === "assets") {
    return <>
      <PanelTitle title="素材库" meta={`${snapshot.assets.length} 个素材`} />
      <label className="upload-button">上传媒体<input aria-label="上传媒体" type="file" accept="video/*,audio/*,image/*" multiple hidden onChange={(event) => event.target.files && props.onUpload([...event.target.files])} /></label>
      <div className="path-import"><input aria-label="本地素材路径" placeholder="本地素材绝对路径" value={props.localPath} onChange={(event) => props.setLocalPath(event.target.value)} /><button onClick={props.onImportPath} disabled={!props.localPath.trim()}>导入</button></div>
      <p className="empty-panel">先明确选择 A-roll，再由导演 Skill 通过 Story Beat 编译 Scene；不会默认把所有视频当人物主画面。</p>
      <button className="wide-button" onClick={props.onBuildTimeline} disabled={props.selectedARollIds.length === 0}>组装 {props.selectedARollIds.length} 条所选 A-roll</button>
      <div className="asset-list">{snapshot.assets.map((asset) => <article key={asset.id} className="asset-card" data-testid={`asset-${asset.id}`} data-object-id={asset.id} aria-label={`素材：${asset.name}`} onClick={() => props.onSelect({ kind: "asset", id: asset.id })}>
        {asset.metadata?.thumbnailPath ? <img src={mediaUrl(snapshot, API_BASE, asset.metadata.thumbnailPath)} alt="素材缩略图" /> : <div className="asset-placeholder">{assetIcon(asset)}</div>}
        <div className="asset-copy"><strong>{asset.name}</strong><small>{asset.metadata?.durationMs ? `${(asset.metadata.durationMs / 1000).toFixed(1)} 秒` : "等待媒体分析"}</small><span className={`status status-${asset.status}`}>{statusText(asset.status)}</span></div>
        {(asset.kind === "video" || asset.kind === "actor_video") && !asset.motion && asset.status === "ready" && <button className="compact" onClick={(event) => { event.stopPropagation(); props.onToggleARoll(asset.id); }}>{props.selectedARollIds.includes(asset.id) ? "取消 A-roll" : "选为 A-roll"}</button>}
        {(asset.kind === "video" || asset.kind === "actor_video") && asset.status === "ready" && asset.metadata?.hasAudio && <button className="compact" onClick={(event) => { event.stopPropagation(); props.onTranscribe(asset.id); }}>转写</button>}
      </article>)}</div>
    </>;
  }
  if (panel === "agent_work_orders") {
    return <AgentWorkOrdersPanel
      snapshot={snapshot}
      title={props.workOrderTitle}
      intent={props.workOrderIntent}
      selectedObjectIds={props.selectedWorkOrderObjectIds}
      disabled={props.busy}
      onChangeTitle={props.onChangeWorkOrderTitle}
      onChangeIntent={props.onChangeWorkOrderIntent}
      onToggleObject={props.onToggleWorkOrderObject}
      onCreate={props.onCreateWorkOrder}
      onCancel={props.onCancelWorkOrder}
    />;
  }
  if (panel === "advanced") {
    return <AdvancedWorkflowsPanel
      snapshot={snapshot}
      currentRevision={props.currentRevision}
      jobs={props.jobs}
      busy={props.busy}
      onRunAction={props.onRunAdvancedAction}
    />;
  }
  if (panel === "script") {
    return <>
      <PanelTitle title="文字稿 / Script" meta={`Script R${snapshot.script.revision}`} />
      {snapshot.transcripts.length === 0 && <p className="empty-panel">选择有声素材后提交 FunASR 转写。当前 API 只提供全文，不能凭字数伪造词级时间。</p>}
      <div className="script-list">{snapshot.semanticUnits.sort((a, b) => a.order - b.order).map((unit) => <label className={props.selectedUnitIds.includes(unit.id) ? "semantic-unit selected" : "semantic-unit"} key={unit.id} data-testid={`semantic-${unit.id}`} data-object-id={unit.id}><input aria-label={`选择语义单元：${unit.text}`} type="checkbox" checked={props.selectedUnitIds.includes(unit.id)} onChange={() => props.onToggleUnit(unit.id)} /><span>{unit.text}</span></label>)}</div>
      {snapshot.semanticUnits.length > 0 && <button className="primary wide-button" onClick={props.onApplyScript}>应用语义选择 · 生成 SpeechSegment</button>}
      <PanelTitle title="SpeechSegment" meta={`${snapshot.speechSegments.length} 段`} />
      {snapshot.speechSegments.map((segment) => <div className="speech-row" key={segment.id} data-testid={`speech-segment-${segment.id}`} data-object-id={segment.id}><span>{segment.text}</span><small>{statusText(segment.status)}</small></div>)}
      <PanelTitle title="VoiceReference" meta={`${snapshot.voiceReferences.length} 条本地参考`} />
      {snapshot.voiceReferences.map((reference) => {
        const asset = snapshot.assets.find((candidate) => candidate.id === reference.assetId);
        return <div className="speech-row" key={reference.id} data-testid={`voice-reference-${reference.id}`} data-object-id={reference.id}><span>{reference.label}</span><small>{asset?.name ?? "素材缺失"}</small></div>;
      })}
      {snapshot.assets.filter((asset) => asset.kind === "audio" && asset.status === "ready" && !snapshot.voiceReferences.some((reference) => reference.assetId === asset.id)).map((asset) => <button className="wide-button" key={asset.id} onClick={() => props.onRegisterVoiceReference(asset.id)}>将「{asset.name}」登记为 VoiceReference</button>)}
    </>;
  }
  if (panel === "audio") {
    const speechFile = snapshot.speechAsset ? snapshot.assets.find((asset) => asset.id === snapshot.speechAsset?.assetId) : undefined;
    const pendingSegments = snapshot.speechSegments.filter((segment) => segment.status !== "ready");
    const needsAssembly = Boolean(!snapshot.speechAsset && snapshot.speechSegments.length > 0 && pendingSegments.length === 0);
    const dialogueTrack = snapshot.timeline.tracks.find((track) => track.name === "Dialogue");
    const hasSpeechOnDialogue = Boolean(snapshot.speechAsset && snapshot.timeline.items.some((item) => item.trackId === dialogueTrack?.id && item.assetId === snapshot.speechAsset?.assetId && !item.disabled));
    const readyMixAssets = snapshot.assets.filter((asset) => asset.kind === "audio" && asset.status === "ready" && asset.metadata?.hasAudio);
    const audioItemsById = new Map(snapshot.timeline.items.map((item) => [item.id, item]));
    return <>
      <PanelTitle title="Audio / Voice" meta={`${snapshot.voiceReferences.length} 条参考声音`} />
      {snapshot.voiceReferences.length === 0 && <p className="empty-panel">先在文字稿面板登记一个已就绪的本地音频。VoiceReference 仅保存本地 Asset，不会创建不存在的远端 Voice ID。</p>}
      {snapshot.voiceReferences.map((reference) => <article className="audio-card" key={reference.id} data-testid={`voice-reference-${reference.id}`} data-object-id={reference.id}>
        <strong>{reference.label}</strong>
        <small>{reference.quality === "passed" ? "技术检查通过" : "需复核：建议使用 3～15 秒、单人且低噪声的参考音频"}</small>
        <button className="wide-button primary" data-testid={`submit-voice-${reference.id}`} onClick={() => props.onSubmitVoiceSynthesis(reference.id)} disabled={snapshot.speechSegments.length === 0 || (pendingSegments.length === 0 && !needsAssembly)}>{needsAssembly ? "复用已生成片段并重新组装旁白" : "生成 / 更新待处理旁白"}</button>
      </article>)}
      <PanelTitle title="SpeechAsset" meta={snapshot.speechAsset ? snapshot.speechAsset.timing.precision : "尚未生成"} />
      {snapshot.speechAsset
        ? <section className="audio-card" data-testid="speech-asset" data-object-id={snapshot.speechAsset.id}><strong>{speechFile?.name ?? "旁白总轨"}</strong><small>Script R{snapshot.speechAsset.scriptRevision} · {snapshot.speechAsset.timing.segments.length} 个段边界 · {hasSpeechOnDialogue ? "已写入 Dialogue 轨" : "尚未写入 Dialogue 轨"}</small><small>{speechFile?.metadata?.durationMs ? `${(speechFile.metadata.durationMs / 1000).toFixed(2)} 秒` : "等待音频元数据"} · 不提供词级时间</small>{!hasSpeechOnDialogue && <button className="wide-button" data-testid="rebuild-speech-timeline" onClick={props.onRebuildSpeechTimeline}>修复 Dialogue 与字幕</button>}{hasSpeechOnDialogue && <button className="wide-button" data-testid="align-presenter-to-speech" onClick={props.onAlignPresenterToSpeech}>按旁白时长收齐 Presenter 主线</button>}</section>
        : <p className="empty-panel">选择 VoiceReference 后，系统会仅生成 pending / stale 的 SpeechSegment，完成后组装为可播放的 SpeechAsset、Dialogue Item 和稳定字幕。</p>}
      {snapshot.speechAsset && <DialogueProcessingPanel
        snapshot={snapshot}
        speechAsset={snapshot.speechAsset}
        hasSpeechOnDialogue={hasSpeechOnDialogue}
        pending={props.jobs.some((job) => job.kind === "dialogue_processing" && (job.status === "queued" || job.status === "running" || job.status === "unknown"))}
        disabled={props.busy}
        onSubmit={props.onSubmitDialogueProcessing}
        onSelect={props.onSelectDialogueProcessingVariant}
      />}
      <PanelTitle title="BGM / SFX" meta={`${snapshot.audioCues.length} 条声音包装`} />
      <SoundLibraryPanel snapshot={snapshot} />
      <p className="empty-panel">音乐按段落主声音退让；动作音效可绑定作品的起势、落定或持续范围。原文件起音和整体听感需在实际声画中复核。</p>
      {readyMixAssets.length === 0 && <p className="empty-panel">导入并分析完成独立音频后，才可作为 BGM 或 SFX 使用。</p>}
      {readyMixAssets.map((asset) => {
        const sourceFrames = Math.max(1, Math.round((asset.metadata!.durationMs / 1_000) * snapshot.timeline.fps));
        const programFrames = snapshot.timeline.durationInFrames;
        return <article className="audio-card audio-source-card" key={asset.id} data-testid={`mix-source-${asset.id}`} data-object-id={asset.id}>
          <strong>{asset.name}</strong><small>{formatDuration(sourceFrames, snapshot.timeline.fps)} · 已就绪本地音频</small>
          <div className="button-row">
            <button type="button" disabled={props.busy || programFrames <= 0} onClick={() => props.onManageAudio({
              action: "create", kind: "bgm", assetId: asset.id, purpose: `为当前主线提供克制的背景音乐：${asset.name}`,
              loop: sourceFrames < programFrames, gainDb: -18,
              fadeInFrames: Math.min(12, Math.floor(programFrames / 2)), fadeOutFrames: Math.min(24, Math.floor(programFrames / 2)),
              ducking: { enabled: true, reductionDb: -14, attackFrames: 4, releaseFrames: 14 }
            })}>作为 BGM</button>
            <button type="button" disabled={props.busy || programFrames <= 0} onClick={() => props.onManageAudio({
              action: "create", kind: "sfx", assetId: asset.id, purpose: `为当前画面事件提供声音强调：${asset.name}`,
              eventFrame: Math.min(props.playhead, Math.max(0, programFrames - 1)), onsetOffsetFrames: 0, gainDb: -6
            })}>在播放头加 SFX</button>
          </div>
        </article>;
      })}
      {snapshot.audioCues.map((cue) => {
        const item = audioItemsById.get(cue.timelineItemId);
        const asset = snapshot.assets.find((candidate) => candidate.id === cue.assetId);
        return item && <AudioCueEditor key={cue.id} cue={cue} item={item} asset={asset} disabled={props.busy} onSeek={props.onSeek} onSave={props.onManageAudio} />;
      })}
      <div className="speech-list">{snapshot.speechSegments.map((segment) => <div className="speech-row" key={segment.id} data-testid={`audio-segment-${segment.id}`} data-object-id={segment.id}><span>{segment.text}</span><small>{statusText(segment.status)}</small></div>)}</div>
    </>;
  }
  if (panel === "actors") {
    return <ActorsPanel snapshot={snapshot} onRegisterActor={props.onRegisterActor} />;
  }
  if (panel === "scenes") {
    return <ScenesPanel snapshot={snapshot} onSelect={props.onSelect} onSeek={props.onSeek} onAddEffect={props.onAddEffect} />;
  }
  if (panel === "captions") {
    return <>
      <PanelTitle title="字幕 Caption" meta={`${snapshot.timeline.captions.length} 张字幕卡`} />
      {snapshot.timeline.captions.length === 0 && <p className="empty-panel">当前没有可用的段级语音时序。字幕只会在 SpeechAsset 组装成功后生成。</p>}
      {snapshot.timeline.captionFormat
        ? <CaptionFormatEditor format={snapshot.timeline.captionFormat} disabled={props.busy} onSave={props.onEditCaptionFormat} />
        : <><p className="empty-panel">此历史项目保留逐卡样式。切换后将使用统一默认规范，替换所有逐卡样式和强调，保留正文与时间。</p>
          <button type="button" disabled={props.busy} onClick={() => props.onEditCaptionFormat({ maxLines: 2 })}>切换为全片统一样式</button></>}
      {snapshot.timeline.captions.map((caption) => <CaptionEditor key={caption.id} caption={caption} unified={Boolean(snapshot.timeline.captionFormat)} disabled={props.busy} onSeek={props.onSeek} onSave={props.onEditCaption} />)}
    </>;
  }
  return <>
    <PanelTitle title="Jobs / Quality / Revision" meta="统一状态" />
    <section className="quality-section"><h3>技术检查与审阅提示</h3>{props.quality && <p className="quality-review-status">辅助审阅（不阻挡导出）：{props.quality.editorial.status === "reviewed" ? "本版五轮覆盖完整" : props.quality.editorial.status === "partial" ? "阶段记录，整片尚未审完" : props.quality.editorial.status === "stale" ? "已过期，需复核当前 Revision" : "尚未记录"} · 预览证据 {props.quality.editorial.previewEvidence.length} 条</p>}{props.quality?.issues.length ? props.quality.issues.map((issue) => <div className={`quality-row ${issue.editorialSeverity ? "warning" : issue.level}`} key={issue.id}><strong>{issue.editorialSeverity ? "审阅提示" : issue.level === "blocking" ? `阻挡${issue.blockingPurposes?.length === 1 ? issue.blockingPurposes[0] === "draft" ? "内部审阅" : "对外交付" : "导出"}` : "建议"}</strong><span>{issue.message}</span></div>) : <p className="success-text">没有检测到结构性问题</p>}</section>
    <section><h3>任务</h3>{props.jobs.map((job) => <div className="job-row" key={job.id} data-testid={`job-${job.id}`} data-object-id={job.id}><span className={`status status-${job.status}`}>{statusText(job.status)}</span><div><strong>{job.kind}</strong><small>{job.error ?? job.id.slice(0, 14)}</small></div>{job.status === "failed" && <button onClick={() => props.onRetryJob(job.id)}>重试</button>}</div>)}</section>
    <section><h3>Export Artifact</h3>{props.exportArtifacts.length === 0
      ? <p className="empty-panel">尚无导出文件。技术与用途条件满足即可导出，观看后由用户决定是否定稿。</p>
      : props.exportArtifacts.map((artifact) => <article className="artifact-row" key={artifact.id} data-testid={`export-artifact-${artifact.id}`} data-object-id={artifact.id}>
        <div><strong>{artifact.purpose === "delivery" ? "交付" : "草稿"} · R{artifact.revision}</strong><small>预检 {artifact.preflight.status === "passed" ? "通过" : "失败"} · {artifact.validation.durationMs}ms · SHA-256 {artifact.fileHash.slice(0, 12)}…</small><small>{artifact.approval ? `人工已定稿 · ${artifact.approval.approvedAt}` : "文件已导出 · 尚未人工定稿"}</small></div>
        <div className="artifact-actions"><a href={mediaUrl(snapshot, API_BASE, artifact.relativePath)} target="_blank" rel="noreferrer">打开文件</a>{artifact.purpose === "delivery" && !artifact.approval && <button onClick={() => props.onApproveExportArtifact(artifact.id)}>人工定稿</button>}</div>
      </article>)}</section>
    <section><h3>Revision</h3>{props.revisions.map((revision) => <div className="revision-row" key={revision.id} data-testid={`revision-${revision.number}`} data-object-id={revision.id}><div><strong>R{revision.number}</strong><span>{revision.summary}</span></div>{revision.number !== props.currentRevision && <button onClick={() => props.onRollback(revision.number)}>回退</button>}</div>)}</section>
  </>;
}

const dialogueProcessingIssueLabels: Record<DialogueProcessingIssue, string> = {
  noise: "底噪 / 环境噪声",
  low_frequency: "低频轰鸣 / 近讲低频",
  sibilance: "齿音过强",
  loudness: "响度不均",
  true_peak: "峰值过高"
};

/**
 * 首版对白处理只提供整条 SpeechAsset 的 A/B/C 试听。这里不写 Timeline：
 * 用户点选后才由 Application 创建 Revision 并替换唯一 Dialogue Item。
 */
function DialogueProcessingPanel({
  snapshot,
  speechAsset,
  hasSpeechOnDialogue,
  pending,
  disabled,
  onSubmit,
  onSelect
}: {
  snapshot: ProjectSnapshot;
  speechAsset: SpeechAsset;
  hasSpeechOnDialogue: boolean;
  pending: boolean;
  disabled: boolean;
  onSubmit: (issueTypes: DialogueProcessingIssue[], evidenceNote: string) => void;
  onSelect: (profile: DialogueProcessingProfile) => void;
}) {
  const processing = speechAsset.dialogueProcessing;
  const [issueTypes, setIssueTypes] = useState<DialogueProcessingIssue[]>([]);
  const [evidenceNote, setEvidenceNote] = useState("");
  useEffect(() => {
    setIssueTypes(processing?.issueTypes ?? []);
    setEvidenceNote(processing?.evidenceNote ?? "");
  }, [speechAsset.id, processing?.jobId]);

  const toggleIssue = (issue: DialogueProcessingIssue) => {
    setIssueTypes((current) => current.includes(issue)
      ? current.filter((entry) => entry !== issue)
      : [...current, issue]);
  };
  // 未显式选择时原声只是默认播放，不等于用户已完成 A/B 试听并确认保留它。
  const activeProfile = processing?.selectedProfile ?? "original";
  const variantAsset = (assetId: string) => snapshot.assets.find((asset) => asset.id === assetId);

  return <section className="audio-card dialogue-processing-card" data-testid="dialogue-processing" data-object-id={speechAsset.id}>
    <strong>Dialogue Processing</strong>
    <small>仅处理当前完整旁白，不做局部修补、Room Tone 或自动审美选择。更干净不自动等于更自然。</small>
    {!hasSpeechOnDialogue && <small className="dialogue-processing-warning">当前 SpeechAsset 尚未以唯一 Item 写入 Dialogue 轨，先修复时间线后才能生成候选。</small>}
    {!processing && <>
      <div className="dialogue-processing-issues" aria-label="确认的对白问题">
        {(Object.keys(dialogueProcessingIssueLabels) as DialogueProcessingIssue[]).map((issue) => <label key={issue}>
          <input
            type="checkbox"
            checked={issueTypes.includes(issue)}
            disabled={disabled || pending || !hasSpeechOnDialogue}
            onChange={() => toggleIssue(issue)}
          />
          <span>{dialogueProcessingIssueLabels[issue]}</span>
        </label>)}
      </div>
      <label className="dialogue-processing-evidence">复听依据
        <textarea
          aria-label="对白处理复听依据"
          value={evidenceNote}
          maxLength={2_000}
          rows={3}
          placeholder="例如：00:12–00:28 可听见持续空调底噪，句尾峰值偏高；请比较处理副作用。"
          disabled={disabled || pending || !hasSpeechOnDialogue}
          onChange={(event) => setEvidenceNote(event.target.value)}
        />
      </label>
      <button
        className="wide-button"
        type="button"
        data-testid="submit-dialogue-processing"
        disabled={disabled || pending || !hasSpeechOnDialogue || issueTypes.length === 0 || !evidenceNote.trim()}
        onClick={() => onSubmit(issueTypes, evidenceNote.trim())}
      >{pending ? "正在生成试听候选…" : "生成原声 / 最小处理 / 强处理对比"}</button>
    </>}
    {processing && <>
      <small>已确认问题：{processing.issueTypes.map((issue) => dialogueProcessingIssueLabels[issue]).join("、")}。</small>
      <small>复听依据：{processing.evidenceNote}</small>
      <div className="dialogue-processing-variants">
        {processing.variants.map((variant) => {
          const asset = variantAsset(variant.assetId);
          const isCurrent = activeProfile === variant.profile;
          const isConfirmed = processing.selectedProfile === variant.profile;
          const label = variant.profile === "original" ? "原声" : variant.profile === "minimal" ? "最小处理" : "强处理";
          return <article key={variant.profile} className={isCurrent ? "dialogue-processing-variant current" : "dialogue-processing-variant"} data-testid={`dialogue-processing-${variant.profile}`}>
            <div><strong>{label}{isCurrent ? processing.selectedProfile ? " · 当前 Dialogue" : " · 当前默认原声（待确认）" : ""}</strong><small>{variant.filters.length === 0 ? "未处理原声" : variant.filters.join(" → ")}</small></div>
            {asset?.managedPath && <audio controls preload="metadata" src={mediaUrl(snapshot, API_BASE, asset.managedPath)}>当前浏览器无法播放此音频。</audio>}
            {!asset && <small className="dialogue-processing-warning">候选素材缺失，不能选择。</small>}
            <button type="button" disabled={disabled || !asset || isConfirmed} onClick={() => onSelect(variant.profile)}>{isConfirmed ? "已确认当前 Dialogue" : isCurrent ? "确认保留原声" : "设为当前 Dialogue"}</button>
          </article>;
        })}
      </div>
      <small className="dialogue-processing-warning">请完整试听三种版本后再选择；切换二进制音频会要求重新复核词级对齐、人物口型与完整声画。</small>
    </>}
  </section>;
}

/**
 * Web 只负责把用户意图落成受 Revision 管理的工作单；这里不模拟 LLM，也不允许
 * 在页面中直接把工作单标记完成。Codex 必须通过 MCP 接手、执行并回写真实 Revision。
 */
function AgentWorkOrdersPanel({ snapshot, title, intent, selectedObjectIds, disabled, onChangeTitle, onChangeIntent, onToggleObject, onCreate, onCancel }: {
  snapshot: ProjectSnapshot;
  title: string;
  intent: string;
  selectedObjectIds: string[];
  disabled: boolean;
  onChangeTitle: (value: string) => void;
  onChangeIntent: (value: string) => void;
  onToggleObject: (objectId: string) => void;
  onCreate: () => void;
  onCancel: (workOrderId: string) => void;
}) {
  const options = workOrderObjectOptions(snapshot);
  const orders = [...snapshot.agentWorkOrders].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return <>
    <PanelTitle title="Agent 工作单" meta={`${orders.length} 条 · 当前 Revision`} />
    <p className="empty-panel">把要完成的剪辑意图交给 Codex。关联对象只保存当前项目对象 ID，不复制时间线；Codex 接手和完成都会产生新的 Revision。</p>
    <section className="agent-work-order-form" data-testid="agent-work-order-form">
      <label>工作单标题<input aria-label="Agent 工作单标题" value={title} maxLength={160} placeholder="例如：收紧开场并复核前两段节奏" onChange={(event) => onChangeTitle(event.target.value)} /></label>
      <label>给 Codex 的意图<textarea aria-label="Agent 工作单意图" value={intent} maxLength={4_000} rows={4} placeholder="说明要解决的问题、保留的内容和验收依据。" onChange={(event) => onChangeIntent(event.target.value)} /></label>
      <div className="agent-work-order-objects">
        <strong>关联当前对象（可选）</strong>
        {options.length === 0 ? <small>当前还没有可关联对象。</small> : options.map((option) => <label key={option.id} className="agent-work-order-object" data-object-id={option.id}>
          <input type="checkbox" aria-label={`关联${option.kind}：${option.label}`} checked={selectedObjectIds.includes(option.id)} onChange={() => onToggleObject(option.id)} />
          <span>{option.kind}</span><em>{option.label}</em>
        </label>)}
      </div>
      <button className="primary wide-button" data-testid="create-agent-work-order" type="button" disabled={disabled || !title.trim() || !intent.trim()} onClick={onCreate}>提交给 Codex</button>
    </section>
    <PanelTitle title="交接记录" meta={`${orders.filter((order) => order.status === "open").length} 条待处理`} />
    {orders.length === 0 && <p className="empty-panel">尚无工作单。提交后可由 Codex 从 MCP 读取并接手。</p>}
    <div className="agent-work-order-list">{orders.map((order) => <AgentWorkOrderCard key={order.id} order={order} disabled={disabled} onCancel={onCancel} />)}</div>
  </>;
}

function AgentWorkOrderCard({ order, disabled, onCancel }: { order: AgentWorkOrder; disabled: boolean; onCancel: (workOrderId: string) => void }) {
  return <article className={`agent-work-order-card ${order.status}`} data-testid={`agent-work-order-${order.id}`} data-object-id={order.id}>
    <div className="agent-work-order-heading"><strong>{order.title}</strong><span className={`status status-${order.status}`}>{statusText(order.status)}</span></div>
    <p>{order.intent}</p>
    <small>创建 R{order.createdRevision} · 关联 {order.relatedObjectIds.length} 个对象</small>
    {order.claimedBy && <small>接手：{order.claimedBy} · R{order.claimedRevision}</small>}
    {order.status === "open" && <button className="agent-work-order-cancel" type="button" disabled={disabled} onClick={() => onCancel(order.id)}>取消工作单</button>}
    {order.status === "cancelled" && <small>取消 R{order.cancelledRevision} · {order.cancellationReason}</small>}
    {order.releasedRevision && <small>上次释放 R{order.releasedRevision} · {order.releaseReason}</small>}
    {order.status === "completed" && <>
      <small>{order.completionKind === "reviewed_no_change" ? "已审查，无编辑改动" : `已编辑 ${order.resultChangedObjectIds?.length ?? 0} 个对象`} · 实际结果 R{order.resultRevision} · 完成回写 R{order.completedRevision}</small>
      <p className="agent-work-order-summary">{order.completionSummary}</p>
      {order.resultImpact && <small>影响证据：R{order.resultImpact.fromRevision}–R{order.resultImpact.toRevision}，{order.resultImpact.revisions.length} 次 Revision</small>}
    </>}
    {(order.relatedObjectIssues?.length ?? 0) > 0 && <small className="agent-work-order-warning">关联对象需复核：{order.relatedObjectIssues?.map((issue) => issue.objectId).join("、")}</small>}
  </article>;
}

/** 全片统一项目只编辑正文和显隐；历史项目保留原有局部操作。 */
export function CaptionEditor({ caption, unified, disabled, onSeek, onSave }: {
  caption: CaptionCard;
  unified: boolean;
  disabled: boolean;
  onSeek: (frame: number) => void;
  onSave: (captionId: string, payload: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState(caption.text);
  const [fontSize, setFontSize] = useState(caption.format?.fontSize ?? 32);
  const [bottomPercent, setBottomPercent] = useState(caption.format?.bottomPercent ?? 7);
  const [shown, setShown] = useState(caption.display?.mode !== "hidden");
  const [placement, setPlacement] = useState(caption.format?.placement);
  const [emphasisText, setEmphasisText] = useState(caption.emphasis?.text ?? "");

  useEffect(() => {
    setShown(caption.display?.mode !== "hidden");
    setPlacement(caption.format?.placement);
    setText(caption.text);
    setFontSize(caption.format?.fontSize ?? 32);
    setBottomPercent(caption.format?.bottomPercent ?? 7);
    setEmphasisText(caption.emphasis?.text ?? "");
  }, [caption.display, caption.format?.placement, caption.id, caption.text, caption.format?.fontSize, caption.format?.bottomPercent, caption.emphasis?.text]);

  const save = () => {
    const phrase = emphasisText.trim();
    const previousEmphasis = caption.emphasis;
    onSave(caption.id, captionCardUpdate(unified, {
      action: "update",
      text,
      format: { fontSize, bottomPercent, placement: placement ?? null },
      display: shown ? { mode: "shown", ...(caption.display?.mode === "shown" && caption.display.ranges ? { ranges: caption.display.ranges } : {}) } : { mode: "hidden" },
      emphasis: phrase ? {
        text: phrase,
        occurrence: previousEmphasis?.text === phrase ? previousEmphasis.occurrence : 0,
        color: previousEmphasis?.text === phrase ? previousEmphasis.color : "#ffd166",
        backgroundColor: previousEmphasis?.text === phrase ? previousEmphasis.backgroundColor : undefined,
        fontWeight: previousEmphasis?.text === phrase ? previousEmphasis.fontWeight : 850,
        scale: previousEmphasis?.text === phrase ? previousEmphasis.scale : 1.05
      } : null
    }));
  };

  return <article className="caption-card" data-testid={`caption-${caption.id}`} data-object-id={caption.id}>
    <button className="caption-summary" type="button" onClick={() => { onSeek(caption.startFrame); setExpanded((value) => !value); }}>
      <strong>{caption.text}</strong>
      <small>F{caption.startFrame}–{caption.endFrame} · {caption.precision} · {caption.textMode === "manual" ? "屏幕文案已编辑" : "语音原文"}</small>
    </button>
    {expanded && <div className="caption-editor">
      <label><input type="checkbox" checked={shown} onChange={event => setShown(event.target.checked)} />显示这张字幕</label>
      {caption.display?.ranges && <p>显示范围：{caption.display.ranges.map(r => `F${r.startFrame}–${r.endFrame}`).join("、")} <button type="button" disabled={disabled} onClick={() => onSave(caption.id, { action: "update", display: null })}>恢复整卡显示</button></p>}
      {!unified && <><label>布局<select value={placement ? "placed" : "bottom"} onChange={event => setPlacement(event.target.value === "placed" ? { leftPercent: 8, topPercent: 12, widthPercent: 84 } : undefined)}><option value="bottom">底部布局</option><option value="placed">自定位置</option></select></label>
      {placement && <div className="caption-field-row">{([["leftPercent", "左侧 %"], ["topPercent", "顶部 %"], ["widthPercent", "宽度 %"]] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min={key === "widthPercent" ? 5 : 0} max={100} value={placement[key]} onChange={event => setPlacement({ ...placement, [key]: Number(event.target.value) })} /></label>)}</div>}
      </>}
      <label>屏幕文案<textarea aria-label={`字幕文案：${caption.id}`} value={text} maxLength={80} rows={2} onChange={(event) => setText(event.target.value)} /></label>
      {!unified && <><div className="caption-field-row">
        <label>字号<input aria-label={`字幕字号：${caption.id}`} type="number" min="16" max="72" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} /></label>
        <label>距底部 %<input aria-label={`字幕距底部百分比：${caption.id}`} type="number" min="0" max="95" step="0.5" value={bottomPercent} onChange={(event) => setBottomPercent(Number(event.target.value))} /></label>
      </div>
      <label>强调短语（可留空）<input aria-label={`字幕强调短语：${caption.id}`} value={emphasisText} maxLength={40} onChange={(event) => setEmphasisText(event.target.value)} /></label>
      </>}
      <div className="button-row">
        <button type="button" disabled={disabled} onClick={save}>保存字幕</button>
        <button type="button" disabled={disabled} onClick={() => onSave(caption.id, { action: "reset" })}>恢复语音原文</button>
      </div>
    </div>}
  </article>;
}

/** BGM / SFX 仅暴露当前阶段可安全持久化的参数；复杂 EQ、自动配乐和波形编辑不伪装成已实现。 */
function AudioCueEditor({ cue, item, asset, disabled, onSeek, onSave }: {
  cue: AudioCue;
  item: TimelineItem;
  asset?: Asset;
  disabled: boolean;
  onSeek: (frame: number) => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [gainDb, setGainDb] = useState(item.gainDb ?? (cue.kind === "bgm" ? -18 : -6));
  const [fadeInFrames, setFadeInFrames] = useState(cue.fadeInFrames);
  const [fadeOutFrames, setFadeOutFrames] = useState(cue.fadeOutFrames);
  const [loop, setLoop] = useState(cue.loop);
  const [eventFrame, setEventFrame] = useState(cue.eventFrame ?? item.startFrame);
  const [onsetOffsetFrames, setOnsetOffsetFrames] = useState(cue.onsetOffsetFrames ?? 0);
  const [duckEnabled, setDuckEnabled] = useState(cue.ducking?.enabled ?? true);
  const [duckReductionDb, setDuckReductionDb] = useState(cue.ducking?.reductionDb ?? -14);
  const [duckAttackFrames, setDuckAttackFrames] = useState(cue.ducking?.attackFrames ?? 4);
  const [duckReleaseFrames, setDuckReleaseFrames] = useState(cue.ducking?.releaseFrames ?? 14);

  useEffect(() => {
    setGainDb(item.gainDb ?? (cue.kind === "bgm" ? -18 : -6));
    setFadeInFrames(cue.fadeInFrames);
    setFadeOutFrames(cue.fadeOutFrames);
    setLoop(cue.loop);
    setEventFrame(cue.eventFrame ?? item.startFrame);
    setOnsetOffsetFrames(cue.onsetOffsetFrames ?? 0);
    setDuckEnabled(cue.ducking?.enabled ?? true);
    setDuckReductionDb(cue.ducking?.reductionDb ?? -14);
    setDuckAttackFrames(cue.ducking?.attackFrames ?? 4);
    setDuckReleaseFrames(cue.ducking?.releaseFrames ?? 14);
  }, [cue.id, cue.kind, cue.fadeInFrames, cue.fadeOutFrames, cue.loop, cue.eventFrame, cue.onsetOffsetFrames, cue.ducking?.enabled, cue.ducking?.reductionDb, cue.ducking?.attackFrames, cue.ducking?.releaseFrames, item.id, item.gainDb, item.startFrame]);

  const save = () => {
    const payload: Record<string, unknown> = {
      action: "update",
      audioCueId: cue.id,
      gainDb,
      fadeInFrames,
      fadeOutFrames
    };
    if (cue.kind === "bgm") {
      payload.loop = loop;
      payload.ducking = { enabled: duckEnabled, reductionDb: duckReductionDb, attackFrames: duckAttackFrames, releaseFrames: duckReleaseFrames };
    } else {
      payload.eventFrame = eventFrame;
      payload.onsetOffsetFrames = onsetOffsetFrames;
    }
    onSave(payload);
  };

  return <article className={`audio-card audio-cue-card ${cue.status === "stale" ? "stale" : ""}`} data-testid={`audio-cue-${cue.id}`} data-object-id={cue.id}>
    <button className="caption-summary" type="button" onClick={() => { onSeek(item.startFrame); setExpanded((value) => !value); }}>
      <strong>{cue.kind === "bgm" ? "BGM" : "SFX"} · {asset?.name ?? "缺失素材"}</strong>
      <small>F{item.startFrame}–{item.endFrame} · {cue.status === "stale" ? "主线变化，需重新确认" : cue.kind === "bgm" ? (cue.ducking?.enabled ? "Dialogue Duck 已开启" : "Duck 已关闭") : `事件 F${cue.eventFrame} / onset +${cue.onsetOffsetFrames}`}</small>
      <small>{cue.purpose}</small>
      {cue.effectEvent && <small>关联动作：{cue.effectEvent.eventName} · 局部 F{cue.effectEvent.localFrame} · {cue.status === "stale" ? "视觉已改版，请由剪辑任务重新确认动作" : "同版本平移可跟随，听感仍须复核"}</small>}
    </button>
    {expanded && <div className="audio-cue-editor">
      <div className="caption-field-row">
        <label>增益 dB<input aria-label={`声音增益：${cue.id}`} type="number" min="-48" max="12" step="0.5" value={gainDb} onChange={(event) => setGainDb(Number(event.target.value))} /></label>
        <label>淡入帧<input aria-label={`声音淡入：${cue.id}`} type="number" min="0" max="480" value={fadeInFrames} onChange={(event) => setFadeInFrames(Number(event.target.value))} /></label>
      </div>
      <label>淡出帧<input aria-label={`声音淡出：${cue.id}`} type="number" min="0" max="480" value={fadeOutFrames} onChange={(event) => setFadeOutFrames(Number(event.target.value))} /></label>
      {cue.kind === "bgm" ? <>
        <label className="audio-check"><input aria-label={`循环 BGM：${cue.id}`} type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />循环当前源片段</label>
        <label className="audio-check"><input aria-label={`启用 Duck：${cue.id}`} type="checkbox" checked={duckEnabled} onChange={(event) => setDuckEnabled(event.target.checked)} />Dialogue 时压低音乐</label>
        <div className="caption-field-row">
          <label>Duck dB<input aria-label={`Duck 衰减：${cue.id}`} type="number" min="-36" max="-1" step="1" value={duckReductionDb} onChange={(event) => setDuckReductionDb(Number(event.target.value))} /></label>
          <label>攻击帧<input aria-label={`Duck 攻击：${cue.id}`} type="number" min="0" max="240" value={duckAttackFrames} onChange={(event) => setDuckAttackFrames(Number(event.target.value))} /></label>
        </div>
        <label>释放帧<input aria-label={`Duck 释放：${cue.id}`} type="number" min="0" max="240" value={duckReleaseFrames} onChange={(event) => setDuckReleaseFrames(Number(event.target.value))} /></label>
      </> : <div className="caption-field-row">
        <label>事件帧<input aria-label={`SFX 事件帧：${cue.id}`} type="number" min="0" disabled={Boolean(cue.effectEvent)} value={eventFrame} onChange={(event) => setEventFrame(Number(event.target.value))} /></label>
        <label>onset 偏移<input aria-label={`SFX onset 偏移：${cue.id}`} type="number" min="0" value={onsetOffsetFrames} onChange={(event) => setOnsetOffsetFrames(Number(event.target.value))} /></label>
      </div>}
      <div className="button-row">
        <button type="button" disabled={disabled || Boolean(cue.effectEvent && cue.status === "stale")} onClick={save}>{cue.status === "stale" ? "重新确认并启用" : "保存声音"}</button>
        <button type="button" disabled={disabled} onClick={() => onSave({ action: "remove", audioCueId: cue.id })}>移除</button>
      </div>
    </div>}
  </article>;
}

/**
 * 效果类型在 Web 中只负责选择，所属图层仍由 Application 的统一映射决定。
 */
function ScenesPanel({ snapshot, onSelect, onSeek, onAddEffect }: {
  snapshot: ProjectSnapshot;
  onSelect: (selection: Selection) => void;
  onSeek: (frame: number) => void;
  onAddEffect: (scene: Scene, type: EffectCue["type"]) => void;
}) {
  const [effectType, setEffectType] = useState<EffectCue["type"]>("MetricBackdrop");
  return <>
    <PanelTitle title="Story / Scenes" meta={`${snapshot.scenes.length} 个场景`} />
    <MotionLibraryPanel snapshot={snapshot} onSelectAsset={(id) => onSelect({ kind: "asset", id })} />
    <section className="story-card" data-testid="story-document" data-object-id={snapshot.story.id}>
      <strong>{snapshot.story.title}</strong>
      <p>{snapshot.story.summary || "尚未填写叙事摘要；可通过 Codex 的 manage_story 先稳定创作意图。"}</p>
      <small>{snapshot.story.beats.length} 个叙事 Beat · 与当前 Revision 同步</small>
    </section>
    <label className="effect-picker">新增效果
      <select aria-label="效果类型" data-testid="effect-type-select" value={effectType} onChange={(event) => setEffectType(event.target.value as EffectCue["type"])}>
        {EFFECT_TYPES.filter((type) => type !== "ManagedMotion").map((type) => <option key={type} value={type}>{type}</option>)}
      </select>
    </label>
    {snapshot.scenes.length === 0 && <p className="empty-panel">A-roll 已组装后，请由 production-director / scene-planning 通过 MCP 根据 Story Beat 编译 Scene Strip。</p>}
    <div className="scene-list">{snapshot.scenes.map((scene) => <article className="scene-card" key={scene.id} data-testid={`scene-${scene.id}`} data-object-id={scene.id} aria-label={`场景：${scene.title}`} onClick={() => { onSelect({ kind: "scene", id: scene.id }); onSeek(scene.startFrame); }}><span className="scene-type">{scene.type.replace("Scene", "")}</span><strong>{scene.title}</strong><p>{scene.purpose}</p><small>{formatDuration(scene.endFrame - scene.startFrame, snapshot.timeline.fps)}</small><button onClick={(event) => { event.stopPropagation(); onAddEffect(scene, effectType); }}>+ {effectType}</button></article>)}</div>
  </>;
}

function PanelTitle({ title, meta }: { title: string; meta: string }) {
  return <div className="panel-title"><h2>{title}</h2><span>{meta}</span></div>;
}

/**
 * 人物表演仍绑定 Timeline Item，Mask 只是该 Item 的显示能力，避免在 Web 侧创建第二份人物状态。
 */
function ActorsPanel({ snapshot, onRegisterActor }: { snapshot: ProjectSnapshot; onRegisterActor: (timelineItemId: string, maskAssetId?: string) => void }) {
  const [maskByItem, setMaskByItem] = useState<Record<string, string>>({});
  const actorTrack = snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll");
  const actorItems = actorTrack ? snapshot.timeline.items.filter((item) => item.trackId === actorTrack.id && !item.disabled) : [];
  // 领域层只接受图片或派生图作为独立 alpha Mask，界面不展示必然会被拒绝的视频素材。
  const usableMasks = snapshot.assets.filter((asset) => asset.status === "ready" && (asset.kind === "image" || asset.kind === "derived"));
  const performanceByItem = new Map((snapshot.actorPerformances ?? []).map((performance) => [performance.timelineItemId, performance]));

  return <>
    <PanelTitle title="人物 / Actor" meta={`${actorItems.length} 条主画面`} />
    {actorItems.length === 0 && <p className="empty-panel">先在素材库建立 Presenter 主线，再在这里登记人物视频与可选 Mask。</p>}
    <div className="actor-list">
      {actorItems.map((item) => {
        const asset = snapshot.assets.find((candidate) => candidate.id === item.assetId);
        const performance = performanceByItem.get(item.id);
        return <article className="actor-card" key={item.id} data-testid={`actor-item-${item.id}`} data-object-id={item.id}>
          <strong>{asset?.name ?? "缺失素材"}</strong>
          <small>F{item.startFrame}–{item.endFrame}</small>
          {performance ? <span className={`status status-${performance.status}`}>{performance.maskMode === "none" ? "已登记（前景降级）" : "已登记 Mask"}</span> : <span className="status">尚未登记</span>}
          <label className="actor-mask-label">Mask
            <select aria-label={`人物 Mask：${asset?.name ?? item.id}`} value={maskByItem[item.id] ?? ""} onChange={(event) => setMaskByItem((current) => ({ ...current, [item.id]: event.target.value }))}>
              <option value="">不使用 Mask（前景降级）</option>
              {usableMasks.filter((candidate) => candidate.id !== item.assetId).map((mask) => <option key={mask.id} value={mask.id}>{mask.name}</option>)}
            </select>
          </label>
          <button className="wide-button" onClick={() => onRegisterActor(item.id, maskByItem[item.id] || undefined)}>{performance ? "更新人物登记" : "登记为人物主画面"}</button>
        </article>;
      })}
    </div>
    <p className="empty-panel">未提供 Mask 时会明确采用前景降级，并在质量报告中提示复核遮挡；不会伪造抠像结果。</p>
  </>;
}

function Inspector({ snapshot, selectedAsset, selectedScene, selectedItem, selectedCue, currentRevision, onMoveItem, onUpdateCue, onSeek }: {
  snapshot: ProjectSnapshot;
  selection: Selection;
  selectedAsset?: Asset;
  selectedScene?: Scene;
  selectedItem?: TimelineItem;
  selectedCue?: EffectCue;
  currentRevision: number;
  onMoveItem: (item: TimelineItem, frame: number) => void;
  onUpdateCue: (cue: EffectCue, intensity: number) => void;
  onSeek: (frame: number) => void;
}) {
  if (selectedCue) {
    return (
      <>
        <PanelTitle title="Inspector" meta="EffectCue" />
        <InspectorGroup title="Basic">
          <InspectorRow label="效果类型" value={selectedCue.type} />
          <InspectorRow label="图层" value={selectedCue.layer} />
          <InspectorRow label="锚点" value={selectedCue.anchor} />
        </InspectorGroup>
        <InspectorGroup title="Timing">
          <InspectorRow label="进入" value={`F${selectedCue.startFrame}`} />
          <InspectorRow label="稳定" value={`F${selectedCue.holdFrame}`} />
          <InspectorRow label="退出" value={`F${selectedCue.endFrame}`} />
          <button className="wide-button" onClick={() => onSeek(selectedCue.startFrame)}>跳到进入帧</button>
        </InspectorGroup>
        <InspectorGroup title="Animation">
          {selectedCue.type === "ManagedMotion" ? <p>此作品的布局与动效已固定。请让 Codex 修改作品源码或参数并生成新版本，再替换绑定。</p> : <>
          <label className="range-label">强度 <b>{Math.round(selectedCue.intensity * 100)}%</b></label>
          <div className="button-row">
            <button onClick={() => onUpdateCue(selectedCue, Math.max(0, selectedCue.intensity - 0.1))}>−</button>
            <button onClick={() => onUpdateCue(selectedCue, Math.min(1, selectedCue.intensity + 0.1))}>+</button>
          </div>
          </>}
        </InspectorGroup>
      </>
    );
  }
  if (selectedItem) {
    const asset = snapshot.assets.find((candidate) => candidate.id === selectedItem.assetId);
    return (
      <>
        <PanelTitle title="Inspector" meta="Timeline Item" />
        <InspectorGroup title="Basic">
          <InspectorRow label="素材" value={asset?.name ?? "缺失素材"} />
          <InspectorRow label="场景" value={selectedItem.sceneId ? "已绑定" : "全局"} />
        </InspectorGroup>
        <InspectorGroup title="Timing">
          <InspectorRow label="成片范围" value={`F${selectedItem.startFrame}–${selectedItem.endFrame}`} />
          <InspectorRow label="源范围" value={`F${selectedItem.sourceStartFrame}–${selectedItem.sourceEndFrame}`} />
          <div className="button-row">
            <button onClick={() => onMoveItem(selectedItem, Math.max(0, selectedItem.startFrame - 1))}>前移 1 帧</button>
            <button onClick={() => onMoveItem(selectedItem, selectedItem.startFrame + 1)}>后移 1 帧</button>
          </div>
        </InspectorGroup>
        <InspectorGroup title="Dependency"><p>直接移动只作用于当前 Item；需要同步的字幕、Cue 与独立轨应由 ImpactReport 复核。</p></InspectorGroup>
      </>
    );
  }
  if (selectedScene) {
    return <><PanelTitle title="Inspector" meta="Scene" /><InspectorGroup title="Basic"><InspectorRow label="类型" value={selectedScene.type} /><InspectorRow label="叙事目的" value={selectedScene.purpose} /><InspectorRow label="素材数" value={String(selectedScene.assetIds.length)} /></InspectorGroup><InspectorGroup title="Timing"><InspectorRow label="范围" value={`F${selectedScene.startFrame}–${selectedScene.endFrame}`} /></InspectorGroup></>;
  }
  if (selectedAsset) {
    return <>
      <PanelTitle title="Inspector" meta="Asset" />
      <InspectorGroup title="Basic"><InspectorRow label="名称" value={selectedAsset.name} /><InspectorRow label="类型" value={selectedAsset.kind} /><InspectorRow label="状态" value={statusText(selectedAsset.status)} /></InspectorGroup>
      <InspectorGroup title="Media"><InspectorRow label="时长" value={selectedAsset.metadata ? `${(selectedAsset.metadata.durationMs / 1000).toFixed(2)} 秒` : "等待分析"} /><InspectorRow label="规格" value={selectedAsset.metadata?.width ? `${selectedAsset.metadata.width}×${selectedAsset.metadata.height}` : "—"} /><InspectorRow label="音频" value={selectedAsset.metadata?.hasAudio ? "有" : "无 / 未知"} /></InspectorGroup>
      <SourceReviewPanel snapshot={snapshot} asset={selectedAsset} onSeekTimeline={onSeek} />
    </>;
  }
  return <><PanelTitle title="Inspector" meta={`R${currentRevision}`} /><p className="empty-panel">从素材、预览、Scene Strip 或 Timeline 中选择对象，以精确检查其属性。</p></>;
}

function InspectorGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section className="inspector-group"><h3>{title}</h3>{children}</section>; }
function InspectorRow({ label, value }: { label: string; value: string }) { return <div className="inspector-row"><span>{label}</span><strong>{value}</strong></div>; }
