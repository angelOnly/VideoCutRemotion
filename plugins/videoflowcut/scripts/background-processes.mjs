import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// 仅由后台渲染入口加载。Windows 不会把父进程的隐藏设置传给子进程，
// 因此 Remotion 等依赖的直接 spawn 也必须覆盖；不改变管道、信号和退出行为。
if (process.platform === "win32") {
  for (const name of ["spawn", "spawnSync"]) {
    const original = childProcess[name];
    childProcess[name] = function (command, args, options) {
      if (Array.isArray(args) || args == null) {
        return original.call(this, command, args ?? [], { ...options, windowsHide: true });
      }
      if (typeof args === "object") return original.call(this, command, { ...args, windowsHide: true });
      return original.call(this, command, args, options);
    };
  }
  // 同时更新 ESM 命名导出，保证 CommonJS 与 ESM 依赖使用同一启动策略。
  syncBuiltinESMExports();
}
