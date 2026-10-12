import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { runProcess } from "@videocut/speech";
import { planMotionVideos } from "../apps/render-worker/src/motion-video-plan.js";
import { createMotionVideoProvider } from "../apps/render-worker/src/motion-video-provider.js";
import { hashMotionFile } from "../apps/render-worker/src/motion-video.js";
import { motionFixture } from "./fixtures/managed-motion.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";

const limits = { frameCacheBytes: 12000, scratchBytes: 120000, diskReserveBytes: 1024, frameTimeoutMs: 12000 };

test("高纹理选段真实累计解码超过512MiB，有界缓存回收后仍完整完成", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-motion-texture-"));
  try {
    const image = new PNG({ width: 768, height: 768 }); let seed = 123456789;
    for (let index = 0; index < image.data.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; image.data[index + channel] = seed & 255; }
      image.data[index + 3] = 255;
    }
    const still = join(root, "noise.png"); await writeFile(still, PNG.sync.write(image));
    const file = join(root, "texture.mp4");
    await runProcess("ffmpeg", ["-v", "error", "-loop", "1", "-framerate", "24", "-i", still, "-frames:v", "360", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv444p", file]);
    const binding = { slot: "a", assetId: "a", managedPath: "texture.mp4", hash: await hashMotionFile(file), sourceStartMs: 0, sourceEndMs: 15000, startFrame: 0, endFrame: 360 };
    const work = { ...motionFixture, width: 768, height: 768, fps: 24, durationInFrames: 360 };
    const budget = { ...limits, frameCacheBytes: 4 * 1024 ** 2, scratchBytes: 32 * 1024 ** 2 };
    const provider = await createMotionVideoProvider(root, root, work, await planMotionVideos(root, work, [binding]), undefined, budget);
    try {
      for (let frame = 0; frame < 360; frame++) await provider.getFrame("a", frame);
      assert.ok(provider.stats.decodedBytes > 512 * 1024 ** 2, String(provider.stats.decodedBytes));
      assert.ok(provider.stats.diskPeakBytes <= budget.scratchBytes); assert.ok(provider.stats.memoryPeakBytes <= budget.frameCacheBytes);
    } finally { await provider.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("小工作区频繁分块回收仍与完整PTS采样一致，跨槽/跨作品复用且坏缓存可重建", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-motion-provider-"));
  try {
    for (const rate of ["24000/1001", "30", "vfr"]) {
      const file = join(root, `${rate === "24000/1001" ? "fractional" : rate}.mp4`);
      await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=64x64:r=${rate === "vfr" ? "30" : rate}:d=5`, ...(rate === "vfr" ? ["-vf", "select='not(mod(n,2))+not(mod(n,5))'", "-fps_mode", "vfr"] : []), "-c:v", "libx264", "-g", "90", file]);
      const binding = { assetId: "source", managedPath: file, hash: await hashMotionFile(file), sourceStartMs: 333, sourceEndMs: 4333, startFrame: 10, endFrame: 106 };
      const work = motionSubmissionSchema.parse({ ...motionFixture, width: 64, height: 64, fps: 24, durationInFrames: 106 });
      const plan = await planMotionVideos(root, work, [{ ...binding, slot: "a" }, { ...binding, slot: "b" }]);
      assert.equal(plan.sources.length, 1);
      const reference = join(root, `ref-${rate === "24000/1001" ? "fractional" : rate}`); await mkdir(reference);
      await runProcess("ffmpeg", ["-v", "error", "-i", file, "-vf", "setpts=PTS-(0.333)/TB,fps=24:start_time=0:round=up:eof_action=pass", "-frames:v", "96", "-pix_fmt", "rgba", join(reference, "%d.png")]);
      const provider = await createMotionVideoProvider(root, root, work, plan, undefined, limits);
      try {
        await assert.rejects(createMotionVideoProvider(root, root, work, plan, undefined, limits), /CACHE_BUSY/);
        const [a, b] = await Promise.all([provider.getFrame("a", 10), provider.getFrame("b", 10)]);
        assert.deepEqual(a, b); assert.equal(provider.stats.decodedChunks, 1);
        for (let frame = 10; frame < 106; frame++) assert.deepEqual(PNG.sync.read(await provider.getFrame("a", frame)).data, PNG.sync.read(await readFile(join(reference, `${frame - 9}.png`))).data, `${rate} 第${frame}帧`);
        assert.ok(provider.stats.memoryPeakBytes <= limits.frameCacheBytes); assert.ok(provider.stats.diskPeakBytes <= limits.scratchBytes);
        assert.ok(provider.stats.decodedChunks > 3); assert.ok(provider.stats.decodedBytes > limits.scratchBytes);
        await assert.rejects(provider.getFrame("a", 106), /MOTION_VIDEO_RANGE/);
      } finally { await provider.close(); }
      const next = await createMotionVideoProvider(root, root, work, plan, undefined, limits);
      try {
        await next.getFrame("a", 105); assert.equal(next.stats.decodedChunks, 0, "下一作品应复用最后的已发布块");
      } finally { await next.close(); }
      const cacheRoot = join(root, ".cache/motion-video");
      const dirs = await readdir(cacheRoot);
      assert.ok(dirs.some(name => /^[a-f0-9]{64}$/u.test(name)), "必须实际损坏已有缓存，不能只测试缺失缓存");
      for (const dir of dirs.filter(name => /^[a-f0-9]{64}$/u.test(name))) {
        for (const name of (await readdir(join(cacheRoot, dir))).filter(name => name.endsWith(".png"))) await writeFile(join(cacheRoot, dir, name), "损坏");
      }
      const repaired = await createMotionVideoProvider(root, root, work, plan, undefined, limits);
      try { assert.deepEqual(PNG.sync.read(await repaired.getFrame("a", 105)).data, PNG.sync.read(await readFile(join(reference, "96.png"))).data); assert.equal(repaired.stats.decodedChunks, 1); }
      finally { await repaired.close(); }
      const fixedSource = await readFile(file);
      const changed = await createMotionVideoProvider(root, root, work, plan, undefined, limits);
      try {
        await changed.getFrame("a", 105); await writeFile(file, "运行中源变化");
        await assert.rejects(changed.verifySources(), /VIDEO_CHANGED/);
        const remaining = await readdir(cacheRoot);
        assert.equal(remaining.some(name => /^[a-f0-9]{64}$/u.test(name)), false);
      } finally { await changed.close(); await writeFile(file, fixedSource); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("大于512MiB原片使用短选段不被拒绝；源变化与极小工作区明确失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-motion-large-source-"));
  try {
    const file = join(root, "large.mp4");
    await runProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=64x64:r=24:d=1", "-c:v", "libx264", file]);
    // 合法MP4 free box扩大原件，不需要制造几十分钟无关画面。
    const handle = await open(file, "r+");
    try { const size = (await handle.stat()).size; const box = Buffer.alloc(8); box.writeUInt32BE(513 * 1024 * 1024, 0); box.write("free", 4); await handle.write(box, 0, 8, size); await handle.truncate(size + 513 * 1024 * 1024); }
    finally { await handle.close(); }
    const binding = { slot: "a", assetId: "a", managedPath: "large.mp4", hash: await hashMotionFile(file), sourceStartMs: 0, sourceEndMs: 500, startFrame: 0, endFrame: 12 };
    const work = { ...motionFixture, width: 64, height: 64, fps: 24, durationInFrames: 12 };
    const plan = await planMotionVideos(root, work, [binding, { ...binding, slot: "b" }]);
    assert.ok(plan.sourceBytes > 512 * 1024 ** 2); assert.equal(plan.sourceBytes, (await stat(file)).size);
    const provider = await createMotionVideoProvider(root, root, work, plan, undefined, limits);
    try { assert.equal(PNG.sync.read(await provider.getFrame("a", 0)).width, 64); }
    finally { await provider.close(); }
    // 模拟进程崩溃留下的锁和未发布块；下一任务不使用或永久保留半块。
    const cacheRoot = join(root, ".cache/motion-video");
    await mkdir(join(cacheRoot, ".lock")); await writeFile(join(cacheRoot, ".lock/owner.json"), JSON.stringify({ pid: 2147483647, token: "crashed" }));
    const pending = join(cacheRoot, `${"a".repeat(64)}.pending`); await mkdir(pending); await writeFile(join(pending, "0.png"), "partial");
    const recovered = await createMotionVideoProvider(root, root, work, plan, undefined, limits);
    try { await assert.rejects(stat(pending), /ENOENT/); await recovered.getFrame("a", 0); await assert.rejects(recovered.reserveDiskSpace(Number.MAX_SAFE_INTEGER), /MOTION_DISK_SPACE/); }
    finally { await recovered.close(); }
    const small = await createMotionVideoProvider(root, root, work, plan, undefined, { ...limits, scratchBytes: 1 });
    try { await assert.rejects(small.getFrame("a", 0), /WORKING_SET/); } finally { await small.close(); }
    await writeFile(file, "changed"); await assert.rejects(planMotionVideos(root, work, [binding]), /VIDEO_CHANGED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("第628秒选段定位关键帧后精确采样，不从片头重建时间轴", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-motion-late-seek-"));
  try {
    const file = join(root, "late.mp4");
    await runProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=2:d=635", "-g", "20", "-c:v", "libx264", file]);
    const binding = { slot: "a", assetId: "a", managedPath: "late.mp4", hash: await hashMotionFile(file), sourceStartMs: 628000, sourceEndMs: 631334, startFrame: 90, endFrame: 170 };
    const work = { ...motionFixture, width: 64, height: 64, fps: 24, durationInFrames: 792 };
    const provider = await createMotionVideoProvider(root, root, work, await planMotionVideos(root, work, [binding]), undefined, limits);
    try {
      const reference = join(root, "reference.png");
      await runProcess("ffmpeg", ["-v", "error", "-i", file, "-vf", "setpts=PTS-628/TB,fps=24:start_time=0:round=up", "-frames:v", "1", "-pix_fmt", "rgba", reference]);
      assert.deepEqual(PNG.sync.read(await provider.getFrame("a", 90)).data, PNG.sync.read(await readFile(reference)).data);
      assert.equal(provider.videos.a.frameCount, 80); assert.ok(provider.stats.decodedChunks <= 1);
    } finally { await provider.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("非零容器PTS和长VFR间隔仍使用归一化源时钟，不跳到下一幅画面", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-motion-pts-origin-"));
  try {
    for (const gap of [false, true]) {
      const file = join(root, gap ? "gap.mp4" : "offset.mp4");
      await runProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=24:d=7", "-vf", gap ? "select='eq(n,0)+eq(n,120)+eq(n,144)'" : "setpts=PTS+10/TB", "-fps_mode", "passthrough", "-c:v", "libx264", file]);
      const binding = { slot: "a", assetId: "a", managedPath: file, hash: await hashMotionFile(file), sourceStartMs: 2500, sourceEndMs: 4500, startFrame: 0, endFrame: 48 };
      const work = { ...motionFixture, width: 64, height: 64, fps: 24, durationInFrames: 48 };
      const plan = await planMotionVideos(root, work, [binding]);
      if (!gap) assert.equal(plan.sources[0].geometry.startTimeSeconds, 10);
      const provider = await createMotionVideoProvider(root, root, work, plan, undefined, limits);
      try {
        const expected = join(root, gap ? "gap.png" : "offset.png");
        await runProcess("ffmpeg", ["-v", "error", "-copyts", "-i", file, "-vf", `setpts=PTS-(${plan.sources[0].geometry.startTimeSeconds + 2.5})/TB,fps=24:start_time=0:round=up:eof_action=pass`, "-frames:v", "1", "-pix_fmt", "rgba", expected]);
        assert.deepEqual(PNG.sync.read(await provider.getFrame("a", 0)).data, PNG.sync.read(await readFile(expected)).data);
        if (gap) assert.deepEqual(await provider.getFrame("a", 0), await provider.getFrame("a", 47));
      } finally { await provider.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
