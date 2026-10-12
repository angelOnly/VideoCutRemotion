import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import type { ProjectSnapshot, TimelineItem, TimelineTrack, VlogAmbientCue, VlogShotSelect } from "@videocut/contracts";
import { resolveVideoSourceVolume, resolveVlogAmbientVolume } from "@videocut/remotion";

const timestamp = "2026-09-02T00:00:00.000Z";

function track(snapshot: ProjectSnapshot, name: string): TimelineTrack {
  const target = snapshot.timeline.tracks.find((candidate) => candidate.name === name);
  assert.ok(target, `测试项目必须具有 ${name} 轨`);
  return target;
}

function item(id: string, trackId: string): TimelineItem {
  return {
    id,
    trackId,
    assetId: "asset_vlog_source",
    startFrame: 0,
    endFrame: 48,
    sourceStartFrame: 24,
    sourceEndFrame: 72,
    gainDb: 0,
    disabled: false
  };
}

function select(input: {
  id: string;
  videoItemId: string;
  ambientItemId?: string;
  sourceAudioMode: "keep" | "mute";
}): VlogShotSelect {
  return {
    id: input.id,
    eventId: "event_vlog",
    shotAnalysisId: "shot_vlog",
    order: 0,
    sourceStartFrame: 24,
    sourceEndFrame: 72,
    function: "action",
    selectionReason: "该镜头保留事件动作。",
    continuityNote: "源范围与事件连续。",
    sourceAudioMode: input.sourceAudioMode,
    timelineItemId: input.videoItemId,
    ambientTimelineItemId: input.ambientItemId,
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function ambientCue(selectId: string, timelineItemId: string): VlogAmbientCue {
  return {
    id: "ambient_vlog",
    shotSelectId: selectId,
    assetId: "asset_vlog_source",
    timelineItemId,
    purpose: "保留真实现场声。",
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

test("Vlog 画面源声始终静音，现场声仅通过已确认的 Ambient 独立轨播放", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-vlog-runtime-"));
  const application = createApplication(root);
  try {
    const created = application.createProject({ name: "Vlog Runtime", profile: "vlog" });
    const snapshot = structuredClone(created.snapshot);
    const background = track(snapshot, "Background");
    const ambient = track(snapshot, "Ambient");
    const videoItem = item("item_vlog_video", background.id);
    const keepAmbientItem = item("item_vlog_ambient_keep", ambient.id);
    snapshot.timeline.items.push(videoItem, keepAmbientItem);

    const keepSelect = select({
      id: "select_vlog_keep",
      videoItemId: videoItem.id,
      ambientItemId: keepAmbientItem.id,
      sourceAudioMode: "keep"
    });
    snapshot.vlogShotSelects.push(keepSelect);
    snapshot.vlogAmbientCues.push(ambientCue(keepSelect.id, keepAmbientItem.id));

    // 即使未来编译器误把主画面 gainDb 回到 0，运行时也不得产生重复的源声。
    assert.equal(resolveVideoSourceVolume(snapshot, videoItem, background), 0);
    assert.equal(resolveVlogAmbientVolume(snapshot, keepAmbientItem, ambient), 1);

    // compileVlogMontage 不会为 mute Select 创建 Ambient Item；这里故意构造脏数据，
    // 验证运行时仍然拒绝播放，不能把结构问题变成意外现场声。
    const mutedAmbientItem = item("item_vlog_ambient_mute", ambient.id);
    snapshot.timeline.items.push(mutedAmbientItem);
    const muteSelect = select({
      id: "select_vlog_mute",
      videoItemId: "item_vlog_video_mute",
      ambientItemId: mutedAmbientItem.id,
      sourceAudioMode: "mute"
    });
    snapshot.vlogShotSelects.push(muteSelect);
    snapshot.vlogAmbientCues.push({ ...ambientCue(muteSelect.id, mutedAmbientItem.id), id: "ambient_vlog_mute" });
    assert.equal(resolveVlogAmbientVolume(snapshot, mutedAmbientItem, ambient), 0);
  } finally {
    application.close();
    await rm(root, { recursive: true, force: true });
  }
});
