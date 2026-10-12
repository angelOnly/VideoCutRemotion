import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../packages/edit-application/src/index.js";
import { runWorkerForever } from "../apps/job-worker/src/index.js";

test("外部分析等待时第二条媒体消费循环仍领取后续配音", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-media-concurrency-"));
  const app = createApplication(root);
  const controller = new AbortController();
  let releaseAnalysis!: () => void;
  const analysisWait = new Promise<void>(resolve => { releaseAnalysis = resolve; });
  let notifyVoice!: () => void;
  const voiceDone = new Promise<void>(resolve => { notifyVoice = resolve; });
  try {
    const project = app.createProject({ name: "媒体队列双消费回归" });
    const projectId = project.snapshot.project.id;
    const analysis = app.repository.createJob({ projectId, kind: "media_understanding", payload: {}, idempotencyKey: "analysis" });
    const voice = app.repository.createJob({ projectId, kind: "voice_synthesis", payload: {}, idempotencyKey: "voice" });
    const worker = runWorkerForever(app, controller.signal, async job => {
      if (job.id === analysis.id) { await analysisWait; return { completed: true }; }
      if (job.id === voice.id) { notifyVoice(); return { completed: true }; }
      throw new Error("意外任务");
    });
    await Promise.race([voiceDone, new Promise((_, reject) => setTimeout(() => reject(new Error("后续配音未被领取")), 3000))]);
    assert.equal(app.trackJob(analysis.id).status, "running");
    assert.equal(app.trackJob(voice.id).status, "succeeded");
    controller.abort();
    releaseAnalysis();
    await worker;
  } finally {
    controller.abort();
    releaseAnalysis();
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
