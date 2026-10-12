import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createApplication } from "@videocut/application";
import { runProcess } from "@videocut/speech";
import { runOneRenderJob } from "../apps/render-worker/src/index.js";
import { RevisionRenderer, runPreviewJob, runExportJob, validateOutputFrameRate } from "../apps/render-worker/src/exporter.js";

// 用可从导出像素读回的二进制帧号验证真实取帧，技术fixture不代表创作审片。
const root = resolve(".repair-validation/frame-rate-20261006/render-workspace");
await mkdir(root, { recursive: true });
const app = createApplication(root);
try {
  const created = app.createProject({ name: "跨帧率像素回归", profile: "visual_explainer", fps: 30, brief: { captionMode: "none" } });
  const projectId = created.snapshot.project.id;
  const revision = () => app.readProject(projectId).revision.number;
  app.repository.commit(projectId, revision(), "隔离小画布", snapshot => { snapshot.timeline.width = 160; snapshot.timeline.height = 96; });
  const motionJob = app.submitManagedMotion({ projectId, baseRevision: revision(), idempotencyKey: `indexed-${projectId}`, work: {
    name: "24fps帧号编码", creativeBrief: "仅验证24fps固定透明帧在不同项目fps下的采样、末帧和时长，不代表正式创作。",
    source: "import React from 'react';import {useCurrentFrame} from 'remotion';export default function M(){const f=useCurrentFrame();return <div style={{position:'absolute',inset:0,background:'#555'}}>{Array.from({length:5},(_,i)=><div key={i} style={{position:'absolute',left:i*32,top:0,width:32,height:96,background:(f>>i)&1?'#eeeeee':'#222222'}}/>)}</div>}",
    props: {}, imageBindings: {}, width: 160, height: 96, fps: 24, durationInFrames: 24
  } });
  await runOneRenderJob(app);
  assert.equal(app.trackJob(motionJob.id).status, "succeeded", app.trackJob(motionJob.id).error);
  const work = app.readProject(projectId).snapshot.assets.find(asset => asset.motion?.jobId === motionJob.id)!;
  const sceneId = app.createScene({ projectId, baseRevision: revision(), type: "ExplainerScene", title: "编码验证", purpose: "逐帧取样", startFrame: 0, endFrame: 30 }).snapshot.scenes[0].id;
  app.createEffectCue({ projectId, baseRevision: revision(), sceneId, type: "ManagedMotion", layer: "fullscreen", startFrame: 0, endFrame: 30, assetBindings: [{ slot: "motion", assetId: work.id }] });
  const renderer = new RevisionRenderer(resolve("apps/render-worker/src/render-entry.tsx"), 2);
  const results: unknown[] = [];
  for (const fps of [30, 15, 60]) {
    const current = app.readProject(projectId);
    if (current.snapshot.timeline.fps !== fps) app.setProjectFrameRate({ projectId, baseRevision: revision(), fps });
    const snapshot = app.readProject(projectId).snapshot;
    const target = join(root, `sample-${fps}.mp4`);
    await renderer.render(snapshot, target);
    const spec = await validateOutputFrameRate(target, fps, fps);
    const rawPath = join(root, `sample-${fps}.gray`);
    await runProcess("ffmpeg", ["-v", "error", "-i", target, "-an", "-pix_fmt", "gray", "-f", "rawvideo", "-y", rawPath]);
    const raw = await readFile(rawPath);
    assert.equal(raw.length, fps * 160 * 96);
    const indices: number[] = [];
    for (let frame = 0; frame < fps; frame++) {
      let index = 0;
      for (let bit = 0; bit < 5; bit++) if (raw[frame * 160 * 96 + 48 * 160 + bit * 32 + 16] > 128) index |= 1 << bit;
      assert.equal(index, Math.floor(frame * 24 / fps), `${fps}fps第${frame}帧取错原作品帧`);
      indices.push(index);
    }
    await assert.rejects(() => validateOutputFrameRate(target, fps === 30 ? 24 : 30, fps), /输出规格异常/u);
    const preview = app.submitPreview({ projectId, revision: revision(), fromFrame: 0, toFrame: fps, idempotencyKey: `preview-${fps}` });
    const previewResult = await runPreviewJob(app, preview, renderer);
    app.updateJob(preview.id, { status: "succeeded", result: previewResult });
    const exportJob = await app.submitExport({ projectId, revision: revision(), purpose: "draft", idempotencyKey: `export-${fps}` });
    const exported = await runExportJob(app, exportJob, renderer);
    app.updateJob(exportJob.id, { status: "succeeded", result: exported });
    results.push({ ...spec, indices, preview: previewResult, export: exported });
  }
  await writeFile(join(root, "report.json"), JSON.stringify({ projectId, sourceFps: 24, results }, null, 2));
  console.log(JSON.stringify({ root, projectId, rates: [30, 15, 60], status: "passed" }));
} finally { app.close(); }
