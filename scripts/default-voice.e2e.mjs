import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveCandidateRuntimeOptions } from '../plugins/videoflowcut/scripts/candidate-runtime.mjs';

// 与候选启动器共用隔离检查；本脚本绝不连接正式项目数据库。
const options = resolveCandidateRuntimeOptions(process.argv.slice(2));
const client = new Client({ name: 'default-voice-candidate', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('plugins/videoflowcut/scripts/mcp-launcher.mjs')], stderr: 'pipe',
  env: { ...getDefaultEnvironment(), VIDEOCUT_WORKSPACE: options.workspaceRoot, VIDEOFLOWCUT_PORT: String(options.port), COMFYUI_BRIDGE_URL: options.bridgeUrl } });
const checkpoint = join(options.workspaceRoot, 'default-voice-checkpoint.json');
let saved = await readFile(checkpoint, 'utf8').then(JSON.parse).catch(() => ({}));
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content.find(item => item.type === 'text').text);
};
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.ok(catalog.tools.find(tool => tool.name === 'submit_voice_synthesis').description.includes('省略参考参数'));
  const release = await call('read_runtime_release');
  assert.equal(release.aligned, true);
  assert.equal(release.runtime.workers.media && release.runtime.workers.render, true);
  if (!saved.projectId) {
    const created = await call('create_project', { name: '隔离默认音色回归', profile: 'visual_explainer' });
    saved.projectId = created.snapshot?.project?.id ?? created.project?.id ?? created.projectId;
    assert.ok(saved.projectId, JSON.stringify(created));
    await writeFile(checkpoint, JSON.stringify(saved));
    const script = await call('apply_authored_script', { project_id: saved.projectId, base_revision_id: 1, source_note: '平台隔离测试，不是正式视频', units: [{ text: '这是默认音色接口测试。', kind: 'statement' }, { text: '不上传参考音频，也能使用服务端已有音色。', kind: 'statement' }] });
    assert.ok(script);
  }
  if (!saved.jobId) {
    const job = await call('submit_voice_synthesis', { project_id: saved.projectId, idempotency_key: 'candidate-default-voice-v1' });
    saved.jobId = job.id ?? job.job?.id;
    assert.ok(saved.jobId, JSON.stringify(job));
    await writeFile(checkpoint, JSON.stringify(saved));
    console.log(JSON.stringify({ submitted: saved }));
  }
  const deadline = Date.now() + 15 * 60000;
  let job;
  while (Date.now() < deadline) {
    const tracked = await call('track_job', { job_id: saved.jobId });
    job = tracked.job ?? tracked;
    if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(job.status)) break;
    await new Promise(done => setTimeout(done, 5000));
  }
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  const speech = await call('read_speech_asset', { project_id: saved.projectId });
  assert.equal(speech.voiceReferences.length, 0);
  assert.equal(speech.speechSegmentAssets.length, 2);
  assert.equal(speech.speechAsset.status, 'ready');
  assert.equal(speech.speechAsset.timing.precision, 'segment_exact');
  assert.ok(speech.speechSegmentAssets.every(asset => asset.durationMs > 0 && !asset.voiceReferenceAssetId && asset.bridgeAudit.request.fileSlots.length === 0));
  const project = await call('read_project', { project_id: saved.projectId });
  const result = { verifiedAt: new Date().toISOString(), release, job, speech, project };
  await writeFile(join(options.workspaceRoot, 'default-voice-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, job, speech }));
} finally { await client.close(); }
