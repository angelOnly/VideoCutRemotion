import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { createServer } from "../apps/server/src/app.js";

const workflowId = "4d02d4eb-a4a5-4c13-95d5-6b6a594b4daa";

test("视频生成只登记受管 Asset、生成参数和来源，不自动写入时间线", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-video-generation-application-"));
  const application = createApplication(root);
  try {
    const created = application.createProject({ name: "视频生成 Application 测试", profile: "presenter_motion" });
    const projectId = created.snapshot.project.id;
    const requested = application.manageAssetRequirement({
      projectId,
      baseRevision: created.revision.number,
      action: "create",
      title: "安静的城市黄昏空镜",
      purpose: "在观点停顿后给观众一个短暂的呼吸空间。",
      visualBrief: "没有品牌和文字的城市黄昏街道，慢速移动，画面上方保留留白。",
      role: "b_roll",
      fallbackPlan: "minimax"
    });
    const assetRequest = requested.snapshot.assetRequests[0]!;
    const submitted = application.submitVideoGeneration({
      projectId,
      baseRevision: requested.revision.number,
      workflowId,
      mode: "text_to_video",
      prompt: "安静的城市黄昏街道空镜，镜头缓慢移动，不出现文字、人物品牌或可识别商标。",
      durationSeconds: 8,
      assetRequestId: assetRequest.id,
      idempotencyKey: "video-generation-application-stage5"
    });
    assert.equal(submitted.kind, "video_generation");

    const projectRoot = application.readProject(projectId).snapshot.project.rootPath;
    const relativePath = "assets/generated/video-application.mp4";
    const outputPath = join(projectRoot, "assets", "generated", "video-application.mp4");
    await mkdir(join(projectRoot, "assets", "generated"), { recursive: true });
    await writeFile(outputPath, "worker-validated-video-fixture");
    const completed = application.completeVideoGeneration({
      projectId,
      jobId: submitted.id,
      generatedVideo: {
        path: outputPath,
        relativePath,
        name: "video-application.mp4",
        contentHash: "video-application-content-hash",
        sourceHash: "video-application-content-hash",
        durationMs: 8_000,
        metadata: { durationMs: 8_000, hasAudio: true, videoCodec: "h264", audioCodec: "aac", width: 1280, height: 720, fps: 24 }
      },
      bridgeAudit: {
        workflowId,
        runId: "video-generation-bridge-run",
        schemaVersion: "video-generation-schema-v1",
        schemaRetryCount: 0,
        submittedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        request: { fieldValues: { prompt: "安静的城市黄昏街道空镜" }, fileSlots: [] },
        response: { status: "succeeded", outputs: [] }
      }
    });
    const asset = completed.asset;
    assert.equal(asset.kind, "video");
    assert.equal(asset.role, "generated_visual");
    assert.equal(asset.status, "ready");
    assert.equal(asset.provenance?.source, "generated");
    assert.equal(asset.provenance?.generationJobId, submitted.id);
    assert.deepEqual(asset.provenance?.generation, {
      jobId: submitted.id,
      workflowId,
      mode: "text_to_video",
      inputAssetIds: [],
      prompt: "安静的城市黄昏街道空镜，镜头缓慢移动，不出现文字、人物品牌或可识别商标。",
      durationSeconds: 8,
      aspectRatio: "9:16"
    });
    assert.equal(completed.state.snapshot.timeline.items.some((item) => item.assetId === asset.id), false, "生成完成不应替导演自动插入 Timeline");
    assert.equal(completed.state.snapshot.assetRequests.find((request) => request.id === assetRequest.id)?.status, "candidates_ready");
    assert.equal(application.trackJob(submitted.id).result?.generatedVideoAssetId, asset.id);

    const recovered = application.completeVideoGeneration({
      projectId,
      jobId: submitted.id,
      generatedVideo: {
        path: outputPath,
        relativePath,
        name: "video-application.mp4",
        contentHash: "video-application-content-hash",
        sourceHash: "video-application-content-hash",
        durationMs: 8_000,
        metadata: { durationMs: 8_000, hasAudio: true, videoCodec: "h264", audioCodec: "aac" }
      },
      bridgeAudit: {
        workflowId,
        runId: "video-generation-bridge-run",
        schemaVersion: "video-generation-schema-v1",
        schemaRetryCount: 0,
        submittedAt: new Date().toISOString(),
        request: { fieldValues: {}, fileSlots: [] }
      }
    });
    assert.equal(recovered.duplicate, true, "重领同一 Job 只能读回原 Asset，不能重复登记素材");
  } finally {
    application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("视频生成拒绝用生成画面替代证据，HTTP 端点只排队受管 Job", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-video-generation-http-"));
  const server = await createServer({ workspaceRoot: root, serveWeb: false });
  try {
    const created = server.application.createProject({ name: "视频生成 HTTP 测试" });
    const projectId = created.snapshot.project.id;
    const evidence = server.application.manageAssetRequirement({
      projectId,
      baseRevision: created.revision.number,
      action: "create",
      title: "法规证据",
      purpose: "证明一条可核对的外部事实。",
      visualBrief: "官方原始文件中的条款页面。",
      role: "evidence"
    }).snapshot.assetRequests[0]!;
    assert.throws(() => server.application.submitVideoGeneration({
      projectId,
      baseRevision: server.application.readProject(projectId).revision.number,
      workflowId,
      mode: "text_to_video",
      prompt: "看起来像官方法规页面的动画",
      durationSeconds: 8,
      assetRequestId: evidence.id
    }), /证据类素材不能由生成视频替代/u);

    const response = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/video-generation`,
      payload: {
        baseRevision: server.application.readProject(projectId).revision.number,
        workflowId,
        mode: "text_to_video",
        prompt: "抽象的流程关系说明，不冒充真实证据。",
        durationSeconds: 8
      }
    });
    assert.equal(response.statusCode, 202);
    assert.equal((response.json() as { kind: string }).kind, "video_generation");
  } finally {
    await server.app.close();
    server.application.close();
    await rm(root, { recursive: true, force: true });
  }
});
