import type { EditingApplication } from "@videocut/application";
import { BridgeError, ComfyUIBridgeClient, type BridgeRunRequest, type BridgeWorkflow } from "@videocut/bridge";
import type { JobRecord } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import { digest } from "../../../packages/media-intelligence/src/index.js";

export type ExternalCheckpoint = { status: "submitting" | "running" | "succeeded" | "failed"; workflowId: string; schemaVersion: string; runId?: string; text?: string; outputSlotId?: string; textOutputs?: Array<{ outputSlotId: string; text: string }>; requestIdentity?: string; attemptJobId?: string; outputRejection?: { jobId: string; reason: string } };

/** 外部 succeeded 只代表推理结束；保留坏原文，让显式重试能取得新响应。 */
export function rejectModelOutput(app: EditingApplication, job: JobRecord, key: string, reason: string): void {
  const checkpoints = (app.trackJob(job.id).result?.externalRuns ?? {}) as Record<string, ExternalCheckpoint>;
  const checkpoint = checkpoints[key];
  if (checkpoint?.status === "succeeded") app.recordJobCheckpoint(job.id, { externalRuns: { ...checkpoints, [key]: { ...checkpoint, outputRejection: { jobId: job.id, reason } } } });
}
export function semanticConfig(job: JobRecord) {
  const current = readRuntimeConfig();
  return (job.payload.modelConfig ?? { ...current.semantic, apiBaseUrl: current.bridge.apiBaseUrl }) as typeof current.semantic & { apiBaseUrl: string };
}
export function restoreModelCheckpoints(app: EditingApplication, job: JobRecord, visited = new Set<string>()): void {
  if (visited.has(job.id) || visited.size >= 100) throw new DomainError("重试链循环或过长", "MEDIA_RETRY_MISMATCH");
  visited.add(job.id);
  // 调用方可能持有提交时的旧 Job；只读实时检查点，不能把当前尝试覆盖回父任务。
  if (!job.payload.retryOfJobId || app.trackJob(job.id).result?.externalRuns) return;
  const parent = app.trackJob(String(job.payload.retryOfJobId));
  const signature = (payload: JobRecord["payload"]) => { const { retryOfJobId, ...identity } = payload; return digest(identity); };
  if (parent.projectId !== job.projectId || parent.kind !== job.kind || signature(parent.payload) !== signature(job.payload)) throw new DomainError("重试来源与分析请求不一致", "MEDIA_RETRY_MISMATCH");
  restoreModelCheckpoints(app, parent, visited);
  app.recordJobCheckpoint(job.id, { externalRuns: app.trackJob(parent.id).result?.externalRuns ?? {} });
}

/** 一次 POST 不确定即保留意图；有 run ID 只继续读取，不重复提交。 */
export async function modelText(app: EditingApplication, job: JobRecord, bridge: ComfyUIBridgeClient, key: string, workflowId: string, build: (schema: BridgeWorkflow) => Promise<BridgeRunRequest>, outputSlotId?: string, requestIdentity?: string) {
  restoreModelCheckpoints(app, job);
  const checkpoints = () => (app.trackJob(job.id).result?.externalRuns ?? {}) as Record<string, ExternalCheckpoint>;
  const save = (checkpoint: ExternalCheckpoint) => app.recordJobCheckpoint(job.id, { externalRuns: { ...checkpoints(), [key]: checkpoint } });
  const checkCancellation = () => { if (app.trackJob(job.id).status === "cancelled") throw new DomainError("分析已取消；停止后续提交，当前外部推理可能仍在运行", "MEDIA_ANALYSIS_CANCELLED"); };
  checkCancellation();
  let checkpoint: ExternalCheckpoint | undefined = checkpoints()[key];
  if (checkpoint && checkpoint.workflowId !== workflowId) throw new DomainError("恢复的工作流与原提交不一致", "MEDIA_RETRY_MISMATCH");
  if (checkpoint?.status === "succeeded" && checkpoint.text !== undefined) {
    const stale = requestIdentity !== undefined && checkpoint.requestIdentity !== requestIdentity;
    if (stale || checkpoint.outputRejection) {
      // 只在新的显式恢复任务里重算已知结束的运行；旧任务与坏输出继续保留。
      if (!job.payload.retryOfJobId || checkpoint.attemptJobId === job.id || checkpoint.outputRejection?.jobId === job.id) throw new DomainError("模型输出无效或观察版本已变化；需要显式恢复或新建分析，不能把旧响应标成新版", "MEDIA_MODEL_OUTPUT_RETRY_REQUIRED");
      checkpoint = undefined;
    } else if (!outputSlotId || checkpoint.outputSlotId === outputSlotId) return checkpoint;
  }
  if (checkpoint?.status === "submitting" && !checkpoint.runId) throw new DomainError("外部提交结果未知，不能重复创建任务", "EXTERNAL_RUN_OUTCOME_UNKNOWN");
  // 只有明确失败的外部任务可在显式重试中重新提交；超时/丢失仍保留原 run ID。
  if (checkpoint?.status === "failed" && job.payload.retryOfJobId) checkpoint = undefined;
  if (!checkpoint?.runId) {
    try {
      const submission = await bridge.createRunWithSchemaRetry(workflowId, async (schema) => {
        checkCancellation();
        const request = await build(schema);
        checkpoint = { status: "submitting", workflowId, schemaVersion: schema.schemaVersion, requestIdentity, attemptJobId: job.id };
        save(checkpoint);
        return request;
      });
      checkpoint = { status: "running", workflowId, schemaVersion: submission.workflow.schemaVersion, runId: submission.run.id, requestIdentity, attemptJobId: job.id };
      save(checkpoint);
    } catch (error) {
      if (checkpoint?.status === "submitting") {
        if (error instanceof BridgeError && (error.code === "BRIDGE_INPUT_UNREADABLE" || error.status && error.status >= 400 && error.status < 500)) save({ ...checkpoint, status: "failed" });
        else throw new DomainError("模型提交已发出但结果未知；保留提交检查点，必须先对账", "EXTERNAL_RUN_OUTCOME_UNKNOWN");
      }
      throw error;
    }
  }
  let run;
  try { run = await bridge.waitForRun(checkpoint.runId!, { timeoutMs: 30 * 60_000, intervalMs: 1000, onUpdate: checkCancellation }); }
  catch (error) {
    if (error instanceof BridgeError && ["BRIDGE_RUN_FAILED", "BRIDGE_RUN_CANCELLED"].includes(error.code ?? "")) save({ ...checkpoint, status: "failed" });
    throw error;
  }
  // FunASR 的全文和对齐 JSON 是不同槽位，不能拼接后交给 JSON 解析器。
  const textOutputs = run.outputs.filter((output) => output.kind === "text" && typeof output.text === "string").map((output) => ({ outputSlotId: output.outputSlotId, text: output.text! }));
  const text = textOutputs.filter((output) => !outputSlotId || output.outputSlotId === outputSlotId).map((output) => output.text).join("\n");
  if (!text) throw new DomainError("模型成功结果缺少文本输出", "MEDIA_MODEL_TEXT_MISSING");
  checkpoint = { ...checkpoint, status: "succeeded", text, outputSlotId, textOutputs };
  save(checkpoint);
  if (requestIdentity !== undefined && checkpoint.requestIdentity !== requestIdentity) throw new DomainError("旧版外部运行已完成并保存；请显式恢复或新建分析以使用当前观察版本", "MEDIA_MODEL_OUTPUT_RETRY_REQUIRED");
  return checkpoint;
}
