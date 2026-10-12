import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

test('topic-driven skills and case references are connected without test-default leakage', () => {
  const output = execFileSync(process.execPath, [join(process.cwd(), 'scripts/check-topic-film-skills.mjs')], {encoding: 'utf8'});
  const report = JSON.parse(output);
  assert.equal(report.kind, '静态技能与案例合同');
  assert.deepEqual(report.failures, []);
});
