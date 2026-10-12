import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@videocut/application";
import type { MediaFact, MediaObservation, MediaSource } from "@videocut/contracts";
import { hashMediaFile } from "../packages/edit-application/src/media-intelligence.js";
import { assetRequestVersion, lexicalTokens, matchObservation, parseObservation, planWindows, uncoveredRanges } from "../packages/media-intelligence/src/index.js";
import { pruneMediaCache } from "../packages/media-intelligence/src/cache.js";

const source: MediaSource = { id: "source", projectId: "project", target: { assetId: "asset" }, identity: "original", hash: "hash", path: "source.mp4", kind: "video", durationMs: 600000, hasAudio: true, streams: [], createdAt: "2026-09-08" };
const fact = (modality: MediaFact["modality"], text: string, range = { startMs: 252000, endMs: 260000 }): MediaFact => ({ modality, text, range, basis: "human", precision: "reviewed", keywords: [] });
const observation = (...facts: MediaFact[]): MediaObservation => ({ id: "observation", projectId: source.projectId, sourceId: source.id, sourceHash: source.hash, range: { startMs: 252000, endMs: 262000 }, depth: "review", modalities: ["visual", "audio", "speech"], facts, unknowns: [], context: "", rawText: "原始响应", version: { workflowId: "workflow", schemaVersion: "v1", model: "model", prompt: "v1", preprocessing: "v1" }, jobId: "job", createdAt: "2026-09-08" });

test("长素材分窗覆盖后半段且重叠不重复计算；发现阶段间隙保持未覆盖", () => {
  const windows = planWindows(610000, "index");
  assert.equal(windows.at(-1)?.endMs, 610000);
  assert.deepEqual(uncoveredRanges({ startMs: 0, endMs: 610000 }, windows), []);
  const discovery = planWindows(610000, "discovery");
  assert.ok(discovery.some((range) => range.startMs >= 600000));
  assert.ok(uncoveredRanges({ startMs: 0, endMs: 610000 }, discovery).length > 0);
  assert.throws(() => planWindows(1000, "index", { startMs: 0, endMs: 2000 }));
});

test("八秒连续条件不能用不相连片段或整条时长拼凑", () => {
  const observed = observation(fact("visual", "海边特写", { startMs: 0, endMs: 4000 }), fact("visual", "海边特写", { startMs: 6000, endMs: 10000 }));
  const matches = matchObservation(source, observed, { query: "海边", modality: "visual", minDurationMs: 8000 });
  assert.equal(matches.length, 2);
  assert.ok(matches.every((match) => match.status === "rejected"));
});

test("画外旁白提到海浪不会被召回成海边画面", () => {
  const observed = observation(fact("visual", "办公室里的电脑"), fact("speech", "海浪拍打沙滩"));
  assert.equal(matchObservation(source, observed, { query: "海浪", modality: "visual" }).length, 0);
  assert.equal(matchObservation(source, observed, { query: "海浪", modality: "speech" }).length, 1);
  assert.ok(lexicalTokens("笔记本接口特写").has("接口"));
});

test("高相似度不能抵消真实人声；未分析原声不能判无人声", () => {
  const visual = fact("visual", "笔记本接口特写");
  const query = { query: "接口", modality: "visual" as const, minDurationMs: 6000, excludeSpeech: true };
  assert.equal(matchObservation(source, observation(visual), query, 0.99)[0].status, "insufficient");
  assert.equal(matchObservation(source, observation(visual, { ...fact("audio", "有人讲解"), speechPresence: "present" }), query, 0.99)[0].status, "rejected");
  const muted = matchObservation(source, observation(visual, { ...fact("audio", "有人讲解"), speechPresence: "present" }), { ...query, allowMute: true }, 0.99)[0];
  assert.equal(muted.status, "conditional");
  assert.ok(muted.conditions.includes("本次采用必须静音"));
});

test("无人声证据需覆盖同一个拟用范围；低密度视觉仍需连续性复核", () => {
  const visual = fact("visual", "海边画面");
  const shortAudio = { ...fact("audio", "只有浪声", { startMs: 252000, endMs: 255000 }), speechPresence: "absent" as const };
  const fragments = matchObservation(source, observation(visual, shortAudio), { query: "海边", modality: "visual", excludeSpeech: true });
  assert.equal(fragments[0].range?.endMs, 255000);
  assert.equal(fragments[1].status, "insufficient");
  assert.equal(matchObservation(source, observation({ ...visual, precision: "sampled" }), { query: "海边", modality: "visual", minDurationMs: 6000 })[0].status, "insufficient");
});

test("模型不合法格式和越界时间不能补成事实，精度由调用方限定", () => {
  assert.equal(parseObservation("这是普通文字", { startMs: 1000, endMs: 6000 }, ["audio"]).facts.length, 0);
  const raw = JSON.stringify({ facts: [{ modality: "audio", text: "电击声", startMs: 0, endMs: 10000 }, { modality: "visual", text: "红色页面", startMs: 500, endMs: 2000, precision: "reviewed" }] });
  const parsed = parseObservation(raw, { startMs: 1000, endMs: 6000 }, ["visual", "audio"]);
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0].precision, "sampled");
  assert.deepEqual(parsed.facts[0].range, { startMs: 1500, endMs: 3000 });
});

test("模型完整 JSON 后的单个多余右括号只作结构恢复，不补范围、排除条件或审阅结论", () => {
  const raw = JSON.stringify({ facts: [{ modality: "audio", text: "短促摩擦声", keywords: ["摩擦"] }], unknowns: [] });
  const parsed = parseObservation(`${raw}\n}`, { startMs: 0, endMs: 902 }, ["audio"]);
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0].range, undefined);
  assert.equal(parsed.facts[0].speechPresence, "unknown");
  assert.equal(parsed.facts[0].musicPresence, "unknown");
  assert.equal(parsed.facts[0].precision, "model_estimated");
  assert.ok(parsed.unknowns.some((entry) => entry.includes("多余") && entry.includes("原文")));
  for (const invalid of [`${raw}\n}根据用途补充`, `${raw}\n}}`, raw.slice(0, -1), `说明：${raw}`]) {
    assert.equal(parseObservation(invalid, { startMs: 0, endMs: 902 }, ["audio"]).facts.length, 0, "不能从任意坏输出中猜测可用对象");
  }
});

test("分析/观察不产生 Revision，纠错保留原文且不改变已用素材和视频版本", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-media-test-"));
  const app = createApplication(root);
  try {
    let state = app.createProject({ name: "隔离素材测试" });
    const projectId = state.snapshot.project.id;
    const assetId = "asset_fixture";
    const path = join(state.snapshot.project.rootPath, "assets", "source", "sample.wav");
    await mkdir(join(state.snapshot.project.rootPath, "assets", "source"), { recursive: true });
    await writeFile(path, "这里只测试源身份与事务，不冒充实际解码");
    const hash = await hashMediaFile(path);
    state = app.repository.commit(projectId, state.revision.number, "测试素材", (snapshot, impact) => {
      snapshot.assets.push({ id: assetId, name: "sample", kind: "audio", status: "ready", managedPath: path, sourceHash: hash, tags: [], metadata: { durationMs: 10000, hasAudio: true }, createdAt: source.createdAt });
      impact.changed.push(assetId);
    });
    const original = { ...source, projectId, hash, path, target: { assetId }, kind: "audio" as const, durationMs: 10000 };
    app.intelligence.store.saveSource(original);
    const observed = { ...observation({ ...fact("audio", "短促机械落定", { startMs: 0, endMs: 10000 }), speechPresence: "absent" as const }), projectId, sourceHash: hash, range: { startMs: 0, endMs: 10000 } };
    app.intelligence.store.saveObservation(observed);
    const job = await app.intelligence.submitAnalysis(projectId, { assetId, depth: "index", modalities: ["audio"], context: "" });
    const duplicate = await app.intelligence.submitAnalysis(projectId, { assetId, depth: "index", modalities: ["audio"], context: "" });
    assert.equal(job.id, duplicate.id);
    assert.equal(app.readProject(projectId).revision.number, state.revision.number);
    const corrected = app.intelligence.correct(projectId, { observationId: observed.id, facts: [{ ...observed.facts[0], text: "机械声后有微弱人声", speechPresence: "present" }], unknowns: [], reason: "实际复核发现尾音中含人声", author: "测试审阅", baseRevision: state.revision.number });
    assert.equal(corrected.revision, state.revision.number);
    assert.equal(app.readProject(projectId).snapshot.mediaAdoptions?.length ?? 0, 0);
    assert.equal(app.intelligence.store.observation(projectId, observed.id)?.rawText, "原始响应");
    assert.deepEqual(app.intelligence.store.observations(projectId).map((entry) => entry.id), [corrected.observation.id]);
    assert.equal(app.readProject(projectId).snapshot.assets[0].status, "ready");
  } finally { app.repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("纠错保留明确的证据来源与精度，模型抽帧不升级成人工连续复核且历史可追溯", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-observation-basis-")), app = createApplication(root);
  try {
    const state = app.createProject({ name: "观察来源审计回归" });
    const projectId = state.snapshot.project.id;
    app.intelligence.store.saveSource({ ...source, projectId });
    const original = { ...observation(fact("visual", "车站人群")), projectId };
    app.intelligence.store.saveObservation(original);
    let previous = original;
    for (const [basis, precision] of [["model", "sampled"], ["model", "reviewed"], ["measurement", "measured"], ["transcript", "provider_timed"], ["human", "reviewed"]] as const) {
      const corrected = app.intelligence.correct(projectId, { observationId: previous.id,
        facts: [{ ...fact("visual", "车站人群"), basis, precision }], unknowns: [], reason: "按实际观察核对证据来源和精度", author: `${basis}复核者` });
      const saved = app.intelligence.store.observation(projectId, corrected.observation.id)!;
      assert.equal(corrected.observation.facts[0].basis, basis);
      assert.equal(saved.facts[0].basis, basis);
      assert.equal(saved.facts[0].precision, precision);
      assert.equal(saved.supersedes, previous.id);
      assert.equal(saved.rawText, original.rawText);
      assert.deepEqual(app.intelligence.store.observation(projectId, previous.id), previous, "历史观察不可被就地改写");
      assert.equal(corrected.revision, state.revision.number, "无采用依赖的纠错不创建视频Revision");
      if (basis === "model") {
        const match = matchObservation(source, saved, { query: "车站", modality: "visual", minDurationMs: 6000 })[0];
        assert.equal(match.status, precision === "sampled" ? "insufficient" : "usable");
      }
      previous = saved;
    }
    assert.deepEqual(app.intelligence.store.observations(projectId).map(entry => entry.id), [previous.id]);
  } finally { app.repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("visual 需求与辅助观察不生成采用资格", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-visual-adopt-")), app = createApplication(root);
  try {
    let state = app.createProject({ name: "视觉采用协议回归" });
    const projectId = state.snapshot.project.id, path = join(state.snapshot.project.rootPath, "fixture.mp4");
    await writeFile(path, "只检验采用协议，不冒充真实视频解码");
    const hash = await hashMediaFile(path);
    state = app.repository.commit(projectId, state.revision.number, "模拟可播放视频", (snapshot) => {
      snapshot.assets.push({ id: "video", name: "视频范围测试", kind: "video", status: "ready", managedPath: "fixture.mp4", sourceHash: hash, tags: [], metadata: { durationMs: 10000, width: 1280, height: 720, hasAudio: true }, createdAt: "test" });
    });
    state = app.manageAssetRequirement({ projectId, baseRevision: state.revision.number, action: "create", mediaKind: "visual", role: "b_roll", title: "接口演示", purpose: "旁白继续时的视觉说明", visualBrief: "六秒完整操作", minDurationMs: 6000 });
    const request = state.snapshot.assetRequests[0];
    app.intelligence.store.saveSource({ ...source, projectId, hash, path, target: { assetId: "video" }, durationMs: 10000 });
    const observed = { ...observation(fact("visual", "协议确认的连续接口操作", { startMs: 0, endMs: 10000 })), projectId, sourceHash: hash, range: { startMs: 0, endMs: 10000 } };
    app.intelligence.store.saveObservation(observed);
    app.intelligence.store.saveObservation({ ...observed, id: "sampled", facts: observed.facts.map((fact) => ({ ...fact, precision: "sampled" })) });
    assert.equal(state.snapshot.assets[0].status, "ready");
    state = app.manageAssetRequirement({ projectId, baseRevision: state.revision.number, action: "update", assetRequestId: request.id, minDurationMs: 8000 });
    assert.equal(state.snapshot.mediaAdoptions?.length ?? 0, 0);
  } finally { app.repository.close(); await rm(root, { recursive: true, force: true }); }
});

test("真实模型混合标点只修结构；未知模态单独剔除且未定位事实不扩成全窗", () => {
  const raw = '{"facts":[{"modality":"audio","text":"一段清脆的铃声响起，音调较高。","keywords":["铃声"]},{"modality":"unknown","text":"来源无法确定。"}],"unknowns":["声音来源"]，“speechPresence”: “absent”}';
  const result = parseObservation(raw, { startMs: 10000, endMs: 15000 }, ["audio"]);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].range, undefined, "无定位信息不能填成整个五秒窗口");
  assert.equal(result.facts[0].speechPresence, "unknown", "顶层属性不能无依据套入每条事实");
  assert.ok(result.unknowns.length >= 2);
  assert.ok(result.facts[0].text.includes("，"), "事实文字中的标点原样保留");
});

test("声音排除条件按交集切片，不跨越未知区间拼出连续长度", () => {
  const audio = (startMs: number, endMs: number, presence: "absent" | "present") => ({ ...fact("audio", "声音条件", { startMs, endMs }), speechPresence: presence, musicPresence: "absent" as const });
  const observed = observation(fact("visual", "接口特写", { startMs: 0, endMs: 10000 }), audio(0, 3000, "absent"), audio(4000, 6000, "present"), audio(7000, 10000, "absent"));
  const result = matchObservation(source, observed, { query: "接口", modality: "visual", excludeSpeech: true, excludeMusic: true, minDurationMs: 5000 });
  assert.ok(result.every((entry) => entry.status !== "usable" && entry.status !== "conditional"));
  assert.ok(result.some((entry) => entry.reasons.some((reason) => reason.includes("实际含人声"))));
});

test("缓存预算保留历史/活动引用，仅清除模块内过期派生文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-cache-"));
  try {
    for (const name of ["protected", "expired"]) {
      await mkdir(join(root, "cache/mi", name), { recursive: true });
      const path = join(root, "cache/mi", name, "input.wav");
      await writeFile(path, "test"); await utimes(path, 0, 0);
    }
    const protectedPath = join(root, "cache/mi/protected/input.wav");
    const result = await pruneMediaCache(root, [protectedPath], { maxBytes: 4, reserveBytes: 0, maxAgeMs: 1 });
    assert.equal(result.removed.length, 1);
    assert.equal(await readFile(protectedPath, "utf8"), "test");
    await assert.rejects(pruneMediaCache(root, [protectedPath], { maxBytes: 1, reserveBytes: 0 }), /受保护/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
