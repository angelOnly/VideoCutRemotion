import test from 'node:test';
import assert from 'node:assert/strict';
import {productionTiming} from '../packages/production-service/src/production-timing.js';
test('全流程区间不重叠，负责人可并行；缺失时间与未结束事件保持未归因',()=>{
 const event=(method:string,threadId:string,time?:number)=>({method,...(time===undefined?{}:{recordedAt:new Date(time).toISOString()}),params:{threadId,item:{id:'same',type:'mcpToolCall',tool:'read_render_job',arguments:{renderRequestId:'original'}}}});
 const report=productionTiming(0,100,[{spanId:'media',renderRequestId:'original',stage:'render_frames',startedAt:new Date(20).toISOString(),endedAt:new Date(60).toISOString(),result:'succeeded',clock:{processInstanceId:'test'}} as any],[event('item/started','a',10),event('item/started','b',30),event('item/completed','a',50),event('item/completed','b',80),event('item/started','c',90),event('item/completed','old')]);
 assert.equal(report.timeline.reduce((n,t)=>n+t.durationMs,0),100);assert.equal(report.unattributedMs,30);assert.equal(report.activities.length,3);assert.ok(report.timeline.some(t=>t.activities.length===3));assert.equal(report.activities[1].dependency,'original');assert.equal(report.diagnostics.length,2);
});
