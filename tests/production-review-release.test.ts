import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
test('发行 review.cjs 能真实初始化、分派、接收结果和登记问题', async () => {
  const entry = resolve('plugins/textvideo-studio/runtime/dist/review.cjs');
  await fs.access(entry);
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'review-release-')));
  try {
    await fs.mkdir(join(root, 'qa'));
    await fs.mkdir(join(root, 'render-jobs'));
    const path = join(root, 'frame.png');
    await fs.writeFile(path, '隔离静帧文件');
    const digest = createHash('sha256').update('隔离静帧文件').digest('hex');
    await fs.writeFile(join(root, 'render-jobs', 'preview.json'), JSON.stringify({ id: 'preview', runId: 'r', kind: 'frame-preview', sourceDigest: 'snapshot', readyFrames: [{ frame: 10, path, sha256: digest }] }));
    const call = async (request: unknown) => {
      await fs.writeFile(join(root, 'qa', 'request.json'), JSON.stringify(request));
      const { stdout } = await exec(process.execPath, [entry, root, 'request.json']);
      assert.ok(stdout.trim(), '发行命令必须执行主入口并返回结果');
      return JSON.parse(stdout);
    };
    await call({ operation: 'initialize', renderRequestIds: ['preview'], input: { runId: 'r', sourceDigest: 'snapshot', scenes: [{ sceneId: 's', fromFrame: 0, toFrame: 20 }], readyFrames: [{ frame: 10, sourceDigest: 'snapshot' }] } });
    await call({ operation: 'assign', unitId: 'scene-s', agentId: 'actual-reviewer', assignmentId: 'assignment-1' });
    const result = await call({ operation: 'result', result: { unitId: 'scene-s', sourceDigest: 'snapshot', reviewerAgentId: 'actual-reviewer', assignmentId: 'assignment-1', status: 'completed', observedFrames: [10], reviewedAudio: false, observations: [{ sceneId: 's', frame: 10, category: '连线遮挡', severity: 'blocking', evidence: `${path}#${digest}`, problem: '标签被连线遮挡', expected: '文字完整可读' }] } });
    assert.equal(result.accepted, true);
    const ledger = JSON.parse(await fs.readFile(join(root, 'qa', 'issue-ledger.json'), 'utf8'));
    assert.equal(ledger.sourceDigest, 'snapshot');
    assert.equal(ledger.issues[0].severity, 'blocking');
    const plan = JSON.parse(await fs.readFile(join(root, 'qa', 'review-plan.json'), 'utf8'));
    assert.equal(plan.units[0].status, 'completed');
    assert.equal(plan.units[0].reviewedAudio, false);
    assert.ok(plan.units[0].lastMeaningfulProgressAt);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
