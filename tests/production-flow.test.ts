import assert from "node:assert/strict";
import test from "node:test";
import { EditingApplication } from "../packages/edit-application/src/index.js";
import {
  VIDEO_PRODUCTION_STAGES,
  VideoProductionCompilation,
  VideoProductionDelivery,
  VideoProductionDirection,
  VideoProductionMaterials,
  VideoProductionUnderstanding,
  createProductionFlow
} from "../packages/edit-application/src/production-flow.js";
import { CORE_PRODUCTION_FLOW } from "../packages/project-overview/src/index.js";
import type { EditingApplication as EditingApplicationType } from "@videocut/application";

test("生产流程门面保持五个可读阶段，并只引用现有 Application 公开命令", () => {
  assert.deepEqual(VIDEO_PRODUCTION_STAGES.map((stage) => stage.key), [
    "materials",
    "understanding",
    "direction",
    "production",
    "delivery"
  ]);

  const publicMethods = new Set(Object.getOwnPropertyNames(EditingApplication.prototype));
  for (const stage of VIDEO_PRODUCTION_STAGES) {
    assert.equal(stage.coreClass, "EditingApplication");
    assert.ok(stage.entryPoints.length > 0, `${stage.title} 必须有至少一个实际入口`);
    for (const entry of stage.entryPoints) {
      assert.ok(publicMethods.has(entry.applicationMethod), `${stage.title} 引用了不存在的 EditingApplication.${entry.applicationMethod}`);
    }
  }
});

test("项目总览与生产门面使用同一组五阶段名称和顺序", () => {
  assert.deepEqual(
    CORE_PRODUCTION_FLOW.map((stage) => ({ step: stage.step, name: stage.name })),
    VIDEO_PRODUCTION_STAGES.map((stage, index) => ({
      step: index + 1,
      name: stage.title.replace(/^\d+\.\s*/u, "")
    }))
  );
});

test("阶段目录与对应门面类的公开方法必须完全同步", () => {
  const facadeByStage = {
    materials: VideoProductionMaterials,
    understanding: VideoProductionUnderstanding,
    direction: VideoProductionDirection,
    production: VideoProductionCompilation,
    delivery: VideoProductionDelivery
  } as const;

  for (const stage of VIDEO_PRODUCTION_STAGES) {
    const facadeMethods = Object.getOwnPropertyNames(facadeByStage[stage.key].prototype)
      .filter((name) => name !== "constructor")
      .sort();
    const cataloguedMethods = stage.entryPoints.map((entry) => entry.applicationMethod).sort();
    assert.deepEqual(facadeMethods, cataloguedMethods, `${stage.title} 的阅读目录与门面方法必须同步`);
  }
});

test("生产流程门面将各阶段命令原样委托给同一个 EditingApplication", () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const application = new Proxy({}, {
    get(_target, property) {
      return (input: unknown) => {
        const method = String(property);
        calls.push({ method, input });
        return { method, input };
      };
    }
  }) as EditingApplicationType;
  const flow = createProductionFlow(application);

  const inputs = {
    material: { marker: "material" },
    understanding: { marker: "understanding" },
    direction: { marker: "direction" },
    production: { marker: "production" },
    delivery: { marker: "delivery" }
  };

  assert.deepEqual(flow.materials.createProject(inputs.material as never), { method: "createProject", input: inputs.material });
  assert.deepEqual(flow.materials.trackJob(inputs.material as never), { method: "trackJob", input: inputs.material });
  assert.deepEqual(flow.understanding.submitTranscription(inputs.understanding as never), { method: "submitTranscription", input: inputs.understanding });
  assert.deepEqual(flow.direction.updateStory(inputs.direction as never), { method: "updateStory", input: inputs.direction });
  assert.deepEqual(flow.direction.manageVlogShotSelects(inputs.direction as never), { method: "manageVlogShotSelects", input: inputs.direction });
  assert.deepEqual(flow.direction.verifyMulticamGroup(inputs.direction as never), { method: "verifyMulticamGroup", input: inputs.direction });
  assert.deepEqual(flow.direction.manageMulticamCuts(inputs.direction as never), { method: "manageMulticamCuts", input: inputs.direction });
  assert.deepEqual(flow.production.assemblePresenterTrack(inputs.production as never), { method: "assemblePresenterTrack", input: inputs.production });
  assert.deepEqual(flow.production.compilePresenterScenes(inputs.production as never), { method: "compilePresenterScenes", input: inputs.production });
  assert.deepEqual(flow.delivery.submitPreview(inputs.delivery as never), { method: "submitPreview", input: inputs.delivery });

  assert.deepEqual(calls, [
    { method: "createProject", input: inputs.material },
    { method: "trackJob", input: inputs.material },
    { method: "submitTranscription", input: inputs.understanding },
    { method: "updateStory", input: inputs.direction },
    { method: "manageVlogShotSelects", input: inputs.direction },
    { method: "verifyMulticamGroup", input: inputs.direction },
    { method: "manageMulticamCuts", input: inputs.direction },
    { method: "assemblePresenterTrack", input: inputs.production },
    { method: "compilePresenterScenes", input: inputs.production },
    { method: "submitPreview", input: inputs.delivery }
  ]);
  assert.equal(flow.application, application, "门面不得创建第二个 Application 或项目状态");
});
