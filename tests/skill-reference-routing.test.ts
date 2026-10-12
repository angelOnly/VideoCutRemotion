import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";

const root = resolve(".agents/skills"), mirror = resolve("plugins/videoflowcut/skills");
const examples = "narration-writing/references/examples";
const ids = ["light-humor", "warm-company", "curiosity", "clear-punchy", "playful-objects", "immersive"];
const read = (path: string) => readFile(join(root, path), "utf8");
const links = (body: string) => [...body.replace(/```[\s\S]*?```/g, "").matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]!.split("#")[0]!).filter(p => p && !/^[a-z]+:/i.test(p));
async function walk(path: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    const next = join(path, item.name);
    if (item.isDirectory()) found.push(...await walk(next)); else found.push(next);
  }
  return found;
}

test("维护源本地链接可达，源与发行文件集合及字节一致", async () => {
  const files = await walk(root);
  const expected = new Set(files.map(p => relative(root, p).replaceAll("\\", "/")));
  for (const path of files) {
    const bytes = await readFile(path);
    assert.deepEqual(await readFile(join(mirror, relative(root, path))), bytes, path);
    if (path.endsWith(".md")) for (const link of links(bytes.toString("utf8"))) await access(resolve(dirname(path), decodeURIComponent(link)));
  }
  const actual = (await walk(mirror)).map(p => relative(mirror, p).replaceAll("\\", "/")).filter(p => !["_shared/SKILL.md", "_shared/agents/openai.yaml"].includes(p));
  assert.deepEqual(new Set(actual), expected);
});

test("六篇示范是独立参考，索引可达且通用入口没有内联示范正文", async () => {
  assert.deepEqual((await readdir(join(root, examples))).sort(), ["README.md", ...ids.map(id => `${id}.md`)].sort());
  const index = await read(`${examples}/README.md`);
  assert.deepEqual(links(index).sort(), ids.map(id => `${id}.md`).sort());
  const passages: string[] = [];
  for (const id of ids) {
    const body = await read(`${examples}/${id}.md`);
    assert.doesNotMatch(body, /^---\s*\n/);
    const passage = body.split("\n").find(line => line.startsWith("> "));
    assert.ok(passage, id); passages.push(passage);
    assert.match(body, /^\[[A-Z]+\d\]: https:\/\//m);
  }
  // 只证明文件和路由边界；是否实际按需读取另由隔离作者任务观察。
  const commonFiles = (await walk(root)).filter(p => p.endsWith(".md") && !p.includes(`${join("references", "examples")}`));
  for (const path of commonFiles) {
    const body = await readFile(path, "utf8");
    for (const passage of passages) assert.ok(!body.includes(passage), path);
    assert.ok(!links(body).some(link => ids.some(id => link.endsWith(`/examples/${id}.md`))), path);
  }
  const narration = links(await read("narration-writing/SKILL.md"));
  assert.ok(narration.includes("references/writing-methods.md"));
  assert.ok(narration.includes("references/expression-patterns.md"));
  assert.ok(narration.includes("references/examples/README.md"));
  const art = links(await read("visual-treatment-planning/SKILL.md"));
  assert.ok(art.includes("references/art-directions.md"));
  assert.ok(!art.some(p => p.includes("narration-writing")));
  for (const entry of ["visual-asset-sourcing/SKILL.md", "motion-brief-writing/SKILL.md"]) assert.ok(!links(await read(entry)).some(p => p.includes("/examples/")));
  for (const [file, prefix] of [["narration-writing/references/expression-patterns.md", "narration"], ["visual-treatment-planning/references/art-directions.md", "art"]]) {
    const body = await read(file!);
    for (const id of ids) assert.ok(body.includes(`id="${prefix}-${id}"`));
  }
});
