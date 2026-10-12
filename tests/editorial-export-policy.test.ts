import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { canExport, evaluateQuality } from "@videocut/quality";
import { probeMedia, runProcess } from "@videocut/speech";
import { runExportJob, runRenderPreflight } from "../apps/render-worker/src/exporter.js";
import { createServer } from "../apps/server/src/app.js";

test("质量、预检、Worker 用途一致；无 AI 审阅可导出，人工定稿验证具体文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-export-policy-"));
  const app = createApplication(root);
  const server = await createServer({ workspaceRoot: root });
  try {
    const project = app.createProject({ name: "导出用途与人工定稿合约夹具" });
    const projectId = project.snapshot.project.id;
    const file = join(project.snapshot.project.rootPath, "assets/source/fixture.mp4");
    await mkdir(dirname(file), { recursive: true });
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x320:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    const imported = app.registerImportedAsset({ projectId, baseRevision: 1, name: "fixture", kind: "video", managedPath: "assets/source/fixture.mp4", provenance: { source: "generated", acquiredAt: new Date().toISOString() } });
    app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(file) });
    const state = app.buildPresenterTimeline({ projectId, baseRevision: app.readProject(projectId).revision.number, assetIds: [imported.asset.id] });
    const quality = evaluateQuality(state.snapshot, state.revision.number);
    assert.equal(quality.editorial.status, "not_recorded");
    assert.equal(canExport(quality, "draft"), true);
    assert.equal(canExport(quality, "delivery"), true);
    assert.equal(quality.exportReadiness.draft.allowed, true);
    assert.ok(quality.exportReadiness.delivery.blockers.every(issue => issue.blockingPurposes?.includes("delivery")));
    for (const purpose of ["draft", "delivery"] as const) {
      const preflight = await runRenderPreflight(app, projectId, state.revision.number, purpose);
      assert.equal(preflight.purpose, purpose);
      assert.equal(preflight.status, "passed");
    }
    // 测试替身只校验导出调度与文件保护；完整 Remotion 渲染在独立候选验收覆盖。
    const renderer = { render: async (_snapshot: unknown, output: string) => { await copyFile(file, output); } } as never;
    const checkJob = app.submitRenderPreflight({ projectId, purpose: "delivery", idempotencyKey: "same-request" });
    const delivery = app.submitExport({ projectId, purpose: "delivery", idempotencyKey: "same-request" });
    assert.notEqual(checkJob.id, delivery.id, "同业务键的预检不能冒充导出结果");
    assert.equal(delivery.kind, "export");
    assert.ok((await runExportJob(app, delivery, renderer)).artifactId);
    const draft = await runExportJob(app, app.submitExport({ projectId, purpose: "draft" }), renderer);
    const draftArtifact = app.readExportArtifact({ projectId, artifactId: String(draft.artifactId) });
    assert.equal(draftArtifact.approval, undefined);
    await assert.rejects(app.approveExportArtifact({ projectId, artifactId: draftArtifact.id, fileHash: draftArtifact.fileHash, confirmedByUser: true }), { code: "EXPORT_ARTIFACT_APPROVAL_PURPOSE_INVALID" });
    const next = app.updateAssetEditorialMetadata({ projectId, baseRevision: state.revision.number, assetId: imported.asset.id, provenance: { ...imported.asset.provenance!, } });
    const run = await app.startProductionRun({ projectId, loadedSkills: ["quality-verification"] });
    await app.recordEditorialQualityReview({ projectId, runId: run.id, revision: next.revision.number, passes: ["mute_visual"], findings: [{ pass: "mute_visual", severity: "major", category: "motion", summary: "合约模拟的待复核问题", evidence: "测试输入，不表示真人观看", impact: "保留提示" }], previewEvidence: ["合约模拟历史文字记录，不等于真实连续观看"] });
    const result = await runExportJob(app, app.submitExport({ projectId, purpose: "delivery" }), renderer);
    const artifactId = String(result.artifactId);
    const artifact = app.readExportArtifact({ projectId, artifactId });
    assert.equal(artifact.approval, undefined);
    const approve = (payload: unknown) => server.app.inject({ method: "POST", url: `/api/projects/${projectId}/export-artifacts/${artifactId}/approve`, payload: payload as object });
    assert.equal((await approve({})).statusCode, 400);
    assert.equal((await approve({ fileHash: "0".repeat(64), confirmedByUser: true })).statusCode, 400);
    const partial = await server.app.inject({ method: "POST", url: `/api/projects/${projectId}/export-artifacts/${artifactId}/review`, payload: { passes: ["mute_visual"], evidence: ["合约模拟文件观察"], findings: [{ pass: "mute_visual", severity: "inconclusive", category: "motion", summary: "保留待复核", evidence: "测试输入", impact: "辅助提示" }] } });
    assert.equal(partial.statusCode, 200, partial.body);
    const approved = await approve({ fileHash: artifact.fileHash, confirmedByUser: true, note: "仅模拟明确人工定稿操作；不代表真实验收" });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().artifactReview.findings[0].severity, "inconclusive");
    assert.equal(approved.json().approval.fileHash, artifact.fileHash);
    const changed = app.updateAssetEditorialMetadata({ projectId, baseRevision: next.revision.number, assetId: imported.asset.id, tags: ["new-revision"] });
    assert.ok(changed.revision.number > artifact.revision);
    assert.equal(app.readExportArtifact({ projectId, artifactId }).revision, artifact.revision);
    const later = await runExportJob(app, app.submitExport({ projectId, purpose: "delivery" }), renderer);
    assert.equal(app.readExportArtifact({ projectId, artifactId: String(later.artifactId) }).approval, undefined);
    await writeFile(join(project.snapshot.project.rootPath, artifact.relativePath), "tampered");
    await assert.rejects(app.approveExportArtifact({ projectId, artifactId, fileHash: artifact.fileHash, confirmedByUser: true }), { code: "EXPORT_ARTIFACT_CHANGED" });
    await rm(file);
    assert.equal((await runRenderPreflight(app, projectId, changed.revision.number, "draft")).status, "failed");
  } finally { await server.app.close(); server.application.close(); app.close(); await rm(root, { recursive: true, force: true }); }
});
