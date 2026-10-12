import { openAsBlob } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, toNamespacedPath } from "node:path";
import { readRuntimeConfig } from "@videocut/project-overview";

export interface BridgeWorkflowField {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  defaultValue?: unknown;
  options?: Array<{ label: string; value: string }>;
}

export interface BridgeItemSlot {
  id: string;
  label: string;
  kind: "audio" | "video" | "image" | string;
  required: boolean;
}

export interface BridgeOutputSlot {
  id: string;
  label: string;
  kind: string;
}

export interface BridgeWorkflow {
  id: string;
  name: string;
  available: boolean;
  reason?: string | null;
  schemaVersion: string;
  fields: BridgeWorkflowField[];
  itemSlots: BridgeItemSlot[];
  outputs: BridgeOutputSlot[];
}

export interface BridgeOutput {
  outputSlotId: string;
  displayName: string;
  kind: "video" | "image" | "audio" | "file" | "text" | string;
  fileName?: string;
  mime?: string;
  outputId?: string;
  downloadUrl?: string;
  text?: string;
}

/** 仅用于不应被长时生成排队饿死的交互式工作；不会中断已在执行的任务。 */
export type BridgeQueueMode = "foreground";

export interface BridgeHealth {
  status: string;
  protocolVersion?: number;
  workflowCount?: number;
  queueModes?: Array<"normal" | BridgeQueueMode>;
}

export interface BridgeRun {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  queueMode?: "normal" | BridgeQueueMode;
  error?: string | null;
  outputs: BridgeOutput[];
}

export interface BridgeRunRequest {
  fieldValues: Record<string, unknown>;
  queueMode?: BridgeQueueMode;
  files?: Array<{ slot: BridgeItemSlot; path: string; mime?: string }>;
}

export interface BridgeRunSubmission {
  workflow: BridgeWorkflow;
  run: BridgeRun;
  request: BridgeRunRequest;
  schemaRetryCount: number;
}

export class BridgeError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown, public readonly code = "BRIDGE_HTTP_ERROR") {
    super(message);
    this.name = "BridgeError";
  }
}

/**
 * 网络层在尚未拿到 HTTP 响应时会把原因压缩为 fetch failed。单独建模后，
 * Job 才能把“Bridge 未就绪”与已提交 Run 的未知结果、工作流 409 区分开。
 */
export class BridgeUnavailableError extends BridgeError {
  constructor(public readonly endpoint: string, public readonly reason: string, message?: string) {
    super(
      message ?? `无法连接 ComfyUI Bridge（${endpoint}）：${reason}。请确认服务已启动，并检查 /health 是否返回 200。`,
      undefined,
      undefined,
      "BRIDGE_UNAVAILABLE"
    );
    this.name = "BridgeUnavailableError";
  }
}

export class WorkflowUnavailableError extends BridgeError {
  constructor(message: string, status?: number, body?: unknown) {
    super(message, status, body, "WORKFLOW_UNAVAILABLE");
    this.name = "WorkflowUnavailableError";
  }
}

/** ComfyUI 重启后旧 run_id 可能不存在；调用方可据此提示重新提交，而不是误报普通网络错误。 */
export class BridgeRunLostError extends BridgeError {
  constructor(public readonly runId: string, body?: unknown) {
    super(`Bridge Run 已不可查询：${runId}。ComfyUI 可能已重启；本地 Job 保留了请求摘要，可据此重新提交。`, 404, body, "BRIDGE_RUN_LOST");
    this.name = "BridgeRunLostError";
  }
}

const ensureNoTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const DEFAULT_BRIDGE_READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_BRIDGE_READINESS_POLL_INTERVAL_MS = 2_000;

export interface ComfyUIBridgeClientOptions {
  /** 仅在无副作用的 Workflow 读取遇到网络未就绪时使用，绝不重放 Run 创建请求。 */
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
}

function endpointForDiagnostics(endpoint: string): string {
  const parsed = new URL(endpoint);
  // 配置 URL 可能带查询串或凭据；诊断只需要服务和路径，不能把它们写入 Job 错误。
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

function transportFailureReason(error: unknown): string {
  // fetch failed 会隐藏服务未启动的原因；只提取已知错误码，不输出 cause 中的凭据或请求。
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause) {
    if (cause.code === "ECONNREFUSED") return "ECONNREFUSED：连接被拒绝，请检查目标端口是否有 ComfyUI 服务监听";
    if (cause.code === "ENOTFOUND") return "ENOTFOUND：无法解析 ComfyUI 服务主机名，请检查 Bridge 地址";
    if (cause.code === "ETIMEDOUT" || cause.code === "UND_ERR_CONNECT_TIMEOUT") return "连接 ComfyUI 服务超时，请检查服务和网络";
  }
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError
    || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Bridge 返回的 downloadUrl 相对于 ComfyUI 服务根地址，而不是 API 根路径。
 * 因此即使调用方把 Bridge API 配在带前缀的反向代理路径下，下载也不能重复拼接该前缀。
 */
function serverOriginFromApiBase(apiBaseUrl: string): string {
  try {
    const parsed = new URL(apiBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    return parsed.origin;
  } catch {
    throw new BridgeError("COMFYUI_BRIDGE_URL 必须是完整的 HTTP(S) 地址", undefined, apiBaseUrl, "BRIDGE_API_URL_INVALID");
  }
}

/** Bridge 合同只允许服务根相对路径；拒绝被输出元数据引导到其他主机。 */
function resolveSameOriginDownloadUrl(downloadUrl: string, serverBaseUrl: string): string {
  if (!downloadUrl.startsWith("/") || downloadUrl.startsWith("//")) {
    throw new BridgeError("Bridge 输出的 downloadUrl 必须是以单个 / 开头的同源路径", undefined, downloadUrl, "UNSAFE_OUTPUT_DOWNLOAD_URL");
  }
  try {
    const resolved = new URL(downloadUrl, serverBaseUrl);
    if (resolved.origin !== serverBaseUrl) {
      throw new BridgeError("Bridge 输出的 downloadUrl 指向了其他服务", undefined, downloadUrl, "UNSAFE_OUTPUT_DOWNLOAD_URL");
    }
    return resolved.toString();
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("Bridge 输出的 downloadUrl 无法解析为同源路径", undefined, downloadUrl, "UNSAFE_OUTPUT_DOWNLOAD_URL");
  }
}

/**
 * 所有外部工作流共享这个客户端。每次提交都重新读取 Workflow 详情，
 * 因此不会把 schemaVersion、field ID 或 itemSlot ID 写死为长期合同。
 */
export class ComfyUIBridgeClient {
  readonly apiBaseUrl: string;
  readonly serverBaseUrl: string;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollIntervalMs: number;

  constructor(apiBaseUrl = readRuntimeConfig().bridge.apiBaseUrl, options: ComfyUIBridgeClientOptions = {}) {
    this.apiBaseUrl = ensureNoTrailingSlash(apiBaseUrl);
    this.serverBaseUrl = serverOriginFromApiBase(this.apiBaseUrl);
    this.readinessTimeoutMs = Math.max(0, options.readinessTimeoutMs ?? DEFAULT_BRIDGE_READINESS_TIMEOUT_MS);
    this.readinessPollIntervalMs = Math.max(1, options.readinessPollIntervalMs ?? DEFAULT_BRIDGE_READINESS_POLL_INTERVAL_MS);
  }

  async health(): Promise<BridgeHealth> {
    return this.requestJson<BridgeHealth>("/health");
  }

  /**
   * 前置队列必须由 Bridge 明确声明支持，避免客户端误以为已隔离、实际仍被长任务饿死。
   */
  async requireQueueMode(queueMode: BridgeQueueMode): Promise<void> {
    const health = await this.health();
    if (health.status !== "ready" || !health.queueModes?.includes(queueMode)) {
      throw new BridgeError(
        `当前 ComfyUI Bridge 未声明支持 ${queueMode} 队列；不会提交可能再次被长任务饿死的工作。`,
        undefined,
        health,
        "BRIDGE_QUEUE_MODE_UNSUPPORTED"
      );
    }
  }

  async listWorkflows(): Promise<{ workflows: BridgeWorkflow[] }> {
    return this.requestJson("/workflows");
  }

  async getWorkflow(workflowId: string): Promise<BridgeWorkflow> {
    const path = `/workflows/${encodeURIComponent(workflowId)}`;
    let workflow: BridgeWorkflow;
    try {
      workflow = await this.requestJson<BridgeWorkflow>(path);
    } catch (error) {
      // 读取 Schema 不会产生 Provider 副作用；因此 Bridge 刚重启时可以等待其健康，
      // 但 createRun 网络失败一律原样抛出，避免误以为未提交而重复生成。
      if (!(error instanceof BridgeUnavailableError)) throw error;
      await this.waitForBridgeReadiness(error);
      workflow = await this.requestJson<BridgeWorkflow>(path);
    }
    if (!workflow.available) {
      throw new WorkflowUnavailableError(`工作流不可用：${workflow.reason ?? workflow.name}`, 409, workflow);
    }
    return workflow;
  }

  async getRun(runId: string): Promise<BridgeRun> {
    try {
      return await this.requestJson<BridgeRun>(`/runs/${encodeURIComponent(runId)}`);
    } catch (error) {
      if (error instanceof BridgeError && error.status === 404) throw new BridgeRunLostError(runId, error.body);
      throw error;
    }
  }

  async createRun(input: BridgeRunRequest & { workflow: BridgeWorkflow }): Promise<BridgeRun> {
    const path = `/workflows/${encodeURIComponent(input.workflow.id)}/runs`;
    const request = {
      schemaVersion: input.workflow.schemaVersion,
      fieldValues: input.fieldValues,
      ...(input.queueMode ? { queueMode: input.queueMode } : {})
    };
    if (!input.files?.length) {
      return this.requestJson<BridgeRun>(path, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(request)
      });
    }
    const form = new FormData();
    form.set("request", JSON.stringify(request));
    for (const file of input.files) {
      // openAsBlob 让 Undici 从磁盘按需读取 multipart 内容，避免把长视频/音频完整复制到 Node 堆。
      let blob: Blob;
      try { blob = await openAsBlob(toNamespacedPath(file.path), { type: file.mime ?? "application/octet-stream" }); }
      catch (error) { throw new BridgeError(`上传前无法读取本地文件：${error instanceof Error ? error.message : String(error)}`, undefined, undefined, "BRIDGE_INPUT_UNREADABLE"); }
      form.set(`file_${file.slot.id}`, blob, basename(file.path));
    }
    return this.requestJson<BridgeRun>(path, { method: "POST", body: form });
  }

  async createRunWithSchemaRetry(
    workflowId: string,
    buildRequest: (workflow: BridgeWorkflow) => Promise<BridgeRunRequest>
  ): Promise<BridgeRunSubmission> {
    let workflow = await this.getWorkflow(workflowId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const request = await buildRequest(workflow);
        const run = await this.createRun({ workflow, ...request });
        return { workflow, run, request, schemaRetryCount: attempt };
      } catch (error) {
        if (!(error instanceof BridgeError) || error.status !== 409 || attempt === 1) throw error;
        workflow = await this.getWorkflow(workflowId);
      }
    }
    throw new BridgeError("无法创建 Bridge 任务");
  }

  async waitForRun(runId: string, options?: { timeoutMs?: number; intervalMs?: number; onUpdate?: (run: BridgeRun) => void }): Promise<BridgeRun> {
    const timeoutMs = options?.timeoutMs ?? 30 * 60_000;
    const intervalMs = options?.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await this.getRun(runId);
      options?.onUpdate?.(run);
      if (run.status === "succeeded") return run;
      if (run.status === "failed") throw new BridgeError(`Bridge 任务失败：${run.error ?? "未知错误"}`, undefined, run, "BRIDGE_RUN_FAILED");
      if (String(run.status) === "canceled" || String(run.status) === "cancelled") throw new BridgeError("Bridge 任务已取消", undefined, run, "BRIDGE_RUN_CANCELLED");
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new BridgeError(`等待 Bridge 任务超时：${runId}`, undefined, undefined, "BRIDGE_RUN_TIMEOUT");
  }

  async downloadOutput(output: BridgeOutput, targetPath: string): Promise<void> {
    if (!output.downloadUrl) throw new BridgeError("输出缺少 downloadUrl", undefined, output, "MISSING_DOWNLOAD_URL");
    const url = resolveSameOriginDownloadUrl(output.downloadUrl, this.serverBaseUrl);
    // 输出端点不应将本地 Worker 重定向到其他网络位置。
    let response: Response;
    try {
      response = await fetch(url, { redirect: "error" });
    } catch (error) {
      if (isTransportFailure(error)) throw this.unavailableError(url, error);
      throw error;
    }
    if (!response.ok) throw new BridgeError(`下载输出失败：HTTP ${response.status}`, response.status, undefined, "OUTPUT_DOWNLOAD_FAILED");
    await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
  }

  findRequiredSlot(workflow: BridgeWorkflow, kind: BridgeItemSlot["kind"], labelIncludes?: string): BridgeItemSlot {
    const matching = workflow.itemSlots.filter((slot) => slot.kind === kind && (!labelIncludes || slot.label.toLowerCase().includes(labelIncludes.toLowerCase())));
    const slot = matching.find((candidate) => candidate.required) ?? matching[0];
    if (!slot) throw new BridgeError(`工作流 ${workflow.name} 没有可用的 ${kind} 输入槽位`);
    return slot;
  }

  findTextField(workflow: BridgeWorkflow): BridgeWorkflowField {
    const field = workflow.fields.find((candidate) => candidate.kind === "text" || candidate.label.toLowerCase().includes("text"));
    if (!field) throw new BridgeError(`工作流 ${workflow.name} 没有可用的文本字段`);
    return field;
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const endpoint = `${this.apiBaseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(endpoint, init);
    } catch (error) {
      if (isTransportFailure(error)) throw this.unavailableError(endpoint, error);
      throw error;
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json().catch(() => undefined) : await response.text().catch(() => undefined);
    if (!response.ok) {
      const detail = typeof body === "object" && body && "error" in body ? String((body as { error?: unknown }).error) : undefined;
      throw new BridgeError(`Bridge 请求失败：HTTP ${response.status}${detail ? `，${detail}` : ""}`, response.status, body, "BRIDGE_HTTP_ERROR");
    }
    return body as T;
  }

  private unavailableError(endpoint: string, error: unknown): BridgeUnavailableError {
    return new BridgeUnavailableError(endpointForDiagnostics(endpoint), transportFailureReason(error));
  }

  private async waitForBridgeReadiness(initialError: BridgeUnavailableError): Promise<void> {
    if (this.readinessTimeoutMs === 0) throw initialError;
    const deadline = Date.now() + this.readinessTimeoutMs;
    let latestError = initialError;
    while (Date.now() < deadline) {
      await sleep(Math.min(this.readinessPollIntervalMs, Math.max(1, deadline - Date.now())));
      try {
        await this.health();
        return;
      } catch (error) {
        if (!(error instanceof BridgeUnavailableError)) throw error;
        latestError = error;
      }
    }
    throw new BridgeUnavailableError(
      latestError.endpoint,
      latestError.reason,
      `ComfyUI Bridge 在 ${Math.ceil(this.readinessTimeoutMs / 1_000)} 秒内仍未就绪（${latestError.endpoint}）：${latestError.reason}。请确认服务已启动，并检查 /health。`
    );
  }
}

export const FUNASR_WORKFLOW_ID = "dd564543-d02d-4247-9e97-089417db9e7a";
/**
 * 正式原声字幕工作流：返回 Provider 已分好的字幕段及其同源时间证据。
 * 正常 VideoFlowCut 路径只消费 segment 的 displayText/startMs/endMs。
 */
export const FUNASR_SOURCE_CAPTION_WORKFLOW_ID = "funasr-source-caption-v4";
export const OMNIVOICE_WORKFLOW_ID = "ba6238d0-3ee4-41d5-a1f4-a2aefc3933ce";
