import { parentPort } from "node:worker_threads";
import { applyReleaseRuntimeDefaults } from "@videocut/project-overview";
import { RevisionRenderer } from "./exporter.js";
import type { RenderThreadRequest, RenderThreadResponse } from "./threaded-renderer.js";

// 线程与 API 使用同版部署合同，但不创建 EditingApplication 或访问 SQLite 队列。
applyReleaseRuntimeDefaults(typeof __dirname === "string" ? __dirname : undefined);
const renderer = new RevisionRenderer();
const port = parentPort;
if (!port) throw new Error("渲染线程入口不能作为独立服务启动");
let queue = Promise.resolve();
port.on("message", (request: RenderThreadRequest) => {
  queue = queue.then(async () => {
    const response: RenderThreadResponse = { id: request.id };
    try {
      if (request.action === "prepare") await renderer.prepare();
      else if (request.action === "render") await renderer.render(request.snapshot, request.targetPath);
      else if (request.action === "renderRange") await renderer.renderRange(request.snapshot, request.fromFrame, request.toFrame, request.targetPath);
      else throw new Error("未知渲染动作");
    } catch (error) {
      response.error = {
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === "object" && "code" in error ? String(error.code) : "RENDER_THREAD_FAILED"
      };
    }
    port.postMessage(response);
  });
});
