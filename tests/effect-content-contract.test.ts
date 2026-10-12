import assert from "node:assert/strict";
import test from "node:test";
import { inspectEffectContentContract, type Asset, type EffectCue } from "@videocut/contracts";

const baseCue = (type: EffectCue["type"], overrides: Partial<EffectCue> = {}): EffectCue => ({
  id: `cue-${type}`,
  sceneId: "scene-1",
  type,
  layer: "front",
  anchor: "scene",
  startFrame: 0,
  holdFrame: 12,
  endFrame: 24,
  intensity: 0.6,
  status: "ready",
  note: "",
  narrativePurpose: "验证内容合同",
  audienceTask: "识别是否可正式渲染",
  semanticAnchor: { type: "scene", targetId: "scene-1", relation: "land_on" },
  spatialAnchor: "bottom_right",
  assetBindings: [],
  props: {},
  motion: { enterPreset: "fade", settlePreset: "hold", exitPreset: "fade", enterFrames: 4, holdFrames: 16, exitFrames: 4 },
  stylePackId: "default-clean",
  qualityRules: [],
  ...overrides
});

const readyImage: Asset = {
  id: "asset-1",
  name: "产品图.png",
  kind: "image",
  role: "generated_visual",
  status: "ready",
  managedPath: "assets/source/product.png",
  sourceHash: "product-hash",
  tags: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  metadata: { durationMs: 0, hasAudio: false, width: 100, height: 100 }
};

test("Effect 内容合同阻止默认占位，并只放行有真实项目内容的 Cue", () => {
  const product = inspectEffectContentContract(baseCue("ProductFan"), [readyImage]);
  assert.equal(product.ready, false);
  assert.match(product.missing.join("、"), /素材绑定/u);

  const comment = inspectEffectContentContract(baseCue("CommentCloud", { props: { comments: ["", "  "] } }), []);
  assert.equal(comment.ready, false);
  assert.match(comment.missing.join("、"), /真实评论/u);

  const workbenchPlaceholder = inspectEffectContentContract(baseCue("GlowCTA", { note: "GlowCTA：由工作台添加" }), []);
  assert.equal(workbenchPlaceholder.ready, false, "编辑备注不能冒充正式成片文案");
  assert.match(workbenchPlaceholder.missing.join("、"), /行动文案/u);

  const endCard = inspectEffectContentContract(baseCue("EndCard", { layer: "fullscreen", note: "谢谢观看" }), []);
  assert.equal(endCard.ready, false, "结束卡不能回退到固定品牌或 CTA");
  assert.deepEqual(endCard.missing, ["项目品牌", "结束主文案", "行动文案"]);

  const completeEndCard = inspectEffectContentContract(baseCue("EndCard", {
    layer: "fullscreen",
    props: { brand: "VideoFlowCut", headline: "剪辑完成", cta: "查看下一集" }
  }), []);
  assert.equal(completeEndCard.ready, true);

  const completeProduct = inspectEffectContentContract(baseCue("ProductFan", {
    assetBindings: [{ slot: "primary", assetId: readyImage.id }]
  }), [readyImage]);
  assert.equal(completeProduct.ready, true);
});
