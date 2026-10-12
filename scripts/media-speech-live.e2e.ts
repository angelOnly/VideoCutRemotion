import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createApplication } from "@videocut/application";
import { createMediaAsset } from "@videocut/domain";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import { probeMedia, runProcess } from "@videocut/speech";
import { readRuntimeConfig } from "@videocut/project-overview";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { hashMediaFile } from "../packages/edit-application/src/media-intelligence.js";

const source = process.argv[process.argv.indexOf("--source") + 1];
if (!process.argv.includes("--source") || !source) throw new Error("提供获准的测试源文件 --source；仅写新建隔离工作区");
const output = resolve(".candidate/media-intelligence-20260908", `speech-${Date.now()}`);
await mkdir(output, { recursive: true });
const app = createApplication(join(output, "workspace"));
try {
  let state = app.createProject({ name: "真实原声与 ASR 隔离联调", profile: "presenter_motion" });
  const id = state.snapshot.project.id, path = join(state.snapshot.project.rootPath, "assets/source.wav");
  await mkdir(join(state.snapshot.project.rootPath, "assets"), { recursive: true });
  await runProcess("ffmpeg", ["-hide_banner", "-y", "-i", resolve(source), "-t", "6", "-vn", "-ar", "48000", "-ac", "1", path]);
  const asset = createMediaAsset({ name: "用户提供研究视频的前六秒原声", kind: "audio", managedPath: "assets/source.wav", role: "voice_reference", sourceHash: await hashMediaFile(path) });
  Object.assign(asset, { status: "ready", metadata: await probeMedia(path) });
  state = app.repository.commit(id, state.revision.number, "隔离测试输入", (snapshot) => snapshot.assets.push(asset));
  const processor = createMediaJobProcessor(app, new ComfyUIBridgeClient(readRuntimeConfig().bridge.apiBaseUrl));
  const job = await app.intelligence.submitAnalysis(id, { assetId: asset.id, range: { startMs: 0, endMs: 6000 }, depth: "review", modalities: ["audio", "speech"], context: "只分析输入原声，语音时间须由真实 ASR 返回" });
  await runOneJob(app, processor);
  const result = app.trackJob(job.id), observations = app.intelligence.inspect(id, { assetId: asset.id });
  await writeFile(join(output, "report.json"), JSON.stringify({ job: result, observations, sourceHash: asset.sourceHash, note: "真实外部 HTTP、原声音轨与 ASR；不代表人类逐字校对或听感验收" }, null, 2));
  assert.equal(result.status, "succeeded", result.error);
  assert.ok(observations.observations.some((observation) => observation.speechEvidence?.runId && observation.facts.some((fact) => fact.modality === "speech" && fact.precision === "provider_timed")));
  assert.equal(app.readProject(id).revision.number, state.revision.number, "分析不应改创作版本");
  console.log(`真实 ASR 证据：${join(output, "report.json")}`);
} finally { app.repository.close(); }
