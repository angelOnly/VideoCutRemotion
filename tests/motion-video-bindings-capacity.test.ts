import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { createApplication } from "@videocut/application";
import { runProcess, probeMedia } from "@videocut/speech";
import { motionFixture } from "./fixtures/managed-motion.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import { motionHash } from "../packages/motion-work/src/compiler.js";
import { planMotionVideos } from "../apps/render-worker/src/motion-video-plan.js";
import { createMotionVideoProvider } from "../apps/render-worker/src/motion-video-provider.js";
import { hashMotionFile } from "../apps/render-worker/src/motion-video.js";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";
import { registerMotionTools } from "../apps/server/src/motion-tools.js";

const binding = { assetId: "source", sourceStartMs: 0, sourceEndMs: 500, startFrame: 0, endFrame: 12 };

test("视频选段取消总数上限，非法槽名、范围与旧时钟输入仍拒绝", () => {
  const work = { ...motionFixture, fps: 24, durationInFrames: 12, videoBindings: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`clip${i}`, { ...binding }])) };
  assert.equal(Object.keys(motionSubmissionSchema.parse(work).videoBindings!).length, 64);
  for (const change of [{ sourceStartMs: -1 }, { sourceEndMs: 0 }, { sourceEndMs: 1000 }, { startFrame: 12 }, { endFrame: 13 }, { decodeScale: 2 }, { offsetInFrames: 0 }]) {
    assert.equal(motionSubmissionSchema.safeParse({ ...work, videoBindings: { ...work.videoBindings, clip63: { ...binding, ...change } } }).success, false);
  }
  assert.equal(motionSubmissionSchema.safeParse({ ...work, videoBindings: { ...work.videoBindings, "bad-slot": binding } }).success, false);
});

test("省略视频绑定的历史输入不注入新默认值，作品身份保持不变", () => {
  const parsed = motionSubmissionSchema.parse(motionFixture);
  assert.deepEqual(parsed, motionFixture);
  assert.equal(Object.hasOwn(parsed, "videoBindings"), false);
  assert.equal(motionHash(parsed, []), motionHash(motionFixture, []));
  const oldVideo = { ...motionFixture, fps: 24, durationInFrames: 12, videoBindings: { clip: binding } };
  assert.equal(motionHash(motionSubmissionSchema.parse(oldVideo), []), motionHash(oldVideo, []));
});

test("真实能力工具公布无固定槽数上限与根时钟", async () => {
  const handlers = new Map<string, () => Promise<any>>();
  registerMotionTools({ registerTool: (name: string, _config: unknown, handler: () => Promise<any>) => handlers.set(name, handler) } as any, {} as any, () => "unused");
  const result = await handlers.get("read_motion_capabilities")!();
  assert.notEqual(result.isError, true);
  const capabilities = JSON.parse(result.content[0].text);
  assert.equal(capabilities.videoBindings.maxSlots, null);
  assert.equal(capabilities.videoBindings.clock, "work_root");
  assert.equal(capabilities.videoBindings.playback, "normal_speed_muted");
});

for (const overlap of [false, true]) test(`六个${overlap ? "交叠" : "顺序"}选段完成真实 Job，同源多范围保留根时钟与缓存身份`, { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-capacity-"));
  const previousWorkspace = process.env.VIDEOCUT_WORKSPACE;
  // 失败诊断也落入本测试工作区，不能写到生产 Runtime 的默认目录。
  process.env.VIDEOCUT_WORKSPACE = root;
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "视频容量隔离验证" });
    const projectId = created.snapshot.project.id, projectRoot = created.snapshot.project.rootPath;
    const file = join(projectRoot, "assets/source/source.mp4");
    await runProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    const hash = await hashMotionFile(file);
    const imported = app.registerImportedAsset({ projectId, baseRevision: 1, name: "source.mp4", kind: "video", managedPath: "assets/source/source.mp4", sourceHash: hash, provenance: { source: "local_import", acquiredAt: new Date().toISOString() } });
    app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(file) });
    const entries = Array.from({ length: 6 }, (_, i) => [`clip${i}`, { ...binding, assetId: imported.asset.id, sourceStartMs: (i % 3) * 250, sourceEndMs: (i % 3) * 250 + 500, startFrame: overlap ? 0 : i * 12, endFrame: overlap ? 12 : (i + 1) * 12 }] as const);
    const source = `import React from 'react'; import {Sequence} from 'remotion'; import {TimelineVideo} from '@videoflowcut/motion'; export default function Motion(){return <>${entries.map(([slot, b], i) => `<Sequence from={${b.startFrame}} durationInFrames={12}><TimelineVideo slot="${slot}" style={{position:'absolute',left:${overlap ? i * 64 : 0},top:0,width:64,height:64}}/></Sequence>`).join("")}</>;}`;
    const work = motionSubmissionSchema.parse({ ...motionFixture, source, width: overlap ? 384 : 64, height: 64, fps: 24, durationInFrames: overlap ? 12 : 72, videoBindings: Object.fromEntries(entries) });
    const job = app.submitManagedMotion({ projectId, baseRevision: app.readProject(projectId).revision.number, idempotencyKey: "six-clips", work });
    // 相同提交只接回原 Job，测试不伪造未知任务完成或换键重放。
    assert.equal(app.submitManagedMotion({ projectId, baseRevision: app.readProject(projectId).revision.number, idempotencyKey: "six-clips", work }).id, job.id);
    const result = await runMotionJob(app, job);
    const asset = app.readProject(projectId).snapshot.assets.find(a => a.id === result.assetId)!;
    assert.equal(asset.motion!.frameCount, work.durationInFrames);
    assert.deepEqual(asset.motion!.sourceAssetIds, [imported.asset.id]);
    const directory = join(projectRoot, asset.motion!.sourcePath, "..");
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.videoResources.uniqueSources, 1);
    assert.equal(manifest.videoResources.decodedChunks, 1);
    assert.equal((await readdir(join(directory, "frames"))).length, work.durationInFrames);
    // 用独立 FFmpeg 源采样逐槽对照输出，包含切口前后和嵌套 Sequence 内的根时钟。
    for (const [i, [, b]] of entries.entries()) {
      for (const local of [0, 11]) {
        const expectedFile = join(root, `expected-${i}-${local}.png`);
        await runProcess("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${b.sourceStartMs * 24 / 1000 + local})`, "-frames:v", "1", "-pix_fmt", "rgba", expectedFile]);
        const expected = PNG.sync.read(await readFile(expectedFile));
        const actual = PNG.sync.read(await readFile(join(directory, "frames", `frame-${String(b.startFrame + local).padStart(5, "0")}.png`)));
        for (let y = 0; y < 64; y++) {
          const start = (y * actual.width + (overlap ? i * 64 : 0)) * 4;
          assert.deepEqual(actual.data.subarray(start, start + 64 * 4), expected.data.subarray(y * 64 * 4, (y + 1) * 64 * 4), `${i}/${local}/${y}`);
        }
      }
    }
    const revision = app.readProject(projectId).revision.number;
    assert.equal((await runMotionJob(app, job)).assetId, asset.id);
    assert.equal(app.readProject(projectId).revision.number, revision);

    const bindings = entries.map(([slot, value]) => ({ slot, ...value, managedPath: "assets/source/source.mp4", hash }));
    await assert.rejects(planMotionVideos(projectRoot, work, bindings.map((b, i) => i === 5 ? { ...b, hash: "0".repeat(64) } : b)), /VIDEO_CHANGED/);
    await assert.rejects(planMotionVideos(projectRoot, work, bindings.map((b, i) => i === 5 ? { ...b, sourceStartMs: 1900, sourceEndMs: 2400 } : b)), /SOURCE_RANGE/);
    const plan = await planMotionVideos(projectRoot, work, bindings);
    const provider = await createMotionVideoProvider(projectRoot, root, work, plan, undefined, { frameCacheBytes: 1024, scratchBytes: 1, diskReserveBytes: 1024, frameTimeoutMs: 12000 });
    try {
      await assert.rejects(provider.getFrame("missing", 0), /MOTION_VIDEO_RANGE/);
      await assert.rejects(provider.getFrame("clip5", entries[5]![1].endFrame), /MOTION_VIDEO_RANGE/);
      await assert.rejects(provider.getFrame("clip5", entries[5]![1].startFrame), /WORKING_SET/);
      assert.equal(provider.stats.decodedChunks, 0);
    } finally { await provider.close(); }
    // 资源失败不影响已经完整发布的作品，也不产生第二个半成品。
    assert.equal(app.readProject(projectId).revision.number, revision);
    assert.equal(app.readProject(projectId).snapshot.assets.filter(a => a.motion).length, 1);
    if (overlap) {
      const failedWork = { ...work, name: "资源不足隔离验证" };
      const failedJob = app.submitManagedMotion({ projectId, baseRevision: revision, idempotencyKey: "resource-failure", work: failedWork });
      const beforeFailure = app.readProject(projectId).revision.number;
      await assert.rejects(runMotionJob(app, failedJob, async (_work, _directory, _images, videoProvider) => {
        // 请求超过实际可用磁盘的空间，走真实诊断和清理链，不发布部分渲染。
        await videoProvider!.reserveDiskSpace(Number.MAX_SAFE_INTEGER);
        throw new Error("不应通过磁盘检查");
      }), /MOTION_DISK_SPACE/);
      assert.equal(app.readProject(projectId).revision.number, beforeFailure);
      assert.equal(app.readProject(projectId).snapshot.assets.filter(a => a.motion).length, 1);
      assert.deepEqual(await readdir(join(projectRoot, "assets/derived/motion", failedJob.id)), []);
      assert.ok(app.trackJob(failedJob.id).result?.motionFailure);
    }
  } finally {
    app.close();
    if (previousWorkspace === undefined) delete process.env.VIDEOCUT_WORKSPACE; else process.env.VIDEOCUT_WORKSPACE = previousWorkspace;
    await rm(root, { recursive: true, force: true });
  }
});
