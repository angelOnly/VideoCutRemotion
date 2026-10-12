import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createApplication } from "@videocut/application";
import { createDefaultAssetProviderRegistry } from "@videocut/acquisition";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";

// 公网验证只取一个正式原文件；独立临时工程不接触生产数据库与用户视频。
const root = await mkdtemp(resolve(".candidate/sound-acquisition-"));
const app = createApplication(root);
try {
  const project = app.createProject({ name: "在线音效隔离验证", profile: "presenter_motion" });
  const projectId = project.snapshot.project.id;
  const rev = () => app.readProject(projectId).revision.number;
  const state = app.manageAssetRequirement({ projectId, baseRevision: rev(), action: "create", title: "界面短提示候选", purpose: "仅验证合法获取、许可和媒体链，不作听感选择", mediaKind: "audio", audioBrief: "公开界面音效候选", role: "sfx" });
  const request = state.snapshot.assetRequests[0];
  const providers = createDefaultAssetProviderRegistry();
  const candidates = await providers.get("mixkit").search({ request, query: "interface" });
  assert.ok(candidates.length > 1);
  const result = app.recordAssetSearch({ projectId, baseRevision: rev(), assetRequestId: request.id, provider: "mixkit", query: "interface", candidates });
  const acquired = app.acquireAssetCandidate({ projectId, baseRevision: rev(), assetCandidateId: result.candidates[0].id });
  const processor = createMediaJobProcessor(app, undefined, providers);
  await runOneJob(app, processor);
  const job = app.trackJob(acquired.job.id);
  assert.equal(job.status, "succeeded", job.error);
  await runOneJob(app, processor);
  const asset = app.readProject(projectId).snapshot.assets[0];
  assert.equal(asset.kind, "audio"); assert.equal(asset.status, "ready"); assert.equal(asset.metadata?.hasAudio, true);
  assert.ok(asset.metadata!.durationMs > 0); assert.equal(asset.provenance?.provider, "mixkit");
  console.log(JSON.stringify({ workspace: root, projectId, candidates: candidates.length, file: resolve(app.readProject(projectId).snapshot.project.rootPath, asset.managedPath), metadata: asset.metadata, provenance: asset.provenance, listening: "未完成真实审听，不能声称音色/匹配通过" }, null, 2));
} finally { app.repository.close(); }
