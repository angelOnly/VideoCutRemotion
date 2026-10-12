import { runSoundComparison } from "./sound-comparison.js";
import { createApplication, type EditingApplication } from "@videocut/application";
import { runOneQueuedJob, type JobProcessor } from "@videocut/job-runtime";
import { readRuntimeConfig } from "@videocut/project-overview";
import type { JobKind } from "@videocut/contracts";
import { RevisionRenderer, runExportJob, runPreviewJob, runRenderPreflightJob, type RevisionRenderEngine } from "./exporter.js";
import { runMotionJob } from "./motion-job.js";

const workspaceRoot = readRuntimeConfig().workspace.root;
let defaultApplication: EditingApplication | undefined;
const getDefaultApplication = () => (defaultApplication ??= createApplication(workspaceRoot));
export const RENDER_JOB_KINDS: JobKind[] = ["preview", "render_preflight", "export", "motion_generation", "sound_comparison"];

export function createRenderJobProcessor(app: EditingApplication, renderer: RevisionRenderEngine = new RevisionRenderer()): JobProcessor {
  return async (job, signal) => {
    if (job.kind === "sound_comparison") return runSoundComparison(app, job, renderer);
    if (job.kind === "motion_generation") return runMotionJob(app, job, undefined, signal);
    if (job.kind === "preview") return runPreviewJob(app, job, renderer);
    if (job.kind === "render_preflight") return runRenderPreflightJob(app, job);
    if (job.kind === "export") return runExportJob(app, job, renderer);
    throw new Error(`任务类型 ${job.kind} 不属于 Render Worker`);
  };
}

export async function runOneRenderJob(
  app: EditingApplication = getDefaultApplication(),
  processor: JobProcessor = createRenderJobProcessor(app),
  signal?: AbortSignal
): Promise<boolean> {
  return runOneQueuedJob(app, RENDER_JOB_KINDS, processor, 5 * 60_000, signal);
}

export async function runRenderWorkerForever(app: EditingApplication = getDefaultApplication(), signal?: AbortSignal, renderer: RevisionRenderEngine = new RevisionRenderer()): Promise<void> {
  let stopping = signal?.aborted ?? false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const processor = createRenderJobProcessor(app, renderer);
    while (!stopping) {
      const worked = await runOneRenderJob(app, processor, signal);
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 750));
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

// 发行 Runtime 以 CommonJS bundle 引入本模块；只让源码 Worker 入口自行启动。
const launchedAsStandaloneRenderWorker = /(?:^|\/)apps\/render-worker\/src\/index\.(?:ts|js)$/u.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (launchedAsStandaloneRenderWorker) {
  runRenderWorkerForever().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
