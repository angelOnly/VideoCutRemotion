import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "@videocut/application";
import { AssetProviderError, AssetProviderRegistry } from "@videocut/acquisition";
import { runProcess } from "@videocut/speech";
import { YoutubeProvider, youtubeVideoUrl } from "../packages/asset-acquisition/src/youtube.js";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import type { AssetRequest } from "@videocut/contracts";

test("YouTube 定向页面拒绝任意站点和列表；候选只返回来源与媒体信息", async () => {
  for (const url of ["https://youtube.com/playlist?list=abc", "https://youtube.com.evil.test/watch?v=abcdefghijk", "http://youtu.be/abcdefghijk", "https://user:pass@youtube.com/watch?v=abcdefghijk", "ytsearch:test", "https://youtube.com/@channel"]) assert.throws(() => youtubeVideoUrl(url));
  assert.equal(youtubeVideoUrl("https://youtu.be/abcdefghijk?t=3").url, "https://www.youtube.com/watch?v=abcdefghijk");
  const provider = new YoutubeProvider(async args => { assert.equal(args.at(-1), "https://www.youtube.com/watch?v=abcdefghijk"); return JSON.stringify({ id: "abcdefghijk", duration: 2, title: "测试元数据" }); });
  const candidates = await provider.search({ request: {} as AssetRequest, query: "https://youtu.be/abcdefghijk" });
  await assert.rejects(new YoutubeProvider(async () => "{}").search({ request: {} as AssetRequest, query: "https://youtu.be/abcdefghijk" }), /元数据|身份/);
});

test("选定页面沿获取Worker登记真实视频，保留来源；下载失败不登记素材", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-youtube-job-"));
  const app = createApplication(root);
  try {
    const projectId = app.createProject({ name: "YouTube固定夹具", profile: "visual_explainer" }).snapshot.project.id;
    const source = join(root, "test.mp4");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=24:d=2", "-c:v", "libx264", source]);
    let fail = false;
    const provider = new YoutubeProvider(async (args, options) => {
      if (!options.directory) return JSON.stringify({ id: "abcdefghijk", duration: 2, title: "模拟下载器" });
      assert.ok(args.includes("--max-filesize"));
      assert.ok(args.includes("--abort-on-unavailable-fragments"), "HLS 缺段必须失败，不能跳过后登记原片");
      assert.equal(args[args.indexOf("--concurrent-fragments") + 1], "4");
      const format = args[args.indexOf("-f") + 1]!;
      assert.ok(!format.includes("height<="), "不能用720p硬上限排除高质量源");
      assert.equal(args[args.indexOf("-S") + 1], `res:${app.readProject(projectId).snapshot.timeline.height},proto:m3u8`);
      assert.equal(options.timeoutMs, 600_000);
      if (fail) { await writeFile(join(options.directory, "source.mp4"), "<html>failed</html>"); return ""; }
      await copyFile(source, join(options.directory, "source.mp4")); return "";
    });
    const revision = () => app.readProject(projectId).revision.number;
    const makeCandidate = async (minDurationMs = 1000) => {
      const state = app.manageAssetRequirement({ projectId, baseRevision: revision(), action: "create", title: "动作补材", purpose: "验证获取合同", visualBrief: "测试完整动作素材", role: "b_roll", minDurationMs, });
      const request = state.snapshot.assetRequests.at(-1)!;
      return app.recordAssetSearch({ projectId, baseRevision: revision(), assetRequestId: request.id, provider: "youtube", query: request.id, candidates: await provider.search({ request, query: "https://youtu.be/abcdefghijk" }) }).candidates[0]!;
    };
    const candidate = await makeCandidate(3000);
    const acquisition = app.acquireAssetCandidate({ projectId, baseRevision: revision(), assetCandidateId: candidate.id, });
    assert.equal(app.acquireAssetCandidate({ projectId, baseRevision: 1, assetCandidateId: candidate.id, }).job.id, acquisition.job.id);
    const processor = createMediaJobProcessor(app, undefined, new AssetProviderRegistry([provider]));
    await runOneJob(app, processor); await runOneJob(app, processor);
    assert.equal(app.trackJob(acquisition.job.id).status, "succeeded", app.trackJob(acquisition.job.id).error);
    const asset = app.readProject(projectId).snapshot.assets[0]!;
    assert.equal(asset.status, "ready"); assert.equal(asset.metadata?.durationMs, 2000);
    assert.equal(asset.provenance?.sourceUrl, "https://www.youtube.com/watch?v=abcdefghijk");
    fail = true;
    const bad = await makeCandidate();
    const failed = app.acquireAssetCandidate({ projectId, baseRevision: revision(), assetCandidateId: bad.id, });
    await runOneJob(app, processor);
    assert.equal(app.trackJob(failed.job.id).status, "failed");
    assert.equal(app.readProject(projectId).snapshot.assets.length, 1);
    const failedRevision = revision();
    assert.throws(() => app.acquireAssetCandidate({ projectId, baseRevision: revision(), assetCandidateId: bad.id, idempotencyKey: failed.job.idempotencyKey }), /幂等键/);
    assert.equal(revision(), failedRevision, "拒绝恢复不得创建视频版本");
    fail = false;
    const recovered = app.acquireAssetCandidate({ projectId, baseRevision: revision(), assetCandidateId: bad.id, });
    assert.notEqual(recovered.job.id, failed.job.id);
    assert.equal(app.acquireAssetCandidate({ projectId, baseRevision: 1, assetCandidateId: bad.id, }).job.id, recovered.job.id);
    await runOneJob(app, processor);
    assert.equal(app.trackJob(recovered.job.id).status, "succeeded");
    assert.equal(app.trackJob(failed.job.id).status, "failed");
    assert.equal(app.readProject(projectId).snapshot.assetCandidates.find(entry => entry.id === bad.id)!.status, "acquired");
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test("HLS 已写部分媒体但下载器报缺段时不得返回可用文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-youtube-fragment-"));
  try {
    const provider = new YoutubeProvider(async (_args, options) => {
      await writeFile(join(options.directory!, "source.mp4"), "部分媒体不是完整原片");
      throw new AssetProviderError("片段下载失败", "YOUTUBE_DOWNLOAD_FAILED");
    });
    await assert.rejects(provider.download({ candidate: { sourceUrl: "https://youtu.be/abcdefghijk", originalAssetId: "abcdefghijk" } as any, temporaryDirectory: root }), (error: unknown) => error instanceof AssetProviderError && error.code === "YOUTUBE_DOWNLOAD_FAILED");
  } finally { await rm(root, { recursive: true, force: true }); }
});
