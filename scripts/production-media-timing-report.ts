import { promises as fs } from 'node:fs';
import { summarizeMediaMetrics, type MediaSpanRecord } from '../packages/production-service/src/media-metrics.js';

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('用法：npx tsx scripts/production-media-timing-report.ts <基线.jsonl> [候选.jsonl ...]');
const records: MediaSpanRecord[] = [];
for (const path of paths) {
  const lines = (await fs.readFile(path, 'utf8')).split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let record: MediaSpanRecord;
    try { record = JSON.parse(line); }
    catch { throw new Error(`记录无法解析：${path} 第 ${index + 1} 行；请先恢复完整日志，不生成不完整报告。`); }
    if (record.schemaVersion !== 1 || record.event !== 'media_span_finished' ||
      typeof record.runId !== 'string' || typeof record.renderRequestId !== 'string' || typeof record.stage !== 'string' ||
      typeof record.spanId !== 'string' || (record.sourceDigest !== null && typeof record.sourceDigest !== 'string') ||
      !Number.isFinite(record.durationMs) || record.durationMs < 0 ||
      typeof record.clock?.processInstanceId !== 'string' ||
      !Number.isFinite(record.clock?.startedMonotonicMs) || !Number.isFinite(record.clock?.endedMonotonicMs) ||
      record.clock.endedMonotonicMs < record.clock.startedMonotonicMs ||
      !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.endedAt)) ||
      !['succeeded', 'failed', 'cancelled'].includes(record.result)) {
      throw new Error(`记录格式不符合计时合同：${path} 第 ${index + 1} 行。`);
    }
    records.push(record);
  }
}
if (!records.length) throw new Error('未找到实际计时记录，不生成基准成绩。');
// 同一个日志被重复传入时，不让阶段计数和覆盖区间重复出现。
const unique = [...new Map(records.map(record => [`${record.clock.processInstanceId}/${record.spanId}`, record])).values()];
const reports = summarizeMediaMetrics(unique);
console.log('# 媒体阶段计时报告\n');
console.log('这是实际日志覆盖的观测区间；未埋点的排队、回调或人工等待不在统计内。阶段存在父子与并行重叠，禁止把各阶段覆盖时间相加作为端到端耗时。\n');
console.log('资源字段仅反映 Node 进程（含同进程并发工作，不含浏览器与 FFmpeg 子进程）；RSS 峰值为进程生命周期峰值，I/O 等待未采集。主机空闲内存与进程可用内存分别记录，不能推断全部媒体进程资源瓶颈。\n');
for (const report of reports) {
  console.log(`## Run ${report.runId} / 请求 ${report.renderRequestId}\n`);
  console.log(`- 源码摘要：${report.sourceDigests.join('、') || '尚未固定'}\n- 观测墙钟：${(report.observedWallClockMs / 1000).toFixed(3)} 秒\n- 去重覆盖：${(report.observedCoverageMs / 1000).toFixed(3)} 秒\n- 时钟：${report.clockBasis === 'monotonic' ? '同进程单调时钟' : '跨进程 UTC 对齐，受系统时钟调整影响'}\n`);
  console.log('| 阶段 | 次数 | 去重覆盖（秒） | 成功 | 失败 | 取消 |\n|---|---:|---:|---:|---:|---:|');
  for (const stage of report.stages) console.log(`| ${stage.stage} | ${stage.count} | ${(stage.coverageMs / 1000).toFixed(3)} | ${stage.succeeded} | ${stage.failed} | ${stage.cancelled} |`);
  console.log('');
}
console.log('基准比较必须固定源码摘要、输入素材、画幅、帧率、帧数、编码参数、并发配置及环境，并分别保存基线与候选日志。摘要相同本身不能证明其他条件相同；本工具不自动宣称加速或判断瓶颈。');
