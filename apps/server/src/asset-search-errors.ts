import { AssetProviderError } from "@videocut/acquisition";

/** 只用于素材搜索，不能把写入/下载 Job 的未知结果标为可重放。 */
export function assetSearchErrorResult(error: unknown, beforePersistence: boolean) {
  const details = error instanceof AssetProviderError ? error.details : {};
  const code = error instanceof AssetProviderError ? error.code : (error as { code?: string })?.code ?? "ASSET_SEARCH_FAILED";
  const recovery = details.recovery ?? (code === "YOUTUBE_URL_INVALID" ? "correct_query" : "repair");
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({
    code, message: error instanceof Error ? error.message : "素材搜索失败",
    ...details, recovery, sideEffects: beforePersistence ? "none" : "unknown",
    safeToRetry: beforePersistence && ["select_provider", "change_media_type", "correct_query", "retry_search"].includes(recovery)
  }) }] };
}
