import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplication } from '@videocut/application';
import { configureDefaultVoice } from '../plugins/videoflowcut/scripts/configure-default-voice.mjs';

test('无参考素材的新稿可提交默认音色，显式无效参考仍拒绝且不产生新 Revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vfc-default-voice-')); const app = createApplication(root);
  try {
    const project = app.createProject({ name: '默认音色回归', profile: 'visual_explainer' });
    const projectId = project.snapshot.project.id;
    const state = app.applyAuthoredScript({ projectId, baseRevision: 1, sourceNote: '测试原稿', units: [{ text: '这是默认音色测试。', kind: 'statement' }] });
    const job = app.submitVoiceSynthesis({ projectId });
    assert.equal(job.payload.workflowId, 'omnivoice-default-reference-v1');
    assert.equal(job.payload.voiceReferenceAssetId, undefined);
    assert.equal(app.submitVoiceSynthesis({ projectId }).id, job.id);
    assert.throws(() => app.submitVoiceSynthesis({ projectId, voiceReferenceId: 'missing' }), /未登记/);
    assert.equal(app.readProject(projectId).revision.number, state.revision.number);
    assert.equal(app.readProject(projectId).snapshot.assets.length, 0);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});

test('默认 HTTP 配置沿用已有文件，不公开上传槽，缺文件时部署失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vfc-default-config-'));
  try {
    const inputRoot = join(root, 'input'); await mkdir(inputRoot);
    const workflowPath = join(root, 'workflow.json'); const outputDirectory = join(root, 'api');
    await writeFile(workflowPath, JSON.stringify({ extra: { comfyuiBridge: { status: 'ready', apiPrompt: { '1': { inputs: { audio: 'existing.wav' } }, '2': { inputs: { text: '示例' } } }, inputMappings: [{ id: 'audio', nodeId: '1', inputName: 'audio', kind: 'audio' }, { id: 'text', nodeId: '2', inputName: 'text', kind: 'text' }], outputMappings: [] } } }));
    await assert.rejects(configureDefaultVoice({ workflowPath, inputRoot, outputDirectory }), /不存在/);
    await writeFile(join(inputRoot, 'existing.wav'), 'fixture');
    await configureDefaultVoice({ workflowPath, inputRoot, outputDirectory });
    const manifest = JSON.parse(await readFile(join(outputDirectory, 'omnivoice-default-reference-v1.bridge.json'), 'utf8'));
    assert.deepEqual(manifest.inputMappings.map((field: { kind: string }) => field.kind), ['text']);
    assert.equal(JSON.parse(await readFile(join(outputDirectory, manifest.apiPromptFile), 'utf8'))['1'].inputs.audio, 'existing.wav');
  } finally { await rm(root, { recursive: true, force: true }); }
});
