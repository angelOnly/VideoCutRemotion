import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { probeMedia, runProcess } from "@videocut/speech";
import { RevisionRenderer } from "../apps/render-worker/src/exporter.js";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";
import { motionFixture } from "./fixtures/managed-motion.js";
import { hashMediaFile } from "../packages/edit-application/src/media-intelligence.js";

test("全屏 Cutaway 接管宿主主视觉、保留明确前景和声音，返回时不重启动效", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-cutaway-composition-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "全屏接管真实渲染", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const revision = () => app.readProject(projectId).revision.number;
    app.repository.commit(projectId, revision(), "隔离测试画布", snapshot => Object.assign(snapshot.timeline, { width: 320, height: 320, fps: 30, durationInFrames: 18 }));
    const scene = app.createScene({ projectId, baseRevision: revision(), type: "ExplainerScene", title: "主模型", purpose: "验证主视觉与实拍交接", startFrame: 0, endFrame: 18 }).snapshot.scenes.at(-1)!;
    const mediaPath = join(created.snapshot.project.rootPath, "assets", "blue.mp4");
    await runProcess("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x320:r=30:d=0.6", "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000:duration=0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", mediaPath]);
    const media = app.registerImportedAsset({ projectId, baseRevision: revision(), name: "蓝色实拍替身", kind: "video", managedPath: "assets/blue.mp4", sourceHash: await hashMediaFile(mediaPath), provenance: { source: "local_import", acquiredAt: new Date().toISOString() } }).asset;
    app.applyMediaAnalysis({ projectId, assetId: media.id, metadata: await probeMedia(mediaPath) });
    for (const layer of ["fullscreen", "front"] as const) {
      const source = layer === "fullscreen"
        ? `import React from 'react';import {useCurrentFrame} from 'remotion';export default function Motion(){return <div style={{position:'absolute',inset:0,background:useCurrentFrame()<10?'#ff0000':'#00ff00'}}/>;}`
        : `import React from 'react';export default function Motion(){return <div style={{position:'absolute',left:20,top:20,width:40,height:40,background:'#ffff00'}}/>;}`;
      const job = app.submitManagedMotion({ projectId, baseRevision: revision(), idempotencyKey: layer, work: { ...motionFixture, source } });
      await runMotionJob(app, job);
      const asset = app.readManagedMotion(projectId, job.id).asset!;
      await app.reviewManagedMotion({ projectId, baseRevision: revision(), assetId: asset.id, outcome: "inconclusive", note: "隔离像素夹具，只测试合成，不冒称艺术审片通过。" });
      app.createEffectCue({ projectId, baseRevision: revision(), sceneId: scene.id, type: "ManagedMotion", layer, startFrame: 0, endFrame: 18, assetBindings: [{ slot: "motion", assetId: asset.id }] });
    }
    app.manageCutaway({ projectId, baseRevision: revision(), action: "create", hostSceneId: scene.id, assetId: media.id, mode: "fullscreen", fit: "contain", audioMode: "continue_dialogue", purpose: "暂时接管主视觉", audienceTask: "看见实拍再回原模型", startFrame: 6, endFrame: 12, sourceStartFrame: 0, sourceEndFrame: 6 });
    const snapshot = app.readProject(projectId).snapshot;
    snapshot.timeline.durationInFrames = 18;
    // 固定夹具的持续声音轨，用像素与解码共同检查视觉替换没有丢掉声音。
    snapshot.timeline.items.push({ ...snapshot.timeline.items.find(item => item.assetId === media.id)!, id: "test-dialogue", sceneId: undefined, trackId: snapshot.timeline.tracks.find(track => track.name === "Dialogue")!.id, startFrame: 0, endFrame: 18, sourceStartFrame: 0, sourceEndFrame: 18 });
    const output = join(root, "cutaway.mp4");
    await new RevisionRenderer(undefined, 1).renderRange(snapshot, 0, 18, output);
    assert.equal((await probeMedia(output)).hasAudio, true);
    const rawPath = join(root, "cutaway.rgb");
    await runProcess("ffmpeg", ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath]);
    const bytes = await readFile(rawPath);
    assert.equal(bytes.length, 18 * 320 * 320 * 3);
    const pixel = (frame: number, x: number, y: number) => [...bytes.subarray((frame * 320 * 320 + y * 320 + x) * 3, (frame * 320 * 320 + y * 320 + x) * 3 + 3)];
    const near = (actual: number[], expected: number[]) => actual.every((value, index) => Math.abs(value - expected[index]!) < 12);
    for (let frame = 0; frame < 18; frame++) {
      const expected = frame < 6 ? [255, 0, 0] : frame < 12 ? [0, 0, 255] : [0, 255, 0];
      assert.ok(near(pixel(frame, 160, 160), expected), `F${frame} 接管/返回错误：${pixel(frame, 160, 160)}`);
      assert.ok(near(pixel(frame, 40, 40), [255, 255, 0]), `F${frame} 明确前景不能被全局停用`);
    }
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
