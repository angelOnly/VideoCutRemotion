import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { registerFontLibraryRoutes } from "../apps/server/src/font-library.js";
import { listMotionFonts, MotionFontUnknownError, readMotionFontFile } from "../packages/motion-work/src/fonts.js";
import { fontPreviewSchema, readFontPreview } from "../packages/motion-work/src/font-preview.js";

test("字体文件只接受目录ID与固定哈希，真实OTF/TTF及缓存身份正确", async () => {
  const server = Fastify();
  registerFontLibraryRoutes(server);
  try {
    const fonts = listMotionFonts();
    for (const id of ["smiley-sans-oblique", "canger-shuyuan-w03"]) {
      const face = fonts.find(font => font.id === id)!;
      const response = await server.inject(`/api/motion/fonts/${id}/file?sha256=${face.sha256}`);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], id === "smiley-sans-oblique" ? "font/otf" : "font/ttf");
      assert.match(String(response.headers["cache-control"]), /immutable/u);
      assert.equal(createHash("sha256").update(response.rawPayload).digest("hex"), face.sha256);
    }
    const missing = await server.inject(`/api/motion/fonts/unknown/file?sha256=${"0".repeat(64)}`);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error, "MOTION_FONT_UNKNOWN");
    const old = await server.inject(`/api/motion/fonts/smiley-sans-oblique/file?sha256=${"0".repeat(64)}`);
    assert.equal(old.statusCode, 409);
    assert.equal(old.json().error, "MOTION_FONT_VERSION_MISMATCH");
    assert.equal(old.headers["cache-control"], "no-store");
    assert.throws(() => readMotionFontFile("../escape", "0".repeat(64)), MotionFontUnknownError);
  } finally { await server.close(); }
});

test("预览链接限制候选数量、去重及文本长度，损坏链接明确提示而不自动采用", () => {
  const input = { text: "本次标题", purpose: "主标题", expected_font: "尚未登记的字体", candidates: [{ font_id: "aa-jianhao", reason: "适合本段的字形" }] };
  assert.deepEqual(readFontPreview(`?fontPreview=${encodeURIComponent(JSON.stringify(input))}`).preview, input);
  assert.equal(readFontPreview("?fontPreview=broken").preview, undefined);
  assert.ok(readFontPreview("?fontPreview=broken").error);
  assert.throws(() => fontPreviewSchema.parse({ ...input, candidates: Array(4).fill(input.candidates[0]) }));
  assert.throws(() => fontPreviewSchema.parse({ ...input, candidates: Array(2).fill(input.candidates[0]) }));
  assert.throws(() => fontPreviewSchema.parse({ ...input, text: "字".repeat(121) }));
  assert.throws(() => fontPreviewSchema.parse({ ...input, candidates: [{ font_id: "C:/font.ttf", reason: "任意路径" }] }));
});
