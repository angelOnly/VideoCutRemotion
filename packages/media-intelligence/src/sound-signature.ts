import type { ProjectSnapshot } from "@videocut/contracts";
import { digest } from "./index.js";

/** 审阅字段不影响声音；实际 Timeline、素材、人物和作品版本全部固定。 */
export function soundDependencySignature(snapshot: ProjectSnapshot) {
  return digest({ timeline: snapshot.timeline, audioCues: snapshot.audioCues.map(({ mixReview, updatedAt, ...cue }) => cue), speech: snapshot.speechAsset, script: snapshot.script,
    ...(snapshot.audioMixGainDb ? { audioMixGainDb: snapshot.audioMixGainDb } : {}),
    soundPlans: snapshot.soundPlans, effects: snapshot.effectCues, actor: snapshot.actorPerformances, cutaways: snapshot.cutaways,
    assets: snapshot.assets.map((asset) => ({ id: asset.id, path: asset.managedPath, hash: asset.sourceHash, status: asset.status, motion: asset.motion?.version })) });
}
