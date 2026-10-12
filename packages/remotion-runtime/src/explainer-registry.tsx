import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, useCurrentFrame } from "remotion";
import type { Asset, ExplainerSceneKind, ProjectSnapshot, Scene } from "@videocut/contracts";
import { resolveCompositionReachability } from "./composition-reachability";
import { CuratedShaderVisual, RestrictedSceneVisual, resolveAdvancedVisualRequest, resolveRestrictedScene } from "./restricted-scene-registry";

/**
 * Explainer 的 Registry 与 Presenter Effect Registry 分开：前者负责一段持续的认知模型，
 * 不能把 ProductFan 一类口播装饰误当成 Comparison 或 EvidenceDocument。
 *
 * 本文件只消费稳定的 Program 投影；具体的 Revision、证据和缓存校验由 Application 完成。
 */
type ExplainerProgramView = {
  id: string;
  sceneId: string;
  kind: ExplainerSceneKind;
  /** 标题属于 Scene；渲染时由宿主 Scene 投影进来，避免两份创作状态漂移。 */
  title?: string;
  primaryTask: string;
  assetIds: string[];
  evidenceCaptureId?: string;
  status: "ready" | "stale";
  states: Array<{
    id: string;
    phase: "entry" | "progressive" | "settled" | "exit";
    startFrame: number;
    endFrame: number;
    label: string;
    detail?: string;
  }>;
  props: Record<string, unknown>;
};

type EvidenceCaptureView = {
  id: string;
  sourceAssetId: string;
  snapshotAssetId?: string;
  sourceTitle: string;
  publisher?: string;
  sourceUrl: string;
  highlights: Array<{ x: number; y: number; width: number; height: number; label?: string }>;
};

type ExplainerSnapshot = ProjectSnapshot & {
  explainerPrograms?: ExplainerProgramView[];
  evidenceCaptures?: EvidenceCaptureView[];
};

const safePath = (path: string) => path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
const mediaUrl = (snapshot: ProjectSnapshot, mediaBaseUrl: string, managedPath: string) => (
  `${mediaBaseUrl.replace(/\/$/, "")}/media/${encodeURIComponent(snapshot.project.id)}/${safePath(managedPath)}`
);
const asText = (value: unknown, fallback = "") => typeof value === "string" && value.trim() ? value.trim() : fallback;
const asTexts = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
  : [];
const asHistoryEvents = (value: unknown): Array<{ date: string; label: string; detail?: string }> => Array.isArray(value)
  ? value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const date = asText(record.date);
    const label = asText(record.label);
    return date && label ? [{ date, label, detail: asText(record.detail) || undefined }] : [];
  })
  : [];
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Explainer Program 的状态不是只写进对象供审计：四个阶段必须直接改变最终合成帧。
 * 这里保留统一且克制的场景级进入、推进、稳定和释放语言；各 Registry 组件仍负责
 * 自己的认知对象，不把通用转场误当成新的解释内容。
 */
function phaseProgress(state: ExplainerProgramView["states"][number], localFrame: number): number {
  const duration = Math.max(1, state.endFrame - state.startFrame);
  return clamp((localFrame - state.startFrame + 1) / duration);
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - clamp(value), 3);
}

function phaseMotionStyle(state: ExplainerProgramView["states"][number], localFrame: number): React.CSSProperties {
  const progress = phaseProgress(state, localFrame);
  const eased = easeOutCubic(progress);
  switch (state.phase) {
    case "entry": {
      // 先建立当前画面的观看边界，再完整露出，不让第一帧直接堆满信息。
      const reveal = Math.round((1 - eased) * 100);
      return {
        clipPath: `inset(0 ${reveal}% 0 0)`,
        opacity: 0.35 + eased * 0.65,
        transform: `translateY(${Math.round((1 - eased) * 18)}px) scale(${(0.985 + eased * 0.015).toFixed(3)})`
      };
    }
    case "progressive": {
      // 推进阶段保持对象在同一空间，只用轻微推进和强调提示正在建立关系。
      return {
        opacity: 1,
        filter: `saturate(${(0.9 + eased * 0.1).toFixed(3)}) brightness(${(0.96 + eased * 0.04).toFixed(3)})`,
        transform: `translateX(${Math.round((1 - eased) * -12)}px) scale(${(0.992 + eased * 0.008).toFixed(3)})`
      };
    }
    case "settled":
      // 稳定阶段不再持续漂移，明确留出阅读和理解时间。
      return { opacity: 1, transform: "none", filter: "none" };
    case "exit": {
      // 退出只释放画面，不突然裁空成黑帧，也不抢走下一 Scene 的第一个注意力事件。
      // 过去将 clipPath 收到 100%，会让最后一帧只剩接近黑色的容器背景，
      // 连续播放时被 blackdetect 识别为闪黑。保留当前认知对象并轻微淡出即可。
      return {
        opacity: 1 - eased * 0.22,
        filter: `brightness(${(1 - eased * 0.08).toFixed(3)})`,
        transform: `translateY(${Math.round(eased * -14)}px) scale(${(1 - eased * 0.012).toFixed(3)})`
      };
    }
  }
}

/**
 * 复杂三维的当前降级路径只播放已经进入项目目录的预渲染结果。不能因为 Asset
 * 恰好是图片或视频就把外链、模型文件路径或普通临时素材称为可用的三维场景。
 */
export const PRE_RENDERED_3D_TAG = "pre_rendered_3d";

function hasManagedProjectPath(managedPath: string | undefined): boolean {
  const normalized = managedPath?.trim().replace(/\\/g, "/") ?? "";
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(normalized)) return false;
  return normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * 这是 Renderer 使用的最终门禁：受管相对路径防止把远程地址或任意本机路径带进
 * Composition；derived 表示项目已派生出预渲染结果，其他图片/视频则必须显式标记。
 */
export function isUsablePreRenderedThreeDAsset(asset: Asset | undefined): asset is Asset {
  if (!asset || asset.status !== "ready" || !hasManagedProjectPath(asset.managedPath)) return false;
  if (asset.kind === "derived") return true;
  return (asset.kind === "image" || asset.kind === "video")
    && asset.tags.some((tag) => tag.trim().toLowerCase() === PRE_RENDERED_3D_TAG);
}

function assetFor(snapshot: ExplainerSnapshot, ids: string[]): Asset | undefined {
  return ids.map((id) => snapshot.assets.find((asset) => asset.id === id)).find((asset): asset is Asset => Boolean(asset));
}

const SceneAsset: React.FC<{ snapshot: ExplainerSnapshot; mediaBaseUrl: string; asset?: Asset; style?: React.CSSProperties }> = ({ snapshot, mediaBaseUrl, asset, style }) => {
  if (!asset) return <div style={{ ...style, display: "grid", placeItems: "center", color: "#d7dced", background: "#1c2437", fontWeight: 700 }}>缺少已绑定的项目素材</div>;
  const src = mediaUrl(snapshot, mediaBaseUrl, asset.managedPath);
  if (asset.kind === "video" || asset.kind === "actor_video") {
    return <OffthreadVideo src={src} volume={0} transparent={Boolean(asset.metadata?.hasAlpha)} style={{ width: "100%", height: "100%", objectFit: "cover", ...style }} />;
  }
  return <img src={src} alt={asset.name} style={{ width: "100%", height: "100%", objectFit: "contain", ...style }} />;
};

/**
 * 复杂三维尚未引入 Three Runtime；这里只播放已入库、已绑定的预渲染图片或视频。
 * 不接受模型文件、远程纹理或运行时 Shader，以保持 Player 和 Render Worker 行为一致。
 */
const PreRenderedThreeDAsset: React.FC<{ snapshot: ExplainerSnapshot; mediaBaseUrl: string; asset: Asset; title: string }> = ({ snapshot, mediaBaseUrl, asset, title }) => (
  <AbsoluteFill aria-label="预渲染三维素材" style={{ background: "#080d18" }}>
    <SceneAsset snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} asset={asset} style={{ objectFit: "cover" }} />
    <div style={{ position: "absolute", left: "7%", right: "7%", bottom: "7%", padding: "16px 20px", borderRadius: 16, background: "#07101bc9", color: "#f5f8ff", fontFamily: "Inter, Noto Sans SC, sans-serif", fontSize: 26, fontWeight: 780 }}>{title}</div>
  </AbsoluteFill>
);

const Shell: React.FC<{ eyebrow: string; title: string; children: React.ReactNode }> = ({ eyebrow, title, children }) => (
  <AbsoluteFill style={{ padding: "7.5%", color: "#f7f9ff", background: "radial-gradient(circle at 18% 14%, #37558a 0%, transparent 28%), linear-gradient(145deg, #0c1222 0%, #17233a 100%)", fontFamily: "Inter, Noto Sans SC, sans-serif" }}>
    {eyebrow && <div style={{ color: "#92b7ff", fontWeight: 800, fontSize: 20, letterSpacing: "0.08em" }}>{eyebrow}</div>}
    <div style={{ marginTop: 12, maxWidth: "90%", fontWeight: 850, fontSize: 45, lineHeight: 1.13 }}>{title}</div>
    {children}
  </AbsoluteFill>
);

const sceneTitle = (program: ExplainerProgramView) => program.title ?? program.primaryTask;

const HeroReveal: React.FC<{ program: ExplainerProgramView; state: ExplainerProgramView["states"][number] }> = ({ program, state }) => {
  const metric = asText(program.props.metric, state.label);
  const qualifier = asText(program.props.qualifier, state.detail);
  return <Shell eyebrow="核心问题" title={sceneTitle(program)}><div style={{ position: "absolute", left: "8%", right: "8%", top: "36%", padding: "8%", borderRadius: 34, background: "linear-gradient(135deg, #7c54ff, #3e83e9)", boxShadow: "0 24px 70px #0008" }}><div style={{ fontSize: 96, fontWeight: 900, letterSpacing: "-0.05em" }}>{metric}</div>{qualifier && <div style={{ marginTop: 18, fontSize: 27, lineHeight: 1.35 }}>{qualifier}</div>}</div></Shell>;
};

const Comparison: React.FC<{ program: ExplainerProgramView; state: ExplainerProgramView["states"][number] }> = ({ program, state }) => {
  const left = asText(program.props.leftLabel, "方案 A");
  const right = asText(program.props.rightLabel, "方案 B");
  const dimension = asText(program.props.dimension, state.label);
  const verdict = asText(program.props.verdict, state.detail);
  return <Shell eyebrow="对比" title={sceneTitle(program)}><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, position: "absolute", left: "8%", right: "8%", top: "34%" }}><div style={{ padding: 28, minHeight: 300, borderRadius: 24, background: "#263954", border: "1px solid #8fbcff55" }}><div style={{ color: "#a8c7ff", fontSize: 20 }}>{dimension}</div><strong style={{ display: "block", marginTop: 26, fontSize: 44 }}>{left}</strong></div><div style={{ padding: 28, minHeight: 300, borderRadius: 24, background: "#473565", border: "1px solid #e0b7ff55" }}><div style={{ color: "#e4c2ff", fontSize: 20 }}>{dimension}</div><strong style={{ display: "block", marginTop: 26, fontSize: 44 }}>{right}</strong></div></div>{verdict && <div style={{ position: "absolute", left: "10%", right: "10%", bottom: "13%", fontSize: 28, fontWeight: 720, textAlign: "center" }}>{verdict}</div>}</Shell>;
};

const ProgressiveClassification: React.FC<{ program: ExplainerProgramView; localFrame: number; state: ExplainerProgramView["states"][number] }> = ({ program, localFrame, state }) => {
  const items = asTexts(program.props.items).slice(0, 5);
  const visible = Math.max(1, Math.min(items.length, Math.floor((localFrame - state.startFrame) / Math.max(1, (state.endFrame - state.startFrame) / Math.max(1, items.length))) + 1));
  return <Shell eyebrow="分类" title={sceneTitle(program)}><div style={{ position: "absolute", left: "8%", right: "8%", top: "34%", display: "grid", gridTemplateColumns: `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))`, gap: 14 }}>{items.map((item, index) => <div key={item} style={{ minHeight: 260, padding: 20, borderRadius: 20, background: index < visible ? "#345887" : "#1c273a", border: `1px solid ${index < visible ? "#b8dcff66" : "#ffffff18"}`, opacity: index < visible ? 1 : 0.34, transform: index < visible ? "translateY(0)" : "translateY(22px)", transition: "all .2s" }}><span style={{ display: "block", color: "#accdff", fontSize: 17 }}>第 {index + 1} 类</span><strong style={{ display: "block", marginTop: 20, fontSize: 30, lineHeight: 1.22 }}>{item}</strong></div>)}</div>{state.detail && <div style={{ position: "absolute", left: "10%", right: "10%", bottom: "12%", fontSize: 25, textAlign: "center" }}>{state.detail}</div>}</Shell>;
};

const RouteAndFlow: React.FC<{ program: ExplainerProgramView; state: ExplainerProgramView["states"][number] }> = ({ program, state }) => {
  const nodes = asTexts(program.props.nodes).slice(0, 5);
  return <Shell eyebrow="机制 / 流程" title={sceneTitle(program)}><div style={{ position: "absolute", left: "8%", right: "8%", top: "40%", display: "flex", alignItems: "center", gap: 12 }}>{nodes.map((node, index) => <React.Fragment key={node}><div style={{ flex: 1, minHeight: 138, padding: 14, display: "grid", placeItems: "center", borderRadius: 18, background: "#304d76", border: "1px solid #b8dcff55", fontSize: 24, fontWeight: 760, textAlign: "center" }}>{node}</div>{index < nodes.length - 1 && <div style={{ color: "#a9cdfc", fontSize: 38 }}>→</div>}</React.Fragment>)}</div>{state.detail && <div style={{ position: "absolute", left: "10%", right: "10%", bottom: "17%", textAlign: "center", fontSize: 27 }}>{state.detail}</div>}</Shell>;
};

/** 人群分组只展示已声明的分类维度，不根据头像或素材外观推断身份、立场或属性。 */
const PeopleGrouping: React.FC<{ program: ExplainerProgramView; state: ExplainerProgramView["states"][number] }> = ({ program, state }) => {
  const groups = asTexts(program.props.groups).slice(0, 6);
  const dimension = asText(program.props.dimension, state.label);
  return <Shell eyebrow="人群分层" title={sceneTitle(program)}><div style={{ position: "absolute", left: "9%", right: "9%", top: "34%", display: "grid", gridTemplateColumns: `repeat(${Math.max(2, Math.min(3, groups.length))}, minmax(0, 1fr))`, gap: 16 }}>{groups.map((group, index) => <div key={group} style={{ minHeight: 180, padding: 20, display: "grid", alignContent: "space-between", borderRadius: 22, background: index % 2 === 0 ? "#29496f" : "#473765", border: "1px solid #c6ddff44" }}><span style={{ color: "#b9d5ff", fontSize: 16, fontWeight: 760 }}>按「{dimension}」分组</span><strong style={{ fontSize: 31, lineHeight: 1.2 }}>{group}</strong></div>)}</div>{state.detail && <div style={{ position: "absolute", left: "10%", right: "10%", bottom: "11%", textAlign: "center", fontSize: 24 }}>{state.detail}</div>}</Shell>;
};

/** LayerStack 把组成关系保持在同一画面中，避免用连续 PPT 卡片打断层级理解。 */
const LayerStack: React.FC<{ program: ExplainerProgramView; state: ExplainerProgramView["states"][number] }> = ({ program, state }) => {
  const layers = asTexts(program.props.layers).slice(0, 6);
  const relationship = asText(program.props.relationship, state.detail);
  return <Shell eyebrow="结构分层" title={sceneTitle(program)}><div style={{ position: "absolute", left: "16%", right: "16%", top: "31%", display: "grid", gap: 10 }}>{layers.map((layer, index) => <div key={layer} style={{ minHeight: 68, padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", borderRadius: 14, background: `rgba(${70 + index * 12}, ${112 + index * 8}, ${170 + index * 6}, 0.92)`, border: "1px solid #e2efff55", boxShadow: "0 9px 22px #0003" }}><span style={{ color: "#d8e7ff", fontSize: 16 }}>第 {layers.length - index} 层</span><strong style={{ fontSize: 28 }}>{layer}</strong></div>)}</div>{relationship && <div style={{ position: "absolute", left: "13%", right: "13%", bottom: "10%", textAlign: "center", color: "#d5e5ff", fontSize: 23 }}>{relationship}</div>}</Shell>;
};

const HistoryTimeline: React.FC<{ program: ExplainerProgramView; state: ExplainerProgramView["states"][number] }> = ({ program, state }) => {
  const events = asHistoryEvents(program.props.events).slice(0, 5);
  const source = asText(program.props.sourceCaption);
  return <Shell eyebrow="时间线" title={sceneTitle(program)}><div style={{ position: "absolute", left: "9%", right: "9%", top: "43%", height: 12, borderRadius: 999, background: "#8ab8ff66" }} /> <div style={{ position: "absolute", left: "9%", right: "9%", top: "29%", display: "grid", gridTemplateColumns: `repeat(${Math.max(2, events.length)}, minmax(0, 1fr))`, gap: 12 }}>{events.map((event, index) => <div key={`${event.date}-${event.label}`} style={{ minHeight: 300, display: "grid", gridTemplateRows: index % 2 === 0 ? "auto 30px 1fr" : "1fr 30px auto", gap: 10, textAlign: "center" }}><div style={{ alignSelf: index % 2 === 0 ? "end" : "start", color: "#eaf2ff" }}><strong style={{ display: "block", fontSize: 28 }}>{event.date}</strong><span style={{ display: "block", marginTop: 8, fontSize: 17, lineHeight: 1.3 }}>{event.label}</span>{event.detail && <small style={{ display: "block", marginTop: 6, color: "#b9cce8" }}>{event.detail}</small>}</div><div style={{ justifySelf: "center", width: 28, height: 28, borderRadius: "50%", background: "#a7cbff", border: "6px solid #1b2d4a", boxSizing: "border-box" }} /></div>)}</div>{(source || state.detail) && <div style={{ position: "absolute", left: "10%", right: "10%", bottom: "8%", textAlign: "center", color: "#bdcdea", fontSize: 16 }}>{source}{source && state.detail ? " · " : ""}{state.detail}</div>}</Shell>;
};

/** QuotePortrait 是明确归属的观点展示；视觉素材只承担识别和情境，不代替 EvidenceDocument 的原文举证。 */
const QuotePortrait: React.FC<{ snapshot: ExplainerSnapshot; mediaBaseUrl: string; program: ExplainerProgramView; state: ExplainerProgramView["states"][number] }> = ({ snapshot, mediaBaseUrl, program, state }) => {
  const portrait = assetFor(snapshot, program.assetIds);
  const quote = asText(program.props.quote, "缺少引语");
  const attribution = asText(program.props.attribution, "归属待确认");
  const source = asText(program.props.sourceCaption);
  return <Shell eyebrow="观点引用" title={sceneTitle(program)}><div style={{ position: "absolute", left: "9%", top: "32%", width: "27%", bottom: "15%", overflow: "hidden", borderRadius: 24, background: "#263650", border: "1px solid #c4dcff55" }}><SceneAsset snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} asset={portrait} style={{ objectFit: "cover" }} /></div><div style={{ position: "absolute", left: "42%", right: "9%", top: "34%", fontSize: 32, lineHeight: 1.35, fontWeight: 740 }}>“{quote}”</div><div style={{ position: "absolute", left: "42%", right: "9%", bottom: "22%", color: "#b9d2f6", fontSize: 21 }}>—— {attribution}</div>{source && <div style={{ position: "absolute", left: "42%", right: "9%", bottom: "14%", color: "#91a8c7", fontSize: 15 }}>{source}</div>}{state.detail && <div style={{ position: "absolute", left: "42%", right: "9%", bottom: "7%", color: "#d8e6fb", fontSize: 16 }}>{state.detail}</div>}</Shell>;
};

/** RealityBroll 直接展示已本地化的真实图片或视频；缺少素材时宁可显示失败占位，也不生成替代现实。 */
const RealityBroll: React.FC<{ snapshot: ExplainerSnapshot; mediaBaseUrl: string; program: ExplainerProgramView; state: ExplainerProgramView["states"][number] }> = ({ snapshot, mediaBaseUrl, program, state }) => {
  const asset = assetFor(snapshot, program.assetIds);
  return <AbsoluteFill style={{ background: "#0d1724" }}><SceneAsset snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} asset={asset} style={{ objectFit: "cover" }} /><div style={{ position: "absolute", left: "7%", right: "7%", bottom: "8%", padding: "18px 22px", borderRadius: 18, background: "#07101acc", color: "#f4f8ff", fontSize: 27, fontWeight: 760 }}>{sceneTitle(program)}{state.detail && <span style={{ display: "block", marginTop: 7, color: "#c8d9ee", fontSize: 17, fontWeight: 500 }}>{state.detail}</span>}</div></AbsoluteFill>;
};

export const DocumentVisual: React.FC<{ snapshot: ExplainerSnapshot; mediaBaseUrl: string; program: ExplainerProgramView; isUi: boolean }> = ({ snapshot, mediaBaseUrl, program, isUi }) => {
  const capture = snapshot.evidenceCaptures?.find((entry) => entry.id === program.evidenceCaptureId);
  // 内部来源元数据不自动上屏；署名等展示文字由作者显式填写。
  const sourceCaption = asText(program.props.sourceCaption);
  const fallback = assetFor(snapshot, program.assetIds);
  const asset = capture ? snapshot.assets.find((candidate) => candidate.id === (capture.snapshotAssetId ?? capture.sourceAssetId)) : fallback;
  const highlights = capture?.highlights ?? (Array.isArray(program.props.focusRects) ? program.props.focusRects as EvidenceCaptureView["highlights"] : []);
  return <Shell eyebrow={asText(program.props.eyebrow)} title={sceneTitle(program)}><div style={{ position: "absolute", left: "10%", right: "10%", top: "30%", bottom: sourceCaption ? "15%" : "7%", borderRadius: 18, overflow: "hidden", background: "#f4f6f9", boxShadow: "0 20px 60px #0009" }}><SceneAsset snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} asset={asset} style={{ objectFit: "contain" }} />{highlights.map((rect, index) => <div key={`${rect.x}-${rect.y}-${index}`} style={{ position: "absolute", left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, border: "4px solid #ffca55", background: "#ffca5533", boxShadow: "0 0 0 999px #00000018" }}>{rect.label && <span style={{ position: "absolute", left: 0, top: -32, padding: "5px 8px", borderRadius: 7, background: "#ffca55", color: "#241c0d", fontSize: 16, fontWeight: 800, whiteSpace: "nowrap" }}>{rect.label}</span>}</div>)}</div>{sourceCaption && <div style={{ position: "absolute", left: "10%", right: "10%", bottom: "7%", fontSize: 16, color: "#c8d7f2" }}>{sourceCaption}</div>}</Shell>;
};

const DataConclusion: React.FC<{ program: ExplainerProgramView; state: ExplainerProgramView["states"][number] }> = ({ program, state }) => {
  const values = Array.isArray(program.props.values) ? program.props.values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).slice(0, 6) : [];
  const labels = asTexts(program.props.labels);
  const max = Math.max(1, ...values);
  const baseline = asText(program.props.baseline, "0");
  const unit = asText(program.props.unit, "数值");
  const source = asText(program.props.sourceCaption);
  return <Shell eyebrow="数据结论" title={sceneTitle(program)}><div style={{ position: "absolute", left: "13%", right: "10%", top: "35%", height: "42%", display: "flex", alignItems: "end", gap: 18, borderLeft: "2px solid #c7dbff", borderBottom: "2px solid #c7dbff", padding: "0 18px" }}>{values.map((value, index) => <div key={`${value}-${index}`} style={{ flex: 1, minWidth: 24, display: "flex", height: "100%", flexDirection: "column", justifyContent: "end", alignItems: "center" }}><span style={{ marginBottom: 8, fontSize: 20, fontWeight: 800 }}>{value}{unit}</span><div style={{ width: "82%", height: `${clamp(value / max) * 100}%`, minHeight: 4, borderRadius: "10px 10px 0 0", background: "linear-gradient(180deg,#93baff,#4c7ed4)" }} /><span style={{ marginTop: 12, fontSize: 16, textAlign: "center" }}>{labels[index] ?? `项 ${index + 1}`}</span></div>)}</div><div style={{ position: "absolute", left: "13%", top: "78%", color: "#c2d0e9", fontSize: 16 }}>基线：{baseline}{source ? ` · ${source}` : ""}</div>{state.detail && <div style={{ position: "absolute", left: "10%", right: "10%", bottom: "9%", textAlign: "center", fontSize: 24 }}>{state.detail}</div>}</Shell>;
};

const ExplainerVisual: React.FC<{ snapshot: ExplainerSnapshot; mediaBaseUrl: string; program: ExplainerProgramView; localFrame: number; state: ExplainerProgramView["states"][number] }> = ({ snapshot, mediaBaseUrl, program, localFrame, state }) => {
  // 受限代码型 Scene 必须先通过本地 Schema，不能把 Program.props 当 JSX、CSS 或 URL 执行。
  // 无效请求直接让 Preview / Render 失败，不能回落后把“自定义代码”伪装成已执行。
  const restrictedScene = resolveRestrictedScene(program.props.restrictedScene);
  const advancedVisual = resolveAdvancedVisualRequest(program.props.advancedVisual);
  if (restrictedScene.status === "ready") {
    if (advancedVisual.status !== "not_requested") {
      throw new Error("[RESTRICTED_SCENE_ADVANCED_VISUAL_CONFLICT] 一个 Explainer Scene 只能选择受限代码组件或一个高级视觉降级路径");
    }
    return <RestrictedSceneVisual definition={restrictedScene.definition} localFrame={localFrame} />;
  }
  if (restrictedScene.status === "rejected") throw new Error(`[${restrictedScene.code}] ${restrictedScene.message}`);
  if (advancedVisual.status === "rejected") throw new Error(`[${advancedVisual.code}] ${advancedVisual.message}`);
  if (advancedVisual.status === "ready") {
    return <CuratedShaderVisual definition={advancedVisual.definition} localFrame={localFrame} title={sceneTitle(program)} />;
  }
  if (advancedVisual.status === "degraded") {
    const asset = program.assetIds.includes(advancedVisual.assetId)
      ? snapshot.assets.find((candidate) => candidate.id === advancedVisual.assetId)
      : undefined;
    if (!isUsablePreRenderedThreeDAsset(asset)) {
      throw new Error("[COMPLEX_3D_ASSET_NOT_BOUND] 复杂三维降级必须绑定已就绪、受管本地的 derived 素材，或带 pre_rendered_3d 标签的图片/视频素材");
    }
    return <PreRenderedThreeDAsset snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} asset={asset} title={sceneTitle(program)} />;
  }
  switch (program.kind) {
    case "HeroReveal": return <HeroReveal program={program} state={state} />;
    case "Comparison": return <Comparison program={program} state={state} />;
    case "ProgressiveClassification": return <ProgressiveClassification program={program} localFrame={localFrame} state={state} />;
    case "RouteAndFlow": return <RouteAndFlow program={program} state={state} />;
    case "EvidenceDocument": return <DocumentVisual snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} program={program} isUi={false} />;
    case "UIWalkthrough": return <DocumentVisual snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} program={program} isUi />;
    case "DataConclusion": return <DataConclusion program={program} state={state} />;
    case "PeopleGrouping": return <PeopleGrouping program={program} state={state} />;
    case "LayerStack": return <LayerStack program={program} state={state} />;
    case "HistoryTimeline": return <HistoryTimeline program={program} state={state} />;
    case "QuotePortrait": return <QuotePortrait snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} program={program} state={state} />;
    case "RealityBroll": return <RealityBroll snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} program={program} state={state} />;
  }
};

/** 只在当前帧位于 Program 所属 Scene 时渲染，避免未绑定的 Explainer 计划偷占画面。 */
export const ExplainerSceneLayer: React.FC<{ snapshot: ProjectSnapshot; mediaBaseUrl: string }> = ({ snapshot: rawSnapshot, mediaBaseUrl }) => {
  const snapshot = rawSnapshot as ExplainerSnapshot;
  const frame = useCurrentFrame();
  const { explainerProgramIds } = resolveCompositionReachability(rawSnapshot);
  return <>
    {(snapshot.explainerPrograms ?? []).filter((program) => explainerProgramIds.has(program.id)).map((program) => {
      const scene = snapshot.scenes.find((candidate) => candidate.id === program.sceneId && candidate.type === "ExplainerScene" && candidate.status === "ready");
      if (!scene || frame < scene.startFrame || frame >= scene.endFrame) return null;
      const localFrame = frame - scene.startFrame;
      const state = program.states.find((candidate) => localFrame >= candidate.startFrame && localFrame < candidate.endFrame) ?? program.states.at(-1);
      if (!state) return null;
      return <Sequence key={program.id} from={scene.startFrame} durationInFrames={scene.endFrame - scene.startFrame} layout="none">
        <AbsoluteFill style={{ overflow: "hidden", background: "#0c1222" }}>
          <AbsoluteFill style={phaseMotionStyle(state, localFrame)}>
            <ExplainerVisual snapshot={snapshot} mediaBaseUrl={mediaBaseUrl} program={program} localFrame={localFrame} state={state} />
          </AbsoluteFill>
        </AbsoluteFill>
      </Sequence>;
    })}
  </>;
};

/** 暴露给测试的最小读回方法；真正的 Scene Cache Key 由 Application 保存到 Program。 */
export function explainerProgramForScene(snapshot: ProjectSnapshot, scene: Scene): ExplainerProgramView | undefined {
  return (snapshot as ExplainerSnapshot).explainerPrograms?.find((program) => program.sceneId === scene.id);
}
