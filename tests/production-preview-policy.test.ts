import assert from 'node:assert/strict';
import test from 'node:test';
import {taskInstruction} from '../packages/production-service/src/task-instructions.js';
import type {Run} from '../packages/production-service/src/contracts.js';
test('阶段入口保留输入合同，效果策略交技能与 Codex，Analysis 不启动审片',()=>{
 const render=taskInstruction({stage:'render',request:{}} as Run,'/run','/plugin',{qaParallelReview:true,qaMaxReviewers:2,previewOnDemand:true});
 assert.match(render,/审片代理上限=2/);assert.match(render,/宿主原生代理分派/);assert.doesNotMatch(render,/previewRequests|claim_review_work/);assert.match(render,/submittedContent/);assert.match(render,/manifest.instructions/);
 const analysis=taskInstruction({stage:'analysis',request:{}} as Run,'/run','/plugin');assert.match(analysis,/不调用配音、预览、媒体生成/);assert.match(analysis,/content 同时保留台词与可见标签/);assert.match(analysis,/template.speakerBindings/);
});
