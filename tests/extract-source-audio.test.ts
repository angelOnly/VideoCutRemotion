import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../packages/edit-application/src/index.js";
import { runOneJob } from "../apps/job-worker/src/index.js";
import { extractSourceAudio } from "../apps/server/src/extract-source-audio.js";
import { sha256File } from "../apps/server/src/media-hash.js";
import { runProcess } from "../packages/speech-services/src/index.js";

test("视频指定源范围提取独立音频并继承来源与权利", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-extract-audio-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "源音频提取回归" });
    const projectId = created.snapshot.project.id;
    const relativePath = join("assets", "source", "source.mp4");
    const path = join(created.snapshot.project.rootPath, relativePath);
    await mkdir(join(created.snapshot.project.rootPath, "assets", "source"), { recursive: true });
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=24:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", path], 30_000);
    const imported = app.registerImportedAsset({ projectId, baseRevision: created.revision.number, name: "source.mp4", kind: "video", managedPath: relativePath,
      sourceHash: await sha256File(path), provenance: { source: "local_import", acquiredAt: new Date().toISOString() } });
    assert.equal(await runOneJob(app), true);
    const ready = app.readProject(projectId);
    const result = await extractSourceAudio(app, { projectId, baseRevision: ready.revision.number, sourceAssetId: imported.asset.id, startMs: 500, endMs: 1500 });
    assert.equal(result.reused, false);
    assert.equal(result.asset.kind, "audio");
    assert.deepEqual(result.asset.provenance?.derivedFrom, { assetId: imported.asset.id, sourceHash: imported.asset.sourceHash, startMs: 500, endMs: 1500 });
    assert.equal(await runOneJob(app), true);
    assert.equal(app.readProject(projectId).snapshot.assets.find(asset => asset.id === result.asset.id)?.status, "ready");
    const second = await extractSourceAudio(app, { projectId, baseRevision: app.readProject(projectId).revision.number, sourceAssetId: imported.asset.id, startMs: 500, endMs: 1500 });
    assert.equal(second.reused, true);
    assert.equal(second.asset.id, result.asset.id);
    await assert.rejects(extractSourceAudio(app, { projectId, baseRevision: app.readProject(projectId).revision.number, sourceAssetId: imported.asset.id, startMs: 2500, endMs: 4000 }), /源范围/u);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
