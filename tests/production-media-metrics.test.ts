import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withMediaSpan, createMediaMetricSink, summarizeMediaMetrics, type MetricContext, type MediaSpanRecord } from '../packages/production-service/src/media-metrics.js';

function recording() {
  const records: MediaSpanRecord[] = [];
  const context: MetricContext = { runId: 'test-run', renderRequestId: 'request', sourceDigest: 'digest', onMetric: record => { records.push(record); } };
  return { context, records };
}

test('计时保持返回值、父子链及单调时长，资源明确为 Node 进程范围', async () => {
  const { context, records } = recording();
  assert.equal(await withMediaSpan(context, 'render', child => withMediaSpan(child, 'bundle', () => 42)), 42);
  assert.equal(records.length, 2);
  assert.equal(records[0].parentSpanId, records[1].spanId);
  assert.equal(records[1].parentSpanId, null);
  assert.ok(records[1].durationMs >= records[0].durationMs);
  assert.equal(records[0].resources.scope, 'node_process_including_concurrent_work_excluding_children');
  assert.equal(records[0].resources.ioWaitMs, null);
  assert.ok(records[0].startedAt.endsWith('Z'));
  assert.equal(records[0].sourceDigest, 'digest');
});

test('并发媒体作业数在阶段结束时读取，避免保留开始时的旧值', async () => {
  const { context, records } = recording();
  let activeMediaJobs = 3;
  await withMediaSpan({ ...context, activeMediaJobs: () => activeMediaJobs }, 'render', () => { activeMediaJobs = 1; });
  assert.equal(records[0].resources.activeMediaJobs, 1);
  await withMediaSpan({ ...context, activeMediaJobs: 2 }, 'render', () => {});
  assert.equal(records[1].resources.activeMediaJobs, 2);
});

test('失败与取消保留原始异常，不输出错误全文或字符串元数据', async () => {
  const { context, records } = recording();
  const failure = new Error('token=secret');
  await assert.rejects(withMediaSpan(context, 'render', () => { throw failure; }, { frames: 10, token: 'secret' } as any), error => error === failure);
  assert.equal(records[0].result, 'failed');
  assert.equal(JSON.stringify(records[0]).includes('secret'), false);
  assert.deepEqual(records[0].metadata, { frames: 10 });
  const cancelled = Object.assign(new Error('已取消'), { code: 'PROCESS_CANCELLED' });
  await assert.rejects(withMediaSpan(context, 'render', () => { throw cancelled; }), error => error === cancelled);
  assert.equal(records[1].result, 'cancelled');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(withMediaSpan({ ...context, signal: controller.signal }, 'render', () => { throw failure; }), error => error === failure);
  assert.equal(records[2].result, 'cancelled');
});

test('关闭开关不创建日志，嵌套操作仍执行；落盘错误不改变成功或失败', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'media-metrics-'));
  try {
    const context = { ...recording().context, onMetric: createMediaMetricSink(root) };
    assert.equal(await withMediaSpan({ ...context, enabled: false }, 'disabled', child => withMediaSpan(child, 'nested', () => 7)), 7);
    assert.equal(await withMediaSpan(undefined, 'disabled', () => 8), 8);
    assert.equal(await fs.stat(join(root, 'metrics')).catch(() => null), null);
    const unavailable = { ...context, onMetric: async () => { throw new Error('磁盘不可写'); } };
    assert.equal(await withMediaSpan(unavailable, 'render', () => 9), 9);
    const failure = new Error('渲染失败');
    await assert.rejects(withMediaSpan(unavailable, 'render', () => { throw failure; }), error => error === failure);
    await withMediaSpan(context, 'render', () => 10);
    const lines = (await fs.readFile(join(root, 'metrics/media.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).result, 'succeeded');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('归并父子与重叠区间不重复相加，跨进程明确标记 UTC 对齐', async () => {
  const { context, records } = recording();
  await withMediaSpan(context, 'render', () => {});
  const span = (id: string, start: number, end: number): MediaSpanRecord => ({ ...records[0], spanId: id,
    startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), durationMs: end - start,
    clock: { processInstanceId: 'one', startedMonotonicMs: start, endedMonotonicMs: end } });
  const spans = [span('one', 1000, 1100), span('two', 1020, 1080), span('three', 1050, 1150)];
  const summary = summarizeMediaMetrics(spans)[0];
  assert.equal(summary.observedWallClockMs, 150);
  assert.equal(summary.observedCoverageMs, 150);
  assert.equal(summary.stages[0].coverageMs, 150);
  assert.equal(summary.stages[0].count, 3);
  assert.equal(summary.clockBasis, 'monotonic');
  spans[1].clock.processInstanceId = 'two';
  assert.equal(summarizeMediaMetrics(spans)[0].clockBasis, 'utc_cross_process');
  assert.equal(summarizeMediaMetrics(spans)[0].observedCoverageMs, 150);
});

test('报告读取真实 JSONL，拒绝截断日志与空基准，重复文件不重复计数', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'media-report-'));
  const file = join(root, 'metrics/media.jsonl');
  const report = (...paths: string[]) => promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'scripts/production-media-timing-report.ts', ...paths], { cwd: process.cwd() });
  try {
    await withMediaSpan({ ...recording().context, onMetric: createMediaMetricSink(root) }, 'render', () => {});
    const { stdout } = await report(file, file);
    assert.match(stdout, /\| render \| 1 \|/);
    assert.match(stdout, /同进程单调时钟/);
    assert.match(stdout, /不自动宣称加速/);
    await fs.appendFile(file, '{');
    await assert.rejects(report(file), /记录无法解析/);
    await fs.writeFile(file, '');
    await assert.rejects(report(file), /未找到实际计时记录/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('实际 FFmpeg 子进程计入采样资源，明确保留并发与短进程遗漏边界',async()=>{
 const {context,records}=recording();
 await withMediaSpan(context,'media_job',()=>promisify(execFile)(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-re','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-f','null','-']));
 const children=records[0].resources.childProcesses!;
 assert.equal(children.scope,'sampled_chrome_ffmpeg_descendants_including_concurrent_work');
 if(process.platform!=='win32'){assert.equal(children.available,true);assert.ok(children.observedProcessCount>=1);assert.ok(children.peakCombinedRssBytes>0);}
 assert.equal(children.accounting,'sampled_lower_bound_short_lived_processes_may_be_missed');
 assert.equal(JSON.stringify(children).includes('frequency'),false);
});
