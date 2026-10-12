import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { runProcess, probeMedia } from "@videocut/speech";
import { createApplication } from "@videocut/application";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";
import { motionFixture } from "./fixtures/managed-motion.js";
import { boundMotionVideoSchema, motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import { prepareMotionVideos, hashMotionFile } from "../apps/render-worker/src/motion-video.js";
import { renderManagedMotion } from "../apps/render-worker/src/motion-renderer.js";

test("视频合同固定作品帧范围，允许毫秒取整，拒绝旧入口及错误范围", () => {
  const binding = { assetId: "asset-node", sourceStartMs: 628000, sourceEndMs: 631334, startFrame: 90, endFrame: 170 };
  const input = { ...motionFixture, fps: 24, durationInFrames: 792, videoBindings: { nodePre: binding } };
  assert.equal(motionSubmissionSchema.safeParse(input).success, true);
  assert.equal(boundMotionVideoSchema.safeParse({ slot: "nodePre", ...binding, managedPath: "source.mp4", hash: "a".repeat(64) }).success, true);
  for (const change of [{ startFrame: 171 }, { endFrame: 793 }, { sourceEndMs: 631000 }, { sourceEndMs: 640000 }]) assert.equal(motionSubmissionSchema.safeParse({ ...input, videoBindings: { nodePre: { ...binding, ...change } } }).success, false);
  assert.equal(motionSubmissionSchema.safeParse({ ...input, videoBindings: { "node-pre": binding } }).success, false);
  const { startFrame: _start, endFrame: _end, ...oldBinding } = binding;
  assert.equal(motionSubmissionSchema.safeParse({ ...input, videoBindings: { nodePre: oldBinding } }).success, false);
});

test("23.976/25/30/VFR按PTS采样；跨Sequence保持作品时钟及精确帧数", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-motion-video-"));
  try {
    for (const [index, rate] of ["24000/1001", "25", "30", "vfr"].entries()) {
      const source = join(root, `source${index}.mp4`);
      await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=64x64:r=${rate === "vfr" ? "30" : rate}:d=3`, ...(rate === "vfr" ? ["-vf", "select='not(mod(n,2))+not(mod(n,3))'", "-fps_mode", "vfr"] : []), "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
      const binding = { slot: "footage", assetId: "test", managedPath: `source${index}.mp4`, hash: await hashMotionFile(source), sourceStartMs: 0, sourceEndMs: 2000, startFrame: 0, endFrame: 48 };
      const work = motionSubmissionSchema.parse({ ...motionFixture, width: 64, height: 64, fps: 24, durationInFrames: 48, videoBindings: { footage: { assetId: "test", sourceStartMs: 0, sourceEndMs: 2000, startFrame: 0, endFrame: 48 } } });
      const provider = await prepareMotionVideos(root, join(root, `decode${index}`), work, [binding]);
      try {
        assert.equal(provider.videos.footage.frameCount, 48);
        const reference = join(root, `ref${index}`); await mkdir(reference);
        await runProcess("ffmpeg", ["-v", "error", "-i", source, "-vf", "setpts=PTS-STARTPTS,fps=24:start_time=0:round=up:eof_action=pass", "-frames:v", "48", "-pix_fmt", "rgba", join(reference, "%d.png")]);
        for (const frame of [0, 1, 20, 46, 47]) assert.deepEqual(PNG.sync.read(await provider.getFrame("footage", frame)).data, PNG.sync.read(await readFile(join(reference, `${frame + 1}.png`))).data);
        if (index === 0) {
          const source = `import React from 'react';import {Sequence} from 'remotion';import {TimelineVideo} from '@videoflowcut/motion';export default function Motion(){return <><Sequence durationInFrames={4}><TimelineVideo slot="footage"/></Sequence><Sequence from={4}><TimelineVideo slot="footage"/></Sequence></>;}`;
          const rendered = await renderManagedMotion({ ...work, source, durationInFrames: 8 }, join(root, "render"), {}, provider);
          assert.equal(rendered.frameHashes.length, 8); assert.notEqual(rendered.frameHashes[0], rendered.frameHashes[7]); assert.ok(rendered.determinism);
          await assert.rejects(renderManagedMotion({ ...work, source: source.replace('slot="footage"', 'slot="missing"'), durationInFrames: 8 }, join(root, "overflow"), {}, provider), /MOTION_VIDEO_RANGE/);
        }
      } finally { await provider.close(); }
      await assert.rejects(prepareMotionVideos(root, join(root, `bad${index}`), work, [{ ...binding, sourceEndMs: 4000 }]), /SOURCE_RANGE/);
      await assert.rejects(prepareMotionVideos(root, join(root, `changed${index}`), work, [{ ...binding, hash: "a".repeat(64) }]), /VIDEO_CHANGED/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("多路Job共享原片且不保存副本，完整作品独立于解码缓存，损坏结果不得复用", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-motion-video-job-")); const app = createApplication(root);
  try {
    const created = app.createProject({ name: "多路视频隔离验证" }); const projectId = created.snapshot.project.id;
    const path = join(created.snapshot.project.rootPath, "assets/source/video.mp4");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", path]);
    const imported = app.registerImportedAsset({ projectId, baseRevision: 1, name: "video.mp4", kind: "video", managedPath: "assets/source/video.mp4", sourceHash: await hashMotionFile(path), provenance: { source: "local_import", acquiredAt: new Date().toISOString() } });
    app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(path) });
    const binding = { assetId: imported.asset.id, sourceStartMs: 0, sourceEndMs: 500, startFrame: 0, endFrame: 12 };
    const work = motionSubmissionSchema.parse({ ...motionFixture, width: 128, height: 64, fps: 24, durationInFrames: 12, videoBindings: { left: binding, right: binding }, source: `import React from 'react';import {TimelineVideo} from '@videoflowcut/motion';export default function Motion(){return <div style={{display:'flex',width:128,height:64}}><TimelineVideo slot="left" style={{width:64,height:64}}/><TimelineVideo slot="right" style={{width:64,height:64}}/></div>}` });
    const job = app.submitManagedMotion({ projectId, baseRevision: app.readProject(projectId).revision.number, idempotencyKey: "two", work });
    const result = await runMotionJob(app, job); const asset = app.readProject(projectId).snapshot.assets.find(a => a.id === result.assetId)!;
    assert.equal(asset.metadata?.hasAudio, false); assert.deepEqual(asset.motion?.sourceAssetIds, [imported.asset.id]);
    const directory = join(created.snapshot.project.rootPath, asset.motion!.sourcePath, "..");
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.videoResources.uniqueSources, 1); assert.equal(manifest.videoResources.decodedChunks, 1);
    assert.equal((await readdir(directory)).includes("resources"), false);
    await rm(join(created.snapshot.project.rootPath, ".cache"), { recursive: true, force: true });
    const revision = app.readProject(projectId).revision.number;
    assert.equal((await runMotionJob(app, job)).assetId, asset.id); assert.equal(app.readProject(projectId).revision.number, revision);
    await writeFile(join(directory, "frames/frame-00000.png"), "damaged");
    await assert.rejects(runMotionJob(app, job), /MOTION_CACHE_CORRUPT/);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
