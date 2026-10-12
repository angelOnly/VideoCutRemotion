import { useEffect, useRef, useState } from "react";
import type { AssetCandidate, AssetRequest, AudioRole, JobRecord, ProjectSnapshot, SoundPlan } from "@videocut/contracts";
import { API_BASE, type ProjectState } from "./api";
import { useMediaTask } from "./useMediaTask";
import { MediaIntelligencePanel } from "./MediaIntelligencePanel";

type Source = { id: string; name: string; enabled: boolean; original: boolean; limits: string; categories: readonly string[]; };
type Library = { revision: number; plans: SoundPlan[]; requests: AssetRequest[]; sources: Source[]; sessions: Array<{ candidates: AssetCandidate[]; requestVersion: string }> };
type Comparison = { name: string; relativePath: string; audio?: unknown };

/** 选音、分析、采用与正式混合均使用公共 HTTP；页面不替代领域规则。 */
export function SoundLibraryPanel({ snapshot }: { snapshot: ProjectSnapshot }) {
  const task = useMediaTask(snapshot.project.id);
  const originalPlayer = useRef<HTMLAudioElement>(null);
  const [current, setCurrent] = useState(snapshot), [library, setLibrary] = useState<Library>();
  const [requestId, setRequestId] = useState(""), [provider, setProvider] = useState("mixkit"), [query, setQuery] = useState("");
  const [planId, setPlanId] = useState(""), [intentId, setIntentId] = useState(""), [brief, setBrief] = useState("");
  const [narration, setNarration] = useState("旁白清楚讲完本段因果，动作落定处留出重音空间"), [music, setMusic] = useState("按段落组织，关键讲解退让，尾音自然释放");
  const [dominantRole, setDominantRole] = useState<AudioRole>("narration");
  const [from, setFrom] = useState(0), [to, setTo] = useState(10), [role, setRole] = useState<"sfx" | "bgm">("sfx");
  const [functionName, setFunctionName] = useState<SoundPlan["intents"][number]["function"]>("settle");
  const [selected, setSelected] = useState<string[]>([]), [originalId, setOriginalId] = useState("");
  const [sourceStart, setSourceStart] = useState(0), [sourceEnd, setSourceEnd] = useState(1), [eventSeconds, setEventSeconds] = useState(1), [onset, setOnset] = useState(0), [gain, setGain] = useState(-12);
  const [eventKey, setEventKey] = useState(""), [compareIds, setCompareIds] = useState<string[]>([]), [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [eventPhase, setEventPhase] = useState<"start" | "end" | "sustain">("start");
  const [onsetConfirmed, setOnsetConfirmed] = useState(false), [note, setNote] = useState(""), [preview, setPreview] = useState<JobRecord>();
  const [ranking, setRanking] = useState("");
  const base = `${API_BASE}/api/projects/${encodeURIComponent(snapshot.project.id)}`;
  const mediaUrl = (path: string) => `${API_BASE}/media/${encodeURIComponent(snapshot.project.id)}/${path.split(/[\\/]/u).map(encodeURIComponent).join("/")}`;
  async function refresh() {
    const result = await task.request<Library>(`${base}/sound-library`);
    const state = await task.request<ProjectState>(base);
    setLibrary(result); setCurrent(state.snapshot);
    return state;
  }
  useEffect(() => { setCurrent(snapshot); }, [snapshot]);
  useEffect(() => {
    setLibrary(undefined); setRequestId(""); setPlanId(""); setIntentId(""); setSelected([]); setOriginalId(""); setCompareIds([]); setComparisons([]); setPreview(undefined); setRanking("");
    void task.action("读取声音需求", async () => { await refresh(); });
  }, [snapshot.project.id]);
  const fps = current.timeline.fps;
  const plan = library?.plans.find((item) => item.id === planId);
  useEffect(() => { setDominantRole(plan?.dominantRole ?? "narration"); }, [plan?.id]);
  useEffect(() => {
    const intent = plan?.intents.find((entry) => entry.id === intentId);
    if (intent) { setFunctionName(intent.function); setBrief(intent.brief); }
  }, [plan?.id, plan?.version, intentId]);
  const requirement = library?.requests.find((item) => item.id === requestId);
  useEffect(() => {
    if (!requirement) return;
    setPlanId(requirement.sound?.soundPlanId ?? ""); setIntentId(requirement.sound?.soundIntentId ?? "");
    setRole(requirement.role === "bgm" ? "bgm" : "sfx"); setProvider(requirement.role === "bgm" ? "mixkit_music" : "mixkit"); setBrief(requirement.audioBrief ?? "");
    const linked = library?.plans.find((p) => p.id === requirement.sound?.soundPlanId);
    if (linked) { setFrom(linked.startFrame / fps); setTo(linked.endFrame / fps); setNarration(linked.narrationDirection); setMusic(linked.musicDirection); }
  }, [requestId, requirement?.id]);
  const candidates = [...new Map([...(library?.sessions.flatMap((session) => session.candidates) ?? []), ...current.assetCandidates].filter((item) => item.kind === "audio" && (!requestId || item.assetRequestId === requestId)).map((item) => [item.id, item])).values()];
  const originals = current.assets.filter((item) => item.kind === "audio" && item.status === "ready");
  const original = originals.find((item) => item.id === originalId);
  const events = current.effectCues.flatMap((cue) => {
    const work = cue.assetBindings.map((binding) => current.assets.find((asset) => asset.id === binding.assetId)?.motion).find((motion) => motion?.eventMap);
    return (work?.eventMap?.events ?? []).map((event) => ({ key: `${cue.id}:${event.id}`, cue, event: { ...event, startFrame: Math.round(event.startFrame * fps / work!.eventMap!.fps), endFrame: event.endFrame === undefined ? undefined : Math.round(event.endFrame * fps / work!.eventMap!.fps) }, version: work!.eventMap!.version }));
  });
  const selectedEvent = events.find((entry) => entry.key === eventKey);
  const motionEvent = selectedEvent && { ...selectedEvent, event: { ...selectedEvent.event, startFrame: eventPhase === "end" && selectedEvent.event.endFrame !== undefined ? Math.min(selectedEvent.event.endFrame, selectedEvent.cue.endFrame - selectedEvent.cue.startFrame - 1) : selectedEvent.event.startFrame, endFrame: eventPhase === "sustain" ? selectedEvent.event.endFrame : undefined } };
  const replacement = current.audioCues.find((cue) => cue.soundPlanId === planId && cue.soundIntentId === intentId && cue.status === "ready");
  const formAudio = (assetId: string) => ({ assetId, kind: role, purpose: brief || requirement?.audioBrief || "复核当前段落声音",
    sourceStartFrame: Math.round(sourceStart * fps), sourceEndFrame: Math.round(sourceEnd * fps), gainDb: gain,
    ...(role === "sfx" ? { eventFrame: motionEvent ? motionEvent.cue.startFrame + motionEvent.event.startFrame : Math.round(eventSeconds * fps), onsetOffsetFrames: Math.round(onset * fps) } : { startFrame: Math.round(from * fps), endFrame: Math.round(to * fps) }),
    fadeInFrames: 0, fadeOutFrames: Math.min(3, Math.round((sourceEnd - sourceStart) * fps / 3)), loop: false,
    design: { role: role === "bgm" ? "music" as const : functionName === "demonstration" ? "demonstration" as const : functionName === "ambience" ? "ambience" as const : "sfx" as const,
      ...(motionEvent?.event.endFrame === undefined ? {} : { durationFrames: motionEvent.event.endFrame - motionEvent.event.startFrame + Math.round(onset * fps) }) }
  });
  const run = (title: string, work: () => Promise<void>) => void task.action(title, work);
  return <section className="story-card" data-testid="sound-library">
    <strong>段落声音与在线选音</strong><p>先确定声音的作用，再搜索少量候选；采用原文件后，在真实旁白和动效中比较。</p>
    {task.busy && <p role="status">{task.busy}。离开页面后可在任务中心继续查看。</p>}{task.error && <p role="alert">{task.error}</p>}
    <fieldset disabled={Boolean(task.busy)}><legend>段落声音设计</legend>
      <label>已有计划<select value={planId} onChange={(e) => { const value = library?.plans.find((p) => p.id === e.target.value); setPlanId(e.target.value); setIntentId(""); if (value) { setFrom(value.startFrame / fps); setTo(value.endFrame / fps); setNarration(value.narrationDirection); setMusic(value.musicDirection); } }}><option value="">新段落</option>{library?.plans.map((p) => <option key={p.id} value={p.id}>{(p.startFrame / fps).toFixed(1)}–{(p.endFrame / fps).toFixed(1)} 秒 · 第 {p.version} 版</option>)}</select></label>
      <label>段落开始（秒）<input type="number" min="0" step="0.1" value={from} onChange={(e) => setFrom(Number(e.target.value))} /></label>
      <label>段落结束（秒）<input type="number" min="0.1" step="0.1" value={to} onChange={(e) => setTo(Number(e.target.value))} /></label>
      <label>旁白怎样讲<textarea value={narration} onChange={(e) => setNarration(e.target.value)} /></label><label>音乐怎样贯穿<textarea value={music} onChange={(e) => setMusic(e.target.value)} /></label>
      <label>本段主要听什么<select value={dominantRole} onChange={(e) => setDominantRole(e.target.value as AudioRole)}>{Object.entries({ narration: "旁白", source_speech: "人物原声", demonstration: "演示声音", music: "音乐", ambience: "环境", sfx: "动作音效" }).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
      <button onClick={() => run("保存声音计划", async () => { const state = await task.request<ProjectState>(base); const result = await task.request<ProjectState>(`${base}/sound-plans`, { baseRevision: state.revision.number, plan: { action: plan ? "update" : "create", soundPlanId: plan?.id, startFrame: Math.round(from * fps), endFrame: Math.round(to * fps), narrationDirection: narration, musicDirection: music, dominantRole, intents: plan?.intents ?? [] } }); setPlanId(plan?.id ?? result.snapshot.soundPlans!.at(-1)!.id); await refresh(); })}>保存段落</button>
      <label>声音意图<select value={intentId} onChange={(e) => { setIntentId(e.target.value); setBrief(plan?.intents.find((i) => i.id === e.target.value)?.brief ?? ""); }}><option value="">新声音意图</option>{plan?.intents.map((i) => <option key={i.id} value={i.id}>{i.brief}</option>)}</select></label>
      <label>承担什么作用<select value={functionName} onChange={(e) => setFunctionName(e.target.value as typeof functionName)}>{Object.entries({ anticipation: "预示动作", settle: "动作落定", reaction: "反应", connection: "连接过程", ambience: "环境", music: "贯穿音乐", silence: "留白", demonstration: "声音本身需要被听清" }).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>听起来应该怎样<textarea value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="例如：轻机械触感，短攻击，尾音干净，无人声" /></label>
      <button disabled={!plan || !brief.trim()} onClick={() => run("保存声音意图", async () => { const state = await task.request<ProjectState>(base); const fresh = state.snapshot.soundPlans?.find((p) => p.id === planId); if (!fresh) throw new Error("请先保存段落"); const id = intentId || crypto.randomUUID(); await task.request(`${base}/sound-plans`, { baseRevision: state.revision.number, plan: { action: "update", soundPlanId: planId, intents: [...fresh.intents.filter((i) => i.id !== id), { id, function: functionName, brief }] } }); setIntentId(id); await refresh(); })}>保存声音意图</button>
    </fieldset>
    <fieldset disabled={Boolean(task.busy)}><legend>在线来源与声音需求</legend>
      <label>需求<select value={requestId} onChange={(e) => { setRequestId(e.target.value); setSelected([]); setRanking(""); }}><option value="">选择或新建需求</option>{library?.requests.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
      <label>类别<select value={role} onChange={(e) => { setRole(e.target.value as typeof role); setProvider(e.target.value === "bgm" ? "mixkit_music" : "mixkit"); }}><option value="sfx">音效</option><option value="bgm">音乐</option></select></label>
      <button disabled={!brief.trim() || !plan || !intentId} onClick={() => run("创建声音需求", async () => { const state = await task.request<ProjectState>(base); const result = await task.request<ProjectState>(`${base}/sound-requirement`, { baseRevision: state.revision.number, title: brief.slice(0, 80), audioBrief: brief, role, sound: { soundPlanId: planId, soundIntentId: intentId, excludeSpeech: true, excludeMusic: role === "sfx" } }); setRequestId(result.snapshot.assetRequests.at(-1)!.id); await refresh(); })}>为此意图创建需求</button>
      <label>来源<select value={provider} onChange={(e) => setProvider(e.target.value)}>{library?.sources.map((s) => <option key={s.id} value={s.id} disabled={!s.enabled}>{s.name}{s.enabled ? "" : "（未启用）"}</option>)}</select></label>
      {library?.sources.filter((s) => s.id === provider).map((s) => <p key={s.id}>{s.limits}</p>)}
      <label>描述或分类<input value={query} onChange={(e) => setQuery(e.target.value)} list="sound-categories" placeholder="例如：纸张撕开 / whoosh / cinematic" /></label><datalist id="sound-categories">{library?.sources.find((s) => s.id === provider)?.categories.map((category) => <option key={category} value={category} />)}</datalist>
      <button disabled={!requestId || !query.trim()} onClick={() => run("搜索在线候选", async () => { await task.request(`${base}/sound-search`, { assetRequestId: requestId, provider, query }); await refresh(); })}>搜索</button>
      <button disabled={!requestId || !selected.length} onClick={() => run("比较并分析有限候选", async () => { const job = await task.finish(await task.request<JobRecord>(`${base}/sound-rank`, { assetRequestId: requestId, candidateIds: selected.slice(0, 30), analyzeTop: 3 })); setRanking(JSON.stringify(job.result?.ranked, null, 2)); for (const id of (job.result?.analysisJobIds ?? []) as string[]) await task.finish(await task.request<JobRecord>(`${API_BASE}/api/jobs/${encodeURIComponent(id)}`)); await refresh(); })}>语义排序并分析前三条</button>
    </fieldset>
    {ranking && <details><summary>元数据排序记录（仍需核查实际声音）</summary><pre style={{ whiteSpace: "pre-wrap" }}>{ranking}</pre></details>}
    {candidates.map((c) => <article key={c.id}><label><input type="checkbox" disabled={!c.hardFilterPassed || Boolean(task.busy)} checked={selected.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))} />{c.name}</label><p>{c.status} · {c.filterReasons.join("；")}</p>{c.previewUrl && <audio controls preload="none" src={c.previewUrl} aria-label={`候选试听：${c.name}`} />}<a href={c.sourceUrl} target="_blank" rel="noreferrer">原站</a>
      <button disabled={Boolean(task.busy) || !c.hardFilterPassed || c.status === "acquired"} onClick={() => run("获取原文件", async () => { const state = await task.request<ProjectState>(base); const result = await task.request<{ job: JobRecord }>(`${base}/sound-acquire`, { baseRevision: state.revision.number, assetCandidateId: c.id }); const acquired = await task.finish(result.job); if (acquired.result?.mediaAnalysisJobId) await task.finish(await task.request<JobRecord>(`${API_BASE}/api/jobs/${encodeURIComponent(String(acquired.result.mediaAnalysisJobId))}`)); await refresh(); })}>获取原文件</button>
      <button disabled={Boolean(task.busy)} onClick={() => run("读取候选的实际观察", async () => { const result = await task.request(`${base}/media-observations/read`, { candidateId: c.id }); setRanking(JSON.stringify(result, null, 2)); })}>查看声音观察</button>
    </article>)}
    <fieldset disabled={Boolean(task.busy)}><legend>原文件与声画比较</legend>
      <label>已取得原文件<select value={originalId} onChange={(e) => { const chosen = originals.find((asset) => asset.id === e.target.value); setOriginalId(e.target.value); setSourceStart(0); setSourceEnd(Math.min((chosen?.metadata?.durationMs ?? 1000) / 1000, role === "bgm" ? to - from : 1)); setOnset(0); setOnsetConfirmed(false); setNote(""); }}><option value="">选择原文件</option>{originals.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {original && <audio ref={originalPlayer} controls preload="metadata" src={mediaUrl(original.managedPath)} aria-label="原文件试听" />}
      <label>源开始（秒）<input type="number" min="0" step="0.001" value={sourceStart} onChange={(e) => { setSourceStart(Number(e.target.value)); setOnsetConfirmed(false); }} /></label><label>源结束（秒）<input type="number" min="0.001" step="0.001" value={sourceEnd} onChange={(e) => { setSourceEnd(Number(e.target.value)); setOnsetConfirmed(false); }} /></label>
      <label>当前作品动作<select value={eventKey} onChange={(e) => { setEventKey(e.target.value); setOnsetConfirmed(false); }}><option value="">独立声音事件</option>{events.map((entry) => <option key={entry.key} value={entry.key}>{entry.event.meaning} · {((entry.cue.startFrame + entry.event.startFrame) / fps).toFixed(2)} 秒</option>)}</select></label>
      {motionEvent && <label>怎样配合动作<select value={eventPhase} onChange={(e) => { setEventPhase(e.target.value as typeof eventPhase); setOnsetConfirmed(false); }}><option value="start">起势发声</option><option value="end" disabled={selectedEvent?.event.endFrame === undefined}>落定发声</option><option value="sustain" disabled={selectedEvent?.event.endFrame === undefined}>包络贯穿动作</option></select></label>}
      {!motionEvent && <label>成片声音落点（秒）<input type="number" min="0" step="0.01" value={eventSeconds} onChange={(e) => setEventSeconds(Number(e.target.value))} /></label>}
      <label>所选源范围内部的可听起音偏移（秒）<input type="number" min="0" step="0.001" value={onset} onChange={(e) => { setOnset(Number(e.target.value)); setOnsetConfirmed(false); }} /></label><label>增益（dB）<input type="number" min="-48" max="12" value={gain} onChange={(e) => setGain(Number(e.target.value))} /></label>
      <p>比较沿用上面的段落范围与声音参数；较短的替代原文件需调整源结束位置。</p>{originals.map((a) => <label key={a.id}><input type="checkbox" checked={compareIds.includes(a.id)} onChange={(e) => setCompareIds(e.target.checked ? [...compareIds, a.id].slice(-3) : compareIds.filter((id) => id !== a.id))} />{a.name}</label>)}
      <button disabled={!compareIds.length} onClick={() => run("生成同段声画比较", async () => { const state = await task.request<ProjectState>(base); const job = await task.finish(await task.request<JobRecord>(`${base}/sound-comparison`, { revision: state.revision.number, fromFrame: Math.round(from * fps), toFrame: Math.round(to * fps), replaceCueId: replacement?.id, alternatives: compareIds.map((id, index) => ({ ...formAudio(id), name: `方案 ${index + 1} · ${originals.find((a) => a.id === id)?.name}` })), includeWithout: true })); setComparisons((job.result?.outputs ?? []) as Comparison[]); })}>生成方案与无该声音对照</button>
      <label><input type="checkbox" checked={onsetConfirmed} onChange={(e) => setOnsetConfirmed(e.target.checked)} />我已在原文件及实际声画中复核起音</label><label>听审依据<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="记录起音、遮蔽、尾音与动作关系；未实际听审请保留待复核" /></label>
      <button disabled={!original || note.trim().length < 16} onClick={() => run("应用原文件", async () => { const state = await task.request<ProjectState>(base); const freshPlan = state.snapshot.soundPlans?.find((p) => p.id === planId); const audio = formAudio(originalId); await task.request(`${base}/audio`, { ...audio, baseRevision: state.revision.number, action: replacement ? "update" : "create", audioCueId: replacement?.id, onsetReview: role === "sfx" ? { status: onsetConfirmed ? "confirmed" : "inconclusive", note } : undefined, effectEvent: motionEvent ? { effectCueId: motionEvent.cue.id, eventName: motionEvent.event.meaning, localFrame: motionEvent.event.startFrame, endLocalFrame: motionEvent.event.endFrame, eventId: motionEvent.event.id, workVersion: motionEvent.version } : null, design: { ...audio.design, role: role === "bgm" ? "music" : functionName === "demonstration" ? "demonstration" : functionName === "ambience" ? "ambience" : "sfx", ...(freshPlan && intentId ? { soundPlanId: freshPlan.id, soundIntentId: intentId, planVersion: freshPlan.version } : {}) } }); await refresh(); })}>采用到成片</button>
    </fieldset>
    {original && <MediaIntelligencePanel snapshot={current} asset={original} defaultRequestId={requestId} onLocate={(seconds) => { if (originalPlayer.current) originalPlayer.current.currentTime = seconds; setSourceStart(seconds); }} />}
    {comparisons.map((item) => <article key={item.relativePath}><strong>{item.name}</strong><video controls preload="metadata" style={{ width: "100%" }} src={mediaUrl(item.relativePath)} /></article>)}
    <fieldset disabled={Boolean(task.busy)}><legend>正式混合复核</legend>
      <button onClick={() => run("生成当前段落正式预览", async () => { const state = await task.request<ProjectState>(base); const job = await task.finish(await task.request<JobRecord>(`${base}/previews`, { revision: state.revision.number, fromFrame: Math.round(from * fps), toFrame: Math.round(to * fps) })); setPreview(job); })}>生成正式预览</button>
      {typeof preview?.result?.relativePath === "string" && <video controls preload="metadata" style={{ width: "100%" }} src={mediaUrl(String(preview.result.relativePath))} />}
      {(["passed", "failed", "inconclusive"] as const).map((outcome, index) => <button key={outcome} disabled={!preview || note.trim().length < 16} onClick={() => run("保存实际混合复核", async () => { const state = await task.request<ProjectState>(base); await task.request(`${base}/sound-mix-review`, { baseRevision: state.revision.number, previewJobId: preview!.id, outcome, method: "audiovisual", note }); await refresh(); })}>{["实际复听通过", "实际复听未通过", "尚不能判断"][index]}</button>)}
    </fieldset>
  </section>;
}
