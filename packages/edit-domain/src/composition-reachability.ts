import { inspectEffectContentContract, type ProjectSnapshot } from "@videocut/contracts";

/**
 * 当前 Composition 真正会消费的对象集合。
 *
 * 它不是第二份项目状态：每次均从不可变 Revision Snapshot 即时推导。Renderer、
 * 交付预检、来源清单和质量中的素材就绪检查必须共用这一边界，避免旧对象、
 * 隐藏轨道或不会渲染的 Cue 被误算为成片依赖。
 */
export interface CompositionReachability {
  videoItemIds: ReadonlySet<string>;
  audioItemIds: ReadonlySet<string>;
  effectCueIds: ReadonlySet<string>;
  explainerProgramIds: ReadonlySet<string>;
  assetIds: ReadonlySet<string>;
}

export function resolveCompositionReachability(snapshot: ProjectSnapshot): CompositionReachability {
  const tracksById = new Map(snapshot.timeline.tracks.map((track) => [track.id, track]));
  const staleCutawayItemIds = new Set((snapshot.cutaways ?? [])
    .filter((cutaway) => cutaway.status === "stale")
    .map((cutaway) => cutaway.timelineItemId));
  const videoItemIds = new Set(snapshot.timeline.items
    .filter((item) => {
      const track = tracksById.get(item.trackId);
      return track?.kind === "video" && !track.hidden && !item.disabled && !staleCutawayItemIds.has(item.id);
    })
    .map((item) => item.id));
  const audioItemIds = new Set(snapshot.timeline.items
    .filter((item) => {
      const track = tracksById.get(item.trackId);
      return track?.kind === "audio" && !track.muted && !item.disabled;
    })
    .map((item) => item.id));
  const effectCueIds = new Set((snapshot.effectCues ?? [])
    .filter((cue) => cue.status === "ready" && inspectEffectContentContract(cue, snapshot.assets, snapshot.timeline).ready)
    .map((cue) => cue.id));
  const explainerProgramIds = new Set((snapshot.explainerPrograms ?? [])
    .filter((program) => !program.disabled && program.status === "ready" && snapshot.scenes.some((scene) => (
      scene.id === program.sceneId && scene.type === "ExplainerScene" && scene.status === "ready"
    )))
    .map((program) => program.id));

  const assetIds = new Set<string>();
  for (const item of snapshot.timeline.items) {
    if (videoItemIds.has(item.id) || audioItemIds.has(item.id)) assetIds.add(item.assetId);
  }
  for (const cue of snapshot.effectCues ?? []) {
    if (!effectCueIds.has(cue.id)) continue;
    for (const binding of cue.assetBindings ?? []) assetIds.add(binding.assetId);
  }
  for (const performance of snapshot.actorPerformances ?? []) {
    if (performance.status !== "ready" || !performance.maskAssetId || !videoItemIds.has(performance.timelineItemId)) continue;
    assetIds.add(performance.maskAssetId);
  }
  for (const program of snapshot.explainerPrograms ?? []) {
    if (!explainerProgramIds.has(program.id)) continue;
    for (const assetId of program.assetIds) assetIds.add(assetId);
  }

  return { videoItemIds, audioItemIds, effectCueIds, explainerProgramIds, assetIds };
}
