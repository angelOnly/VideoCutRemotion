import { createServer } from "../../server/src/app.js";
import { runWorkerForever } from "../../job-worker/src/index.js";
import { runRenderWorkerForever } from "../../render-worker/src/index.js";
import { applyReleaseRuntimeDefaults } from "@videocut/project-overview";
import { ThreadedRevisionRenderer } from "../../render-worker/src/threaded-renderer.js";

/**
 * 发布构建是 CommonJS，__dirname 即 runtime/dist；开发时 TypeScript 以 ESM
 * 运行则不存在该变量，继续由 Server 使用仓库内 Web 构建目录。
 */
const runtimeConfig = applyReleaseRuntimeDefaults(typeof __dirname === "string" ? __dirname : undefined);
const { port, host } = runtimeConfig.http;
const runtimeToken = runtimeConfig.runtime.runtimeToken;
const runtimeId = runtimeConfig.runtime.runtimeId;
const releaseId = runtimeConfig.runtime.releaseId;

/**
 * 保持入口没有顶层 await，发行构建可稳定输出 CommonJS，Node 才能通过
 * NODE_PATH 从宿主仓库解析运行依赖；开发态的 ESM 启动仍复用同一逻辑。
 */
async function main(): Promise<void> {
  const { app, application } = await createServer({
    serveWeb: true,
    webRoot: runtimeConfig.runtime.webRoot
  });
  const workersAbort = new AbortController();
  let stopping = false;
  const workers = { media: false, render: false };
  const status = () => stopping ? "stopping" : workers.media && workers.render ? "ready" : "starting";

  /**
   * API 与任务领取仍共享一个 EditingApplication。只把不可变 Snapshot 的
   * 渲染计算移到线程，避免第三方同步调用堵住健康接口，不另开 SQLite 队列。
   */
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`VideoFlowCut Runtime 正在停止：${reason}`);
    await app.close().catch(() => undefined);
    workersAbort.abort();
  };

  if (runtimeToken) {
    app.get("/internal/runtime/status", async (request, reply) => {
      if (request.headers["x-videoflowcut-runtime-token"] !== runtimeToken) {
        return reply.code(403).send({ error: "RUNTIME_TOKEN_INVALID" });
      }
      return { status: status(), runtimeId, releaseId, workers };
    });

    app.post("/internal/runtime/shutdown", async (request, reply) => {
      if (request.headers["x-videoflowcut-runtime-token"] !== runtimeToken) {
        return reply.code(403).send({ error: "RUNTIME_TOKEN_INVALID" });
      }
      // 先让 HTTP 响应写回，再关闭 listener；否则 Windows 下调用方可能读到连接中断。
      setTimeout(() => { void shutdown("插件启动器请求"); }, 50);
      return { status: "stopping" };
    });
  }

  /**
   * MCP 在不接触内部控制令牌的前提下核对自己与 Runtime 是否来自同一发行物。
   * 返回值没有路径、令牌或用户数据；它仅用于阻止旧 MCP 对新版 Runtime 伪造部署确认。
   */
  app.get("/api/runtime/status", async () => ({
    status: status(),
    runtimeId,
    releaseId,
    workers
  }));

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

  const renderer = new ThreadedRevisionRenderer(undefined, (error) => {
    workers.render = false;
    void shutdown(`渲染线程不可用：${error.message}`);
  });
  try {
    await app.listen({ port, host });
    console.error(`VideoFlowCut Runtime 已启动：http://${host}:${port}`);
    // 浏览器和冷启动打包全部完成后才领取 Job，避免首个预览打包阻塞在线健康检查。
    await renderer.prepare();
    if (stopping) return;
    workers.media = true;
    workers.render = true;
    await Promise.all([
      runWorkerForever(application, workersAbort.signal),
      runRenderWorkerForever(application, workersAbort.signal, renderer)
    ]);
  } finally {
    workers.media = false;
    workers.render = false;
    await renderer.close();
    await app.close().catch(() => undefined);
    application.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
