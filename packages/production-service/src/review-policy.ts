import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ReviewPolicyConfig {
  qaParallelReview: boolean;
  qaMaxReviewers: number;
  previewOnDemand: boolean;
}
export const DEFAULT_REVIEW_POLICY: ReviewPolicyConfig = {
  qaParallelReview: true, qaMaxReviewers: 3, previewOnDemand: true,
};
export interface ReviewScene { sceneId: string; fromFrame: number; toFrame: number }
export interface ReviewUnit {
  unitId: string;
  sceneIds: string[];
  fromFrame: number;
  toFrame: number;
  reviewFrames: number[];
  observedFrames: number[];
  status: 'pending' | 'assigned' | 'completed';
  assignedAgentId: string | null;
  assignmentId: string | null;
  attempt: number;
  lastMeaningfulProgressAt: string | null;
  unobservedRanges: Array<{ fromFrame: number; toFrame: number }>;
  reviewedAudio: false;
}
export interface ReviewObservation {
  sceneId: string; frame: number; category: string;
  severity: 'blocking' | 'warning' | 'suggestion';
  evidence: string; problem: string; expected: string;
}
export interface ReviewResult {
  unitId: string; sourceDigest: string; assignmentId: string; reviewerAgentId: string;
  status: 'partial' | 'completed'; observedFrames: number[];
  observations: ReviewObservation[];
  unobservedRanges?: Array<{ fromFrame: number; toFrame: number }>;
  reviewedAudio?: false;
}
export interface ReviewPlan {
  schemaVersion: 1; runId: string; sourceDigest: string; scenes: ReviewScene[]; units: ReviewUnit[];
  evidenceFrames?: Array<{ frame: number; path: string; sha256: string }>;
  results: ReviewResult[];
  history: Array<{ unitId: string; assignmentId: string; agentId: string; reason: string }>;
}

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** 这里只维护只读审查记录；代理创建、真实观察与媒体提交仍由宿主和主任务执行。 */
export function createReviewPlan(input: {
  runId: string; sourceDigest: string; scenes: ReviewScene[];
  chapters?: Array<{ chapterId: string; sceneIds: string[] }>;
  readyFrames: Array<{ frame: number; sourceDigest: string }>;
}): ReviewPlan {
  requireValue(input.runId && input.sourceDigest && input.scenes.length, '审查需要真实 Run、快照摘要和分镜');
  const scenes = new Map(input.scenes.map(scene => [scene.sceneId, scene]));
  requireValue(scenes.size === input.scenes.length, '分镜 ID 不得重复');
  for (const scene of input.scenes) requireValue(scene.sceneId && Number.isInteger(scene.fromFrame) && Number.isInteger(scene.toFrame) && scene.fromFrame >= 0 && scene.toFrame > scene.fromFrame, '分镜帧范围无效');
  const orderedScenes = [...input.scenes].sort((a, b) => a.fromFrame - b.fromFrame);
  requireValue(orderedScenes.every((scene, index) => index === 0 || scene.fromFrame >= orderedScenes[index - 1].toFrame), '分镜全局帧范围不得重叠');
  requireValue(input.readyFrames.every(frame => frame.sourceDigest === input.sourceDigest && Number.isInteger(frame.frame) && frame.frame >= 0), '静帧必须来自同一已冻结快照');
  const groups = input.chapters?.length ? input.chapters.map(chapter => ({ unitId: `chapter-${chapter.chapterId}`, sceneIds: chapter.sceneIds })) : input.scenes.map(scene => ({ unitId: `scene-${scene.sceneId}`, sceneIds: [scene.sceneId] }));
  const grouped = groups.flatMap(group => group.sceneIds);
  requireValue(grouped.length === scenes.size && new Set(grouped).size === scenes.size && grouped.every(id => scenes.has(id)), '主题必须完整且唯一覆盖确认分镜');
  requireValue(new Set(groups.map(group => group.unitId)).size === groups.length, '审查单元 ID 不得重复');
  const units = groups.map(group => {
    requireValue(group.sceneIds.length, '主题不得为空');
    const selected = group.sceneIds.map(id => scenes.get(id)!).sort((a, b) => a.fromFrame - b.fromFrame);
    const firstIndex = orderedScenes.indexOf(selected[0]);
    requireValue(selected.every((scene, index) => orderedScenes[firstIndex + index] === scene), '同一主题必须由连续分镜组成');
    const reviewFrames = [...new Set(input.readyFrames.filter(({ frame }) => selected.some(scene => frame >= scene.fromFrame && frame < scene.toFrame)).map(({ frame }) => frame))];
    return { ...group, sceneIds: selected.map(scene => scene.sceneId), lastMeaningfulProgressAt: null, reviewedAudio: false as const, unobservedRanges: [{ fromFrame: selected[0].fromFrame, toFrame: selected.at(-1)!.toFrame }], fromFrame: Math.min(...selected.map(scene => scene.fromFrame)), toFrame: Math.max(...selected.map(scene => scene.toFrame)), reviewFrames, observedFrames: [], status: 'pending' as const, assignedAgentId: null, assignmentId: null, attempt: 0 };
  });
  units.sort((a, b) => a.fromFrame - b.fromFrame);
  return { schemaVersion: 1, runId: input.runId, sourceDigest: input.sourceDigest, scenes: structuredClone(orderedScenes), units, results: [], history: [] };
}

export function reviewerCapacity(config: ReviewPolicyConfig, availableSlots: number): number {
  requireValue(Number.isInteger(availableSlots) && availableSlots >= 0, '必须使用宿主实际剩余名额');
  requireValue(Number.isInteger(config.qaMaxReviewers) && config.qaMaxReviewers >= 1 && config.qaMaxReviewers <= 3, '审片上限必须为 1～3');
  return Math.min(availableSlots, config.qaParallelReview ? config.qaMaxReviewers : 1);
}

export function assignReviewUnit(plan: ReviewPlan, unitId: string, agentId: string, assignmentId: string): void {
  const unit = plan.units.find(item => item.unitId === unitId);
  requireValue(unit && unit.status === 'pending', '只能领取待审单元');
  requireValue(unit.reviewFrames.length, '此单元尚无本版静帧，须补取证据后再分派');
  requireValue(agentId && assignmentId, '需要宿主真实代理及当前分派标识');
  requireValue(!plan.units.some(item => item.status === 'assigned' && item.assignedAgentId === agentId), '同一审片代理应先完成当前单元');
  requireValue(!plan.units.some(item => item.assignmentId === assignmentId) && !plan.history.some(item => item.assignmentId === assignmentId), '分派标识不得重复');
  Object.assign(unit, { status: 'assigned', assignedAgentId: agentId, assignmentId, attempt: unit.attempt + 1 });
}

/** 迟到、跨版本或冒名结果只由调用方存档，不能更新当前完成状态。 */
export function acceptReviewResult(plan: ReviewPlan, result: ReviewResult, now = new Date().toISOString()): boolean {
  const unit = plan.units.find(item => item.unitId === result.unitId);
  if (!unit || unit.status !== 'assigned' || result.sourceDigest !== plan.sourceDigest || result.assignmentId !== unit.assignmentId || result.reviewerAgentId !== unit.assignedAgentId) return false;
  requireValue(result.observedFrames.every(frame => unit.reviewFrames.includes(frame)), '观察帧必须属于已分配证据');
  requireValue(result.observations.every(issue => unit.sceneIds.includes(issue.sceneId) && plan.scenes.some(scene => scene.sceneId === issue.sceneId && issue.frame >= scene.fromFrame && issue.frame < scene.toFrame) && result.observedFrames.includes(issue.frame) && issue.category && issue.evidence && issue.problem && issue.expected), '问题必须带实际观察帧、分镜和证据');
  requireValue(result.reviewedAudio === undefined || result.reviewedAudio === false, '静帧审查不能声明已听审');
  if (plan.evidenceFrames) requireValue(result.observations.every(issue => plan.evidenceFrames!.some(frame => frame.frame === issue.frame && issue.evidence === `${frame.path}#${frame.sha256}`)), '问题证据必须绑定原作业登记的图片路径与摘要');
  const observed = [...new Set([...unit.observedFrames, ...result.observedFrames])];
  requireValue(result.status !== 'completed' || unit.reviewFrames.every(frame => observed.includes(frame)), '未观察完分配范围不得标记完成');
  const previousIssues = new Set(plan.results.filter(item => item.unitId === unit.unitId).flatMap(item => item.observations.map(issue => JSON.stringify(issue))));
  if (observed.length > unit.observedFrames.length || result.observations.some(issue => !previousIssues.has(JSON.stringify(issue)))) unit.lastMeaningfulProgressAt = now;
  // 这份记录只证明静帧观察；连续画面和音频仍保持未审，不从静帧覆盖推导视听通过。
  unit.observedFrames = observed;
  unit.status = result.status === 'completed' ? 'completed' : 'assigned';
  plan.results.push(structuredClone({ ...result, reviewedAudio: false, unobservedRanges: unit.unobservedRanges }));
  return true;
}

export function releaseReviewAssignment(plan: ReviewPlan, unitId: string, reason: string): number[] {
  const unit = plan.units.find(item => item.unitId === unitId);
  requireValue(unit && unit.status === 'assigned' && reason.trim(), '只有未完成分派可以按实际原因接管');
  plan.history.push({ unitId, assignmentId: unit.assignmentId!, agentId: unit.assignedAgentId!, reason });
  Object.assign(unit, { status: 'pending', assignedAgentId: null, assignmentId: null });
  return unit.reviewFrames.filter(frame => !unit.observedFrames.includes(frame));
}

/** 该函数只规划新证据范围，不把旧版结论改写为新版通过；未变区域须另有可信摘要等价证明。 */
export function affectedReviewUnits(plan: ReviewPlan, change: { sceneIds: string[]; sharedComponent?: boolean; subtitles?: boolean; globalTimeline?: boolean; templatePackaging?: boolean }): string[] {
  requireValue(change.sceneIds.every(id => plan.units.some(unit => unit.sceneIds.includes(id))), '变更引用了未知分镜');
  if (change.sharedComponent || change.subtitles || change.globalTimeline || change.templatePackaging) return plan.units.map(unit => unit.unitId);
  const indices = new Set<number>();
  plan.units.forEach((unit, index) => {
    if (unit.sceneIds.some(id => change.sceneIds.includes(id))) {
      // 局部修订同时复查相邻主题切口，不能遗漏跨单元的持续对象。
      for (const neighbor of [index - 1, index, index + 1]) if (plan.units[neighbor]) indices.add(neighbor);
    }
  });
  return plan.units.filter((_, index) => indices.has(index)).map(unit => unit.unitId);
}

export function mergeReviewIssues(plan: ReviewPlan): ReviewObservation[] {
  const issues = new Map<string, ReviewObservation>();
  const rank = { suggestion: 0, warning: 1, blocking: 2 };
  for (const result of plan.results) for (const issue of result.observations) {
    const key = JSON.stringify([result.sourceDigest, issue.sceneId, issue.frame, issue.category]);
    const previous = issues.get(key);
    if (!previous || rank[issue.severity] > rank[previous.severity]) issues.set(key, issue);
  }
  return [...issues.values()];
}

export async function writeReviewRecord(runRoot: string, name: string, content: string): Promise<string> {
  // QA 放在 project 旁边，不参与渲染输入摘要，也不改任何媒体作业状态。
  const directory = join(runRoot, 'qa');
  await fs.mkdir(directory, { recursive: true });
  if (!/^[a-z-]+\.(json|jsonl)$/.test(name)) throw new Error('QA 记录文件名无效');
  if (await fs.realpath(directory) !== join(await fs.realpath(runRoot), 'qa')) throw new Error('qa 目录不得指向外部链接');
  const path = join(directory, name);
  const temporary = join(directory, `review-plan.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, path);
  } finally { await fs.rm(temporary, { force: true }); }
  return path;
}

export function saveReviewPlan(runRoot: string, plan: ReviewPlan): Promise<string> {
  return writeReviewRecord(runRoot, 'review-plan.json', JSON.stringify(plan, null, 2));
}
