import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";

test("缩短旧解释场景只改变终点，并拒绝越界依赖和过期 Revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-scene-trim-"));
  const app = createApplication(root);
  try {
    const projectId = app.createProject({ name: "场景范围回归", profile: "visual_explainer" }).snapshot.project.id;
    const revision = () => app.readProject(projectId).revision.number;
    const scene = app.createScene({ projectId, baseRevision: revision(), type: "ExplainerScene", title: "成本周期", purpose: "验证缩短旧场景", startFrame: 252, endFrame: 576 }).snapshot.scenes[0]!;
    app.createEffectCue({ projectId, baseRevision: revision(), sceneId: scene.id, type: "CameraPunch", layer: "actor", startFrame: 252, endFrame: 528 });
    const previousRevision = revision();
    const trimmed = app.trimScene({ projectId, baseRevision: previousRevision, sceneId: scene.id, endFrame: 528 });
    assert.equal(trimmed.snapshot.scenes[0]!.endFrame, 528);
    assert.equal(trimmed.snapshot.effectCues[0]!.endFrame, 528);
    assert.equal(trimmed.revision.number, previousRevision + 1);
    assert.throws(() => app.trimScene({ projectId, baseRevision: previousRevision, sceneId: scene.id, endFrame: 500 }));
    assert.throws(() => app.trimScene({ projectId, baseRevision: revision(), sceneId: scene.id, endFrame: 252 }), { code: "INVALID_SCENE_RANGE" });
    assert.throws(() => app.trimScene({ projectId, baseRevision: revision(), sceneId: scene.id, endFrame: 529 }), { code: "INVALID_SCENE_RANGE" });
    assert.throws(() => app.trimScene({ projectId, baseRevision: revision(), sceneId: scene.id, endFrame: 500 }), { code: "SCENE_TRIM_DEPENDENCY_OUT_OF_RANGE" });
    assert.equal(app.readProject(projectId).snapshot.scenes[0]!.endFrame, 528);
  } finally {
    app.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});
