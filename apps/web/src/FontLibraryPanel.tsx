import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { FontPreviewLoader } from "./font-preview-loader";
import { readFontPreview, type FontLibraryFace } from "../../../packages/motion-work/src/font-preview";

const defaultText = "字体 Aa";

function FontSample({ face, loader, text, size, light, onLoaded }: { face: FontLibraryFace; loader: FontPreviewLoader; text: string; size: number; light: boolean; onLoaded?: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [family, setFamily] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "100px" });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    setFamily(""); setError("");
    void loader.load(face).then(value => { if (current) { setFamily(value); onLoaded?.(face.id); } }, failure => {
      if (current) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { current = false; };
  }, [visible, loader, face.id, face.sha256, onLoaded]);
  return <div ref={container} className={`font-sample ${light ? "font-sample-light" : ""}`} data-font-id={face.id} data-font-status={error ? "failed" : family ? "loaded" : "loading"}>
    {error ? <p className="font-error">预览失败：{error}</p> : family
      ? <div style={{ fontFamily: family, fontWeight: face.weight, fontStyle: face.style, fontSize: size, fontSynthesis: "none" }}>{text || "请输入预览文字"}</div>
      : <p className="font-loading">{visible ? "字体加载中…" : "滚动到此处后加载"}</p>}
  </div>;
}

function FontComparison({ faces, loader, text, size, light, close }: { faces: FontLibraryFace[]; loader: FontPreviewLoader; text: string; size: number; light: boolean; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="font-comparison" onCancel={event => { event.preventDefault(); close(); }} aria-label="字体放大对比">
    <div className="font-comparison-heading"><h2>字体放大对比</h2><button autoFocus onClick={close}>关闭</button></div>
    <p>相同文案、字号与背景。不同字幅产生的换行差异保留。</p>
    <div className="font-comparison-grid" style={{ gridTemplateColumns: `repeat(${faces.length}, minmax(0, 1fr))` }}>
      {faces.map(face => <article key={face.id}><h3>{face.name}</h3><FontSample {...{ face, loader, text, size, light }} /></article>)}
    </div>
  </dialog>;
}

/** 浏览、比较与复制选择均为本地界面状态；聊天确认后才由主任务安排正式制作。 */
export function FontLibraryPanel() {
  const [context] = useState(() => readFontPreview(window.location.search));
  const [fonts, setFonts] = useState<FontLibraryFace[]>([]);
  const [loader, setLoader] = useState<FontPreviewLoader>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [text, setText] = useState(context.preview?.text ?? defaultText);
  const [size, setSize] = useState(18);
  const [light, setLight] = useState(false);
  const [recommendedOnly, setRecommendedOnly] = useState(Boolean(context.preview));
  const [selected, setSelected] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [readyIds, setReadyIds] = useState<Set<string>>(() => new Set());
  const onLoaded = useCallback((id: string) => setReadyIds(old => old.has(id) ? old : new Set([...old, id])), []);
  useEffect(() => {
    const owned = new FontPreviewLoader(), controller = new AbortController();
    setLoader(owned);
    setReadyIds(new Set());
    void api.fontCapabilities(controller.signal).then(result => { if (!controller.signal.aborted) setFonts(result.fonts); }, failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { controller.abort(); owned.dispose(); };
  }, []);
  const recommendations = context.preview?.candidates ?? [];
  const rank = (id: string) => recommendations.findIndex(entry => entry.font_id === id);
  const missing = fonts.length ? recommendations.filter(entry => !fonts.some(face => face.id === entry.font_id)) : [];
  const visible = fonts.filter(face => (!recommendedOnly || rank(face.id) >= 0) && `${face.name} ${face.id}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (rank(a.id) < 0 ? 999 : rank(a.id)) - (rank(b.id) < 0 ? 999 : rank(b.id)));
  async function copy(face: FontLibraryFace) {
    const value = `${context.preview?.purpose ? `${context.preview.purpose}：` : "本次字体选择："}选用${face.name}（字体ID：${face.id}）。`;
    setSelectionText(value);
    try { await navigator.clipboard.writeText(value); setCopyMessage("已复制，请发到聊天中确认选择。尚未修改视频。"); }
    catch { setCopyMessage("请复制下面的选择文字，发到聊天中确认。尚未修改视频。"); }
  }
  return <section className="font-library" data-testid="font-library">
    <div className="font-library-heading"><h2>字体库</h2><small>{fonts.length ? `${fonts.length} 个可用字款` : "正在读取…"}</small></div>
    {context.preview && <div className="font-recommendation-context">
      <strong>原作者推荐 · 主任务协调选择</strong>
      {context.preview.expected_font && <p>原计划：{context.preview.expected_font}</p>}
      {context.preview.purpose && <p>用途：{context.preview.purpose}</p>}
      <p>查看字样后在聊天中确认；未回复不会自动采用首选。</p>
    </div>}
    {(context.error || error) && <p role="alert" className="font-error">{context.error || error}</p>}
    {!!missing.length && <p role="alert" className="font-error">推荐中的{missing.map(entry => entry.font_id).join("、")}已不在当前字体库，请让主任务重新提供候选。</p>}
    <label>搜索名称<input aria-label="搜索字体" value={query} onChange={event => setQuery(event.target.value)} placeholder="例如：仓耳、得意黑" /></label>
    <label>预览文字<textarea aria-label="字体预览文字" value={text} maxLength={300} rows={3} onChange={event => setText(event.target.value)} /></label>
    <label className="font-size-control">字号 {size}<input aria-label="字体预览字号" type="range" min={12} max={72} value={size} onChange={event => setSize(Number(event.target.value))} /></label>
    <div className="font-library-actions"><button onClick={() => setLight(value => !value)}>{light ? "切换深色背景" : "切换浅色背景"}</button><button disabled={!selected.length} onClick={() => setComparing(true)}>放大对比（{selected.length}/3）</button></div>
    {!!recommendations.length && <label className="font-only-recommended"><input type="checkbox" checked={recommendedOnly} onChange={event => setRecommendedOnly(event.target.checked)} />只看推荐字体</label>}
    <p className="font-library-note">预览为原字体，无描边或动效。部分生僻字或符号可能缺字，请用实际文案检查。复制选择后，请在聊天中确认用途。</p>
    {selectionText && <div className="font-copy-result"><p role="status">{copyMessage}</p><textarea aria-label="字体选择文字" readOnly value={selectionText} rows={3} /></div>}
    <div className="font-card-grid">{loader && visible.map(face => <article key={face.id} className="font-card" data-testid={`font-card-${face.id}`}>
      <div className="font-card-heading"><strong title={face.name}>{rank(face.id) >= 0 ? `${rank(face.id) + 1}. ` : ""}{face.name}</strong>{rank(face.id) === 0 && <small>首选</small>}</div>
      {rank(face.id) >= 0 && <p className="font-reason">{recommendations[rank(face.id)]!.reason}</p>}
      <FontSample {...{ face, loader, text, size, light, onLoaded }} />
      <div className="font-card-actions"><label title="加入放大对比"><input type="checkbox" aria-label={`对比${face.name}`} checked={selected.includes(face.id)} disabled={!selected.includes(face.id) && selected.length >= 3} onChange={() => setSelected(value => value.includes(face.id) ? value.filter(id => id !== face.id) : [...value, face.id])} />对比</label><button title="复制选择，发到聊天中确认" disabled={!readyIds.has(face.id)} onClick={() => void copy(face)}>复制</button></div>
    </article>)}</div>
    {fonts.length > 0 && !visible.length && <p>没有匹配字款，请调整搜索或查看全部字体。</p>}
    {comparing && loader && <FontComparison faces={selected.map(id => fonts.find(face => face.id === id)!)} {...{ loader, text, size, light }} close={() => setComparing(false)} />}
  </section>;
}
