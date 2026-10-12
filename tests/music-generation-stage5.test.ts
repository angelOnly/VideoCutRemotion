import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication, type EditingApplication } from "@videocut/application";
import { ComfyUIBridgeClient, type BridgeRun, type BridgeWorkflow } from "@videocut/bridge";
import type { BridgeRunAudit, JobRecord, ProjectSnapshot } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { canExport, evaluateQuality } from "@videocut/quality";
import { runProcess } from "@videocut/speech";
import {
  buildMusicBridgeRequest,
  inspectGeneratedMusicFile,
  runMusicGeneration,
  selectMusicOutput,
  type MusicGenerationCompletionInput
} from "../apps/job-worker/src/music-generation.js";
import { createMediaJobProcessor, MEDIA_JOB_KINDS } from "../apps/job-worker/src/index.js";

const musicWorkflow: BridgeWorkflow = {
  id: "music-workflow",
  name: "受控音乐生成",
  available: true,
  schemaVersion: "music-v1",
  fields: [
    { id: "prompt", label: "Music prompt", kind: "text", required: true },
    {
      id: "duration", label: "Duration seconds", kind: "select", required: true,
      options: [{ label: "30 seconds", value: "30" }]
    },
    { id: "negative", label: "Negative prompt", kind: "text", required: false }
  ],
  itemSlots: [],
  outputs: [{ id: "final_audio", label: "Final music", kind: "audio" }]
};

function context(root: string) {
  const snapshot = {
    project: { rootPath: root }
  } as ProjectSnapshot;
  const job: JobRecord = {
    id: "music-job-1",
    projectId: "music-project-1",
    kind: "music_generation" as unknown as JobRecord["kind"],
    status: "running",
    payload: {
      requestedRevision: 1,
      workflowId: musicWorkflow.id,
      prompt: "克制的钢琴与轻柔弦乐，不要人声，用于观点型口播的过渡。",
      durationSeconds: 30
    },
    idempotencyKey: "music-test",
    attempt: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const completions: MusicGenerationCompletionInput[] = [];
  const application = {
    readProject: () => ({ revision: { number: 1 }, snapshot }),
    recordBridgeRun: (_jobId: string, audit: BridgeRunAudit) => {
      const bridgeRuns = Array.isArray(job.result?.bridgeRuns) ? job.result?.bridgeRuns : [];
      job.result = { ...(job.result ?? {}), bridgeRuns: [...bridgeRuns, audit] };
      return job;
    },
    trackJob: () => job,
    completeMusicGeneration: async (input: MusicGenerationCompletionInput) => {
      completions.push(input);
      job.result = { ...(job.result ?? {}), musicAssetId: "generated-music-asset", revision: 1 };
    }
  } as unknown as EditingApplication;
  return { snapshot, job, application, completions };
}

async function createMp3Fixture(root: string): Promise<Buffer> {
  const path = join(root, "generated.mp3");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1",
    "-c:a", "libmp3lame",
    "-b:a", "96k",
    path
  ]);
  return readFile(path);
}

function installBridgeFetch(bytes: Buffer, observed: { request?: Record<string, unknown> }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.endsWith(`/workflows/${musicWorkflow.id}`) && (!init?.method || init.method === "GET")) {
      return Response.json(musicWorkflow);
    }
    if (address.endsWith(`/workflows/${musicWorkflow.id}/runs`) && init?.method === "POST") {
      observed.request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ id: "bridge-music-run", status: "queued", outputs: [] });
    }
    if (address.endsWith("/runs/bridge-music-run")) {
      return Response.json({
        id: "bridge-music-run",
        status: "succeeded",
        outputs: [{
          outputSlotId: "final_audio",
          displayName: "Final music",
          kind: "audio",
          fileName: "finale.mp3",
          mime: "audio/mpeg",
          downloadUrl: "/downloads/finale.mp3"
        }]
      } satisfies BridgeRun);
    }
    if (address === "http://bridge.test/downloads/finale.mp3") {
      // Buffer 的底层 ArrayBuffer 类型在 Node DOM 声明中较宽，复制为浏览器兼容 Uint8Array 再模拟下载体。
      const body = new Uint8Array(bytes.byteLength);
      body.set(bytes);
      return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    throw new Error(`测试未处理的 Bridge 请求：${address}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("音乐 Bridge 请求只映射唯一的正向提示词和精确时长", () => {
  const request = buildMusicBridgeRequest({
    snapshot: { project: { rootPath: "C:/test" } } as ProjectSnapshot,
    workflowId: musicWorkflow.id,
    prompt: "低密度钢琴",
    durationSeconds: 30
  }, musicWorkflow);
  assert.deepEqual(request.fieldValues, { prompt: "低密度钢琴", duration: "30" });

  const ambiguous: BridgeWorkflow = {
    ...musicWorkflow,
    fields: [
      { id: "prompt-a", label: "Prompt", kind: "text", required: true },
      { id: "prompt-b", label: "提示词", kind: "text", required: true },
      musicWorkflow.fields[1]!
    ]
  };
  assert.throws(
    () => buildMusicBridgeRequest({
      snapshot: { project: { rootPath: "C:/test" } } as ProjectSnapshot,
      workflowId: musicWorkflow.id,
      prompt: "低密度钢琴",
      durationSeconds: 30
    }, ambiguous),
    (error: unknown) => error instanceof DomainError && error.code === "MUSIC_PROMPT_FIELD_AMBIGUOUS"
  );
});

test("音乐 Worker 动态读取 Schema、保存审计并只接收可解码的本地音频", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-music-generation-"));
  const observed: { request?: Record<string, unknown> } = {};
  const restoreFetch = installBridgeFetch(await createMp3Fixture(root), observed);
  try {
    const state = context(root);
    assert.ok(MEDIA_JOB_KINDS.includes("music_generation"), "音乐任务必须由媒体 Worker 领取");
    const result = await createMediaJobProcessor(
      state.application,
      new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1")
    )(state.job);
    assert.equal(result.musicAssetId, "generated-music-asset");
    assert.equal(result.revision, 1);
    assert.deepEqual(observed.request, {
      schemaVersion: "music-v1",
      fieldValues: {
        prompt: "克制的钢琴与轻柔弦乐，不要人声，用于观点型口播的过渡。",
        duration: "30"
      }
    });
    assert.equal(state.completions.length, 1);
    const completion = state.completions[0]!;
    assert.match(completion.musicAudio.relativePath.replace(/\\/g, "/"), /^assets\/music\/music-music-job-1-finale\.mp3$/);
    assert.ok(completion.musicAudio.durationMs > 0);
    assert.equal(completion.musicAudio.metadata.audioCodec, "mp3");
    assert.equal((state.job.result?.bridgeRuns as unknown[]).length, 2, "提交与完成审计都必须保留");
  } finally {
    restoreFetch();
    await rm(root, { recursive: true, force: true });
  }
});

test("多路音频输出或网页错误页不会被误当成可用音乐", async () => {
  assert.throws(
    () => selectMusicOutput({
      id: "multiple",
      status: "succeeded",
      outputs: [
        { outputSlotId: "preview", displayName: "Preview", kind: "audio", downloadUrl: "/preview" },
        { outputSlotId: "final", displayName: "Final", kind: "audio", downloadUrl: "/final" }
      ]
    }),
    (error: unknown) => error instanceof DomainError && error.code === "MUSIC_OUTPUT_AMBIGUOUS"
  );

  const root = await mkdtemp(join(tmpdir(), "videocut-music-invalid-"));
  const invalid = join(root, "error.mp3");
  await writeFile(invalid, "<!doctype html><html>provider error</html>");
  try {
    await assert.rejects(
      () => inspectGeneratedMusicFile(invalid, "audio/mpeg"),
      (error: unknown) => error instanceof DomainError && error.code === "MUSIC_OUTPUT_HTML"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("已提交的音乐 Run 丢失时不自动重提，避免在未知额度状态下重复消费", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-music-run-lost-"));
  const originalFetch = globalThis.fetch;
  let createRunCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.endsWith("/runs/lost-music-run")) {
      return Response.json({ error: "run missing" }, { status: 404 });
    }
    if (address.endsWith(`/workflows/${musicWorkflow.id}/runs`) && init?.method === "POST") {
      createRunCalls += 1;
      return Response.json({ id: "unexpected-new-run", status: "queued", outputs: [] });
    }
    throw new Error(`测试未处理的 Bridge 请求：${address}`);
  }) as typeof fetch;
  try {
    const state = context(root);
    state.job.result = {
      bridgeRuns: [{
        workflowId: musicWorkflow.id,
        runId: "lost-music-run",
        schemaVersion: "music-v1",
        schemaRetryCount: 0,
        submittedAt: new Date().toISOString(),
        request: { fieldValues: { prompt: "旧请求" }, fileSlots: [] }
      }]
    };
    await assert.rejects(
      () => runMusicGeneration(state.application, state.job, new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1")),
      (error: unknown) => error instanceof DomainError && error.code === "MUSIC_RUN_LOST_REQUIRES_RECONFIRMATION"
    );
    assert.equal(createRunCalls, 0, "未知远端状态下不得自动创建第二个音乐 Run");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("音乐 Application 登记受管素材；实际加入 BGM 后可导出 delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-music-application-"));
  const application = createApplication(root);
  try {
    const created = application.createProject({ name: "音乐 Application 受管素材" });
    const projectId = created.snapshot.project.id;
    const submitted = application.submitMusicGeneration({
      projectId,
      baseRevision: created.revision.number,
      workflowId: musicWorkflow.id,
      prompt: "低密度钢琴，不要人声。",
      durationSeconds: 30,
      idempotencyKey: "music-application-stage5"
    });
    const projectRoot = application.readProject(projectId).snapshot.project.rootPath;
    const relativePath = "assets/music/generated-source-check.mp3";
    const outputPath = join(projectRoot, ...relativePath.split("/"));
    await mkdir(join(projectRoot, "assets", "music"), { recursive: true });
    await writeFile(outputPath, "application-layer-music-fixture");

    const completed = application.completeMusicGeneration({
      projectId,
      jobId: submitted.id,
      musicAudio: {
        path: outputPath,
        relativePath,
        name: "generated-source-check.mp3",
        contentHash: "music-application-fixture-hash",
        sourceHash: "music-application-fixture-hash",
        durationMs: 30_000,
        metadata: {
          durationMs: 30_000,
          hasAudio: true,
          audioCodec: "mp3",
          sampleRate: 44_100,
          channels: 2,
          mime: "audio/mpeg"
        }
      },
      bridgeAudit: {
        workflowId: musicWorkflow.id,
        runId: "music-application-bridge-run",
        schemaVersion: musicWorkflow.schemaVersion,
        schemaRetryCount: 0,
        submittedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        request: { fieldValues: { prompt: "低密度钢琴，不要人声。", duration: "30" }, fileSlots: [] }
      }
    });

    assert.equal(completed.asset.kind, "audio");
    assert.equal(completed.asset.status, "ready");
    assert.equal(completed.asset.provenance?.source, "generated");
    assert.equal(completed.asset.provenance?.provider, `bridge:${musicWorkflow.id}`);
    assert.ok(completed.asset.provenance?.acquiredAt, "生成素材必须记录取得时间");
    assert.equal(completed.state.snapshot.timeline.items.some((item) => item.assetId === completed.asset.id), false, "生成成功不能自动把音乐放入 Timeline");
    assert.equal(completed.state.snapshot.audioCues.some((cue) => cue.assetId === completed.asset.id), false, "生成成功不能自动创建 BGM 决策");

    const presenter = application.registerImportedAsset({
      projectId,
      baseRevision: application.readProject(projectId).revision.number,
      name: "presenter.mp4",
      kind: "video",
      managedPath: "assets/source/presenter.mp4",
      sourceHash: "presenter-stage5-hash",
      provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
    });
    application.applyMediaAnalysis({
      projectId,
      assetId: presenter.asset.id,
      metadata: { durationMs: 1_000, hasAudio: true, videoCodec: "h264", audioCodec: "aac", width: 64, height: 64 }
    });
    application.buildPresenterTimeline({
      projectId,
      baseRevision: application.readProject(projectId).revision.number,
      assetIds: [presenter.asset.id],
      sceneSize: 1
    });
    const usedMusic = application.manageAudio({
      projectId,
      baseRevision: application.readProject(projectId).revision.number,
      action: "create",
      kind: "bgm",
      assetId: completed.asset.id,
      purpose: "为口播开场提供克制的音乐床",
      gainDb: -18
    });
    assert.equal(usedMusic.snapshot.timeline.items.some((item) => item.assetId === completed.asset.id), true, "只有显式 BGM 决策才会把音乐写入 Timeline");

    const report = evaluateQuality(usedMusic.snapshot, usedMusic.revision.number);
    assert.equal(report.issues.some((issue) => issue.code.startsWith("EXTERNAL_ASSET_RIGHTS")), false);
    assert.equal(canExport(report, "delivery"), true, "已使用的受管音乐不需要权利证明");
  } finally {
    application.close();
    await rm(root, { recursive: true, force: true });
  }
});
