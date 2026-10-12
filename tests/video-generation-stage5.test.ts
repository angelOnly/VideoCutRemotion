import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ComfyUIBridgeClient, type BridgeRun, type BridgeWorkflow } from "@videocut/bridge";
import type { Asset, BridgeRunAudit, JobRecord, ProjectSnapshot } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { runProcess } from "@videocut/speech";
import {
  buildVideoGenerationBridgeRequest,
  inspectGeneratedVideoFile,
  localizeGeneratedVideo,
  runVideoGeneration,
  type VideoGenerationContext
} from "../apps/job-worker/src/video-generation.js";

function snapshot(root: string): ProjectSnapshot {
  return {
    project: {
      rootPath: root,
      brief: { aspectRatio: "16:9" }
    },
    assets: []
  } as unknown as ProjectSnapshot;
}

function asset(id: string, name: string, kind: Asset["kind"], managedPath: string): Asset {
  return {
    id,
    name,
    kind,
    status: "ready",
    managedPath,
    sourceHash: `${id}-hash`,
    tags: [],
    metadata: kind === "audio" || kind === "speech"
      ? { durationMs: 1_000, hasAudio: true, audioCodec: "aac" }
      : kind === "image"
        ? { durationMs: 0, hasAudio: false, videoCodec: "png", width: 64, height: 64 }
        : { durationMs: 1_000, hasAudio: true, videoCodec: "h264", audioCodec: "aac", width: 64, height: 64 },
    provenance: { source: "local_import", acquiredAt: new Date().toISOString() },
    createdAt: new Date().toISOString()
  };
}

const standardFields: BridgeWorkflow["fields"] = [
  { id: "prompt", label: "提示词", kind: "text", required: true },
  { id: "duration", label: "视频时长（秒）", kind: "number", required: true },
  {
    id: "ratio", label: "画面比例", kind: "select", required: true,
    options: [{ label: "16:9 (Widescreen)", value: "16:9 (Widescreen)" }]
  }
];

function workflow(id: string, slots: BridgeWorkflow["itemSlots"], fields = standardFields): BridgeWorkflow {
  return {
    id,
    name: id,
    available: true,
    schemaVersion: `${id}-schema`,
    fields,
    itemSlots: slots,
    outputs: [{ id: "final-video", label: "Final video", kind: "dynamic" }]
  };
}

function context(root: string, mode: VideoGenerationContext["mode"], inputAssets: Asset[]): VideoGenerationContext {
  return {
    snapshot: snapshot(root),
    requestedRevision: 1,
    workflowId: `${mode}-workflow`,
    mode,
    inputAssets,
    prompt: "克制的城市黄昏空镜，镜头缓慢移动，不显示文字或品牌。",
    durationSeconds: 8,
    aspectRatio: "16:9"
  };
}

async function materialize(root: string, target: string, contents = "fixture"): Promise<void> {
  const path = join(root, target);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

test("四类 MiniMax 视频工作流按本次 Schema 的字段、标签与槽顺序映射", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-video-generation-schema-"));
  try {
    await Promise.all([
      materialize(root, "assets/source/first.png"),
      materialize(root, "assets/source/last.png"),
      materialize(root, "assets/source/ref2.png"),
      materialize(root, "assets/source/motion.mp4"),
      materialize(root, "assets/source/voice.wav")
    ]);
    const first = asset("first", "first.png", "image", "assets/source/first.png");
    const last = asset("last", "last.png", "image", "assets/source/last.png");
    const second = asset("second", "ref2.png", "image", "assets/source/ref2.png");
    const motion = asset("motion", "motion.mp4", "video", "assets/source/motion.mp4");
    const voice = asset("voice", "voice.wav", "audio", "assets/source/voice.wav");

    const text = await buildVideoGenerationBridgeRequest(context(root, "text_to_video", []), workflow("text", []));
    assert.deepEqual(text.files, []);
    assert.deepEqual(text.fieldValues, {
      prompt: "克制的城市黄昏空镜，镜头缓慢移动，不显示文字或品牌。",
      duration: 8,
      ratio: "16:9 (Widescreen)"
    });

    const image = await buildVideoGenerationBridgeRequest(
      context(root, "image_to_video", [first]),
      workflow("image", [{ id: "image-first", label: "Reference first frame image", kind: "image", required: true }])
    );
    assert.deepEqual(image.files.map((entry) => entry.slot.id), ["image-first"]);

    const firstLast = await buildVideoGenerationBridgeRequest(
      context(root, "first_last_frame", [first, last]),
      workflow("first-last", [
        { id: "tail", label: "尾帧图像", kind: "image", required: true },
        { id: "head", label: "首帧图像", kind: "image", required: true }
      ])
    );
    assert.deepEqual(firstLast.files.map((entry) => entry.slot.id), ["head", "tail"], "不能把 Bridge 声明顺序当成首尾语义");

    const multiFields: BridgeWorkflow["fields"] = [
      ...standardFields,
      {
        id: "initial-ratio", label: "初采画面比例", kind: "select", required: true,
        options: [{ label: "16:9", value: "16:9" }]
      },
      {
        id: "final-ratio", label: "最终画面比例", kind: "select", required: true,
        options: [{ label: "16:9", value: "16:9" }]
      }
    ];
    const multi = await buildVideoGenerationBridgeRequest(
      context(root, "multi_reference", [first, second, motion, voice]),
      workflow("multi", [
        { id: "image-2", label: "参考图像 2", kind: "image", required: false },
        { id: "image-1", label: "参考图像 1", kind: "image", required: false },
        { id: "reference-video", label: "参考视频", kind: "video", required: false },
        { id: "audio-2", label: "参考音频 2", kind: "audio", required: false },
        { id: "audio-1", label: "参考音频 1", kind: "audio", required: false }
      ], multiFields)
    );
    assert.deepEqual(multi.files.map((entry) => entry.slot.id), ["image-1", "image-2", "audio-1", "reference-video"]);
    assert.equal(multi.fieldValues["initial-ratio"], "16:9");
    assert.equal(multi.fieldValues["final-ratio"], "16:9");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createVideoFixture(root: string): Promise<string> {
  const path = join(root, "generated.mp4");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=0x264653:s=64x64:r=24:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-shortest",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    path
  ]);
  return path;
}

function job(payload: Record<string, unknown>): JobRecord {
  return {
    id: "video-job-1",
    projectId: "video-project-1",
    kind: "video_generation" as unknown as JobRecord["kind"],
    status: "running",
    payload,
    idempotencyKey: "video-generation-test",
    attempt: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

test("生成视频先在 Job 缓存校验后才进入 assets/generated，并拒绝 HTML 伪文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-video-generation-localize-"));
  try {
    const source = await createVideoFixture(root);
    const currentJob = job({});
    const bridge = {
      downloadOutput: async (_output: unknown, target: string) => copyFile(source, target)
    } as unknown as ComfyUIBridgeClient;
    const generated = await localizeGeneratedVideo(bridge, snapshot(root), currentJob, {
      outputSlotId: "final-video",
      displayName: "Final video",
      kind: "video",
      fileName: "mini-max-output.mp4",
      mime: "video/mp4",
      downloadUrl: "/runs/final"
    });
    assert.match(generated.relativePath.replace(/\\/g, "/"), /^assets\/generated\/video-video-job-1-mini-max-output\.mp4$/);
    assert.ok(generated.durationMs > 0);
    assert.equal(generated.metadata.videoCodec, "h264");

    const html = join(root, "provider-error.mp4");
    await writeFile(html, "<!doctype html><html>bridge failure</html>");
    await assert.rejects(
      () => inspectGeneratedVideoFile(html, "video/mp4"),
      (error: unknown) => error instanceof DomainError && error.code === "VIDEO_GENERATION_OUTPUT_HTML"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("已提交视频 Run 丢失时不自动重提，避免未知 Provider 额度下重复生成", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-video-generation-lost-"));
  const originalFetch = globalThis.fetch;
  let createRunCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.endsWith("/runs/lost-video-run")) return Response.json({ error: "run missing" }, { status: 404 });
    if (address.endsWith("/workflows/video-workflow/runs") && init?.method === "POST") {
      createRunCalls += 1;
      return Response.json({ id: "unexpected-run", status: "queued", outputs: [] } satisfies BridgeRun);
    }
    throw new Error(`测试未处理的 Bridge 请求：${address}`);
  }) as typeof fetch;
  try {
    const currentJob = job({
      requestedRevision: 1,
      workflowId: "video-workflow",
      mode: "text_to_video",
      inputAssetIds: [],
      prompt: "夜晚街道的安静空镜",
      durationSeconds: 8
    });
    const audit: BridgeRunAudit = {
      workflowId: "video-workflow",
      runId: "lost-video-run",
      schemaVersion: "old-schema",
      schemaRetryCount: 0,
      submittedAt: new Date().toISOString(),
      request: { fieldValues: { prompt: "夜晚街道的安静空镜" }, fileSlots: [] }
    };
    currentJob.result = { bridgeRuns: [audit] };
    const application = {
      readProject: () => ({ revision: { number: 1 }, snapshot: snapshot(root) }),
      trackJob: () => currentJob
    } as never;
    await assert.rejects(
      () => runVideoGeneration(application, currentJob, new ComfyUIBridgeClient("http://bridge.test/comfyui-bridge/v1")),
      (error: unknown) => error instanceof DomainError && error.code === "VIDEO_GENERATION_RUN_LOST_REQUIRES_RECONFIRMATION"
    );
    assert.equal(createRunCalls, 0, "Run 状态未知时不能创建第二个生成任务");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
