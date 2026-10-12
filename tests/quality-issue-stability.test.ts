import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { evaluateQuality } from "@videocut/quality";

test("同一 Revision 的质量问题 ID 稳定，Revision 变化后不会与旧问题混淆", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-quality-id-"));
  const application = createApplication(workspaceRoot);
  try {
    const created = application.createProject({ name: "质量 ID 稳定性" });
    const first = evaluateQuality(created.snapshot, created.revision.number);
    const second = evaluateQuality(created.snapshot, created.revision.number);
    assert.deepEqual(
      first.issues.map((entry) => ({ code: entry.code, id: entry.id })),
      second.issues.map((entry) => ({ code: entry.code, id: entry.id })),
      "重复读取同一 Revision 不应生成新的质量问题身份"
    );

    const updated = application.updateStory({
      projectId: created.snapshot.project.id,
      baseRevision: created.revision.number,
      summary: "仅创建一个新 Revision，不改变空时间线问题"
    });
    const next = evaluateQuality(updated.snapshot, updated.revision.number);
    const previousEmpty = first.issues.find((entry) => entry.code === "EMPTY_TIMELINE");
    const nextEmpty = next.issues.find((entry) => entry.code === "EMPTY_TIMELINE");
    assert.ok(previousEmpty && nextEmpty, "两个 Revision 都应保留可比较的空时间线问题");
    assert.notEqual(previousEmpty.id, nextEmpty.id, "质量问题 ID 必须绑定实际 Revision");
  } finally {
    application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
