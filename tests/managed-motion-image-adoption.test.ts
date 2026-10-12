import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApplication } from "@videocut/application";
import type { MediaAdoption, MediaUsageTarget, ProjectSnapshot } from "@videocut/contracts";
import { registerMediaIntelligenceRoutes, registerMediaIntelligenceTools } from "../apps/server/src/media-intelligence-tools.js";
import { mediaUsageFindings, mediaUsageProblem, mediaUsageState } from "../packages/media-intelligence/src/usage.js";
import { motionFixture } from "./fixtures/managed-motion.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vfc-image-adoption-"));
  const app = createApplication(root);
  const initial = app.createProject({ name: "内部图片采用合同回归" });
  const projectId = initial.snapshot.project.id;
  const rev = () => app.readProject(projectId).revision.number;
  const bytes = Buffer.from("isolated image identity fixture");
  await writeFile(join(initial.snapshot.project.rootPath, "assets/photo.png"), bytes);
  const image = app.registerImportedAsset({ projectId, baseRevision: rev(), name: "测试图片身份", kind: "image", managedPath: "assets/photo.png", sourceHash: createHash("sha256").update(bytes).digest("hex") }).asset;
  app.applyMediaAnalysis({ projectId, assetId: image.id, metadata: { durationMs: 0, width: 10, height: 10, hasAudio: false } });
  app.repository.commit(projectId, rev(), "隔离测试画布", snapshot => { Object.assign(snapshot.timeline, { width: 320, height: 320, fps: 30 }); });
  const job = app.submitManagedMotion({ projectId, baseRevision: rev(), idempotencyKey: "image", work: { ...motionFixture, imageBindings: { photo: image.id } } });
  // 本夹具只验证登记与采用合同，不把模拟完成当作真实渲染或审美证据。
  const work = app.completeManagedMotion({ projectId, jobId: job.id, engineVersion: "fixture", sourceHash: "fixture-preview", metadata: { durationMs: 600, width: 320, height: 320, fps: 30, hasAudio: false } });
  app.updateJob(job.id, { status: "succeeded", result: { assetId: work.id } });
  const scene = app.createScene({ projectId, baseRevision: rev(), type: "ExplainerScene", title: "图片采用", purpose: "隔离协议回归", startFrame: 0, endFrame: 18 }).snapshot.scenes.at(-1)!;
  const cue = app.createEffectCue({ projectId, baseRevision: rev(), sceneId: scene.id, type: "ManagedMotion", layer: "fullscreen", startFrame: 0, endFrame: 18, assetBindings: [{ slot: "motion", assetId: work.id }] }).snapshot.effectCues.at(-1)!;
  return { app, projectId, image, work, job, cue, rev, close: async () => { app.close(); await rm(root, { recursive: true, force: true }); } };
}

test("图片无任何观察与审核即可绑定，MCP及HTTP不再发布资格写入口", async () => {
  const f=await fixture(), server=Fastify();
  try {
    const before=f.rev(), snapshot=f.app.readProject(f.projectId).snapshot;
    assert.equal(snapshot.mediaAdoptions?.length??0,0);
    assert.deepEqual(mediaUsageFindings(snapshot),[]);
    const names:string[]=[];
    registerMediaIntelligenceTools({registerTool:(name:string)=>names.push(name)} as unknown as McpServer,f.app,id=>id??f.projectId);
    assert.ok(!names.includes("adopt_media_fragment"));assert.ok(!names.includes("bind_media_adoption"));
    assert.ok(names.includes("analyze_media"));
    registerMediaIntelligenceRoutes(server,f.app);
    for(const route of ["adopt","bind"]){
      const response=await server.inject({method:"POST",url:`/api/projects/${f.projectId}/media-fragments/${route}`,payload:{}});
      assert.equal(response.statusCode,404);
    }
    assert.equal(f.rev(),before);
    const changed=structuredClone(snapshot);changed.assets.find(asset=>asset.id===f.image.id)!.sourceHash="different";
    assert.ok(mediaUsageFindings(changed).some(finding=>finding.reason.includes("源哈希")));
    assert.deepEqual(mediaUsageFindings(snapshot),[]);
  } finally {await server.close();await f.close();}
});
