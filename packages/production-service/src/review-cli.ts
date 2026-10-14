import { promises as fs } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { z } from 'zod';
import { acceptReviewResult, affectedReviewUnits, assignReviewUnit, createReviewPlan, releaseReviewAssignment, saveReviewPlan, writeReviewRecord, mergeReviewIssues, type ReviewPlan } from './review-policy.js';
import { regular } from './files.js';
import { sha256 } from './contracts.js';
import { decideDynamicPreview } from './preview-policy.js';

const text = z.string().trim().min(1);
const frame = z.number().int().nonnegative();
const observation = z.object({ sceneId: text, frame, category: text, severity: z.enum(['blocking', 'warning', 'suggestion']), evidence: text, problem: text, expected: text }).strict();
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('initialize'), renderRequestIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1), input: z.object({ runId: text, sourceDigest: text, scenes: z.array(z.object({ sceneId: text, fromFrame: frame, toFrame: frame }).strict()).min(1), chapters: z.array(z.object({ chapterId: text, sceneIds: z.array(text).min(1) }).strict()).optional(), readyFrames: z.array(z.object({ frame, sourceDigest: text }).strict()).min(1) }).strict() }).strict(),
  z.object({ operation: z.literal('add_frames'), renderRequestIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).min(1), readyFrames: z.array(z.object({ frame, sourceDigest: text }).strict()).min(1) }).strict(),
  z.object({ operation: z.literal('assign'), unitId: text, agentId: text, assignmentId: text }).strict(),
  z.object({ operation: z.literal('result'), result: z.object({ unitId: text, sourceDigest: text, assignmentId: text, reviewerAgentId: text, status: z.enum(['partial', 'completed']), observedFrames: z.array(frame), observations: z.array(observation), reviewedAudio: z.literal(false).optional(), unobservedRanges: z.array(z.object({ fromFrame: frame, toFrame: frame }).strict()).optional() }).strict() }).strict(),
  z.object({ operation: z.literal('takeover'), unitId: text, reason: text }).strict(),
  z.object({ operation: z.literal('affected'), change: z.object({ sceneIds: z.array(text), sharedComponent: z.boolean().optional(), subtitles: z.boolean().optional(), globalTimeline: z.boolean().optional(), templatePackaging: z.boolean().optional() }).strict() }).strict(),
  z.object({ operation: z.literal('preview'), input: z.object({ onDemand: z.boolean(), request: z.object({ sourceDigest: text, question: text, fromFrame: frame, toFrame: frame, consumer: text, passCriteria: text, needsVideo: z.boolean(), needsAudio: z.boolean(), continuousVideoAvailable: z.boolean(), continuousAudioAvailable: z.boolean() }).strict().optional(), verifiedWholeVideo: z.object({ sourceDigest: text, fileRef: text }).strict().optional() }).strict() }).strict(),
]);

async function verifiedReviewFrames(root: string, plan: Pick<ReviewPlan, 'runId' | 'sourceDigest'>, renderRequestIds: string[], readyFrames: Array<{ frame: number; sourceDigest: string }>) {
  if (readyFrames.some(frame => frame.sourceDigest !== plan.sourceDigest)) throw new Error('补帧必须来自当前冻结摘要');
  const evidenceFrames: Array<{ frame: number; path: string; sha256: string }> = [];
  for (const id of renderRequestIds) {
    const job = JSON.parse(await fs.readFile(await regular(root, join('render-jobs', `${id}.json`)), 'utf8'));
    if (job.id !== id || job.runId !== plan.runId || job.kind !== 'frame-preview' || job.sourceDigest !== plan.sourceDigest || !Array.isArray(job.readyFrames)) throw new Error('原静帧作业与当前 Run 或冻结摘要不一致');
    for (const item of job.readyFrames) {
      if (!readyFrames.some(frame => frame.frame === item.frame)) continue;
      if (!(await fs.lstat(item.path)).isFile()) throw new Error('静帧必须是普通文件');
      const path = await regular(root, await fs.realpath(item.path));
      if (sha256(await fs.readFile(path)) !== item.sha256) throw new Error('原作业静帧文件摘要不一致');
      const previous = evidenceFrames.find(frame => frame.frame === item.frame);
      if (previous && (previous.path !== path || previous.sha256 !== item.sha256)) throw new Error('相同帧的证据身份不同');
      if (!previous) evidenceFrames.push({ frame: item.frame, path, sha256: item.sha256 });
    }
  }
  if (readyFrames.some(frame => !evidenceFrames.some(item => item.frame === frame.frame))) throw new Error('请求静帧尚未由原作业登记 readyFrames');
  return evidenceFrames;
}

/** 本地 QA 辅助只更新任务旁路记录；不具备渲染、配音、发布或代理创建能力。 */
export async function executeReviewCommand(runRoot: string, requestFile: string): Promise<unknown> {
  if (basename(requestFile) !== requestFile || !requestFile.endsWith('.json')) throw new Error('请求文件必须是 qa 目录内 JSON 文件名');
  const root = await fs.realpath(runRoot);
  const directory = join(root, 'qa');
  if (await fs.realpath(directory) !== resolve(directory)) throw new Error('qa 目录不得通过链接指向其他位置');
  const requestPath = await regular(directory, requestFile);
  const readRecord = async (name: string) => fs.readFile(await regular(directory, name), 'utf8');
  const readOptional = async (name: string) => readRecord(name).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  const appendRecord = async (name: string, value: unknown) => writeReviewRecord(root, name, (await readOptional(name) ?? '') + JSON.stringify(value) + '\n');
  const request = requestSchema.parse(JSON.parse(await fs.readFile(requestPath, 'utf8')));
  if (request.operation === 'preview') {
    const decision = decideDynamicPreview(request.input);
    await writeReviewRecord(root, 'preview-decision.json', JSON.stringify({ ...request.input, decision }, null, 2));
    return { decision, professionalReviewCompleted: false };
  }
  if (request.operation === 'initialize') {
    const plan = createReviewPlan(request.input);
    const evidenceFrames = await verifiedReviewFrames(root, plan, request.renderRequestIds, request.input.readyFrames);
    plan.evidenceFrames = evidenceFrames;
    // 同版重放不抹去进度；新版先保留原计划用于追溯，再建立待审记录。
    const previous = await readOptional('review-plan.json');
    if (previous) {
      const old = JSON.parse(previous) as ReviewPlan;
      if (old.sourceDigest === plan.sourceDigest) throw new Error('同版计划已存在，请续接原计划，不得清空审查进度');
      await appendRecord('review-history.jsonl', old);
    }
    const path = await saveReviewPlan(root, plan);
    await writeReviewRecord(root, 'issue-ledger.json', JSON.stringify({ sourceDigest: plan.sourceDigest, issues: [] }, null, 2));
    return { path, units: plan.units, evidenceFrames };
  }
  const plan = JSON.parse(await readRecord('review-plan.json')) as ReviewPlan;
  if (request.operation === 'add_frames') {
    const incoming = await verifiedReviewFrames(root, plan, request.renderRequestIds, request.readyFrames);
    const existing = plan.evidenceFrames ?? [];
    for (const frame of incoming) {
      const previous = existing.find(item => item.frame === frame.frame);
      if (previous && (previous.path !== frame.path || previous.sha256 !== frame.sha256)) throw new Error('相同帧的证据身份不同');
      const scene = plan.scenes.find(item => frame.frame >= item.fromFrame && frame.frame < item.toFrame);
      if (!scene || !plan.units.some(unit => unit.sceneIds.includes(scene.sceneId))) throw new Error('补帧不属于当前审查分镜范围');
    }
    const addedFrames: number[] = [];
    for (const frame of incoming) {
      if (!existing.some(item => item.frame === frame.frame)) existing.push(frame);
      const scene = plan.scenes.find(item => frame.frame >= item.fromFrame && frame.frame < item.toFrame)!;
      const unit = plan.units.find(item => item.sceneIds.includes(scene.sceneId))!;
      if (unit.reviewFrames.includes(frame.frame)) continue;
      unit.reviewFrames.push(frame.frame);
      unit.reviewFrames.sort((a, b) => a - b);
      addedFrames.push(frame.frame);
      // 新证据只重开受影响的完成项，保留观察与问题；旧分派随即失效。
      if (unit.status === 'completed' && !unit.observedFrames.includes(frame.frame)) {
        plan.history.push({ unitId: unit.unitId, assignmentId: unit.assignmentId!, agentId: unit.assignedAgentId!, reason: '补充同版静帧，需继续审查新增范围' });
        Object.assign(unit, { status: 'pending', assignedAgentId: null, assignmentId: null });
      }
    }
    plan.evidenceFrames = existing;
    return { path: await saveReviewPlan(root, plan), addedFrames, evidenceFrames: incoming };
  }
  if (request.operation === 'affected') return { unitIds: affectedReviewUnits(plan, request.change), sourceDigest: plan.sourceDigest };
  if (request.operation === 'assign') assignReviewUnit(plan, request.unitId, request.agentId, request.assignmentId);
  if (request.operation === 'result') {
    if (!acceptReviewResult(plan, request.result)) {
      await appendRecord('late-results.jsonl', request.result);
      return { accepted: false, reason: '版本、当前负责人或分派代次不符，仅保存历史' };
    }
  }
  const remainingFrames = request.operation === 'takeover' ? releaseReviewAssignment(plan, request.unitId, request.reason) : undefined;
  const path = await saveReviewPlan(root, plan);
  if (request.operation === 'result') await writeReviewRecord(root, 'issue-ledger.json', JSON.stringify({ sourceDigest: plan.sourceDigest, issues: mergeReviewIssues(plan) }, null, 2));
  return { path, accepted: true, remainingFrames };
}

// 被打包为独立命令时执行；测试导入模块不启动命令。
if (/[/\\]review(?:-cli\.ts|\.cjs)$/.test(process.argv[1] ?? '')) {
  const [runRoot, requestFile] = process.argv.slice(2);
  if (!runRoot || !requestFile) { process.stderr.write('用法：node review.cjs <runRoot> <qa内请求JSON文件名>\n'); process.exitCode = 1; }
  else executeReviewCommand(runRoot, requestFile).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(String(error instanceof Error ? error.message : error) + '\n'); process.exitCode = 1; });
}
