import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { EffectCue, ProjectSnapshot } from "@videocut/contracts";
import { TRACK_LABEL_WIDTH, clampFrame, edgeScrollSpeed, frameAtClientX, rulerStep, scrollAfterZoom } from "./timeline-geometry";

type Selection = { kind: "asset" | "scene" | "item" | "cue"; id: string } | undefined;
type Props = {
  snapshot: ProjectSnapshot;
  selection: Selection;
  playhead: number;
  onSelect: (selection: Selection, frame: number) => void;
  onSeek: (frame: number) => void;
  onScrubStart: () => void;
};
type Drag = { pointerId: number; clientX: number; offsetX: number; lastFrame: number; lastTime: number };

const effectTrackNameByLayer: Record<EffectCue["layer"], string> = {
  rear: "Rear FX", actor: "Actor FX", front: "Front FX", fullscreen: "Cutaway / Fullscreen"
};
const timecode = (frame: number, fps: number) => {
  const seconds = Math.floor(frame / fps);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}:${String(frame % fps).padStart(2, "0")}`;
};

export function TimelineEditor(props: Props) {
  const { snapshot, selection, playhead, onSelect, onSeek, onScrubStart } = props;
  const { timeline } = snapshot;
  const duration = Math.max(1, timeline.durationInFrames);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const animation = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [visibleWidth, setVisibleWidth] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState(0);
  const maxZoom = Math.max(0, Math.log2(duration * 8 / visibleWidth));
  const effectiveZoom = Math.min(zoom, maxZoom);
  const canvasWidth = visibleWidth * 2 ** effectiveZoom;
  const latest = useRef({ onSeek, duration, canvasWidth });
  latest.current = { onSeek, duration, canvasWidth };
  const previousWidth = useRef(canvasWidth);

  useLayoutEffect(() => {
    const element = viewport.current!;
    const measure = () => setVisibleWidth(Math.max(1, element.clientWidth - TRACK_LABEL_WIDTH));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current!;
    if (previousWidth.current !== canvasWidth) {
      element.scrollLeft = scrollAfterZoom(previousWidth.current, canvasWidth, visibleWidth, element.scrollLeft, playhead, duration);
      previousWidth.current = canvasWidth;
      setScrollLeft(element.scrollLeft);
    }
  }, [canvasWidth, visibleWidth, playhead, duration]);

  const stopScrubbing = () => {
    const current = drag.current;
    drag.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    if (current && viewport.current?.hasPointerCapture(current.pointerId)) viewport.current.releasePointerCapture(current.pointerId);
    setScrubbing(false);
  };

  useEffect(() => {
    const blur = () => stopScrubbing();
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("blur", blur);
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      drag.current = null;
    };
  }, []);

  const seekDrag = (current: Drag) => {
    const element = viewport.current!;
    const { canvasWidth: width, duration: frames, onSeek: seek } = latest.current;
    const frame = frameAtClientX(current.clientX - current.offsetX, element.getBoundingClientRect().left, element.scrollLeft, width, frames);
    if (frame !== current.lastFrame) {
      current.lastFrame = frame;
      seek(frame);
    }
  };

  // 指针捕获使跨轨道、拖出窗口后松手仍能正常结束；每次绘制最多定位一次。
  const animateDrag = (time: number) => {
    const current = drag.current;
    const element = viewport.current;
    if (!current || !element) return;
    const rect = element.getBoundingClientRect();
    const elapsed = Math.min(50, time - current.lastTime) / 1000;
    current.lastTime = time;
    element.scrollLeft += edgeScrollSpeed(current.clientX, rect.left + TRACK_LABEL_WIDTH, rect.left + element.clientWidth) * elapsed;
    seekDrag(current);
    animation.current = requestAnimationFrame(animateDrag);
  };

  const beginScrubbing = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    suppressClick.current = false;
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>(".playhead");
    // 片段、场景与标记仍可选中；红线的透明抓取区优先处理拖动。
    if (!target.closest("[data-timeline-canvas]") || (!handle && target.closest("button"))) return;
    event.preventDefault();
    const element = viewport.current!;
    const rect = element.getBoundingClientRect();
    const headX = rect.left + TRACK_LABEL_WIDTH - element.scrollLeft + playhead / duration * canvasWidth;
    const current: Drag = { pointerId: event.pointerId, clientX: event.clientX, offsetX: handle ? event.clientX - headX : 0, lastFrame: -1, lastTime: performance.now() };
    drag.current = current;
    suppressClick.current = true;
    element.setPointerCapture(event.pointerId);
    onScrubStart();
    setScrubbing(true);
    seekDrag(current);
    animation.current = requestAnimationFrame(animateDrag);
  };

  const finishScrubbing = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (event.type === "pointerup") {
      current.clientX = event.clientX;
      seekDrag(current);
    }
    stopScrubbing();
  };

  const step = rulerStep(duration, timeline.fps, canvasWidth);
  const firstTick = Math.max(0, Math.floor(scrollLeft / canvasWidth * duration / step) * step);
  const lastTick = Math.min(duration - 1, Math.ceil((scrollLeft + visibleWidth) / canvasWidth * duration / step) * step);
  const ticks: number[] = [];
  for (let frame = firstTick; frame <= lastTick; frame += step) ticks.push(frame);
  const spanStyle = (start: number, end: number): CSSProperties => ({ left: `${start / duration * 100}%`, width: `${(end - start) / duration * 100}%` });
  const headStyle: CSSProperties = { left: `${clampFrame(playhead, duration) / duration * 100}%` };
  const head = (ruler = false) => <div className={`playhead${ruler ? " playhead-handle" : ""}`} style={headStyle} title="按住拖动播放指针" aria-hidden="true" />;
  const assetsById = useMemo(() => new Map(snapshot.assets.map((asset) => [asset.id, asset])), [snapshot.assets]);
  const selected = (kind: NonNullable<Selection>["kind"], id: string) => selection?.kind === kind && selection.id === id ? " selected" : "";

  return <section className={`timeline${scrubbing ? " is-scrubbing" : ""}`} aria-label="多轨时间线" data-testid="timeline">
    <div className="timeline-tools">
      <span className="timeline-position">{timecode(playhead, timeline.fps)} · F{playhead}</span>
      <span className="timeline-help">拖动红线或轨道空白定位</span>
      <button type="button" aria-label="缩小时间线" disabled={scrubbing || effectiveZoom <= 0} onClick={() => setZoom(Math.max(0, effectiveZoom - 1))}>−</button>
      <input type="range" aria-label="时间线缩放" min={0} max={maxZoom} step="any" value={effectiveZoom} disabled={scrubbing || maxZoom === 0} onChange={(event) => setZoom(Number(event.target.value))} />
      <button type="button" aria-label="放大时间线" disabled={scrubbing || effectiveZoom >= maxZoom} onClick={() => setZoom(Math.min(maxZoom, effectiveZoom + 1))}>＋</button>
      <span className="timeline-zoom-value">{(2 ** effectiveZoom).toFixed(1)}×</span>
      <button type="button" disabled={scrubbing} onClick={() => setZoom(0)}>适合窗口</button>
    </div>
    <div className="timeline-scroll" ref={viewport} data-testid="timeline-scroll" tabIndex={0} aria-label="时间线浏览区域"
      onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
      onPointerDownCapture={beginScrubbing}
      onPointerMove={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current.clientX = event.clientX; }}
      onPointerUp={finishScrubbing} onPointerCancel={finishScrubbing}
      onLostPointerCapture={() => { if (drag.current) stopScrubbing(); }}
      onClickCapture={(event) => {
        if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) { event.preventDefault(); stopScrubbing(); }
        if (event.target !== event.currentTarget) return;
        const frame = event.key === "ArrowLeft" ? playhead - 1 : event.key === "ArrowRight" ? playhead + 1 : event.key === "Home" ? 0 : event.key === "End" ? duration - 1 : undefined;
        if (frame !== undefined) { event.preventDefault(); onSeek(clampFrame(frame, duration)); }
      }}>
      <div className="timeline-content" style={{ width: canvasWidth + TRACK_LABEL_WIDTH, "--timeline-label-width": `${TRACK_LABEL_WIDTH}px`, "--timeline-grid-step": `${step / duration * canvasWidth}px` } as CSSProperties}>
        <div className="timeline-heading">
          <section className="scene-strip" aria-label="Scene Strip" data-testid="scene-strip">
            <div className="strip-label">Scenes</div>
            <div className="strip-canvas" data-timeline-canvas>
              {snapshot.scenes.map((scene) => <button type="button" key={scene.id} className={`scene-chip ${scene.startFrame <= playhead && playhead < scene.endFrame ? "current" : ""}`} data-testid={`scene-strip-${scene.id}`} data-object-id={scene.id} aria-label={`定位场景：${scene.title}`} style={spanStyle(scene.startFrame, scene.endFrame)} onClick={() => onSelect({ kind: "scene", id: scene.id }, scene.startFrame)}>{scene.title}</button>)}
              {head()}
            </div>
          </section>
          <div className="timeline-header">
            <span className="strip-label">轨道</span>
            <div className="ruler" data-timeline-canvas data-testid="timeline-ruler">
              {ticks.map((frame) => <span key={frame} style={{ left: `${frame / duration * 100}%` }}>{timecode(frame, timeline.fps)}</span>)}
              {snapshot.markers.map((marker) => <button key={marker.id} type="button" className={`timeline-marker ${marker.level}`} data-testid={`marker-${marker.id}`} data-object-id={marker.id} aria-label={`标记：${marker.label}，F${marker.frame}`} style={{ left: `${marker.frame / duration * 100}%` }} onClick={() => onSeek(marker.frame)} />)}
              {head(true)}
            </div>
          </div>
        </div>
        <div className="timeline-body">
          {timeline.tracks.map((track) => <div className="track-row" key={track.id} data-testid={`track-${track.id}`} data-object-id={track.id}>
            <div className="track-name"><strong>{track.name}</strong><small>{track.kind}</small></div>
            <div className="track-canvas" data-timeline-canvas aria-label={`轨道：${track.name}`}>
              {timeline.items.filter((item) => item.trackId === track.id).map((item) => <button type="button" key={item.id} className={`timeline-item${selected("item", item.id)}`} data-testid={`timeline-item-${item.id}`} data-object-id={item.id} data-start-frame={item.startFrame} data-end-frame={item.endFrame} aria-label={`时间线片段：${assetsById.get(item.assetId)?.name ?? "缺失素材"}，F${item.startFrame} 到 F${item.endFrame}`} style={spanStyle(item.startFrame, item.endFrame)} onClick={() => onSelect({ kind: "item", id: item.id }, item.startFrame)}><span>{assetsById.get(item.assetId)?.name ?? "缺失素材"}</span><small>F{item.startFrame}</small></button>)}
              {track.kind === "caption" && timeline.captions.map((caption) => <button type="button" className="caption-block" key={caption.id} data-testid={`timeline-caption-${caption.id}`} data-object-id={caption.id} aria-label={`字幕：${caption.text}`} style={spanStyle(caption.startFrame, caption.endFrame)} onClick={() => onSeek(caption.startFrame)}>{caption.text}</button>)}
              {snapshot.effectCues.filter((cue) => effectTrackNameByLayer[cue.layer] === track.name).map((cue) => <button type="button" key={cue.id} className={`timeline-cue${selected("cue", cue.id)}`} data-testid={`timeline-cue-${cue.id}`} data-object-id={cue.id} data-start-frame={cue.startFrame} data-end-frame={cue.endFrame} aria-label={`效果：${cue.type}，F${cue.startFrame} 到 F${cue.endFrame}`} style={spanStyle(cue.startFrame, cue.endFrame)} onClick={() => onSelect({ kind: "cue", id: cue.id }, cue.startFrame)}><span>{cue.type}</span><small>F{cue.startFrame}</small></button>)}
              {head()}
            </div>
          </div>)}
        </div>
      </div>
    </div>
  </section>;
}
