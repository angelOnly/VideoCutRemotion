/**
 * Remotion 4 的并发页面导航偶发先收到 load、后收到 CDP responseReceivedExtraInfo，
 * 此时 HTTP 200 仍会被报告为无响应。只重做无外部副作用的本地渲染，最多恢复两次；
 * 不重试资源/脚本/超时错误，也不把失败产物标为成功。
 */
export async function withRenderNavigationRecovery<T>(render: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await render(); }
    catch (error) {
      if (attempt >= 2 || !(error instanceof Error)
        || !/^Visited "http:\/\/(?:localhost|127\.0\.0\.1):\d+\/index\.html" but got no response\.$/u.test(error.message)) throw error;
      process.stderr.write(`Remotion 内部页面响应事件未齐，重新渲染（恢复 ${attempt + 1}/2）：${error.message}\n`);
    }
  }
}
