import { createHash } from "node:crypto";
import { inspectEffectContentContract, type EffectAudioEvent, type EffectCue, type ImpactReport, type ProjectSnapshot } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";

export type EffectAudioEventInput = Omit<EffectAudioEvent, "cueSignature" | "syncOffsetFrames" | "meaning"> & { syncOffsetFrames?: number };

function canBindEffectAudio(snapshot: ProjectSnapshot, cue: EffectCue): boolean {
  const scene = snapshot.scenes.find((entry) => entry.id === cue.sceneId);
  // Presenter 编译后 Scene 仍为 draft；能否使用动效应遵循渲染内容合同，而非误用解释片的 ready 门禁。
  return !!scene && scene.status !== "stale" && cue.status === "ready"
    && inspectEffectContentContract(cue, snapshot.assets, snapshot.timeline).ready;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** 只允许纯平移保持同步；作品、Props、运动或长度改变均须重新确认内部落点。 */
export function effectAudioSignature(snapshot: ProjectSnapshot, cue: EffectCue): string {
  const assets = cue.assetBindings.map((binding) => {
    const asset = snapshot.assets.find((entry) => entry.id === binding.assetId);
    return { ...binding, hash: asset?.sourceHash, version: asset?.motion?.version, status: asset?.status };
  });
  return createHash("sha256").update(JSON.stringify(canonical({ type: cue.type, layer: cue.layer,
    fps: snapshot.timeline.fps,
    sceneId: cue.sceneId, duration: cue.endFrame - cue.startFrame, props: cue.props, motion: cue.motion,
    intensity: cue.intensity, spatialAnchor: cue.spatialAnchor, stylePackId: cue.stylePackId, assets }))).digest("hex");
}

export function bindEffectAudioEvent(snapshot: ProjectSnapshot, input: EffectAudioEventInput, eventFrame: number): EffectAudioEvent {
  const cue = snapshot.effectCues.find((entry) => entry.id === input.effectCueId);
  if (!cue || !canBindEffectAudio(snapshot, cue)) throw new DomainError("声音只能绑定内容可渲染且场景未失效的动效", "SFX_EFFECT_NOT_READY");
  const syncOffsetFrames = input.syncOffsetFrames ?? 0;
  let meaning: string | undefined;
  if (input.eventId) {
    const work = cue.assetBindings.map((binding) => snapshot.assets.find((asset) => asset.id === binding.assetId)).find((asset) => asset?.motion?.eventMap);
    const map = work?.motion?.eventMap;
    const event = map?.events.find((entry) => entry.id === input.eventId);
    if (!map || !event || input.workVersion !== map.version || map.version !== work?.motion?.version) throw new DomainError("请使用当前作品输出的动作事件与版本", "SFX_MOTION_EVENT_STALE");
    const start = Math.round(event.startFrame * snapshot.timeline.fps / map.fps);
    const end = event.endFrame === undefined ? undefined : Math.round(event.endFrame * snapshot.timeline.fps / map.fps);
    // 同一动作可在起势/落定发一声，也可用完整包络贯穿；持续范围不能伪造。
    const pointEnd = end === undefined ? undefined : Math.min(end, cue.endFrame - cue.startFrame - 1);
    const matches = input.endLocalFrame === undefined ? input.localFrame === start || input.localFrame === pointEnd : input.localFrame === start && input.endLocalFrame === end;
    if (!matches) throw new DomainError("声音绑定与作品的实际事件范围不一致", "SFX_MOTION_EVENT_MISMATCH");
    meaning = event.meaning;
  } else if (input.workVersion || input.endLocalFrame !== undefined) throw new DomainError("新范围绑定需要来自作品的事件 ID", "SFX_MOTION_EVENT_REQUIRED");
  if (!input.eventName.trim() || input.eventName.length > 160 || !Number.isInteger(input.localFrame) || input.localFrame < 0 || input.localFrame >= cue.endFrame - cue.startFrame || !Number.isInteger(syncOffsetFrames)) {
    throw new DomainError("必须提供明确动作名称、有效局部帧和整数声画偏移", "INVALID_SFX_EFFECT_EVENT");
  }
  if (eventFrame !== cue.startFrame + input.localFrame + syncOffsetFrames) throw new DomainError("可听事件帧与所绑定的动效局部动作不一致", "SFX_EFFECT_EVENT_MISMATCH");
  return { ...input, meaning, eventName: input.eventName.trim(), syncOffsetFrames, cueSignature: effectAudioSignature(snapshot, cue) };
}

/** 在同一 Revision 事务统一对账，覆盖修改、移除、重编译和作品换绑等入口。 */
export function reconcileEffectAudioEvents(snapshot: ProjectSnapshot, impact: ImpactReport): void {
  const audioItems = new Set(snapshot.audioCues.map((audio) => audio.timelineItemId));
  const programEnd = snapshot.timeline.items.filter((item) => !item.disabled && !audioItems.has(item.id)).reduce((end, item) => Math.max(end, item.endFrame), 0);
  for (const audio of snapshot.audioCues) {
    const binding = audio.effectEvent;
    if (!binding || audio.status === "stale") continue;
    const item = snapshot.timeline.items.find((entry) => entry.id === audio.timelineItemId);
    const cue = snapshot.effectCues.find((entry) => entry.id === binding.effectCueId);
    const event = cue ? cue.startFrame + binding.localFrame + binding.syncOffsetFrames : -1;
    const delta = event - (audio.eventFrame ?? -1);
    const invalid = !item || !cue || !canBindEffectAudio(snapshot, cue)
      || effectAudioSignature(snapshot, cue) !== binding.cueSignature || audio.kind !== "sfx"
      || !Number.isInteger(binding.localFrame) || binding.localFrame < 0 || binding.localFrame >= cue.endFrame - cue.startFrame
      || !Number.isInteger(binding.syncOffsetFrames) || !Number.isInteger(audio.eventFrame) || !Number.isInteger(audio.onsetOffsetFrames)
      || item.startFrame !== (audio.eventFrame! - audio.onsetOffsetFrames!)
      || binding.endLocalFrame !== undefined && (!audio.sustained || item.endFrame + delta !== cue!.startFrame + binding.endLocalFrame + binding.syncOffsetFrames)
      || item.startFrame + delta < 0 || item.endFrame + delta > programEnd;
    if (invalid) {
      audio.status = "stale";
      audio.updatedAt = new Date().toISOString();
      impact.stale.push(audio.id);
      impact.changed.push(audio.id);
      if (item) {
        item.disabled = true;
        impact.changed.push(item.id);
        impact.dirtyRanges.push({ startFrame: item.startFrame, endFrame: item.endFrame, reason: "动效事件已变更，停用旧声音等待复核" });
      }
      impact.warnings.push(`音效“${audio.purpose}”绑定的动效版本、时序或范围已失效；需重新确认具体动作，不能只增大音量或沿用旧帧。`);
    } else if (item && delta !== 0) {
      const previous = { startFrame: item.startFrame, endFrame: item.endFrame, reason: "清理音效原位置" };
      item.startFrame += delta;
      item.endFrame += delta;
      audio.eventFrame = event;
      audio.mixReview = "needs_review";
      audio.updatedAt = new Date().toISOString();
      impact.changed.push(audio.id, item.id);
      impact.dirtyRanges.push(previous, { startFrame: item.startFrame, endFrame: item.endFrame, reason: "音效随同版本动效平移，声画需复审" });
    }
  }
}
