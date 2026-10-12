import test from "node:test";
import assert from "node:assert/strict";
import { activeCaptionsAtFrame } from "@videocut/remotion";
import { layoutCaptionWithMeasure, resolveCaptionLayoutInput } from "../packages/remotion-runtime/src/caption-layout.js";
import { captionDisplaySchema, captionDisplayRanges } from "../packages/contracts/src/caption-presentation.js";
import type { CaptionCard } from "@videocut/contracts";

test("显示时序遵守半开范围且不修改原卡；静态框宽度和垂直边界使用同一测量", () => {
  const card: CaptionCard = { id: "card", text: "字幕", sourceText: "字幕", startFrame: 0, endFrame: 100, style: "stable", precision: "segment_exact", display: { mode: "shown", ranges: [{ startFrame: 12, endFrame: 36 }, { startFrame: 60, endFrame: 80 }] } };
  assert.equal(activeCaptionsAtFrame([card], 11).length, 0);
  assert.equal(activeCaptionsAtFrame([card], 12).length, 1);
  assert.equal(activeCaptionsAtFrame([card], 36).length, 0);
  assert.equal(activeCaptionsAtFrame([card], 60).length, 1);
  assert.deepEqual(captionDisplayRanges({ ...card, display: { mode: "hidden" } }), []);
  assert.equal(card.startFrame, 0); assert.equal(card.sourceText, "字幕");
  assert.equal(captionDisplaySchema.safeParse({ mode: "shown", ranges: [] }).success, false);
  const input = { text: "同一对象", compositionWidth: 1000, compositionHeight: 500, format: { placement: { leftPercent: 50, topPercent: 10, widthPercent: 40 } } };
  assert.equal(resolveCaptionLayoutInput(input)!.maxLineWidth, 400);
  assert.equal(layoutCaptionWithMeasure(input, text => text.length * 20, "browser").ready, true);
  const overflow = layoutCaptionWithMeasure({ ...input, format: { placement: { leftPercent: 50, topPercent: 95, widthPercent: 40 } } }, text => text.length * 20, "browser");
  assert.equal(overflow.ready, false);
  if (!overflow.ready) assert.equal(overflow.reason, "CANVAS_VERTICAL_OVERFLOW");
});
