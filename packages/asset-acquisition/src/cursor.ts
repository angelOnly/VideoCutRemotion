import { createHash } from "node:crypto";
import { AssetProviderError } from "./errors.js";

type Query = { query: string; mediaType?: string };
const identity = (provider: string, input: Query) => createHash("sha256").update(JSON.stringify([provider, input.query.trim(), input.mediaType ?? null])).digest("hex");
/** 游标只携带页位置，后续请求仍由 Provider 构造，不接受远端下载地址。 */
export function encodeSearchCursor(provider: string, input: Query, position: number): string {
  return Buffer.from(JSON.stringify({ v: 1, identity: identity(provider, input), position })).toString("base64url");
}
export function decodeSearchCursor(provider: string, input: Query & { cursor?: string }): number | undefined {
  if (input.cursor === undefined) return undefined;
  try {
    if (!["wikimedia-commons"].includes(provider) || input.cursor.length > 500) throw new Error();
    const value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
    if (value.v !== 1 || value.identity !== identity(provider, input) || !Number.isSafeInteger(value.position) || value.position < 1 || value.position > 1_000_000) throw new Error();
    return value.position;
  } catch { throw new AssetProviderError("分页游标与服务、查询或媒体类型不匹配，请从新查询第一页开始", "ASSET_CURSOR_INVALID"); }
}
