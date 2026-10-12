import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@videocut/application";
import { AssetProviderRegistry, MockAssetProvider } from "@videocut/acquisition";
import { assetRequestVersion } from "../packages/media-intelligence/src/index.js";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import type { AssetRequest } from "@videocut/contracts";
import { ComfyUIBridgeClient, type BridgeWorkflow } from "@videocut/bridge";
import { readRuntimeConfig } from "@videocut/project-overview";
import { runSoundRanking } from "../apps/job-worker/src/sound-ranking.js";

const source = (id: string) => ({ originalAssetId: id, name: "同名材料", kind: "image" as const, sourceUrl: `https://example.test/${id}` });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vfc-search-lifecycle-"));
  const app = createApplication(root);
  const projectId = app.createProject({ name: "素材生命周期隔离测试" }).snapshot.project.id;
  const read = () => app.readProject(projectId);
  const revision = () => read().revision.number;
  const request = app.manageAssetRequirement({ projectId, baseRevision: revision(), action: "create", title: "表达需求", purpose: "补充当前讲述", visualBrief: "不同内容可以参与", queryHints: [] }).snapshot.assetRequests[0];
  const update = (input: Partial<AssetRequest>) => app.manageAssetRequirement({ projectId, baseRevision: revision(), action: "update", assetRequestId: request.id, ...input });
  const close = (outcome: "completed" | "cancelled" = "cancelled") => app.manageAssetRequirement({ projectId, baseRevision: revision(), action: "close", assetRequestId: request.id, closeOutcome: outcome, closeReason: outcome === "completed" ? "作者确认材料已接住用途" : "取消当前用途" });
  const search = (query: string, ids = ["one", "two"]) => app.recordAssetSearch({ projectId, baseRevision: revision(), assetRequestId: request.id, provider: "mock", query, candidates: ids.map(source) });
  const acquire = (id: string, baseRevision = revision(), idempotencyKey?: string) => app.acquireAssetCandidate({ projectId, baseRevision, assetCandidateId: id, idempotencyKey });
  return { root, app, projectId, request, read, revision, update, close, search, acquire, cleanup: async () => { app.close(); await rm(root, { recursive: true, force: true }); } };
}

test("开放需求不补默认比例；相同或不同内容更新均保留会话和已提升候选", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.request.queryHints, []);
    assert.equal(f.request.targetAspectRatio, undefined);
    const found = f.search("作者的实际查询");
    assert.equal(found.candidates.length, 2, "不能以同名标题去重不同文件");
    const acquired = f.acquire(found.candidates[0].id);
    const fields: Partial<AssetRequest>[] = [
      { purpose: f.request.purpose }, { purpose: "新的表达" }, { visualBrief: "调整构图" }, { queryHints: ["新线索"] },
      { role: "evidence" }, { targetAspectRatio: "1:1" }, { minDurationMs: 6000 }, { excludedTerms: ["不用于这轮查询"] }
    ];
    for (const patch of fields) {
      f.update(patch);
      assert.equal(f.read().snapshot.assetRequests[0].status, "acquiring");
      assert.equal(f.app.readAssetCandidate({ projectId: f.projectId, assetCandidateId: found.candidates[1].id }).candidate.status, "available");
      assert.equal(f.read().snapshot.assetCandidates[0].status, "acquisition_queued");
      assert.deepEqual(f.app.trackJob(acquired.job.id).payload, JSON.parse(JSON.stringify(acquired.job.payload)));
    }
    assert.equal(f.acquire(found.candidates[0].id, 1).job.id, acquired.job.id, "同输入读取原任务无需重新写入");
    assert.throws(() => f.acquire(found.candidates[1].id, found.state.revision.number), /Revision/);
    assert.throws(() => f.acquire(found.candidates[1].id, f.revision(), acquired.job.idempotencyKey), /幂等键/);
  } finally { await f.cleanup(); }
});

for (const closed of [false, true]) test(`迟到搜索保存发出时的真实输入，关闭=${closed}`, async () => {
  const f = await fixture();
  try {
    const issuedRevision = f.revision(), issuedRequest = structuredClone(f.request);
    f.update({ purpose: "新的内容", queryHints: ["另一条线索"] });
    if (closed) f.close();
    const before = f.revision();
    const result = f.app.recordAssetSearch({ projectId: f.projectId, baseRevision: issuedRevision, assetRequestId: f.request.id, provider: "mock", query: "原查询", requestVersion: assetRequestVersion(issuedRequest), requestSnapshot: issuedRequest, candidates: [source("late")] });
    const session = f.app.repository.mediaIntelligence.searches(f.projectId)[0];
    assert.deepEqual(session.requestSnapshot, JSON.parse(JSON.stringify(issuedRequest)));
    assert.equal(result.requestVersion, assetRequestVersion(issuedRequest));
    assert.equal(result.intent.query, "原查询");
    assert.equal(f.revision(), before);
    assert.equal(f.read().snapshot.assetRequests[0].status, closed ? "closed" : "candidates_ready");
    assert.deepEqual(f.app.listJobs(f.projectId), []);
    if (closed) assert.throws(() => f.acquire(result.candidates[0].id), /用途已关闭/);
    else assert.equal(f.acquire(result.candidates[0].id).job.status, "queued");
    assert.throws(() => f.app.recordAssetSearch({ projectId: f.projectId, baseRevision: issuedRevision, assetRequestId: f.request.id, provider: "mock", query: "错误快照", requestSnapshot: issuedRequest, requestVersion: "错误指纹", candidates: [] }), /快照与需求版本/);
  } finally { await f.cleanup(); }
});

test("两天前会话可按最新 Revision 获取，发现路径保留且不要求重新搜索", async () => {
  const f = await fixture();
  try {
    const found = f.search("旧查询");
    const session = f.app.repository.mediaIntelligence.searches(f.projectId)[0];
    session.id = "old-session";
    session.createdAt = new Date(Date.now() - 48 * 3600_000).toISOString();
    f.app.repository.mediaIntelligence.saveSearch(session);
    f.update({ purpose: "已改稿" });
    const next = f.search("新查询");
    assert.notEqual(next.sessionId, found.sessionId);
    assert.notEqual(next.candidates[0].id, found.candidates[0].id);
    assert.equal(f.acquire(found.candidates[0].id).candidate.originalAssetId, "one");
    assert.equal(f.app.repository.mediaIntelligence.searches(f.projectId).length, 3);
  } finally { await f.cleanup(); }
});

for (const closed of [false, true]) for (const fails of [false, true]) test(`在途改稿后 Worker 固定输入，关闭=${closed}，失败=${fails}`, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "source.png");
    await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const provider = new MockAssetProvider([{ ...source("one"), name: "source.png", filePath: path }]);
    const found = f.search("先取得供比较");
    const queued = f.acquire(found.candidates[0].id);
    const download = provider.download.bind(provider);
    provider.download = async input => {
      assert.deepEqual(input.candidate, JSON.parse(JSON.stringify(queued.job.payload.candidate)));
      f.update({ purpose: "下载期间改稿", role: "evidence", queryHints: ["新增查询词"], targetAspectRatio: "1:1" });
      if (closed) f.close();
      if (fails) throw new Error("测试来源文件读取失败");
      return download(input);
    };
    await runOneJob(f.app, createMediaJobProcessor(f.app, undefined, new AssetProviderRegistry([provider])));
    const job = f.app.trackJob(queued.job.id);
    assert.equal(job.status, fails ? "failed" : "succeeded", job.error);
    const state = f.read();
    assert.equal(state.snapshot.assetRequests[0].status, closed ? "closed" : "candidates_ready", "未提升的另一候选也计入进度");
    assert.equal(state.snapshot.assetCandidates[0].status, fails ? "failed" : "acquired");
    assert.equal(state.snapshot.assets.length, fails ? 0 : 1);
    assert.equal(state.snapshot.timeline.items.length, 0);
    if (!fails) {
      assert.equal(state.snapshot.assets[0].role, "b_roll", "下载结果保留提交时用途标签，不偷换为新角色");
      assert.ok(!state.snapshot.assets[0].tags.includes("新增查询词"));
      f.app.failAssetCandidateAcquisition({ projectId: f.projectId, assetCandidateId: found.candidates[0].id, jobId: job.id, reason: "迟到失败" });
      assert.equal(f.read().snapshot.assetCandidates[0].status, "acquired");
      if (!closed) assert.equal(f.close("completed").snapshot.assetRequests[0].closeOutcome, "completed");
    } else assert.match(state.snapshot.assetCandidates[0].acquisitionError!, /测试来源文件/);
  } finally { await f.cleanup(); }
});

test("关闭完成需实际材料，取消不需下载；历史 fulfilled 不自动重开", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.close("completed"), /实际取得/);
    f.search("只有候选");
    assert.throws(() => f.close("completed"), /实际取得/);
    f.app.repository.commit(f.projectId, f.revision(), "测试历史获取状态", snapshot => { snapshot.assetRequests[0].status = "fulfilled"; });
    assert.equal(f.read().snapshot.assetRequests[0].status, "fulfilled");
    assert.equal(f.close().snapshot.assetRequests[0].status, "closed");
  } finally { await f.cleanup(); }
});

test("多个在途任务独立收口，失败遮盖同 ID 的会话副本，无替代时回到 open", async () => {
  const f = await fixture();
  try {
    const found = f.search("两份待取得材料");
    const first = f.acquire(found.candidates[0].id), second = f.acquire(found.candidates[1].id);
    f.app.failAssetCandidateAcquisition({ projectId: f.projectId, assetCandidateId: first.candidate.id, jobId: first.job.id, reason: "首份来源失效" });
    assert.equal(f.read().snapshot.assetRequests[0].status, "acquiring");
    f.app.failAssetCandidateAcquisition({ projectId: f.projectId, assetCandidateId: second.candidate.id, jobId: second.job.id, reason: "另一来源失效" });
    assert.equal(f.read().snapshot.assetRequests[0].status, "open", "旧会话的 available 副本不能掩盖真实失败");
  } finally { await f.cleanup(); }
});

test("成功回调仍拒绝不同来源或范围，创意解耦不允许错文件登记", async () => {
  const f = await fixture();
  try {
    const candidate = f.search("来源核验").candidates[0];
    const queued = f.acquire(candidate.id);
    f.app.repository.commit(f.projectId, f.revision(), "模拟身份错误", snapshot => { snapshot.assetCandidates[0].originalAssetId = "other-file"; });
    assert.throws(() => f.app.completeAssetAcquisition({ projectId: f.projectId, assetCandidateId: candidate.id, jobId: queued.job.id, name: "source.png", managedPath: "assets/source/source.png", sourceHash: "a".repeat(64) }), /来源或取得范围/);
    assert.deepEqual(f.read().snapshot.assets, []);
  } finally { await f.cleanup(); }
});

test("旧策略迁移仅恢复单一自动原因，混合、人工与技术拒绝保留历史", async () => {
  const f = await fixture();
  try {
    const reason = "素材需求已更新，必须重新搜索并复核候选。";
    const found = f.search("旧记录", ["auto", "mixed", "manual", "broken"]);
    const old = f.app.repository.mediaIntelligence.searches(f.projectId)[0];
    old.id = "legacy-rejections";
    old.resultFormatVersion = 4;
    old.candidates.forEach((candidate, index) => {
      candidate.status = "rejected";
      candidate.filterReasons = index === 1 ? [reason, "作者不采用"] : index === 2 ? ["作者不采用"] : [reason];
      candidate.rejectionReason = index === 2 ? "作者不采用" : reason;
      candidate.hardFilterPassed = false;
      if (index === 3) candidate.sourceUrl = "";
    });
    f.app.repository.mediaIntelligence.saveSearch(old);
    f.app.repository.commit(f.projectId, f.revision(), "模拟旧快照", snapshot => { snapshot.assetCandidates.push(...structuredClone(old.candidates)); snapshot.searchIntents.push(old.intent); });
    const before = f.revision();
    for (const list of [f.read().snapshot.assetCandidates, f.app.repository.mediaIntelligence.searches(f.projectId)[0].candidates]) {
      assert.deepEqual(list.map(candidate => candidate.status), ["available", "rejected", "rejected", "rejected"]);
      assert.equal(list[0].strategyMigration?.outcome, "restored");
      assert.deepEqual(list[0].strategyMigration?.filterReasons, [reason]);
      assert.equal(list[1].strategyMigration?.outcome, "retained_mixed");
      assert.equal(list[2].strategyMigration, undefined);
      assert.equal(list[3].strategyMigration?.outcome, "retained_mixed");
    }
    assert.equal(f.revision(), before, "只读兼容不产生视频 Revision");
    for (const candidate of found.candidates.slice(1)) assert.throws(() => f.acquire(candidate.id), /可用候选/);
    assert.equal(f.acquire(found.candidates[0].id).job.status, "queued");
  } finally { await f.cleanup(); }
});

test("同需求旧声音候选可按当前内容重排，不把旧搜索版本当素材资格", async () => {
  const f = await fixture();
  try {
    const request = f.app.manageAssetRequirement({ projectId: f.projectId, baseRevision: f.revision(), action: "create", title: "声音", purpose: "原段落", mediaKind: "audio", audioBrief: "一段提示音", role: "sfx", fallbackPlan: "ask_user" }).snapshot.assetRequests.at(-1)!;
    const found = f.app.recordAssetSearch({ projectId: f.projectId, baseRevision: f.revision(), assetRequestId: request.id, provider: "mixkit", query: "提示音", candidates: [{ originalAssetId: "1", sourceUrl: "https://mixkit.co/free-sound-effects/", name: "提示音", kind: "audio" }] });
    const state = f.app.manageAssetRequirement({ projectId: f.projectId, baseRevision: f.revision(), action: "update", assetRequestId: request.id, purpose: "新的段落作用" });
    const current = state.snapshot.assetRequests.at(-1)!;
    assert.notEqual(found.requestVersion, assetRequestVersion(current));
    const config = readRuntimeConfig(), bridge = new ComfyUIBridgeClient(config.bridge.apiBaseUrl);
    const workflow: BridgeWorkflow = { id: config.semantic.embeddingWorkflowId, schemaVersion: "test-v1", name: "测试编码", available: true, fields: ["texts_json", "mode", "instruction"].map(id => ({ id, label: id, kind: "text", required: false })), itemSlots: [], outputs: [] };
    const vectors = new Map<string, number[][]>();
    bridge.getWorkflow = async () => workflow;
    bridge.createRunWithSchemaRetry = async (_id, build) => {
      const request = await build(workflow), texts = JSON.parse(String(request.fieldValues.texts_json)) as string[], id = `sound-${vectors.size}`;
      vectors.set(id, texts.map(() => [1, ...Array<number>(1023).fill(0)]));
      return { workflow, request, schemaRetryCount: 0, run: { id, status: "queued", outputs: [] } };
    };
    bridge.waitForRun = async id => ({ id, status: "succeeded", outputs: [{ outputSlotId: "result", kind: "text", displayName: "向量", text: JSON.stringify({ embeddings: vectors.get(id) }) }] });
    const job = f.app.repository.createJob({ projectId: f.projectId, kind: "sound_ranking", idempotencyKey: "old-candidate-ranking", payload: { assetRequestId: request.id, requestVersion: assetRequestVersion(current), candidateIds: found.candidates.map(candidate => candidate.id), analyzeTop: 0, modelConfig: { ...config.semantic, apiBaseUrl: config.bridge.apiBaseUrl } } });
    const result = await runSoundRanking(f.app, job, bridge);
    assert.equal(result.ranked[0].candidateId, found.candidates[0].id);
    assert.equal(result.ranked[0].audioVerified, false);
  } finally { await f.cleanup(); }
});
