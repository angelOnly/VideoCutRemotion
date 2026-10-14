import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 实际启动候选 MCP 进程，身份由服务返回，不能通过模型参数切换角色。
test('候选发行移除文件审片入口，审片 MCP 使用最小同源合同与独立连接凭证',async()=>{
 const plugin=resolve('plugins/textvideo-studio'),release=JSON.parse(await fs.readFile(join(plugin,'runtime/dist/manifest.json'),'utf8'));
 await assert.rejects(fs.access(join(plugin,'runtime/dist/review.cjs')));
 const received:any[]=[];
 const runtime=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/healthz'){res.end(JSON.stringify({releaseId:release.releaseId}));return;}
  let body='';for await(const chunk of req)body+=chunk;
  received.push({url:req.url,headers:req.headers,body:JSON.parse(body)});
  if(req.url==='/internal/tools/read_production_task')res.end(JSON.stringify({stage:'render',role:'reviewer'}));
  else if(req.url==='/internal/tools/submit_review'){res.statusCode=409;res.end(JSON.stringify({msg:'分派已经过期',error:{code:'REVIEW_ASSIGNMENT_STALE',nextStep:'重新领取当前包'}}));}
  else res.end(JSON.stringify({assignmentToken:'00000000-0000-4000-8000-000000000001',unitId:'scene-a'}));
 });
 await new Promise<void>(done=>runtime.listen(0,'127.0.0.1',done));
 const port=(runtime.address() as any).port;
 const transport=new StdioClientTransport({command:process.execPath,args:[join(plugin,'runtime/dist/mcp.cjs')],env:{...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),TEXTVIDEO_PLUGIN_ROOT:plugin,TEXTVIDEO_RUNTIME_URL:`http://127.0.0.1:${port}`,TEXTVIDEO_RUN_ID:'isolated-run',TEXTVIDEO_REVIEW_TOKEN:'isolated-reviewer',TEXTVIDEO_RUN_TOKEN:'must-not-transmit'},stderr:'pipe'});
 const client=new Client({name:'隔离发行验证',version:'1'});
 try{
  await client.connect(transport);
  const listed=await client.listTools();assert.deepEqual(listed.tools.map(t=>t.name).sort(),['claim_review_work','read_production_task','read_review','read_runtime_release','submit_review']);
  const submission=listed.tools.find(t=>t.name==='submit_review')!;
  assert.deepEqual(new Set(submission.inputSchema.required),new Set(['assignmentToken','observations','issues','status']));
  assert.equal((await client.callTool({name:'render_template',arguments:{}})).isError,true);
  const claimed=await client.callTool({name:'claim_review_work',arguments:{}});assert.equal((claimed.structuredContent as any).unitId,'scene-a');
  const rejected=await client.callTool({name:'submit_review',arguments:{assignmentToken:'00000000-0000-4000-8000-000000000001',observations:[],issues:[],status:'partial'}});
  assert.equal(rejected.isError,true);assert.equal((rejected.structuredContent as any).code,'REVIEW_ASSIGNMENT_STALE');assert.equal((rejected.structuredContent as any).nextStep,'重新领取当前包');
  assert.ok(received.every(r=>r.headers['x-review-token']==='isolated-reviewer'&&!r.headers['x-run-token']));
 }finally{await client.close();await new Promise<void>(done=>runtime.close(()=>done()));}
});
