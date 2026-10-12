import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { captionTextShadowCss, captionTextShadowSchema } from "../packages/contracts/src/caption-presentation.js";

test("接入完整美术正文，插件副本与唯一来源一致且方法链接有效", () => {
  // 活动方法允许授权修订；核对完整来源与发行副本，不把某版措辞冻结成历史原件。
  for (const name of ["SKILL.md", "references/art-direction.md"]) {
    const source = resolve(`.agents/skills/visual-treatment-planning/${name}`);
    const text = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
    assert.equal(readFileSync(resolve(`plugins/videoflowcut/skills/visual-treatment-planning/${name}`), "utf8").replace(/\r\n/g, "\n"), text);
    for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) assert.ok(existsSync(resolve(dirname(source), match[1]!)), match[1]);
  }
  const routing = readFileSync(".agents/skills/production-coordinator/references/task-routing.md", "utf8");
  assert.ok(routing.includes("../../visual-treatment-planning/SKILL.md"));
  assert.ok(readFileSync(".agents/skills/captions/SKILL.md", "utf8").includes("../visual-treatment-planning/SKILL.md"));
});

test("字幕阴影显式关闭优先，旧作品兼容，结构拒绝任意CSS", () => {
  assert.equal(captionTextShadowCss(undefined), "0 3px 14px #000");
  assert.equal(captionTextShadowCss(null), "none");
  assert.equal(captionTextShadowCss({ offsetX: -2, offsetY: 3, blur: 6, color: "#123456", opacity: 0.4 }), "-2px 3px 6px #12345666");
  assert.equal(captionTextShadowSchema.safeParse("none").success, false);
  assert.equal(captionTextShadowSchema.safeParse({ offsetX: 0, offsetY: 0, blur: 41, color: "#000000", opacity: 1 }).success, false);
});
