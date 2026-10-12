import type { MotionDiagnostics } from "./motion-diagnostics.js";
import { spawn } from "node:child_process";

/** 每个媒体阶段按无进展超时保护；作品长不等于卡死，取消必须终止实际进程。 */
export async function runMotionProcess(command: string, args: string[], signal?: AbortSignal, idleTimeoutMs = 120_000, diagnostics?: MotionDiagnostics): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  diagnostics?.event("media_process_start", { command, pid: child.pid });
  let output = "", error = "", timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; diagnostics?.event("media_process_termination", { reason: "idle_timeout", pid: child.pid }); child.kill(); }, idleTimeoutMs); };
  const abort = () => { diagnostics?.event("media_process_termination", { reason: "cancelled", pid: child.pid }); child.kill(); };
  signal?.addEventListener("abort", abort, { once: true });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", error => { diagnostics?.additional(error, "media_process"); reject(error); });
    child.once("close", (code, signal) => { diagnostics?.event("media_process_close", { code, signal, stderr: error, pid: child.pid }); code === 0 ? resolve() : reject(new Error(timedOut ? "MOTION_PROCESS_STALLED" : `MOTION_PROCESS_FAILED: exit=${code} signal=${signal} ${error}`)); });
  });
  child.stdout.on("data", data => { output = (output + String(data)).slice(-64000); touch(); });
  child.stderr.on("data", data => { error = (error + String(data)).slice(-4000); touch(); });
  touch();
  try { if (signal?.aborted) abort(); await done; signal?.throwIfAborted(); return output; }
  catch (error) { signal?.throwIfAborted(); throw error; }
  finally { clearTimeout(timer!); signal?.removeEventListener("abort", abort); child.kill(); }
}
