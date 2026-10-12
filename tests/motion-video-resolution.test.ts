import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { runProcess } from "@videocut/speech";
import { prepareMotionVideos, hashMotionFile } from "../apps/render-worker/src/motion-video.js";
import { motionDecodeDimensions, parseMotionVideoGeometry } from "../apps/render-worker/src/motion-video-geometry.js";
import { motionSubmissionSchema, boundMotionVideoSchema } from "../packages/motion-work/src/schema.js";
import { motionFixture } from "./fixtures/managed-motion.js";
import { motionHash, MOTION_ENGINE_VERSION } from "../packages/motion-work/src/compiler.js";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";
import { MotionDiagnostics } from "../apps/render-worker/src/motion-diagnostics.js";

const timing = { sourceStartMs: 0, sourceEndMs: 1000, startFrame: 0, endFrame: 30 };
test("固定Job绑定和公开比例不一致，解码前拒绝", async (t) => {
  const work = motionSubmissionSchema.parse({ ...motionFixture, durationInFrames: 30, videoBindings: { footage: { assetId: "a", ...timing, decodeScale: 0.5 } } });
  const boundVideos = [{ slot: "footage", assetId: "a", managedPath: "source.mp4", hash: "a".repeat(64), ...timing, decodeScale: 0.75 }];
  const version = motionHash(work, [], MOTION_ENGINE_VERSION, boundVideos);
  // 仅隔离诊断落盘，保留真实输入校验；测试不得写运行中的工作区。
  t.mock.method(MotionDiagnostics.prototype, "save", async () => ({ reportPath: "test-only" }));
  const app = { trackJob: () => ({ status: "running" }), updateJob: () => {}, readProject: () => { throw new Error("不应读取项目或生成产物"); } } as any;
  await assert.rejects(runMotionJob(app, { kind: "motion_generation", payload: { work, boundVideos, boundImages: [], version, engineVersion: MOTION_ENGINE_VERSION } } as any), /MOTION_VIDEO_BINDING_MISMATCH/);
});

test("比例严格校验，几何尺寸不静默夹到边界", () => {
  for (const decodeScale of [0, -1, 1.01, NaN, Infinity]) {
    assert.equal(motionSubmissionSchema.safeParse({ ...motionFixture, durationInFrames: 30, videoBindings: { v: { assetId: "a", ...timing, decodeScale } } }).success, false);
    assert.equal(boundMotionVideoSchema.safeParse({ slot: "v", assetId: "a", managedPath: "a", hash: "a".repeat(64), ...timing, decodeScale }).success, false);
  }
  assert.deepEqual(motionDecodeDimensions({ displayWidth: 1920, displayHeight: 1080 }, { width: 768, height: 1344 }), { width: 768, height: 432 });
  assert.deepEqual(motionDecodeDimensions({ displayWidth: 1920, displayHeight: 1080 }, { width: 768, height: 1344 }, 0.75), { width: 1440, height: 810 });
  assert.throws(() => motionDecodeDimensions({ displayWidth: 3840, displayHeight: 2160 }, motionFixture, 1), /DIMENSION_BUDGET/);
  assert.throws(() => motionDecodeDimensions({ displayWidth: 320, displayHeight: 180 }, motionFixture, 0.001), /DIMENSION_BUDGET/);
  assert.throws(() => parseMotionVideoGeometry({ streams: [{ index: 0, codec_type: "video", width: 320, height: 180, duration: 1, tags: { rotate: 45 } }] }), /正交/);
});

test("四种旋转和SAR实际解码与显示方向一致；旧引擎不进入新生成", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-geometry-"));
  try {
    const source = join(root, "source.mp4");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=30:d=1,drawbox=x=20:y=20:w=40:h=40:color=white:t=fill", "-c:v", "libx264", source]);
    for (const rotation of [0, 90, 180, 270]) {
      const file = join(root, `r${rotation}.mp4`);
      await runProcess("ffmpeg", ["-y", "-v", "error", "-display_rotation", String(rotation), "-i", source, "-c", "copy", file]);
      const binding = { slot: "footage", assetId: "a", managedPath: `r${rotation}.mp4`, hash: await hashMotionFile(file), ...timing };
      const work = { ...motionFixture, durationInFrames: 30, width: rotation % 180 ? 180 : 320, height: rotation % 180 ? 320 : 180 };
      const provider = await prepareMotionVideos(root, join(root, `new${rotation}`), work, [binding]);
      try {
        const frame = PNG.sync.read(await provider.getFrame("footage", 0)); assert.equal(frame.width, work.width); assert.equal(frame.height, work.height);
        const expected = join(root, `expected${rotation}.png`);
        await runProcess("ffmpeg", ["-y", "-v", "error", "-i", file, "-frames:v", "1", "-pix_fmt", "rgba", expected]);
        assert.deepEqual(frame.data, PNG.sync.read(await readFile(expected)).data);
      } finally { await provider.close(); }
      await assert.rejects(prepareMotionVideos(root, join(root, "previous"), work, [binding], "managed-motion-11"), /ENGINE_UPGRADE_REQUIRED/);
    }
    const sar = join(root, "sar.mp4"); await runProcess("ffmpeg", ["-y", "-v", "error", "-i", source, "-vf", "setsar=2", "-c:v", "libx264", sar]);
    const binding = { slot: "footage", assetId: "a", managedPath: "sar.mp4", hash: await hashMotionFile(sar), ...timing };
    const provider = await prepareMotionVideos(root, join(root, "sar-new"), { ...motionFixture, durationInFrames: 30, width: 640, height: 180 }, [binding]);
    try { assert.equal(provider.videos.footage.width, 640); assert.equal(provider.videos.footage.height, 180); assert.equal(provider.videos.footage.geometry?.sar, 2); } finally { await provider.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
