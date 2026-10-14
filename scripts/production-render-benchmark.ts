import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, cpus, totalmem, platform, release, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { renderTemplate, type TemplateRenderInput } from '../apps/render-worker/src/template-renderer.js';
import { createMediaMetricSink, withMediaSpan, summarizeMediaMetrics, type MediaSpanRecord, type MetricContext } from '../packages/production-service/src/media-metrics.js';
import { canonical, sha256, type Run } from '../packages/production-service/src/contracts.js';
import { processFile, treeDigest, writeJson } from '../packages/production-service/src/files.js';

// 固定的小样本仅测计时开关，不改变编码器、切片算法或正式项目。
const source = `import React from 'react';
import {AbsoluteFill,Audio,Composition,registerRoot,staticFile,useCurrentFrame} from 'remotion';
const Main=()=>{const frame=useCurrentFrame();return <AbsoluteFill style={{backgroundColor:'#101827'}}>
<div style={{position:'absolute',left:20+frame*3,top:35,width:90,height:90,backgroundColor:frame<30?'#23bfad':'#eea83f',transform:'rotate('+frame+'deg)'}}/>
<div style={{position:'absolute',left:20,bottom:20,width:280*frame/59,height:10,backgroundColor:'#f5f5f5'}}/>
<Audio src={staticFile('tone.wav')}/></AbsoluteFill>};
registerRoot(()=> <Composition id="Main" component={Main} width={320} height={180} fps={30} durationInFrames={60}/>);
`;
const request = { taskId: 'isolated-timing-benchmark', otherRequirements: '隔离性能基准', basePlanVersion: 1,
  dataList: [{ id: 's1', content: '固定第一分镜' }, { id: 's2', content: '固定第二分镜' }] };
const renderInput = { renderRequestId: 'fixed-render', timelineRef: 'timeline.json',
  ranges: [{ id: 's1', fromFrame: 0, toFrame: 30 }, { id: 's2', fromFrame: 30, toFrame: 60 }],
  checks: ['隔离固定输入完整渲染'], previewOnly: false };
const config = { width: 320, height: 180, fps: 30, frames: 60, concurrency: 2, sceneCutMode: 'accurate' as const,
  codec: 'h264', audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 1, audioSamples: 96000 };
const repository = process.cwd();
const outputBase = resolve(process.argv[2] ?? 'docs/benchmarks/20261014-render-timing');
const browser = process.env.TEST_BROWSER ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
if (!browser) throw new Error('请设置 TEST_BROWSER 指向已安装浏览器，基准不自动下载。');

function fixedWav() {
  const wave = Buffer.alloc(44 + config.audioSamples * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(config.audioSamples * 2, 40);
  for (let sample = 0; sample < config.audioSamples; sample++) wave.writeInt16LE(Math.round(Math.sin(sample / 48000 * Math.PI * 880) * 5000), 44 + sample * 2);
  return wave;
}
async function fixture(root: string, audio: Buffer) {
  const project = join(root, 'project'), renderer = join(project, 'renderer');
  await fs.mkdir(join(renderer, 'public'), { recursive: true });
  await fs.writeFile(join(project, '说明.md'), '固定 320×180、30fps、60 帧、单声道 440Hz 音频与两个分镜的隔离性能样本。\n');
  await writeJson(join(project, 'timeline.json'), { fps: 30, scenes: renderInput.ranges });
  await fs.writeFile(join(renderer, 'timeline.ts'), 'export default {fps:30,frames:60};\n');
  await fs.writeFile(join(renderer, 'index.tsx'), source);
  await fs.writeFile(join(renderer, 'public/tone.wav'), audio);
  await writeJson(join(renderer, 'renderer-manifest.json'), { schemaVersion: 1, templateVersion: 'timing-benchmark-v1',
    instructions: ['../说明.md'], entry: 'index.tsx', timelineModule: 'timeline.ts', wholeComposition: 'Main',
    publicAssetRoot: 'public', width: 320, height: 180, fps: 30, voiceRefs: ['public/tone.wav'] });
  return treeDigest(project);
}

const audio = fixedWav();
const samples: Array<Record<string, unknown>> = [];
const persisted: MediaSpanRecord[] = [];
const startedAt = new Date().toISOString();
const implementationFiles = ['apps/render-worker/src/template-renderer.ts', 'apps/render-worker/src/template-slices.ts',
  'packages/production-service/src/media-metrics.ts', 'packages/production-service/src/video-output.ts'];
const implementationDigests = Object.fromEntries(await Promise.all(implementationFiles.map(async path => [path, sha256(await fs.readFile(join(repository, path)))])));
const environment = { node: process.version, platform: platform(), osRelease: release(), architecture: arch(),
  cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(),
  ffmpeg: (await processFile(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-version'])).split('\n')[0],
  ffprobe: (await processFile(process.env.FFPROBE_PATH ?? 'ffprobe', ['-version'])).split('\n')[0],
  browser: (await processFile(browser, ['--version'])).trim(),
  remotion: JSON.parse(await fs.readFile(join(repository, 'node_modules/remotion/package.json'), 'utf8')).version };
const root = await fs.mkdtemp(join(tmpdir(), 'textvideo-timing-benchmark-'));
let sourceDigest: string | undefined;
async function save(status: string) {
  await fs.mkdir(dirname(outputBase), { recursive: true });
  await writeJson(`${outputBase}.json`, { schemaVersion: 1, status, startedAt, recordedAt: new Date().toISOString(),
    description: '同输入真实 Remotion 小样本：三轮关闭/开启计时依次交替，完整绘制整片后准确切成两镜。',
    config, sourceDigest, audioSha256: sha256(audio), contentInputSha256: sha256(canonical({ request, renderInput, config })),
    implementationDigests, environment, samples,
    notes: [
      '全部样本源码、WAV 字节、业务输入、渲染参数和 accurate 算法一致；只有隔离目录、运行编号与计时开关变化。',
      '每个样本重新冻结、bundle、启动浏览器、渲染和完整验证；没有预热或复用 bundle。首次执行受模块加载与操作系统缓存冷启动影响，后续仍可能受共享缓存影响。',
      '顺序固定为 off/on × 3，样本量不足以报告 P95、证明无计时开销或外推到真实长片；保留所有观测，不剔除首次样本。',
      '墙钟包含 renderTemplate 和启用时的阶段日志落盘；不包括生成测试输入、报告落盘及临时目录清理。开启模式记录真实 JSONL，关闭模式断言无日志。',
      '阶段有父子与并行重叠，不可相加充当总墙钟；资源字段仅属于 Node 进程，不能据此断言 FFmpeg 或浏览器瓶颈。',
      '没有调用生产服务、正式队列、回调或发布路径；机器上的其他工作仍可能影响测量。',
    ] });
  await fs.writeFile(`${outputBase}.jsonl`, persisted.map(record => JSON.stringify(record)).join('\n') + (persisted.length ? '\n' : ''));
}
try {
  for (let round = 1; round <= 3; round++) for (const enabled of [false, true]) {
    const order = samples.length + 1;
    const runId = `00000000-0000-4000-8000-${String(order).padStart(12, '0')}`;
    const sampleRoot = join(root, String(order));
    const digest = await fixture(sampleRoot, audio);
    sourceDigest ??= digest;
    if (digest !== sourceDigest) throw new Error('基准输入摘要不一致，拒绝比较。');
    const run: Run = { runId, requestId: 'benchmark-request', accountId: 'isolated', taskKey: 'isolated', taskId: request.taskId,
      stage: 'render', state: 'running', planVersion: 1, inputDigest: sha256(canonical(request)), request,
      token: null, heartbeat: null, checkpoint: { template: { digest: sourceDigest } }, result: null, error: null, resultVersion: null, createdAt: 0 };
    const input: TemplateRenderInput = { ...renderInput, runId };
    const records: MediaSpanRecord[] = [];
    const sink = createMediaMetricSink(sampleRoot);
    const metrics: MetricContext = { runId, renderRequestId: input.renderRequestId, sourceDigest, enabled, activeMediaJobs: 1,
      onMetric: async record => { await sink(record); records.push(record); } };
    console.log(`开始第 ${round} 轮，计时${enabled ? '开启' : '关闭'}（固定 60 帧，accurate）。`);
    const start = performance.now();
    const result = await withMediaSpan(metrics, 'benchmark_render_total', child => renderTemplate(run, sampleRoot, input,
      { dependencyRoot: repository, browser, concurrency: config.concurrency, sceneCutMode: config.sceneCutMode, metrics: child }));
    const wallTimeMs = performance.now() - start;
    const metricFile = join(sampleRoot, 'metrics/media.jsonl');
    if (!enabled && await fs.stat(metricFile).catch(() => null)) throw new Error('关闭计时后仍生成了日志。');
    if (enabled) {
      const lines = (await fs.readFile(metricFile, 'utf8')).trim().split('\n');
      if (!records.length || lines.length !== records.length || records.some(record => record.result !== 'succeeded')) throw new Error('阶段计时缺失或包含失败，不记录为成功样本。');
      for (const stage of ['freeze_project', 'bundle', 'select_composition', 'render_media', 'video_full_decode', 'file_record_sha', 'scene_slice']) {
        if (!records.some(record => record.stage === stage)) throw new Error(`缺少实测阶段：${stage}`);
      }
    }
    if (result.delivery.sourceDigest !== sourceDigest || result.delivery.files.length !== 3) throw new Error('输出未满足固定输入或整片与两镜合同。');
    persisted.push(...records);
    samples.push({ order, round, timingEnabled: enabled, runId, wallTimeMs, sourceDigest,
      files: result.delivery.files.map(file => ({ id: file.id, fromFrame: file.fromFrame, toFrame: file.toFrame,
        width: file.width, height: file.height, fps: file.fps, durationSeconds: file.dur, sha256: file.sha256, cutMode: file.cutMetadata?.cutMode ?? null })),
      metricRecordCount: records.length, stageSummary: summarizeMediaMetrics(records)[0] ?? null });
    await save('进行中');
    console.log(`完成第 ${round} 轮，计时${enabled ? '开启' : '关闭'}：${wallTimeMs.toFixed(1)} 毫秒，${records.length} 条阶段记录。`);
  }
  await save('完成');
} catch (error) {
  await save('失败；仅保留已完成样本，不推断完整基准结论');
  throw error;
} finally { await fs.rm(root, { recursive: true, force: true }); }
