import assert from "node:assert/strict";
import test from "node:test";
import { planCreativePreviewFrames } from "../scripts/creative-preview-frames.js";

test("动作接管的中途与边界都保留，超过工具上限分批而不截断", () => {
  const requested = [28, 29, 134, 135, 503, 504, 505, 527];
  const batches = planCreativePreviewFrames(528, requested);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.length > 0 && batch.length <= 12));
  const actual = batches.flat();
  assert.ok(requested.every((frame) => actual.includes(frame)));
  assert.deepEqual(actual, [0, 28, 29, 105, 134, 135, 211, 316, 422, 503, 504, 505, 527]);
  assert.deepEqual(requested, [28, 29, 134, 135, 503, 504, 505, 527]);
});

test("旧输入继续概览取样，极短作品不产生重复或越界帧", () => {
  assert.deepEqual(planCreativePreviewFrames(100), [[0, 20, 40, 60, 80, 99]]);
  assert.deepEqual(planCreativePreviewFrames(1), [[0]]);
  assert.deepEqual(planCreativePreviewFrames(2), [[0, 1]]);
});

test("作者帧去重排序，保留全部显式请求", () => {
  const result = planCreativePreviewFrames(30, Array.from({ length: 30 }, (_, i) => 29 - i).concat([0, 29]));
  assert.deepEqual(result.map((batch) => batch.length), [12, 12, 6]);
  assert.deepEqual(result.flat(), Array.from({ length: 30 }, (_, i) => i));
});

test("范围外、非整数与错误形状输入在调用工具前拒绝，不悄悄修正", () => {
  for (const frames of [[-1], [30], [0.5], [NaN], [Infinity], ["1"], null, "1", {}]) {
    assert.throws(() => planCreativePreviewFrames(30, frames as number[]), /inspection_frames/);
  }
  for (const duration of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => planCreativePreviewFrames(duration), /预览长度/);
  }
});
