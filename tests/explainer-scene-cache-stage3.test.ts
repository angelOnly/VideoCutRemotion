import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createApplication, type EditingApplication } from "@videocut/application";
import type { ProjectSnapshot } from "@videocut/contracts";
import { runProcess } from "@videocut/speech";
import { RevisionRenderer, runPreviewJob } from "../apps/render-worker/src/exporter.js";

class CountingPreviewRenderer extends RevisionRenderer {
  calls = 0;

  override async renderRange(snapshot: ProjectSnapshot, fromFrame: number, toFrame: number, targetPath: string): Promise<void> {
    this.calls += 1;
    await mkdir(dirname(targetPath), { recursive: true });
    const durationSeconds = (toFrame - fromFrame) / snapshot.timeline.fps;
    // 生成真正可由 ffprobe 读取的短 MP4，使缓存测试覆盖文件校验与复制，而非只模拟路径。
    await runProcess("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=0x315f9d:s=96x96:r=24",
      "-f", "lavfi",
      "-i", "anullsrc=r=48000:cl=stereo",
      "-t", durationSeconds.toFixed(3),
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      targetPath
    ]);
  }
}

async function createIsolatedExplainer(): Promise<{ root: string; app: EditingApplication; projectId: string; revision: number }> {
  const root = await mkdtemp(join(tmpdir(), "videocut-explainer-cache-"));
  const app = createApplication(root);
  const created = app.createProject({ name: "场景缓存验证", profile: "visual_explainer" });
  const projectId = created.snapshot.project.id;
  const story = app.updateStory({
    projectId,
    baseRevision: created.revision.number,
    title: "场景缓存",
    summary: "只验证无其它叠加层的纯 Explainer Scene。",
    beats: [{ title: "核心机制", purpose: "建立可复用的认知模型" }]
  });
  const beat = story.snapshot.story.beats[0]!;
  const narrative = app.manageNarrativeMap({
    projectId,
    baseRevision: story.revision.number,
    viewerQuestion: "为什么需要一个稳定的场景缓存？",
    promisedModel: "相同的场景输入只渲染一次。",
    conclusion: "缓存不会跨越其它叠加对象。",
    beats: [{
      narrativeBeatId: beat.id,
      enteringKnowledge: "已经知道局部预览很昂贵。",
      question: "何时可以安全复用？",
      newKnowledge: "仅独占画面的 Explainer Scene 可以复用。",
      deferredInformation: "其它叠加层会在下一步单独重新合成。",
      claim: "相同 Scene 输入可复用预览。"
    }]
  });
  const mapBeat = narrative.snapshot.narrativeMap!.beats[0]!;
  const compiled = app.compileExplainerScenes({
    projectId,
    baseRevision: narrative.revision.number,
    plans: [{
      title: "场景缓存的边界",
      purpose: "说明缓存仅复用无字幕、无 Cue、无 Timeline Item 的 Explainer 画面。",
      startFrame: 0,
      endFrame: 48,
      narrativeMapBeatId: mapBeat.id,
      kind: "HeroReveal",
      primaryTask: "说明同一视觉输入可以安全复用。",
      states: [
        { phase: "entry", startFrame: 0, endFrame: 6, label: "建立问题" },
        { phase: "progressive", startFrame: 6, endFrame: 18, label: "展示缓存键" },
        { phase: "settled", startFrame: 18, endFrame: 42, label: "保留阅读时间" },
        { phase: "exit", startFrame: 42, endFrame: 48, label: "释放场景" }
      ],
      props: { metric: "一次渲染", qualifier: "相同 Scene 输入命中本地预览缓存" }
    }]
  });
  return { root, app, projectId, revision: compiled.revision.number };
}

test("独占 Explainer Scene 的局部预览会写入并复用受管缓存，缓存键包含可视主任务", async () => {
  const context = await createIsolatedExplainer();
  try {
    const renderer = new CountingPreviewRenderer();
    const firstJob = context.app.submitPreview({
      projectId: context.projectId,
      revision: context.revision,
      fromFrame: 0,
      toFrame: 48,
      idempotencyKey: "explainer-cache-first"
    });
    const first = await runPreviewJob(context.app, firstJob, renderer);
    const firstCache = first.sceneCache as { cacheKey?: string; hit?: boolean } | undefined;
    assert.equal(renderer.calls, 1);
    assert.equal(firstCache?.hit, false);
    assert.match(firstCache?.cacheKey ?? "", /^[a-f0-9]{32}$/u);

    const secondJob = context.app.submitPreview({
      projectId: context.projectId,
      revision: context.revision,
      fromFrame: 0,
      toFrame: 48,
      idempotencyKey: "explainer-cache-second"
    });
    const second = await runPreviewJob(context.app, secondJob, renderer);
    const secondCache = second.sceneCache as { cacheKey?: string; hit?: boolean } | undefined;
    assert.equal(renderer.calls, 1, "相同独占 Scene 不应再次调用渲染器");
    assert.equal(secondCache?.hit, true);
    assert.equal(secondCache?.cacheKey, firstCache?.cacheKey);

    const program = context.app.readExplainerScenePrograms({ projectId: context.projectId }).programs[0]!;
    const changed = context.app.compileExplainerScenes({
      projectId: context.projectId,
      baseRevision: context.app.readProject(context.projectId).revision.number,
      plans: [{
        title: "场景缓存的边界",
        purpose: "说明缓存仅复用无字幕、无 Cue、无 Timeline Item 的 Explainer 画面。",
        startFrame: 0,
        endFrame: 48,
        narrativeMapBeatId: mapBeatId(context.app, context.projectId),
        kind: "HeroReveal",
        primaryTask: "改写后的主任务必须使旧缓存失效。",
        states: [
          { phase: "entry", startFrame: 0, endFrame: 6, label: "建立问题" },
          { phase: "progressive", startFrame: 6, endFrame: 18, label: "展示缓存键" },
          { phase: "settled", startFrame: 18, endFrame: 42, label: "保留阅读时间" },
          { phase: "exit", startFrame: 42, endFrame: 48, label: "释放场景" }
        ],
        props: { metric: "一次渲染", qualifier: "相同 Scene 输入命中本地预览缓存" }
      }]
    });
    const changedProgram = changed.snapshot.explainerPrograms[0]!;
    assert.notEqual(changedProgram.cacheKey, program.cacheKey, "可视主任务变化不能复用旧缓存键");
  } finally {
    context.app.close();
    await rm(context.root, { recursive: true, force: true });
  }
});

function mapBeatId(app: EditingApplication, projectId: string): string {
  const mapBeat = app.readNarrativeMap({ projectId }).narrativeMap?.beats[0];
  assert.ok(mapBeat, "测试项目必须保留 NarrativeMap Beat");
  return mapBeat.id;
}

test("停用 Program 后不能复用仍存在的旧场景视频缓存，恢复时可复用同一输入", async () => {
  const context = await createIsolatedExplainer();
  try {
    // 另一个场景维持项目长度，使被停用的局部范围仍可请求 Preview。
    const extended = context.app.repository.commit(context.projectId, context.revision, "候选后续场景", (snapshot) => {
      snapshot.scenes.push({ ...snapshot.scenes[0]!, id: "cache-following-scene", type: "PresenterScene", startFrame: 48, endFrame: 96, narrativeBeatIds: [] });
    });
    const renderer = new CountingPreviewRenderer();
    const preview = async (revision: number) => runPreviewJob(context.app, context.app.submitPreview({ projectId: context.projectId, revision, fromFrame: 0, toFrame: 48 }), renderer);
    const first = await preview(extended.revision.number);
    assert.equal((first.sceneCache as { hit: boolean }).hit, false);
    const programId = extended.snapshot.explainerPrograms[0]!.id;
    const off = context.app.setExplainerProgramEnabled({ projectId: context.projectId, baseRevision: extended.revision.number, programId, enabled: false });
    const disabledPreview = await preview(off.revision.number);
    assert.equal(renderer.calls, 2, "旧缓存文件仍在，但停用后必须重新合成底层");
    assert.equal(disabledPreview.sceneCache, undefined);
    const on = context.app.setExplainerProgramEnabled({ projectId: context.projectId, baseRevision: off.revision.number, programId, enabled: true });
    const enabledPreview = await preview(on.revision.number);
    assert.equal((enabledPreview.sceneCache as { hit: boolean }).hit, true);
    assert.equal(renderer.calls, 2);
  } finally {
    context.app.close();
    await rm(context.root, { recursive: true, force: true });
  }
});
