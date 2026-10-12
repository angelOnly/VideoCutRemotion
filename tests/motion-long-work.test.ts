import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "@videocut/application";
import { runProcess, probeMedia } from "@videocut/speech";
import { processClaimedJob } from "@videocut/job-runtime";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";
import { runMotionProcess } from "../apps/render-worker/src/motion-process.js";
import { hashMotionFile } from "../apps/render-worker/src/motion-video.js";
import { motionFixture } from "./fixtures/managed-motion.js";

test("768×1344完整33秒四选段经真实渲染形成一个792帧作品", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-motion-33s-")); const app = createApplication(root);
  try {
    const state = app.createProject({ name: "33秒候选回归" });
    const projectId = state.snapshot.project.id;
    const sources = [];
    for (const [index, color] of ["red", "blue"].entries()) {
      const managedPath = `assets/source/${index}.mp4`; const path = join(state.snapshot.project.rootPath, managedPath);
      await runProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=64x64:r=24:d=12`, "-c:v", "libx264", path]);
      const imported = app.registerImportedAsset({ projectId, baseRevision: app.readProject(projectId).revision.number, name: `${index}.mp4`, kind: "video", managedPath, sourceHash: await hashMotionFile(path), provenance: { source: "local_import", acquiredAt: new Date().toISOString() } });
      app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(path) }); sources.push(imported.asset.id);
    }
    const work = { ...motionFixture, reference: undefined, width: 768, height: 1344, fps: 24, durationInFrames: 792,
      videoBindings: {
        a: { assetId: sources[0], sourceStartMs: 0, sourceEndMs: 3750, startFrame: 0, endFrame: 90 },
        b: { assetId: sources[0], sourceStartMs: 4000, sourceEndMs: 7334, startFrame: 90, endFrame: 170 },
        c: { assetId: sources[0], sourceStartMs: 8000, sourceEndMs: 11550, startFrame: 150, endFrame: 235 },
        d: { assetId: sources[1], sourceStartMs: 0, sourceEndMs: 10000, startFrame: 222, endFrame: 462 }
      },
      source: `import React from 'react';import {AbsoluteFill,useCurrentFrame} from 'remotion';import {TimelineVideo} from '@videoflowcut/motion';export default function Motion(){const f=useCurrentFrame();return <AbsoluteFill style={{background:'#172033'}}><TimelineVideo slot="a"/><TimelineVideo slot="b"/><TimelineVideo slot="c"/><TimelineVideo slot="d"/><div style={{position:'absolute',left:80,top:80,color:'white',fontSize:48}}>候选技术回归 {f}</div></AbsoluteFill>;}`
    };
    const job = app.submitManagedMotion({ projectId, baseRevision: app.readProject(projectId).revision.number, idempotencyKey: "complete-33", work });
    const before = app.readProject(projectId).revision.number;
    const result = await runMotionJob(app, job);
    const current = app.readProject(projectId); const asset = current.snapshot.assets.find(asset => asset.id === result.assetId)!;
    assert.equal(current.revision.number, before + 1); assert.equal(current.snapshot.assets.filter(asset => asset.motion).length, 1);
    assert.equal(asset.motion!.frameCount, 792); assert.equal(asset.metadata!.durationMs, 33000);
    const manifest = JSON.parse(await readFile(join(current.snapshot.project.rootPath, asset.motion!.sourcePath, "../manifest.json"), "utf8"));
    assert.equal(manifest.frameHashes.length, 792); assert.equal(manifest.videoResources.uniqueSources, 2);
    assert.equal(manifest.videoDecodes.b.frameCount, 80); assert.equal(manifest.videoDecodes.c.frameCount, 85);
    assert.equal((await runMotionJob(app, job)).assetId, asset.id);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("取消Job向实际媒体进程传信号且不登记作品、不创建Revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-motion-cancel-")); const app = createApplication(root);
  try {
    const state = app.createProject({ name: "取消回归" }); const projectId = state.snapshot.project.id;
    const job = app.submitManagedMotion({ projectId, baseRevision: 1, idempotencyKey: "cancel", work: motionFixture });
    const before = app.readProject(projectId);
    let aborted = false;
    await processClaimedJob(app, job, async (_job, signal) => {
      const timer = setTimeout(() => app.updateJob(job.id, { status: "cancelled" }), 100);
      try { await runMotionProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], signal); }
      catch (error) { aborted = Boolean(signal?.aborted); throw error; }
      finally { clearTimeout(timer); }
      assert.fail("取消后不能继续");
    });
    assert.equal(aborted, true); assert.equal(app.trackJob(job.id).status, "cancelled"); assert.deepEqual(app.readProject(projectId), before);
    assert.throws(() => app.completeManagedMotion({ projectId, jobId: job.id, engineVersion: String(job.payload.engineVersion), sourceHash: "a", metadata: { durationMs: 600, width: 320, height: 320, hasAudio: false } }), /取消/u);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
