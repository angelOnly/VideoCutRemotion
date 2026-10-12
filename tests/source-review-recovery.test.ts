import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createServer } from "../apps/server/src/app.js";
import { inspectAsset } from "../apps/server/src/source-review.js";
import { classifySourceReviewFailure } from "../apps/server/src/source-review-diagnostics.js";
import { MediaProcessError, probeMedia, runProcess } from "@videocut/speech";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-review-recovery-"));
  const server = await createServer({ workspaceRoot: root });
  const app = server.application;
  const created = app.createProject({ name: "审阅容错隔离夹具" });
  const projectId = created.snapshot.project.id;
  const original = join(root, "fixture.mp4");
  await runProcess("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=96x72:rate=24:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", original]);
  const imported = app.registerImportedAsset({ projectId, baseRevision: created.revision.number, name: "fixture.mp4", kind: "video", managedPath: "assets/source/fixture.mp4" });
  const path = join(created.snapshot.project.rootPath, imported.asset.managedPath);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(original, path);
  app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(path) });
  const before = app.readProject(projectId), jobsBefore = app.repository.listJobs(projectId);
  return { root, server, app, path, before, input: { projectId, assetId: imported.asset.id, mode: "overview" as const, contactSheetFrames: 4 },
    async close() {
      assert.deepEqual(app.readProject(projectId), before, "审阅不改视频 Revision、Asset 状态或内容");
      assert.deepEqual(app.repository.listJobs(projectId), jobsBefore, "审阅不提交生成任务");
      await server.app.close(); app.close(); await rm(root, { recursive: true, force: true });
    } };
}

for (const failIndex of [2, 4]) test(`第${failIndex}张预览为空时保留其他真实图片，失败缓存不复用`, async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const result = await inspectAsset(f.app, f.input, { runProcess: async (command, args, timeout) => {
      if (args.at(-1)?.endsWith(".jpg") && ++calls === failIndex) return "";
      return runProcess(command, args, timeout);
    } });
    assert.equal(calls, 4); assert.equal(result.contactSheet.frames.length, 3);
    assert.equal(result.diagnostics.status, "partial");
    assert.equal(result.diagnostics.recovery, "inspect_available_evidence");
    assert.equal(result.diagnostics.issues[0].owner, "unknown");
    assert.equal(result.diagnostics.issues[0].code, "SOURCE_REVIEW_OUTPUT_EMPTY");
    assert.equal(result.diagnostics.issues[0].sourceFrame, failIndex === 4 ? 23 : 8);
    const cache = join(f.before.snapshot.project.rootPath, "cache/source-review");
    assert.equal((await readdir(cache, { recursive: true })).some(name => name.includes(".partial-")), false);
    let regenerated = 0;
    const next = await inspectAsset(f.app, f.input, { runProcess: async (command, args, timeout) => {
      if (args.at(-1)?.endsWith(".jpg")) regenerated++;
      return runProcess(command, args, timeout);
    } });
    assert.equal(regenerated, 1, "只补缺口，不把空文件当缓存成功");
    assert.equal(next.diagnostics.status, "complete");
  } finally { await f.close(); }
});

test("所有图片为空但连续代理成功时仍可观看，声音分析失败不丢波形", async () => {
  const f = await fixture();
  try {
    const result = await inspectAsset(f.app, { ...f.input, mode: "range", sourceStartFrame: 0, sourceEndFrame: 24 }, {
      runProcess: async (command, args, timeout) => {
        if (args.at(-1)?.endsWith(".jpg")) return "";
        if (args.includes("volumedetect")) throw new MediaProcessError("声音分析超时", "", { timedOut: true });
        return runProcess(command, args, timeout);
      }
    });
    assert.equal(result.diagnostics.status, "partial");
    assert.equal(result.diagnostics.continuousReview, "available");
    assert.ok(result.proxy); assert.ok(result.audio.waveform);
    assert.equal(result.diagnostics.components.audioAnalysis, "partial");
    assert.equal(result.audio.meanVolumeDb, undefined);
    assert.equal((await probeMedia(join(f.before.snapshot.project.rootPath, result.proxy.relativePath))).videoCodec, "h264");
  } finally { await f.close(); }
});

test("波形为空不妨碍连续代理与其他声音证据，代理失败不能以截图审阅通过", async () => {
  const f = await fixture();
  try {
    const result = await inspectAsset(f.app, { ...f.input, mode: "dense", sourceStartFrame: 0, sourceEndFrame: 24 }, {
      runProcess: async (command, args, timeout) => {
        if (/source-range.*\.mp4$/u.test(args.at(-1) ?? "") || args.at(-1)?.endsWith(".png")) return "";
        return runProcess(command, args, timeout);
      }
    });
    assert.equal(result.contactSheet.frames.length, 4);
    assert.equal(result.diagnostics.continuousReview, "unavailable");
    assert.equal(result.proxy, undefined); assert.equal(result.audio.waveform, undefined);
    assert.equal(result.diagnostics.components.audioAnalysis, "complete");
    assert.ok(Number.isFinite(result.audio.meanVolumeDb));
    assert.match(result.evidenceBoundaries.join(" "), /不能以截图替代连续观看/u);
  } finally { await f.close(); }
});

test("磁盘故障终止后续处理但保留已成功图片，工具无法启动仍报平台故障", async () => {
  for (const systemCode of ["ENOSPC", "ENOENT"]) {
    const f = await fixture();
    try {
      let calls = 0;
      const result = await inspectAsset(f.app, { ...f.input, mode: "range", sourceStartFrame: 0, sourceEndFrame: 24 }, {
        runProcess: async (command, args, timeout) => {
          if (args.at(-1)?.endsWith(".jpg") && ++calls === 2) throw new MediaProcessError("工具或磁盘故障", "", { systemCode });
          return runProcess(command, args, timeout);
        }
      });
      assert.equal(calls, 2); assert.equal(result.contactSheet.frames.length, 1);
      assert.equal(result.diagnostics.recovery, "report_platform_failure");
      assert.equal(result.diagnostics.components.proxy, "skipped");
      assert.equal(result.diagnostics.components.waveform, "skipped");
      assert.equal(result.diagnostics.components.audioAnalysis, "skipped");
    } finally { await f.close(); }
  }
});

test("全部为空或超时时原因保留未知，转向其他候选而不制造平台工单", async () => {
  const f = await fixture();
  try {
    const result = await inspectAsset(f.app, f.input, { runProcess: async (command, args, timeout) => {
      if (args.at(-1)?.endsWith(".jpg")) return "";
      return runProcess(command, args, timeout);
    } });
    assert.equal(result.diagnostics.status, "unavailable");
    assert.equal(result.diagnostics.recovery, "select_another_candidate");
    assert.equal(result.diagnostics.issues.every(issue => issue.owner === "unknown"), true);
    assert.equal(result.diagnostics.sideEffects, "review_cache_only");
    const timeout = classifySourceReviewFailure(new MediaProcessError("执行超时", "", { timedOut: true }), "contact_sheet");
    assert.equal(timeout.owner, "unknown"); assert.equal(timeout.code, "SOURCE_REVIEW_TIMEOUT");
  } finally { await f.close(); }
});

test("真实坏文件通过HTTP返回候选不可用，原件丢失则返回平台故障", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, "<html>下载失败页面</html>");
    const response = await f.server.app.inject({ method: "POST", url: `/api/projects/${f.input.projectId}/assets/${f.input.assetId}/inspect`, payload: { mode: "overview", contactSheetFrames: 4 } });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.diagnostics.status, "unavailable");
    assert.equal(result.diagnostics.recovery, "select_another_candidate");
    assert.equal(result.diagnostics.issues.every((issue: { owner: string }) => issue.owner === "source"), true);
    await rm(f.path);
    const missing = await inspectAsset(f.app, f.input);
    assert.equal(missing.diagnostics.recovery, "report_platform_failure");
  } finally { await f.close(); }
});

test("编码能力不足与程序异常不冒称素材损坏", () => {
  const codec = classifySourceReviewFailure(new MediaProcessError("解码失败", "Decoder codec-x not found"), "contact_sheet");
  assert.equal(codec.owner, "capability");
  const encoder = classifySourceReviewFailure(new MediaProcessError("编码失败", "Unknown encoder 'libx264'"), "proxy");
  assert.equal(encoder.owner, "platform");
  assert.equal(classifySourceReviewFailure(new TypeError("程序异常"), "contact_sheet").owner, "platform");
});

test("代理虽有有效画面但缺少后半段时不能标为连续审阅成功", async () => {
  const f = await fixture();
  try {
    const result = await inspectAsset(f.app, { ...f.input, mode: "range", sourceStartFrame: 0, sourceEndFrame: 24 }, {
      runProcess: async (command, args, timeout) => {
        if (command === "ffmpeg" && /source-range.*\.mp4$/u.test(args.at(-1) ?? "")) {
          const shortened = [...args]; shortened[shortened.indexOf("-t") + 1] = "0.5";
          return runProcess(command, shortened, timeout);
        }
        return runProcess(command, args, timeout);
      }
    });
    assert.equal(result.contactSheet.frames.length, 4);
    assert.equal(result.proxy, undefined);
    assert.equal(result.diagnostics.continuousReview, "unavailable");
    assert.equal(result.diagnostics.issues.find(issue => issue.stage === "proxy")!.code, "SOURCE_REVIEW_PROXY_INCOMPLETE");
    assert.match(result.evidenceBoundaries.join(" "), /不能以截图替代连续观看/u);
  } finally { await f.close(); }
});
