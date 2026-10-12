import { useEffect, useState } from "react";
import type { FrameRateChangeReport } from "@videocut/contracts";
import { api } from "./api";

/** 影响报告绑定预检查时的版本；后台更新后必须重新计算，不能沿用旧报告提交。 */
export function FrameRateSettings({ projectId, revision, fps, onApplied }: { projectId: string; revision: number; fps: number; onApplied: (fromFps: number, toFps: number, durationInFrames: number) => Promise<void> }) {
  const [target, setTarget] = useState(fps);
  const [report, setReport] = useState<FrameRateChangeReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setTarget(fps); setReport(undefined); }, [fps]);
  const check = async () => {
    setBusy(true); setError(""); setReport(undefined);
    try { setReport(await api.previewFrameRateChange(projectId, revision, target)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!report || report.revision !== revision || !report.canApply) return;
    setBusy(true); setError("");
    try {
      const result = await api.setFrameRate(projectId, report.revision, report.toFps);
      await onApplied(report.fromFps, result.snapshot.timeline.fps, result.snapshot.timeline.durationInFrames);
      setReport(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <details className="frame-rate-settings">
    <summary>帧率设置</summary>
    <div className="frame-rate-popover">
      <label>成片帧率 <input aria-label="项目目标帧率" type="number" min={15} max={60} step={1} value={target} onChange={event => { setTarget(Number(event.target.value)); setReport(undefined); }} disabled={busy} /></label>
      <p>保持片段实际时间，支持15–60整数帧率。改变后需重新预览和声画复核。</p>
      <button onClick={() => void check()} disabled={busy || !Number.isInteger(target) || target < 15 || target > 60}>检查变更影响</button>
      {report && <div role="status">
        <p>{report.fromFps} → {report.toFps} fps；时长 {report.durationBeforeSeconds.toFixed(3)} → {report.durationAfterSeconds.toFixed(3)} 秒；最大边界偏差 {report.maxBoundaryErrorMs.toFixed(2)} 毫秒。</p>
        {report.blockers.map((entry, index) => <p key={index}>{entry.objectId && `${entry.objectId}：`}{entry.message}</p>)}
        {report.changed && <p>需更新：{report.rebuild.join("、")}。提高帧率不会增加已有动画的运动细节。</p>}
        {report.revision !== revision && <p>项目已更新，请重新检查变更影响。</p>}
        <button onClick={() => void apply()} disabled={busy || !report.changed || !report.canApply || report.revision !== revision}>应用帧率</button>
      </div>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
