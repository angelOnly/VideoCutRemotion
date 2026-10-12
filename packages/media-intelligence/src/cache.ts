import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DomainError } from "@videocut/domain";

/** 只清理本模块派生目录；正式素材、历史引用和正在恢复的输入由调用方保护。 */
export async function pruneMediaCache(projectRoot: string, protectedPaths: string[], options: { maxBytes?: number; maxAgeMs?: number; reserveBytes?: number } = {}) {
  const root = await realpath(projectRoot), limit = options.maxBytes ?? 2 * 1024 ** 3;
  const maxAge = options.maxAgeMs ?? 30 * 86400_000, reserve = options.reserveBytes ?? 32 * 1024 ** 2;
  const inside = (parent: string, path: string) => { const rel = relative(parent, path); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };
  const protectedResolved = protectedPaths.map((path) => resolve(root, path));
  const entries: Array<{ path: string; bytes: number; lastUsed: number; protected: boolean }> = [];
  async function scan(directory: string): Promise<{ bytes: number; lastUsed: number }> {
    let bytes = 0, lastUsed = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new DomainError("素材缓存包含符号链接，停止自动清理", "MEDIA_CACHE_PATH_INVALID");
      if (entry.isDirectory()) { const nested = await scan(path); bytes += nested.bytes; lastUsed = Math.max(lastUsed, nested.lastUsed); }
      else { bytes += info.size; lastUsed = Math.max(lastUsed, info.mtimeMs); }
    }
    return { bytes, lastUsed };
  }
  for (const name of ["mi", "media-intelligence"]) {
    const cacheRoot = join(root, "cache", name);
    const info = await lstat(cacheRoot).catch(() => undefined);
    if (!info) continue;
    if (info.isSymbolicLink() || !inside(root, await realpath(cacheRoot))) throw new DomainError("素材缓存路径越界，停止自动清理", "MEDIA_CACHE_PATH_INVALID");
    for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
      const path = join(cacheRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      entries.push({ path, ...await scan(path), protected: protectedResolved.some((protectedPath) => inside(path, protectedPath) || inside(protectedPath, path)) });
    }
  }
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const removed: string[] = [];
  for (const entry of entries.sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (entry.protected || bytes + reserve <= limit && Date.now() - entry.lastUsed < maxAge) continue;
    const actual = await realpath(entry.path);
    if (!inside(root, actual) || actual !== entry.path) throw new DomainError("清理前缓存路径已变化", "MEDIA_CACHE_PATH_INVALID");
    await rm(actual, { recursive: true }); bytes -= entry.bytes; removed.push(relative(root, actual));
  }
  if (bytes + reserve > limit) throw new DomainError("受保护的素材分析缓存已达上限；先完成或取消相关任务，再清理未引用缓存", "MEDIA_CACHE_BUDGET_EXCEEDED");
  return { bytes, removed, limit };
}
