import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "@videocut/application";
import { WikimediaCommonsProvider } from "@videocut/acquisition";
import { decodeSearchCursor, encodeSearchCursor } from "../packages/asset-acquisition/src/cursor.js";

test("升级前 JPEG 会话历史可读，新搜索与页缓存隔离且不改创作 Revision",async()=>{
  const root=await mkdtemp(join(tmpdir(),"vfc-search-upgrade-"));const app=createApplication(root);
  try{
    const created=app.createProject({name:"旧缓存升级"});
    const state=app.manageAssetRequirement({projectId:created.snapshot.project.id,baseRevision:1,action:"create",title:"动作",purpose:"看动作",visualBrief:"真实手部动作",role:"b_roll",});
    const input={projectId:state.snapshot.project.id,baseRevision:state.revision.number,assetRequestId:state.snapshot.assetRequests[0].id,provider:"wikimedia-commons",query:"hand",mediaType:"video" as const};
    const candidate={originalAssetId:"1",name:"动作",kind:"video" as const,sourceUrl:"https://pexels.com/video/1",previewUrl:"https://images.pexels.com/cover.jpg",mimeType:"video/mp4",};
    const original=app.recordAssetSearch({...input,query:"legacy seed",candidates:[candidate]});
    const session=app.repository.mediaIntelligence.searches(input.projectId)[0];delete session.resultFormatVersion;session.id="legacy-session";session.intent.query=input.query;app.repository.mediaIntelligence.saveSearch(session);
    const legacy={...original,sessionId:session.id};
    const upgraded=app.recordAssetSearch({...input,candidates:[{...candidate,previewUrl:"https://videos.pexels.com/video.mp4"}]});
    assert.equal(upgraded.reused,false);assert.notEqual(upgraded.sessionId,legacy.sessionId);assert.match(upgraded.candidates[0].previewUrl!,/mp4$/);
    assert.match(app.readAssetCandidate({projectId:input.projectId,assetCandidateId:legacy.candidates[0].id}).candidate.previewUrl!,/jpg$/);
    assert.equal(app.recordAssetSearch({...input,candidates:[]}).reused,true);
    const next=encodeSearchCursor("wikimedia-commons",input,2);
    assert.equal(app.recordAssetSearch({...input,cursor:next,candidates:[]}).reused,false);
    assert.equal(app.readProject(input.projectId).revision.number,state.revision.number);
    for(const invalid of [{...input,query:"other"},{...input,mediaType:"image"},{...input,provider:"youtube"}]) assert.throws(()=>decodeSearchCursor(invalid.provider,{...invalid,cursor:next}),/游标/);
  }finally{app.close();await rm(root,{recursive:true,force:true});}
});

test("Commons continue 按原查询继续且末页不捏造游标",async()=>{
  const offsets:Array<string|null>=[];
  const provider=new WikimediaCommonsProvider({fetchImpl:async raw=>{const url=new URL(String(raw)); if(url.searchParams.has("list")){offsets.push(url.searchParams.get("sroffset"));return Response.json({continue:offsets.length===1?{sroffset:12,continue:"-||"}:undefined,query:{search:[{title:"File:demo.png"}]}});}return Response.json({query:{pages:[{title:"File:demo.png",imageinfo:[{url:"https://upload.wikimedia.org/demo.png",mime:"image/png",width:100,height:100,extmetadata:{}}]}]}});}});
  const input={request:{queryHints:[]} as any,query:"demo",mediaType:"image" as const};const first=await provider.searchDetailed(input);assert.ok(first.nextCursor);assert.equal((await provider.searchDetailed({...input,cursor:first.nextCursor})).nextCursor,undefined);assert.deepEqual(offsets,[null,"12"]);
});

test("Commons 空候选页仍保留服务端继续位置", async () => {
  const provider = new WikimediaCommonsProvider({ fetchImpl: async () => Response.json({ continue: { sroffset: 12 }, query: { search: [] } }) });
  const input = { request: { queryHints: [] } as any, query: "demo", mediaType: "image" as const };
  const result = await provider.searchDetailed(input);
  assert.deepEqual(result.candidates, []);
  assert.equal(decodeSearchCursor(provider.name, { ...input, cursor: result.nextCursor }), 12);
});
