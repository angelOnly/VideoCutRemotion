import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const { withRuntimeOperationLock, isLaunchLockOwnerCurrent } = await import(pathToFileURL(resolve("plugins/videoflowcut/scripts/runtime-launcher.mjs")).href);

test("MCP 操作与部署共用工作区互斥锁，前一个操作完成才能进入", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videoflowcut-operation-lock-"));
  const options = { repoRoot: process.cwd(), workspaceRoot, port: 3199 };
  const order: string[] = [];
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolveStarted) => { entered = resolveStarted; });
  try {
    const first = withRuntimeOperationLock(options, async () => {
      order.push("调用开始");
      entered();
      await new Promise<void>((done) => { finish = done; });
      order.push("调用完成");
    });
    await started;
    const second = withRuntimeOperationLock(options, async () => { order.push("部署进入"); });
    await new Promise((done) => setTimeout(done, 30));
    assert.deepEqual(order, ["调用开始"]);
    finish();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["调用开始", "调用完成", "部署进入"]);
    await assert.rejects(withRuntimeOperationLock(options, async () => { throw new Error("验证失败"); }), /验证失败/);
    assert.equal(await withRuntimeOperationLock(options, async () => "已释放"), "已释放");
  } finally {
    finish?.();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("遗留启动锁的 PID 被新进程复用后可恢复，不误杀同号进程或抢占活跃锁", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videoflowcut-reused-pid-"));
  try {
    assert.equal(isLaunchLockOwnerCurrent({ pid: process.pid, createdAt: new Date().toISOString() }), true);
    const old = new Date(Date.now() - (process.uptime() + 3600) * 1000);
    assert.equal(isLaunchLockOwnerCurrent({ pid: process.pid, createdAt: old.toISOString() }), false);
    const directory = join(workspaceRoot, ".videoflowcut-runtime");
    await mkdir(directory);
    const lock = join(directory, "launch.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: old.toISOString() }));
    await utimes(lock, old, old);
    assert.equal(await withRuntimeOperationLock({ repoRoot: process.cwd(), workspaceRoot, port: 3199 }, async () => "已恢复"), "已恢复");
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("等待超时和取消均不执行回调，活跃持锁者不被抢占且后续操作可恢复", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videoflowcut-lock-wait-"));
  const options = { repoRoot: process.cwd(), workspaceRoot, port: 3199 };
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  let calls = 0;
  const holder = withRuntimeOperationLock(options, async () => {
    entered();
    await new Promise<void>(done => { finish = done; });
  }, { operationName: "回归持锁" });
  try {
    await started;
    const lock = join(workspaceRoot, ".videoflowcut-runtime", "launch.lock");
    const metadata = JSON.parse(await readFile(lock, "utf8"));
    assert.equal(metadata.operation, "回归持锁");
    await assert.rejects(withRuntimeOperationLock(options, () => { calls++; }, { waitTimeoutMs: 30 }), { code: "RUNTIME_LOCK_TIMEOUT" });
    const controller = new AbortController();
    const cancelled = withRuntimeOperationLock(options, () => { calls++; }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, { code: "RUNTIME_LOCK_CANCELLED" });
    assert.deepEqual(JSON.parse(await readFile(lock, "utf8")), metadata);
    assert.equal(calls, 0);
    finish();
    await holder;
    assert.equal(await withRuntimeOperationLock(options, () => ++calls), 1);
  } finally {
    finish?.();
    await holder;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("业务内部 EEXIST 只执行一次，不能被误认成抢锁冲突而重放", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videoflowcut-lock-eexist-"));
  const options = { repoRoot: process.cwd(), workspaceRoot, port: 3199 };
  let calls = 0;
  try {
    await assert.rejects(withRuntimeOperationLock(options, () => {
      calls++;
      throw Object.assign(new Error("业务文件已存在"), { code: "EEXIST" });
    }, { waitTimeoutMs: 500 }), { code: "EEXIST" });
    assert.equal(calls, 1);
    assert.equal(await withRuntimeOperationLock(options, () => "释放成功"), "释放成功");
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});

test("锁删除短暂失败会重试，持续失败明确报错且同进程可恢复", async (context) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videoflowcut-lock-release-"));
  const options = { repoRoot: process.cwd(), workspaceRoot, port: 3199 };
  const lock = join(workspaceRoot, ".videoflowcut-runtime", "launch.lock");
  const originalRm = fs.rm;
  let remainingFailures = 2;
  // 在真实文件锁的释放边界注入 Windows 占用错误，不替换业务或抢锁流程。
  const mocked = context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === lock && remainingFailures-- > 0) throw Object.assign(new Error("文件暂被占用"), { code: "EPERM" });
    return originalRm(...args);
  });
  syncBuiltinESMExports();
  let calls = 0;
  try {
    assert.equal(await withRuntimeOperationLock(options, async () => {
      calls++;
      return "已执行一次";
    }), "已执行一次");
    await assert.rejects(readFile(lock), { code: "ENOENT" });
    remainingFailures = Infinity;
    await assert.rejects(withRuntimeOperationLock(options, async () => {
      calls++;
    }), { code: "RUNTIME_LOCK_RELEASE_FAILED" });
    assert.equal(calls, 2);
    remainingFailures = 0;
    assert.equal(await withRuntimeOperationLock(options, () => ++calls), 3);
    await assert.rejects(readFile(lock), { code: "ENOENT" });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
