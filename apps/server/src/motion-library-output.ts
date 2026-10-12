import type { JobRecord } from "@videocut/contracts";

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const pick = (value: unknown, fields: readonly string[]): Data => {
  const source = object(value);
  return Object.fromEntries(fields.filter(field => source[field] !== undefined).map(field => [field, source[field]]));
};
const list = (value: unknown, project: (entry: unknown) => Data) => Array.isArray(value) ? value.map(project) : undefined;
const relationFields = ["categories", "actions", "entry", "exit", "holds", "anchors"];
const connection = (value: unknown) => pick(value, ["from", "to", "left_end", "right_start", "shared_states", "shared_anchors", "next_holds", "checks", "gap", "continuous_verified"]);

/** 搜索卡只交付可判断的动作关系和读取入口；完整检索正文仍留在索引与任务记录。 */
function mechanismCard(value: unknown): Data {
  const source = object(value);
  return {
    ...pick(source, ["id", "title", "case_number", "summary", "purpose", "relation", "start_state", "end_state", "tags", "document", "storyboard", "case_slug", "overview", "detail", "score", "match_reasons"]),
    ...(source.retrieval ? { retrieval: pick(source.retrieval, relationFields) } : {}),
    ...(source.clip ? { clip: pick(source.clip, ["path", "start_ms", "end_ms", "source_sha256", "sha256", "bytes", "boundary_note"]) } : {}),
    ...(source.difference ? { difference: pick(source.difference, ["source_relation", "candidate_relation", "added_actions", "absent_actions"]) } : {}),
    ...(source.connection ? { connection: connection(source.connection) } : {})
  };
}

const diagnostic = (value: unknown) => pick(value, ["code", "message"]);
const recovery = (value: unknown) => {
  const source = object(value);
  return {
    ...pick(source, ["action", "tool", "project_id", "job_id", "message"]),
    ...(source.runs ? { runs: list(source.runs, entry => pick(entry, ["runId", "status", "workflowId", "schemaVersion", "attemptJobId"])) } : {})
  };
};

export function projectMotionSearchResult(value: unknown): Data {
  const source = object(value), diagnostics = object(source.diagnostics);
  return {
    ...pick(source, ["scope", "source_sha256", "library_count", "notice", "stage", "total", "offset", "next_offset", "exhausted", "warnings", "comparison"]),
    ...(source.cards ? { cards: list(source.cards, mechanismCard) } : {}),
    ...(source.groups ? { groups: list(source.groups, projectMotionSearchResult) } : {}),
    ...(source.connections ? { connections: list(source.connections, connection) } : {}),
    ...(source.selection ? { selection: pick(source.selection, ["v", "source_sha256", "ids", "adopted", "unknown_ids", "stale"]) } : {}),
    ...(source.taxonomy ? { taxonomy: pick(source.taxonomy, ["categories", "actions", "states", "holds", "anchors"]) } : {}),
    ...(source.diagnostics ? { diagnostics: {
      ...pick(diagnostics, ["mode", "semantic_used", "source_sha256", "job_id", "status", "reason"]),
      ...(diagnostics.failure ? { failure: diagnostic(diagnostics.failure) } : {}),
      ...(diagnostics.recovery ? { recovery: recovery(diagnostics.recovery) } : {})
    } } : {})
  };
}

export function projectMotionMechanismResult(value: unknown): Data {
  const source = object(value);
  return {
    ...pick(source, ["source_sha256", "part", "document", "body", "preview_url", "video_path", "observation"]),
    card: mechanismCard(source.card)
  };
}

function projectMotionAnalysisResult(value: unknown): Data {
  const source = object(value), input = object(source.input);
  return {
    ...pick(source, ["id", "source_sha256", "source_hash", "description", "model", "schema", "run_id"]),
    ...(source.range ? { range: pick(source.range, ["startMs", "endMs"]) } : {}),
    ...(source.sampling ? { sampling: pick(source.sampling, ["model_frame_density", "limitation"]) } : {}),
    ...(source.input ? { input: {
      mapping: pick(input.mapping, ["parentSourceId", "parentHash", "offsetMs", "rate", "coordinateSpace", "preprocessing"]),
      streams: list(input.streams, entry => pick(entry, ["nb_read_frames", "avg_frame_rate"]))
    } } : {})
  };
}

/** 失败只暴露对账所需的运行身份，不回传向量、模型请求或历次成功正文。 */
export function motionJobRecovery(job: JobRecord): Data | undefined {
  if (!["failed", "unknown", "cancelled"].includes(job.status)) return undefined;
  const runs = Object.values(object(job.result?.externalRuns)).filter(entry => object(entry).status !== "succeeded")
    .map(entry => pick(entry, ["runId", "status", "workflowId", "schemaVersion", "attemptJobId"]));
  const code = object(job.result?.diagnostic).code;
  if (job.status === "unknown" || code === "EXTERNAL_RUN_OUTCOME_UNKNOWN") return {
    action: "reconcile", job_id: job.id, project_id: job.projectId, runs,
    message: "外部提交结果未知，先核对原 Job 与已知 Run；不能换幂等键或重新提交。"
  };
  if (code === "MOTION_LIBRARY_STALE") return {
    action: "refresh_search", tool: "search_motion_mechanisms", job_id: job.id, project_id: job.projectId,
    message: "机制来源已变化，重新查询当前来源并核读采用项，不重试过期请求。"
  };
  return {
    action: "retry", tool: "retry_media_job", job_id: job.id, project_id: job.projectId, runs,
    message: "根据失败原因恢复服务或修正条件后，显式恢复原 Job；已知 Run 沿检查点继续，不自动重放。"
  };
}

/** 只收窄已确认的机制任务链；其余工具继续使用现有合同，后台记录不变。 */
export function projectMotionJob(job: JobRecord): JobRecord | Data {
  if (!["motion_library_search", "motion_reference_analysis"].includes(job.kind)) return job;
  const result = object(job.result), next = motionJobRecovery(job);
  return {
    ...pick(job, ["id", "projectId", "kind", "status", "error", "attempt", "createdAt", "updatedAt"]),
    source_sha256: job.payload.source_sha256,
    ...(job.payload.retryOfJobId ? { retryOfJobId: job.payload.retryOfJobId } : {}),
    ...(job.kind === "motion_reference_analysis" ? { mechanism_id: job.payload.id, range: pick(job.payload.range, ["startMs", "endMs"]) } : {}),
    ...(job.result ? { result: {
      ...(job.kind === "motion_library_search" ? projectMotionSearchResult(result) : projectMotionAnalysisResult(result)),
      ...(result.motionIndex ? { motionIndex: pick(result.motionIndex, ["completed", "total", "source_sha256"]) } : {}),
      ...(result.diagnostic ? { diagnostic: diagnostic(result.diagnostic) } : {})
    } } : {}),
    ...(next ? { recovery: next } : {})
  };
}
