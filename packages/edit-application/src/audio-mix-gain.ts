import { z } from "zod";
import type { EditingApplication } from "./index.js";

export const audioMixGainSchema = z.number().finite().min(-48).max(24);

/** 设置绝对值而非累加，重发同一参数不会反复放大；Revision 仍须匹配。 */
export function setAudioMixGain(app: EditingApplication, projectId: string, baseRevision: number, value: number) {
  const gainDb = audioMixGainSchema.parse(value);
  const state = app.repository.commit(projectId, baseRevision, "设置整体混合增益", (snapshot, impact) => {
    snapshot.audioMixGainDb = gainDb;
    impact.changed.push("audioMixGainDb");
    if (snapshot.timeline.durationInFrames > 0) impact.dirtyRanges.push({ startFrame: 0, endFrame: snapshot.timeline.durationInFrames, reason: "整体混合增益已改变，需要重新测量与复核" });
  });
  app.publish({ projectId, revision: state.revision.number, type: "revision" });
  return state;
}
