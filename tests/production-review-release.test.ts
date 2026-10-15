import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 实际启动候选 MCP 进程，身份由服务返回，不能通过模型参数切换角色。
test('候选发行移除文件审片入口，主任务 MCP 显式登记原生分派并使用 Run 凭证',async()=>{
 const plugin=resolve('plugins/textvideo-studio'),release=JSON.parse(await fs.readFile(join(plugin,'runtime/dist/manifest.json'),'utf8'));
 await assert.rejects(fs.access(join(plugin,'runtime/dist/review.cjs')));
 const received:any[]=[];
 const runtime=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/healthz'){res.end(JSON.stringify({releaseId:release.releaseId}));return;}
  let body='';for await(const chunk of req)body+=chunk;
  received.push({url:req.url,headers:req.headers,body:JSON.parse(body)});
  if(req.url==='/internal/tools/read_production_task')res.end(JSON.stringify({stage:'render'}));
  else if(req.url==='/internal/tools/submit_review'){res.statusCode=409;res.end(JSON.stringify({msg:'分派已经过期',error:{code:'REVIEW_ASSIGNMENT_STALE',nextStep:'重新领取当前包'}}));}
  else res.end(JSON.stringify({assignmentToken:'00000000-0000-4000-8000-000000000001',unitId:'scene-a'}));
 });
 await new Promise<void>(done=>runtime.listen(0,'127.0.0.1',done));
 const port=(runtime.address() as any).port;
 const transport=new StdioClientTransport({command:process.execPath,args:[join(plugin,'runtime/dist/mcp.cjs')],env:{...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),TEXTVIDEO_PLUGIN_ROOT:plugin,TEXTVIDEO_RUNTIME_URL:`http://127.0.0.1:${port}`,TEXTVIDEO_RUN_ID:'isolated-run',TEXTVIDEO_REVIEW_TOKEN:'isolated-reviewer',TEXTVIDEO_RUN_TOKEN:'isolated-coordinator'},stderr:'pipe'});
 const client=new Client({name:'隔离发行验证',version:'1'});
 try{
  await client.connect(transport);
  const listed=await client.listTools();assert.ok(listed.tools.some(t=>t.name==='assign_review_work'));assert.ok(listed.tools.some(t=>t.name==='prepare_review_frames'));assert.ok(listed.tools.some(t=>t.name==='retry_review_preparation'));assert.ok(listed.tools.find(t=>t.name==='read_review')?.inputSchema.properties?.details);assert.ok(listed.tools.some(t=>t.name==='render_template'));assert.ok(!listed.tools.some(t=>t.name==='claim_review_work'));
  const prepared=await client.callTool({name:'prepare_review_frames',arguments:{renderRequestId:'round',phase:'pre_export',units:[{unitId:'scene-a',sceneIds:['scene-a'],checks:[{checkId:'layout',purpose:'实际布局',frames:Array.from({length:26},(_,i)=>i)}]}]}});assert.notEqual(prepared.isError,true);
  const submission=listed.tools.find(t=>t.name==='submit_review')!;
  assert.deepEqual(new Set(submission.inputSchema.required),new Set(['reviewId','assignmentToken','observations','issues','status']));
  assert.equal((await client.callTool({name:'render_template',arguments:{}})).isError,true);
  const claimed=await client.callTool({name:'assign_review_work',arguments:{reviewId:'00000000-0000-4000-8000-000000000002',unitId:'scene-a',reviewerAgentId:'native-agent',assignmentRequestId:'assign-one'}});assert.equal((claimed.structuredContent as any).unitId,'scene-a');
  const rejected=await client.callTool({name:'submit_review',arguments:{reviewId:'00000000-0000-4000-8000-000000000002',assignmentToken:'00000000-0000-4000-8000-000000000001',observations:[],issues:[],status:'partial'}});
  assert.equal(rejected.isError,true);assert.equal((rejected.structuredContent as any).code,'REVIEW_ASSIGNMENT_STALE');assert.equal((rejected.structuredContent as any).nextStep,'重新领取当前包');
  assert.ok(received.every(r=>r.headers['x-run-token']==='isolated-coordinator'&&!r.headers['x-review-token']));
 }finally{await client.close();await new Promise<void>(done=>runtime.close(()=>done()));}
});
