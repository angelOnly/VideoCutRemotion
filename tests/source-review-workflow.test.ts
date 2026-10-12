import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("主任务、原素材作者与故障技能共享审阅分流规则，不把素材缺口当平台故障", async () => {
  const paths = ["AGENTS.md", ".agents/skills/known-errors/references/submission-errors.md",
    ".agents/skills/visual-asset-sourcing/references/acquisition-operations.md"];
  for (const path of paths) {
    const text = await readFile(path, "utf8");
    for (const rule of ["inspect_available_evidence", "select_another_candidate", "report_platform_failure", "range/dense"]) assert.ok(text.includes(rule), `${path} 缺少 ${rule}`);
    assert.match(text, /其他.*继续/u);
  }
  const coordinator = await readFile(".agents/skills/production-coordinator/references/task-routing.md", "utf8");
  const sourceReview = await readFile(".agents/skills/visual-asset-sourcing/references/source-review.md", "utf8");
  // 作者方法和协调入口均指向同一份操作分流，不要求全文复制诊断规则。
  for (const text of [coordinator, sourceReview]) {
    assert.match(text, /\[审阅诊断\]\([^)]*acquisition-operations\.md#审阅与诊断分流\)/u);
  }
  const knownErrors = await readFile(".agents/skills/known-errors/references/submission-errors.md", "utf8");
  assert.match(knownErrors, /不是下载\/生成重试许可/u);
  assert.match(knownErrors, /空输出与超时不能证明原视频损坏/u);
});
