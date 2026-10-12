import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { syncTree } = createRequire(import.meta.url)("../plugins/videoflowcut/scripts/sync-tree.mjs");

test("差异同步更新内容与删除旧对象，未修改媒体不触碰文件身份", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-skill-sync-"));
  try {
    const source = join(root, "source"), target = join(root, "target");
    await mkdir(source); await writeFile(join(source, "media.mp4"), "固定素材"); await writeFile(join(source, "SKILL.md"), "旧文档");
    await syncTree(source, target);
    const before = await stat(join(target, "media.mp4"));
    await writeFile(join(target, "obsolete.md"), "源已删除"); await writeFile(join(source, "SKILL.md"), "新文档");
    await syncTree(source, target);
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "新文档");
    const after = await stat(join(target, "media.mp4"));
    assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs);
    await assert.rejects(stat(join(target, "obsolete.md")));
    await assert.rejects(syncTree(source, source));
  } finally { await rm(root, { recursive: true, force: true }); }
});
