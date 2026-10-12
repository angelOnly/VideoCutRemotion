import { useEffect, useRef, useState } from "react";
import type { JobRecord } from "@videocut/contracts";
import { API_BASE } from "./api";

/** 切换项目只终止页面等待；已取得 ID 的后台任务由任务中心继续跟踪。 */
export function useMediaTask(identity: string) {
  const epoch = useRef(0), controller = useRef(new AbortController());
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    epoch.current++; controller.current = new AbortController(); setBusy(""); setError("");
    return () => { epoch.current++; controller.current.abort(); };
  }, [identity]);
  async function request<T>(url: string, body?: unknown): Promise<T> {
    const stamp = epoch.current;
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), signal: controller.current.signal });
    const result = await response.json();
    if (stamp !== epoch.current) throw new DOMException("当前对象已切换", "AbortError");
    if (!response.ok) throw new Error(result.message ?? result.error ?? `请求失败：${response.status}`);
    return result as T;
  }
  async function finish(job: JobRecord): Promise<JobRecord> {
    let latest = job;
    const stamp = epoch.current;
    while (latest.status === "queued" || latest.status === "running") {
      if (stamp !== epoch.current) throw new DOMException("当前对象已切换", "AbortError");
      setBusy(`${latest.status === "queued" ? "排队中" : "处理中"} · ${job.id}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (stamp !== epoch.current) throw new DOMException("当前对象已切换", "AbortError");
      latest = await request<JobRecord>(`${API_BASE}/api/jobs/${encodeURIComponent(job.id)}`);
    }
    if (latest.status !== "succeeded") throw new Error(latest.error ?? `任务状态：${latest.status}`);
    return latest;
  }
  async function action(title: string, work: () => Promise<void>) {
    const stamp = epoch.current; setBusy(title); setError("");
    try { await work(); } catch (error) { if (stamp === epoch.current && !(error instanceof Error && error.name === "AbortError")) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (stamp === epoch.current) setBusy(""); }
  }
  return { request, finish, action, busy, error };
}
