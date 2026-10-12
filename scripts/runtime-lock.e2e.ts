import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = process.cwd();
const pluginRoot = resolve("plugins/videoflowcut");
const baselineRoot = resolve(process.argv[2]!);
const launcher = await import(pathToFileURL(join(pluginRoot, "scripts/runtime-launcher.mjs")).href);
const baselineLauncher = await import(pathToFileURL(join(baselineRoot, "scripts/runtime-launcher.mjs")).href);
const root = await mkdtemp(join(tmpdir(), "videocut-runtime-lock-"));
const workspaceRoot = join(root, "workspace");
const port = await launcher.findAvailablePort();
assert.notEqual(port, 3100);
const options = { repoRoot, pluginRoot, workspaceRoot, port, bridgeUrl: "http://127.0.0.1:18199" };
const evidence: any[] = [];
let client: Client | undefined;
let transport: StdioClientTransport | undefined;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client!.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse((result.content as any[]).find(item => item.type === "text").text);
};
const connect = async (root: string) => {
  await client?.close();
  transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "scripts/mcp-launcher.mjs")],
    cwd: repoRoot, stderr: "pipe", env: { ...process.env as Record<string, string>, VIDEOFLOWCUT_REPO_ROOT: repoRoot,
      VIDEOCUT_WORKSPACE: workspaceRoot, VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: options.bridgeUrl } });
  client = new Client({ name: "runtime-lock-release-regression", version: "1.0.0" });
  await client.connect(transport);
  await client.listTools();
};
const hold = async (milliseconds: number) => {
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const completion = launcher.withRuntimeOperationLock(options, async () => {
    entered();
    await new Promise(done => setTimeout(done, milliseconds));
  }, { operationName: "隔离回归合法长操作" });
  await started;
  return { completion };
};
try {
  // 在真实文件系统的释放边界注入一次占用错误，验证旧版会遗留活进程锁。
  for (const [name, implementation] of [["baseline", baselineLauncher], ["candidate", launcher]] as const) {
    const isolated = join(root, `cleanup-${name}`);
    const lockPath = join(isolated, ".videoflowcut-runtime/launch.lock");
    const originalRm = fs.rm;
    let failures = 1;
    fs.rm = (async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === lockPath && failures-- > 0) throw Object.assign(new Error("模拟 Windows 瞬时占用"), { code: "EPERM" });
      return originalRm(...args);
    }) as typeof fs.rm;
    syncBuiltinESMExports();
    try {
      let executions = 0;
      await implementation.withRuntimeOperationLock({ ...options, workspaceRoot: isolated }, () => ++executions);
      const leftover = await readFile(lockPath, "utf8").catch(() => undefined);
      assert.equal(executions, 1);
      assert.equal(Boolean(leftover), name === "baseline");
      evidence.push({ stage: `cleanup_${name}`, singleExecution: true, orphanedLock: Boolean(leftover), injectedFailure: "EPERM" });
    } finally { fs.rm = originalRm; syncBuiltinESMExports(); }
  }
  await launcher.ensureRuntime({ ...options, pluginRoot: baselineRoot });
  await connect(baselineRoot);
  const baselineRelease = await call("read_runtime_release");
  const created = await call("create_project", { name: "Runtime锁隔离回归" });
  const projectId = created.snapshot.project.id;
  const baselineHolder = await hold(32_000);
  const baselineStarted = Date.now();
  let baselineError = "";
  try { await call("read_quality_report", { project_id: projectId }); }
  catch (error) { baselineError = String(error); }
  assert.match(baselineError, /启动锁超时/);
  const baselineWaitMs = Date.now() - baselineStarted;
  await baselineHolder.completion;
  evidence.push({ stage: "baseline_real_mcp_contention", releaseId: baselineRelease.mcpReleaseId, baselineWaitMs, baselineError });
  console.log(JSON.stringify(evidence.at(-1)));
  await client!.close();
  client = undefined;
  await launcher.ensureRuntime(options);
  await connect(pluginRoot); // 必须真正启动新版外壳，不能把旧外壳内层热切称为验证。
  const candidateRelease = await call("read_runtime_release");
  assert.equal(candidateRelease.aligned, true);
  assert.notEqual(candidateRelease.mcpReleaseId, baselineRelease.mcpReleaseId);
  const launcherSources = await Promise.all(["mcp-launcher.mjs", "mcp-session.mjs", "runtime-launcher.mjs"].map(async name => `${name}\n${await readFile(join(pluginRoot, "scripts", name), "utf8")}`));
  assert.equal(candidateRelease.launcherReleaseId, candidateRelease.mcpReleaseId);
  assert.equal(candidateRelease.launcherCodeHash, createHash("sha256").update(launcherSources.join("\n")).digest("hex"));
  assert.equal(candidateRelease.runtime.workers.media && candidateRelease.runtime.workers.render, true);
  const candidateHolder = await hold(32_000);
  const candidateStarted = Date.now();
  const quality = await call("read_quality_report", { project_id: projectId });
  const candidateWaitMs = Date.now() - candidateStarted;
  await candidateHolder.completion;
  assert.ok(candidateWaitMs >= 30_000);
  assert.equal((await call("read_project", { project_id: projectId })).revision.number, created.revision.number);
  evidence.push({ stage: "candidate_real_mcp_contention", releaseId: candidateRelease.mcpReleaseId, launcherCodeHash: candidateRelease.launcherCodeHash, candidateWaitMs, quality });
  console.log(JSON.stringify({ stage: "candidate_contention_passed", candidateWaitMs }));
  const before = await call("list_projects");
  const cancelledHolder = await hold(1500);
  const controller = new AbortController();
  const cancelled = client!.callTool({ name: "create_project", arguments: { name: "取消后绝不可创建" } }, undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(cancelled);
  await cancelledHolder.completion;
  assert.deepEqual(await call("list_projects"), before, "排队取消不能在释放锁后晚执行");
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/jobs`)).json(), []);
  evidence.push({ stage: "candidate_cancelled_mutation", noLateProject: true, noJobs: true, noRevisionChange: true });
  const reportPath = join(root, "report.json");
  await writeFile(reportPath, JSON.stringify({ verified: true, workspaceRoot, port, scope: "独立技术fixture，不触碰正式项目", evidence }, null, 2));
  console.log(JSON.stringify({ verified: true, reportPath, releaseId: candidateRelease.mcpReleaseId }));
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  await launcher.stopRuntime(options, { force: true });
}
