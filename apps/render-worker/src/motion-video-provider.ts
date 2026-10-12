import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, statfs, utimes, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { PNG } from "pngjs";
import { runProcess } from "@videocut/speech";
import { readRuntimeConfig } from "@videocut/project-overview";
import type { MotionSubmission, MotionVideoProvider } from "../../../packages/motion-work/src/schema.js";
import type { MotionVideoClip, MotionVideoPlan } from "./motion-video-plan.js";
import { hashMotionFile } from "./motion-video.js";

interface Chunk { key: string; bytes: number; touched: number; hashes: string[]; count: number }
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function acquireCacheLock(cacheRoot: string) {
  const path = join(cacheRoot, ".lock");
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await mkdir(path); await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, token })); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8").catch(() => "{}"));
      let active = true;
      if (Number.isInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (error) { active = (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
      if (active || attempt) throw new Error("MOTION_VIDEO_CACHE_BUSY: 同项目解码缓存正在使用");
      await rm(path, { recursive: true, force: true }); continue;
    }
    return async () => {
      const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
      if (owner.token !== token) throw new Error("MOTION_VIDEO_CACHE_LOCK_CHANGED");
      await rm(path, { recursive: true, force: true });
    };
  }
  throw new Error("MOTION_VIDEO_CACHE_BUSY");
}

/** 源缓存是可重建数据；原片和正式作品不在这个目录，也不参与回收。 */
export async function createMotionVideoProvider(root: string, _directory: string, work: MotionSubmission, plan: MotionVideoPlan, signal?: AbortSignal, limits = readRuntimeConfig().motion): Promise<MotionVideoProvider & { stats: Record<string, number> }> {
  const cacheRoot = join(root, ".cache", "motion-video");
  await mkdir(cacheRoot, { recursive: true });
  const cacheRelative = relative(await realpath(root), await realpath(cacheRoot));
  if (isAbsolute(cacheRelative) || cacheRelative.startsWith("..")) throw new Error("MOTION_VIDEO_PATH_REJECTED");
  const releaseLock = await acquireCacheLock(cacheRoot);
  try {
  const decoderVersion = plan.sources.length ? (await runProcess("ffmpeg", ["-version"])).split("\n")[0] : "";
  const chunks = new Map<string, Chunk>();
  const memory = new Map<string, Buffer>();
  let memoryBytes = 0, diskBytes = 0, closed = false;
  const stats = { uniqueSources: plan.sources.length, sourceBytes: plan.sourceBytes, decodedChunks: 0, cacheHits: 0, memoryPeakBytes: 0, diskPeakBytes: 0, decodedBytes: 0 };
  // Render Worker 串行执行；启动时只清理过期的未发布块，绝不把半块当缓存使用。
  for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(cacheRoot, entry.name);
    if (/^[a-f0-9]{64}\.pending$/u.test(entry.name)) {
      // 项目缓存已独占；没有活动解码时，崩溃遗留的半块可以立即删除。
      await rm(path, { recursive: true, force: true });
    } else if (/^[a-f0-9]{64}$/u.test(entry.name)) {
      try {
        const manifestPath = join(path, "manifest.json");
        if ((await stat(manifestPath)).size > 16384) throw new Error("缓存索引过大");
        const chunk = JSON.parse(await readFile(manifestPath, "utf8")) as Chunk;
        if (chunk.key !== entry.name || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0 || !Number.isInteger(chunk.count) || chunk.count < 1 || chunk.count > 120 || chunk.hashes.length !== chunk.count || chunk.hashes.some(hash => !/^[a-f0-9]{64}$/u.test(hash))) throw new Error("缓存索引无效");
        let actualBytes = (await stat(manifestPath)).size;
        for (let frame = 0; frame < chunk.count; frame++) actualBytes += (await stat(join(path, `${frame}.png`))).size;
        chunks.set(chunk.key, { ...chunk, bytes: actualBytes, touched: (await stat(path)).mtimeMs });
        diskBytes += actualBytes;
      } catch { await rm(path, { recursive: true, force: true }); }
    }
  }
  const evict = async (required: number, keep?: string) => {
    if (required > limits.scratchBytes) throw new Error("MOTION_VIDEO_WORKING_SET: 临时盘限额不足以保存一个解码块");
    for (const chunk of [...chunks.values()].sort((a, b) => a.touched - b.touched)) {
      if (diskBytes + required <= limits.scratchBytes) break;
      if (chunk.key === keep) continue;
      await rm(join(cacheRoot, chunk.key), { recursive: true, force: true });
      chunks.delete(chunk.key); diskBytes -= chunk.bytes;
    }
  };
  await evict(0);
  const reserveDiskSpace = async (bytes: number) => {
    let disk = await statfs(cacheRoot);
    for (const chunk of [...chunks.values()].sort((a, b) => a.touched - b.touched)) {
      if (disk.bavail * disk.bsize >= bytes + limits.diskReserveBytes) break;
      await rm(join(cacheRoot, chunk.key), { recursive: true, force: true }); chunks.delete(chunk.key); diskBytes -= chunk.bytes;
      disk = await statfs(cacheRoot);
    }
    if (disk.bavail * disk.bsize < bytes + limits.diskReserveBytes) throw new Error(`MOTION_DISK_SPACE: 可用${disk.bavail * disk.bsize}字节，需要${bytes + limits.diskReserveBytes}字节`);
  };
  stats.diskPeakBytes = diskBytes;
  let queue: Promise<unknown> = Promise.resolve();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error("MOTION_CANCELLED"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  const decode = async (clip: MotionVideoClip, key: string, start: number, count: number, phase: number, maximumBytes: number): Promise<Chunk> => {
    await evict(maximumBytes);
    await reserveDiskSpace(maximumBytes);
    const pendingDir = join(cacheRoot, `${key}.pending`);
    await rm(pendingDir, { recursive: true, force: true });
    await mkdir(pendingDir);
    const geometry = clip.source.geometry;
    // seek 保留关键帧至目标之间的 PTS；每个块沿同一个绝对采样网格，不能重置 STARTPTS。
    const origin = geometry.startTimeSeconds + phase / (work.fps * 1000);
    const seek = Math.max(geometry.startTimeSeconds, origin + start / work.fps);
    const filter = `setpts=PTS-(${origin})/TB,fps=${work.fps}:start_time=${start / work.fps}:round=up:eof_action=pass,scale=${geometry.rotation % 180 ? clip.height : clip.width}:${geometry.rotation % 180 ? clip.width : clip.height},setsar=1${geometry.rotation === 90 ? ",transpose=cclock" : geometry.rotation === 180 ? ",hflip,vflip" : geometry.rotation === 270 ? ",transpose=clock" : ""}`;
    const child = spawn("ffmpeg", ["-v", "error", "-nostdin", "-threads", "1", "-noautorotate", "-copyts", "-noaccurate_seek", "-seek_timestamp", "1", "-ss", String(seek), "-i", clip.source.path, "-map", `0:${geometry.streamIndex}`, "-an", "-sn", "-dn", "-vf", filter, "-frames:v", String(count), "-pix_fmt", "rgba", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", timeout = false, bytes = 0, frames = 0;
    const hashes: string[] = [];
    child.stderr.on("data", part => { stderr = (stderr + String(part)).slice(-4000); });
    const done = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(timeout ? "MOTION_VIDEO_DECODE_TIMEOUT" : `MOTION_VIDEO_DECODE_FAILED: ${stderr}`))); });
    void done.catch(() => undefined);
    const kill = () => child.kill();
    controller.signal.addEventListener("abort", kill, { once: true });
    let timer: ReturnType<typeof setTimeout>;
    const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => { timeout = true; child.kill(); }, 120_000); };
    resetTimer();
    const frameBytes = clip.width * clip.height * 4;
    let buffer = Buffer.alloc(frameBytes), filled = 0;
    try {
      controller.signal.throwIfAborted();
      for await (const data of child.stdout) {
        controller.signal.throwIfAborted(); resetTimer();
        let offset = 0;
        while (offset < data.length) {
          const size = Math.min(frameBytes - filled, data.length - offset);
          data.copy(buffer, filled, offset, offset + size); filled += size; offset += size;
          if (filled !== frameBytes) continue;
          if (frames >= count) throw new Error("MOTION_VIDEO_FRAME_COUNT");
          const image = new PNG({ width: clip.width, height: clip.height }); image.data = buffer;
          const png = PNG.sync.write(image, { colorType: 6, deflateLevel: 3 });
          bytes += png.length;
          if (bytes > maximumBytes) throw new Error("MOTION_VIDEO_WORKING_SET: 解码块超过预留空间");
          await writeFile(join(pendingDir, `${frames}.png`), png, { flag: "wx" });
          hashes.push(digest(png)); frames++; filled = 0;
        }
      }
      await done; controller.signal.throwIfAborted();
      if (timeout) throw new Error("MOTION_VIDEO_DECODE_TIMEOUT");
      if (filled || frames !== count) throw new Error(`MOTION_VIDEO_SOURCE_SHORT: 需要${count}帧，实际${frames}帧`);
      const chunk = { key, bytes: bytes + 16384, touched: Date.now(), hashes, count };
      await writeFile(join(pendingDir, "manifest.json"), JSON.stringify(chunk));
      chunk.bytes = bytes + (await stat(join(pendingDir, "manifest.json"))).size;
      controller.signal.throwIfAborted();
      await rename(pendingDir, join(cacheRoot, key));
      chunks.set(key, chunk); diskBytes += chunk.bytes;
      stats.decodedChunks++; stats.decodedBytes += bytes; stats.diskPeakBytes = Math.max(stats.diskPeakBytes, diskBytes);
      return chunk;
    } finally {
      clearTimeout(timer!); controller.signal.removeEventListener("abort", kill); child.kill();
      await done.catch(() => undefined); await rm(pendingDir, { recursive: true, force: true });
    }
  };

  const get = async (slot: string, frame: number): Promise<Buffer> => {
    controller.signal.throwIfAborted();
    if (closed) throw new Error("MOTION_VIDEO_PROVIDER_CLOSED");
    const clip = plan.clips[slot];
    if (!clip || !Number.isInteger(frame) || frame < clip.startFrame || frame >= clip.endFrame) throw new Error("MOTION_VIDEO_RANGE");
    const rawFrameBytes = clip.width * clip.height * 4;
    const perFrame = Math.ceil((rawFrameBytes + clip.height) * 1.02) + 4096;
    const chunkFrames = Math.min(work.fps * 2, Math.floor((Math.min(64 * 1024 * 1024, limits.scratchBytes) - 16384) / perFrame));
    if (chunkFrames < 1) throw new Error("MOTION_VIDEO_WORKING_SET: 临时盘不能容纳一帧");
    const sourceTick = clip.binding.sourceStartMs * work.fps;
    if (!Number.isSafeInteger(sourceTick)) throw new Error("MOTION_VIDEO_TIME_RANGE");
    const phase = sourceTick % 1000;
    const absoluteIndex = Math.floor(sourceTick / 1000) + frame - clip.startFrame;
    const start = Math.floor(absoluteIndex / chunkFrames) * chunkFrames;
    const count = Math.min(chunkFrames, Math.ceil((clip.source.geometry.durationMs * work.fps - phase) / 1000) - start);
    const signature = ["pts-hold-1", decoderVersion, clip.source.hash, clip.source.geometry, clip.width, clip.height, work.fps, phase, start, count];
    const key = digest(JSON.stringify(signature));
    const index = absoluteIndex - start;
    const memoryKey = `${key}:${index}`;
    const hit = memory.get(memoryKey);
    if (hit) { memory.delete(memoryKey); memory.set(memoryKey, hit); const chunk = chunks.get(key); if (chunk) chunk.touched = Date.now(); stats.cacheHits++; return hit; }
    let chunk = chunks.get(key);
    const cacheHit = Boolean(chunk);
    if (!chunk) chunk = await decode(clip, key, start, count, phase, perFrame * count + 16384);
    let png: Buffer | undefined;
    try {
      if ((await stat(join(cacheRoot, key, `${index}.png`))).size > perFrame) throw new Error("缓存帧过大");
      png = await readFile(join(cacheRoot, key, `${index}.png`));
      if (digest(png) !== chunk.hashes[index]) throw new Error("解码帧哈希变化");
    } catch {
      // 解码缓存可重建；正式作品损坏由 motion-job 报错，两者不能混淆。
      await rm(join(cacheRoot, key), { recursive: true, force: true }); chunks.delete(key); diskBytes -= chunk.bytes;
      chunk = await decode(clip, key, start, count, phase, perFrame * count + 16384);
      png = await readFile(join(cacheRoot, key, `${index}.png`));
      if (digest(png) !== chunk.hashes[index]) throw new Error("MOTION_VIDEO_CACHE_CORRUPT");
    }
    chunk.touched = Date.now(); if (cacheHit) stats.cacheHits++;
    if (png.length <= limits.frameCacheBytes) {
      while (memoryBytes + png.length > limits.frameCacheBytes && memory.size) {
        const oldest = memory.keys().next().value!; memoryBytes -= memory.get(oldest)!.length; memory.delete(oldest);
      }
      memory.set(memoryKey, png); memoryBytes += png.length;
      stats.memoryPeakBytes = Math.max(stats.memoryPeakBytes, memoryBytes);
    }
    return png;
  };
  return {
    videos: Object.fromEntries(Object.entries(plan.clips).map(([slot, { binding: _binding, source: _source, ...video }]) => [slot, video])), stats,
    workingSetBytes: Object.values(plan.clips).reduce((maximum, clip) => {
      const perFrame = Math.ceil((clip.width * clip.height * 4 + clip.height) * 1.02) + 4096;
      const count = Math.min(work.fps * 2, Math.ceil(clip.source.geometry.durationMs * work.fps / 1000), Math.floor((Math.min(64 * 1024 * 1024, limits.scratchBytes) - 16384) / perFrame));
      return Math.max(maximum, Math.max(1, count) * perFrame + 16384);
    }, 0),
    reserveDiskSpace,
    getFrame(slot, frame) {
      // 所有 FFmpeg 解码串行；相同请求排队后命中缓存，不产生第二份解码。
      const task = queue.then(() => get(slot, frame)); queue = task.catch(() => undefined); return task;
    },
    async releaseBefore() { await evict(0); },
    async verifySources() {
      controller.signal.throwIfAborted();
      await queue;
      for (const source of plan.sources) {
        controller.signal.throwIfAborted();
        let changed = false;
        try { changed = await hashMotionFile(source.path, controller.signal) !== source.hash; }
        catch (error) { controller.signal.throwIfAborted(); changed = true; }
        if (!changed) continue;
        // 运行中源变化可能污染已发布的解码块；恢复原件后也不能复用这些错误帧。
        for (const chunk of chunks.values()) await rm(join(cacheRoot, chunk.key), { recursive: true, force: true });
        chunks.clear(); diskBytes = 0; memory.clear(); memoryBytes = 0;
        throw new Error("MOTION_VIDEO_CHANGED");
      }
    },
    async close() {
      if (closed) return; closed = true; controller.abort(new Error("MOTION_VIDEO_PROVIDER_CLOSED"));
      try { await queue; for (const chunk of chunks.values()) await utimes(join(cacheRoot, chunk.key), new Date(chunk.touched), new Date(chunk.touched)); }
      finally { memory.clear(); memoryBytes = 0; signal?.removeEventListener("abort", abort); await releaseLock(); }
    }
  };
  } catch (error) { await releaseLock(); throw error; }
}
