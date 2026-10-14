import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptReviewResult, affectedReviewUnits, assignReviewUnit, createReviewPlan, DEFAULT_REVIEW_POLICY, mergeReviewIssues, releaseReviewAssignment, reviewerCapacity, saveReviewPlan, type ReviewResult } from '../packages/production-service/src/review-policy.js';

function plan() {
  return createReviewPlan({ runId: 'run-qa', sourceDigest: 'digest-v1',
    scenes: Array.from({ length: 5 }, (_, i) => ({ sceneId: `s${i}`, fromFrame: i * 100, toFrame: (i + 1) * 100 })),
    chapters: Array.from({ length: 5 }, (_, i) => ({ chapterId: `ch${i}`, sceneIds: [`s${i}`] })),
    readyFrames: Array.from({ length: 10 }, (_, i) => ({ frame: i * 50 + 10, sourceDigest: 'digest-v1' })),
  });
}
function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return { unitId: 'chapter-ch0', sourceDigest: 'digest-v1', assignmentId: 'assignment-1', reviewerAgentId: 'agent-1', status: 'completed', observedFrames: [10, 60], observations: [], ...overrides };
}

test('主题单元不硬编码数量，同版覆盖完整分镜，真实容量受宿主限制', () => {
  const current = plan();
  assert.equal(current.units.length, 5);
  assert.equal(reviewerCapacity({ ...DEFAULT_REVIEW_POLICY, qaParallelReview: true }, 9), 3);
  assert.equal(reviewerCapacity({ ...DEFAULT_REVIEW_POLICY, qaParallelReview: true }, 2), 2);
  assert.equal(reviewerCapacity(DEFAULT_REVIEW_POLICY, 0), 0);
  assert.equal(reviewerCapacity(DEFAULT_REVIEW_POLICY, 4), 1);
  for (let i = 0; i < 3; i++) assignReviewUnit(current, `chapter-ch${i}`, `agent-${i + 1}`, `assignment-${i + 1}`);
  assert.equal(current.units.filter(unit => unit.status === 'assigned').length, 3);
  assert.throws(() => assignReviewUnit(current, 'chapter-ch0', 'agent-other', 'duplicate'), /待审/);
  assert.throws(() => assignReviewUnit(current, 'chapter-ch3', 'agent-1', 'assignment-4'), /当前单元/);
  assert.equal(acceptReviewResult(current, result()), true);
  assignReviewUnit(current, 'chapter-ch3', 'agent-1', 'assignment-4');
  assert.equal(current.units[3].assignedAgentId, 'agent-1');
});

test('静帧混版或分镜主题重复会在分派前拒绝', () => {
  const input = { runId: 'r', sourceDigest: 'v1', scenes: [{ sceneId: 's', fromFrame: 0, toFrame: 100 }], readyFrames: [{ frame: 20, sourceDigest: 'v2' }] };
  assert.throws(() => createReviewPlan(input), /同一已冻结/);
  assert.throws(() => createReviewPlan({ ...input, readyFrames: [{ frame: 20, sourceDigest: 'v1' }], chapters: [{ chapterId: 'a', sceneIds: ['s', 's'] }] }), /完整且唯一/);
  assert.equal(createReviewPlan({ ...input, readyFrames: [{ frame: 20, sourceDigest: 'v1' }] }).units[0].unitId, 'scene-s');
});

test('当前分派验证版本、负责人、真实观察范围，不将旧版完成带入新版', () => {
  const current = plan();
  assignReviewUnit(current, 'chapter-ch0', 'agent-1', 'assignment-1');
  assert.equal(acceptReviewResult(current, result({ sourceDigest: 'old' })), false);
  assert.equal(acceptReviewResult(current, result({ reviewerAgentId: 'other' })), false);
  assert.throws(() => acceptReviewResult(current, result({ observedFrames: [10] })), /未观察完/);
  assert.throws(() => acceptReviewResult(current, result({ observedFrames: [10, 999] })), /分配证据/);
  assert.equal(current.units[0].status, 'assigned');
  assert.equal(acceptReviewResult(current, result()), true);
  assert.equal(plan().units[0].status, 'pending');
});

test('通信接管仅剩余只读范围，迟到代次无法覆盖，阻断问题保留', () => {
  const current = plan();
  assignReviewUnit(current, 'chapter-ch0', 'agent-1', 'assignment-1');
  const observation = { sceneId: 's0', frame: 10, category: '遮挡', severity: 'blocking' as const, evidence: 'readyFrames/10.png#sha', problem: '连线穿字', expected: '文字完整可读' };
  assert.equal(acceptReviewResult(current, result({ status: 'partial', observedFrames: [10], observations: [observation] })), true);
  assert.deepEqual(releaseReviewAssignment(current, 'chapter-ch0', 'Broken pipe，宿主确认失联'), [60]);
  assignReviewUnit(current, 'chapter-ch0', 'healthy-agent', 'assignment-takeover');
  assert.equal(acceptReviewResult(current, result()), false);
  assert.equal(acceptReviewResult(current, result({ assignmentId: 'assignment-takeover', reviewerAgentId: 'healthy-agent', observedFrames: [60] })), true);
  assert.equal(current.units[0].attempt, 2);
  assert.equal(current.history[0].assignmentId, 'assignment-1');
  assert.equal(mergeReviewIssues(current)[0].severity, 'blocking');
  assert.throws(() => releaseReviewAssignment(current, 'chapter-ch0', '不能接管完成项'), /未完成/);
  assert.equal('mediaJobs' in current, false);
});

test('局部变更只规划影响及相邻切口，共享字幕或时间轴扩大范围', () => {
  const current = plan();
  assert.deepEqual(affectedReviewUnits(current, { sceneIds: ['s3'] }), ['chapter-ch2', 'chapter-ch3', 'chapter-ch4']);
  for (const change of [{ subtitles: true }, { globalTimeline: true }, { sharedComponent: true }, { templatePackaging: true }]) {
    assert.equal(affectedReviewUnits(current, { sceneIds: [], ...change }).length, 5);
  }
  assert.throws(() => affectedReviewUnits(current, { sceneIds: ['missing'] }), /未知分镜/);
  assert.equal(current.units.every(unit => unit.status === 'pending'), true);
});

test('QA 原子记录位于工程之外，不改变 project 文件及其摘要输入', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'review-policy-'));
  try {
    await fs.mkdir(join(root, 'project'));
    await fs.writeFile(join(root, 'project', 'timeline.json'), '{"unchanged":true}');
    const path = await saveReviewPlan(root, plan());
    assert.equal(path, join(root, 'qa', 'review-plan.json'));
    assert.equal(JSON.parse(await fs.readFile(path, 'utf8')).sourceDigest, 'digest-v1');
    assert.equal(await fs.readFile(join(root, 'project', 'timeline.json'), 'utf8'), '{"unchanged":true}');
    assert.deepEqual(await fs.readdir(join(root, 'qa')), ['review-plan.json']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('发行 QA 命令实际读写原计划、拒绝迟到结果并保留媒体原文件', async () => {
  const { executeReviewCommand } = await import('../packages/production-service/src/review-cli.js');
  const root = await fs.mkdtemp(join(tmpdir(), 'review-cli-'));
  try {
    await fs.mkdir(join(root, 'qa'));
    await fs.writeFile(join(root, 'media-job.json'), '{"state":"running"}');
    const command = async (request: unknown) => {
      await fs.writeFile(join(root, 'qa', 'request.json'), JSON.stringify(request));
      return executeReviewCommand(root, 'request.json');
    };
    await fs.mkdir(join(root, 'render-jobs'));
    await fs.writeFile(join(root, 'frame.png'), 'test frame');
    await fs.writeFile(join(root, 'render-jobs', 'preview.json'), JSON.stringify({ id: 'preview', runId: 'r', kind: 'frame-preview', sourceDigest: 'v1', readyFrames: [{ frame: 30, path: join(root, 'frame.png'), sha256: createHash('sha256').update('test frame').digest('hex') }] }));
    const initialize = { operation: 'initialize', renderRequestIds: ['preview'], input: { runId: 'r', sourceDigest: 'v1', scenes: [{ sceneId: 's', fromFrame: 0, toFrame: 100 }], readyFrames: [{ frame: 30, sourceDigest: 'v1' }] } };
    await command(initialize);
    await assert.rejects(command(initialize), /同版计划已存在/);
    await command({ operation: 'assign', unitId: 'scene-s', agentId: 'actual-agent', assignmentId: 'assignment-a' });
    await command({ operation: 'takeover', unitId: 'scene-s', reason: '宿主确认通信异常' });
    await command({ operation: 'assign', unitId: 'scene-s', agentId: 'actual-agent-b', assignmentId: 'assignment-b' });
    const late = await command({ operation: 'result', result: { unitId: 'scene-s', sourceDigest: 'v1', assignmentId: 'assignment-a', reviewerAgentId: 'actual-agent', status: 'completed', observedFrames: [30], observations: [] } });
    assert.equal((late as { accepted: boolean }).accepted, false);
    assert.match(await fs.readFile(join(root, 'qa', 'late-results.jsonl'), 'utf8'), /assignment-a/);
    assert.equal(await fs.readFile(join(root, 'media-job.json'), 'utf8'), '{"state":"running"}');
    await assert.rejects(executeReviewCommand(root, '../media-job.json'), /qa 目录内/);
    const preview = await command({ operation: 'preview', input: { onDemand: true } });
    assert.deepEqual(preview, { decision: 'not_needed', professionalReviewCompleted: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('有意义进度只在新观察帧或新问题出现时前进，静帧完成不宣称听审', () => {
  const current = plan();
  assignReviewUnit(current, 'chapter-ch0', 'agent-1', 'assignment-1');
  const partial = result({ status: 'partial', observedFrames: [10] });
  acceptReviewResult(current, partial, '2026-10-14T00:00:00Z');
  acceptReviewResult(current, partial, '2026-10-14T01:00:00Z');
  assert.equal(current.units[0].lastMeaningfulProgressAt, '2026-10-14T00:00:00Z');
  acceptReviewResult(current, result(), '2026-10-14T02:00:00Z');
  assert.equal(current.units[0].lastMeaningfulProgressAt, '2026-10-14T02:00:00Z');
  assert.equal(current.units[0].reviewedAudio, false);
  assert.deepEqual(current.units[0].unobservedRanges, [{ fromFrame: 0, toFrame: 100 }]);
});

test('主题按真实时间排序，非连续主题和重叠分镜拒绝，局部新证据不逼迫全片重渲', () => {
  const input = { runId: 'r', sourceDigest: 'v2', scenes: [0, 1, 2].map(i => ({ sceneId: `s${i}`, fromFrame: i * 100, toFrame: (i + 1) * 100 })), readyFrames: [{ frame: 150, sourceDigest: 'v2' }] };
  const current = createReviewPlan({ ...input, chapters: [2, 0, 1].map(i => ({ chapterId: `ch${i}`, sceneIds: [`s${i}`] })) });
  assert.deepEqual(current.units.map(unit => unit.unitId), ['chapter-ch0', 'chapter-ch1', 'chapter-ch2']);
  assert.deepEqual(current.units.map(unit => unit.reviewFrames.length), [0, 1, 0]);
  assert.throws(() => assignReviewUnit(current, 'chapter-ch0', 'a', 'id'), /尚无本版静帧/);
  assignReviewUnit(current, 'chapter-ch1', 'a', 'id');
  assert.throws(() => createReviewPlan({ ...input, chapters: [{ chapterId: 'bad', sceneIds: ['s0', 's2'] }, { chapterId: 'middle', sceneIds: ['s1'] }] }), /连续分镜/);
  assert.throws(() => createReviewPlan({ ...input, scenes: [input.scenes[0], { sceneId: 's1', fromFrame: 50, toFrame: 150 }] }), /不得重叠/);
});

test('QA 输出安全替换已有软链接，读取计划拒绝外部链接', async () => {
  const { executeReviewCommand } = await import('../packages/production-service/src/review-cli.js');
  const root = await fs.mkdtemp(join(tmpdir(), 'review-links-'));
  try {
    await fs.mkdir(join(root, 'qa'));
    const external = join(root, 'outside.json');
    await fs.writeFile(external, '原文件');
    await fs.symlink(external, join(root, 'qa', 'preview-decision.json'));
    await fs.writeFile(join(root, 'qa', 'request.json'), JSON.stringify({ operation: 'preview', input: { onDemand: true } }));
    await executeReviewCommand(root, 'request.json');
    assert.equal(await fs.readFile(external, 'utf8'), '原文件');
    assert.equal((await fs.lstat(join(root, 'qa', 'preview-decision.json'))).isSymbolicLink(), false);
    await fs.symlink(external, join(root, 'qa', 'review-plan.json'));
    await fs.writeFile(join(root, 'qa', 'request.json'), JSON.stringify({ operation: 'assign', unitId: 'u', agentId: 'a', assignmentId: 'i' }));
    await assert.rejects(executeReviewCommand(root, 'request.json'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('同版补帧保留已完成单元，空单元可领取，新增已完成范围会作废旧分派', async () => {
  const { executeReviewCommand } = await import('../packages/production-service/src/review-cli.js');
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'review-add-frames-')));
  try {
    await fs.mkdir(join(root, 'qa'));
    await fs.mkdir(join(root, 'render-jobs'));
    const readyFrames = [];
    for (const frame of [10, 30, 110]) {
      const path = join(root, `${frame}.png`);
      await fs.writeFile(path, `静帧${frame}`);
      readyFrames.push({ frame, path, sha256: createHash('sha256').update(`静帧${frame}`).digest('hex') });
    }
    await fs.writeFile(join(root, 'render-jobs', 'frames.json'), JSON.stringify({ id: 'frames', runId: 'r', kind: 'frame-preview', sourceDigest: 'v1', readyFrames }));
    const command = async (request: unknown) => {
      await fs.writeFile(join(root, 'qa', 'request.json'), JSON.stringify(request));
      return executeReviewCommand(root, 'request.json');
    };
    const readPlan = async () => JSON.parse(await fs.readFile(join(root, 'qa', 'review-plan.json'), 'utf8'));
    await command({ operation: 'initialize', renderRequestIds: ['frames'], input: { runId: 'r', sourceDigest: 'v1', scenes: [{ sceneId: 'a', fromFrame: 0, toFrame: 100 }, { sceneId: 'b', fromFrame: 100, toFrame: 200 }], readyFrames: [{ frame: 10, sourceDigest: 'v1' }] } });
    await command({ operation: 'assign', unitId: 'scene-a', agentId: 'agent', assignmentId: 'assignment-a' });
    const result = { unitId: 'scene-a', sourceDigest: 'v1', assignmentId: 'assignment-a', reviewerAgentId: 'agent', status: 'completed', observedFrames: [10], observations: [{ sceneId: 'a', frame: 10, category: '标签', severity: 'warning', evidence: `${readyFrames[0].path}#${readyFrames[0].sha256}`, problem: '字号偏小', expected: '文字可读' }] };
    await command({ operation: 'result', result });
    const before = await readPlan();
    await command({ operation: 'add_frames', renderRequestIds: ['frames'], readyFrames: [{ frame: 110, sourceDigest: 'v1' }] });
    assert.deepEqual((await readPlan()).units[0], before.units[0]);
    await command({ operation: 'assign', unitId: 'scene-b', agentId: 'agent', assignmentId: 'assignment-b' });
    await command({ operation: 'add_frames', renderRequestIds: ['frames'], readyFrames: [{ frame: 30, sourceDigest: 'v1' }] });
    const after = await readPlan();
    assert.equal(after.units[0].status, 'pending');
    assert.deepEqual(after.units[0].observedFrames, [10]);
    assert.equal(after.units[0].lastMeaningfulProgressAt, before.units[0].lastMeaningfulProgressAt);
    assert.equal(after.history[0].assignmentId, 'assignment-a');
    assert.equal(after.results.length, 1);
    assert.equal((await command({ operation: 'result', result }) as { accepted: boolean }).accepted, false);
    const changed = { ...readyFrames[0], path: join(root, 'another.png') };
    await fs.writeFile(changed.path, '静帧10');
    await fs.writeFile(join(root, 'render-jobs', 'changed.json'), JSON.stringify({ id: 'changed', runId: 'r', kind: 'frame-preview', sourceDigest: 'v1', readyFrames: [changed] }));
    await assert.rejects(command({ operation: 'add_frames', renderRequestIds: ['changed'], readyFrames: [{ frame: 10, sourceDigest: 'v1' }] }), /证据身份不同/);
    assert.equal(JSON.parse(await fs.readFile(join(root, 'qa', 'issue-ledger.json'), 'utf8')).issues.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('同主题多分镜的问题帧不得误标到其他分镜', () => {
  const current = createReviewPlan({ runId: 'r', sourceDigest: 'v1', scenes: [{ sceneId: 's1', fromFrame: 0, toFrame: 100 }, { sceneId: 's2', fromFrame: 100, toFrame: 200 }], chapters: [{ chapterId: 'one', sceneIds: ['s1', 's2'] }], readyFrames: [{ frame: 110, sourceDigest: 'v1' }] });
  assignReviewUnit(current, 'chapter-one', 'a', 'assignment');
  assert.throws(() => acceptReviewResult(current, { unitId: 'chapter-one', sourceDigest: 'v1', assignmentId: 'assignment', reviewerAgentId: 'a', status: 'completed', observedFrames: [110], observations: [{ sceneId: 's1', frame: 110, category: '标签', severity: 'warning', evidence: 'frame110', problem: '错误标注分镜', expected: '问题归属真实分镜' }] }), /实际观察帧、分镜和证据/);
  assert.equal(current.units[0].status, 'assigned');
});
