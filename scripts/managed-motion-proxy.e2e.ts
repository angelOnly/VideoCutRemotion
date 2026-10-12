import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";
import { createApplication } from "@videocut/application";
import { runProcess } from "@videocut/speech";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";

// 输入只读真实报障作品；项目、队列、渲染和审阅缓存全部在独立候选目录。
assert.ok(process.argv[2], "提供报障作品的只读 source.json 路径");
const sourcePath = resolve(process.argv[2]!);
const original = motionSubmissionSchema.parse(JSON.parse(await readFile(sourcePath, "utf8")));
// 新候选提交补技术用途说明，不覆盖只读旧源码或其缓存哈希。
const work = { ...original, creativeBrief: original.creativeBrief ?? "重新渲染只读历史作品以检验透明像素和代理一致性；保留原设计，不将技术结果作为审美通过。" };
assert.equal(Object.keys(work.imageBindings).length, 0, "此回归仅接受独立文字/SVG，不复制正式素材绑定");
const require = createRequire(import.meta.url);
const { findAvailablePort } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
const root = await mkdtemp(join(tmpdir(), "videocut-motion-proxy-"));
const repoRoot = resolve(import.meta.dirname, "..");
const pluginRoot = join(repoRoot, "plugins", "videoflowcut");
const port = await findAvailablePort();
const args = ["--repo-root", repoRoot, "--workspace", root, "--port", String(port), "--comfyui-bridge-url", "http://127.0.0.1:18199"];
const app = createApplication(root);
const state = app.createProject({ name: "真实矩阵代理报障隔离回归", profile: "presenter_motion" });
const projectId = state.snapshot.project.id;
const projectRoot = state.snapshot.project.rootPath;
app.repository.commit(projectId, state.revision.number, "仅设置隔离测试画布", (snapshot) => {
  Object.assign(snapshot.timeline, { width: work.width, height: work.height, fps: work.fps, durationInFrames: work.durationInFrames });
});
app.repository.close();
const runtime = await runCandidateRuntime("ensure", args);
console.log(JSON.stringify({ stage: "candidate_started", root, port, releaseId: runtime.releaseId }));
const spec = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.videoflowcut;
const transport = new StdioClientTransport({ command: spec.command, args: spec.args, cwd: pluginRoot, stderr: "pipe", env: { ...getDefaultEnvironment(), ...spec.env, VIDEOCUT_WORKSPACE: root, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: "http://127.0.0.1:18199" } });
transport.stderr?.on("data", (data) => process.stderr.write(data));
const client = new Client({ name: "motion-proxy-regression", version: "1.0.0" });
const call = async (name: string, input: Record<string, unknown> = {}): Promise<any> => {
  const result = await client.callTool({ name, arguments: input });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse((result.content as { type: string; text?: string }[]).find((item) => item.type === "text")!.text!);
};
try {
  await client.connect(transport);
  const schema = await client.listTools();
  for (const name of ["read_runtime_release", "submit_motion_work", "track_job", "read_motion_work", "inspect_asset"]) assert.ok(schema.tools.some((tool) => tool.name === name));
  const release = await call("read_runtime_release");
  assert.equal(release.aligned, true);
  assert.equal(release.runtime.releaseId, runtime.releaseId);
  const before = await call("read_project", { project_id: projectId });
  const job = await call("submit_motion_work", { project_id: projectId, base_revision_id: before.revision.number, idempotency_key: "actual-source-proxy-regression", work });
  const deadline = Date.now() + 300_000;
  let done = false;
  while (Date.now() < deadline) {
    const current = await call("track_job", { job_id: job.id });
    if (current.status === "failed") throw new Error(JSON.stringify(current));
    if (current.status === "succeeded") { done = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.ok(done, "候选真实作品须在期限内成功");
  const rendered = await call("read_motion_work", { project_id: projectId, job_id: job.id });
  assert.equal(rendered.asset.motion.engineVersion, "managed-motion-3");
  const inspected = await call("inspect_asset", { project_id: projectId, asset_id: rendered.asset.id, mode: "overview", contact_sheet_frames: 10 });
  const errors: { frame: number; meanAbsoluteError: number }[] = [];
  for (const frame of inspected.contactSheet.frames) {
    const name = `frame-${String(frame.sourceFrame).padStart(5, "0")}.png`;
    const pngPath = join(projectRoot, rendered.asset.motion.framesDirectory, name);
    const original = PNG.sync.read(await readFile(join(dirname(sourcePath), "frames", name)));
    const bytes = await readFile(pngPath);
    assert.equal(bytes[25], 6);
    const png = PNG.sync.read(bytes);
    assert.deepEqual(png.data, original.data, "归一化不得改变原始作品像素与 Alpha");
    const expectedPath = join(root, `expected-${frame.sourceFrame}.rgb`);
    const actualPath = join(root, `actual-${frame.sourceFrame}.rgb`);
    // 单张 PNG 不发生输入类型切换；作为独立正确的透明合成基线。
    await runProcess("ffmpeg", ["-v", "error", "-i", pngPath, "-f", "lavfi", "-i", `color=c=0x172033:s=${work.width}x${work.height}`, "-filter_complex", "[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p,scale=480:-2", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", expectedPath]);
    await runProcess("ffmpeg", ["-v", "error", "-i", join(projectRoot, frame.relativePath), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", actualPath]);
    const expected = await readFile(expectedPath);
    const actual = await readFile(actualPath);
    assert.equal(actual.length, expected.length);
    let sum = 0;
    for (let index = 0; index < actual.length; index++) sum += Math.abs(actual[index]! - expected[index]!);
    const meanAbsoluteError = sum / actual.length;
    assert.ok(meanAbsoluteError < 4, `F${frame.sourceFrame} 审阅帧与独立合成偏差 ${meanAbsoluteError}`);
    errors.push({ frame: frame.sourceFrame, meanAbsoluteError });
  }
  const report = { verified: true, root, projectId, port, release, assetId: rendered.asset.id, motion: { ...rendered.asset.motion, visibility: undefined }, sourcePath, inspectedFrames: inspected.contactSheet.frames, errors };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  await runCandidateRuntime("stop", args);
}
