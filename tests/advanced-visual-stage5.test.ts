import assert from "node:assert/strict";
import test from "node:test";
import type { Asset } from "@videocut/contracts";
import { isUsablePreRenderedThreeDAsset, PRE_RENDERED_3D_TAG } from "../packages/remotion-runtime/src/explainer-registry.js";
import { resolveAdvancedVisualRequest } from "@videocut/remotion";

function preRenderedAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset_pre_rendered_3d",
    name: "预渲染三维关系图.mp4",
    kind: "derived",
    status: "ready",
    managedPath: "assets/derived/pre-rendered-relationship.mp4",
    tags: [],
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides
  };
}

test("复杂三维降级只接受已就绪且受管本地的预渲染项目素材", () => {
  assert.equal(isUsablePreRenderedThreeDAsset(preRenderedAsset()), true);
  assert.equal(isUsablePreRenderedThreeDAsset(preRenderedAsset({ kind: "video", tags: [PRE_RENDERED_3D_TAG] })), true);

  assert.equal(isUsablePreRenderedThreeDAsset(preRenderedAsset({ kind: "video" })), false, "普通视频不能被悄悄称为三维预渲染");
  assert.equal(isUsablePreRenderedThreeDAsset(preRenderedAsset({ kind: "image", tags: ["preview"] })), false);
  assert.equal(isUsablePreRenderedThreeDAsset(preRenderedAsset({ status: "analyzing" })), false);
  assert.equal(isUsablePreRenderedThreeDAsset(preRenderedAsset({ managedPath: "https://example.test/model.mp4" })), false);
  assert.equal(isUsablePreRenderedThreeDAsset(preRenderedAsset({ managedPath: "../outside/render.mp4" })), false);
  assert.equal(isUsablePreRenderedThreeDAsset(preRenderedAsset({ managedPath: "C:\\outside\\render.mp4" })), false);
});

test("Shader 只接受已审查模板，任意源码不会进入 Renderer", () => {
  const shader = resolveAdvancedVisualRequest({ feature: "shader", source: "void main() {}" });
  assert.equal(shader.status, "rejected");
  if (shader.status === "rejected") assert.equal(shader.code, "SHADER_SOURCE_FORBIDDEN");

  const curated = resolveAdvancedVisualRequest({ feature: "shader", template: "signal_grid", intensity: "medium" });
  assert.equal(curated.status, "ready");
  if (curated.status === "ready") assert.equal(curated.definition.template, "signal_grid");
});
