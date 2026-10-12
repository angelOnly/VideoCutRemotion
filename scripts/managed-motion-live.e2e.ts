import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApplication } from "@videocut/application";
import { motionFixture } from "../tests/fixtures/managed-motion.js";
import { runMotionJob } from "../apps/render-worker/src/motion-job.js";
import { createTimelineItem } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";
import { RevisionRenderer, verifyMotionFrameCaches } from "../apps/render-worker/src/exporter.js";

const root = await mkdtemp(join(tmpdir(), "videocut-motion-live-"));
const app = createApplication(root);
try {
  const state = app.createProject({ name: "受管动效真实渲染候选", profile: "presenter_motion" });
  const projectId = state.snapshot.project.id;
  app.repository.commit(projectId, state.revision.number, "设置候选画布", (snapshot) => { Object.assign(snapshot.timeline, { width: 320, height: 320, fps: 30, durationInFrames: 60 }); });
  const revision = () => app.readProject(projectId).revision.number;
  const job = app.submitManagedMotion({ projectId, baseRevision: revision(), idempotencyKey: "live", work: motionFixture });
  const result = await runMotionJob(app, job);
  assert.ok(result.assetId);
  const repeated = await runMotionJob(app, job);
  assert.equal(repeated.assetId, result.assetId);
  const asset = app.readManagedMotion(projectId, job.id).asset!;
  const png = await readFile(join(app.readProject(projectId).snapshot.project.rootPath, asset.motion!.framesDirectory, "frame-00009.png"));
  assert.equal(png[25], 6, "PNG 必须保留 RGBA 而非烧入背景");
  const projectRoot = app.readProject(projectId).snapshot.project.rootPath;
  const logoPath = join(projectRoot, "assets", "logo.png");
  await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0xec5a77:s=32x32", "-frames:v", "1", logoPath]);
  const logoHash = createHash("sha256").update(await readFile(logoPath)).digest("hex");
  const logo = app.registerImportedAsset({ projectId, baseRevision: revision(), name: "图片绑定候选", kind: "image", managedPath: "assets/logo.png", sourceHash: logoHash, provenance: { source: "local_import", acquiredAt: new Date().toISOString() } }).asset;
  app.applyMediaAnalysis({ projectId, assetId: logo.id, metadata: await probeMedia(logoPath) });
  const imageJob = app.submitManagedMotion({ projectId, baseRevision: revision(), idempotencyKey: "live-image", work: { ...motionFixture, imageBindings: { logo: logo.id }, source: `import React from 'react';import {AbsoluteFill,Img,useCurrentFrame} from 'remotion';export default function Motion(props){const f=useCurrentFrame();return <AbsoluteFill style={{justifyContent:'center',alignItems:'center'}}><Img src={props.assets.logo} style={{width:100+f,height:100+f}}/></AbsoluteFill>;}` } });
  const imageResult = await runMotionJob(app, imageJob);
  assert.ok(imageResult.assetId);
  assert.equal((await runMotionJob(app, imageJob)).assetId, imageResult.assetId);
  const backgroundPath = join(projectRoot, "assets", "background.mp4");
  await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x286954:s=320x320:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", backgroundPath]);
  const background = app.registerImportedAsset({ projectId, baseRevision: revision(), name: "候选背景", kind: "video", managedPath: "assets/background.mp4" });
  app.applyMediaAnalysis({ projectId, assetId: background.asset.id, metadata: await probeMedia(backgroundPath) });
  const scenes = app.createScene({ projectId, baseRevision: revision(), type: "PresenterScene", title: "透明动效合成候选", purpose: "验证背景不会被审阅代理替换", startFrame: 0, endFrame: 60, assetIds: [background.asset.id] });
  const sceneId = scenes.snapshot.scenes.at(-1)!.id;
  app.repository.commit(projectId, revision(), "放置候选背景", (snapshot) => {
    snapshot.timeline.items.push(createTimelineItem({ trackId: snapshot.timeline.tracks.find((track) => track.name === "Background")!.id, sceneId, assetId: background.asset.id, startFrame: 0, endFrame: 60, sourceStartFrame: 0, sourceEndFrame: 60 }));
  });
  await app.reviewManagedMotion({ projectId, baseRevision: revision(), assetId: asset.id, outcome: "inconclusive", note: "候选 fixture 用于验证渲染位置、透明度和版本，不代表正式视频审美批准。" });
  app.createEffectCue({ projectId, baseRevision: revision(), sceneId, type: "ManagedMotion", layer: "front", startFrame: 20, endFrame: 38, assetBindings: [{ slot: "motion", assetId: asset.id }] });
  const finalSnapshot = app.readProject(projectId).snapshot;
  const compositionPath = join(root, "composition.mp4");
  await new RevisionRenderer(undefined, 1).renderRange(finalSnapshot, 0, 60, compositionPath);
  await runProcess("ffmpeg", ["-y", "-v", "error", "-i", compositionPath, "-vf", "select='eq(n,5)+eq(n,20)+eq(n,27)+eq(n,37)+eq(n,40)',tile=5x1", "-frames:v", "1", join(root, "composition-frames.png")]);
  const report = { root, asset, result, imageResult, compositionPath, compositionFrames: join(root, "composition-frames.png") };
  await assert.rejects(verifyMotionFrameCaches({ ...finalSnapshot, timeline: { ...finalSnapshot.timeline, fps: 25 } }), /画布|帧率/u);
  // 真正破坏一个已使用的缓存帧，确认不能偷偷回退到 MP4；测试后恢复原始字节。
  const framePath = join(projectRoot, asset.motion!.framesDirectory, "frame-00009.png");
  await writeFile(framePath, Buffer.from("corrupt"));
  try { await assert.rejects(verifyMotionFrameCaches(finalSnapshot), /缓存|透明帧/u); }
  finally { await writeFile(framePath, png); }
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { app.repository.close(); }
