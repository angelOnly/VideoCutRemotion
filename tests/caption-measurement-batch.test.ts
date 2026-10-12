import assert from "node:assert/strict";
import test from "node:test";
import { bindMotionFonts } from "../packages/motion-work/src/fonts.js";
import { measureCaptionTextInBrowser } from "../packages/quality-system/src/caption-measurement.js";

test("整片33卡共用登记中文字体时完成真实测量，不重复传输字体原件", { timeout: 60_000 }, async () => {
  const { slot: _slot, ...registeredFont } = bindMotionFonts({ fontBindings: { caption: "noto-sans-sc-bold" } })[0]!;
  // 复现整片批量测量规模；每行内容不同，确保去重字体没有丢失或串用测量结果。
  const requests = Array.from({ length: 33 }, (_, index) => ({
    font: `normal 700 32px ${registeredFont.family}`,
    texts: ["字幕".repeat(index % 10 + 1), ""], registeredFont
  }));
  const widths = await measureCaptionTextInBrowser(requests);
  assert.equal(widths.length, requests.length);
  widths.forEach((row, index) => assert.deepEqual(row, [64 * (index % 10 + 1), 0]));
});
