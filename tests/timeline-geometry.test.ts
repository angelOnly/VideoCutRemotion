import assert from "node:assert/strict";
import test from "node:test";
import { clampFrame, edgeScrollSpeed, frameAtClientX, rulerStep, scrollAfterZoom } from "../apps/web/src/timeline-geometry.js";

test("轨道定位扣除固定名称列，并在缩放、横向滚动后仍命中同一帧", () => {
  assert.equal(frameAtClientX(420, 100, 0, 1000, 2400), 480);
  assert.equal(frameAtClientX(420, 100, 600, 4000, 2400), 480);
  assert.equal(frameAtClientX(0, 100, 0, 1000, 2400), 0);
  assert.equal(frameAtClientX(2000, 100, 0, 1000, 2400), 2399);
  assert.equal(clampFrame(10, 0), 0);
  assert.equal(clampFrame(0.6, 24), 1);
});

test("缩放保持可见指针的屏幕位置；离屏时保持视野中心；适合窗口归零", () => {
  assert.equal(scrollAfterZoom(2000, 4000, 1000, 400, 600, 2400), 900);
  assert.equal(scrollAfterZoom(2000, 4000, 1000, 800, 0, 2400), 2100);
  assert.equal(scrollAfterZoom(4000, 1000, 1000, 2000, 1500, 2400), 0);
  assert.equal(scrollAfterZoom(4000, 2000, 1000, 2900, 2399, 2400), 1000);
});

test("长片与逐帧缩放的刻度都保持可读间距", () => {
  for (const duration of [1, 2400, 24 * 3600 * 4]) {
    for (const width of [900, 5000, duration * 8]) {
      const step = rulerStep(duration, 24, width);
      assert.ok(Number.isInteger(step) && step >= 1);
      assert.ok(step / duration * width >= 90 || step === 1);
    }
  }
});

test("边缘滚动按距离加速并限制速度，中间区域保持静止", () => {
  assert.equal(edgeScrollSpeed(500, 120, 1000), 0);
  assert.equal(edgeScrollSpeed(120, 120, 1000), -720);
  assert.equal(edgeScrollSpeed(1000, 120, 1000), 720);
  assert.equal(edgeScrollSpeed(1200, 120, 1000), 720);
  assert.equal(edgeScrollSpeed(138, 120, 1000), -360);
});
