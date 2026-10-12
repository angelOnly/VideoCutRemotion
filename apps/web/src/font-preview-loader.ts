import { API_BASE } from "./api";
import type { FontLibraryFace } from "../../../packages/motion-work/src/font-preview";

type Pending = { face: FontLibraryFace; resolve: (family: string) => void; reject: (error: unknown) => void };

/** 每个面板拥有自己的字体对象，最多两路加载；清理时不删除Player或其它面板的字体。 */
export class FontPreviewLoader {
  private queue: Pending[] = [];
  private controllers = new Set<AbortController>();
  private registered = new Set<FontFace>();
  private promises = new Map<string, Promise<string>>();
  private disposed = false;

  load(face: FontLibraryFace): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("字体面板已关闭"));
    const existing = this.promises.get(face.sha256);
    if (existing) return existing;
    const promise = new Promise<string>((resolve, reject) => { this.queue.push({ face, resolve, reject }); });
    this.promises.set(face.sha256, promise);
    this.drain();
    return promise;
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    for (const item of this.queue.splice(0)) item.reject(new Error("字体面板已关闭"));
    for (const face of this.registered) document.fonts.delete(face);
    this.registered.clear(); this.promises.clear();
  }

  private drain() {
    while (!this.disposed && this.controllers.size < 2 && this.queue.length) {
      const item = this.queue.shift()!, controller = new AbortController();
      this.controllers.add(controller);
      void this.run(item, controller).finally(() => { this.controllers.delete(controller); this.drain(); });
    }
  }

  private async run(item: Pending, controller: AbortController) {
    const timeout = setTimeout(() => controller.abort(new Error("字体预览加载超时，请刷新后重试")), 15000);
    try {
      const response = await fetch(`${API_BASE}/api/motion/fonts/${encodeURIComponent(item.face.id)}/file?sha256=${item.face.sha256}`, { signal: controller.signal });
      if (!response.ok) {
        const detail = await response.json().catch(() => undefined) as { message?: string } | undefined;
        throw new Error(detail?.message ?? `字体读取失败（${response.status}）`);
      }
      const bytes = await response.arrayBuffer();
      const family = `VFC_PREVIEW_${item.face.sha256}`;
      const face = await new FontFace(family, bytes, { weight: String(item.face.weight), style: item.face.style }).load();
      if (this.disposed) throw new Error("字体面板已关闭");
      if (controller.signal.aborted) throw controller.signal.reason;
      document.fonts.add(face); this.registered.add(face);
      item.resolve(family);
    } catch (error) { item.reject(error); }
    finally { clearTimeout(timeout); }
  }
}
