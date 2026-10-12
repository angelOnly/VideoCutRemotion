import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { errorDetail } from "../../../packages/job-runtime/src/error-detail.js";

function bound(value: unknown, depth = 0, budget = { nodes: 40 }): unknown {
  if (--budget.nodes < 0) return "内容已截断";
  if (typeof value === "string") return value.slice(0, 4096);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "内容已截断";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => bound(item, depth + 1, budget));
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key.slice(0, 80), bound(item, depth + 1, budget)]));
}

function boundedDetail(detail: Record<string, unknown>) {
  const result = bound(detail);
  const json = JSON.stringify(result);
  return Buffer.byteLength(json) <= 8192 ? result : { truncated: true, preview: Buffer.from(json).subarray(0, 4000).toString("utf8") };
}

/** 诊断只归属运行任务；事件和输出在采集时限额，不保存源码或资源内容。 */
export class MotionDiagnostics {
  private events: Record<string, unknown>[] = [];
  private stderr = "";
  private lastCheckpoint = 0;
  private firstEvent?: Record<string, unknown>;
  private state: Record<string, unknown> = { stage: "input_validation", currentFrame: null, lastCompletedFrame: null };
  constructor(private identity: Record<string, unknown>, private checkpoint?: (state: Record<string, unknown>) => void) {}
  event(type: string, detail: Record<string, unknown> = {}) {
    const event = { at: new Date().toISOString(), type, detail: boundedDetail(detail) };
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
    if (!this.firstEvent && /error|crash|failed|disconnected/u.test(type) && !(type === "browser_disconnected" && this.state.terminationRequestedBy)) this.firstEvent = event;
  }
  stage(stage: string, detail: Record<string, unknown> = {}) {
    this.state = { ...this.state, stage, ...detail, stageStartedAt: new Date().toISOString() };
    this.event("stage", { stage, ...detail }); this.publish(true);
  }
  frame(frame: number, operation: string) { this.state = { ...this.state, currentFrame: frame, operation }; }
  progress(frame: number) {
    this.state = { ...this.state, lastCompletedFrame: frame, lastProgressAt: new Date().toISOString() }; this.publish(false);
  }
  terminate(reason: string) { this.state.terminationRequestedBy ??= reason; this.event("termination_requested", { reason }); }
  browser(detail: Record<string, unknown>) { Object.assign(this.state, detail); }
  browserStderr(chunk: string) { const bytes = Buffer.from(this.stderr + chunk);
    let start = Math.max(0, bytes.length - 65536);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    this.stderr = bytes.subarray(start).toString("utf8"); }
  additional(error: unknown, context: string) { this.event("additional_error", { context, error: errorDetail(error) }); }
  summary(): Record<string, unknown> { return { ...this.identity, ...this.state }; }
  private publish(force: boolean) {
    if (!force && Date.now() - this.lastCheckpoint < 5000) return;
    this.lastCheckpoint = Date.now();
    try { this.checkpoint?.(this.summary()); } catch (error) { this.additional(error, "checkpoint"); }
  }
  async save(root: string, jobId: string, error: unknown): Promise<Record<string, unknown> & { reportPath: string }> {
    if (!/^job_[A-Za-z0-9-]+$/u.test(jobId)) throw new Error("MOTION_DIAGNOSTIC_JOB_ID_INVALID");
    const directory = join(root, ".videoflowcut-runtime", "diagnostics", "jobs", jobId, randomUUID());
    await mkdir(directory, { recursive: true });
    const report = { ...this.summary(), error: errorDetail(error), firstEvent: this.firstEvent, events: this.events };
    let json = JSON.stringify(report, null, 2);
    while (Buffer.byteLength(json) > 900000 && report.events.length) { report.events.shift(); json = JSON.stringify(report, null, 2); }
    await writeFile(join(directory, "report.json.tmp"), json);
    await rename(join(directory, "report.json.tmp"), join(directory, "report.json"));
    await writeFile(join(directory, "browser.stderr.log"), this.stderr);
    return { ...this.summary(), error: errorDetail(error), reportPath: relative(root, join(directory, "report.json")).replaceAll("\\", "/") };
  }
}
