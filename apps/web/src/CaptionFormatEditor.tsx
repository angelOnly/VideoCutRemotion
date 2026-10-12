import { useEffect, useState } from "react";
import type { CaptionFormat } from "@videocut/contracts";
import type { FontLibraryFace } from "../../../packages/motion-work/src/font-preview";
import { api } from "./api";

type FormatPatch = Partial<Omit<CaptionFormat, "font" | "placement">> & { placement?: CaptionFormat["placement"] | null };

/** 只保存明确改过的全片字段，颜色调整不会重新选择或绑定字体原件。 */
export function CaptionFormatEditor({ format, disabled, onSave }: {
  format: CaptionFormat;
  disabled: boolean;
  onSave: (format: Record<string, unknown>) => void;
}) {
  const [patch, setPatch] = useState<FormatPatch>({});
  const [fonts, setFonts] = useState<FontLibraryFace[]>([]);
  const [error, setError] = useState("");
  useEffect(() => setPatch({}), [format]);
  useEffect(() => {
    const controller = new AbortController();
    void api.fontCapabilities(controller.signal).then(result => {
      if (!controller.signal.aborted) setFonts(result.fonts);
    }, failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, []);
  const current = { ...format, ...patch };
  const placement = current.placement;
  const numberField = (key: "fontSize" | "fontWeight" | "bottomPercent" | "horizontalInsetPercent" | "lineHeight" | "paddingHorizontal" | "paddingVertical" | "borderRadius", label: string, value: number, min: number, max: number, step: number | "any" = "any") =>
    <label key={key}>{label}<input aria-label={`全片字幕${label}`} type="number" min={min} max={max} step={Number.isInteger(step) ? step : "any"} value={current[key] ?? value} onChange={event => setPatch(previous => ({ ...previous, [key]: Number(event.target.value) }))} /></label>;
  return <section className="caption-card" aria-label="全片字幕样式">
    <h3>全片字幕样式</h3>
    <p>当前全片使用 {format.fontId ?? "既定字体"} · {format.fontSize} px · 固定 {format.maxLines ?? 2} 行占位。正文与显示时间在下方各卡编辑。</p>
    <details><summary>调整全片样式</summary>
      <form className="caption-editor" onSubmit={event => { event.preventDefault(); if (Object.keys(patch).length) onSave(patch); }}>
        <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
          <label>字体<select aria-label="全片字幕字体" value={current.fontId ?? ""} onChange={event => {
            const face = fonts.find(entry => entry.id === event.target.value);
            if (face) setPatch(previous => ({ ...previous, fontId: face.id, fontWeight: Math.max(400, face.weight) }));
          }}>
            {!fonts.some(face => face.id === current.fontId) && <option value={current.fontId ?? ""}>{current.fontId ?? "既定字体"}</option>}
            {fonts.map(face => <option key={face.id} value={face.id}>{face.name}</option>)}
          </select></label>
          {error && <p role="alert">字体列表读取失败：{error}。当前字体保持不变，仍可调整其他样式。</p>}
          <label>行数规则<select aria-label="全片字幕行数" value={current.maxLines ?? 2} onChange={event => setPatch(previous => ({ ...previous, maxLines: Number(event.target.value) as 1 | 2 }))}><option value={1}>固定单行</option><option value={2}>固定双行占位</option></select></label>
          <div className="caption-field-row">{numberField("fontSize", "字号", 32, 16, 72, 1)}{numberField("fontWeight", "字重", 700, 400, 900, 1)}</div>
          <label>字色<input aria-label="全片字幕字色" type="color" value={current.color} onChange={event => setPatch(previous => ({ ...previous, color: event.target.value }))} /></label>
          <label>对齐<select value={current.textAlign} onChange={event => setPatch(previous => ({ ...previous, textAlign: event.target.value as CaptionFormat["textAlign"] }))}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
          <label>位置<select aria-label="全片字幕位置" value={placement ? "placed" : "bottom"} onChange={event => setPatch(previous => ({ ...previous, placement: event.target.value === "placed" ? { leftPercent: 8, topPercent: 80, widthPercent: 84 } : null }))}><option value="bottom">底部布局</option><option value="placed">固定自定位置</option></select></label>
          {placement ? <div className="caption-field-row">{([["leftPercent", "左侧 %"], ["topPercent", "顶部 %"], ["widthPercent", "宽度 %"]] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min={key === "widthPercent" ? 5 : 0} max={100} step="any" value={placement[key]} onChange={event => setPatch(previous => ({ ...previous, placement: { ...placement, [key]: Number(event.target.value) } }))} /></label>)}</div>
            : <div className="caption-field-row">{numberField("bottomPercent", "距底部 %", 7, 0, 95, 0.5)}{numberField("horizontalInsetPercent", "左右边距 %", 8, 0, 45, 0.5)}</div>}
          <div className="caption-field-row">{numberField("lineHeight", "行高", 1.36, 1, 2, 0.01)}{numberField("borderRadius", "圆角", current.backgroundColor ? current.fontSize * 0.22 : 0, 0, 72, 0.01)}</div>
          <div className="caption-field-row">{numberField("paddingHorizontal", "水平内边距", current.backgroundColor ? current.fontSize * 0.32 : 0, 0, 72, 0.01)}{numberField("paddingVertical", "垂直内边距", current.backgroundColor ? current.fontSize * 0.13 : 0, 0, 72, 0.01)}</div>
          <label>底板宽度<select value={current.boxWidth ?? "content"} onChange={event => setPatch(previous => ({ ...previous, boxWidth: event.target.value as "content" | "full" }))}><option value="content">随文字宽度</option><option value="full">固定框宽度</option></select></label>
          <button type="submit" disabled={!Object.keys(patch).length}>保存全片样式</button>
        </fieldset>
      </form>
    </details>
  </section>;
}
