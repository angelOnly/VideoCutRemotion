"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/production-service/src/review-cli.ts
var review_cli_exports = {};
__export(review_cli_exports, {
  executeReviewCommand: () => executeReviewCommand
});
module.exports = __toCommonJS(review_cli_exports);
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var import_zod2 = require("zod");

// packages/production-service/src/review-policy.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_crypto = require("node:crypto");
function requireValue(value, message) {
  if (!value) throw new Error(message);
}
function createReviewPlan(input) {
  requireValue(input.runId && input.sourceDigest && input.scenes.length, "\u5BA1\u67E5\u9700\u8981\u771F\u5B9E Run\u3001\u5FEB\u7167\u6458\u8981\u548C\u5206\u955C");
  const scenes2 = new Map(input.scenes.map((scene) => [scene.sceneId, scene]));
  requireValue(scenes2.size === input.scenes.length, "\u5206\u955C ID \u4E0D\u5F97\u91CD\u590D");
  for (const scene of input.scenes) requireValue(scene.sceneId && Number.isInteger(scene.fromFrame) && Number.isInteger(scene.toFrame) && scene.fromFrame >= 0 && scene.toFrame > scene.fromFrame, "\u5206\u955C\u5E27\u8303\u56F4\u65E0\u6548");
  const orderedScenes = [...input.scenes].sort((a, b) => a.fromFrame - b.fromFrame);
  requireValue(orderedScenes.every((scene, index) => index === 0 || scene.fromFrame >= orderedScenes[index - 1].toFrame), "\u5206\u955C\u5168\u5C40\u5E27\u8303\u56F4\u4E0D\u5F97\u91CD\u53E0");
  requireValue(input.readyFrames.every((frame2) => frame2.sourceDigest === input.sourceDigest && Number.isInteger(frame2.frame) && frame2.frame >= 0), "\u9759\u5E27\u5FC5\u987B\u6765\u81EA\u540C\u4E00\u5DF2\u51BB\u7ED3\u5FEB\u7167");
  const groups = input.chapters?.length ? input.chapters.map((chapter) => ({ unitId: `chapter-${chapter.chapterId}`, sceneIds: chapter.sceneIds })) : input.scenes.map((scene) => ({ unitId: `scene-${scene.sceneId}`, sceneIds: [scene.sceneId] }));
  const grouped = groups.flatMap((group) => group.sceneIds);
  requireValue(grouped.length === scenes2.size && new Set(grouped).size === scenes2.size && grouped.every((id) => scenes2.has(id)), "\u4E3B\u9898\u5FC5\u987B\u5B8C\u6574\u4E14\u552F\u4E00\u8986\u76D6\u786E\u8BA4\u5206\u955C");
  requireValue(new Set(groups.map((group) => group.unitId)).size === groups.length, "\u5BA1\u67E5\u5355\u5143 ID \u4E0D\u5F97\u91CD\u590D");
  const units = groups.map((group) => {
    requireValue(group.sceneIds.length, "\u4E3B\u9898\u4E0D\u5F97\u4E3A\u7A7A");
    const selected = group.sceneIds.map((id) => scenes2.get(id)).sort((a, b) => a.fromFrame - b.fromFrame);
    const firstIndex = orderedScenes.indexOf(selected[0]);
    requireValue(selected.every((scene, index) => orderedScenes[firstIndex + index] === scene), "\u540C\u4E00\u4E3B\u9898\u5FC5\u987B\u7531\u8FDE\u7EED\u5206\u955C\u7EC4\u6210");
    const reviewFrames = [...new Set(input.readyFrames.filter(({ frame: frame2 }) => selected.some((scene) => frame2 >= scene.fromFrame && frame2 < scene.toFrame)).map(({ frame: frame2 }) => frame2))];
    return { ...group, sceneIds: selected.map((scene) => scene.sceneId), lastMeaningfulProgressAt: null, reviewedAudio: false, unobservedRanges: [{ fromFrame: selected[0].fromFrame, toFrame: selected.at(-1).toFrame }], fromFrame: Math.min(...selected.map((scene) => scene.fromFrame)), toFrame: Math.max(...selected.map((scene) => scene.toFrame)), reviewFrames, observedFrames: [], status: "pending", assignedAgentId: null, assignmentId: null, attempt: 0 };
  });
  units.sort((a, b) => a.fromFrame - b.fromFrame);
  return { schemaVersion: 1, runId: input.runId, sourceDigest: input.sourceDigest, scenes: structuredClone(orderedScenes), units, results: [], history: [] };
}
function assignReviewUnit(plan, unitId, agentId, assignmentId) {
  const unit = plan.units.find((item) => item.unitId === unitId);
  requireValue(unit && unit.status === "pending", "\u53EA\u80FD\u9886\u53D6\u5F85\u5BA1\u5355\u5143");
  requireValue(unit.reviewFrames.length, "\u6B64\u5355\u5143\u5C1A\u65E0\u672C\u7248\u9759\u5E27\uFF0C\u987B\u8865\u53D6\u8BC1\u636E\u540E\u518D\u5206\u6D3E");
  requireValue(agentId && assignmentId, "\u9700\u8981\u5BBF\u4E3B\u771F\u5B9E\u4EE3\u7406\u53CA\u5F53\u524D\u5206\u6D3E\u6807\u8BC6");
  requireValue(!plan.units.some((item) => item.status === "assigned" && item.assignedAgentId === agentId), "\u540C\u4E00\u5BA1\u7247\u4EE3\u7406\u5E94\u5148\u5B8C\u6210\u5F53\u524D\u5355\u5143");
  requireValue(!plan.units.some((item) => item.assignmentId === assignmentId) && !plan.history.some((item) => item.assignmentId === assignmentId), "\u5206\u6D3E\u6807\u8BC6\u4E0D\u5F97\u91CD\u590D");
  Object.assign(unit, { status: "assigned", assignedAgentId: agentId, assignmentId, attempt: unit.attempt + 1 });
}
function acceptReviewResult(plan, result, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const unit = plan.units.find((item) => item.unitId === result.unitId);
  if (!unit || unit.status !== "assigned" || result.sourceDigest !== plan.sourceDigest || result.assignmentId !== unit.assignmentId || result.reviewerAgentId !== unit.assignedAgentId) return false;
  requireValue(result.observedFrames.every((frame2) => unit.reviewFrames.includes(frame2)), "\u89C2\u5BDF\u5E27\u5FC5\u987B\u5C5E\u4E8E\u5DF2\u5206\u914D\u8BC1\u636E");
  requireValue(result.observations.every((issue) => unit.sceneIds.includes(issue.sceneId) && plan.scenes.some((scene) => scene.sceneId === issue.sceneId && issue.frame >= scene.fromFrame && issue.frame < scene.toFrame) && result.observedFrames.includes(issue.frame) && issue.category && issue.evidence && issue.problem && issue.expected), "\u95EE\u9898\u5FC5\u987B\u5E26\u5B9E\u9645\u89C2\u5BDF\u5E27\u3001\u5206\u955C\u548C\u8BC1\u636E");
  requireValue(result.reviewedAudio === void 0 || result.reviewedAudio === false, "\u9759\u5E27\u5BA1\u67E5\u4E0D\u80FD\u58F0\u660E\u5DF2\u542C\u5BA1");
  if (plan.evidenceFrames) requireValue(result.observations.every((issue) => plan.evidenceFrames.some((frame2) => frame2.frame === issue.frame && issue.evidence === `${frame2.path}#${frame2.sha256}`)), "\u95EE\u9898\u8BC1\u636E\u5FC5\u987B\u7ED1\u5B9A\u539F\u4F5C\u4E1A\u767B\u8BB0\u7684\u56FE\u7247\u8DEF\u5F84\u4E0E\u6458\u8981");
  const observed = [.../* @__PURE__ */ new Set([...unit.observedFrames, ...result.observedFrames])];
  requireValue(result.status !== "completed" || unit.reviewFrames.every((frame2) => observed.includes(frame2)), "\u672A\u89C2\u5BDF\u5B8C\u5206\u914D\u8303\u56F4\u4E0D\u5F97\u6807\u8BB0\u5B8C\u6210");
  const previousIssues = new Set(plan.results.filter((item) => item.unitId === unit.unitId).flatMap((item) => item.observations.map((issue) => JSON.stringify(issue))));
  if (observed.length > unit.observedFrames.length || result.observations.some((issue) => !previousIssues.has(JSON.stringify(issue)))) unit.lastMeaningfulProgressAt = now;
  unit.observedFrames = observed;
  unit.status = result.status === "completed" ? "completed" : "assigned";
  plan.results.push(structuredClone({ ...result, reviewedAudio: false, unobservedRanges: unit.unobservedRanges }));
  return true;
}
function releaseReviewAssignment(plan, unitId, reason) {
  const unit = plan.units.find((item) => item.unitId === unitId);
  requireValue(unit && unit.status === "assigned" && reason.trim(), "\u53EA\u6709\u672A\u5B8C\u6210\u5206\u6D3E\u53EF\u4EE5\u6309\u5B9E\u9645\u539F\u56E0\u63A5\u7BA1");
  plan.history.push({ unitId, assignmentId: unit.assignmentId, agentId: unit.assignedAgentId, reason });
  Object.assign(unit, { status: "pending", assignedAgentId: null, assignmentId: null });
  return unit.reviewFrames.filter((frame2) => !unit.observedFrames.includes(frame2));
}
function affectedReviewUnits(plan, change) {
  requireValue(change.sceneIds.every((id) => plan.units.some((unit) => unit.sceneIds.includes(id))), "\u53D8\u66F4\u5F15\u7528\u4E86\u672A\u77E5\u5206\u955C");
  if (change.sharedComponent || change.subtitles || change.globalTimeline || change.templatePackaging) return plan.units.map((unit) => unit.unitId);
  const indices = /* @__PURE__ */ new Set();
  plan.units.forEach((unit, index) => {
    if (unit.sceneIds.some((id) => change.sceneIds.includes(id))) {
      for (const neighbor of [index - 1, index, index + 1]) if (plan.units[neighbor]) indices.add(neighbor);
    }
  });
  return plan.units.filter((_, index) => indices.has(index)).map((unit) => unit.unitId);
}
function mergeReviewIssues(plan) {
  const issues = /* @__PURE__ */ new Map();
  const rank = { suggestion: 0, warning: 1, blocking: 2 };
  for (const result of plan.results) for (const issue of result.observations) {
    const key = JSON.stringify([result.sourceDigest, issue.sceneId, issue.frame, issue.category]);
    const previous = issues.get(key);
    if (!previous || rank[issue.severity] > rank[previous.severity]) issues.set(key, issue);
  }
  return [...issues.values()];
}
async function writeReviewRecord(runRoot, name, content) {
  const directory = (0, import_node_path.join)(runRoot, "qa");
  await import_node_fs.promises.mkdir(directory, { recursive: true });
  if (!/^[a-z-]+\.(json|jsonl)$/.test(name)) throw new Error("QA \u8BB0\u5F55\u6587\u4EF6\u540D\u65E0\u6548");
  if (await import_node_fs.promises.realpath(directory) !== (0, import_node_path.join)(await import_node_fs.promises.realpath(runRoot), "qa")) throw new Error("qa \u76EE\u5F55\u4E0D\u5F97\u6307\u5411\u5916\u90E8\u94FE\u63A5");
  const path = (0, import_node_path.join)(directory, name);
  const temporary = (0, import_node_path.join)(directory, `review-plan.${(0, import_node_crypto.randomUUID)()}.tmp`);
  try {
    await import_node_fs.promises.writeFile(temporary, content);
    await import_node_fs.promises.rename(temporary, path);
  } finally {
    await import_node_fs.promises.rm(temporary, { force: true });
  }
  return path;
}
function saveReviewPlan(runRoot, plan) {
  return writeReviewRecord(runRoot, "review-plan.json", JSON.stringify(plan, null, 2));
}

// packages/production-service/src/files.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// packages/production-service/src/contracts.ts
var import_node_crypto2 = require("node:crypto");
var import_zod = require("zod");
var ProductionError = class extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
  code;
  statusCode;
};
var text = import_zod.z.string().max(1e5).refine((v) => v.trim().length > 0, "\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
var sceneId = import_zod.z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).refine((v) => v !== "whole-video", "\u6574\u7247 ID \u4E0D\u53EF\u7528\u4E8E\u5206\u955C");
var sceneSchema = import_zod.z.object({ id: sceneId, content: text }).strict();
var scenes = import_zod.z.array(sceneSchema).min(1).max(200).refine((v) => new Set(v.map((s) => s.id)).size === v.length, "\u5206\u955C ID \u91CD\u590D");
var common = { taskId: import_zod.z.string().min(1).max(200), otherRequirements: import_zod.z.string().max(2e4) };
var analysisRequestSchema = import_zod.z.object({ ...common, content: text, plugin: import_zod.z.object({ customTemplateId: import_zod.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict() }).strict();
var renderRequestSchema = import_zod.z.object({
  ...common,
  basePlanVersion: import_zod.z.number().int().positive(),
  dataList: scenes,
  baseRenderRunId: import_zod.z.string().uuid().optional(),
  revisionInstructions: text.optional()
}).strict().refine((v) => Boolean(v.baseRenderRunId) === Boolean(v.revisionInstructions), "\u57FA\u7840\u6210\u7247\u548C\u4FEE\u6539\u8BF4\u660E\u5FC5\u987B\u540C\u65F6\u63D0\u4F9B");
var sha256 = (value) => (0, import_node_crypto2.createHash)("sha256").update(value).digest("hex");
var analysisResultSchema = import_zod.z.object({
  taskId: import_zod.z.string(),
  runId: import_zod.z.string().uuid(),
  inputDigest: import_zod.z.string(),
  dataList: import_zod.z.array(sceneSchema.extend({ dur: import_zod.z.number().positive(), durationSource: import_zod.z.literal("estimated") })).min(1),
  context: import_zod.z.string().min(1).refine((value) => value.trim().length > 0, "context \u5FC5\u987B\u662F\u975E\u7A7A Markdown \u5B57\u7B26\u4E32")
}).strict();
var sceneCutMetadataSchema = import_zod.z.object({
  cutMode: import_zod.z.enum(["accurate", "stream_copy", "local_transcode"]),
  requestedStartSec: import_zod.z.number().finite().nonnegative(),
  requestedEndSec: import_zod.z.number().finite().positive(),
  measuredDurationSec: import_zod.z.number().finite().positive(),
  startDeviationMs: import_zod.z.number().finite(),
  endDeviationMs: import_zod.z.number().finite(),
  mediaValidationVersion: import_zod.z.literal("scene-cut-v1"),
  fallbackReason: import_zod.z.string().max(8e3).optional(),
  boundaryValidation: import_zod.z.enum(["packet-pts-and-decoded-boundaries", "decoded-boundaries", "accurate-frame-trim"]),
  videoToleranceMs: import_zod.z.number().finite().nonnegative(),
  audioToleranceMs: import_zod.z.number().finite().nonnegative()
}).strict();
var deliverySchema = import_zod.z.object({
  taskId: import_zod.z.string(),
  runId: import_zod.z.string().uuid(),
  inputDigest: import_zod.z.string(),
  templateDigest: import_zod.z.string(),
  renderRequestId: import_zod.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  sourceDigest: import_zod.z.string(),
  timelineRef: import_zod.z.string(),
  checks: import_zod.z.array(import_zod.z.string()),
  files: import_zod.z.array(import_zod.z.object({
    id: import_zod.z.string(),
    content: import_zod.z.string(),
    file: import_zod.z.string(),
    sha256: import_zod.z.string(),
    dur: import_zod.z.number().positive(),
    fromFrame: import_zod.z.number().int().nonnegative(),
    toFrame: import_zod.z.number().int().positive(),
    width: import_zod.z.number().int().positive(),
    height: import_zod.z.number().int().positive(),
    fps: import_zod.z.number().positive(),
    cutMetadata: sceneCutMetadataSchema.optional()
  }).strict()).min(2)
}).strict();

// packages/production-service/src/files.ts
function inside(root, name) {
  const p = (0, import_node_path2.resolve)(root, name), r = (0, import_node_path2.relative)((0, import_node_path2.resolve)(root), p);
  if (r.startsWith("..") || (0, import_node_path2.isAbsolute)(r)) throw new ProductionError("PATH_OUTSIDE_ROOT", "\u8DEF\u5F84\u8D8A\u754C");
  return p;
}
async function regular(root, name) {
  const p = inside(root, name);
  const real = await import_node_fs2.promises.realpath(p);
  inside(await import_node_fs2.promises.realpath(root), real);
  if (!(await import_node_fs2.promises.lstat(p)).isFile()) throw new ProductionError("FILE_INVALID", `\u4E0D\u662F\u666E\u901A\u6587\u4EF6\uFF1A${name}`);
  return p;
}

// packages/production-service/src/preview-policy.ts
function decideDynamicPreview(input) {
  if (!input.onDemand) return "legacy";
  const request = input.request;
  if (!request || !request.needsVideo && !request.needsAudio) return "not_needed";
  if (!request.sourceDigest || !request.question.trim() || !request.consumer.trim() || !request.passCriteria.trim() || !Number.isInteger(request.fromFrame) || !Number.isInteger(request.toFrame) || request.fromFrame < 0 || request.toFrame <= request.fromFrame) throw new Error("\u52A8\u6001\u68C0\u67E5\u9700\u8981\u660E\u786E\u5FEB\u7167\u3001\u8303\u56F4\u3001\u95EE\u9898\u3001\u68C0\u67E5\u8005\u4E0E\u901A\u8FC7\u6807\u51C6");
  if (request.needsVideo && !request.continuousVideoAvailable || request.needsAudio && !request.continuousAudioAvailable) return "professional_review_pending";
  if (input.verifiedWholeVideo?.sourceDigest === request.sourceDigest && input.verifiedWholeVideo.fileRef) return "reuse_whole_video";
  return "request_preview";
}

// packages/production-service/src/review-cli.ts
var text2 = import_zod2.z.string().trim().min(1);
var frame = import_zod2.z.number().int().nonnegative();
var observation = import_zod2.z.object({ sceneId: text2, frame, category: text2, severity: import_zod2.z.enum(["blocking", "warning", "suggestion"]), evidence: text2, problem: text2, expected: text2 }).strict();
var requestSchema = import_zod2.z.discriminatedUnion("operation", [
  import_zod2.z.object({ operation: import_zod2.z.literal("initialize"), renderRequestIds: import_zod2.z.array(import_zod2.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1), input: import_zod2.z.object({ runId: text2, sourceDigest: text2, scenes: import_zod2.z.array(import_zod2.z.object({ sceneId: text2, fromFrame: frame, toFrame: frame }).strict()).min(1), chapters: import_zod2.z.array(import_zod2.z.object({ chapterId: text2, sceneIds: import_zod2.z.array(text2).min(1) }).strict()).optional(), readyFrames: import_zod2.z.array(import_zod2.z.object({ frame, sourceDigest: text2 }).strict()).min(1) }).strict() }).strict(),
  import_zod2.z.object({ operation: import_zod2.z.literal("add_frames"), renderRequestIds: import_zod2.z.array(import_zod2.z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1), readyFrames: import_zod2.z.array(import_zod2.z.object({ frame, sourceDigest: text2 }).strict()).min(1) }).strict(),
  import_zod2.z.object({ operation: import_zod2.z.literal("assign"), unitId: text2, agentId: text2, assignmentId: text2 }).strict(),
  import_zod2.z.object({ operation: import_zod2.z.literal("result"), result: import_zod2.z.object({ unitId: text2, sourceDigest: text2, assignmentId: text2, reviewerAgentId: text2, status: import_zod2.z.enum(["partial", "completed"]), observedFrames: import_zod2.z.array(frame), observations: import_zod2.z.array(observation), reviewedAudio: import_zod2.z.literal(false).optional(), unobservedRanges: import_zod2.z.array(import_zod2.z.object({ fromFrame: frame, toFrame: frame }).strict()).optional() }).strict() }).strict(),
  import_zod2.z.object({ operation: import_zod2.z.literal("takeover"), unitId: text2, reason: text2 }).strict(),
  import_zod2.z.object({ operation: import_zod2.z.literal("affected"), change: import_zod2.z.object({ sceneIds: import_zod2.z.array(text2), sharedComponent: import_zod2.z.boolean().optional(), subtitles: import_zod2.z.boolean().optional(), globalTimeline: import_zod2.z.boolean().optional(), templatePackaging: import_zod2.z.boolean().optional() }).strict() }).strict(),
  import_zod2.z.object({ operation: import_zod2.z.literal("preview"), input: import_zod2.z.object({ onDemand: import_zod2.z.boolean(), request: import_zod2.z.object({ sourceDigest: text2, question: text2, fromFrame: frame, toFrame: frame, consumer: text2, passCriteria: text2, needsVideo: import_zod2.z.boolean(), needsAudio: import_zod2.z.boolean(), continuousVideoAvailable: import_zod2.z.boolean(), continuousAudioAvailable: import_zod2.z.boolean() }).strict().optional(), verifiedWholeVideo: import_zod2.z.object({ sourceDigest: text2, fileRef: text2 }).strict().optional() }).strict() }).strict()
]);
async function verifiedReviewFrames(root, plan, renderRequestIds, readyFrames) {
  if (readyFrames.some((frame2) => frame2.sourceDigest !== plan.sourceDigest)) throw new Error("\u8865\u5E27\u5FC5\u987B\u6765\u81EA\u5F53\u524D\u51BB\u7ED3\u6458\u8981");
  const evidenceFrames = [];
  for (const id of renderRequestIds) {
    const job = JSON.parse(await import_node_fs3.promises.readFile(await regular(root, (0, import_node_path3.join)("render-jobs", `${id}.json`)), "utf8"));
    if (job.id !== id || job.runId !== plan.runId || job.kind !== "frame-preview" || job.sourceDigest !== plan.sourceDigest || !Array.isArray(job.readyFrames)) throw new Error("\u539F\u9759\u5E27\u4F5C\u4E1A\u4E0E\u5F53\u524D Run \u6216\u51BB\u7ED3\u6458\u8981\u4E0D\u4E00\u81F4");
    for (const item of job.readyFrames) {
      if (!readyFrames.some((frame2) => frame2.frame === item.frame)) continue;
      if (!(await import_node_fs3.promises.lstat(item.path)).isFile()) throw new Error("\u9759\u5E27\u5FC5\u987B\u662F\u666E\u901A\u6587\u4EF6");
      const path = await regular(root, await import_node_fs3.promises.realpath(item.path));
      if (sha256(await import_node_fs3.promises.readFile(path)) !== item.sha256) throw new Error("\u539F\u4F5C\u4E1A\u9759\u5E27\u6587\u4EF6\u6458\u8981\u4E0D\u4E00\u81F4");
      const previous = evidenceFrames.find((frame2) => frame2.frame === item.frame);
      if (previous && (previous.path !== path || previous.sha256 !== item.sha256)) throw new Error("\u76F8\u540C\u5E27\u7684\u8BC1\u636E\u8EAB\u4EFD\u4E0D\u540C");
      if (!previous) evidenceFrames.push({ frame: item.frame, path, sha256: item.sha256 });
    }
  }
  if (readyFrames.some((frame2) => !evidenceFrames.some((item) => item.frame === frame2.frame))) throw new Error("\u8BF7\u6C42\u9759\u5E27\u5C1A\u672A\u7531\u539F\u4F5C\u4E1A\u767B\u8BB0 readyFrames");
  return evidenceFrames;
}
async function executeReviewCommand(runRoot, requestFile) {
  if ((0, import_node_path3.basename)(requestFile) !== requestFile || !requestFile.endsWith(".json")) throw new Error("\u8BF7\u6C42\u6587\u4EF6\u5FC5\u987B\u662F qa \u76EE\u5F55\u5185 JSON \u6587\u4EF6\u540D");
  const root = await import_node_fs3.promises.realpath(runRoot);
  const directory = (0, import_node_path3.join)(root, "qa");
  if (await import_node_fs3.promises.realpath(directory) !== (0, import_node_path3.resolve)(directory)) throw new Error("qa \u76EE\u5F55\u4E0D\u5F97\u901A\u8FC7\u94FE\u63A5\u6307\u5411\u5176\u4ED6\u4F4D\u7F6E");
  const requestPath = await regular(directory, requestFile);
  const readRecord = async (name) => import_node_fs3.promises.readFile(await regular(directory, name), "utf8");
  const readOptional = async (name) => readRecord(name).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const appendRecord = async (name, value) => writeReviewRecord(root, name, (await readOptional(name) ?? "") + JSON.stringify(value) + "\n");
  const request = requestSchema.parse(JSON.parse(await import_node_fs3.promises.readFile(requestPath, "utf8")));
  if (request.operation === "preview") {
    const decision = decideDynamicPreview(request.input);
    await writeReviewRecord(root, "preview-decision.json", JSON.stringify({ ...request.input, decision }, null, 2));
    return { decision, professionalReviewCompleted: false };
  }
  if (request.operation === "initialize") {
    const plan2 = createReviewPlan(request.input);
    const evidenceFrames = await verifiedReviewFrames(root, plan2, request.renderRequestIds, request.input.readyFrames);
    plan2.evidenceFrames = evidenceFrames;
    const previous = await readOptional("review-plan.json");
    if (previous) {
      const old = JSON.parse(previous);
      if (old.sourceDigest === plan2.sourceDigest) throw new Error("\u540C\u7248\u8BA1\u5212\u5DF2\u5B58\u5728\uFF0C\u8BF7\u7EED\u63A5\u539F\u8BA1\u5212\uFF0C\u4E0D\u5F97\u6E05\u7A7A\u5BA1\u67E5\u8FDB\u5EA6");
      await appendRecord("review-history.jsonl", old);
    }
    const path2 = await saveReviewPlan(root, plan2);
    await writeReviewRecord(root, "issue-ledger.json", JSON.stringify({ sourceDigest: plan2.sourceDigest, issues: [] }, null, 2));
    return { path: path2, units: plan2.units, evidenceFrames };
  }
  const plan = JSON.parse(await readRecord("review-plan.json"));
  if (request.operation === "add_frames") {
    const incoming = await verifiedReviewFrames(root, plan, request.renderRequestIds, request.readyFrames);
    const existing = plan.evidenceFrames ?? [];
    for (const frame2 of incoming) {
      const previous = existing.find((item) => item.frame === frame2.frame);
      if (previous && (previous.path !== frame2.path || previous.sha256 !== frame2.sha256)) throw new Error("\u76F8\u540C\u5E27\u7684\u8BC1\u636E\u8EAB\u4EFD\u4E0D\u540C");
      const scene = plan.scenes.find((item) => frame2.frame >= item.fromFrame && frame2.frame < item.toFrame);
      if (!scene || !plan.units.some((unit) => unit.sceneIds.includes(scene.sceneId))) throw new Error("\u8865\u5E27\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5BA1\u67E5\u5206\u955C\u8303\u56F4");
    }
    const addedFrames = [];
    for (const frame2 of incoming) {
      if (!existing.some((item) => item.frame === frame2.frame)) existing.push(frame2);
      const scene = plan.scenes.find((item) => frame2.frame >= item.fromFrame && frame2.frame < item.toFrame);
      const unit = plan.units.find((item) => item.sceneIds.includes(scene.sceneId));
      if (unit.reviewFrames.includes(frame2.frame)) continue;
      unit.reviewFrames.push(frame2.frame);
      unit.reviewFrames.sort((a, b) => a - b);
      addedFrames.push(frame2.frame);
      if (unit.status === "completed" && !unit.observedFrames.includes(frame2.frame)) {
        plan.history.push({ unitId: unit.unitId, assignmentId: unit.assignmentId, agentId: unit.assignedAgentId, reason: "\u8865\u5145\u540C\u7248\u9759\u5E27\uFF0C\u9700\u7EE7\u7EED\u5BA1\u67E5\u65B0\u589E\u8303\u56F4" });
        Object.assign(unit, { status: "pending", assignedAgentId: null, assignmentId: null });
      }
    }
    plan.evidenceFrames = existing;
    return { path: await saveReviewPlan(root, plan), addedFrames, evidenceFrames: incoming };
  }
  if (request.operation === "affected") return { unitIds: affectedReviewUnits(plan, request.change), sourceDigest: plan.sourceDigest };
  if (request.operation === "assign") assignReviewUnit(plan, request.unitId, request.agentId, request.assignmentId);
  if (request.operation === "result") {
    if (!acceptReviewResult(plan, request.result)) {
      await appendRecord("late-results.jsonl", request.result);
      return { accepted: false, reason: "\u7248\u672C\u3001\u5F53\u524D\u8D1F\u8D23\u4EBA\u6216\u5206\u6D3E\u4EE3\u6B21\u4E0D\u7B26\uFF0C\u4EC5\u4FDD\u5B58\u5386\u53F2" };
    }
  }
  const remainingFrames = request.operation === "takeover" ? releaseReviewAssignment(plan, request.unitId, request.reason) : void 0;
  const path = await saveReviewPlan(root, plan);
  if (request.operation === "result") await writeReviewRecord(root, "issue-ledger.json", JSON.stringify({ sourceDigest: plan.sourceDigest, issues: mergeReviewIssues(plan) }, null, 2));
  return { path, accepted: true, remainingFrames };
}
if (/[/\\]review(?:-cli\.ts|\.cjs)$/.test(process.argv[1] ?? "")) {
  const [runRoot, requestFile] = process.argv.slice(2);
  if (!runRoot || !requestFile) {
    process.stderr.write("\u7528\u6CD5\uFF1Anode review.cjs <runRoot> <qa\u5185\u8BF7\u6C42JSON\u6587\u4EF6\u540D>\n");
    process.exitCode = 1;
  } else executeReviewCommand(runRoot, requestFile).then((result) => process.stdout.write(JSON.stringify(result) + "\n")).catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  executeReviewCommand
});
//# sourceMappingURL=review.cjs.map
