import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JobStatus } from "@videocut/contracts";
import { createServer } from "../apps/server/src/app.js";

test("Job Retry 只重试已明确失败或取消的任务，未知结果必须先对账", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-job-retry-"));
  const server = await createServer({ workspaceRoot });
  try {
    const created = server.application.createProject({ name: "Job Retry 安全测试" });
    const projectId = created.snapshot.project.id;
    const createJobWithStatus = (status: JobStatus) => {
      const job = server.application.repository.createJob({
        projectId,
        kind: "media_analysis",
        payload: { assetId: `asset-${status}` },
        idempotencyKey: `job-retry-${status}`
      });
      if (status !== "queued") server.application.updateJob(job.id, { status, error: `${status} 测试状态` });
      return server.application.trackJob(job.id);
    };

    for (const status of ["failed", "cancelled"] as const) {
      const original = createJobWithStatus(status);
      const response = await server.app.inject({ method: "POST", url: `/api/jobs/${original.id}/retry` });
      assert.equal(response.statusCode, 202, response.body);
      const retry = response.json() as { id: string; status: JobStatus; kind: string; payload: Record<string, unknown>; idempotencyKey: string };
      assert.notEqual(retry.id, original.id);
      assert.equal(retry.status, "queued");
      assert.equal(retry.kind, original.kind);
      assert.deepEqual(retry.payload, original.payload);
      assert.match(retry.idempotencyKey, new RegExp(`^${original.idempotencyKey}:retry:`));
      assert.equal(server.application.trackJob(original.id).status, status, "重试不能改写原任务的终态记录");
    }

    const failedTranscription = server.application.repository.createJob({
      projectId,
      kind: "transcription",
      payload: { assetId: "asset-transcription-retry" },
      idempotencyKey: "job-retry-transcription"
    });
    server.application.updateJob(failedTranscription.id, { status: "failed", error: "模拟转写超时" });
    const transcriptionResponse = await server.app.inject({ method: "POST", url: `/api/jobs/${failedTranscription.id}/retry` });
    assert.equal(transcriptionResponse.statusCode, 202, transcriptionResponse.body);
    const transcriptionRetry = transcriptionResponse.json() as { payload: Record<string, unknown> };
    assert.deepEqual(transcriptionRetry.payload, {
      assetId: "asset-transcription-retry",
      retryOfJobId: failedTranscription.id
    }, "转写重试必须保留来源 Job，供 Worker 恢复既有 run_id");

    const rejectedCases: Array<{ status: JobStatus; error: string }> = [
      { status: "queued", error: "JOB_RETRY_NOT_TERMINAL" },
      { status: "running", error: "JOB_RETRY_NOT_TERMINAL" },
      { status: "succeeded", error: "JOB_RETRY_SUCCEEDED" },
      { status: "unknown", error: "JOB_RETRY_REQUIRES_RECONCILIATION" }
    ];
    for (const rejected of rejectedCases) {
      const original = createJobWithStatus(rejected.status);
      const jobsBeforeRetry = server.application.listJobs(projectId).length;
      const response = await server.app.inject({ method: "POST", url: `/api/jobs/${original.id}/retry` });
      assert.equal(response.statusCode, 400, response.body);
      const body = response.json() as { error?: string; message?: string };
      assert.equal(body.error, rejected.error);
      if (rejected.status === "unknown") assert.match(body.message ?? "", /对账/u);
      assert.equal(server.application.listJobs(projectId).length, jobsBeforeRetry, "被拒绝的重试不能创建新 Job");
    }
  } finally {
    await server.app.close();
    server.application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
