// 发行映射只恢复堆栈位置，不依赖源码运行。
process.setSourceMapsEnabled(true);

/** 保存原始异常链，限制长度与深度，避免循环引用或巨大对象污染诊断。 */
export function errorDetail(error: unknown, seen = new Set<unknown>(), depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "NonError", message: String(error).slice(0, 16000) };
  if (seen.has(error) || depth >= 5) return { name: error.name, message: "异常链已截断" };
  seen.add(error);
  return { name: error.name, message: error.message.slice(0, 16000), stack: error.stack?.slice(0, 32000),
    ...("code" in error ? { code: String(error.code) } : {}),
    ...(error.cause !== undefined ? { cause: errorDetail(error.cause, seen, depth + 1) } : {}) };
}
