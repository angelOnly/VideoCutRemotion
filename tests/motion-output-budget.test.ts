import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { checkMotionDiskSpace, checkMotionOutputBudget, motionOutputBudget, MOTION_DISK_RESERVE_BYTES } from "../apps/render-worker/src/motion-output-budget.js";

test("高纹理输出超过旧512MiB及像素总量仍按无损磁盘体积计算", () => {
  const width = 1080, height = 1920, frames = 264;
  const png = new PNG({ width, height });
  let seed = 123456789;
  for (let i = 0; i < png.data.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    png.data[i] = seed & 255;
  }
  const encoded = PNG.sync.write(png, { colorType: 6, deflateLevel: 6, deflateStrategy: 0 });
  assert.deepEqual(PNG.sync.read(encoded).data, png.data);
  const total = encoded.length * frames;
  assert.ok(total > 512 * 1024 * 1024, "夹具必须复现旧预算失败");
  const budget = motionOutputBudget(width, height, frames);
  assert.doesNotThrow(() => checkMotionOutputBudget(total, budget));
  assert.doesNotThrow(() => checkMotionOutputBudget(budget, budget));
  assert.throws(() => checkMotionOutputBudget(budget + 1, budget), /MOTION_OUTPUT_BUDGET.*字节/u);
  assert.ok(motionOutputBudget(1000, 1000, 650) < 3 * 1024 ** 3);
  assert.ok(motionOutputBudget(1000, 1000, 651) > motionOutputBudget(1000, 1000, 650));
  assert.ok(motionOutputBudget(768, 1344, 792) > 3 * 1024 ** 3);
  assert.throws(() => motionOutputBudget(1920, 1920, Number.MAX_SAFE_INTEGER), /MOTION_RENDER_BUDGET/u);
  assert.throws(() => motionOutputBudget(NaN, 1920, 264), /MOTION_RENDER_BUDGET/u);
});

test("磁盘不足在渲染前拒绝，并预留预览空间", () => {
  const budget = motionOutputBudget(1080, 1920, 264);
  assert.doesNotThrow(() => checkMotionDiskSpace(budget + MOTION_DISK_RESERVE_BYTES, budget));
  assert.throws(() => checkMotionDiskSpace(budget + MOTION_DISK_RESERVE_BYTES - 1, budget), /MOTION_DISK_SPACE.*可用.*需要/u);
  assert.ok(motionOutputBudget(320, 320, 18) < 8 * 1024 * 1024, "小作品不能被固定512MiB最低预留误挡");
});
