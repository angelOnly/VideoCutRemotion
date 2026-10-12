import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { createApplication } from "@videocut/application";
import { runProcess } from "@videocut/speech";
import { RevisionRenderer } from "../apps/render-worker/src/exporter.js";

// 每一源帧都有可从成片像素读回的序号，避免“渲染成功”掩盖回退、闪帧和错误取帧。
const root = await mkdtemp(join(tmpdir(), "videocut-video-timing-"));
process.env.VIDEOCUT_WORKSPACE = root;
const app = createApplication(root);
const { snapshot } = app.createProject({ name: "逐帧时间与声音所有权隔离回归" });
const frames = join(root, "frames");
await mkdir(frames);
for (let frame = 0; frame < 160; frame++) {
  const png = new PNG({ width: 320, height: 320 });
  for (let y = 0; y < 320; y++) for (let x = 0; x < 320; x++) {
    const value = y < 160 ? ((frame >> Math.floor(x / 40)) & 1 ? 235 : 20) : ((x + frame * 7) % 320 < 80 ? 220 : 45);
    const pixel = (y * 320 + x) * 4;
    png.data.set([value, value, value, 255], pixel);
  }
  await writeFile(join(frames, `${String(frame).padStart(4, "0")}.png`), PNG.sync.write(png));
}
const source = join(snapshot.project.rootPath, "indexed.mp4");
await runProcess("ffmpeg", ["-v", "error", "-framerate", "25", "-i", join(frames, "%04d.png"), "-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*(220*t+55*t*t)):s=16000:d=6.4", "-c:v", "libx264", "-g", "60", "-bf", "3", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]);
snapshot.timeline.width = 320;
snapshot.timeline.height = 320;
snapshot.timeline.fps = 24;
snapshot.timeline.durationInFrames = 120;
const track = snapshot.timeline.tracks.find((entry) => entry.name === "Actor / A-roll")!;
snapshot.assets = [{ id: "timing-source", name: "indexed.mp4", kind: "video", managedPath: "indexed.mp4", status: "ready", metadata: { width: 320, height: 320, fps: 25, durationMs: 6400, hasAudio: true } } as any];
snapshot.timeline.items = [
  { id: "disabled-old", trackId: track.id, assetId: "timing-source", startFrame: 0, endFrame: 120, sourceStartFrame: 0, sourceEndFrame: 120, disabled: true },
  { id: "first", trackId: track.id, assetId: "timing-source", startFrame: 0, endFrame: 48, sourceStartFrame: 0, sourceEndFrame: 48, disabled: false },
  { id: "second", trackId: track.id, assetId: "timing-source", startFrame: 48, endFrame: 120, sourceStartFrame: 60, sourceEndFrame: 132, disabled: false }
];
const renderer = new RevisionRenderer(resolve("apps/render-worker/src/render-entry.tsx"), 4);
const target = join(root, "rendered.mp4");
await renderer.render(snapshot, target);
const decoded = join(root, "decoded.gray");
await runProcess("ffmpeg", ["-v", "error", "-i", target, "-an", "-pix_fmt", "gray", "-f", "rawvideo", decoded]);
const raw = await readFile(decoded);
assert.equal(raw.length, 120 * 320 * 320);
const failures: { frame: number; actual: number; expected: number }[] = [];
const sourceIndices: number[] = [];
for (let frame = 0; frame < 120; frame++) {
  let actual = 0;
  for (let bit = 0; bit < 8; bit++) if (raw[frame * 320 * 320 + 80 * 320 + bit * 40 + 20]! > 128) actual |= 1 << bit;
  sourceIndices.push(actual);
  const expected = (frame + (frame >= 48 ? 12 : 0)) / 24 * 25;
  if (Math.abs(actual - expected) > 1.01 || (frame > 0 && actual < sourceIndices[frame - 1]!)) failures.push({ frame, actual, expected });
}
const audioPath = join(root, "decoded.f32");
await runProcess("ffmpeg", ["-v", "error", "-i", target, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", audioPath]);
const audioBytes = await readFile(audioPath);
const samples = Array.from({ length: audioBytes.length / 4 }, (_, index) => audioBytes.readFloatLE(index * 4));
const audioWindows: { timelineSeconds: number; frequency: number; expectedFrequency: number; rms: number }[] = [];
// 线性扫频给源声音编码时间：删口后频率必须直接推进，disabled 旧轨不得叠出第二路声音。
for (let time = 0.25; time < 4.8; time += 0.25) {
  if (Math.abs(time - 2) < 0.2) continue;
  const start = Math.round((time - 0.1) * 16000), end = Math.round((time + 0.1) * 16000);
  const crossings: number[] = [];
  let energy = 0;
  for (let index = start; index < end; index++) {
    energy += samples[index]! ** 2;
    if (samples[index]! <= 0 && samples[index + 1]! > 0) crossings.push(index + -samples[index]! / (samples[index + 1]! - samples[index]!));
  }
  const frequency = (crossings.length - 1) * 16000 / (crossings.at(-1)! - crossings[0]!);
  const expectedFrequency = 220 + 110 * (time + (time >= 2 ? 0.5 : 0));
  const rms = Math.sqrt(energy / (end - start));
  audioWindows.push({ timelineSeconds: time, frequency, expectedFrequency, rms });
  assert.ok(Math.abs(frequency - expectedFrequency) < 12, `音频源时间回退或错位：${time}s`);
  assert.ok(rms > 0.16 && rms < 0.27, `声音缺失或重复叠加：${time}s，RMS=${rms}`);
}
await writeFile(join(root, "report.json"), JSON.stringify({ root, target, sourceIndices, failures, audioWindows }, null, 2));
console.log(JSON.stringify({ root, target, failures, audioWindows }));
assert.equal(failures.length, 0, "25fps 源→24fps 分段合成不得跳回旧帧或使用错误帧；证据保留在隔离目录");
