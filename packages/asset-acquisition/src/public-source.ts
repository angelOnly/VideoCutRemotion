import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { EnvHttpProxyAgent, Pool } from "undici";
import { DomainError } from "@videocut/domain";

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0 || a === 100 && b >= 64 && b <= 127);
  }
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:(?:db8|0):/i.test(address) && !/^2002:/i.test(address);
}
export async function publicSourceUrl(raw: string) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new DomainError("来源必须是无凭据的公开 HTTP(S) 页面", "SOURCE_URL_REJECTED");
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new DomainError("来源不能指向本机、私网或保留地址", "SOURCE_URL_REJECTED");
  return { url, address: addresses[0] };
}
/** 直连和代理隧道都固定到已核验 IP；HTTP Host 和 TLS 身份仍使用原站域名。 */
export function publicSourceDispatcher(url: URL, address: { address: string; family: number }, environment = process.env) {
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY;
  const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY;
  for (const proxy of [httpProxy, httpsProxy]) {
    if (proxy && !["http:", "https:"].includes(new URL(proxy).protocol)) throw new DomainError("公开来源只支持 HTTP(S) 代理隧道", "SOURCE_PROXY_UNSUPPORTED");
  }
  const authority = `${address.family === 6 ? `[${address.address}]` : address.address}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  return new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    noProxy: environment.no_proxy ?? environment.NO_PROXY,
    connect: { lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
    } },
    // 代理不能自行再解析目标域名，否则会绕过刚完成的公网地址核验。
    clientFactory: (origin, options) => new Pool(origin, options).compose(dispatch => (request, handler) =>
      dispatch(request.method === "CONNECT" ? { ...request, path: authority } : request, handler))
  });
}

/** 每次重定向重新校验，并把连接固定到已检查的地址，防止 DNS 重绑定。 */
export async function fetchPublicSource(raw: string, maxBytes: number, signal = AbortSignal.timeout(60000), browserHeaders: Record<string, string> = {}): Promise<{ bytes: Buffer; url: string; mime: string; fetchedAt: string }> {
  // 保留浏览器已计算的来源与内容协商信息；不转发 Cookie、授权或连接控制头。
  const headers = new Headers();
  for (const [name, value] of Object.entries(browserHeaders)) {
    if (["user-agent", "accept", "accept-language", "referer"].includes(name.toLowerCase())) headers.set(name, value);
  }
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { url, address } = await publicSourceUrl(raw);
    const agent = publicSourceDispatcher(url, address);
    try {
      const response = await fetch(url, { dispatcher: agent, redirect: "manual", signal, headers } as RequestInit);
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location) throw new DomainError("来源重定向缺少位置", "SOURCE_REDIRECT_INVALID");
        const target = new URL(location, url);
        const referer = headers.get("referer");
        if (referer) {
          const source = new URL(referer);
          // 服务内跟随跳转时仍限制来源泄露；降级不发，跨域只保留源站。
          if (source.protocol === "https:" && target.protocol === "http:") headers.delete("referer");
          else if (source.origin !== target.origin) headers.set("referer", `${source.origin}/`);
        }
        raw = target.href; continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new DomainError(`来源返回 HTTP ${response.status}`, "SOURCE_DOWNLOAD_FAILED"); }
      if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new DomainError("来源文件超过下载预算", "SOURCE_DOWNLOAD_BUDGET"); }
      const chunks: Uint8Array[] = []; let size = 0;
      if (!response.body) throw new DomainError("来源没有正文", "SOURCE_EMPTY");
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) throw new DomainError("来源文件超过下载预算", "SOURCE_DOWNLOAD_BUDGET");
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), url: url.href, mime: response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "", fetchedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const timeout = signal.aborted || (error as { cause?: { code?: string } }).cause?.code === "UND_ERR_CONNECT_TIMEOUT";
      throw new DomainError(timeout ? "公开来源连接超时，请检查外网与代理" : "公开来源连接失败，请检查外网与代理", timeout ? "SOURCE_NETWORK_TIMEOUT" : "SOURCE_NETWORK_FAILED");
    } finally { await agent.close(); }
  }
  throw new DomainError("来源重定向次数超过预算", "SOURCE_REDIRECT_LIMIT");
}
