import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('候选发行：隔离启动真实 Runtime 与 MCP，核对同版、四任务配置和新工具发现',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'production-release-')),plugin=resolve('plugins/textvideo-studio');
 const manifest=JSON.parse(await fs.readFile(join(plugin,'runtime/dist/manifest.json'),'utf8'));
 const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as any).port;await new Promise<void>(r=>socket.close(()=>r()));
 const url=`http://127.0.0.1:${port}`,env={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),NODE_PATH:resolve('node_modules'),TEXTVIDEO_PLUGIN_ROOT:plugin,TEXTVIDEO_DATA_ROOT:root,TEXTVIDEO_HOST:'127.0.0.1',TEXTVIDEO_PORT:String(port),TEXTVIDEO_RUNTIME_URL:url,TEXTVIDEO_DEPENDENCY_ROOT:resolve('.'),TEXTVIDEO_API_TOKEN:'isolated-test',TEXTVIDEO_ACCOUNT_ID:'isolated-test',CUSTOM_TEMPLATE_API_BASE_URL:url,CALLBACK_BASE_URL:url,CALLBACK_SECRET:'isolated-test',MEDIA_PUBLIC_BASE_URL:`${url}/media`,CODEX_EXECUTABLE:process.execPath,TEXTVIDEO_CODEX_HOME:join(root,'codex'),DOUBAO_API_KEY:'',DOUBAO_VOICES_FILE:'',TEXTVIDEO_MAX_ACTIVE_RUNS:'4',TEXTVIDEO_RENDER_CONCURRENCY:'5',TEXTVIDEO_SPEECH_CONCURRENCY:'20',TEXTVIDEO_SPEECH_PER_RUN_CONCURRENCY:'5'};
 const child=spawn(process.execPath,[join(plugin,'runtime/dist/runtime.cjs')],{cwd:root,env,stdio:['ignore','ignore','pipe']});let diagnostic='';child.stderr.on('data',d=>{diagnostic=(diagnostic+d).slice(-4000);});
 const exited=new Promise<void>((done,fail)=>{child.once('close',()=>done());child.once('error',fail);});
 const client=new Client({name:'isolated-release-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[join(plugin,'runtime/dist/mcp.cjs')],env,stderr:'pipe'});
 try{
   let health:any;for(let i=0;i<200;i++){try{const response=await fetch(`${url}/healthz`,{signal:AbortSignal.timeout(500)});if(response.ok){health=await response.json();break;}}catch{}if(child.exitCode!==null)assert.fail(diagnostic);await new Promise(r=>setTimeout(r,25));}
   assert.ok(health,diagnostic);assert.equal(health.releaseId,manifest.releaseId);assert.deepEqual(health.capacity,{maxActiveRuns:4,renderConcurrency:5,speechConcurrency:20,speechPerRunConcurrency:5,activeRuns:0});
   await client.connect(transport);const tools=await client.listTools();for(const name of ['synthesize_speech_batch','read_speech_batch','retry_speech_validation','verify_sentence_audio','render_template','read_render_job','preview_template_frames','retry_render_slices'])assert.ok(tools.tools.some(t=>t.name===name),name);
   assert.ok(!tools.tools.some(t=>t.name==='preview_template_frame'));
   const release=await client.callTool({name:'read_runtime_release',arguments:{}});assert.notEqual(release.isError,true,JSON.stringify(release));const content=JSON.parse((release.content as any)[0].text);assert.equal(content.aligned,true);assert.equal(content.mcpReleaseId,manifest.releaseId);
 }finally{await client.close();child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exited;}finally{clearTimeout(timer);await fs.rm(root,{recursive:true,force:true});}}
});
