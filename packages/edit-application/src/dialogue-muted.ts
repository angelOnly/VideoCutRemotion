import { z } from "zod";
import { DomainError } from "@videocut/domain";
import type { EditingApplication } from "./index.js";

/** 复用轨道静音合同，保留语音、字幕和时间线，恢复时无需重新生成。 */
export function setDialogueMuted(app: EditingApplication, projectId: string, baseRevision: number, value: boolean) {
  const muted = z.boolean().parse(value);
  const state = app.repository.commit(projectId, baseRevision, muted ? "静音 Dialogue 轨" : "恢复 Dialogue 轨声音", (snapshot, impact) => {
    const track = snapshot.timeline.tracks.find(entry => entry.name === "Dialogue" && entry.kind === "audio");
    if (!track) throw new DomainError("Dialogue 音轨不存在", "DIALOGUE_TRACK_NOT_FOUND");
    track.muted = muted;
    impact.changed.push(track.id);
    // Dialogue 同时影响背景音乐避让，整片声音须重新复核。
    if (snapshot.timeline.durationInFrames > 0) impact.dirtyRanges.push({ startFrame: 0, endFrame: snapshot.timeline.durationInFrames, reason: "Dialogue 静音状态变化，重新预览并复核混合" });
  });
  app.publish({ projectId, revision: state.revision.number, type: "revision" });
  return state;
}
