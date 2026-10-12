import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication, type EditingApplication } from "@videocut/application";
import type { ExplainerSceneState, Id, ProjectSnapshot } from "@videocut/contracts";
import { probeMedia, runProcess } from "@videocut/speech";
import { RevisionRenderer } from "../apps/render-worker/src/exporter.js";
import { hashMediaFile } from "../packages/edit-application/src/media-intelligence.js";
import { PRE_RENDERED_3D_TAG } from "../packages/remotion-runtime/src/explainer-registry.js";

function sceneStates(): Array<Omit<ExplainerSceneState, "id">> {
  return [
    { phase: "entry", startFrame: 0, endFrame: 4, label: "建立问题" },
    { phase: "progressive", startFrame: 4, endFrame: 10, label: "建立关系" },
    { phase: "settled", startFrame: 10, endFrame: 20, label: "稳定阅读" },
    { phase: "exit", startFrame: 20, endFrame: 24, label: "释放画面" }
  ];
}

/** 测试只使用项目内受管视频，确保复杂三维降级确实走 Renderer 的媒体服务。 */
async function createPreRenderedVideo(path: string): Promise<void> {
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=0x28ba72:s=768x1344:r=24:d=1",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
    "-c:a", "aac",
    path
  ]);
}

async function createSnapshot(root: string): Promise<{ app: EditingApplication; snapshot: ProjectSnapshot }> {
  const app = createApplication(root);
  const created = app.createProject({ name: "阶段 5 高级视觉真实渲染", profile: "visual_explainer" });
  const projectId = created.snapshot.project.id;
  const projectRoot = created.snapshot.project.rootPath;
  const assetRelativePath = join("assets", "derived", "pre-rendered-three-d.mp4");
  const assetPath = join(projectRoot, assetRelativePath);
  await mkdir(join(projectRoot, "assets", "derived"), { recursive: true });
  await createPreRenderedVideo(assetPath);

  const imported = app.registerImportedAsset({
    projectId,
    baseRevision: app.readProject(projectId).revision.number,
    name: "受管预渲染三维关系图.mp4",
    kind: "video",
    managedPath: assetRelativePath,
    sourceHash: await hashMediaFile(assetPath),
    tags: [PRE_RENDERED_3D_TAG],
    provenance: { source: "generated", acquiredAt: "2026-09-02T00:00:00.000Z" }
  });
  app.applyMediaAnalysis({ projectId, assetId: imported.asset.id, metadata: await probeMedia(assetPath) });

  const story = app.updateStory({
    projectId,
    baseRevision: app.readProject(projectId).revision.number,
    title: "受限高级视觉渲染",
    summary: "确认注册模板与预渲染降级都能经由真实 Composition 输出。",
    beats: ["流程关系", "指标比较", "预渲染三维", "内置 Shader"]
      .map((title) => ({ title, purpose: `验证${title}的实际 Render 路径` }))
  });
  const narrative = app.manageNarrativeMap({
    projectId,
    baseRevision: story.revision.number,
    viewerQuestion: "高级视觉是否真正进入 Render Worker？",
    promisedModel: "受限模板和预渲染素材各自走可审查的实际渲染路径。",
    conclusion: "未启用的运行时能力必须明确失败。",
    beats: story.snapshot.story.beats.map((beat, index) => ({
      narrativeBeatId: beat.id,
      enteringKnowledge: index === 0 ? "尚未验证运行时" : "已验证上一视觉路径",
      question: "当前视觉路径是否可实际输出？",
      newKnowledge: "Renderer 已完成当前场景渲染。",
      deferredInformation: "下一拍验证另一种路径。"
    }))
  });
  const beats = narrative.snapshot.narrativeMap!.beats;
  const plan = (input: { title: string; beatId: Id; startFrame: number; props: Record<string, unknown>; assetIds?: Id[] }) => ({
    title: input.title,
    purpose: "验证高级视觉的真实渲染结果",
    startFrame: input.startFrame,
    endFrame: input.startFrame + 24,
    narrativeMapBeatId: input.beatId,
    kind: "RouteAndFlow" as const,
    primaryTask: "建立可读的关系模型",
    assetIds: input.assetIds,
    states: sceneStates(),
    // RouteAndFlow 的既有事实门禁仍保留；restrictedScene / advancedVisual 只是 Renderer 的受限扩展。
    props: input.props
  });
  app.compileExplainerScenes({
    projectId,
    baseRevision: narrative.revision.number,
    plans: [
      plan({
        title: "FlowMap 真实渲染",
        beatId: beats[0]!.id,
        startFrame: 0,
        props: {
          nodes: ["确认输入", "建立关系", "输出结论"],
          restrictedScene: {
            schemaVersion: 1,
            template: "FlowMap",
            title: "从输入到结论",
            accent: "violet",
            revealFrames: 6,
            nodes: [{ label: "输入", detail: "核对事实" }, { label: "关系", detail: "保持因果" }, { label: "结论" }]
          }
        }
      }),
      plan({
        title: "MetricComparison 真实渲染",
        beatId: beats[1]!.id,
        startFrame: 24,
        props: {
          nodes: ["基线", "比较", "结论"],
          restrictedScene: {
            schemaVersion: 1,
            template: "MetricComparison",
            title: "方案差异",
            accent: "blue",
            revealFrames: 6,
            metrics: [{ label: "方案 A", value: 42 }, { label: "方案 B", value: 18 }]
          }
        }
      }),
      plan({
        title: "预渲染三维降级真实渲染",
        beatId: beats[2]!.id,
        startFrame: 48,
        assetIds: [imported.asset.id],
        props: {
          nodes: ["预渲染素材", "项目绑定", "稳定播放"],
          advancedVisual: { feature: "complex_3d", preRenderedAssetId: imported.asset.id }
        }
      }),
      plan({
        title: "内置 Shader 真实渲染",
        beatId: beats[3]!.id,
        startFrame: 72,
        props: {
          nodes: ["内置模板", "局部时间", "受控输出"],
          advancedVisual: { feature: "shader", template: "aurora_mesh", accent: "violet", intensity: "subtle" }
        }
      })
    ]
  });
  return { app, snapshot: app.readProject(projectId).snapshot };
}

function invalidSnapshot(snapshot: ProjectSnapshot, advancedVisual: Record<string, unknown>): ProjectSnapshot {
  const next = structuredClone(snapshot);
  const program = next.explainerPrograms[0];
  if (!program) throw new Error("测试场景缺少 Explainer Program");
  program.props = { nodes: ["拒绝", "而非假成功"], advancedVisual };
  return next;
}

test("阶段 5 高级视觉经真实 Composition 渲染，未启用能力会明确失败", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-advanced-visual-render-"));
  const { app, snapshot } = await createSnapshot(root);
  const renderer = new RevisionRenderer(undefined, 1);
  try {
    const previewPath = join(snapshot.project.rootPath, "previews", "advanced-visual-valid.mp4");
    await renderer.renderRange(snapshot, 0, 96, previewPath);
    const preview = await probeMedia(previewPath);
    assert.ok(preview.durationMs > 3_000, "四个场景必须实际输出为可解码 Preview");
    assert.equal(preview.videoCodec, "h264");

    const shaderPath = join(snapshot.project.rootPath, "previews", "curated-shader.mp4");
    await renderer.renderRange(snapshot, 72, 96, shaderPath);
    const shaderPreview = await probeMedia(shaderPath);
    assert.equal(shaderPreview.videoCodec, "h264", "内置 Shader 场景必须进入真实 Render Worker");
    const shaderBlackDetect = await runProcess("ffmpeg", ["-hide_banner", "-i", shaderPath, "-vf", "blackdetect=d=0.2:pix_th=0.10", "-an", "-f", "null", "-"]);
    assert.doesNotMatch(shaderBlackDetect, /black_start:/u, "内置 Shader 不得在真实渲染中退化为黑帧");

    await assert.rejects(
      () => renderer.renderRange(invalidSnapshot(snapshot, { feature: "shader", source: "void main() {}" }), 0, 1, join(snapshot.project.rootPath, "previews", "shader-rejected.mp4")),
      /SHADER_SOURCE_FORBIDDEN/u,
      "任意 Shader 源码不可作为空白画面或静默降级被标记为渲染成功"
    );
    await assert.rejects(
      () => renderer.renderRange(invalidSnapshot(snapshot, { feature: "complex_3d", modelPath: "C:/unsafe/model.glb" }), 0, 1, join(snapshot.project.rootPath, "previews", "three-d-rejected.mp4")),
      /COMPLEX_3D_SOURCE_FORBIDDEN/u,
      "非法三维源不能绕过项目内预渲染素材门禁"
    );
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
