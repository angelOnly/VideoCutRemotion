import test from "node:test";
import assert from "node:assert/strict";
import { mediaUsageState } from "../packages/media-intelligence/src/usage.js";

test("视频采用依据只定位绑定选段，不把80帧扩大成完整33秒作品", () => {
  const snapshot = {
    timeline: { fps: 24, items: [] },
    assets: [
      { id: "source", kind: "video", sourceHash: "fixed" },
      { id: "work", motion: { version: "v12", fps: 24, frameCount: 792, videoSources: [{ slot: "b", assetId: "source", sourceHash: "fixed", sourceStartMs: 628000, sourceEndMs: 631334, startFrame: 90, endFrame: 170 }] } }
    ],
    effectCues: [{ id: "cue", type: "ManagedMotion", status: "ready", startFrame: 100, endFrame: 892, assetBindings: [{ slot: "motion", assetId: "work" }] }]
  } as any;
  const use = mediaUsageState(snapshot, { effectCueId: "cue", motionVideoSlot: "b" })!;
  assert.deepEqual(use.frameRange, { startFrame: 190, endFrame: 270 });
  assert.deepEqual(use.range, { startMs: 628000, endMs: 631334 });
  const signature = use.signature;
  snapshot.assets[1].motion.videoSources[0].startFrame = 91;
  assert.notEqual(mediaUsageState(snapshot, { effectCueId: "cue", motionVideoSlot: "b" })!.signature, signature);
});
