export interface AssetFailureDetails {
  stage?: "provider" | "search" | "metadata" | "download";
  provider?: string;
  retryAfterMs?: number;
  availableProviders?: string[];
  recovery?: "select_provider" | "configure_provider" | "change_media_type" | "retry_search" | "repair";
}

/** 传递可诊断的原因；不把代理地址、密钥或底层请求全文带到 MCP。 */
export class AssetProviderError extends Error {
  constructor(message: string, public readonly code: string, public readonly details: AssetFailureDetails = {}) {
    super(message);
    this.name = "AssetProviderError";
  }
}
