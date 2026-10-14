import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductionRepository } from '../packages/production-service/src/repository.js';
import { CallbackSender,signCallback } from '../packages/production-service/src/callbacks.js';
test('T13：限流、超时、非 JSON 可恢复，业务拒绝进入死信且不改变成功结果',async()=>{
  const repo=new ProductionRepository(join(mkdtempSync(join(tmpdir(),'textvideo-callback-faults-')),'tasks.sqlite'));
  let mode='429';const received:{id:string;body:string}[]=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    received.push({id:String(req.headers['x-event-id']),body});
    if(mode==='timeout')return;
    if(mode==='429'){res.writeHead(429).end();return;}
    res.setHeader('content-type','application/json');
    res.end(mode==='non-json'?'响应损坏':mode==='reject'?'{"status":2}':'{"status":0}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const sender=new CallbackSender(repo,`http://127.0.0.1:${(server.address() as any).port}`,'secret',{maxAttempts:8,timeoutMs:100,baseDelayMs:0});
  try{
    const run=repo.accept('a','analysis',{taskId:'faults',content:'测试稿',otherRequirements:'',plugin:{customTemplateId:'3'}}),claim=repo.claim()!;
    repo.finish(run.runId,claim.token,'succeeded',{marker:'不可变结果'});
    const event=()=>repo.db.prepare('SELECT * FROM callback_outbox').get() as any;
    const original=event().body;
    for(const failure of ['429','timeout','non-json']){
      mode=failure;await sender.tick();assert.equal(event().state,'retrying',failure);
      assert.equal(repo.get(run.runId).state,'succeeded');assert.equal(event().body,original);
    }
    mode='reject';await sender.tick();assert.equal(event().state,'dead_letter');
    // 死信恢复只重投同一通知，不重新接受任务或修改成功结果。
    sender.retry(event().id,'a');mode='ok';await sender.tick();
    assert.equal(event().state,'delivered');assert.equal(new Set(received.map(r=>r.id)).size,1);
    assert.equal(new Set(received.map(r=>r.body)).size,1);assert.equal(repo.list('a','faults').length,1);
    assert.deepEqual(repo.get(run.runId).result,{marker:'不可变结果'});
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));repo.close();}
});
test('T13/T14/T15：回调独立重试、原字节签名及事件身份保持',async()=>{
  const repo=new ProductionRepository(join(mkdtempSync(join(tmpdir(),'vfc-outbox-')),'tasks.sqlite'));const bodies:string[]=[];let mode='500';
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;bodies.push(body);assert.equal(req.headers['x-callback-signature'],signCallback('secret',String(req.headers['x-callback-timestamp']),body));if(mode==='500'){res.writeHead(500).end();return;}res.setHeader('content-type','application/json');res.end(mode==='string'?'{"status":"0"}':'{"status":0}');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as any).port}`,sender=new CallbackSender(repo,base,'secret',{maxAttempts:3,timeoutMs:1000,baseDelayMs:0});
  try{const r=repo.accept('a','analysis',{taskId:'t',content:'原文',otherRequirements:'',plugin:{customTemplateId:'3'}}),c=repo.claim()!;repo.finish(r.runId,c.token,'succeeded',{});await sender.tick();assert.equal(repo.get(r.runId).state,'succeeded');assert.equal((repo.db.prepare('SELECT * FROM callback_outbox').get() as any).state,'retrying');mode='string';await sender.tick();const event=repo.db.prepare('SELECT * FROM callback_outbox').get() as any;assert.equal(event.state,'dead_letter');sender.retry(event.id,'a');mode='ok';await sender.tick();assert.equal((repo.db.prepare('SELECT * FROM callback_outbox').get() as any).state,'delivered');assert.equal(new Set(bodies).size,1);assert.equal(repo.list('a','t').length,1);}finally{await new Promise<void>(r=>server.close(()=>r()));repo.close();}
});

test('并发 tick 只投递一次；HTTP 200 的畸形正文不是业务接受',async()=>{
 const root=mkdtempSync(join(tmpdir(),'callback-overlap-')),repo=new ProductionRepository(join(root,'tasks.sqlite'));
 let received=0,body='null';
 const server=createServer(async(req,res)=>{for await(const _chunk of req){}received++;await new Promise(resolve=>setTimeout(resolve,20));res.end(body);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const sender=new CallbackSender(repo,`http://127.0.0.1:${(server.address() as any).port}`,'secret',{maxAttempts:10,timeoutMs:1000,baseDelayMs:0});
 try{
  const run=repo.accept('a','analysis',{taskId:'overlap',content:'原文',otherRequirements:'',plugin:{customTemplateId:'3'}}),claim=repo.claim()!;
  repo.finish(run.runId,claim.token,'succeeded',{marker:'已发布'});
  const event=()=>repo.db.prepare('SELECT * FROM callback_outbox').get() as any;
  await Promise.all([sender.tick(),sender.tick(),sender.tick()]);assert.equal(received,1);assert.equal(event().attempts,1);assert.equal(event().state,'retrying');
  for(const malformed of ['[]','0','{}','{"status":null}']){body=malformed;await sender.tick();assert.notEqual(event().state,'delivered');if(event().state==='dead_letter')sender.retry(event().id,'a');}
  body='{"status":0}';await sender.tick();assert.equal(event().state,'delivered');assert.equal(repo.get(run.runId).state,'succeeded');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));repo.close();}
});
