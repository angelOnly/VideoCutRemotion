import type { MediaUsageTarget, ProjectSnapshot } from "@videocut/contracts";
import { resolveCompositionReachability } from "@videocut/domain";
import { digest } from "./index.js";

/** 同一素材的多次使用独立定位，避免一次纠错污染所有未关联使用。 */
export function mediaUsageState(snapshot: ProjectSnapshot, target: MediaUsageTarget) {
  const item = target.timelineItemId ? snapshot.timeline.items.find((entry) => entry.id === target.timelineItemId) : undefined;
  const effect = target.effectCueId ? snapshot.effectCues.find((entry) => entry.id === target.effectCueId) : undefined;
  if (target.motionImageSlot) {
    const work = snapshot.assets.find(a => a.id === effect?.assetBindings.find(b => b.slot === "motion")?.assetId);
    const source = work?.motion?.imageSources?.find(image => image.slot === target.motionImageSlot);
    const asset = snapshot.assets.find(a => a.id === source?.assetId);
    if (!effect || effect.type !== "ManagedMotion" || !work?.motion || !source || asset?.kind !== "image" || asset.sourceHash !== source.sourceHash) return undefined;
    return { asset, range: undefined, frameRange: { startFrame: effect.startFrame, endFrame: effect.endFrame }, active: effect.status === "ready", audioPolicy: "not_applicable" as const,
      signature: digest({ target, effect, work: [work.id, work.motion.version], source, fps: snapshot.timeline.fps }) };
  }
  if (target.motionVideoSlot) {
    const work = snapshot.assets.find(a => a.id === effect?.assetBindings.find(b => b.slot === "motion")?.assetId);
    const source = work?.motion?.videoSources?.find(v => v.slot === target.motionVideoSlot);
    const asset = snapshot.assets.find(a => a.id === source?.assetId);
    if (!effect || effect.type !== "ManagedMotion" || !work?.motion || !source || !asset || asset.sourceHash !== source.sourceHash) return undefined;
    // 内部视频只检查实际在作品中出现的源范围。
    const ratio = snapshot.timeline.fps / work.motion.fps;
    const frameRange = {
      startFrame: effect.startFrame + Math.floor((source.startFrame ?? 0) * ratio),
      endFrame: Math.min(effect.endFrame, effect.startFrame + Math.ceil((source.endFrame ?? work.motion.frameCount) * ratio))
    };
    return { asset, range: { startMs: source.sourceStartMs, endMs: source.sourceEndMs }, frameRange, active: effect.status === "ready" && frameRange.endFrame > frameRange.startFrame, audioPolicy: "mute" as const,
      signature: digest({ target, effect, work: [work.id, work.motion.version], source, fps: [snapshot.timeline.fps, work.motion.fps] }) };
  }
  const binding = effect?.assetBindings.find((entry) => entry.slot === target.slot);
  const asset = snapshot.assets.find((entry) => entry.id === (item?.assetId ?? binding?.assetId));
  if (!asset || (!item && !binding)) return undefined;
  const cutaway = item && snapshot.cutaways.find((entry) => entry.timelineItemId === item.id);
  const frameRange = { startFrame: item?.startFrame ?? effect!.startFrame, endFrame: item?.endFrame ?? effect!.endFrame };
  const range = item && !["image", "document"].includes(asset.kind) ? { startMs: item.sourceStartFrame * 1000 / snapshot.timeline.fps, endMs: item.sourceEndFrame * 1000 / snapshot.timeline.fps } : undefined;
  return { asset, range, frameRange, active: item ? !item.disabled : effect!.status === "ready", audioPolicy: item?.mediaAudioPolicy,
    signature: digest({ target, asset: [asset.id, asset.sourceHash], fps: snapshot.timeline.fps, item, cutaway, effect }) };
}

export function mediaUsageProblem(snapshot: ProjectSnapshot, target: MediaUsageTarget): string | undefined {
  const usage = mediaUsageState(snapshot, target);
  if (!usage) return "实际绑定的素材、槽位或源哈希不一致";
  if (usage.asset.status !== "ready") return "实际绑定素材尚未技术就绪";
  if (target.motionVideoSlot && !["video", "actor_video"].includes(usage.asset.kind)) return "内部视频槽位绑定了非视频素材";
  if (usage.range && (!Number.isFinite(usage.range.startMs) || !Number.isFinite(usage.range.endMs) || usage.range.startMs < 0 || usage.range.endMs <= usage.range.startMs || usage.range.endMs > (usage.asset.metadata?.durationMs ?? 0) + 1000 / snapshot.timeline.fps)) return "实际源范围越界或无效";
  return undefined;
}

/** 只检查实际引用，不读取旧采用状态、观察覆盖或审核签名。 */
export function mediaUsageFindings(snapshot: ProjectSnapshot) {
  const reachable = resolveCompositionReachability(snapshot);
  const targets: MediaUsageTarget[] = snapshot.timeline.items.filter(item => reachable.videoItemIds.has(item.id) || reachable.audioItemIds.has(item.id)).map(item => ({ timelineItemId: item.id }));
  for (const cue of snapshot.effectCues.filter(cue => cue.status === "ready")) {
    targets.push(...cue.assetBindings.map(binding => ({ effectCueId: cue.id, slot: binding.slot })));
    const work = snapshot.assets.find(asset => asset.id === cue.assetBindings.find(binding => binding.slot === "motion")?.assetId)?.motion;
    targets.push(...(work?.imageSources ?? []).map(source => ({ effectCueId: cue.id, motionImageSlot: source.slot })));
    targets.push(...(work?.videoSources ?? []).map(source => ({ effectCueId: cue.id, motionVideoSlot: source.slot })));
  }
  return targets.flatMap(target => {
    const reason = mediaUsageProblem(snapshot, target);
    const object = target.timelineItemId ? snapshot.timeline.items.find(item => item.id === target.timelineItemId)! : snapshot.effectCues.find(cue => cue.id === target.effectCueId)!;
    return reason ? [{ objectId: object.id, frameRange: { startFrame: object.startFrame, endFrame: object.endFrame }, reason }] : [];
  });
}
