import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { pluginRootFromModule, resolveRepoRoot } from "./repo-root.mjs";
import { buildMcpCatalog } from "./build-mcp-catalog.mjs";

const pluginRoot = pluginRootFromModule(import.meta.url);
const repoRoot = resolveRepoRoot({ pluginRoot });
const runtimeRoot = join(pluginRoot, "runtime");
const distRoot = join(runtimeRoot, "dist");
const webSourceRoot = join(repoRoot, "apps", "web", "dist");
const semanticVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/**
 * 发行入口只打包本仓库的 TypeScript 与 JSX；第三方包仍由宿主仓库的 node_modules
 * 提供。启动器会给 CommonJS 入口设置 NODE_PATH，因此插件缓存无需复制一棵
 * 不可控、体积很大的 node_modules，也不再依赖 tsx 或 apps/*.ts 源文件。
 */
const aliases = {
  "@videocut/contracts": join(repoRoot, "packages", "contracts", "src", "index.ts"),
  "@videocut/domain": join(repoRoot, "packages", "edit-domain", "src", "index.ts"),
  "@videocut/application": join(repoRoot, "packages", "edit-application", "src", "index.ts"),
  "@videocut/acquisition": join(repoRoot, "packages", "asset-acquisition", "src", "index.ts"),
  "@videocut/bridge": join(repoRoot, "packages", "comfyui-bridge-client", "src", "index.ts"),
  "@videocut/speech": join(repoRoot, "packages", "speech-services", "src", "index.ts"),
  "@videocut/quality": join(repoRoot, "packages", "quality-system", "src", "index.ts"),
  "@videocut/job-runtime": join(repoRoot, "packages", "job-runtime", "src", "index.ts"),
  "@videocut/remotion": join(repoRoot, "packages", "remotion-runtime", "src", "index.tsx"),
  "@videocut/project-overview": join(repoRoot, "packages", "project-overview", "src", "index.ts")
};

const outputPaths = {
  runtime: join(distRoot, "runtime.cjs"),
  renderThread: join(distRoot, "render-thread.cjs"),
  mcp: join(distRoot, "mcp.cjs"),
  remotion: join(distRoot, "remotion", "render-entry.cjs"),
  web: join(distRoot, "web"),
  manifest: join(distRoot, "manifest.json")
};

const buildOptions = {
  absWorkingDir: repoRoot,
  bundle: true,
  format: "cjs",
  platform: "node",
  // 项目存储层使用 node:sqlite；该内置模块从 Node 22.5 起可用。
  target: "node22",
  packages: "external",
  alias: aliases,
  legalComments: "none",
  minifyWhitespace: true,
  // 发行堆栈映射回源码位置，不把完整源码写入发行映射。
  sourcemap: "linked",
  sourcesContent: false,
  logLevel: "warning",
  banner: {
    js: "/* 此文件由 npm run plugin:build 自动生成；请修改源码与 build-runtime.mjs。 */"
  }
};

function assertUnder(root, candidate) {
  const relativePath = relative(root, candidate);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`发行构建目标不在插件 runtime 目录内：${candidate}`);
  }
}

async function requireNonEmpty(path, label) {
  const information = await stat(path).catch(() => undefined);
  if (!information?.isFile() || information.size <= 0) {
    throw new Error(`${label} 未生成或为空：${path}`);
  }
}

/** Vite 压缩产物偶尔保留行尾空格；发行文件统一清理，避免提交校验被生成噪声阻断。 */
async function trimReleaseTextWhitespace(root) {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return trimReleaseTextWhitespace(path);
    if (!/\.(?:css|html|js)$/iu.test(entry.name)) return undefined;
    const contents = await readFile(path, "utf8");
    const normalized = contents.replace(/\r+\n|\r/gu, "\n").replace(/[\t ]+(?=\n)/gu, "");
    if (normalized !== contents) await writeFile(path, normalized, "utf8");
    return undefined;
  }));
}

/** 发行哈希按固定 LF 文本计算，避免不同系统的构建换行改变身份。 */
async function normalizeReleaseText(root) {
  for (const path of await releaseFiles(root)) {
    if (!/\.(?:cjs|js|css|html|json|py)$/iu.test(path)) continue;
    const contents = await readFile(path, "utf8");
    const normalized = contents.replace(/\r+\n|\r/gu, "\n");
    if (normalized !== contents) await writeFile(path, normalized, "utf8");
  }
}

async function assertReleaseEntry(path) {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path, "utf8");
  const forbidden = [
    /apps[\\/]runtime[\\/]src/iu,
    /apps[\\/]server[\\/]src[\\/]mcp/iu,
    /apps[\\/]render-worker[\\/]src[\\/]render-entry/iu,
    /[\\/]tsx(?:[\\/]|['"])/iu
  ];
  const hit = forbidden.find((pattern) => pattern.test(source));
  if (hit) throw new Error(`发行入口仍包含源码启动引用 ${hit}：${path}`);
}

/**
 * Release ID 只由本次实际执行的 Runtime、MCP、Remotion 与 Web 产物计算。
 * manifest 自身不参与哈希，避免“把 ID 写进 manifest 后又改变自己的输入”的循环。
 */
async function releaseFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return releaseFiles(root, path);
    return [path];
  }));
  return files.flat().sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

async function createReleaseId(root, pluginVersion) {
  const hash = createHash("sha256");
  // 插件版本也是正式发行身份的一部分；仅改 manifest 版本不能复用旧 Release ID。
  hash.update("plugin-version");
  hash.update("\u0000");
  hash.update(pluginVersion);
  hash.update("\u0000");
  for (const path of await releaseFiles(root)) {
    const pathInRelease = relative(root, path).replace(/\\/gu, "/");
    hash.update(pathInRelease);
    hash.update("\u0000");
    hash.update(await readFile(path));
    hash.update("\u0000");
  }
  return `release-${hash.digest("hex")}`;
}

async function main() {
  if (!existsSync(webSourceRoot)) {
    throw new Error(`找不到 Web 构建产物：${webSourceRoot}。请先执行 npm run build:web。`);
  }
  assertUnder(runtimeRoot, distRoot);
  const pluginManifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  if (pluginManifest?.name !== "videoflowcut" || !semanticVersionPattern.test(pluginManifest?.version ?? "")) {
    throw new Error("插件 manifest 缺少可发布版本；请先更新 plugins/videoflowcut/.codex-plugin/plugin.json。");
  }
  const pluginVersion = pluginManifest.version;
  // dist 是唯一允许整目录覆盖的生成目标；repo-root.json 和用户数据不会触及。
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(dirname(outputPaths.remotion), { recursive: true });

  await Promise.all([
    build({
      ...buildOptions,
      entryPoints: [join(repoRoot, "apps", "runtime", "src", "index.ts")],
      outfile: outputPaths.runtime
    }),
    build({
      ...buildOptions,
      entryPoints: [join(repoRoot, "apps", "server", "src", "mcp.ts")],
      outfile: outputPaths.mcp
    }),
    build({
      ...buildOptions,
      entryPoints: [join(repoRoot, "apps", "render-worker", "src", "render-thread.ts")],
      outfile: outputPaths.renderThread
    }),
    build({
      ...buildOptions,
      entryPoints: [join(repoRoot, "apps", "render-worker", "src", "render-entry.tsx")],
      outfile: outputPaths.remotion
    })
  ]);
  await cp(webSourceRoot, outputPaths.web, { recursive: true, force: true });
  // 下载器版本约束随发行物固定，部署时在独立环境安装，不在线自更新。
  await cp(join(pluginRoot, "requirements-youtube.txt"), join(distRoot, "requirements-youtube.txt"));
  // 字体文件、固定目录和许可证一起发行并参与Release ID；生成时不下载字体。
  const fontRoot = join(repoRoot, "packages", "motion-work", "fonts");
  const fonts = JSON.parse(await readFile(join(fontRoot, "catalog.json"), "utf8"));
  for (const font of fonts.fonts) {
    if (!/^[A-Za-z0-9_-]+\.(?:otf|ttf)$/u.test(font.file)) throw new Error("字体目录中的文件名无效");
    if (font.licenseFile && !/^[A-Za-z0-9_-]+\.txt$/u.test(font.licenseFile)) throw new Error("字体许可证文件名无效");
    if (createHash("sha256").update(await readFile(join(fontRoot, font.file))).digest("hex") !== font.sha256) throw new Error(`发行字体校验失败：${font.id}`);
  }
  await mkdir(join(distRoot, "fonts"), { recursive: true });
  for (const name of new Set(["catalog.json", "OFL.txt", "OFL-Serif.txt", "NOTICE-RequestedFonts.txt",
    ...fonts.fonts.flatMap(font => [font.file, ...(font.licenseFile ? [font.licenseFile] : [])])])) await cp(join(fontRoot, name), join(distRoot, "fonts", name));
  await trimReleaseTextWhitespace(outputPaths.web);
  // 外部语义节点也纳入发行身份，候选验证和部署使用同一份受管产物。
  const semanticRoot = join(distRoot, "comfyui-semantic");
  await mkdir(semanticRoot, { recursive: true });
  for (const name of ["local_semantic_nodes.py", "minicpmo_worker.py"]) {
    await cp(join(repoRoot, "integrations", "comfyui-semantic", name), join(semanticRoot, name));
  }
  // Provider 修正版随 Runtime 发行并参与 Release ID，不能在生产环境手改 site-packages。
  execFileSync("python", [join(pluginRoot, "scripts", "build-funasr-provider.py")], { stdio: "inherit" });
  await Promise.all([
    requireNonEmpty(outputPaths.runtime, "Runtime 入口"),
    requireNonEmpty(outputPaths.renderThread, "渲染线程入口"),
    requireNonEmpty(outputPaths.mcp, "MCP 入口"),
    requireNonEmpty(outputPaths.remotion, "Remotion 入口"),
    requireNonEmpty(join(outputPaths.web, "index.html"), "Web 入口")
  ]);
  await Promise.all([
    assertReleaseEntry(outputPaths.runtime),
    assertReleaseEntry(outputPaths.renderThread),
    assertReleaseEntry(outputPaths.mcp),
    assertReleaseEntry(outputPaths.remotion)
  ]);
  const toolCount = await buildMcpCatalog({ repoRoot, distRoot });
  console.log(`已从发行 MCP 导出 ${toolCount} 个工具定义，首次发现不依赖 Runtime 状态。`);
  await normalizeReleaseText(distRoot);
  const releaseId = await createReleaseId(distRoot, pluginVersion);
  await writeFile(outputPaths.manifest, `${JSON.stringify({
    schemaVersion: 2,
    format: "commonjs",
    releaseId,
    pluginVersion,
    runtimeEntry: "runtime.cjs",
    mcpEntry: "mcp.cjs",
    remotionEntry: "remotion/render-entry.cjs",
    webRoot: "web",
    nodeRuntime: ">=22.5.0",
    dependencies: "由启动器通过宿主仓库 node_modules 的 NODE_PATH 提供；发行入口不使用 tsx 或 apps 源码。"
  }, null, 2)}\n`, "utf8");
  console.log(`已生成 VideoFlowCut 插件发行 Runtime：${distRoot}`);
}

await main();
