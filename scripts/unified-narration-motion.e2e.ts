import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@videocut/application";
import { createTimelineItem } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";
import { hashMotionFile } from "../apps/render-worker/src/motion-video.js";
import { motionFixture } from "../tests/fixtures/managed-motion.js";

// 只在候选工作区生成工程标记片，不读取或修改正式项目与队列。
const require = createRequire(import.meta.url);
const { findAvailablePort } = require("../plugins/videoflowcut/scripts/runtime-launcher.mjs");
const { runCandidateRuntime } = require("../plugins/videoflowcut/scripts/candidate-runtime.mjs");
const root = await mkdtemp(join(tmpdir(),"vfc-unified-e2e-"));
const repoRoot=resolve(import.meta.dirname,".."); const pluginRoot=join(repoRoot,"plugins/videoflowcut");
const port=await findAvailablePort();
const args=["--repo-root",repoRoot,"--workspace",root,"--port",String(port),"--comfyui-bridge-url","http://127.0.0.1:18199"];
const app=createApplication(root);const created=app.createProject({name:"解说混合动效工程验收",profile:"presenter_motion"});
const projectId=created.snapshot.project.id,projectRoot=created.snapshot.project.rootPath;
const path=join(projectRoot,"assets/source/pattern.mp4");
await runProcess("ffmpeg",["-y","-v","error","-f","lavfi","-i","testsrc2=s=320x180:r=30:d=3","-c:v","libx264","-pix_fmt","yuv420p",path]);
const hash=await hashMotionFile(path);
const imported=app.registerImportedAsset({projectId,baseRevision:1,name:"逐帧工程标记",kind:"video",managedPath:"assets/source/pattern.mp4",sourceHash:hash,provenance:{source:"local_import",acquiredAt:new Date().toISOString()}});
app.applyMediaAnalysis({projectId,assetId:imported.asset.id,metadata:await probeMedia(path)});
app.repository.commit(projectId,app.readProject(projectId).revision.number,"候选画布与字幕",snapshot=>{
  Object.assign(snapshot.timeline,{width:320,height:180,fps:30,durationInFrames:90});
  snapshot.timeline.items.push(createTimelineItem({trackId:snapshot.timeline.tracks.find(t=>t.name==="Actor / A-roll")!.id,assetId:imported.asset.id,startFrame:0,endFrame:90,sourceStartFrame:0,sourceEndFrame:90}));
  snapshot.speechSegments.push({id:"technical-segment",semanticUnitIds:[],text:"工程测试 · 非实拍案例",order:0,pauseBefore:{durationMs:0,reason:"sentence"},status:"pending"});
  snapshot.timeline.captions.push({id:"technical-caption",speechSegmentId:"technical-segment",text:"工程测试 · 非实拍案例",startFrame:0,endFrame:90,style:"stable",precision:"segment_exact"});
});
app.intelligence.store.saveSource({id:"engineering-source",projectId,target:{assetId:imported.asset.id},identity:"original",hash,path,kind:"video",durationMs:3000,hasAudio:false,streams:[],createdAt:new Date().toISOString()});
app.intelligence.store.saveObservation({id:"engineering-observation",projectId,sourceId:"engineering-source",sourceHash:hash,range:{startMs:0,endMs:3000},depth:"review",modalities:["visual"],facts:[{modality:"visual",text:"自制逐帧工程标记，仅用于范围与采用协议验证",range:{startMs:0,endMs:3000},basis:"human",precision:"reviewed",keywords:[]}],unknowns:["非真实创作素材，没有观感结论"],context:"受控工程输入",rawText:"测试夹具声明，不是模型观察",version:{workflowId:"fixture",schemaVersion:"v1",model:"fixture",prompt:"fixture",preprocessing:"fixture"},jobId:"fixture",createdAt:new Date().toISOString()});
app.close();
const runtime=await runCandidateRuntime("ensure",args);
const transport=new StdioClientTransport({command:process.execPath,args:[join(pluginRoot,"scripts/mcp-launcher.mjs")],cwd:repoRoot,stderr:"pipe",env:{...getDefaultEnvironment(),VIDEOCUT_WORKSPACE:root,VIDEOFLOWCUT_PORT:String(port),COMFYUI_BRIDGE_URL:"http://127.0.0.1:18199"}});
const client=new Client({name:"统一方案候选验收",version:"1.0"});
const call=async(name:string,input:Record<string,unknown>={})=>{const response=await client.callTool({name,arguments:input});assert.ok(!response.isError,JSON.stringify(response));return JSON.parse((response.content as any[]).find(c=>c.type==="text").text);};
const revision=async()=>(await call("read_project",{project_id:projectId})).revision.number;
const wait=async(id:string)=>{for(let n=0;n<240;n++){const job=await call("track_job",{job_id:id});if(job.status==="succeeded")return job;if(job.status==="failed")throw new Error(JSON.stringify(job));await new Promise(r=>setTimeout(r,750));}throw new Error(`候选任务超时 ${id}`);};
try{
  await client.connect(transport);
  await client.listTools();
  const release=await call("read_runtime_release");assert.ok(release.aligned);assert.equal(release.mcpReleaseId,runtime.releaseId);
  const tools=(await client.listTools()).tools;
  assert.ok(tools.some(t=>t.name==="acquire_source_material"));
  for(const name of ["search_sources","read_source"])assert.ok(!tools.some(t=>t.name===name));
  const materialSchema = tools.find(t=>t.name==="acquire_source_material")!.inputSchema.properties!.input as any;
  assert.equal(materialSchema.anyOf.length,3);
  assert.ok(!materialSchema.anyOf[0].properties.pageWidth);
  const requirements=await call("manage_asset_requirements",{project_id:projectId,base_revision_id:await revision(),action:"create",title:"候选合同测试",purpose:"验证清空时长",visual_brief:"工程图像",min_duration_ms:4000});
  const requestId= requirements.snapshot.assetRequests.at(-1).id;
  const cleared=await call("manage_asset_requirements",{project_id:projectId,base_revision_id:await revision(),action:"update",asset_request_id:requestId,min_duration_ms:null});
  assert.equal(cleared.snapshot.assetRequests.at(-1).minDurationMs,undefined);
  const beforeInvalid=await revision();
  const invalidMaterial=await client.callTool({name:"acquire_source_material",arguments:{project_id:projectId,input:{baseRevision:beforeInvalid,idempotencyKey:"invalid-web-width",url:"https://example.com/",kind:"web_snapshot",pageWidth:1280,basis:"候选合同验证",purposes:["draft"]}}});
  assert.ok(invalidMaterial.isError);
  assert.equal(await revision(),beforeInvalid);
  const mismatch=await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/research/acquire`,{method:"POST",headers:{"content-type":"application/json","x-videoflowcut-release-id":"old"},body:JSON.stringify({query:"test"})});assert.equal((await mismatch.json()).error,"RUNTIME_RELEASE_MISMATCH");
  const acquiredSources: Array<Record<string, unknown>> = [];
  for (const sourceInput of [
    { url: "https://example.com/", kind: "web_snapshot", idempotencyKey: "public-page" },
    { url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", kind: "pdf", pages: [1], pageWidth: 640, idempotencyKey: "public-pdf" }
  ]) {
    const acquired = await wait((await call("acquire_source_material", { project_id: projectId, input: { ...sourceInput, baseRevision: await revision(), basis: "公开测试页面，仅候选工程验收", purposes: ["draft"] } })).id);
    assert.equal(acquired.result.assetIds.length, sourceInput.kind === "pdf" ? 2 : 1);
    acquiredSources.push(acquired.result);
  }
  const source=await readFile(join(repoRoot,"tests/fixtures/material-space-motion.tsx.txt"),"utf8");
  const props={sourceWidth:320,sourceHeight:180,viewBefore:{x:20,y:20,width:240,height:135},viewAfter:{x:0,y:0,width:320,height:180},cameraStartSec:0.1,cameraEndSec:1,scopeBefore:{x:30,y:40,width:60,height:60},scopeAfter:{x:20,y:20,width:280,height:130},scopeStartSec:1,scopeExpandedSec:1.6,scopeEndSec:2.5,marks:[{id:"marker",text:"测试",x:60,y:60,labelX:120,labelY:70,startSec:0.3,endSec:1.2}],background:"#111111",ink:"#ffffff",accent:"#ffcc00",labelFill:"#333333"};
  const work={...motionFixture,source,props,width:320,height:180,fps:30,durationInFrames:90,reference:undefined,videoBindings:{footage:{assetId:imported.asset.id,sourceStartMs:0,sourceEndMs:3000,decodeScale:1}}};
  const job=await call("submit_motion_work",{project_id:projectId,base_revision_id:await revision(),idempotency_key:"technical-v1",work});await wait(job.id);
  const first=await call("read_motion_work",{project_id:projectId,job_id:job.id});assert.equal(first.job.result.videoDecodes.footage.width,320);assert.equal(first.asset.motion.videoSources[0].sourceHash,hash);
  const scene=await call("create_scene",{project_id:projectId,base_revision_id:await revision(),type:"PresenterScene",title:"混合场面技术试作",purpose:"验证素材时钟与字幕合成",start_frame:0,end_frame:90});
  const cues=await call("manage_effect_cues",{project_id:projectId,base_revision_id:await revision(),scene_id:scene.snapshot.scenes.at(-1).id,type:"ManagedMotion",layer:"front",start_frame:0,end_frame:90,asset_bindings:[{slot:"motion",asset_id:first.asset.id}],semantic_anchor:{type:"absolute",relation:"land_on"},quality_rules:["semantic_anchor_required"]});
  const cueId=cues.snapshot.effectCues.at(-1).id;
  const preview=await wait((await call("render_preview_range",{project_id:projectId,revision:await revision(),from_frame:0,to_frame:90,idempotency_key:"preview-v1"})).id);
  const updated=await call("submit_motion_work",{project_id:projectId,base_revision_id:await revision(),idempotency_key:"technical-v2",work:{...work,previousAssetId:first.asset.id,props:{...props,cameraEndSec:1.2}}});await wait(updated.id);
  const second=await call("read_motion_work",{project_id:projectId,job_id:updated.id});assert.notEqual(second.asset.motion.version,first.asset.motion.version);
  await call("manage_effect_cues",{project_id:projectId,base_revision_id:await revision(),action:"update",cue_id:cueId,asset_bindings:[{slot:"motion",asset_id:second.asset.id}]});
  const revisedPreview=await wait((await call("render_preview_range",{project_id:projectId,revision:await revision(),from_frame:0,to_frame:90,idempotency_key:"preview-v2"})).id);
  const report={root,projectId,releaseId:runtime.releaseId,revision:await revision(),firstVersion:first.asset.motion.version,secondVersion:second.asset.motion.version,preview:preview.result,revisedPreview:revisedPreview.result,acquiredSources,scope:"真实 MCP、Worker、公开网页与 PDF 获取、固定源码、内部素材绑定、改版、字幕合成工程验证；标记素材不证明实拍质量，未配音和审美验收"};
  await writeFile(join(root,"unified-acceptance.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await client.close();await transport.close();await runCandidateRuntime("stop",args);}
