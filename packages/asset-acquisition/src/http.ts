import { EnvHttpProxyAgent } from "undici";
import { AssetProviderError } from "./errors.js";

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const result = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(result) ? Math.max(0, Math.ceil(result)) : undefined;
}

export interface AssetHttpOptions {
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  retries?: number;
  maxRetryWaitMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** 只给素材请求配置代理；不修改全局 fetch，且本地服务始终直连。 */
export function createAssetFetch(options: AssetHttpOptions = {}): typeof fetch {
  const environment = options.environment ?? process.env;
  const dispatcher = options.fetchImpl ? undefined : new EnvHttpProxyAgent({
    httpProxy: environment.http_proxy ?? environment.HTTP_PROXY,
    httpsProxy: environment.https_proxy ?? environment.HTTPS_PROXY,
    noProxy: [environment.no_proxy ?? environment.NO_PROXY, "localhost", ".localhost", "127.0.0.1", "[::1]", "::1"].filter(Boolean).join(",")
  });
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, { ...init, dispatcher } as RequestInit));
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return async (input, init = {}) => {
    const retryCount = (init.method ?? "GET").toUpperCase() === "GET" ? options.retries ?? 1 : 0;
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 20_000), ...(init.signal ? [init.signal] : [])]);
      let response: Response;
      try {
        response = await fetchImpl(input, { ...init, signal });
      } catch (error) {
        if (attempt < retryCount && !init.signal?.aborted) { await sleep(300); continue; }
        const cause = (error as { cause?: { code?: string } })?.cause?.code;
        const timeout = signal.aborted || cause === "UND_ERR_CONNECT_TIMEOUT";
        throw new AssetProviderError(timeout ? "素材网络请求超时，请检查外网与代理连接" : "素材网络连接失败，请检查外网与代理配置", timeout ? "ASSET_NETWORK_TIMEOUT" : "ASSET_NETWORK_FAILED", { recovery: "repair" });
      }
      const waitMs = retryAfterMilliseconds(response.headers.get("retry-after")) ?? 500;
      // 等待要求超过本轮预算时交回调用方，不提前重试撞限流，也不无限占用 MCP。
      if (![429, 502, 503, 504].includes(response.status) || attempt >= retryCount || waitMs > (options.maxRetryWaitMs ?? 3000) || init.signal?.aborted) return response;
      await response.body?.cancel();
      await sleep(waitMs);
    }
  };
}

// 延迟创建连接池，避免仅枚举服务时初始化网络连接。
let queryFetch: typeof fetch | undefined;
let singleAttemptFetch: typeof fetch | undefined;
let downloadFetch: typeof fetch | undefined;
export const assetFetch: typeof fetch = (input, init) => (queryFetch ??= createAssetFetch())(input, init);
// 保留音效来源原有的限流即停约束，只接入代理和超时。
export const assetSingleAttemptFetch: typeof fetch = (input, init) => (singleAttemptFetch ??= createAssetFetch({ retries: 0 }))(input, init);
export const assetDownloadFetch: typeof fetch = (input, init) => (downloadFetch ??= createAssetFetch({ timeoutMs: 120_000, retries: 0 }))(input, init);
