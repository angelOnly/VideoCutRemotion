import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import type { AssetCandidate, AssetRequest } from "@videocut/contracts";
import {
  AssetProviderError,
  AssetProviderRegistry,
  MockAssetProvider,
  assertDownloadedProviderMedia,
  assertProviderDownloadContentType,
  assertProviderMediaAnalysis,
  createDefaultAssetProviderRegistry
} from "@videocut/acquisition";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";

const request = { queryHints: ["图表", "证据"] } as AssetRequest;

test("Mock Provider 能把图片 fixture 作为 image 候选和真实 image MIME 返回", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-image-provider-"));
  try {
    const imagePath = join(root, "evidence-chart.png");
    // PNG 签名足以验证下载边界不依赖“视频”扩展名；实际尺寸仍应由 Worker 的 ffprobe 写入。
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const provider = new MockAssetProvider([{
      originalAssetId: "chart-001",
      name: "evidence-chart.png",
      filePath: imagePath,
      sourceUrl: "https://example.test/evidence/chart-001",
    }]);

    const [candidate] = await provider.search({ request, query: "chart evidence" });
    assert.ok(candidate);
    assert.equal(candidate.kind, "image");
    assert.equal(candidate.mimeType, "image/png");
    assert.deepEqual(candidate.tags, ["图表", "证据"]);

    const downloaded = await provider.download({
      candidate: { id: "candidate-001", originalAssetId: candidate.originalAssetId } as AssetCandidate,
      temporaryDirectory: join(root, "download")
    });
    assert.equal(downloaded.contentType, "image/png");
    await assertDownloadedProviderMedia({
      filePath: downloaded.filePath,
      contentType: downloaded.contentType,
      expectedKind: "image",
      expectedMimeType: candidate.mimeType
    });

    // 图片可以是零时长，但必须有真实的视觉流与尺寸；绝不靠 videoCodec 把它登记成视频。
    assert.doesNotThrow(() => assertProviderMediaAnalysis({
      candidate: { kind: "image", name: candidate.name },
      metadata: { durationMs: 0, width: 1280, height: 720, hasAudio: false, videoCodec: "png" }
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("素材类型、响应 MIME 和分析结果不一致时明确失败，不把图片伪装为视频", () => {
  assert.throws(
    () => assertProviderDownloadContentType({ contentType: "image/png", expectedKind: "video", expectedMimeType: "video/mp4" }),
    (error: unknown) => error instanceof AssetProviderError && error.code === "ASSET_DOWNLOAD_KIND_MISMATCH"
  );
  assert.throws(
    () => new MockAssetProvider([{
      originalAssetId: "bad-fixture",
      name: "bad.png",
      kind: "video",
      mimeType: "image/png",
      filePath: "C:/fixture/bad.png",
      sourceUrl: "https://example.test/bad",
    }]),
    (error: unknown) => error instanceof AssetProviderError && error.code === "MOCK_ASSET_KIND_MIME_MISMATCH"
  );
  assert.throws(
    () => assertProviderMediaAnalysis({
      candidate: { kind: "image", name: "broken.png" },
      metadata: { durationMs: 0, hasAudio: false, videoCodec: "png" }
    }),
    (error: unknown) => error instanceof AssetProviderError && error.code === "ASSET_DOWNLOAD_IMAGE_DIMENSIONS_MISSING"
  );
  assert.throws(
    () => assertProviderMediaAnalysis({
      candidate: { kind: "video", name: "still.mp4" },
      metadata: { durationMs: 0, width: 1280, height: 720, hasAudio: false, videoCodec: "h264" }
    }),
    (error: unknown) => error instanceof AssetProviderError && error.code === "ASSET_DOWNLOAD_VIDEO_DURATION_MISSING"
  );
});

test("默认 Registry 始终发现无需密钥的 Wikimedia Commons Provider", () => {
  const registry = createDefaultAssetProviderRegistry();
  assert.ok(registry.names().includes("wikimedia-commons"));
});

test("图片候选经 Worker 本地化和 ffprobe 后保持 image Asset、来源和尺寸", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-image-acquisition-"));
  const app = createApplication(root);
  try {
    const sourcePath = join(root, "source-evidence.png");
    // 1×1 的有效 PNG；这里刻意不用伪造 metadata，确保 Worker 实际调用 ffprobe。
    await writeFile(sourcePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const created = app.createProject({ name: "图片素材本地化测试", profile: "visual_explainer" });
    const requested = app.manageAssetRequirement({
      projectId: created.snapshot.project.id,
      baseRevision: created.revision.number,
      action: "create",
      title: "真实证据截图",
      purpose: "验证视觉解释片可保留图片事实。",
      visualBrief: "一张可读取的证据截图。",
      role: "evidence",
    });
    const assetRequest = requested.snapshot.assetRequests[0]!;
    const provider = new MockAssetProvider([{
      originalAssetId: "evidence-image-001",
      name: "evidence.png",
      filePath: sourcePath,
      sourceUrl: "https://example.test/evidence/001",
      creator: "测试作者",
    }]);
    const searched = app.recordAssetSearch({
      projectId: created.snapshot.project.id,
      baseRevision: requested.revision.number,
      assetRequestId: assetRequest.id,
      provider: provider.name,
      query: "evidence screenshot",
      candidates: await provider.search({ request: assetRequest, query: "evidence screenshot" })
    });
    const candidate = searched.candidates[0]!;
    assert.equal(candidate.kind, "image");
    assert.equal(candidate.mimeType, "image/png");

    const acquisition = app.acquireAssetCandidate({
      projectId: created.snapshot.project.id,
      baseRevision: searched.state.revision.number,
      assetCandidateId: candidate.id
    });
    const processor = createMediaJobProcessor(app, undefined, new AssetProviderRegistry([provider]));
    assert.equal(await runOneJob(app, processor), true);
    assert.equal(app.trackJob(acquisition.job.id).status, "succeeded");
    // 第二个 Job 才会把 ffprobe 结果写回 Asset；Acquire 本身不能伪造 ready。
    assert.equal(await runOneJob(app, processor), true);

    const acquiredAssetId = String(app.trackJob(acquisition.job.id).result?.assetId);
    const asset = app.readProject(created.snapshot.project.id).snapshot.assets.find((entry) => entry.id === acquiredAssetId);
    assert.ok(asset);
    assert.equal(asset.kind, "image");
    assert.equal(asset.status, "ready", asset.failureReason);
    assert.equal(asset.metadata?.width, 1);
    assert.equal(asset.metadata?.height, 1);
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("原始 PDF 证据通过受管 Worker 登记为 document，而不会被当成视频分析", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-document-evidence-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "PDF 证据导入测试", profile: "visual_explainer" });
    const documentPath = join(root, "original-research.pdf");
    // 最小 PDF 文件头足以验证当前边界：它是来源本体，真正可视页面仍需另行绑定图片快照。
    await writeFile(documentPath, Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "ascii"));
    const imported = app.registerImportedAsset({
      projectId: created.snapshot.project.id,
      baseRevision: created.revision.number,
      name: "original-research.pdf",
      kind: "document",
      managedPath: "assets/source/original-research.pdf",
      sourceHash: "pdf-source-hash",
      role: "evidence",
      provenance: {
        source: "local_import",
        acquiredAt: new Date().toISOString()
      }
    });
    const managedPath = join(app.readProject(created.snapshot.project.id).snapshot.project.rootPath, "assets", "source", "original-research.pdf");
    await writeFile(managedPath, await readFile(documentPath));
    assert.equal(await runOneJob(app, createMediaJobProcessor(app)), true);
    assert.equal(app.trackJob(imported.job.id).status, "succeeded");
    const asset = app.readProject(created.snapshot.project.id).snapshot.assets.find((entry) => entry.id === imported.asset.id);
    assert.equal(asset?.kind, "document");
    assert.equal(asset?.status, "ready");
    assert.deepEqual(asset?.metadata, { durationMs: 0, hasAudio: false, mime: "application/pdf" });
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
