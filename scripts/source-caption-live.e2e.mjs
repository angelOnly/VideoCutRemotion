import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { runCandidateRuntime } from "../plugins/videoflowcut/scripts/candidate-runtime.mjs";

// 显式使用候选运行合同；本验收不允许复用生产端口、Bridge 或数据库。
const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
assert.ok(sourceIndex >= 0 && isAbsolute(args[sourceIndex + 1]), "必须明确提供绝对 --source 路径");
const [, source] = args.splice(sourceIndex, 2);
const runtime = await runCandidateRuntime("ensure", args);
const request = async (path, body) => {
  const response = await fetch(runtime.apiUrl + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
};
const waitJob = async (job) => {
  console.log(JSON.stringify({ jobId: job.id, kind: job.kind }));
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const current = await request(`/api/jobs/${job.id}`);
    if (current.status === "failed") throw new Error(JSON.stringify(current));
    if (current.status === "succeeded") return current;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`验收超时；保留 Job ${job.id}，不自动重复提交`);
};

let state = await request("/api/projects", { name: "完整原声字幕依赖修复验收", profile: "presenter_motion" });
const projectId = state.snapshot.project.id;
console.log(JSON.stringify({ projectId, releaseId: runtime.releaseId, workspace: state.snapshot.project.rootPath }));
const path = `/api/projects/${projectId}`;
const imported = await request(path + "/assets/import-path", { baseRevision: state.revision.number, filePath: source });
await waitJob(imported.job);
state = await request(path);
state = await request(path + "/timeline/assemble-presenter", { baseRevision: state.revision.number, assetIds: [imported.asset.id] });
const actor = state.snapshot.timeline.items.find((item) => item.assetId === imported.asset.id);
assert.ok(actor);
state = await request(path + "/timeline/compile-presenter-scenes", { baseRevision: state.revision.number, scenes: [{
  title: "完整原视频字幕验收", purpose: "检验长音频字幕写入、边界和真实渲染", startFrame: 0, endFrame: actor.endFrame
}] });
state = await request(path + "/actor-performances", {
  baseRevision: state.revision.number, timelineItemId: actor.id, source: "imported", maskMode: "none", audioMode: "use_source_audio"
});
const captionJob = await request(path + "/source-audio-captions", {
  baseRevision: state.revision.number, timelineItemId: actor.id, idempotencyKey: "full-source-provider-verification"
});
await waitJob(captionJob);
state = await request(path);
const alignment = state.snapshot.sourceAudioAlignments[0];
assert.equal(alignment.tokenPrecision, "provider_token_timed");
assert.ok(alignment.tokens.length > 0);
assert.equal(state.snapshot.sourceCaptionPrograms.length, 1);
assert.equal(state.snapshot.timeline.captions.length, alignment.segments.length);
assert.ok(alignment.segments.every((s) => s.displayText.replace(/[\p{P}\p{S}\s]/gu, "")));
assert.equal(state.snapshot.speechSegmentAssets.length, 0, "原声字幕不生成 TTS");
console.log(JSON.stringify({ projectId, revision: state.revision.number, captions: alignment.segments.length, tokens: alignment.tokens.length }));
const preview = await waitJob(await request(path + "/previews", {
  revision: state.revision.number, fromFrame: 0, toFrame: actor.endFrame, idempotencyKey: "full-source-caption-preview"
}));
console.log(JSON.stringify({ projectId, revision: state.revision.number, releaseId: runtime.releaseId, preview }, null, 2));
