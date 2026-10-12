import { useEffect, useRef, useState } from "react";
import type { Asset, JobRecord, MediaMatch, MediaModality, MediaObservation, ProjectSnapshot } from "@videocut/contracts";
import { API_BASE } from "./api";

type Observations = { observations: MediaObservation[]; requests: Array<{ id: string; title: string; version: string }>; total: number; nextOffset?: number; semanticStatus: string; modalityCoverage: Array<{ analysisId: string; facts: Array<{ modality: MediaModality; factCount: number; unlocatedFactCount: number; unknownRanges?: unknown[] }> }>; coverage: Array<{ id: string; status: string; totalWindows: number; completedWindows: number; totalShots: number; missingRanges: unknown[] }> };
const label: Record<MediaModality, string> = { visual: "画面", audio: "实际声音", speech: "说话内容", text: "可见文字" };
const statusLabel = { usable: "符合当前条件", conditional: "按条件使用", insufficient: "需要补查", rejected: "不符合" };

/** 只操作公共接口；分析与检索不在浏览器内重写。 */
export function MediaIntelligencePanel({ snapshot, asset, onLocate, defaultRequestId = "" }: { snapshot: ProjectSnapshot; asset: Asset; onLocate: (seconds: number) => void; defaultRequestId?: string }) {
  const [data, setData] = useState<Observations>();
  const [query, setQuery] = useState("");
  const [modality, setModality] = useState<MediaModality>(asset.kind === "audio" ? "audio" : "visual");
  const [matches, setMatches] = useState<MediaMatch[]>([]);
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState(String((asset.metadata?.durationMs ?? 0) / 1000));
  const [excludeSpeech, setExcludeSpeech] = useState(false);
  const [excludeMusic, setExcludeMusic] = useState(false), [allowMute, setAllowMute] = useState(false), [allAssets, setAllAssets] = useState(true);
  const [minSeconds, setMinSeconds] = useState(0), [page, setPage] = useState(1), [context, setContext] = useState("");
  const [region, setRegion] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const [offset, setOffset] = useState(0), [matchOffset, setMatchOffset] = useState<number>();
  const [searchMode, setSearchMode] = useState<"hybrid" | "lexical">("hybrid");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MediaObservation>();
  const [correction, setCorrection] = useState("");
  const [reason, setReason] = useState("");
  const epoch = useRef(0);
  const controller = useRef(new AbortController());
  const base = `${API_BASE}/api/projects/${encodeURIComponent(snapshot.project.id)}`;
  async function request<T>(url: string, body?: unknown): Promise<T> {
    const stamp = epoch.current;
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), signal: controller.current.signal });
    const result = await response.json();
    if (stamp !== epoch.current) throw new DOMException("素材已切换", "AbortError");
    if (!response.ok) throw new Error(result.message ?? result.error ?? `请求失败：${response.status}`);
    return result as T;
  }
  async function refresh(offset = 0) {
    const current = epoch.current;
    const result = await request<Observations>(`${base}/media-observations/read`, { assetId: asset.id, offset, limit: 20 });
    if (current === epoch.current) setData(result);
  }
  useEffect(() => {
    epoch.current++;
    controller.current = new AbortController();
    setData(undefined); setMatches([]); setError(""); setBusy(""); setEditing(undefined);
    setStart("0"); setEnd(String((asset.metadata?.durationMs ?? 0) / 1000));
    setModality(asset.kind === "audio" || asset.kind === "speech" ? "audio" : "visual");
    setOffset(0); setPage(1); setMatchOffset(undefined);
    void refresh().catch((error: Error) => { if (error.name !== "AbortError") setError(error.message); });
    return () => { epoch.current++; controller.current.abort(); };
  }, [snapshot.project.id, asset.id]);
  async function action(title: string, work: () => Promise<void>) {
    const current = epoch.current; setBusy(title); setError("");
    try { await work(); } catch (error) { if (current === epoch.current && !(error instanceof Error && error.name === "AbortError")) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (current === epoch.current) setBusy(""); }
  }
  async function finish(job: JobRecord): Promise<JobRecord> {
    const current = epoch.current;
    let latest = job;
    while (latest.status === "queued" || latest.status === "running") {
      if (current !== epoch.current) throw new DOMException("素材已切换", "AbortError");
      setBusy(`${latest.status === "queued" ? "排队中" : "分析中"}${latest.result?.totalWindows ? ` · ${latest.result.completedWindows ?? 0}/${latest.result.totalWindows}` : ""}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (current !== epoch.current) throw new DOMException("素材已切换", "AbortError");
      latest = await request<JobRecord>(`${API_BASE}/api/jobs/${encodeURIComponent(job.id)}`);
    }
    if (latest.status !== "succeeded") throw new Error(latest.error ?? `任务状态：${latest.status}`);
    return latest;
  }
  const range = asset.kind === "image" || asset.kind === "document" ? undefined : { startMs: Number(start) * 1000, endMs: Number(end) * 1000 };
  const sourceRegion = range ? undefined : { ...region, ...(asset.kind === "document" ? { page } : {}) };
  async function search(mode: "hybrid" | "lexical", offset = 0) {
    setSearchMode(mode);
    const result = await request<{ matches?: MediaMatch[]; nextOffset?: number } & Partial<JobRecord>>(`${base}/media-fragments/search`, { query: { query, modality, assetIds: allAssets ? undefined : [asset.id], excludeSpeech, excludeMusic, allowMute, minDurationMs: minSeconds > 0 ? minSeconds * 1000 : undefined, offset }, mode });
    const found = result.id ? (await finish(result as JobRecord)).result : result;
    setMatches((found?.matches ?? []) as MediaMatch[]); setMatchOffset(found?.nextOffset as number | undefined);
  }
  return <details className="media-intelligence" data-testid="media-intelligence-panel">
    <summary>素材理解与片段检索</summary>
    <p>按画面、原声、说话内容分别查找片段。未覆盖的范围会保留为待分析。</p>
    {range && <div className="inline-fields">
      <label>源开始（秒）<input type="number" min="0" step="0.1" value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>源结束（秒）<input type="number" min="0" step="0.1" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
    </div>}
    {!range && <fieldset><legend>图片或 PDF 页面范围（相对画面 0–1）</legend>{asset.kind === "document" && <label>页码<input type="number" min="1" value={page} onChange={(e) => setPage(Number(e.target.value))} /></label>}{(["x", "y", "width", "height"] as const).map((key) => <label key={key}>{({ x: "左", y: "上", width: "宽", height: "高" })[key]}<input type="number" min="0" max="1" step="0.01" value={region[key]} onChange={(e) => setRegion({ ...region, [key]: Number(e.target.value) })} /></label>)}</fieldset>}
    <label>必要上下文<textarea value={context} onChange={(e) => setContext(e.target.value)} placeholder="说明前后事件或本次用途；上下文不作为直接观察" /></label>
    <div className="button-row">{(["discovery", "index", "review"] as const).map((depth, index) => <button key={depth} disabled={Boolean(busy) || asset.status !== "ready"} onClick={() => void action("提交分析", async () => {
      const job = await request<JobRecord>(`${base}/media-analysis`, { assetId: asset.id, range, region: sourceRegion, context, depth, modalities: asset.kind === "audio" || asset.kind === "speech" ? ["sfx", "bgm"].includes(asset.role ?? "") ? ["audio"] : ["audio", "speech"] : range ? ["visual", "audio", "speech", "text"] : ["visual", "text"] });
      await finish(job);
      await refresh(offset);
    })}>{["发现候选范围", "建立片段索引", "复核所选范围"][index]}</button>)}</div>
    {data?.coverage.map((coverage) => <p key={coverage.id}>已处理 {coverage.completedWindows}/{coverage.totalWindows} 个窗口 · {coverage.totalShots} 个技术镜头 · {coverage.missingRanges.length} 段尚未处理</p>)}
    {data?.modalityCoverage?.map((coverage) => <p key={coverage.analysisId}>{coverage.facts.map((fact) => `${label[fact.modality]}：${fact.factCount} 条事实，${fact.unlocatedFactCount} 条未定位${fact.unknownRanges ? `，${fact.unknownRanges.length} 段无定位事实` : ""}`).join("；")}。事实范围仍保留模型/采样精度，不能表示每一瞬间都已看清。</p>)}
    {!data?.coverage.length && <p>这份素材尚无语义分析记录。</p>}
    <label>要找什么<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：接口特写 / 短促机械落定" /></label>
    <label>查找依据<select value={modality} onChange={(event) => setModality(event.target.value as MediaModality)}>{Object.entries(label).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
    <label><input type="checkbox" checked={excludeSpeech} onChange={(event) => setExcludeSpeech(event.target.checked)} />要求原声无人声</label>
    <label><input type="checkbox" checked={excludeMusic} onChange={(e) => setExcludeMusic(e.target.checked)} />排除背景音乐</label><label><input type="checkbox" checked={allowMute} onChange={(e) => setAllowMute(e.target.checked)} />画面可静音使用</label><label><input type="checkbox" checked={allAssets} onChange={(e) => setAllAssets(e.target.checked)} />检索全项目已分析素材</label><label>至少连续可用（秒）<input type="number" min="0" step="0.1" value={minSeconds} onChange={(e) => setMinSeconds(Number(e.target.value))} /></label>
    <div className="button-row">{(["hybrid", "lexical"] as const).map((mode) => <button key={mode} disabled={Boolean(busy) || !query.trim()} onClick={() => void action("查找片段", async () => {
      await search(mode);
    })}>{mode === "hybrid" ? "语义与关键词检索" : "仅查已有关键词"}</button>)}</div>
    {busy && <p role="status">{busy}。离开面板不会取消已提交的外部任务。</p>}
    {error && <p role="alert">{error}</p>}
    {matches.map((match, index) => <article key={`${match.observationId}:${index}`}>
      <strong>{statusLabel[match.status]}</strong><p>{match.text}</p>
      <p>{[...match.reasons, ...match.conditions].join("；")}</p>
      <small>{snapshot.assets.find((a) => a.id === match.source.target.assetId)?.name ?? "在线候选"} · {match.source.identity === "preview" ? "候选试听版本" : "原文件"}</small>
      {match.range && match.source.target.assetId === asset.id && <button onClick={() => { onLocate(match.range!.startMs / 1000); setStart(String(match.range!.startMs / 1000)); setEnd(String(match.range!.endMs / 1000)); }}>定位 {(match.range.startMs / 1000).toFixed(2)}–{(match.range.endMs / 1000).toFixed(2)} 秒</button>}
      {match.source.target.assetId !== asset.id && match.source.target.assetId && <p>在素材列表选择该原文件，定位所需范围。</p>}
    </article>)}
    {matchOffset !== undefined && <button disabled={Boolean(busy)} onClick={() => void action("检索下一页", () => search(searchMode, matchOffset))}>下一页匹配</button>}
    {data?.observations.map((observation) => <article key={observation.id}>
      <strong>{observation.range ? `${(observation.range.startMs / 1000).toFixed(2)}–${(observation.range.endMs / 1000).toFixed(2)} 秒` : "图片/页面"}</strong>
      {observation.facts.map((fact, index) => <p key={index}>{label[fact.modality]}：{fact.text}</p>)}
      {observation.unknowns.length > 0 && <p>待确认：{observation.unknowns.join("；")}</p>}
      {observation.audioMeasurements && <><svg viewBox="0 0 600 70" role="img" aria-label="技术波形与候选起音，仍需实际复听"><polyline fill="none" stroke="currentColor" points={observation.audioMeasurements.peaks.map((peak, index, values) => `${index * 600 / Math.max(1, values.length - 1)},${35 - peak * 32}`).join(" ")} /></svg><p>候选起音：{observation.audioMeasurements.firstAudibleSample === null ? "未检测到" : (observation.audioMeasurements.firstAudibleSample / observation.audioMeasurements.sampleRate).toFixed(3) + " 秒（分析窗口内部）"}；技术检测不代表动作落点已确认。</p></>}
      <details><summary>原始分析记录</summary><pre style={{ whiteSpace: "pre-wrap" }}>{observation.rawText}</pre></details>
      <button disabled={Boolean(busy)} onClick={() => { setEditing(observation); setCorrection(observation.facts.map((fact) => fact.text).join("\n")); setReason(""); }}>按实际复核纠正</button>
    </article>)}
    {offset > 0 && <button onClick={() => void action("读取上一页", async () => { const next = Math.max(0, offset - 20); await refresh(next); setOffset(next); })}>上一页观察</button>}
    {data?.nextOffset !== undefined && <button onClick={() => void action("读取下一页", async () => { await refresh(data.nextOffset); setOffset(data.nextOffset!); })}>下一页观察</button>}
    {editing && <fieldset><legend>纠正实际观察（每行对应原有一条事实）</legend>
      <textarea value={correction} onChange={(event) => setCorrection(event.target.value)} />
      {editing.range && editing.facts.map((fact, index) => <fieldset key={`range-${index}`}><legend>第 {index + 1} 条事实的实际确认范围（源秒；留空保持未定位）</legend>{(["startMs", "endMs"] as const).map((key) => <label key={key}>{key === "startMs" ? "确认开始" : "确认结束"}<input type="number" min="0" step="0.001" value={fact.range ? fact.range[key] / 1000 : ""} onChange={(e) => setEditing({ ...editing, facts: editing.facts.map((entry, i) => i === index ? { ...entry, range: e.target.value === "" ? undefined : { ...(entry.range ?? { startMs: 0, endMs: 0 }), [key]: Number(e.target.value) * 1000 } } : entry) })} /></label>)}</fieldset>)}
      {editing.facts.map((fact, index) => fact.modality === "audio" && <fieldset key={index}><legend>第 {index + 1} 条实际声音条件</legend>{(["speechPresence", "musicPresence"] as const).map((key) => <label key={key}>{key === "speechPresence" ? "人声" : "音乐"}<select value={fact[key] ?? "unknown"} onChange={(e) => setEditing({ ...editing, facts: editing.facts.map((f, i) => i === index ? { ...f, [key]: e.target.value } : f) })}><option value="unknown">不能判断</option><option value="present">实际存在</option><option value="absent">已复核不存在</option></select></label>)}</fieldset>)}
      <label>复核依据<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明实际看见或听到的内容及范围" /></label>
      <button disabled={Boolean(busy) || reason.trim().length < 8} onClick={() => void action("保存纠正", async () => {
        const texts = correction.split("\n");
        if (texts.length !== editing.facts.length || texts.some((text) => !text.trim())) throw new Error("请逐行修正原有事实，保留对应关系");
        const state = await request<{ revision: { number: number } }>(`${base}`);
        await request(`${base}/media-observations/correct`, { observationId: editing.id, facts: editing.facts.map((fact, index) => ({ ...fact, text: texts[index], keywords: fact.text === texts[index] ? fact.keywords : [] })), unknowns: editing.unknowns, reason, author: "工作台实际复核", baseRevision: state.revision.number });
        setEditing(undefined);
        await refresh(offset);
      })}>确认纠正并检查影响</button><button onClick={() => setEditing(undefined)}>返回</button>
    </fieldset>}
  </details>;
}

