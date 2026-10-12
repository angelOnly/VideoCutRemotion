import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createScene } from "@videocut/domain";
import { createApplication } from "@videocut/application";
import { probeMedia, runProcess } from "@videocut/speech";
import { hashMediaFile, renderedAnalysisSource } from "../packages/edit-application/src/media-intelligence.js";
import { analysisInputSchema } from "../packages/media-intelligence/src/index.js";

test("成片复核绑定真实导出哈希，不导入素材或产生Revision，替换/跨项目/越界均拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-output-review-")), app = createApplication(root);
  try {
    const state = app.createProject({ name: "隔离成片复核" }), id = state.snapshot.project.id;
    const current = app.repository.commit(id, 1, "测试时间线", (snapshot) => { snapshot.timeline.fps = 24; snapshot.scenes.push(Object.assign(createScene({type:"ExplainerScene",title:"测试",purpose:"工程验证",startFrame:0,endFrame:48}), { status: "ready" as const })); });
    const path = join(state.snapshot.project.rootPath, "exports", "test.mp4");
    await mkdir(join(state.snapshot.project.rootPath, "exports"), { recursive: true });
    await runProcess("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=500:duration=2.08", "-c:v", "libx264", "-c:a", "aac", path]);
    const job = app.repository.createJob({ projectId: id, kind: "export", payload: { revision: current.revision.number }, idempotencyKey: "fixture-output" });
    app.updateJob(job.id, { status: "succeeded", result: { path } });
    const artifact = app.registerExportArtifact({ id: "artifact-review-test", projectId: id, revision: current.revision.number, jobId: job.id, purpose: "delivery", relativePath: "exports/test.mp4", fileHash: await hashMediaFile(path), fileSizeBytes: (await stat(path)).size, createdAt: new Date().toISOString(), preflight: {} as any, validation: {} as any, sourceManifest: {} as any });
    const input = { exportArtifactId: artifact.id, depth: "review" as const, modalities: ["audio" as const], context: "检查起音与尾音" };
    const first = await app.intelligence.submitAnalysis(id, input);
    assert.equal((await app.intelligence.submitAnalysis(id, input)).id, first.id);
    assert.equal(first.payload.sourceVersion, artifact.fileHash);
    assert.equal(app.readProject(id).revision.number, current.revision.number);
    assert.equal(app.readProject(id).snapshot.assets.length, 0);
    assert.deepEqual((await renderedAnalysisSource(app, id, input)).composition, { revision: current.revision.number, fromFrame: 0, toFrame: 48, fps: 24 });
    const durationMs = (await probeMedia(path)).durationMs!;
    assert.ok(durationMs > 2001, "真实音轨尾部超过48帧的画面时长");
    const whole = await app.intelligence.submitAnalysis(id, { ...input, range: { startMs: 0, endMs: durationMs } });
    assert.deepEqual((whole.payload.input as any).range, { startMs: 0, endMs: durationMs }, "不得静默缩短文件复核范围");
    assert.equal(app.readProject(id).revision.number, current.revision.number);
    assert.equal(analysisInputSchema.safeParse({ ...input, assetId: "extra" }).success, false);
    assert.equal(analysisInputSchema.safeParse({ ...input, depth: "index" }).success, false);
    const count = app.repository.listJobs(id).length;
    await assert.rejects(app.intelligence.submitAnalysis(id, { ...input, range: { startMs: 0, endMs: 3000 } }), /超出/u);
    const other = app.createProject({ name: "另一个测试项目" });
    await assert.rejects(app.intelligence.submitAnalysis(other.snapshot.project.id, input));
    await writeFile(path, "文件已被替换");
    await assert.rejects(app.intelligence.submitAnalysis(id, { ...input, context: "再次复核" }), /替换/u);
    assert.equal(app.repository.listJobs(id).length, count, "无效来源不得创建分析Job");
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("局部预览明确返回成片偏移，失败或旧范围不能冒充成功预览", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-preview-review-")), app = createApplication(root);
  try {
    const state = app.createProject({ name: "隔离预览映射" }), id = state.snapshot.project.id;
    const current = app.repository.commit(id, 1, "测试时间线", (snapshot) => { snapshot.timeline.fps = 24; snapshot.scenes.push(Object.assign(createScene({type:"ExplainerScene",title:"测试",purpose:"工程验证",startFrame:0,endFrame:96}), { status: "ready" as const })); });
    const path = join(state.snapshot.project.rootPath, "sample.mp4");
    await writeFile(path, "仅验证定位合同，不冒充已解码媒体");
    const preview = app.submitPreview({ projectId: id, revision: current.revision.number, fromFrame: 24, toFrame: 48, idempotencyKey: "review-map" });
    await assert.rejects(renderedAnalysisSource(app, id, { previewJobId: preview.id }), /成功/u);
    app.updateJob(preview.id, { status: "succeeded", result: { path, revision: current.revision.number, fromFrame: 24, toFrame: 48 } });
    assert.deepEqual((await renderedAnalysisSource(app, id, { previewJobId: preview.id })).composition, { revision: current.revision.number, fromFrame: 24, toFrame: 48, fps: 24 });
    app.updateJob(preview.id, { status: "succeeded", result: { path, revision: current.revision.number, fromFrame: 0, toFrame: 48 } });
    await assert.rejects(renderedAnalysisSource(app, id, { previewJobId: preview.id }), /范围/u);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
