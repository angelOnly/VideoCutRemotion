import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {
  ADVANCED_VISUAL_RUNTIME_CAPABILITIES,
  RestrictedSceneVisual,
  resolveAdvancedVisualRequest,
  resolveRestrictedScene
} from "@videocut/remotion";

test("受限代码型 Remotion Scene 只接受已注册模板和有限 JSON Props", () => {
  const resolved = resolveRestrictedScene({
    schemaVersion: 1,
    template: "FlowMap",
    title: "从输入到结果的判断路径",
    accent: "violet",
    revealFrames: 8,
    nodes: [
      { label: "确认输入", detail: "只使用已核对事实" },
      { label: "建立关系", detail: "保持因果链连续" },
      { label: "输出结论" }
    ]
  });

  assert.equal(resolved.status, "ready");
  if (resolved.status !== "ready") return;
  assert.equal(resolved.definition.template, "FlowMap");
  assert.equal(resolved.definition.nodes.length, 3);
  assert.equal(resolved.definition.accent, "violet");

  // 组件只接收已解析 Definition；raw props 不会直接流进 JSX/CSS/媒体加载器。
  assert.ok(React.isValidElement(RestrictedSceneVisual({ definition: resolved.definition, localFrame: 16 })));
});

test("受限 Scene 明确拒绝 JSX、样式、URL 和未知字段，不能借 props 执行任意代码", () => {
  const attempts = [
    {
      schemaVersion: 1,
      template: "FlowMap",
      title: "不应执行",
      nodes: [{ label: "A" }, { label: "B" }],
      jsx: "<AbsoluteFill>{process.env.SECRET}</AbsoluteFill>"
    },
    {
      schemaVersion: 1,
      template: "FlowMap",
      title: "不应加载",
      nodes: [{ label: "A", style: { color: "red" } }, { label: "B" }]
    },
    {
      schemaVersion: 1,
      template: "MetricComparison",
      title: "不应访问网络",
      metrics: [{ label: "A", value: 1 }, { label: "B", value: 2 }],
      url: "https://untrusted.example/shader.wgsl"
    }
  ];

  for (const attempt of attempts) {
    const resolved = resolveRestrictedScene(attempt);
    assert.equal(resolved.status, "rejected");
    if (resolved.status === "rejected") assert.match(resolved.message, /不允许|不属于/u);
  }
});

test("受限模板会检查自身数据边界，而不是将错误数据降级成看似成功的卡片", () => {
  const unknownTemplate = resolveRestrictedScene({
    schemaVersion: 1,
    template: "RunArbitraryComponent",
    title: "未知模板"
  });
  assert.deepEqual(unknownTemplate, {
    status: "rejected",
    code: "RESTRICTED_SCENE_TEMPLATE_UNSUPPORTED",
    message: "template 必须是已注册的 FlowMap 或 MetricComparison"
  });

  const wrongFields = resolveRestrictedScene({
    schemaVersion: 1,
    template: "MetricComparison",
    title: "错误字段",
    nodes: [{ label: "不会被悄悄转换" }, { label: "为指标" }]
  });
  assert.equal(wrongFields.status, "rejected");
  if (wrongFields.status === "rejected") assert.equal(wrongFields.code, "RESTRICTED_SCENE_TEMPLATE_FIELDS");

  const unreasonableMetric = resolveRestrictedScene({
    schemaVersion: 1,
    template: "MetricComparison",
    title: "数值必须可渲染",
    metrics: [{ label: "A", value: Number.POSITIVE_INFINITY }, { label: "B", value: 2 }]
  });
  assert.equal(unreasonableMetric.status, "rejected");
});

test("Shader 只允许受审查的内置 WebGL 模板，复杂三维仍降级为项目内预渲染素材", () => {
  assert.equal(ADVANCED_VISUAL_RUNTIME_CAPABILITIES.shader.status, "curated_webgl");
  assert.equal(ADVANCED_VISUAL_RUNTIME_CAPABILITIES.complex3d.status, "pre_rendered_asset_only");

  const shader = resolveAdvancedVisualRequest({ feature: "shader", source: "void main() {}" });
  assert.equal(shader.status, "rejected");
  if (shader.status === "rejected") {
    assert.equal(shader.code, "SHADER_SOURCE_FORBIDDEN");
    assert.equal(shader.fallback, "registered_scene");
  }

  const curatedShader = resolveAdvancedVisualRequest({ feature: "shader", template: "aurora_mesh", accent: "violet", intensity: "subtle" });
  assert.deepEqual(curatedShader, {
    status: "ready",
    feature: "shader",
    definition: { template: "aurora_mesh", accent: "violet", intensity: "subtle" }
  });

  const sourceModel = resolveAdvancedVisualRequest({ feature: "complex_3d", modelPath: "C:/unsafe/model.glb" });
  assert.equal(sourceModel.status, "rejected");
  if (sourceModel.status === "rejected") assert.equal(sourceModel.code, "COMPLEX_3D_SOURCE_FORBIDDEN");

  const pathDisguisedAsAssetId = resolveAdvancedVisualRequest({ feature: "complex_3d", preRenderedAssetId: "../unsafe-model.glb" });
  assert.equal(pathDisguisedAsAssetId.status, "rejected");
  if (pathDisguisedAsAssetId.status === "rejected") assert.equal(pathDisguisedAsAssetId.code, "COMPLEX_3D_PRE_RENDER_REQUIRED");

  const preRendered = resolveAdvancedVisualRequest({ feature: "complex_3d", preRenderedAssetId: "asset_pre_rendered_3d" });
  assert.deepEqual(preRendered, {
    status: "degraded",
    feature: "complex_3d",
    assetId: "asset_pre_rendered_3d",
    message: "当前按预渲染项目素材降级；未启用 Three/3D 实时场景。",
    fallback: "pre_rendered_project_asset"
  });
});
