import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ProjectSnapshot } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { readRuntimeConfig } from "@videocut/project-overview";
import type { RevisionRenderEngine } from "./exporter.js";

type RenderOperation =
  | { action: "prepare" }
  | { action: "render"; snapshot: ProjectSnapshot; targetPath: string }
  | { action: "renderRange"; snapshot: ProjectSnapshot; targetPath: string; fromFrame: number; toFrame: number };
export type RenderThreadRequest = { id: number } & RenderOperation;
export type RenderThreadResponse = { id: number; error?: { message: string; code: string } };

function createRenderThread(): Worker {
  const config = readRuntimeConfig().runtime;
  if (config.distributionDirectory) {
    // 正式线程只执行同一 Release 的发行物，不回到源码或可变依赖入口。
    return new Worker(join(config.distributionDirectory, "render-thread.cjs"));
  }
  const sourceRoot = config.renderSourceRoot ?? join(process.cwd(), "apps", "render-worker", "src");
  // tsx 的主进程加载器不自动接管新线程；开发态明确注册，发行态不依赖 tsx。
  return new Worker(join(sourceRoot, "render-thread-dev.mjs"), { execArgv: [] });
}

/** 隔离第三方渲染的同步 CPU/子进程调用；不增加数据库连接或第二个领取队列。 */
export class ThreadedRevisionRenderer implements RevisionRenderEngine {
  private readonly thread: Worker;
  private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private failure?: Error;
  private closing = false;

  constructor(createThread: () => Worker = createRenderThread, onFatal: (error: Error) => void = () => {}) {
    this.thread = createThread();
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
      if (!this.closing) onFatal(error);
    };
    this.thread.on("message", (message: RenderThreadResponse) => {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (message.error) call.reject(new DomainError(message.error.message, message.error.code));
      else call.resolve();
    });
    this.thread.on("error", (error) => fail(error));
    this.thread.on("exit", (code) => fail(new DomainError(`渲染线程已退出（${code}），未自动重放渲染`, "RENDER_THREAD_EXITED")));
  }

  private request(payload: RenderOperation): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new DomainError("渲染线程正在关闭", "RENDER_THREAD_CLOSED"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.thread.postMessage({ ...payload, id }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  prepare(): Promise<void> { return this.request({ action: "prepare" }); }
  render(snapshot: ProjectSnapshot, targetPath: string): Promise<void> {
    return this.request({ action: "render", snapshot, targetPath });
  }
  renderRange(snapshot: ProjectSnapshot, fromFrame: number, toFrame: number, targetPath: string): Promise<void> {
    return this.request({ action: "renderRange", snapshot, fromFrame, toFrame, targetPath });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.thread.terminate();
  }
}
