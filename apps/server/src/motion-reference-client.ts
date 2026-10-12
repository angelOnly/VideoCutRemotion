import { DomainError } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import type { inspectMotionReference } from "./motion-reference.js";

/** 浏览器依赖属于已部署 Runtime；MCP 不再依赖宿主启动时碰巧继承的浏览器环境。 */
export async function inspectMotionReferenceViaRuntime(
  sourceUrl: string,
  previewIndex?: number,
  sampleDurationMs = 6000,
  config = readRuntimeConfig()
): Promise<Awaited<ReturnType<typeof inspectMotionReference>>> {
  const response = await fetch(new URL("/api/motion/inspect-reference", config.http.webOrigin), {
    method: "POST",
    headers: { "content-type": "application/json", "x-videoflowcut-release-id": config.runtime.releaseId },
    body: JSON.stringify({ sourceUrl, previewIndex, sampleDurationMs }),
    redirect: "error",
    signal: AbortSignal.timeout(50_000)
  });
  const value = await response.json();
  if (!response.ok) {
    throw new DomainError(value.message ?? `动效参考审阅失败（HTTP ${response.status}）`, value.error ?? "MOTION_REFERENCE_FAILED");
  }
  // 不能把旧 Runtime、错误页面或空采样包装成已成功审阅。
  if (response.headers.get("x-videoflowcut-release-id") !== config.runtime.releaseId) {
    throw new DomainError("动效参考审阅返回的 Runtime 版本与当前 MCP 不一致", "RUNTIME_RELEASE_MISMATCH");
  }
  if (value.sourceUrl !== sourceUrl || !Array.isArray(value.images) || value.images.length === 0
    || !value.images.every((item: { elapsedMs?: unknown; data?: unknown }) => typeof item?.elapsedMs === "number"
      && Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0 && typeof item.data === "string" && item.data.length > 0)) {
    throw new DomainError("Runtime 未返回有效的动效参考采样", "MOTION_REFERENCE_RESPONSE_INVALID");
  }
  return value;
}
