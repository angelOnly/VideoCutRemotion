import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ToolObserver} from '../packages/production-service/src/tool-observer.js';
import {collectMainTurn} from '../packages/production-service/src/turn-events.js';

test('审片通信异常只是线索，不清空在途媒体，也不冒充有效审片进展',()=>{
 const observer=new ToolObserver();
 observer.observe({method:'item/started',params:{threadId:'reviewer',item:{id:'media',type:'mcpToolCall'}}},0);
 observer.observeTransport('Broken pi','stderr',10);observer.observeTransport('pe: secret text','stderr',20);
 observer.observeTransport('WebSocket fallback','stderr',30);observer.observeTransport('timeout','stderr',40);
 observer.observeTransport('普通日志','stderr',50);
 const diagnostics=observer.transportDiagnostics();
 assert.deepEqual(diagnostics.map(d=>d.kind),['broken_pipe','websocket_fallback','transport_timeout']);
 assert.ok(diagnostics.every(d=>!d.reviewProgressKnown&&d.count===1));assert.ok(!JSON.stringify(diagnostics).includes('secret'));
 assert.equal(observer.stalled(200000)[0].itemId,'media');
 observer.observe({method:'item/completed',params:{threadId:'reviewer',item:{id:'media'}}},200001);
 assert.equal(observer.stalled(200002).length,0);
});

test('子代理失败及迟到完成不结束主Turn，原主结果仍可交接',()=>{
 let finished=0,failed=0;
 const collect=collectMainTurn(()=>({threadId:'main',turnId:'current'}),()=>{finished++;},()=>{failed++;});
 collect({method:'turn/completed',params:{threadId:'reviewer',turn:{id:'child',status:'failed',error:'Broken pipe'}}});
 collect({method:'turn/completed',params:{threadId:'main',turn:{id:'old',status:'completed'}}});
 assert.equal(finished,0);assert.equal(failed,0);
 collect({method:'item/completed',params:{threadId:'main',turnId:'current',item:{type:'agentMessage',text:'真实主结果'}}});
 collect({method:'turn/completed',params:{threadId:'main',turn:{id:'current',status:'completed'}}});
 assert.equal(finished,1);assert.equal(failed,0);
});
