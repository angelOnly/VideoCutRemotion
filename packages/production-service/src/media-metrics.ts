import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export type MediaMetricMetadata = Record<string, number | boolean | null>;
export interface MetricContext {
  runId: string;
  renderRequestId: string;
  sourceDigest?: string;
  parentSpanId?: string;
  enabled?: boolean;
  signal?: AbortSignal;
  activeMediaJobs?: number | (() => number);
  onMetric?: (record: MediaSpanRecord) => void | Promise<void>;
}
export interface MediaSpanRecord {
  schemaVersion: 1;
  event: 'media_span_finished';
  runId: string;
  renderRequestId: string;
  sourceDigest: string | null;
  stage: string;
  spanId: string;
  parentSpanId: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  result: 'succeeded' | 'failed' | 'cancelled';
  clock: { processInstanceId: string; startedMonotonicMs: number; endedMonotonicMs: number };
  resources: {
    scope: 'node_process_including_concurrent_work_excluding_children';
    cpuUserMs: number;
    cpuSystemMs: number;
    cpuPercentOfOneCore: number;
    rssStartBytes: number;
    rssEndBytes: number;
    processLifetimePeakRssBytes: number;
    fileSystemReadOperations: number;
    fileSystemWriteOperations: number;
    ioAccounting: 'resourceUsage_platform_dependent_zero_may_be_unavailable';
    ioWaitMs: null;
    hostFreeMemoryStartBytes: number;
    hostFreeMemoryEndBytes: number;
    processAvailableMemoryEndBytes: number | null;
    activeMediaJobs: number | null;
    childProcesses?: ChildResourceSample;
  };
  metadata: MediaMetricMetadata;
}

export interface ChildResourceSample {
  scope: 'sampled_chrome_ffmpeg_descendants_including_concurrent_work';
  available: boolean;
  intervalMs: number;
  samples: number;
  observedProcessCount: number;
  observedCpuMs: number;
  peakCombinedRssBytes: number;
  accounting: 'sampled_lower_bound_short_lived_processes_may_be_missed';
}
const execFileAsync=promisify(execFile);
function cpuTimeMs(value:string){
  const [daysPart,timePart]=value.includes('-')?value.split('-'):['0',value];
  const pieces=timePart.split(':').map(Number);let seconds=0;for(const p of pieces)seconds=seconds*60+p;
  return (Number(daysPart)*86400+seconds)*1000;
}
/** 只读取进程名与资源数字；不采集可能带凭据的命令参数。并行作业共享子树，不能归因成独占资源。 */
function sampleChildren(){
  const result:ChildResourceSample={scope:'sampled_chrome_ffmpeg_descendants_including_concurrent_work',available:false,intervalMs:1000,samples:0,observedProcessCount:0,observedCpuMs:0,peakCombinedRssBytes:0,accounting:'sampled_lower_bound_short_lived_processes_may_be_missed'};
  const cpu=new Map<number,{base:number;last:number}>();let sampling:Promise<void>|undefined,stopped=false;
  const sample=()=>{
    if(sampling)return sampling;
    sampling=(async()=>{
      try{
        const {stdout}=await execFileAsync('ps',['-axo','pid=,ppid=,time=,rss=,comm='],{timeout:2000,maxBuffer:4*1024*1024});
        const processes=stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);return m?[{pid:Number(m[1]),parent:Number(m[2]),cpu:cpuTimeMs(m[3]),rss:Number(m[4])*1024,name:m[5]}]:[];});
        const descendants=new Set([process.pid]);let added=true;
        while(added){added=false;for(const p of processes)if(descendants.has(p.parent)&&!descendants.has(p.pid)){descendants.add(p.pid);added=true;}}
        let rss=0;
        for(const p of processes.filter(p=>descendants.has(p.pid)&&/chrome|chromium|ffmpeg|ffprobe/i.test(p.name))){
          if(!cpu.has(p.pid))cpu.set(p.pid,{base:result.samples===0?p.cpu:0,last:p.cpu});else cpu.get(p.pid)!.last=p.cpu;rss+=p.rss;
        }
        result.available=true;result.samples++;result.peakCombinedRssBytes=Math.max(result.peakCombinedRssBytes,rss);
        result.observedProcessCount=cpu.size;result.observedCpuMs=[...cpu.values()].reduce((sum,p)=>sum+Math.max(0,p.last-p.base),0);
      }catch{/* 宿主无 ps 或采样失败只影响观测，不影响正式媒体。 */}
    })().finally(()=>{sampling=undefined;});return sampling;
  };
  const initial=sample();const timer=setInterval(()=>{if(!stopped)void sample();},result.intervalMs);timer.unref();
  return {initial,async stop(){stopped=true;clearInterval(timer);await sampling;await sample();return result;}};
}

const processInstanceId = randomUUID();

// 元数据只接收计数和开关，不把命令、错误消息、密钥或全文写进性能记录。
function numericMetadata(metadata: MediaMetricMetadata = {}): MediaMetricMetadata {
  return Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
    /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) &&
    (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))));
}

export async function withMediaSpan<T>(
  context: MetricContext | undefined,
  stage: string,
  operation: (child: MetricContext | undefined) => T | Promise<T>,
  metadata?: MediaMetricMetadata,
): Promise<T> {
  // 开关由运行配置统一解析，通过 context 传入，避免同一次作业重新读取环境变量。
  if (!context || context.enabled === false || !context.onMetric) return operation(context);
  const spanId = randomUUID();
  const child = { ...context, parentSpanId: spanId };
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let usage: NodeJS.ResourceUsage, rss: number, freeMemory: number;
  try {
    usage = process.resourceUsage();
    rss = process.memoryUsage.rss();
    freeMemory = freemem();
  } catch {
    // 宿主无法采样时仍执行原操作，不把观测能力当成渲染前置条件。
    return operation(context);
  }
  const sampler=['media_job','media_job_resume'].includes(stage)?sampleChildren():undefined;
  // 采样在旁路进行，不能为收集资源数据延迟真正的媒体工作。
  let result: MediaSpanRecord['result'] = 'succeeded';
  try {
    return await operation(child);
  } catch (error) {
    const failure = error as { name?: string; code?: string } | null;
    result = context.signal?.aborted || failure?.name === 'AbortError' || failure?.code === 'PROCESS_CANCELLED'
      ? 'cancelled' : 'failed';
    throw error;
  } finally {
    // 计时/落盘失败不能覆盖媒体结果或原始错误；不记录可能包含凭据的错误文本。
    try {
      const childProcesses=await sampler?.stop();
      const end = performance.now();
      const endedAt = new Date().toISOString();
      const finalUsage = process.resourceUsage();
      const durationMs = Math.max(0, end - start);
      const cpuUserMs = Math.max(0, finalUsage.userCPUTime - usage.userCPUTime) / 1000;
      const cpuSystemMs = Math.max(0, finalUsage.systemCPUTime - usage.systemCPUTime) / 1000;
      await context.onMetric({
        schemaVersion: 1, event: 'media_span_finished', runId: context.runId,
        renderRequestId: context.renderRequestId, sourceDigest: child.sourceDigest ?? context.sourceDigest ?? null,
        stage, spanId, parentSpanId: context.parentSpanId ?? null, startedAt, endedAt, durationMs, result,
        clock: { processInstanceId, startedMonotonicMs: start, endedMonotonicMs: end },
        resources: {
          scope: 'node_process_including_concurrent_work_excluding_children', cpuUserMs, cpuSystemMs,
          ...(childProcesses?{childProcesses}:{}),
          cpuPercentOfOneCore: durationMs > 0 ? (cpuUserMs + cpuSystemMs) / durationMs * 100 : 0,
          rssStartBytes: rss, rssEndBytes: process.memoryUsage.rss(),
          // maxRSS 是 Node 进程启动以来的峰值，不是此阶段或 FFmpeg 的峰值。
          processLifetimePeakRssBytes: finalUsage.maxRSS * 1024,
          fileSystemReadOperations: Math.max(0, finalUsage.fsRead - usage.fsRead),
          fileSystemWriteOperations: Math.max(0, finalUsage.fsWrite - usage.fsWrite),
          ioAccounting: 'resourceUsage_platform_dependent_zero_may_be_unavailable', ioWaitMs: null,
          hostFreeMemoryStartBytes: freeMemory, hostFreeMemoryEndBytes: freemem(),
          processAvailableMemoryEndBytes: typeof process.availableMemory === 'function' ? process.availableMemory() : null,
          // 长阶段期间作业数会变化，调度方可提供结束时的实时读数。
          activeMediaJobs: (typeof context.activeMediaJobs === 'function' ? context.activeMediaJobs() : context.activeMediaJobs) ?? null,
        }, metadata: numericMetadata(metadata),
      });
    } catch { /* 性能日志为辅助产物，不改变正式媒体状态。 */ }
  }
}

/** 输出只进入 Run 的 metrics 目录，调用方提供可信的 Run 根目录。 */
export function createMediaMetricSink(runRoot: string): NonNullable<MetricContext['onMetric']> {
  const directory = join(runRoot, 'metrics');
  return async record => {
    await fs.mkdir(directory, { recursive: true });
    await fs.appendFile(join(directory, 'media.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  };
}

function unionDuration(intervals: Array<[number, number]>) {
  let total = 0, left = 0, right = 0;
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    if (end < start) continue;
    if (start > right) { total += right - left; left = start; right = end; }
    else right = Math.max(right, end);
  }
  return total + right - left;
}

/** 同进程用单调时钟，跨进程只能使用 UTC 对齐；阶段覆盖时间绝不相加充当总耗时。 */
export function summarizeMediaMetrics(records: MediaSpanRecord[]) {
  const groups = new Map<string, MediaSpanRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([record.runId, record.renderRequestId]);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map(spans => {
    const sameProcess = new Set(spans.map(span => span.clock.processInstanceId)).size === 1;
    const interval = (span: MediaSpanRecord): [number, number] => sameProcess
      ? [span.clock.startedMonotonicMs, span.clock.endedMonotonicMs]
      : [Date.parse(span.startedAt), Date.parse(span.endedAt)];
    const intervals = spans.map(interval);
    return {
      runId: spans[0].runId, renderRequestId: spans[0].renderRequestId,
      sourceDigests: [...new Set(spans.map(span => span.sourceDigest).filter(digest => digest !== null))],
      clockBasis: sameProcess ? 'monotonic' : 'utc_cross_process',
      observedWallClockMs: Math.max(...intervals.map(item => item[1])) - Math.min(...intervals.map(item => item[0])),
      observedCoverageMs: unionDuration(intervals),
      stages: [...new Set(spans.map(span => span.stage))].map(stage => {
        const matches = spans.filter(span => span.stage === stage);
        return { stage, count: matches.length, coverageMs: unionDuration(matches.map(interval)),
          succeeded: matches.filter(span => span.result === 'succeeded').length,
          failed: matches.filter(span => span.result === 'failed').length,
          cancelled: matches.filter(span => span.result === 'cancelled').length };
      }),
    };
  });
}
