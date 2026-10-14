import assert from 'node:assert/strict';
import test from 'node:test';
import { decideDynamicPreview, type DynamicPreviewRequest } from '../packages/production-service/src/preview-policy.js';
import { taskInstruction, INSTRUCTION_VERSION } from '../packages/production-service/src/task-instructions.js';
import type { Run } from '../packages/production-service/src/contracts.js';

const request: DynamicPreviewRequest = { sourceDigest: 'v1', question: '章间过渡是否遮字', fromFrame: 80, toFrame: 110, consumer: 'actual-agent', passCriteria: '标题完整可读', needsVideo: true, needsAudio: false, continuousVideoAvailable: true, continuousAudioAvailable: false };
test('按需预览：无疑点不生成，无真实能力留待审，能力齐全才提交', () => {
  assert.equal(decideDynamicPreview({ onDemand: false }), 'legacy');
  assert.equal(decideDynamicPreview({ onDemand: true }), 'not_needed');
  assert.equal(decideDynamicPreview({ onDemand: true, request: { ...request, continuousVideoAvailable: false } }), 'professional_review_pending');
  assert.equal(decideDynamicPreview({ onDemand: true, request: { ...request, needsAudio: true } }), 'professional_review_pending');
  assert.equal(decideDynamicPreview({ onDemand: true, request }), 'request_preview');
  assert.throws(() => decideDynamicPreview({ onDemand: true, request: { ...request, passCriteria: '' } }), /通过标准/);
});
test('同版已核验整片直接复用，旧版不能充作当前检查媒体', () => {
  assert.equal(decideDynamicPreview({ onDemand: true, request, verifiedWholeVideo: { sourceDigest: 'v1', fileRef: 'readyFiles/whole.mp4' } }), 'reuse_whole_video');
  assert.equal(decideDynamicPreview({ onDemand: true, request, verifiedWholeVideo: { sourceDigest: 'v0', fileRef: 'readyFiles/whole.mp4' } }), 'request_preview');
});
test('真实运行时指令随开关变化，默认按需预览，Analysis 不启动审片', () => {
  const render = { stage: 'render', request: {} } as Run;
  assert.match(taskInstruction(render, '/run', '/plugin'), /动态预览不是固定下一步/);
  const legacy = taskInstruction(render, '/run', '/plugin', { qaParallelReview: false, qaMaxReviewers: 3, previewOnDemand: false });
  assert.match(legacy, /并行主题审片=关闭/);
  assert.match(legacy, /再用 render_template 的 previewOnly\/ranges 检查真实运动和声音/);
  const optimized = taskInstruction(render, '/run', '/plugin', { qaParallelReview: true, qaMaxReviewers: 2, previewOnDemand: true });
  assert.match(optimized, /审片代理上限=2/);
  assert.match(optimized, /动态预览不是固定下一步/);
  assert.match(optimized, /professional_review_pending/);
  assert.match(optimized, /Runtime 启动有界只读审片线程并绑定独立身份/);
  assert.ok(!optimized.includes('再用 render_template 的 previewOnly/ranges 检查真实运动和声音'));
  assert.match(INSTRUCTION_VERSION, /\/8$/);
  const analysis = taskInstruction({ stage: 'analysis', request: {} } as Run, '/run', '/plugin', { qaParallelReview: true, qaMaxReviewers: 3, previewOnDemand: true });
  assert.match(analysis, /不调用配音、预览、媒体生成/);
  assert.ok(!analysis.includes('只读主题审查单元'));
});
