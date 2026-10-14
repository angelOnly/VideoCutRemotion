import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexUsageObserver } from '../packages/production-service/src/codex-usage.js';

const tokens=(inputTokens:number,cachedInputTokens:number,outputTokens:number)=>({inputTokens,cachedInputTokens,outputTokens,totalTokens:inputTokens+outputTokens});
test('模型用量按 thread 累计快照去重，不把累计输入或快照次数当作单次上下文和响应数',()=>{
  const observer=new CodexUsageObserver();assert.equal(observer.summary('/raw').available,false);
  const first={method:'thread/tokenUsage/updated',params:{threadId:'main',tokenUsage:{last:tokens(100,20,10),total:tokens(100,20,10)}}};
  observer.observe(first);observer.observe(first);
  observer.observe({method:'thread/tokenUsage/updated',params:{threadId:'main',tokenUsage:{last:tokens(150,40,20),total:tokens(250,60,30)}}});
  const result=observer.summary('/raw').threads[0];
  assert.equal(result.firstInputTokens,100);assert.equal(result.peakInputTokens,150);assert.equal(result.cumulativeInputTokens,250);assert.equal(result.cumulativeCachedInputTokens,60);assert.equal(result.cumulativeOutputTokens,30);assert.equal(result.responseCount,null);assert.equal(result.usageSnapshots,2);
});
test('真实响应事件按 responseId 去重，子会话单列，无累计用量时保留 null',()=>{
  const observer=new CodexUsageObserver(),response={method:'rawResponse/completed',params:{threadId:'child',responseId:'r1',usage:tokens(42,12,3)}};
  observer.observe(response);observer.observe(response);observer.observe({...response,params:{...response.params,responseId:'r2',usage:null}});
  const result=observer.summary('/raw').threads[0];assert.equal(result.threadId,'child');assert.equal(result.responseCount,2);assert.equal(result.cumulativeInputTokens,null);assert.equal(result.peakInputTokens,42);
});
