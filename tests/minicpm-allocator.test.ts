import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("MiniCPM 在首次导入 torch 前隔离新旧 allocator 设置，父环境不变", () => {
  // 拦截真实入口的首次 torch 导入，不加载模型，也不占用 GPU。
  const script = `
import builtins, json, os, runpy, sys
original = builtins.__import__
def checked_import(name, *args, **kwargs):
    if name == 'torch':
        print(json.dumps({key: os.environ.get(key) for key in
            ['PYTORCH_ALLOC_CONF', 'PYTORCH_CUDA_ALLOC_CONF', 'MINICPM_TEST_KEEP']}))
        raise SystemExit(0)
    return original(name, *args, **kwargs)
builtins.__import__ = checked_import
runpy.run_path(sys.argv[1], run_name='__main__')
raise RuntimeError('未执行 torch 导入检查')
`;
  for (const allocator of [undefined, "backend:cudaMallocAsync", "backend:cudaMallocAsync,backend:cudaMallocAsync"]) {
    const env: NodeJS.ProcessEnv = { ...process.env, MINICPM_TEST_KEEP: "保留其它环境" };
    for (const key of ["PYTORCH_ALLOC_CONF", "PYTORCH_CUDA_ALLOC_CONF"]) {
      if (allocator === undefined) delete env[key];
      else env[key] = allocator;
    }
    const result = spawnSync("python", ["-c", script, resolve("integrations/comfyui-semantic/minicpmo_worker.py")], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      PYTORCH_ALLOC_CONF: "backend:native", PYTORCH_CUDA_ALLOC_CONF: "backend:native", MINICPM_TEST_KEEP: "保留其它环境"
    });
    assert.equal(env.PYTORCH_CUDA_ALLOC_CONF, allocator);
    assert.equal(env.PYTORCH_ALLOC_CONF, allocator);
  }
});
