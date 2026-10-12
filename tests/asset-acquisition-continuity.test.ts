import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "@videocut/application";
import { AssetProviderRegistry } from "@videocut/acquisition";
import { runProcess } from "@videocut/speech";
import type { MediaObservation, MediaSource } from "@videocut/contracts";
import { YoutubeProvider } from "../packages/asset-acquisition/src/youtube.js";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";

test("升级后只解除旧时长自动拒绝，人工与类型拒绝保持", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-duration-upgrade-"));
  const app = createApplication(root);
  try {
    const projectId = app.createProject({ name: "旧候选迁移" }).snapshot.project.id;
    const rev = () => app.readProject(projectId).revision.number;
    const request = app.manageAssetRequirement({ projectId, baseRevision: rev(), action: "create", title: "完整动作", purpose: "按实际内容选段", visualBrief: "主体可见", minDurationMs: 5000 }).snapshot.assetRequests[0];
    app.recordAssetSearch({ projectId, baseRevision: rev(), assetRequestId: request.id, provider: "youtube", query: "旧候选", candidates: [
      { originalAssetId: "abcdefghijk", name: "短片", kind: "video", sourceUrl: "https://youtu.be/abcdefghijk", durationMs: 2000 },
      { originalAssetId: "mnopqrstuvw", name: "人工拒绝", kind: "video", sourceUrl: "https://youtu.be/mnopqrstuvw" },
      { originalAssetId: "audio", name: "类型错误", kind: "audio", sourceUrl: "https://example.org/audio" }
    ] });
    const old = app.repository.mediaIntelligence.searches(projectId)[0];
    old.id = "legacy-search"; old.resultFormatVersion = 3;
    for (const c of old.candidates) { c.filterReasons.push("时长不足 5 秒。"); c.hardFilterPassed = false; c.status = "rejected"; c.rejectionReason = c.filterReasons.join(" "); }
    old.candidates[1].rejectionReason = "主体不符，不采用";
    app.repository.mediaIntelligence.saveSearch(old);
    assert.equal(app.readAssetCandidate({ projectId, assetCandidateId: old.candidates[0].id }).candidate.status, "available");
    const job = app.acquireAssetCandidate({ projectId, baseRevision: rev(), assetCandidateId: old.candidates[0].id });
    assert.equal(job.job.status, "queued");
    for (const c of old.candidates.slice(1)) assert.throws(() => app.acquireAssetCandidate({ projectId, baseRevision: rev(), assetCandidateId: c.id }), /可用|技术|画质/);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("范围获取保留时间对应和既有观察，分析纠错不影响原文件使用", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-range-evidence-"));
  const app = createApplication(root);
  try {
    const projectId = app.createProject({ name: "在线选段延续", profile: "visual_explainer" }).snapshot.project.id;
    const rev = () => app.readProject(projectId).revision.number;
    const fixture = join(root, "fixture.mp4");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=24:d=2", "-c:v", "libx264", fixture]);
    const request = app.manageAssetRequirement({ projectId, baseRevision: rev(), action: "create", title: "已定位动作", purpose: "直接延续线上选段", visualBrief: "动作范围已观察" }).snapshot.assetRequests[0];
    const provider = new YoutubeProvider(async (args, options) => {
      if (!options.directory) return JSON.stringify({ id: "abcdefghijk", title: "缺省时长的长视频" });
      assert.equal(args[args.indexOf("--download-sections") + 1], "*10-12");
      assert.ok(args.includes("--force-keyframes-at-cuts"));
      assert.equal(args[args.indexOf("-S") + 1], "res:2160,proto:m3u8");
      assert.ok(!args.includes("--max-filesize"), "范围取得不能用整片预计大小作准入限制");
      await copyFile(fixture, join(options.directory, "source.mp4"));
      return "";
    });
    const candidate = app.recordAssetSearch({ projectId, baseRevision: rev(), assetRequestId: request.id, provider: "youtube", query: "https://youtu.be/abcdefghijk", candidates: await provider.search({ request, query: "https://youtu.be/abcdefghijk" }) }).candidates[0];
    assert.equal(candidate.durationMs, undefined);
    const source: MediaSource = { id: "online-source", projectId, target: { candidateId: candidate.id }, identity: "preview", hash: "online-original-encoding", path: fixture, kind: "video", durationMs: 2000, hasAudio: false, streams: [], createdAt: new Date().toISOString() };
    const observation: MediaObservation = { id: "observed-action", projectId, sourceId: source.id, sourceHash: source.hash, range: { startMs: 0, endMs: 2000 }, depth: "review", modalities: ["visual"],
      facts: [{ modality: "visual", text: "夹具动作持续变化", range: { startMs: 0, endMs: 2000 }, basis: "human", precision: "reviewed", keywords: ["动作"] }], unknowns: ["原声没有观察"], context: "已选动作与下一镜接续", rawText: "测试夹具观察", version: { workflowId: "fixture", schemaVersion: "1", model: "fixture", prompt: "fixture", preprocessing: "fixture" }, jobId: "fixture", createdAt: source.createdAt };
    app.repository.mediaIntelligence.saveSource(source); app.repository.mediaIntelligence.saveObservation(observation);
    const options = { qualityHeight: 2160, sourceRange: { startMs: 10000, endMs: 12000 } };
    const queued = app.acquireAssetCandidate({ projectId, baseRevision: rev(), assetCandidateId: candidate.id, options });
    assert.equal(app.acquireAssetCandidate({ projectId, baseRevision: 1, assetCandidateId: candidate.id, options }).job.id, queued.job.id);
    const beforeConflict = rev();
    assert.throws(() => app.acquireAssetCandidate({ projectId, baseRevision: rev(), assetCandidateId: candidate.id, options: { ...options, sourceRange: { startMs: 12000, endMs: 14000 } } }), /未结束/);
    assert.equal(rev(), beforeConflict);
    const processor = createMediaJobProcessor(app, undefined, new AssetProviderRegistry([provider]));
    await runOneJob(app, processor);
    const completed = app.trackJob(queued.job.id);
    assert.equal(completed.status, "succeeded", completed.error);
    const asset = app.readProject(projectId).snapshot.assets[0];
    assert.equal(asset.status, "ready"); assert.equal(asset.metadata?.durationMs, 2000);
    assert.deepEqual(asset.provenance?.acquisition?.sourceRange, options.sourceRange);
    assert.deepEqual(completed.result?.localRange, { startMs: 0, endMs: 2000 });
    assert.deepEqual(completed.result?.observations, [observation]);
    const read = app.intelligence.inspect(projectId, { assetId: asset.id });
    assert.equal(read.candidateEvidence[0].observations[0].context, observation.context);
    assert.equal(app.readAssetCandidate({ projectId, assetCandidateId: candidate.id }).candidate.durationMs, undefined, "不能用片段长度覆盖原片未知长度");
    const beforeCorrection = rev();
    assert.deepEqual(app.repository.mediaIntelligence.observation(projectId, observation.id), observation, "不得伪造本地观察替换原证据");
    app.intelligence.correct(projectId, { observationId: observation.id, facts: observation.facts, unknowns: ["原声未知"], reason: "测试纠错后需要重新确认当前用途", author: "测试", baseRevision: rev() });
    assert.equal(rev(), beforeCorrection);
    assert.equal(app.readProject(projectId).snapshot.mediaAdoptions?.length ?? 0, 0);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("范围返回整文件或残片时获取失败，不登记错误的源时间", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-range-invalid-")); const app = createApplication(root);
  try {
    const projectId = app.createProject({ name: "时间错位拒绝" }).snapshot.project.id;
    const rev = () => app.readProject(projectId).revision.number;
    const fixture = join(root, "fixture.mp4");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=s=64x64:r=24:d=1", "-c:v", "libx264", fixture]);
    const request = app.manageAssetRequirement({ projectId, baseRevision: rev(), action: "create", title: "三秒动作", purpose: "测试范围", visualBrief: "持续变化" }).snapshot.assetRequests[0];
    const candidate = app.recordAssetSearch({ projectId, baseRevision: rev(), assetRequestId: request.id, provider: "youtube", query: "range-invalid", candidates: [{ originalAssetId: "abcdefghijk", name: "源", kind: "video", sourceUrl: "https://youtu.be/abcdefghijk" }] }).candidates[0];
    const provider = new YoutubeProvider(async (_args, options) => { await copyFile(fixture, join(options.directory!, "source.mp4")); return ""; });
    const queued = app.acquireAssetCandidate({ projectId, baseRevision: rev(), assetCandidateId: candidate.id, options: { sourceRange: { startMs: 1000, endMs: 4000 } } });
    await runOneJob(app, createMediaJobProcessor(app, undefined, new AssetProviderRegistry([provider])));
    assert.equal(app.trackJob(queued.job.id).status, "failed");
    assert.match(app.trackJob(queued.job.id).error ?? "", /范围不一致/);
    assert.equal(app.readProject(projectId).snapshot.assets.length, 0);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
