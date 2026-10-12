import { useState } from "react";
import type { ExplicitCreativePreferences, ExpressionDimension } from "@videocut/contracts";
import { api } from "./api";

const dimensions: Array<[ExpressionDimension, string]> = [
  ["narration", "讲述口吻"], ["visual", "视觉语言"], ["motion", "运动性格"],
  ["background", "背景关系"], ["sound", "声音气质"]
];

export function CreativeDefaultsSettings() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<ExplicitCreativePreferences>({});
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => {
    setOpen(true); setBusy(true); setLoaded(false); setMessage("");
    try { setValue(await api.creativeDefaults()); setLoaded(true); }
    catch (error) { setMessage(error instanceof Error ? error.message : "读取失败，请重试"); }
    finally { setBusy(false); }
  };
  const save = async (clear: boolean) => {
    setBusy(true); setMessage("");
    const chosen = Object.fromEntries(Object.entries(value.dimensions ?? {}).flatMap(([key, text]) => text?.trim() ? [[key, text.trim()]] : []));
    const preferences = { ...(Object.keys(chosen).length ? { dimensions: chosen } : {}), ...(value.notes?.trim() ? { notes: value.notes.trim() } : {}) };
    try {
      setValue(await (clear ? api.clearCreativeDefaults() : api.saveCreativeDefaults(preferences)));
      setMessage(clear ? "已清空，后续新项目由导演自主判断。" : "已保存，仅对后续新建项目生效。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  };
  return <>
    <button className="creative-defaults-trigger" onClick={() => void load()}>创作默认偏好</button>
    {open && <div className="creative-defaults-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="creative-defaults-title" className="creative-defaults-dialog">
      <h2 id="creative-defaults-title">创作默认偏好</h2>
      <p>可全部留空，也可只填一项；其余由导演根据内容判断。保存后仅影响新建项目，本次任务要求优先。</p>
      <fieldset disabled={busy || !loaded}>
        {dimensions.map(([key, label]) => <label key={key}>{label}<input maxLength={1600} value={value.dimensions?.[key] ?? ""} placeholder="由导演判断" onChange={event => setValue(previous => ({ ...previous, dimensions: { ...previous.dimensions, [key]: event.target.value } }))} /></label>)}
        <label>其他明确要求<textarea maxLength={4000} value={value.notes ?? ""} onChange={event => setValue(previous => ({ ...previous, notes: event.target.value }))} /></label>
        <div className="creative-defaults-actions"><button className="primary" onClick={() => void save(false)}>保存默认</button><button onClick={() => void save(true)}>清空默认</button></div>
      </fieldset>
      <p role="status">{busy ? "正在处理…" : message}</p>
      {!loaded && !busy && <button onClick={() => void load()}>重新读取</button>}
      <button disabled={busy} onClick={() => setOpen(false)}>关闭</button>
    </section></div>}
  </>;
}
