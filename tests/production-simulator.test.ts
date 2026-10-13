import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { signCallback } from '../packages/production-service/src/callbacks.js';

test('模拟平台：下载摘要、故障注入和落库后丢响应的去重',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'textvideo-simulator-'));
  const bytes=Buffer.from('明确标记的协议测试归档字节');await fs.writeFile(join(root,'template-demo.zip'),bytes);
  const child=spawn(process.execPath,[resolve('scripts/production-simulator.mjs')],{env:{...process.env,SIMULATOR_ROOT:root,SIMULATOR_PORT:'0',CALLBACK_SECRET:'test-secret'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');
  try{
    const port=await new Promise<string>((yes,no)=>{let output='';const timer=setTimeout(()=>no(new Error('模拟平台启动超时')),10000);child.once('error',no);child.stdout.on('data',chunk=>{output+=chunk;const m=/已启动 (\d+)/.exec(output);if(m){clearTimeout(timer);yes(m[1]);}});});
    const base=`http://127.0.0.1:${port}`,control=(value:unknown)=>fs.writeFile(join(root,'fault-config.json'),JSON.stringify(value));
    assert.deepEqual(Buffer.from(await (await fetch(base+'/api/custom-templates/demo/package')).arrayBuffer()),bytes);
    const attempt=JSON.parse((await fs.readFile(join(root,'template-attempts.jsonl'),'utf8')).trim());assert.equal(attempt.sha256,createHash('sha256').update(bytes).digest('hex'));
    await control({templateStatus:404});assert.equal((await fetch(base+'/api/custom-templates/demo/package')).status,404);
    const body=JSON.stringify({eventId:'event-fixed',data:{runId:'run-fixed'}}),timestamp=String(Math.floor(Date.now()/1000));
    const send=()=>fetch(base+'/ai_video_director/getAiVideoEditingDataCallback',{method:'POST',body,headers:{'x-event-id':'event-fixed','x-callback-timestamp':timestamp,'x-callback-signature':signCallback('test-secret',timestamp,body)}});
    await control({callbackStatus:429});assert.equal((await send()).status,429);
    await control({callbackResponse:'drop-after-persist'});await assert.rejects(send());
    await control({});assert.equal((await (await send()).json()).status,0);
    const events=await (await fetch(base+'/events')).json();assert.equal(events.length,1);assert.equal(events[0].eventId,'event-fixed');
    assert.equal((await fs.readFile(join(root,'callback-attempts.jsonl'),'utf8')).trim().split('\n').length,3);
  }finally{child.kill();await exited;}
});
