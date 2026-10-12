import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** 只替换内容变化的文件；未改媒体不删除，源中已移除的对象仍准确清理。 */
export async function syncTree(source, target) {
  const root = resolve(target);
  const sourceRoot = resolve(source);
  const overlap = relative(sourceRoot, root);
  if (!overlap || (!overlap.startsWith("..") && !isAbsolute(overlap))) throw new Error("同步目录不能重叠");
  const assertTarget = path => {
    const child = relative(root, resolve(path));
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("同步清理目标超出发行目录");
  };
  const walk = async (from, to) => {
    await mkdir(to, { recursive: true });
    const sources = await readdir(from, { withFileTypes: true });
    const names = new Set(sources.map(entry => entry.name));
    for (const entry of await readdir(to, { withFileTypes: true })) {
      const path = join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error("同步目标不能包含符号链接");
      if (!names.has(entry.name)) { assertTarget(path); await rm(path, { recursive: true, force: true }); }
    }
    for (const entry of sources) {
      if (entry.isSymbolicLink()) throw new Error("技能源不能包含符号链接");
      const fromPath = join(from, entry.name), toPath = join(to, entry.name);
      const existing = await stat(toPath).catch(() => undefined);
      if (existing && existing.isDirectory() !== entry.isDirectory()) { assertTarget(toPath); await rm(toPath, { recursive: true, force: true }); }
      if (entry.isDirectory()) await walk(fromPath, toPath);
      else if (!existing?.isFile() || (await stat(fromPath)).size !== existing.size || await digest(fromPath) !== await digest(toPath)) await copyFile(fromPath, toPath);
    }
  };
  await walk(sourceRoot, root);
}
