import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProductionRepository } from '../packages/production-service/src/repository.js';

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
   assert.ok(health,diagnostic);assert.equal(health.releaseId,manifest.releaseId);assert.equal(health.capabilities.reviewProtocol,5);assert.equal(manifest.capabilities.reviewProtocol,5);assert.deepEqual(health.capacity,{maxActiveRuns:4,renderConcurrency:5,mediaGlobalConcurrency:16,mediaRunConcurrency:2,mediaProcessConcurrency:4,speechConcurrency:20,speechPerRunConcurrency:5,activeRuns:0});
   await client.connect(transport);const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name),['read_runtime_release'],'未绑定可信 Run 时不暴露制作工具');
   assert.ok(!tools.tools.some(t=>t.name==='preview_template_frame'));
   const release=await client.callTool({name:'read_runtime_release',arguments:{}});assert.notEqual(release.isError,true,JSON.stringify(release));const content=JSON.parse((release.content as any)[0].text);assert.equal(content.aligned,true);assert.equal(content.mcpReleaseId,manifest.releaseId);
   // 只向隔离测试仓库建立身份夹具，验证打包后的 MCP 确实向服务查询可信阶段。
   const fixture=new ProductionRepository(join(root,'tasks.sqlite'));
   try{
     fixture.accept('isolated-test','analysis',{taskId:'stage-fixture',content:'原文',otherRequirements:'',plugin:{customTemplateId:'fixture'}});const analysis=fixture.claim()!;
     for(const stage of ['analysis','render'] as const){
       let run=analysis;
       if(stage==='render'){fixture.finish(analysis.runId,analysis.token,'succeeded',{});fixture.accept('isolated-test','render',{taskId:'stage-fixture',basePlanVersion:1,dataList:[{id:'s',content:'原文'}],otherRequirements:''});run=fixture.claim()!;}
       const scoped=new Client({name:'stage-fixture',version:'1'});
       try{
         await scoped.connect(new StdioClientTransport({command:process.execPath,args:[join(plugin,'runtime/dist/mcp.cjs')],env:{...env,TEXTVIDEO_RUN_ID:run.runId,TEXTVIDEO_RUN_TOKEN:run.token!,TEXTVIDEO_RUN_STAGE:stage==='analysis'?'render':'analysis'},stderr:'pipe'}));
         const discovered=(await scoped.listTools()).tools;const names=discovered.map(tool=>tool.name);
         if(stage==='render'){const phase=JSON.stringify(discovered.find(t=>t.name==='prepare_review')!.inputSchema.properties?.phase);assert.match(phase,/pre_export/);assert.doesNotMatch(phase,/final/);}
         if(stage==='analysis')assert.deepEqual(names.sort(),['read_production_task','read_runtime_release']);
         else for(const name of ['synthesize_speech_batch','read_render_job','retry_render_slices','search_motion_mechanisms'])assert.ok(names.includes(name),name);
       }finally{await scoped.close();}
     }
   }finally{fixture.close();}
 }finally{await client.close();child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exited;}finally{clearTimeout(timer);await fs.rm(root,{recursive:true,force:true});}}
});
