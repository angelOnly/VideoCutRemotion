import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { pluginRootFromModule, resolveReleaseRuntime, resolveRepoRoot } from "./repo-root.mjs";

const pluginRoot = pluginRootFromModule(import.meta.url);
const repoRoot = resolveRepoRoot({ pluginRoot });
const sourceRoot = join(repoRoot, ".agents", "skills");
const targetRoot = join(pluginRoot, "skills");
const generatedSharedFiles = new Set([
  "_shared/SKILL.md",
  "_shared/agents/openai.yaml"
]);
const runtimeRoot = join(pluginRoot, "runtime", "dist");
const semanticVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const releaseFiles = [
  ["Runtime 入口", join(runtimeRoot, "runtime.cjs")],
  ["渲染线程入口", join(runtimeRoot, "render-thread.cjs")],
  ["MCP 入口", join(runtimeRoot, "mcp.cjs")],
  ["MCP 工具目录", join(runtimeRoot, "mcp-tools.json")],
  ["Remotion 入口", join(runtimeRoot, "remotion", "render-entry.cjs")],
  ["Web 入口", join(runtimeRoot, "web", "index.html")],
  ["发行 manifest", join(runtimeRoot, "manifest.json")]
];

async function listFiles(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(absolute, base);
    return [relative(base, absolute).replace(/\\/g, "/")];
  }));
  return files.flat();
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function requireNonEmptyFile(label, path) {
  const information = await stat(path).catch(() => undefined);
  if (!information?.isFile() || information.size <= 0) {
    throw new Error(`插件发行物缺少或为空：${label}（${path}）`);
  }
}

async function assertNoSourceRuntimeLaunch(path) {
  const contents = await readFile(path, "utf8");
  const forbidden = [
    /tsxCliPath/u,
    /apps[\\/]runtime[\\/]src/iu,
    /apps[\\/]server[\\/]src[\\/]mcp/iu,
    /apps[\\/]render-worker[\\/]src[\\/]render-entry/iu,
    /[\\/]tsx(?:[\\/]|['"])/iu
  ];
  const hit = forbidden.find((pattern) => pattern.test(contents));
  if (hit) throw new Error(`插件运行入口仍含源码或 tsx 启动引用 ${hit}：${path}`);
}

if (!existsSync(targetRoot)) throw new Error("插件 Skills 尚未生成。请先执行 npm run plugin:sync-skills。");
const sourceFiles = await listFiles(sourceRoot);
const targetFiles = (await listFiles(targetRoot)).filter((file) => !generatedSharedFiles.has(file));
if (sourceFiles.sort().join("\n") !== targetFiles.sort().join("\n")) {
  throw new Error("插件 Skills 与根目录 .agents/skills 不一致。请执行 npm run plugin:sync-skills。");
}
for (const file of sourceFiles) {
  const [source, target] = await Promise.all([readFile(join(sourceRoot, file)), readFile(join(targetRoot, file))]);
  if (digest(source) !== digest(target)) throw new Error(`插件 Skills 文件已漂移：${file}`);
}
const generatedSharedSkillPath = join(targetRoot, "_shared", "SKILL.md");
const generatedSharedMetadataPath = join(targetRoot, "_shared", "agents", "openai.yaml");
if (!existsSync(generatedSharedSkillPath)) throw new Error("插件缺少 _shared 校验适配文件。");
const generatedSharedMetadata = await readFile(generatedSharedMetadataPath, "utf8").catch(() => undefined);
const expectedGeneratedSharedMetadata = [
  "interface:",
  "  display_name: \"VideoFlowCut 共享参考资料\"",
  "  short_description: \"仅供 VideoFlowCut Skills 按需引用\"",
  "policy:",
  "  allow_implicit_invocation: false",
  ""
].join("\n");
if (generatedSharedMetadata?.replace(/\r\n/g, "\n") !== expectedGeneratedSharedMetadata) {
  throw new Error("插件 _shared 必须禁止隐式加载。");
}

await Promise.all(releaseFiles.map(([label, path]) => requireNonEmptyFile(label, path)));
const releaseManifest = JSON.parse(await readFile(join(runtimeRoot, "manifest.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
if (manifest.name !== "videoflowcut" || manifest.mcpServers !== "./.mcp.json" || manifest.skills !== "./skills/") {
  throw new Error("插件 manifest 未声明预期的 Skills 或 MCP 入口。");
}
if (!semanticVersionPattern.test(manifest.version ?? "")) {
  throw new Error("插件 manifest 缺少可发布版本。");
}
if (releaseManifest.schemaVersion !== 2 || releaseManifest.format !== "commonjs"
  || releaseManifest.runtimeEntry !== "runtime.cjs" || releaseManifest.mcpEntry !== "mcp.cjs"
  || releaseManifest.remotionEntry !== "remotion/render-entry.cjs" || releaseManifest.webRoot !== "web"
  || releaseManifest.nodeRuntime !== ">=22.5.0" || releaseManifest.pluginVersion !== manifest.version
  || !/^release-[a-f0-9]{64}$/u.test(releaseManifest.releaseId ?? "")) {
  throw new Error("插件发行 Runtime manifest 与启动约定不一致。请重新执行 npm run plugin:build。");
}
// 启动器也会执行这一校验；verify 提前失败让“只改 manifest”的伪发行无法进入部署流程。
resolveReleaseRuntime(pluginRoot);
await Promise.all([
  "repo-root.mjs",
  "runtime-launcher.mjs",
  "mcp-launcher.mjs",
  "candidate-runtime.mjs"
].map((file) => assertNoSourceRuntimeLaunch(join(pluginRoot, "scripts", file))));
await Promise.all(releaseFiles.slice(0, 3).map(([, path]) => assertNoSourceRuntimeLaunch(path)));

const mcp = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8"));
if (mcp.mcpServers?.videoflowcut?.command !== "node" || mcp.mcpServers?.videoflowcut?.args?.[0] !== "./scripts/mcp-launcher.mjs") {
  throw new Error("插件 MCP 必须以 Node 启动发行 Runtime 启动器。");
}
if (mcp.mcpServers?.videoflowcut?.env?.VIDEOFLOWCUT_SFX_ROOTS !== undefined
  && typeof mcp.mcpServers.videoflowcut.env.VIDEOFLOWCUT_SFX_ROOTS !== "string") {
  throw new Error("插件 MCP 的 VIDEOFLOWCUT_SFX_ROOTS 必须是可传递给 Runtime 的字符串路径列表。");
}
console.log(`插件 Skills、发行 Runtime、manifest 与 MCP 入口验证通过：${pluginRoot}`);
