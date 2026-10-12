import { useEffect, useMemo, useRef, useState } from "react";
import { MediaIntelligencePanel } from "./MediaIntelligencePanel";
import type { Asset, ProjectSnapshot } from "@videocut/contracts";
import { API_BASE, api, type SourceReviewMode, type SourceReviewResult, type SourceReviewShot, type SourceReviewUsageItem } from "./api";

type SourceReviewPanelProps = {
  snapshot: ProjectSnapshot;
  asset: Asset;
  onSeekTimeline: (frame: number) => void;
};

const modeLabel: Record<SourceReviewMode, string> = {
  overview: "概览",
  range: "查看范围",
  dense: "密集复核"
};

const sourceFrameLimit = (asset: Asset, fps: number) => {
  const durationMs = asset.metadata?.durationMs;
  return durationMs && durationMs > 0 ? Math.max(1, Math.ceil((durationMs / 1_000) * fps)) : 0;
};

/** derived 可能是截图、生成视频或生成音频，必须依据已分析的媒体事实选择播放器。 */
function isReviewableVideo(asset: Asset): boolean {
  if (asset.kind === "video" || asset.kind === "actor_video") return true;
  return asset.kind === "derived" && Boolean(asset.metadata?.videoCodec) && Boolean(asset.metadata?.durationMs && asset.metadata.durationMs > 0);
}

function isReviewableAudio(asset: Asset): boolean {
  if (asset.kind === "audio" || asset.kind === "speech") return true;
  return asset.kind === "derived" && Boolean(asset.metadata?.hasAudio) && !isReviewableVideo(asset);
}

const sourceTimecode = (frame: number, fps: number) => {
  const seconds = Math.max(0, Math.floor(frame / fps));
  const remainder = Math.max(0, frame % fps);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
};

/** 派生文件只能来自当前项目受管 /media 路径，拒绝把任意字符串作为播放器 URL。 */
function reviewMediaUrl(mediaPath: string | undefined): string | undefined {
  if (!mediaPath || !mediaPath.startsWith("/media/") || mediaPath.includes("..") || /[\\\r\n]/u.test(mediaPath)) return undefined;
  return `${API_BASE.replace(/\/$/u, "")}${mediaPath}`;
}

function asSafeFrame(value: string, fallback: number, upperBound: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(0, Math.min(upperBound, parsed));
}

function reviewRange(mode: SourceReviewMode, startFrame: number, endFrame: number) {
  if (mode === "overview") return { mode };
  return {
    mode,
    sourceStartFrame: startFrame,
    sourceEndFrame: endFrame,
    // 概览关注候选发现，范围与 dense 只请求足够支持当前判断的帧数。
    contactSheetFrames: mode === "dense" ? 24 : 12
  };
}

function ShotRangeButton({ shot, fps, onApply }: { shot: SourceReviewShot; fps: number; onApply: (startFrame: number, endFrame: number) => void }) {
  return <button className="source-review-range-chip" type="button" onClick={() => onApply(shot.sourceStartFrame, shot.sourceEndFrame)}>
    {sourceTimecode(shot.sourceStartFrame, fps)}–{sourceTimecode(shot.sourceEndFrame, fps)}
  </button>;
}

function UsageList({ title, items, snapshot, onSeekTimeline }: { title: string; items: SourceReviewUsageItem[]; snapshot: ProjectSnapshot; onSeekTimeline: (frame: number) => void }) {
  if (!items.length) return null;
  return <div className="source-review-usage">
    <strong>{title} · {items.length}</strong>
    {items.slice(0, 8).map((item) => {
      const linkedTimelineItem = item.timelineItemId ? snapshot.timeline.items.find((candidate) => candidate.id === item.timelineItemId) : undefined;
      const timelineStart = item.startFrame ?? linkedTimelineItem?.startFrame;
      const timelineEnd = item.endFrame ?? linkedTimelineItem?.endFrame;
      const label = item.title || item.purpose || item.trackName || item.type || item.sourceTitle || item.role || item.id;
      return <button key={item.id} type="button" className="source-review-usage-item" disabled={typeof timelineStart !== "number"} onClick={() => typeof timelineStart === "number" && onSeekTimeline(timelineStart)}>
        <span>{label}</span>
        {typeof timelineStart === "number" && <small>成片 F{timelineStart}–F{timelineEnd ?? "?"}</small>}
        {typeof item.sourceStartFrame === "number" && <small>源 F{item.sourceStartFrame}–F{item.sourceEndFrame ?? "?"}</small>}
      </button>
    })}
  </div>;
}

/**
 * 素材审阅只展示原始声画与服务端派生证据；它不在 Web 端产生 Take、事件或叙事判断。
 * 需要形成编辑决定时，仍须由对应主工作流写入现有项目对象并回到成片 Preview 复核。
 */
export function SourceReviewPanel({ snapshot, asset, onSeekTimeline }: SourceReviewPanelProps) {
  const sourceRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const currentAssetIdRef = useRef(asset.id);
  const requestSequenceRef = useRef(0);
  // 选中素材变化时立即让旧请求失效，避免慢响应在新 Inspector 中写入错误证据。
  currentAssetIdRef.current = asset.id;
  const [mode, setMode] = useState<SourceReviewMode>("overview");
  const [startDraft, setStartDraft] = useState("0");
  const [endDraft, setEndDraft] = useState("0");
  const [loopRange, setLoopRange] = useState(true);
  const [result, setResult] = useState<SourceReviewResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const fps = snapshot.timeline.fps;
  const frameLimit = sourceFrameLimit(asset, fps);
  const sourceUrl = useMemo(() => {
    const managedPath = asset.managedPath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
    return `${API_BASE.replace(/\/$/u, "")}/media/${encodeURIComponent(snapshot.project.id)}/${managedPath}`;
  }, [asset.managedPath, snapshot.project.id]);
  // 源范围的结束帧是开区间；起始帧最多只能落在最后一帧之前。
  const startFrame = asSafeFrame(startDraft, 0, Math.max(0, frameLimit - 1));
  const endFrame = asSafeFrame(endDraft, frameLimit, frameLimit);
  const reviewableVideo = isReviewableVideo(asset);
  const reviewableAudio = isReviewableAudio(asset);
  const playable = reviewableVideo || reviewableAudio;

  useEffect(() => {
    requestSequenceRef.current += 1;
    setMode("overview");
    setStartDraft("0");
    setEndDraft(String(frameLimit));
    setLoopRange(true);
    setResult(undefined);
    setError(undefined);
    return () => {
      // 卸载或切换素材时同样失效，避免请求结束后向已离开的面板写状态。
      requestSequenceRef.current += 1;
    };
  }, [asset.id, frameLimit]);

  const applyRange = (nextStart: number, nextEnd: number) => {
    const safeStart = Math.max(0, Math.min(Math.max(0, frameLimit - 1), Math.floor(nextStart)));
    const safeEnd = Math.min(frameLimit, Math.max(safeStart + 1, Math.floor(nextEnd)));
    setStartDraft(String(safeStart));
    setEndDraft(String(safeEnd));
    if (sourceRef.current) sourceRef.current.currentTime = safeStart / fps;
  };

  const requestReview = async (nextMode: SourceReviewMode) => {
    if (!frameLimit && nextMode !== "overview") {
      setError("素材尚无可用时长；请等待媒体分析完成后再审阅。");
      return;
    }
    if (nextMode !== "overview" && endFrame <= startFrame) {
      setError("源范围结束帧必须大于起始帧。");
      return;
    }
    const requestSequence = ++requestSequenceRef.current;
    const requestedAssetId = asset.id;
    const isCurrentRequest = () => requestSequenceRef.current === requestSequence && currentAssetIdRef.current === requestedAssetId;
    setMode(nextMode);
    setLoading(true);
    setError(undefined);
    try {
      const next = await api.inspectAsset(snapshot.project.id, asset.id, reviewRange(nextMode, startFrame, endFrame));
      if (!isCurrentRequest() || next.assetId !== requestedAssetId) return;
      setResult(next);
      if (next.sourceRange) applyRange(next.sourceRange.startFrame, next.sourceRange.endFrame);
    } catch (reason) {
      if (!isCurrentRequest()) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  };

  const handleTimeUpdate = () => {
    if (!loopRange || !sourceRef.current || endFrame <= startFrame) return;
    // 用源帧而非浮点秒判断，避免 29.97/30 fps 素材在循环边界累积漂移。
    if (sourceRef.current.currentTime * fps >= endFrame - 0.15) {
      sourceRef.current.currentTime = startFrame / fps;
      void sourceRef.current.play().catch(() => undefined);
    }
  };

  const proxyUrl = reviewMediaUrl(result?.proxy?.mediaPath);
  const waveformUrl = reviewMediaUrl(result?.audio.waveform?.mediaPath);
  const inspectedShots = result?.shots.overlapping.length ? result.shots.overlapping : result?.shots.current ? [result.shots.current] : [];

  return <section
    className="source-review"
    data-testid="source-review"
    data-object-id={asset.id}
    data-source-review-mode={result?.mode ?? "idle"}
    data-source-start-frame={result?.sourceRange?.startFrame ?? startFrame}
    data-source-end-frame={result?.sourceRange?.endFrame ?? endFrame}
  >
    <div className="source-review-heading">
      <h3>原素材审阅</h3>
      <span>{asset.status === "ready" ? "只读证据" : "等待素材就绪"}</span>
    </div>
    <p className="source-review-help">先看概览，再对会改变选片、切口或表演判断的短范围请求连续声画或密集帧。</p>
    <MediaIntelligencePanel snapshot={snapshot} asset={asset} onLocate={(seconds) => {
      if (sourceRef.current) sourceRef.current.currentTime = seconds;
      setStartDraft(String(Math.floor(seconds * fps)));
    }} />

    <div className="source-review-player">
      {reviewableVideo
        ? <video ref={sourceRef as React.RefObject<HTMLVideoElement>} data-testid="source-review-source-video" src={sourceUrl} controls preload="metadata" onTimeUpdate={handleTimeUpdate} />
        : reviewableAudio
          ? <audio ref={sourceRef as React.RefObject<HTMLAudioElement>} data-testid="source-review-source-audio" src={sourceUrl} controls preload="metadata" onTimeUpdate={handleTimeUpdate} />
          : asset.kind === "image" || asset.kind === "derived"
            ? <img src={sourceUrl} alt={`${asset.name} 原素材`} />
            : <p>该素材类型没有可直接播放的源画面。</p>}
    </div>

    <div className="source-review-range">
      <label>起始源帧<input aria-label="素材审阅起始源帧" value={startDraft} inputMode="numeric" disabled={!frameLimit} onChange={(event) => setStartDraft(event.target.value)} onBlur={() => applyRange(startFrame, Math.max(startFrame + 1, endFrame))} /></label>
      <label>结束源帧<input aria-label="素材审阅结束源帧" value={endDraft} inputMode="numeric" disabled={!frameLimit} onChange={(event) => setEndDraft(event.target.value)} onBlur={() => applyRange(startFrame, endFrame)} /></label>
      <label className="source-review-loop"><input aria-label="循环源范围" type="checkbox" checked={loopRange} disabled={!playable || endFrame <= startFrame} onChange={(event) => setLoopRange(event.target.checked)} />循环范围</label>
    </div>
    <small className="source-review-range-summary">源时间 {sourceTimecode(startFrame, fps)}–{sourceTimecode(endFrame, fps)} · F{startFrame}–F{endFrame} · {frameLimit ? `素材共 ${frameLimit} 帧` : "时长未知"}</small>

    <div className="source-review-actions">
      {(Object.keys(modeLabel) as SourceReviewMode[]).map((candidate) => <button
        key={candidate}
        type="button"
        className={mode === candidate ? "active" : ""}
        disabled={loading || asset.status !== "ready" || (candidate !== "overview" && endFrame <= startFrame)}
        onClick={() => void requestReview(candidate)}
      >{loading && mode === candidate ? "读取中…" : modeLabel[candidate]}</button>)}
    </div>
    {error && <p className="source-review-error" role="alert">{error}</p>}

    {result && <div className="source-review-result">
      <div className="source-review-facts">
        <span>{result.mode === "overview" ? "低密度候选发现" : result.sourceRange ? `源范围 ${sourceTimecode(result.sourceRange.startFrame, fps)}–${sourceTimecode(result.sourceRange.endFrame, fps)}` : "源范围不可用"}</span>
        <span>R{result.revision}</span>
      </div>
      {result.diagnostics.status !== "complete" && <div role="status" className="source-review-boundaries" data-testid="source-review-diagnostics">
        <strong>{result.diagnostics.status === "not_ready" ? "素材正在准备" : result.diagnostics.status === "partial" ? "部分预览可用" : "暂时无法审阅"}</strong>
        <p>{result.diagnostics.requestedFrames > 0 && `已生成 ${result.diagnostics.generatedFrames}/${result.diagnostics.requestedFrames} 张预览。`}
          {result.diagnostics.recovery === "report_platform_failure" ? "平台处理异常，需要报修；已有预览仍可查看。"
            : result.diagnostics.recovery === "select_another_candidate" ? "当前素材暂不采用，可继续查看其他候选。"
            : result.diagnostics.recovery === "wait_for_media_analysis" ? "请等待媒体分析完成。" : "缺失位置尚未核验。"}
        </p>
        {result.diagnostics.continuousReview === "unavailable" && <p>连续预览未生成，不能用截图代替选段观看。</p>}
        {result.diagnostics.issues.length > 0 && <details><summary>查看缺失位置与原因</summary><ul>
          {result.diagnostics.issues.map((issue, index) => <li key={index}>
            {issue.sourceMs !== undefined ? `${(issue.sourceMs / 1000).toFixed(3)} 秒 · ` : ""}
            {issue.sourceRange ? `${sourceTimecode(issue.sourceRange.startFrame, issue.sourceRange.fps)}–${sourceTimecode(issue.sourceRange.endFrame, issue.sourceRange.fps)} · ` : ""}
            {{ metadata: "素材探测", contact_sheet: "预览图", proxy: "连续预览", waveform: "声音波形", audio_analysis: "声音分析" }[issue.stage]}：
            {{ source: "该素材或范围不可用", platform: "平台处理故障", capability: "当前不支持此编码", unknown: "原因尚不确定" }[issue.owner]}
          </li>)}
        </ul></details>}
      </div>}
      {result.evidenceBoundaries.length > 0 && <ul className="source-review-boundaries">{result.evidenceBoundaries.map((boundary) => <li key={boundary}>{boundary}</li>)}</ul>}

      {proxyUrl && <div className="source-review-proxy"><strong>连续范围代理</strong>{result?.proxy?.kind === "audio"
        ? <audio data-testid="source-review-proxy-audio" src={proxyUrl} controls preload="metadata" />
        : <video data-testid="source-review-proxy" src={proxyUrl} controls loop preload="metadata" />}</div>}

      {result.contactSheet.frames.length > 0 && <div className="source-review-contact-sheet" data-testid="source-review-contact-sheet">
        <strong>联系表 · {result.contactSheet.frames.length} 帧</strong>
        <div>{result.contactSheet.frames.map((frame) => {
          const frameUrl = reviewMediaUrl(frame.mediaPath);
          return <button key={`${frame.sourceFrame}-${frame.relativePath}`} type="button" className="source-review-frame" onClick={() => applyRange(frame.sourceFrame, Math.min(frameLimit, frame.sourceFrame + Math.max(fps * 3, 1)))} title={`定位源帧 F${frame.sourceFrame}`}>
            {frameUrl ? <img src={frameUrl} alt={`源时间 ${frame.timecode}`} loading="lazy" /> : <span>帧不可用</span>}
            <small>{frame.timecode}</small>
          </button>;
        })}</div>
      </div>}

      {result.transcript && <div className="source-review-transcript"><strong>转写{result.transcript.source ? ` · ${result.transcript.source}` : ""}</strong><p>{result.transcript.text}</p></div>}

      {result.audio.hasAudio && <div className="source-review-audio">
        <strong>声音概览</strong>
        {waveformUrl && <img src={waveformUrl} alt="音频波形" />}
        {(typeof result.audio.meanVolumeDb === "number" || typeof result.audio.maxVolumeDb === "number") && <small>当前范围平均 {result.audio.meanVolumeDb ?? "—"} dBFS · 峰值 {result.audio.maxVolumeDb ?? "—"} dBFS</small>}
        {result.audio.silenceRanges.length > 0 && <small>静音范围 {result.audio.silenceRanges.slice(0, 4).map((range) => `F${range.startFrame}–F${range.endFrame}`).join("，")}</small>}
        {result.audio.onsetFrames.length > 0 && <small>明显起音 F{result.audio.onsetFrames.slice(0, 8).join("、F")}</small>}
        {result.audio.limitations?.map((limitation) => <small className="source-review-audio-warning" key={limitation}>{limitation}</small>)}
      </div>}

      {(result.shots.previous || inspectedShots.length > 0 || result.shots.next) && <div className="source-review-shots">
        <strong>相邻 Shot</strong>
        <div>{result.shots.previous && <ShotRangeButton shot={result.shots.previous} fps={fps} onApply={applyRange} />}{inspectedShots.map((shot) => <ShotRangeButton key={`current-${shot.id}`} shot={shot} fps={fps} onApply={applyRange} />)}{result.shots.next && <ShotRangeButton shot={result.shots.next} fps={fps} onApply={applyRange} />}</div>
      </div>}

      <div className="source-review-usage-list">
        <UsageList title="Timeline 使用" items={result.usage.timelineItems} snapshot={snapshot} onSeekTimeline={onSeekTimeline} />
        <UsageList title="Scene 使用" items={result.usage.scenes} snapshot={snapshot} onSeekTimeline={onSeekTimeline} />
        <UsageList title="Cutaway 使用" items={result.usage.cutaways} snapshot={snapshot} onSeekTimeline={onSeekTimeline} />
        <UsageList title="EffectCue 使用" items={result.usage.effectCues} snapshot={snapshot} onSeekTimeline={onSeekTimeline} />
        <UsageList title="人物表演使用" items={result.usage.actorPerformances} snapshot={snapshot} onSeekTimeline={onSeekTimeline} />
        <UsageList title="Evidence 使用" items={result.usage.evidenceCaptures} snapshot={snapshot} onSeekTimeline={onSeekTimeline} />
      </div>

      {result.requestableRanges.length > 0 && <div className="source-review-requestable"><strong>可继续复核</strong><div>{result.requestableRanges.slice(0, 8).map((range, index) => <button key={`${range.startFrame}-${range.endFrame}-${index}`} type="button" onClick={() => applyRange(range.startFrame, range.endFrame)}>{sourceTimecode(range.startFrame, fps)}–{sourceTimecode(range.endFrame, fps)}</button>)}</div></div>}
    </div>}
  </section>;
}
