import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import { BridgeError, ComfyUIBridgeClient, type BridgeWorkflow } from "@videocut/bridge";
import { modelText, type ExternalCheckpoint } from "../apps/job-worker/src/model-http.js";

test("模型等待超时后显式恢复只续读原运行，连续超时也不重复提交", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-model-timeout-"));
  const app = createApplication(root);
  try {
    const project = app.createProject({ name: "隔离超时恢复验证" });
    const projectId = project.snapshot.project.id;
    const revision = project.revision.number;
    const schema: BridgeWorkflow = { id: "workflow", name: "超时夹具", schemaVersion: "v1", available: true, fields: [], itemSlots: [], outputs: [] };
    const bridge = new ComfyUIBridgeClient("http://127.0.0.1:1");
    let posts = 0;
    const reads: string[] = [];
    bridge.createRunWithSchemaRetry = async (_id, build) => {
      posts++;
      return { workflow: schema, request: await build(schema), schemaRetryCount: 0, run: { id: "original-run", status: "running", outputs: [] } };
    };
    bridge.waitForRun = async (id, options) => {
      reads.push(id);
      assert.equal(options?.timeoutMs, 30 * 60_000);
      if (reads.length <= 2) throw new BridgeError("等待 Bridge 任务超时", undefined, undefined, "BRIDGE_RUN_TIMEOUT");
      return { id, status: "succeeded", outputs: [{ outputSlotId: "result", kind: "text", displayName: "结果", text: "原运行完成后的实际结果" }] };
    };
    const original = app.repository.createJob({ projectId, kind: "media_understanding", payload: {}, idempotencyKey: "timeout-fixture" });
    let current = original;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(modelText(app, current, bridge, "window:0", schema.id, async () => ({ fieldValues: {} }), undefined, "same-request"), /超时/u);
      // 客户端等待结束不能把仍在计算的外部运行改成 failed。
      const checkpoint = (app.trackJob(current.id).result!.externalRuns as Record<string, ExternalCheckpoint>)["window:0"];
      assert.equal(checkpoint.status, "running");
      assert.equal(checkpoint.runId, "original-run");
      app.updateJob(current.id, { status: "failed", error: "等待超时" });
      const next = app.intelligence.retry(projectId, current.id);
      assert.equal(app.intelligence.retry(projectId, current.id).id, next.id);
      current = next;
    }
    const result = await modelText(app, current, bridge, "window:0", schema.id, async () => ({ fieldValues: {} }), undefined, "same-request");
    assert.equal(result.text, "原运行完成后的实际结果");
    assert.equal(posts, 1);
    assert.deepEqual(reads, ["original-run", "original-run", "original-run"]);
    assert.equal(app.trackJob(original.id).status, "failed");
    assert.equal(app.readProject(projectId).revision.number, revision);
  } finally {
    app.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});
