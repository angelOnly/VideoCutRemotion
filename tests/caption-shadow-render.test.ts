import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { createApplication } from "@videocut/application";
import { DEFAULT_CAPTION_FORMAT } from "@videocut/contracts";
import { runProcess } from "@videocut/speech";
import { RevisionRenderer } from "../apps/render-worker/src/exporter.js";

test("真实预览与全片导出兑现相同阴影选择，显式关闭消除阴影像素", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-caption-shadow-render-"));
  const app = createApplication(root);
  const renderer = new RevisionRenderer(undefined, 1);
  try {
    const snapshot = structuredClone(app.createProject({ name: "字幕阴影隔离渲染" }).snapshot);
    delete snapshot.timeline.captionFormat; // 历史逐卡阴影仍按原快照解释。
    snapshot.timeline.width = 480;
    snapshot.timeline.height = 480;
    snapshot.timeline.durationInFrames = 2;
    snapshot.timeline.captions = [{ id: "caption", text: "符合非自愿退票条件", sourceText: "符合非自愿退票条件", startFrame: 0, endFrame: 2, style: "stable", precision: "segment_exact", format: { ...DEFAULT_CAPTION_FORMAT, fontSize: 24, textShadow: { offsetX: 8, offsetY: 8, blur: 0, color: "#ff0000", opacity: 1 } } }];
    async function pixels(name: string, full: boolean) {
      const video = join(root, `${name}.mp4`);
      if (full) await renderer.render(snapshot, video);
      else await renderer.renderRange(snapshot, 0, 2, video);
      const image = join(root, `${name}.png`);
      await runProcess("ffmpeg", ["-y", "-i", video, "-frames:v", "1", image]);
      return PNG.sync.read(await readFile(image)).data;
    }
    const preview = await pixels("preview", false);
    const full = await pixels("export", true);
    assert.deepEqual(preview, full, "同一Composition的预览与导出必须像素一致");
    snapshot.timeline.captions[0]!.format!.textShadow = null;
    const clear = await pixels("no-shadow", false);
    const reds = (data: Buffer) => {
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! > 140 && data[i + 1]! < 90 && data[i + 2]! < 90) count++;
      return count;
    };
    assert.ok(reds(preview) > 100, "指定阴影必须出现在实际像素中");
    assert.equal(reds(clear), 0, "关闭阴影不能仍套回默认或上次外观");
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
