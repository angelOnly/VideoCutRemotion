import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@videocut/application";

test("短文件与缺省时长仍可获取；明确选段长度的变更与非法值维持版本合同", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-duration-contract-"));
  const app = createApplication(root);
  try {
    const projectId = app.createProject({name:"图片与视频时长"}).snapshot.project.id;
    const revision = () => app.readProject(projectId).revision.number;
    const request = app.manageAssetRequirement({ projectId, baseRevision: revision(), action:"create", title:"基站", purpose:"辨认基站", visualBrief:"真实图片或四秒以上视频", minDurationMs:4000 }).snapshot.assetRequests[0];
    const input = { projectId, baseRevision: revision(), assetRequestId:request.id, provider:"wikimedia-commons", query:"cell tower" };
    const common = { sourceUrl:"https://example.org/source", };
    const candidates = [
      {...common, originalAssetId:"image", name:"图片", kind:"image" as const},
      {...common, originalAssetId:"short", name:"短视频", kind:"video" as const, durationMs:3000},
      {...common, originalAssetId:"long", name:"长视频", kind:"video" as const, durationMs:4000},
      {...common, originalAssetId:"unknown", name:"未知时长", kind:"video" as const}
    ];
    const searched = app.recordAssetSearch({...input,candidates});
    assert.deepEqual(searched.candidates.map(c => c.hardFilterPassed), [true,true,true,true]);
    assert.equal(revision(),input.baseRevision);
    // 模拟升级前的第 2 版搜索缓存，修复后相同查询必须重新过滤。
    const oldSession = app.repository.mediaIntelligence.searches(projectId)[0];
    oldSession.id="legacy-duration-session";
    input.query="cell tower upgrade";
    oldSession.intent.query=input.query;
    oldSession.resultFormatVersion=2;
    oldSession.candidates[0].hardFilterPassed=false;
    oldSession.candidates[0].status="rejected";
    app.repository.mediaIntelligence.saveSearch(oldSession);
    const fresh = app.recordAssetSearch({...input,candidates});
    assert.equal(fresh.reused,false);
    assert.equal(fresh.candidates[0].hardFilterPassed,true);
    for (const minDurationMs of [0,-1,0.5,300001,Number.NaN]) {
      assert.throws(() => app.manageAssetRequirement({projectId,baseRevision:revision(),action:"update",assetRequestId:request.id,minDurationMs}), /最小时长/);
      assert.equal(revision(),input.baseRevision);
      assert.equal(app.readProject(projectId).snapshot.assetRequests[0].minDurationMs,4000);
    }
    app.manageAssetRequirement({projectId,baseRevision:revision(),action:"update",assetRequestId:request.id,title:"标题变更"});
    assert.equal(app.readProject(projectId).snapshot.assetRequests[0].minDurationMs,4000);
    app.manageAssetRequirement({projectId,baseRevision:revision(),action:"update",assetRequestId:request.id,minDurationMs:null});
    assert.equal(app.readProject(projectId).snapshot.assetRequests[0].minDurationMs,undefined);
    assert.equal(app.acquireAssetCandidate({projectId,baseRevision:revision(),assetCandidateId:fresh.candidates[2].id}).job.status, "queued");
    const cleared=app.recordAssetSearch({...input,baseRevision:revision(),candidates});
    assert.equal(cleared.reused,false);
    assert.notEqual(cleared.requestVersion,fresh.requestVersion);
    assert.ok(cleared.candidates.every(c => c.hardFilterPassed));
  } finally {app.close();await rm(root,{recursive:true,force:true});}
});
