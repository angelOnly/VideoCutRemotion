import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMediaAsset, createProjectSnapshot, createTimelineItem } from "@videocut/domain";
import { runProcess } from "@videocut/speech";
import { motionFixture } from "./fixtures/managed-motion.js";
import { renderManagedMotion } from "../apps/render-worker/src/motion-renderer.js";
import { prepareMotionVideos, hashMotionFile } from "../apps/render-worker/src/motion-video.js";
import { verifySourceFiles } from "../apps/render-worker/src/exporter.js";
import { mediaUsageFindings } from "../packages/media-intelligence/src/usage.js";

test("同一状态函数在交叠中拆件，所有帧及真实视频源时钟保持一致", { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "continuous-motion-"));
  try {
    const path = join(root, "source.mp4");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=24:d=1", "-c:v", "libx264", path]);
    const hash = await hashMotionFile(path);
    // 同一源素材、运动与观察逻辑，仅调整分块的绝对时钟和源起点。
    const source = `import React from 'react';import {useCurrentFrame} from 'remotion';import {TimelineVideo} from '@videoflowcut/motion';
export default function Motion(props:{offset:number}){const frame=useCurrentFrame()+props.offset;return <div style={{width:128,height:64,background:'#111'}}><div style={{position:'absolute',left:frame*2,top:0,width:64,height:64}}><TimelineVideo slot="footage" style={{width:64,height:64}}/></div><div style={{position:'absolute',left:100-frame*2,top:12,width:40,height:40,background:'#ffdd33',opacity:0.65}}/></div>;}`;
    const render = async (name: string, offset: number, count: number) => {
      const timing = { assetId: "source", sourceStartMs: offset * 1000 / 24, sourceEndMs: (offset + count) * 1000 / 24, startFrame: 0, endFrame: count };
      const work = { ...motionFixture, source, props: { offset }, width: 128, height: 64, fps: 24, durationInFrames: count, videoBindings: { footage: timing } };
      const provider = await prepareMotionVideos(root, join(root, `decode-${name}`), work, [{ ...timing, slot: "footage", managedPath: "source.mp4", hash }]);
      try { return await renderManagedMotion(work, join(root, name), {}, provider); }
      finally { await provider.close(); }
    };
    const whole = await render("whole", 0, 24);
    const first = await render("first", 0, 12);
    const second = await render("second", 12, 12);
    assert.deepEqual([...first.frameHashes, ...second.frameHashes], whole.frameHashes);
    assert.notEqual(second.frameHashes[0], whole.frameHashes[0], "后块不能重新开场或重播素材");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("无需审核对象仍检查实际文件、哈希和范围，隐藏轨道不构成输出依赖", async () => {
  const root = await mkdtemp(join(tmpdir(), "direct-source-"));
  try {
    const snapshot = createProjectSnapshot({ projectId: "source-test", name: "直接引用", rootPath: root });
    const path = join(root, "source.mp4");
    await writeFile(path, "原始文件身份");
    const asset = createMediaAsset({ name: "测试素材", kind: "video", managedPath: "source.mp4", sourceHash: await hashMotionFile(path) });
    Object.assign(asset, { status: "ready", metadata: { durationMs: 1000, hasAudio: false } });
    snapshot.assets.push(asset);
    const track = snapshot.timeline.tracks.find(entry => entry.kind === "video")!;
    snapshot.timeline.items.push(createTimelineItem({ trackId: track.id, assetId: asset.id, startFrame: 0, endFrame: 10, sourceStartFrame: 0, sourceEndFrame: 10 }));
    assert.deepEqual(mediaUsageFindings(snapshot), []);
    await verifySourceFiles(snapshot);
    snapshot.timeline.items[0].sourceEndFrame = 10000;
    assert.match(mediaUsageFindings(snapshot)[0].reason, /范围/);
    await writeFile(path, "更改后的内容");
    await assert.rejects(verifySourceFiles(snapshot), /哈希/);
    await rm(path);
    await assert.rejects(verifySourceFiles(snapshot), /缺失/);
    track.hidden = true;
    assert.deepEqual(mediaUsageFindings(snapshot), []);
    await verifySourceFiles(snapshot);
  } finally { await rm(root, { recursive: true, force: true }); }
});
