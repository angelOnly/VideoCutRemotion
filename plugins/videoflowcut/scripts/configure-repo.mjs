import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pluginRootFromModule, readOption, resolveRepoRoot } from "./repo-root.mjs";

const pluginRoot = pluginRootFromModule(import.meta.url);
const explicitRoot = readOption(process.argv.slice(2), "--repo-root");
const repoRoot = explicitRoot
  ? resolveRepoRoot({ pluginRoot, explicitRoot })
  : resolveRepoRoot({ pluginRoot, explicitRoot: resolve(pluginRoot, "..", "..") });
const runtimeDirectory = join(pluginRoot, "runtime");
const pointerPath = join(runtimeDirectory, "repo-root.json");
const temporaryPath = `${pointerPath}.tmp-${process.pid}`;

await mkdir(runtimeDirectory, { recursive: true });
await writeFile(temporaryPath, `${JSON.stringify({ schemaVersion: 1, repoRoot }, null, 2)}\n`, "utf8");
await rename(temporaryPath, pointerPath);
console.log(`已写入 VideoFlowCut 仓库定位指针：${pointerPath}`);
