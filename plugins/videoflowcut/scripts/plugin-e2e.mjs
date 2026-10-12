import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pluginRootFromModule, resolveReleaseRuntime, resolveRepoRoot } from "./repo-root.mjs";
import { ensureRuntime, findAvailablePort, getRuntimeStatus, stopRuntime } from "./runtime-launcher.mjs";

const sourcePluginRoot = pluginRootFromModule(import.meta.url);
const repoRoot = resolveRepoRoot({ pluginRoot: sourcePluginRoot });
// 安装快照必须位于仓库之外，否则 CWD 向上找到 package.json 会掩盖浏览器依赖缺失。
const installationRoot = await mkdtemp(join(tmpdir(), "videoflowcut-install-e2e-"));
const pluginRoot = join(installationRoot, "videoflowcut");
await cp(sourcePluginRoot, pluginRoot, { recursive: true });
const release = resolveReleaseRuntime(pluginRoot);
const workspaceRoot = await mkdtemp(join(tmpdir(), "videoflowcut-plugin-e2e-"));
const runtimePort = await findAvailablePort();
const candidateBridgePort = await findAvailablePort();
assert.notEqual(candidateBridgePort, runtimePort);
// 本轮不调用生成Bridge；仍显式隔离地址，避免候选误连生产队列。
const bridgeUrl = `http://127.0.0.1:${candidateBridgePort}`;
const runtimeOptions = { pluginRoot, repoRoot, workspaceRoot, port: runtimePort, bridgeUrl };
const requireFromRepo = createRequire(join(repoRoot, "package.json"));
const { Client } = requireFromRepo("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requireFromRepo("@modelcontextprotocol/sdk/client/stdio.js");

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

let transport;
let untrustedProcess;

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processTreeRss(pid) {
  if (process.platform !== "win32") return undefined;
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress"], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const records = JSON.parse(stdout); const children = new Set([pid]);
  for (let pass = 0; pass < records.length; pass++) {
    const before = children.size;
    for (const record of records) if (children.has(record.ParentProcessId)) children.add(record.ProcessId);
    if (children.size === before) break;
  }
  // RSS合计可能重复计算共享页；这里只记录观察峰值，不冒充硬内存限额。
  return records.filter(record => children.has(record.ProcessId)).reduce((sum, record) => sum + Number(record.WorkingSetSize), 0);
}

try {
  // 陈旧状态即使恰好命中已复用的 PID，也绝不能成为强杀未知进程的授权。
  untrustedProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore"
  });
  assert.ok(untrustedProcess.pid, "安全性验证需要启动独立的未知进程");
  const runtimeStateDirectory = join(workspaceRoot, ".videoflowcut-runtime");
  const runtimeStateName = runtimePort === 3100 ? "runtime.json" : `runtime-${runtimePort}.json`;
  await mkdir(runtimeStateDirectory, { recursive: true });
  await writeFile(join(runtimeStateDirectory, runtimeStateName), `${JSON.stringify({
    schemaVersion: 3,
    runtimeId: "stale-runtime",
    controlToken: "not-a-real-runtime-token",
    repoRoot,
    workspaceRoot,
    port: runtimePort,
    apiUrl: `http://127.0.0.1:${runtimePort}`,
    runtimeEntry: join(pluginRoot, "runtime", "dist", "runtime.cjs"),
    distributionRoot: join(pluginRoot, "runtime", "dist"),
    releaseId: release.releaseId,
    pid: untrustedProcess.pid
  }, null, 2)}\n`, "utf8");
  const rejectedStop = await stopRuntime(runtimeOptions, { force: true });
  assert.equal(rejectedStop.stopped, false, "未认证状态不得被当作本插件 Runtime");
  assert.equal(processIsAlive(untrustedProcess.pid), true, "停止器不能终止状态文件指向的未知 PID");
  untrustedProcess.kill();
  await rm(join(runtimeStateDirectory, runtimeStateName), { force: true });

  const runtime = await ensureRuntime(runtimeOptions);
  assert.equal(runtime.ready, true, "运行器必须报告 ready");
  assert.equal(runtime.releaseId, release.releaseId, "Runtime 状态必须包含当前构建 Release ID");
  assert.equal(runtime.port, runtimePort, "E2E 必须使用独立 Runtime 端口");
  const projects = await fetchWithTimeout(`${runtime.apiUrl}/api/projects`);
  assert.equal(projects.status, 200, "API 必须可读项目列表");
  assert.ok(Array.isArray(await projects.json()), "项目列表必须是数组");
  const runtimeReleaseResponse = await fetchWithTimeout(`${runtime.apiUrl}/api/runtime/status`);
  assert.equal(runtimeReleaseResponse.status, 200, "Runtime 必须提供不含控制令牌的发行状态接口");
  const runtimeRelease = await runtimeReleaseResponse.json();
  assert.equal(runtimeRelease.releaseId, release.releaseId, "Runtime 公开发行状态必须匹配 manifest");

  // 模拟新构建落地后磁盘仍记录旧 Release 的常见切换现场：只有控制令牌认证成功，
  // 启动器才可停止旧 Runtime 并拉起新实例；未知 PID 仍由前面的安全性用例保护。
  const currentRuntimeStatePath = join(runtimeStateDirectory, runtimeStateName);
  const recordedRuntime = JSON.parse(await readFile(currentRuntimeStatePath, "utf8"));
  await writeFile(currentRuntimeStatePath, `${JSON.stringify({
    ...recordedRuntime,
    releaseId: `release-${"0".repeat(64)}`
  }, null, 2)}\n`, "utf8");
  const cutoverRuntime = await ensureRuntime(runtimeOptions);
  assert.equal(cutoverRuntime.ready, true, "旧发行状态必须通过受控切换重新部署 Runtime");
  assert.equal(cutoverRuntime.releaseId, release.releaseId, "受控切换后 Runtime 必须恢复 manifest Release ID");
  const web = await fetchWithTimeout(runtime.webUrl);
  assert.equal(web.status, 200, "Web 工作台必须可访问");
  assert.match(await web.text(), /id="root"/u, "Web 必须返回 React 根节点");

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(pluginRoot, "scripts", "mcp-launcher.mjs")],
    cwd: pluginRoot,
    env: {
      ...process.env,
      VIDEOFLOWCUT_REPO_ROOT: repoRoot,
      VIDEOCUT_WORKSPACE: workspaceRoot,
      VIDEOFLOWCUT_PORT: String(runtimePort),
      COMFYUI_BRIDGE_URL: bridgeUrl
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "videoflowcut-plugin-e2e", version: "1.0.0" });
  await client.connect(transport);
  const textFromResult = (result) => {
    const content = result?.content;
    const first = Array.isArray(content) ? content.find((entry) => entry?.type === "text") : undefined;
    if (result?.isError || typeof first?.text !== "string") throw new Error(first?.text ?? "MCP 未返回标准文本结果");
    return first.text;
  };
  const call = async (name, args) => {
    try { return JSON.parse(textFromResult(await client.callTool({ name, arguments: args }))); }
    catch (error) { throw new Error(`E2E 调用 ${name} 失败：${error.message}`, { cause: error }); }
  };
  const waitForJob = async (jobId, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await call("track_job", { job_id: jobId });
      if (job.status === "succeeded") return job;
      if (job.status === "failed") throw new Error(`Worker 任务失败：${job.error ?? jobId}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    }
    throw new Error(`Worker 未在时限内消费任务：${jobId}`);
  };
  const tools = await client.listTools();
  assert.equal(tools.tools.some(tool => ["adopt_media_source", "bind_media_adoption"].includes(tool.name)), false, "发行 MCP 不再公开素材采用资格入口");
  assert.ok(tools.tools.some(tool => tool.name === "search_motion_mechanisms"), "发行 MCP 必须公开混合机制检索");
  assert.ok(tools.tools.some(tool => tool.name === "analyze_motion_reference"), "发行 MCP 必须公开按需原片理解");
  const motionTool = tools.tools.find((tool) => tool.name === "submit_motion_work");
  assert.ok(motionTool.inputSchema.properties.work.properties.imageBindings, "内部图片直接使用真实素材绑定");
  assert.ok(motionTool.inputSchema.properties.work.properties.videoBindings, "内部视频直接使用真实源时钟绑定");
  const composedTool = tools.tools.find((tool) => tool.name === "inspect_composed_frames");
  assert.equal(composedTool.inputSchema.properties.frames.maxItems, 12, "实时MCP Schema必须保留抽帧数量上限");
  assert.match(composedTool.description, /1–12.*分批/u, "压缩工具声明未展示maxItems时，描述仍须明确上限");
  assert.match(tools.tools.find((tool) => tool.name === "inspect_asset")?.description ?? "", /range最长60秒，dense最长12秒/u, "发行工具表须公开素材短范围限制");
  assert.match(tools.tools.find((tool) => tool.name === "render_preview_range")?.description ?? "", /result.audio.*integratedLufs.*truePeakDbfs/u, "发行工具表须明确混合响度的读取位置");
  assert.match(motionTool?.description ?? "", /TimelineVideo/u, "发行工具表必须公开作品根时钟视频合同");
  assert.match(motionTool.inputSchema.properties.work.properties.durationInFrames.description, /不按30秒/u, "发行字段必须公开完整作品资源策略");
  assert.ok(tools.tools.some((tool) => tool.name === "inspect_asset"), "插件 MCP 必须发现 inspect_asset");
  assert.ok(tools.tools.some((tool) => tool.name === "list_projects"), "插件 MCP 必须发现基础只读工具");
  assert.ok(tools.tools.some((tool) => tool.name === "open_web_workbench"), "插件 MCP 必须提供工作台入口");
  assert.ok(tools.tools.some((tool) => tool.name === "read_runtime_release"), "插件 MCP 必须提供发行版本核验");
  // Windows 不允许移动被进程当作 CWD 持有的安装目录；运行中升级不能依赖重启 Codex 来释放它。
  const relocatedPluginRoot = `${pluginRoot}-cwd-check`;
  await rename(pluginRoot, relocatedPluginRoot);
  await rename(relocatedPluginRoot, pluginRoot);
  assert.ok(tools.tools.some((tool) => tool.name === "report_editing_blocker"), "插件 MCP 必须提供剪辑阻断报告");
  assert.ok(tools.tools.some((tool) => tool.name === "generate_source_audio_captions"), "插件 MCP 必须提供原声段级字幕入口");
  assert.equal(tools.tools.some((tool) => tool.name === "submit_source_audio_captions"), false, "插件 MCP 不得暴露旧 VAD 粗字幕入口");
  assert.equal(tools.tools.some((tool) => tool.name === "submit_source_audio_sentence_alignment"), false, "插件 MCP 不得暴露旧 token-only 字幕入口");
  assert.equal(tools.tools.some((tool) => tool.name === "submit_source_audio_token_alignment"), false, "插件 MCP 不得暴露重复的 token-only 字幕入口");
  assert.ok(tools.tools.some((tool) => tool.name === "browse_local_sound_effects"), "插件 MCP 必须提供受控本地音效浏览");
  assert.ok(tools.tools.some((tool) => tool.name === "import_local_sound_effect"), "插件 MCP 必须提供受控本地音效导入");
  assert.equal(tools.tools.find((tool) => tool.name === "browse_sound_sources")?.annotations?.readOnlyHint, true);
  // 当前入口返回实际 Provider 能力，旧版五个网站目录的数量不再是发行合同。
  assert.deepEqual((await call("browse_sound_sources", {})).sources.map((source) => source.id).sort(), ["mixkit", "mixkit_music"]);
  assert.ok(tools.tools.find((tool) => tool.name === "manage_audio")?.inputSchema?.properties?.effect_event);
  const workbench = await call("open_web_workbench", {});
  assert.equal(workbench.url, runtime.webUrl, "MCP 工作台入口必须指向同一个隔离 Runtime");

  const authoredProject = await call("create_project", { name: "发行版原创旁白入口验收", profile: "visual_explainer" });
  const authoredState = await call("apply_authored_script", {
    project_id: authoredProject.snapshot.project.id,
    base_revision_id: authoredProject.revision.number,
    source_note: "隔离发行验收的新写旁白，不是已有素材转写",
    units: [{ text: "流量大小不代表下载速度。", kind: "statement" }]
  });
  assert.equal(authoredState.snapshot.semanticUnits[0].sourceKind, "authored");
  assert.equal(authoredState.snapshot.speechSegments[0].text, "流量大小不代表下载速度。");
  assert.equal(authoredState.snapshot.assets.length, 0);
  assert.equal(authoredState.snapshot.transcripts.length, 0);
  assert.equal(authoredState.snapshot.transcriptSentenceCandidates.length, 0);
  assert.equal((await call("read_script", { project_id: authoredProject.snapshot.project.id })).semanticUnits[0].sourceAssetId, undefined);

  // 在隔离目录生成可解码的声画测试文件，发行验收不依赖开发者私有素材。
  const sourceVideo = join(workspaceRoot, "media-worker-fixture.mp4");
  await promisify(execFile)("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libx264",
    "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", sourceVideo], { windowsHide: true });
  const project = await call("create_project", { name: "插件 Runtime 媒体任务验收", profile: "presenter_motion" });
  const releaseRead = await call("read_runtime_release", {});
  assert.equal(releaseRead.aligned, true, "MCP 与 Runtime 必须报告同一 Release ID");
  assert.equal(releaseRead.mcpReleaseId, release.releaseId);
  const ticket = await call("report_editing_blocker", {
    project_id: project.snapshot.project.id,
    reported_revision: project.revision.number,
    category: "tool_error",
    summary: "E2E 验证平台修复交接，不执行临时绕过。",
    reporter_id: "plugin-e2e-editor",
    idempotency_key: "plugin-e2e-repair-ticket"
  });
  assert.equal(ticket.status, "open", "阻断报告必须写入独立 Repair Ticket");
  const claimedTicket = await call("claim_repair_ticket", { ticket_id: ticket.id, repairer_id: "plugin-e2e-repairer" });
  const readyTicket = await call("mark_repair_candidate_ready", {
    ticket_id: ticket.id,
    repairer_id: "plugin-e2e-repairer",
    candidate_release_id: release.releaseId,
    validation_summary: "E2E 在隔离工作区验证发行 Runtime、MCP 与健康检查。"
  });
  assert.equal(claimedTicket.status, "claimed");
  assert.equal(readyTicket.status, "ready_for_cutover");
  const deployedTicket = await call("mark_repair_deployed", {
    ticket_id: ticket.id,
    repairer_id: "plugin-e2e-repairer",
    deployment_evidence: "同一 Release ID 的 MCP、Runtime、媒体 Worker 和渲染 Worker 均健康。"
  });
  assert.equal(deployedTicket.status, "deployed");
  const acknowledgedTicket = await call("acknowledge_repair_deployment", {
    ticket_id: ticket.id,
    editor_id: "plugin-e2e-editor",
    observed_revision: project.revision.number
  });
  assert.equal(acknowledgedTicket.status, "acknowledged", "剪辑任务必须在新版 MCP 实测后确认恢复");
  const imported = await call("import_media", {
    project_id: project.snapshot.project.id,
    base_revision_id: project.revision.number,
    file_path: sourceVideo,
    role: "a_roll",
    provenance: { source: "local_import" }
  });
  const analyzed = await waitForJob(imported.job.id);
  assert.equal(analyzed.status, "succeeded", "媒体 Worker 必须完成真实素材分析");

  // 用发行版 render-entry.cjs 做一秒真实合成，防止 E2E 只验证媒体 Worker 而遗漏 Remotion 发行入口。
  let projectState = await call("read_project", { project_id: project.snapshot.project.id });
  const importedAsset = projectState.snapshot.assets.find((asset) => asset.status === "ready" && asset.kind === "video");
  assert.ok(importedAsset?.id, "媒体分析完成后必须存在可播放视频 Asset");
  // 真实发行MCP→API→Worker验证33秒，不只检查字段或直接调用开发源码。
  const motion = await call("submit_motion_work", { project_id: project.snapshot.project.id, base_revision_id: projectState.revision.number, idempotency_key: "release-motion-33",
    work: { name: "发行版33秒完整动效回归", creativeBrief: "独立候选技术回归：检查作品根时钟、源复用和完整帧数，不构成审美验收。", props: {}, imageBindings: {}, width: 768, height: 1344, fps: 24, durationInFrames: 792,
      videoBindings: { footage: { assetId: importedAsset.id, sourceStartMs: 0, sourceEndMs: 2000, startFrame: 0, endFrame: 48 } },
      source: "import React from 'react';import {AbsoluteFill,useCurrentFrame,Sequence} from 'remotion';import {TimelineVideo} from '@videoflowcut/motion';export default function Motion(){const f=useCurrentFrame();return <AbsoluteFill style={{background:'#172033'}}><Sequence durationInFrames={24}><TimelineVideo slot='footage'/></Sequence><Sequence from={24} durationInFrames={24}><TimelineVideo slot='footage'/></Sequence><div style={{color:'white',fontSize:48,margin:80}}>发行回归 {f}</div></AbsoluteFill>}"
    } });
  let runtimeTreeRssPeak = 0, sampling;
  const sampleMemory = () => {
    if (sampling) return;
    sampling = processTreeRss(cutoverRuntime.pid).then(bytes => { if (bytes !== undefined) runtimeTreeRssPeak = Math.max(runtimeTreeRssPeak, bytes); }).finally(() => { sampling = undefined; });
  };
  sampleMemory(); const memoryTimer = setInterval(sampleMemory, 5000);
  let motionResult;
  try { motionResult = await waitForJob(motion.id, 180_000); }
  finally { clearInterval(memoryTimer); await sampling; }
  const motionRead = await call("read_motion_work", { project_id: project.snapshot.project.id, job_id: motion.id });
  assert.equal(motionRead.asset.motion.frameCount, 792);
  assert.equal(motionRead.asset.metadata.durationMs, 33000);
  // 字体已由managed-motion-13接管；新作必须使用当前引擎，旧版本仅供历史作品读取。
  assert.equal(motionRead.asset.motion.engineVersion, "managed-motion-13");
  assert.equal(motionResult.result.assetId, motionRead.asset.id);
  if (process.platform === "win32") assert.ok(runtimeTreeRssPeak > 0, "候选验证必须记录实际Runtime进程树内存");
  console.log(JSON.stringify({ releaseId: release.releaseId, frameCount: 792, durationMs: 33000, runtimeTreeRssPeakBytes: runtimeTreeRssPeak }));
  projectState = await call("read_project", { project_id: project.snapshot.project.id });
  const assembled = await call("assemble_presenter_track", {
    project_id: project.snapshot.project.id,
    base_revision_id: projectState.revision.number,
    asset_ids: [importedAsset.id]
  });
  projectState = await call("read_project", { project_id: project.snapshot.project.id });
  const actorTrack = projectState.snapshot.timeline.tracks.find((track) => track.name === "Actor / A-roll");
  const actorItem = projectState.snapshot.timeline.items.find((item) => item.trackId === actorTrack?.id && !item.disabled);
  assert.ok(actorItem, "组装 Presenter A-roll 后必须存在主画面 Timeline Item");
  await call("compile_presenter_scenes", {
    project_id: project.snapshot.project.id,
    base_revision_id: assembled.revision.number,
    scenes: [{
      title: "发行 Runtime 预览场景",
      purpose: "验证插件发行版能从受管素材合成实际 Preview。",
      start_frame: actorItem.startFrame,
      end_frame: actorItem.endFrame,
      style_pack_id: "default-clean"
    }]
  });
  projectState = await call("read_project", { project_id: project.snapshot.project.id });
  const previewToFrame = Math.min(projectState.snapshot.timeline.durationInFrames, 24);
  // 音效在真实发行 Worker 中参与合成；不把无声作品或只读 Schema 当声画链已通过。
  const soundPath = join(workspaceRoot, "event-fixture.wav");
  const soundBytes = Buffer.alloc(44 + 4800 * 2);
  soundBytes.write("RIFF"); soundBytes.writeUInt32LE(soundBytes.length - 8, 4); soundBytes.write("WAVEfmt ", 8);
  soundBytes.writeUInt32LE(16, 16); soundBytes.writeUInt16LE(1, 20); soundBytes.writeUInt16LE(1, 22);
  soundBytes.writeUInt32LE(48000, 24); soundBytes.writeUInt32LE(96000, 28); soundBytes.writeUInt16LE(2, 32); soundBytes.writeUInt16LE(16, 34);
  soundBytes.write("data", 36); soundBytes.writeUInt32LE(9600, 40);
  for (let i = 0; i < 4800; i++) soundBytes.writeInt16LE(Math.round(Math.sin(i * 880 * Math.PI * 2 / 48000) * 6000), 44 + i * 2);
  await writeFile(soundPath, soundBytes);
  const soundImport = await call("import_media", { project_id: project.snapshot.project.id, base_revision_id: projectState.revision.number, file_path: soundPath, role: "sfx", provenance: { source: "local_import" } });
  await waitForJob(soundImport.job.id);
  projectState = await call("read_project", { project_id: project.snapshot.project.id });
  const effectState = await call("manage_effect_cues", { project_id: project.snapshot.project.id, base_revision_id: projectState.revision.number,
    action: "create", scene_id: projectState.snapshot.scenes[0].id, type: "CameraPunch", layer: "actor", start_frame: 2, end_frame: 22,
    narrative_purpose: "独立测试一个有声音关联的动作", audience_task: "验证物理事件", semantic_anchor: { type: "absolute", relation: "land_on" } });
  const effectId = effectState.snapshot.effectCues.at(-1).id;
  const soundState = await call("manage_audio", { project_id: project.snapshot.project.id, base_revision_id: effectState.revision.number,
    action: "create", kind: "sfx", asset_id: soundImport.asset.id, purpose: "测试动作落点", event_frame: 8, onset_offset_frames: 0,
    effect_event: { effect_cue_id: effectId, event_name: "局部动作", local_frame: 6 } });
  assert.match(soundState.snapshot.audioCues[0].effectEvent.cueSignature, /^[a-f0-9]{64}$/u);
  const movedState = await call("manage_effect_cues", { project_id: project.snapshot.project.id, base_revision_id: soundState.revision.number,
    action: "update", cue_id: effectId, start_frame: 4, end_frame: 24 });
  assert.equal(movedState.snapshot.audioCues[0].eventFrame, 10);
  projectState = movedState;
  const preview = await call("render_preview_range", {
    project_id: project.snapshot.project.id,
    revision: projectState.revision.number,
    from_frame: 0,
    to_frame: previewToFrame,
    idempotency_key: "plugin-release-render-preview"
  });
  const rendered = await waitForJob(preview.id);
  assert.equal(rendered.status, "succeeded", "发行版 Render Worker 必须完成 Preview 合成");
  assert.equal(rendered.result.audio.decoded, true, "实际Preview音轨必须完整解码");
  assert.ok(Number.isFinite(rendered.result.audio.integratedLufs), "实际Preview须返回LUFS");
  assert.ok(Number.isFinite(rendered.result.audio.truePeakDbfs), "实际Preview须返回true peak");
  assert.equal(rendered.result.audio.method, "ffmpeg_ebur128_true_peak_complete_decode");
  assert.deepEqual([rendered.result.fromFrame, rendered.result.toFrame], [0, previewToFrame], "响度绑定实际合成范围");
  assert.equal(existsSync(join(pluginRoot, ".remotion")), false, "正式安装目录不能因 Job 渲染而下载浏览器");
  const composedFrames = await call("inspect_composed_frames", {
    project_id: project.snapshot.project.id,
    preview_job_id: preview.id,
    frames: [0, previewToFrame - 1]
  });
  assert.equal(composedFrames.frames.length, 2, "发行版 Preview 必须可提取实际合成帧");
  const reviewRun = await call("start_production_run", { project_id: project.snapshot.project.id, loaded_skills: ["quality-verification"] });
  const review = await call("record_editorial_quality_review", {
    project_id: project.snapshot.project.id,
    run_id: reviewRun.id,
    revision: projectState.revision.number,
    passes: ["mute_visual"],
    findings: [],
    observations: [{ pass: "mute_visual", preview_job_id: preview.id, start_frame: 0, end_frame: previewToFrame, method: "continuous_video", observation: "发行 E2E 模拟观察声明，只验证合同，不声称审美通过" }]
  });
  assert.match(review.editorialReview.evidenceRecords[0].contentHash, /^[a-f0-9]{64}$/u);
  const reviewQuality = await call("read_quality_report", { project_id: project.snapshot.project.id });
  assert.equal(reviewQuality.editorial.status, "partial", "一轮观察不能冒充五轮完整审阅");
  assert.ok(Array.isArray(reviewQuality.productionReconciliation));
  assert.equal((await call("read_project", { project_id: project.snapshot.project.id })).revision.number, projectState.revision.number, "审片不得创建视频 Revision");
  await transport.close();
  transport = undefined;

  const beforeStop = await getRuntimeStatus(runtimeOptions);
  assert.equal(beforeStop.ready, true, "MCP 关闭后 Runtime 必须仍可复用");
  const stopped = await stopRuntime(runtimeOptions, { force: true });
  assert.equal(stopped.stopped, true, "运行器必须可停止");
  const afterStop = await getRuntimeStatus(runtimeOptions);
  assert.equal(afterStop.ready, false, "停止后 Runtime 不应继续可用");
  console.log("VideoFlowCut 插件 Runtime、Web 与 MCP E2E 验证通过。");
} catch (error) {
  // 保留失败现场摘要，避免 finally 清理隔离环境后只剩一条含糊的健康错误。
  const logName = runtimePort === 3100 ? "runtime.log" : `runtime-${runtimePort}.log`;
  const log = await readFile(join(workspaceRoot, ".videoflowcut-runtime", logName), "utf8").catch(() => "无运行日志");
  console.error(log.slice(-6_000));
  throw error;
} finally {
  if (transport) await transport.close().catch(() => undefined);
  await stopRuntime(runtimeOptions, { force: true }).catch(() => undefined);
  if (untrustedProcess?.pid && processIsAlive(untrustedProcess.pid)) untrustedProcess.kill();
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(installationRoot, { recursive: true, force: true });
}
