import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { renderManagedMotion } from "../apps/render-worker/src/motion-renderer.js";
import { motionHash } from "../packages/motion-work/src/compiler.js";
import { motionFixture } from "./fixtures/managed-motion.js";

test("T12：同一时间常量驱动画面与事件，改时序产生新版本并保留有效阅读", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-topic-timing-"));
  try {
    // 夹具只验证实际像素与事件边界，不把技术渲染视为审美通过。
    const source = `import React from 'react';
import {useCurrentFrame} from 'remotion';
const timing = {reveal: [2, 5]};
export function resolveMotionEvents() {
  return [{id:'reveal',meaning:'色块揭示后稳定阅读',startFrame:timing.reveal[0],endFrame:timing.reveal[1]}];
}
export default function Motion() {
  const frame=useCurrentFrame();
  const progress=Math.max(0,Math.min(1,(frame-timing.reveal[0])/(timing.reveal[1]-timing.reveal[0])));
  return <div style={{position:'absolute',left:0,top:0,width:64*progress,height:64,background:'#ff0000'}}/>;
}`;
    const work = { ...motionFixture, reference: undefined, source, width: 64, height: 64, durationInFrames: 10 };
    const revised = { ...work, source: source.replace("reveal: [2, 5]", "reveal: [4, 7]") };
    assert.notEqual(motionHash(work), motionHash(revised), "旧版本的审阅不能替改时序后的作品背书");
    const frame = async (directory: string, index: number) => PNG.sync.read(await readFile(join(directory, "frames", `frame-${String(index).padStart(5, "0")}.png`)));
    for (const [id, input, start, end] of [["first", work, 2, 5], ["revised", revised, 4, 7]] as const) {
      const directory = join(root, id);
      const result = await renderManagedMotion(input, directory);
      assert.deepEqual(result.events, [{ id: "reveal", meaning: "色块揭示后稳定阅读", startFrame: start, endFrame: end }]);
      const before = await frame(directory, start);
      assert.equal(before.data[3], 0, "事件起点前保持透明");
      const during = await frame(directory, start + 1);
      assert.equal(during.data[3], 255, "事件开始后画面实际展开");
      assert.equal(during.data[(63 * 4) + 3], 0, "中途不能提前显示完整终态");
      const settled = await frame(directory, end);
      assert.deepEqual([...settled.data.subarray(63 * 4, 64 * 4)], [255, 0, 0, 255]);
      assert.equal(result.frameHashes[end], result.frameHashes[9], "完成后的稳定阅读允许保持，不自动删静帧");
      assert.equal(result.determinism?.status, "exact");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
