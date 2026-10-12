import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectSnapshot, MediaAdoption } from "@videocut/contracts";
import { mediaUsageState, mediaUsageProblem, mediaUsageFindings } from "../packages/media-intelligence/src/usage.js";

test("内部视频直接按源身份与范围校验，历史资格与作品改版不产生阻塞",()=>{
  const snapshot={assets:[{id:"source",kind:"video",status:"ready",sourceHash:"hash",metadata:{durationMs:2000}},{id:"work",kind:"video",status:"ready",motion:{version:"v1",fps:30,frameCount:30,videoSources:[{slot:"footage",assetId:"source",sourceHash:"hash",sourceStartMs:200,sourceEndMs:1000}]}}],timeline:{fps:30,items:[]},effectCues:[{id:"cue",type:"ManagedMotion",status:"ready",startFrame:0,endFrame:30,assetBindings:[{slot:"motion",assetId:"work"}]}],cutaways:[]} as unknown as ProjectSnapshot;
  const target={effectCueId:"cue",motionVideoSlot:"footage"};
  snapshot.timeline.tracks=[];
  assert.equal(mediaUsageState(snapshot,target)!.audioPolicy,"mute");
  assert.equal(mediaUsageProblem(snapshot,target),undefined);
  assert.deepEqual(mediaUsageFindings(snapshot),[]);
  snapshot.mediaAdoptions=[{id:"old",status:"needs_review",assetId:"source",sourceHash:"old",observationIds:[],range:{startMs:0,endMs:1},uses:[{target,signature:"expired"}]} as unknown as MediaAdoption];
  snapshot.assets[1].motion!.version="v2";
  assert.deepEqual(mediaUsageFindings(snapshot),[]);
  snapshot.assets[1].motion!.videoSources![0].sourceEndMs=3000;
  assert.match(mediaUsageProblem(snapshot,target)!,/源范围/);
  snapshot.assets[0].sourceHash="changed";
  assert.match(mediaUsageProblem(snapshot,target)!,/源哈希/);
  assert.match(mediaUsageProblem(snapshot,{...target,motionVideoSlot:"missing"})!,/槽位/);
});
