import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { createApplication } from "@videocut/application";
import { sourceMaterialSchema } from "../packages/asset-acquisition/src/source-research.js";
import { publicAddress, publicSourceUrl } from "../packages/asset-acquisition/src/public-source.js";
import { runSourceMaterialAcquisition } from "../apps/job-worker/src/source-material-acquisition.js";
import { createMediaJobProcessor, runOneJob } from "../apps/job-worker/src/index.js";
import { createServer } from "../apps/server/src/app.js";
import { RevisionRenderer } from "../apps/render-worker/src/exporter.js";
import { probeMedia } from "@videocut/speech";
import { DomainError } from "@videocut/domain";

test("网页和图片合同不暴露 PDF 参数，错误提交不创建 Job 或 Revision", async () => {
  const root=await mkdtemp(join(tmpdir(),"vfc-material-schema-"));
  const app=createApplication(root);
  try {
    const projectId=app.createProject({name:"材料合同"}).snapshot.project.id;
    const common={baseRevision:1,idempotencyKey:"shape",url:"https://example.org/",};
    for(const kind of ["web_snapshot","image"] as const) {
      assert.equal(sourceMaterialSchema.safeParse({...common,kind}).success,true);
      for(const extra of [{pageWidth:1280},{pages:[1]}]) {
        assert.throws(()=>app.submitSourceMaterial(projectId,{...common,kind,...extra}));
        assert.equal(app.readProject(projectId).revision.number,1);
      }
    }
    assert.equal(sourceMaterialSchema.safeParse({...common,kind:"pdf",pages:[1],pageWidth:1280}).success,true);
    assert.deepEqual(app.listJobs(projectId),[]);
  } finally {app.close();await rm(root,{recursive:true,force:true});}
});

test("来源 HTTP 路由保留版本错误与参数错误的结构化响应", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-research-http-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  try {
    const projectId = application.createProject({ name: "错误合同" }).snapshot.project.id;
    const url = `/api/projects/${projectId}/research/acquire`;
    const mismatch = await app.inject({ method: "POST", url, headers: { "x-videoflowcut-release-id": "old" }, payload: { query: "test" } });
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.json().error, "RUNTIME_RELEASE_MISMATCH");
    const invalid = await app.inject({ method: "POST", url, headers: { "x-videoflowcut-release-id": mismatch.headers["x-videoflowcut-release-id"] as string }, payload: {} });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, "VALIDATION_ERROR");
    for (const action of ["search", "read"]) {
      const removed = await app.inject({ method: "POST", url: `/api/projects/${projectId}/research/${action}`, payload: {} });
      assert.equal(removed.statusCode, 404);
    }
  } finally { await app.close(); application.close(); await rm(root, { recursive: true, force: true }); }
});

test("公开来源拒绝内网、特殊地址、凭据及非法协议",async()=>{
  for(const ip of ["127.0.0.1","10.1.1.1","169.254.169.254","192.168.1.1","::1","::ffff:127.0.0.1","fc00::1","2001:db8::1"]) assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress("8.8.8.8"),true);
  for(const url of ["http://127.0.0.1/","http://[::1]/","file:///c:/secret","https://user:password@example.org/"]) await assert.rejects(publicSourceUrl(url));
});

test("截图导航保留地址拒绝根因，不被Chromium ERR_FAILED覆盖或写入素材",async()=>{
  const root=await mkdtemp(join(tmpdir(),"vfc-capture-error-"));const app=createApplication(root);
  try {
    const state=app.createProject({name:"截图失败根因"});const id=state.snapshot.project.id;
    const job=app.submitSourceMaterial(id,{baseRevision:1,idempotencyKey:"private",kind:"web_snapshot",url:"http://127.0.0.1/",});
    await assert.rejects(runSourceMaterialAcquisition(app,job),error=>(error as {code:string}).code==="SOURCE_URL_REJECTED");
    assert.equal(app.readProject(id).revision.number,1);
    assert.equal(app.readProject(id).snapshot.assets.length,0);
  }finally{app.close();await rm(root,{recursive:true,force:true});}
});

test("真实浏览器保留Referer，子资源失败保存待核验截图，主页面失败仍拒绝",async()=>{
  const root=await mkdtemp(join(tmpdir(),"vfc-capture-referer-"));const app=createApplication(root);
  const url="https://official.example.test/article";
  const html='<html><head><title>公开资料测试</title><link rel="stylesheet" href="https://fonts.example.test/fonts"></head><body>这是一段用于核验公开网页截图加载的足够长的真实测试文字，样式表需要浏览器提供来源信息才能加载。</body></html>';
  let rejectResource=false, references:string[]=[];
  const fetcher=async(raw:string,_budget:number,_signal?:AbortSignal,headers:Record<string,string>={})=>{
    const stylesheet=raw.includes("fonts.example.test");
    if(stylesheet){
      references.push(headers.referer);
      if(rejectResource || headers.referer!=="https://official.example.test/")throw new DomainError("来源返回 HTTP 404","SOURCE_DOWNLOAD_FAILED");
    }
    return {bytes:Buffer.from(stylesheet?"body { color: rgb(10, 20, 30); }":html),url:raw,mime:stylesheet?"text/css":"text/html",fetchedAt:new Date().toISOString()};
  };
  try {
    const id=app.createProject({name:"浏览器请求头"}).snapshot.project.id;
    const input={baseRevision:1,idempotencyKey:"referer",kind:"web_snapshot" as const,url,};
    const clean=await runSourceMaterialAcquisition(app,app.submitSourceMaterial(id,input),fetcher);
    assert.equal((clean.capture as {complete:boolean}).complete,true);
    assert.equal((clean.capture as {reviewStatus:string}).reviewStatus,"pending");
    assert.ok(references.length>0);
    assert.ok(references.every(value=>value==="https://official.example.test/"));
    assert.equal(app.readProject(id).snapshot.assets.length,1);
    const revision=app.readProject(id).revision.number;
    rejectResource=true;
    const partial=await runSourceMaterialAcquisition(app,app.submitSourceMaterial(id,{...input,baseRevision:revision,idempotencyKey:"missing-resource"}),fetcher);
    assert.deepEqual((partial.capture as {warnings:unknown[]}).warnings,[{url:"https://fonts.example.test/fonts",method:"GET",resourceType:"stylesheet",code:"SOURCE_DOWNLOAD_FAILED",message:"来源返回 HTTP 404"}]);
    assert.equal((partial.capture as {complete:boolean}).complete,false);
    assert.equal((partial.capture as {reviewStatus:string}).reviewStatus,"pending");
    assert.equal(app.readProject(id).snapshot.assets.length,2);
    const empty=await runSourceMaterialAcquisition(app,app.submitSourceMaterial(id,{...input,baseRevision:app.readProject(id).revision.number,idempotencyKey:"empty-resource"}),async(raw,...args)=>{
      if(raw.includes("fonts.example.test"))throw new DomainError("来源没有正文","SOURCE_EMPTY");
      return fetcher(raw,...args);
    });
    assert.equal((empty.capture as {warnings:Array<{code:string}>}).warnings[0].code,"SOURCE_EMPTY");
    const next=app.readProject(id).revision.number;
    await assert.rejects(runSourceMaterialAcquisition(app,app.submitSourceMaterial(id,{...input,baseRevision:next,idempotencyKey:"main-failure"}),async()=>{throw new DomainError("来源返回 HTTP 404","SOURCE_DOWNLOAD_FAILED");}),error=>(error as {code:string}).code==="SOURCE_DOWNLOAD_FAILED");
    assert.equal(app.readProject(id).revision.number,next);
    assert.equal(app.readProject(id).snapshot.assets.length,3);
  }finally{app.close();await rm(root,{recursive:true,force:true});}
});

test("统计POST仅记缺口且不发送，验证码与子资源安全错误仍原子拒绝",async()=>{
  const root=await mkdtemp(join(tmpdir(),"vfc-capture-gaps-"));const app=createApplication(root);
  let mode="beacon", forwarded=0;
  const fetcher=async(raw:string)=>{
    if(raw.includes("private-resource"))throw new DomainError("来源不能指向内网","SOURCE_URL_REJECTED");
    if(raw.includes("8.8.8.8")){forwarded++;throw new Error("统计请求不能被发送");}
    const extra=mode==="beacon"?'<script>navigator.sendBeacon("https://8.8.8.8/stats?credential=secret", "test")</script>':mode==="captcha"?'<div id="captcha">验证码</div>':'<link rel="stylesheet" href="https://official.example.test/private-resource">';
    return {bytes:Buffer.from(`<html><head><title>工程公开网页</title></head><body>这是用于验证页面正文截图的隔离测试文字，能够显示正文不表示统计请求必须成功，也不表示证据内容已经通过专业核验。${extra}</body></html>`),url:raw,mime:"text/html",fetchedAt:new Date().toISOString()};
  };
  try{
    const id=app.createProject({name:"截图缺口边界"}).snapshot.project.id;
    const input={baseRevision:1,idempotencyKey:"beacon",kind:"web_snapshot" as const,url:"https://official.example.test/",};
    const result=await runSourceMaterialAcquisition(app,app.submitSourceMaterial(id,input),fetcher);
    const capture=result.capture as {complete:boolean;reviewStatus:string;warnings:Array<{url:string;method:string;code:string}>};
    assert.equal(capture.complete,false);assert.equal(capture.reviewStatus,"pending");assert.equal(forwarded,0);
    assert.ok(capture.warnings.some(w=>w.url==="https://8.8.8.8/stats" && w.method==="POST" && w.code==="SOURCE_CAPTURE_REQUEST_BLOCKED"));
    assert.ok(!JSON.stringify(capture).includes("secret"));
    const revision=app.readProject(id).revision.number;
    for(const [next,code] of [["captcha","SOURCE_CAPTURE_UNAVAILABLE"],["private","SOURCE_URL_REJECTED"]]){
      mode=next;
      await assert.rejects(runSourceMaterialAcquisition(app,app.submitSourceMaterial(id,{...input,baseRevision:revision,idempotencyKey:next}),fetcher),error=>(error as {code:string}).code===code);
      assert.equal(app.readProject(id).revision.number,revision);assert.equal(app.readProject(id).snapshot.assets.length,1);
    }
  }finally{app.close();await rm(root,{recursive:true,force:true});}
});

test("受管取得真实 PNG、幂等完成、媒体分析与错误页拒绝",async()=>{
  const root=await mkdtemp(join(tmpdir(),"vfc-source-worker-")); const app=createApplication(root);
  try {
    const state=app.createProject({name:"来源获取"});const id=state.snapshot.project.id;
    const input={baseRevision:1,idempotencyKey:"image",url:"https://example.org/image",kind:"image" as const,};
    const job=app.submitSourceMaterial(id,input);assert.equal(app.submitSourceMaterial(id,input).id,job.id);
    assert.throws(()=>app.submitSourceMaterial(id,{...input,url:"https://example.org/other"}),/幂等/);
    const png=new PNG({width:64,height:64});png.data.fill(255);
    const fetcher=async()=>({bytes:PNG.sync.write(png),url:input.url,mime:"image/png",fetchedAt:new Date().toISOString()});
    const result=await runSourceMaterialAcquisition(app,job,fetcher);
    const revision=app.readProject(id).revision.number;
    assert.deepEqual((await runSourceMaterialAcquisition(app,job,async()=>{throw new Error("不可重新获取");})).assetIds,result.assetIds);
    assert.equal(app.readProject(id).revision.number,revision);
    app.updateJob(job.id,{status:"succeeded",result});
    await runOneJob(app,createMediaJobProcessor(app));
    assert.equal(app.readProject(id).snapshot.assets[0].status,"ready");
    const bad=app.submitSourceMaterial(id,{...input,baseRevision:app.readProject(id).revision.number,idempotencyKey:"bad"});
    await assert.rejects(runSourceMaterialAcquisition(app,bad,async()=>({...await fetcher(),mime:"text/html",bytes:Buffer.from("login")})),/类型/);
    assert.equal(app.readProject(id).snapshot.assets.length,1);assert.equal(app.readProject(id).snapshot.timeline.items.length,0);
  } finally {app.close();await rm(root,{recursive:true,force:true});}
});

/** 生成可被 Poppler 实际解析的工程 PDF；不冒充外部研究证据。 */
function engineeringPdf(): Buffer {
  const content = "BT /F1 24 Tf 40 160 Td (SOURCE MATERIAL TEST) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let text = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(text); text += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test("PDF 原文件及选页登记、证据绑定并真实渲染，越界页原子拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-source-pdf-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "PDF 工程验证", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const revision = () => app.readProject(projectId).revision.number;
    const input = { baseRevision: revision(), idempotencyKey: "pdf", url: "https://example.org/engineering.pdf", kind: "pdf" as const, pages: [1], pageWidth: 640, };
    const fetcher = async () => ({ bytes: engineeringPdf(), url: input.url, mime: "application/pdf", fetchedAt: new Date().toISOString() });
    const job = app.submitSourceMaterial(projectId, input);
    const result = await runSourceMaterialAcquisition(app, job, fetcher);
    app.updateJob(job.id, { status: "succeeded", result });
    await runOneJob(app, createMediaJobProcessor(app));
    await runOneJob(app, createMediaJobProcessor(app));
    const assets = app.readProject(projectId).snapshot.assets;
    const document = assets.find(asset => asset.kind === "document")!;
    const page = assets.find(asset => asset.kind === "image")!;
    assert.equal(assets.length, 2);
    assert.equal(page.status, "ready");
    const pixels = PNG.sync.read(await readFile(join(created.snapshot.project.rootPath, page.managedPath)));
    assert.equal(pixels.width, 640);
    const capture = app.manageEvidenceCapture({ projectId, baseRevision: revision(), action: "create", sourceAssetId: document.id, snapshotAssetId: page.id, sourceTitle: "自制工程文档", publisher: "工程测试", sourceUrl: input.url, capturedAt: new Date().toISOString(), pageOrRange: "第 1 页", excerpt: "SOURCE MATERIAL TEST", claim: "测试 PDF 页面可见", limitation: "仅工程测试，不是外部事实证据", highlights: [{ x: 0.1, y: 0.2, width: 0.8, height: 0.2, label: "测试正文" }] }).snapshot.evidenceCaptures[0];
    const story = app.updateStory({ projectId, baseRevision: revision(), title: "工程文档", summary: "检查真实 PDF 页面合成", beats: [{ title: "页面", purpose: "工程可见性" }] });
    const map = app.manageNarrativeMap({ projectId, baseRevision: revision(), viewerQuestion: "页面是否正确显示", promisedModel: "固定页面", conclusion: "页面能参与合成", beats: [{ narrativeBeatId: story.snapshot.story.beats[0].id, enteringKnowledge: "工程输入", question: "页面是什么", newKnowledge: "看见页面", deferredInformation: "无", claim: "可见", evidenceCaptureIds: [capture.id] }] });
    app.compileExplainerScenes({ projectId, baseRevision: revision(), plans: [{ title: "页面", purpose: "工程验证", startFrame: 0, endFrame: 30, narrativeMapBeatId: map.snapshot.narrativeMap!.beats[0].id, kind: "EvidenceDocument", primaryTask: "显示 PDF 页面", evidenceCaptureId: capture.id, props: { focus: "工程页面" }, states: [{ phase: "entry", startFrame: 0, endFrame: 5, label: "进入" }, { phase: "progressive", startFrame: 5, endFrame: 10, label: "展开" }, { phase: "settled", startFrame: 10, endFrame: 25, label: "查看" }, { phase: "exit", startFrame: 25, endFrame: 30, label: "退出" }] }] });
    app.repository.commit(projectId, revision(), "候选画幅", snapshot => { Object.assign(snapshot.timeline, { width: 640, height: 360, durationInFrames: 30 }); });
    const output = join(root, "evidence.mp4");
    await new RevisionRenderer(undefined, 2).renderRange(app.readProject(projectId).snapshot, 0, 30, output);
    const media = await probeMedia(output);
    assert.equal(media.width, 640);
    assert.ok(media.durationMs >= 1000);
    const invalid = app.submitSourceMaterial(projectId, { ...input, baseRevision: revision(), idempotencyKey: "invalid-page", pages: [2] });
    await assert.rejects(runSourceMaterialAcquisition(app, invalid, fetcher), /页码越界/);
    assert.equal(app.readProject(projectId).snapshot.assets.length, 2);
  } finally { app.close(); await rm(root, { recursive: true, force: true }); }
});
