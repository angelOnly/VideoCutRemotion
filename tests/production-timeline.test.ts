import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateProductionTimeline, preflightTimeline } from '../packages/production-service/src/production-timeline.js';
import { renderToolSchema, publicRenderToolSchema, renderTemplate, templateFrames } from '../apps/render-worker/src/template-renderer.js';
import { writeJson } from '../packages/production-service/src/files.js';
const expected=[{id:'a',content:'甲。'},{id:'b',content:'乙。'}];
function timeline(){return {fps:30,totalFrames:80,scenes:expected.map((s,i)=>({id:s.id,from:i*35,frames:35,utterances:[{id:`u${i}`,text:s.content,src:`${i}.wav`,startFrame:i===0?5:0,endFrameExclusive:30}],captions:[{text:s.content,utteranceId:`u${i}`,startFrame:i===0?5:0,endFrameExclusive:30}],...(i===0?{intro:{src:'intro.mp4',frames:5,muted:true}}:{})})),chapters:[{id:'c1',from:5,endFrameExclusive:35},{id:'c2',from:35,endFrameExclusive:70}],ending:{narrationEndFrame:70,outro:{src:'outro.mp4',frames:10,muted:false}}};}
test('公共结构推导完整分镜，首末包装不改变视觉章节时钟',()=>{
 const value=timeline(),before=JSON.stringify(value);const result=validateProductionTimeline(value,expected,30);
 assert.deepEqual(result.ranges,[{id:'a',fromFrame:0,toFrame:35},{id:'b',fromFrame:35,toFrame:80}]);
 assert.deepEqual(result.chapters,[{chapterId:'c1',sceneIds:['a']},{chapterId:'c2',sceneIds:['b']}]);assert.equal(JSON.stringify(value),before);
 for(const change of [(v:any)=>v.chapters[0].from=4,(v:any)=>v.scenes[1].id='a',(v:any)=>v.scenes[0].captions[0].text='改稿',(v:any)=>v.scenes[0].captions[0].endFrameExclusive=40,(v:any)=>v.ending.outro.frames=9,(v:any)=>v.scenes[0].utterances[0].startFrame=0]){const invalid=timeline();change(invalid);assert.throws(()=>validateProductionTimeline(invalid,expected,30));}
});
test('正式和预览工具使用两个严格合同，正式范围不再手填',()=>{
 const base={renderRequestId:'formal',timelineRef:'renderer/timeline.json',checks:['仅静帧']};
 assert.equal(publicRenderToolSchema.parse(base).previewOnly,false);
 assert.throws(()=>publicRenderToolSchema.parse({...base,ranges:[{id:'a',fromFrame:0,toFrame:35}]}));
 assert.throws(()=>publicRenderToolSchema.parse({...base,previewOnly:true}));
 assert.equal(publicRenderToolSchema.parse({...base,previewOnly:true,ranges:[{id:'risk',fromFrame:5,toFrame:10}]}).previewOnly,true);
 assert.equal(renderToolSchema.parse({...base,runId:'11111111-1111-4111-8111-111111111111'}).previewOnly,false);
});
async function fixture(){
 const root=await fs.mkdtemp(join(tmpdir(),'timeline-contract-')),project=join(root,'project'),renderer=join(project,'renderer');
 await fs.mkdir(join(renderer,'public'),{recursive:true});
 for(const name of ['index.ts','timeline.ts','说明.md'])await fs.writeFile(join(renderer,name),'// 测试');
 await writeJson(join(renderer,'renderer-manifest.json'),{schemaVersion:1,templateVersion:'test',instructions:['说明.md'],entry:'index.ts',timelineModule:'timeline.ts',timelineDataRef:'timeline.json',timelineContract:'sentence-timeline/1',publicAssetRoot:'public',width:64,height:64,fps:30,wholeComposition:'Main'});
 for(const name of ['0.wav','1.wav','intro.mp4','outro.mp4'])await fs.writeFile(join(renderer,'public',name),'资源引用夹具');
 await writeJson(join(renderer,'timeline.json'),timeline());
 const run:any={runId:'11111111-1111-4111-8111-111111111111',stage:'render',state:'running',request:{dataList:expected}};
 return {root,project,renderer,run};
}
test('冻结后且 bundle 前拒绝结构错误及越界静帧',async()=>{
 const f=await fixture();let bundled=false;const backend:any={bundle:async()=>{bundled=true;throw new Error('不应绘图');}},options:any={dependencyRoot:process.cwd(),concurrency:1};
 try{
  await assert.rejects(templateFrames(f.run,f.root,{runId:f.run.runId,renderRequestId:'badframe',frames:[80]},options,backend),/frames/);assert.equal(bundled,false);
  const bad=timeline();bad.chapters[0].from=4;await writeJson(join(f.renderer,'timeline.json'),bad);
  await assert.rejects(renderTemplate(f.run,f.root,{runId:f.run.runId,renderRequestId:'badchapter',timelineRef:'renderer/timeline.json',previewOnly:false,checks:[]},options,backend),/chapters/);assert.equal(bundled,false);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('正式范围登记在原作业回调，数据源和资源不匹配明确拒绝',async()=>{
 const f=await fixture();let ranges:unknown;const backend:any={bundle:async()=>{throw new Error('停止在打包边界');}};
 try{
  await assert.rejects(renderTemplate(f.run,f.root,{runId:f.run.runId,renderRequestId:'derived',timelineRef:'renderer/timeline.json',previewOnly:false,checks:[]},{dependencyRoot:process.cwd(),concurrency:1,onRangesResolved:async value=>{ranges=value;}},backend),/停止在打包边界/);
  assert.deepEqual(ranges,validateProductionTimeline(timeline(),expected,30).ranges);
  await assert.rejects(preflightTimeline(f.project,expected,{timelineRef:'other.json'}),/唯一 JSON/);
  await fs.unlink(join(f.renderer,'public/0.wav'));await assert.rejects(preflightTimeline(f.project,expected));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('真实 MCP 发现显示字段且调用执行严格正式/预览合同',async()=>{
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js'),{Client}=await import('@modelcontextprotocol/sdk/client/index.js'),{InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const {registerProductionTools}=await import('../apps/server/src/production/speech-tools.js');
 const server=new McpServer({name:'隔离合同',version:'1'}),client=new Client({name:'测试',version:'1'});let called=0;
 registerProductionTools(server,async()=>{called++;return {state:'accepted'};});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  const listed=(await client.listTools()).tools;const schema=listed.find(t=>t.name==='render_template')!.inputSchema;
  assert.ok(schema.properties?.renderRequestId&&schema.properties?.timelineRef&&schema.properties?.ranges);assert.ok(listed.some(t=>t.name==='assemble_sentence_audio'));
  const base={renderRequestId:'formal',timelineRef:'renderer/timeline.json',checks:['仅静帧']};
  assert.notEqual((await client.callTool({name:'render_template',arguments:base})).isError,true);
  for(const bad of [{...base,ranges:[{id:'a',fromFrame:0,toFrame:35}]},{...base,previewOnly:true},{...base,unexpected:true}])assert.equal((await client.callTool({name:'render_template',arguments:bad})).isError,true);
  assert.equal(called,1);
 }finally{await client.close();await server.close();}
});

test('单一 JSON 模板迁移保留完整数值、顺序和动作对象，拒绝执行表达式',async()=>{
 const {processFile}=await import('../packages/production-service/src/files.js');const {build}=await import('esbuild');const f=await fixture();
 const source="import type {FinanceTimeline} from './types';\nexport const timeline: FinanceTimeline = "+JSON.stringify({...timeline(),precision:1.2345678901234567,negativeZero:-0,visualBlocks:[{kind:'持续动作',from:7,events:[0,0.25,1]}]},null,2)+';\n';
 try{
  await fs.mkdir(join(f.renderer,'src'));await fs.writeFile(join(f.renderer,'src/timeline.ts'),source);await fs.writeFile(join(f.renderer,'src/types.ts'),'export type FinanceTimeline=any;');
  const load=async()=>{const result=await build({entryPoints:[join(f.renderer,'src/timeline.ts')],bundle:true,write:false,format:'cjs',platform:'node'});const module={exports:{} as any};new Function('module','exports',result.outputFiles[0].text)(module,module.exports);return module.exports.timeline;};
  const before=await load();
  await processFile('python3',['-c',"import runpy,sys;runpy.run_path('scripts/patch-finance-template.py')['adapt_timeline'](sys.argv[1])",f.project]);
  assert.deepEqual(await load(),before);assert.deepEqual(JSON.parse(await fs.readFile(join(f.renderer,'timeline.json'),'utf8')),before);
  await fs.writeFile(join(f.renderer,'src/timeline.ts'),"export const timeline: FinanceTimeline = {fps: calculate()};");
  await assert.rejects(processFile('python3',['-c',"import runpy,sys;runpy.run_path('scripts/patch-finance-template.py')['adapt_timeline'](sys.argv[1])",f.project]));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('真实 HTTP 可连续登记两批静帧，合并等待只创建一份同版完整计划',async t=>{
 const {createProductionServer}=await import('../apps/server/src/production/routes.js'),{ReviewerSessions}=await import('../packages/production-service/src/reviewer-session.js'),{treeDigest}=await import('../packages/production-service/src/files.js'),{sha256}=await import('../packages/production-service/src/contracts.js'),{PNG}=await import('pngjs');
 const start=t.mock.method(ReviewerSessions.prototype,'start',()=>{});const f=await fixture();let release!:()=>void;const gate=new Promise<void>(yes=>{release=yes;}),started:string[]=[];
 const config:any={dataRoot:join(f.root,'service'),apiToken:'test',accountId:'test',callbackBase:'http://localhost',callbackSecret:'test',ready:{},release:{releaseId:'test'},voicesPath:''};
 const service=await createProductionServer(config,undefined,{templateFrames:async(run,root,input,options)=>{
  started.push(input.renderRequestId);const project=join(root,'preview-snapshots',input.renderRequestId,'project');await fs.cp(join(root,'project'),project,{recursive:true});const sourceDigest=await treeDigest(project);await options.onSourceFrozen?.(sourceDigest);
  if(input.renderRequestId==='first')await gate;
  const readyFrames=[];for(const frame of input.frames){const png=new PNG({width:64,height:64});png.data.fill(255);const bytes=PNG.sync.write(png),path=join(root,`${input.renderRequestId}-${frame}.png`);await fs.writeFile(path,bytes);const record={frame,path,sha256:sha256(bytes)};readyFrames.push(record);await options.onFrameReady?.(record);}
  return {sourceDigest,readyFrames,overviewPaths:[],warnings:[]};
 }});
 try{
  service.repo.accept('test','analysis',{taskId:'queue',content:'甲。乙。',otherRequirements:'',plugin:{customTemplateId:'test'}});const a=service.repo.claim()!;service.repo.finish(a.runId,a.token,'succeeded',{});
  service.repo.accept('test','render',{taskId:'queue',basePlanVersion:a.planVersion,dataList:expected,otherRequirements:''});const run=service.repo.claim()!;service.runner.active.set(run.runId,new AbortController());await fs.cp(f.project,join(service.runner.runRoot(run),'project'),{recursive:true});
  const call=(name:string,payload:any)=>service.app.inject({method:'POST',url:`/internal/tools/${name}`,headers:{'x-run-id':run.runId,'x-run-token':run.token!},payload});
  assert.equal((await call('preview_template_frames',{renderRequestId:'first',frames:[0]})).statusCode,200);
  const second=await call('preview_template_frames',{renderRequestId:'second',frames:[35]});assert.equal(second.statusCode,200);assert.equal(second.json().state,'queued');
  assert.equal((await call('render_template',{renderRequestId:'forbidden',timelineRef:'renderer/timeline.json',checks:[]})).statusCode,409);
  const prepare={renderRequestIds:['first','second'],phase:'pre_export',waitMs:10};const waiting=(await call('prepare_review',prepare)).json();assert.equal(waiting.state,'waiting_media');assert.equal(start.mock.callCount(),0);assert.deepEqual(started,['first']);
  const pending=call('prepare_review',{...prepare,waitMs:3000});release();const ready=(await pending).json();assert.ok(ready.reviewId);assert.deepEqual(started,['first','second']);
  assert.equal(service.repo.db.prepare('SELECT COUNT(*) AS n FROM reviews').get()?.n,1);
  assert.equal((await call('prepare_review',prepare)).json().reviewId,ready.reviewId);
 }finally{release();await service.close();await fs.rm(f.root,{recursive:true,force:true});}
});
