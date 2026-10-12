import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { JobRecord } from "@videocut/contracts";

/** 报告只能来自指定Job的诊断目录，拒绝路径跳转、软链接逃逸和巨大文件。 */
export async function readJobDiagnostics(root: string, job: JobRecord) {
  const failure = job.result?.motionFailure as { reportPath?: string } | undefined;
  if (!failure?.reportPath) return { available: false, jobId: job.id, reason: "当前Job没有动画失败报告" };
  if (isAbsolute(failure.reportPath)) throw new Error("JOB_DIAGNOSTIC_PATH_REJECTED");
  const base = await realpath(join(root, ".videoflowcut-runtime", "diagnostics", "jobs", job.id));
  const target = await realpath(resolve(root, failure.reportPath));
  const child = relative(base, target);
  if (!child || isAbsolute(child) || child.startsWith("..")) throw new Error("JOB_DIAGNOSTIC_PATH_REJECTED");
  const info = await stat(target);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("JOB_DIAGNOSTIC_SIZE_REJECTED");
  const report = JSON.parse(await readFile(target, "utf8"));
  if (report.jobId !== job.id) throw new Error("JOB_DIAGNOSTIC_ID_MISMATCH");
  const stderrPath = await realpath(join(target, "..", "browser.stderr.log"));
  const stderrChild = relative(base, stderrPath);
  if (stderrChild.startsWith("..") || isAbsolute(stderrChild) || (await stat(stderrPath)).size > 65536) throw new Error("JOB_DIAGNOSTIC_PATH_REJECTED");
  return { available: true, report, browserStderr: await readFile(stderrPath, "utf8") };
}
