import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("发行 FunASR 保留长音频 token 边界，拒绝缺词补标点，并校验供应链哈希", () => {
  const result = spawnSync("python", ["tests/test_funasr_provider.py"], {
    encoding: "utf8", timeout: 30_000
  });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
});
