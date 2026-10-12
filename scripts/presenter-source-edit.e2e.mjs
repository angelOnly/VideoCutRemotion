import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tsImport } from "tsx/esm/api";
import { ensureRuntime, findAvailablePort, stopRuntime } from "../plugins/videoflowcut/scripts/runtime-launcher.mjs";
import { resolveReleaseRuntime } from "../plugins/videoflowcut/scripts/repo-root.mjs";

// 全链路只使用独立工作区、随机端口和合成声画，不读取或写入正式视频工程。
const root = await mkdtemp(join(tmpdir(), "videoflowcut-source-edit-render-"));
const repoRoot = process.cwd();
const pluginRoot = resolve("plugins/videoflowcut");
const release = resolveReleaseRuntime(pluginRoot);
const port = await findAvailablePort();
assert.notEqual(port, 3100);
const options = { pluginRoot, repoRoot, workspaceRoot: root, port, bridgeUrl: "http://127.0.0.1:8199" };
const exec = promisify(execFile);
const run = (command, args) => exec(command, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" });
const source = join(root, "red-green-blue-25fps.mp4");
let client;
let transport;
try {
  const args = ["-y", "-v", "error"];
  for (const [color, tone] of [["red", 440], ["green", 660], ["blue", 880]]) {
    args.push("-f", "lavfi", "-i", `color=c=${color}:s=360x640:r=25:d=2`,
      "-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000:duration=2`);
  }
  args.push("-filter_complex", "[0:v][1:a][2:v][3:a][4:v][5:a]concat=n=3:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source);
  await run("ffmpeg", args);
  const runtime = await ensureRuntime(options);
  assert.equal(runtime.ready, true);
  transport = new StdioClientTransport({ command: process.execPath, args: [join(pluginRoot, "scripts/mcp-launcher.mjs")], cwd: pluginRoot,
    env: { ...process.env, VIDEOFLOWCUT_REPO_ROOT: repoRoot, VIDEOCUT_WORKSPACE: root,
      VIDEOFLOWCUT_PORT: String(port), COMFYUI_BRIDGE_URL: options.bridgeUrl }, stderr: "pipe" });
  client = new Client({ name: "source-edit-render-e2e", version: "1" });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "edit_presenter_source"));
  const call = async (name, parameters) => {
    const result = await client.callTool({ name, arguments: parameters }, undefined, { timeout: 180_000 });
    const text = result.content.find((entry) => entry.type === "text")?.text;
    if (result.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
  const waitJob = async (id) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const job = await call("track_job", { job_id: id });
      if (job.status === "succeeded") return job;
      if (["failed", "unknown", "cancelled"].includes(job.status)) throw new Error(JSON.stringify(job));
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error(`候选任务超时，保留现场：${root}`);
  };
  const health = await call("read_runtime_release", {});
  assert.equal(health.aligned, true);
  assert.equal(health.mcpReleaseId, release.releaseId);
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "edit_presenter_source"));
  const created = await call("create_project", { name: "发行版原声裁剪声画回归", profile: "presenter_motion" });
  const projectId = created.snapshot.project.id;
  const read = () => call("read_project", { project_id: projectId });
  const imported = await call("import_media", { project_id: projectId, base_revision_id: created.revision.number,
    file_path: source, role: "a_roll", provenance: { source: "local_import" } });
  await waitJob(imported.job.id);
  let state = await read();
  state = await call("assemble_presenter_track", { project_id: projectId, base_revision_id: state.revision.number, asset_ids: [imported.asset.id] });
  const item = state.snapshot.timeline.items.find((candidate) => !candidate.disabled);
  assert.equal(state.snapshot.timeline.fps, 24);
  state = await call("compile_presenter_scenes", { project_id: projectId, base_revision_id: state.revision.number,
    scenes: [{ title: "合成色块与测试音", purpose: "验证源裁剪未错位、漏裁或闪黑", start_frame: 0, end_frame: 144 }] });
  state = await call("manage_actor_performance", { project_id: projectId, base_revision_id: state.revision.number,
    timeline_item_id: item.id, source: "imported", mask_mode: "none", audio_mode: "use_source_audio" });
  // 仅在隔离测试库注入合成 Provider 证据；裁剪、质量校验与渲染仍走发行版 MCP/Worker。
  // 2010ms 映射到 F48，但 F48 反算仅 2000ms，覆盖真实工单同类舍入边界。
  const { createApplication } = await tsImport("../packages/edit-application/src/index.ts", import.meta.url);
  const fixtureApp = createApplication(root);
  try {
    const segments = [
      { displayText: "红色", startMs: 100, endMs: 2010, tokenStartIndex: 0, tokenEndIndex: 1 },
      { displayText: "绿色", startMs: 2010, endMs: 4010, tokenStartIndex: 1, tokenEndIndex: 2 },
      { displayText: "蓝色", startMs: 4010, endMs: 5810, tokenStartIndex: 2, tokenEndIndex: 3 }
    ];
    fixtureApp.completeSourceAudioCaptionAlignment({ projectId, requestedRevision: state.revision.number,
      assetId: imported.asset.id, timelineItemId: item.id, sourceStartFrame: 0, sourceEndFrame: 144,
      timelineStartFrame: 0, timelineEndFrame: 144, transcriptText: "红色绿色蓝色", tokenPrecision: "provider_token_timed",
      tokens: segments.map((segment) => ({ text: segment.displayText, startMs: segment.startMs, endMs: segment.endMs })), segments,
      bridgeAudit: { workflowId: "synthetic-timing-boundary", schemaVersion: "fixture-v4", runId: "synthetic-rgb-timing",
        request: { fieldValues: {}, fileSlots: [{ id: "audio", kind: "audio", fileName: "synthetic-rgb.wav" }] },
        submittedAt: new Date().toISOString(), completedAt: new Date().toISOString(), schemaRetryCount: 0 } });
  } finally { fixtureApp.close(); }
  state = await read();
  state = await call("edit_presenter_source", { project_id: projectId, base_revision_id: state.revision.number,
    timeline_item_id: item.id, keep_ranges: [{ source_start_frame: 0, source_end_frame: 48 }, { source_start_frame: 96, source_end_frame: 144 }],
    reason: "移除绿色/660Hz 中间测试段，保留红色/440Hz 和蓝色/880Hz；素材25fps、项目24fps" });
  assert.equal(state.snapshot.timeline.durationInFrames, 96);
  assert.deepEqual(state.snapshot.timeline.captions.map((card) => [card.text, card.startFrame, card.endFrame]), [["红色", 2, 48], ["蓝色", 48, 91]]);
  assert.deepEqual(state.snapshot.sourceAudioAlignments.filter((alignment) => alignment.sourceEdit).map((alignment) => [alignment.segments[0].startMs, alignment.segments[0].endMs]), [[100, 2010], [4010, 5810]]);
  const historicalPerformance = state.snapshot.actorPerformances.find((performance) => performance.timelineItemId === item.id);
  assert.equal(historicalPerformance.status, "stale");
  assert.equal(state.snapshot.timeline.items.find((candidate) => candidate.id === item.id).disabled, true);
  const quality = await call("read_quality_report", { project_id: projectId });
  assert.equal(quality.revision, state.revision.number);
  assert.deepEqual(quality.technical.filter((issue) => issue.objectId === historicalPerformance.id && issue.code.startsWith("ACTOR_")), [],
    "已禁用的历史人物不能作为当前成片的质量阻断");
  assert.equal((await read()).revision.number, state.revision.number, "质量读回不能修改审计记录或制造视频 Revision");
  const preview = await call("render_preview_range", { project_id: projectId, revision: state.revision.number,
    from_frame: 0, to_frame: 96, idempotency_key: "source-edit-render-96" });
  const rendered = await waitJob(preview.id);
  const evidence = await call("inspect_composed_frames", { project_id: projectId, preview_job_id: preview.id, frames: [0, 47, 48, 95] });
  const stored = await read();
  const previewAsset = stored.snapshot.assets.find((asset) => asset.id === rendered.resultAssetId);
  // 通过实际 Job 输出读取候选 Preview，不猜测正式媒体路径。
  const output = rendered.outputPath ?? rendered.result?.path ?? (previewAsset && join(stored.snapshot.project.rootPath, previewAsset.managedPath));
  assert.ok(output, `Preview Job 缺少可读取路径：${JSON.stringify(rendered)}`);
  const probed = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", output])).stdout.toString());
  assert.equal(probed.frames.length, 96);
  for (let index = 0; index < 96; index++) assert.ok(Math.abs(Number(probed.frames[index].best_effort_timestamp_time) - index / 24) < 0.00001, `帧${index}的PTS不连续`);
  const pixels = (await run("ffmpeg", ["-v", "error", "-i", output, "-an", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])).stdout;
  assert.equal(pixels.length, 96 * 3);
  for (let frame = 0; frame < 96; frame++) {
    const [red, green, blue] = pixels.subarray(frame * 3, frame * 3 + 3);
    assert.ok(frame < 48 ? red > 180 && green < 40 && blue < 40 : blue > 180 && red < 40 && green < 40,
      `帧${frame}颜色错位或闪黑：${red},${green},${blue}`);
  }
  const pcm = (await run("ffmpeg", ["-v", "error", "-i", output, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"])).stdout;
  const power = (frequency, second) => {
    let real = 0, imaginary = 0;
    for (let sample = 0; sample < 24000; sample++) {
      const amplitude = pcm.readFloatLE((second * 48000 + sample) * 4);
      const phase = 2 * Math.PI * frequency * sample / 48000;
      real += amplitude * Math.cos(phase); imaginary += amplitude * Math.sin(phase);
    }
    return real * real + imaginary * imaginary;
  };
  for (const [second, frequency] of [[1, 440], [3, 880]]) {
    assert.ok(power(frequency, second) > power(660, second) * 1000, "被裁掉的中间音调不能残留或与画面脱节");
    assert.ok(power(frequency, second) > 100, "保留的声音不能静音");
  }
  // 真实导出仍走标准门禁与渲染 Worker，不删除历史表演或伪造 ready。
  const exportJob = await call("submit_export", { project_id: projectId, revision: state.revision.number,
    purpose: "draft", idempotency_key: "source-edit-disabled-audit-draft" });
  const exported = await waitJob(exportJob.id);
  const exportPath = exported.result?.path;
  assert.equal(typeof exportPath, "string", "成功导出的 Job.result.path 必须指向真实产物");
  assert.equal(exported.result.revision, state.revision.number);
  assert.equal(exported.result.purpose, "draft");
  const exportProbe = JSON.parse((await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames", "-of", "json", exportPath])).stdout.toString());
  assert.equal(Number(exportProbe.streams[0].nb_read_frames), 96);
  const finalState = await read();
  assert.equal(finalState.revision.number, state.revision.number);
  assert.equal(finalState.snapshot.actorPerformances.find((performance) => performance.id === historicalPerformance.id).status, "stale");
  const summary = { releaseId: release.releaseId, root, port, projectId, revision: state.revision.number,
    output, evidence, exported, assertions: { frames: 96, fps: 24, sourceFps: 25, sourceRangeSeconds: [[0, 2], [4, 6]], pts: "continuous", colors: "red-then-blue-no-black", audio: "440Hz-then-880Hz-no-660Hz", captions: "provider-ms-preserved-at-rounded-cut-boundary", disabledActorAudit: "preserved-without-composition-blocking", draftExport: "96-frames-without-revision-change" } };
  await writeFile(join(root, "verification.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(`验证失败现场保留于 ${root}`);
  const log = await readFile(join(root, ".videoflowcut-runtime", `runtime-${port}.log`), "utf8").catch(() => "");
  console.error(log.slice(-3000));
  throw error;
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  await stopRuntime(options).catch(() => undefined);
}
