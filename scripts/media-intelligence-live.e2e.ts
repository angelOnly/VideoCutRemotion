import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createApplication } from "@videocut/application";
import { createMediaAsset } from "@videocut/domain";
import { createDefaultAssetProviderRegistry } from "@videocut/acquisition";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import { probeMedia, runProcess } from "@videocut/speech";
import { readRuntimeConfig } from "@videocut/project-overview";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { hashMediaFile } from "../packages/edit-application/src/media-intelligence.js";
import type { Asset, MediaModality } from "@videocut/contracts";

// 只允许每次新建的隔离测试工作区，不接入用户正式项目或生产队列。
const output = resolve(".candidate", "media-intelligence-20260908", `live-${Date.now()}`);
await mkdir(output, { recursive: true });
const app = createApplication(join(output, "workspace"));
const created = app.createProject({ name: "公共声画理解隔离验收", profile: "presenter_motion" });
const projectId = created.snapshot.project.id;
const assetsRoot = join(created.snapshot.project.rootPath, "assets", "source");
await mkdir(assetsRoot, { recursive: true });
const providers = createDefaultAssetProviderRegistry();
const bridge = new ComfyUIBridgeClient(readRuntimeConfig().bridge.apiBaseUrl);
const processor = createMediaJobProcessor(app, bridge, providers);
const reports: Array<Record<string, unknown>> = [];
async function record(value: Record<string, unknown>) {
  reports.push(value); await writeFile(join(output, "report.json"), JSON.stringify({ projectId, output, reports, note: "真实 HTTP/媒体测试；模型描述不等于实际听感通过" }, null, 2)); console.log(JSON.stringify({ name: value.name, status: (value.job as { status?: string } | undefined)?.status, error: value.error, output }));
}
async function add(name: string, kind: Asset["kind"]) {
  const path = join(assetsRoot, name), sourceHash = await hashMediaFile(path);
  const metadata = kind === "document" ? { durationMs: 0, hasAudio: false } : await probeMedia(path);
  const asset = createMediaAsset({ name, kind, managedPath: path, sourceHash, role: kind === "audio" ? "sfx" : "b_roll" });
  Object.assign(asset, { metadata, status: "ready" });
  const state = app.readProject(projectId);
  app.repository.commit(projectId, state.revision.number, "登记隔离验收素材", (snapshot) => snapshot.assets.push(asset));
  return asset;
}
async function analyze(asset: Asset, modalities: MediaModality[]) {
  const before = app.readProject(projectId).revision.number;
  const job = await app.intelligence.submitAnalysis(projectId, { assetId: asset.id, depth: "review", modalities, context: "只描述实际输入，测试内容不提供给模型作为答案。" });
  await runOneJob(app, processor);
  const latest = app.trackJob(job.id);
  await record({ name: asset.name, job: latest, observations: app.intelligence.inspect(projectId, { assetId: asset.id }), revisionUnchanged: app.readProject(projectId).revision.number === before });
  return latest;
}
try {
  if (!process.argv.includes("--online-only")) {
  await runProcess("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "48000", join(assetsRoot, "tone.wav")], 120000);
  await runProcess("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=25:d=3", "-itsoffset", "0.7", "-i", join(assetsRoot, "tone.wav"), "-t", "3", "-c:v", "libx264", "-c:a", "aac", join(assetsRoot, "offset.mp4")], 120000);
  await runProcess("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240", "-frames:v", "1", join(assetsRoot, "red.png")], 120000);
  // 极小的可核验 PDF，避免依赖安装额外文档库。
  const content = "BT /F1 24 Tf 40 100 Td (TEST PAGE 1) Tj ET\n";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
  let pdf = "%PDF-1.4\n"; const positions = [0];
  objects.forEach((object, index) => { positions.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${positions.slice(1).map((p) => `${String(p).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(join(assetsRoot, "page.pdf"), pdf);
  for (const [name, kind, modalities] of [["tone.wav", "audio", ["audio"]], ["offset.mp4", "video", ["visual", "audio"]], ["red.png", "image", ["visual", "text"]], ["page.pdf", "document", ["visual", "text"]]] as const) {
    await analyze(await add(name, kind), [...modalities]);
  }
  const search = app.intelligence.submitSearch(projectId, { query: "红色画面", modality: "visual" });
  await runOneJob(app, processor); await record({ name: "Qwen 事实与查询检索", job: app.trackJob(search.id) });
  }
  for (const [provider, query, role] of [["mixkit", "interface", "sfx"], ["mixkit_music", "cinematic", "bgm"]] as const) {
    try {
      const requested = app.manageAssetRequirement({ projectId, baseRevision: app.readProject(projectId).revision.number, action: "create", title: `真实在线${role}验收`, purpose: "隔离技术验收", mediaKind: "audio", audioBrief: role === "sfx" ? "短促界面反馈，无人声" : "器乐背景，无演唱", role });
      const request = requested.snapshot.assetRequests.at(-1)!;
      const candidates = await providers.get(provider).search({ request, query });
      const search = app.recordAssetSearch({ projectId, baseRevision: requested.revision.number, assetRequestId: request.id, provider, query, candidates });
      const candidate = search.candidates.find((entry) => entry.hardFilterPassed);
      if (!candidate) throw new Error("没有可合法获取的候选");
      const acquired = app.acquireAssetCandidate({ projectId, baseRevision: app.readProject(projectId).revision.number, assetCandidateId: candidate.id });
      await runOneJob(app, processor); await runOneJob(app, processor);
      const asset = app.readProject(projectId).snapshot.assets.find((asset) => asset.provenance?.originalAssetId === candidate.originalAssetId && asset.provenance?.provider === provider);
      await record({ name: `${provider}真实搜索与原文件`, count: candidates.length, job: app.trackJob(acquired.job.id), asset });
      if (asset && role === "sfx") await analyze(asset, ["audio"]);
    } catch (error) { await record({ name: provider, error: String(error) }); }
  }
  if (reports.some((entry) => entry.error || entry.job && (entry.job as { status: string }).status !== "succeeded")) process.exitCode = 1;
} finally { app.repository.close(); console.log(`验收报告：${join(output, "report.json")}`); }
