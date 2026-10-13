import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMainTurn } from '../packages/production-service/src/turn-events.js';

const message=(threadId:string,turnId:string,text:string)=>({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',text}}});
const completed=(threadId:string,id:string,status='completed')=>({method:'turn/completed',params:{threadId,turn:{id,status}}});

test('子代理初审完成不结束主制作，也不覆盖主线程结构化交付',()=>{
  const results:any[]=[],errors:Error[]=[];
  const receive=collectMainTurn(()=>({threadId:'main',turnId:'render'}),r=>results.push(r),e=>errors.push(e));
  receive(message('main','render','{"resultPath":"result.json"}'));
  receive(message('director','review','初审已保存'));
  receive(completed('director','review'));
  receive(completed('visual','drawing','interrupted'));
  receive(message('main','old-turn','过期输出'));
  receive(completed('main','old-turn'));
  assert.equal(results.length,0);assert.equal(errors.length,0);
  receive(completed('main','render'));
  assert.equal(results.length,1);assert.equal(results[0].text,'{"resultPath":"result.json"}');
});

test('首个主 turn 先于启动响应到达时仍收集；主 turn 中断仍正确失败',()=>{
  const results:any[]=[],errors:Error[]=[];let turnId:string|undefined;
  const receive=collectMainTurn(()=>({threadId:'main',turnId}),r=>results.push(r),e=>errors.push(e));
  receive(message('main','first','完整结果'));receive(completed('main','first'));
  assert.equal(results[0].text,'完整结果');
  turnId='second';receive(completed('main','second','interrupted'));
  assert.equal(errors.length,1);assert.match(errors[0].message,/interrupted/);
});
