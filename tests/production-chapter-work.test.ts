import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chapterWorkPlan} from '../packages/production-service/src/chapter-work.js';

test('连续章节保持最新分镜顺序，重复标题不合并跨章内容',()=>{
 const titles=[undefined,'收入',undefined,'利润','收入'];
 const scenes=titles.map((chapter,i)=>({id:`s${i}`,content:'正文',dur:1,directing:{kind:'speech',chapter}}));
 const plan=chapterWorkPlan(scenes as any);
 assert.equal(plan.maxConcurrentAuthors,4);
 assert.deepEqual(plan.units.map(u=>u.sceneIds),[['s0'],['s1','s2'],['s3'],['s4']]);
 assert.equal(new Set(plan.units.map(u=>u.sourceDirectory)).size,4);
 assert.deepEqual(chapterWorkPlan([]).units,[]);
});
