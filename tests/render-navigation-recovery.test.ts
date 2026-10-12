import assert from "node:assert/strict";
import test from "node:test";
import { withRenderNavigationRecovery } from "../apps/render-worker/src/navigation-recovery.js";

test("仅内部导航响应竞态可恢复，必须取得真实渲染结果后才返回", async () => {
  let attempts = 0;
  const result = await withRenderNavigationRecovery(async () => {
    if (++attempts < 3) throw new Error('Visited "http://localhost:3000/index.html" but got no response.');
    return { completed: true };
  });
  assert.deepEqual(result, { completed: true });
  assert.equal(attempts, 3);
});

test("持续导航故障保留原错误，资源与外部请求失败绝不自动重放", async () => {
  for (const [message, count] of [
    ['Visited "http://127.0.0.1:3001/index.html" but got no response.', 3],
    ['Visited "https://provider.example/index.html" but got no response.', 1],
    ["MOTION_CACHE_CORRUPT", 1], ["MOTION_CSP_VIOLATION", 1], ["Navigation timeout", 1]
  ] as const) {
    let attempts = 0;
    const failure = new Error(message);
    await assert.rejects(withRenderNavigationRecovery(async () => { attempts++; throw failure; }), error => error === failure);
    assert.equal(attempts, count);
  }
});
