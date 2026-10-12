import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProjectSnapshot } from "@videocut/contracts";
import { RevisionRenderer } from "../apps/render-worker/src/exporter.js";
import { probeMedia } from "@videocut/speech";

/** 只读正式快照与素材，输出仅进新建隔离目录；不创建正式 Project、Revision、Job 或 Artifact。 */
const [apiUrl, projectId, rawRanges] = process.argv.slice(2);
if (!apiUrl || !projectId || !rawRanges) throw new Error("参数：API 地址、Project ID、JSON 帧范围数组");
const response = await fetch(`${apiUrl}/api/projects/${encodeURIComponent(projectId)}`);
if (!response.ok) throw new Error(`只读快照失败：${response.status}`);
const project = await response.json() as { snapshot: ProjectSnapshot; revision: { number: number } };
const ranges = JSON.parse(rawRanges) as [number, number][];
if (!Array.isArray(ranges) || ranges.some(([from, to]) => !Number.isInteger(from) || !Number.isInteger(to)
  || from < 0 || to <= from || to > project.snapshot.timeline.durationInFrames)) throw new Error("无效的验证帧范围");
const root = await mkdtemp(join(tmpdir(), "videoflowcut-render-snapshot-audit-"));
const distribution = resolve("plugins/videoflowcut/runtime/dist");
const manifest = JSON.parse(await readFile(join(distribution, "manifest.json"), "utf8"));
const { prepareRenderBrowser } = await import(pathToFileURL(resolve("plugins/videoflowcut/scripts/prepare-render-browser.mjs")).href);
process.env.VIDEOCUT_WORKSPACE = root;
if (process.env.VIDEOCUT_AUDIT_SOURCE_ENTRY === "1") delete process.env.VIDEOFLOWCUT_RUNTIME_DIST;
else process.env.VIDEOFLOWCUT_RUNTIME_DIST = distribution;
process.env.VIDEOFLOWCUT_NODE_MODULES = resolve("node_modules");
process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE = await prepareRenderBrowser({ repoRoot: process.cwd() });
// Renderer 的打包入口来自该 Release；正式源文件由只读媒体服务读取，不复制或修改创作对象。
const renderer = new RevisionRenderer(process.env.VIDEOCUT_AUDIT_SOURCE_ENTRY === "1"
  ? resolve("apps/render-worker/src/render-entry.tsx")
  : join(distribution, "remotion/render-entry.cjs"), process.env.VIDEOCUT_AUDIT_CONCURRENCY ?? 1);
for (const [index, [from, to]] of ranges.entries()) {
  const runRoot = join(root, `run-${index + 1}`);
  await mkdir(runRoot);
  const target = join(runRoot, `revision-${project.revision.number}-${from}-${to}.mp4`);
  await renderer.renderRange(project.snapshot, from, to, target);
  const media = await probeMedia(target);
  if (!media.hasAudio || !media.videoCodec || Math.abs(media.durationMs - (to - from) / project.snapshot.timeline.fps * 1000) > 1000) {
    throw new Error("回归视频缺少有效声画或时长不匹配");
  }
  console.log(JSON.stringify({ releaseId: process.env.VIDEOCUT_AUDIT_SOURCE_ENTRY === "1" ? null : manifest.releaseId, revision: project.revision.number, from, to, target, durationMs: media.durationMs, memory: process.memoryUsage(), activeResources: process.getActiveResourcesInfo() }));
}
