import assert from "node:assert/strict";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createApplication } from "@videocut/application";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import { readRuntimeConfig } from "@videocut/project-overview";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";

const reportPath = await realpath(resolve(process.argv[2] ?? ""));
const allowed = await realpath(resolve(".candidate/media-intelligence-20260908"));
if (relative(allowed, reportPath).startsWith("..")) throw new Error("只恢复本轮隔离验收报告的任务");
const prior = JSON.parse(await readFile(reportPath, "utf8"));
const app = createApplication(join(dirname(reportPath), "workspace"));
try {
  const bridge = new ComfyUIBridgeClient(readRuntimeConfig().bridge.apiBaseUrl);
  let postCount = 0; const submit = bridge.createRunWithSchemaRetry.bind(bridge);
  bridge.createRunWithSchemaRetry = async (...args) => { postCount++; return submit(...args); };
  const before = app.readProject(prior.job.projectId).revision.number;
  const retry = app.intelligence.retry(prior.job.projectId, prior.job.id);
  await runOneJob(app, createMediaJobProcessor(app, bridge));
  const job = app.trackJob(retry.id), observations = app.intelligence.inspect(job.projectId, prior.job.payload.input);
  await writeFile(join(dirname(reportPath), "resume-report.json"), JSON.stringify({ job, observations, postCount, note: "仅重读已有 HTTP run 和原文，未重复推理提交；保留原始失败证据" }, null, 2));
  assert.equal(job.status, "succeeded", job.error); assert.equal(postCount, 0);
  assert.equal(app.readProject(job.projectId).revision.number, before);
  assert.ok(observations.observations.some((observation) => observation.speechEvidence && observation.facts.some((fact) => fact.modality === "speech" && fact.precision === "provider_timed")));
  console.log(`恢复通过，POST 数=${postCount}；${join(dirname(reportPath), "resume-report.json")}`);
} finally { app.repository.close(); }
