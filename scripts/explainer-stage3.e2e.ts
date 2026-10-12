import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "@videocut/application";
import { assertProjectGraphValid } from "@videocut/domain";
import type { AssetKind, AssetRole, ExplainerSceneKind, ExplainerSceneState, ProjectSnapshot } from "@videocut/contracts";
import { probeMedia, runProcess } from "@videocut/speech";
import { inspectComposedFrames } from "../apps/server/src/preview-inspection.js";
import { RevisionRenderer, runPreviewJob } from "../apps/render-worker/src/exporter.js";

/**
 * 阶段 3 的纯视觉回归：内容全部是项目内的确定性演示数据，刻意不接入网络、外部素材、旁白或生成服务。
 * 它验证 Explainer Program → Revision → Preview 的真实渲染通路，而不是完整声画成片或可交付 Artifact。
 */
const fps = 24;
// 每个 Scene 7.5 秒，10 个连续 Scene 组成固定 75 秒测试片。
const sceneFrames = fps * 7 + 12;
const expectedDurationFrames = sceneFrames * 10;
const fullRun = process.argv.includes("--full");
const keepWorkspace = process.argv.includes("--keep");

type Fixture = {
  title: string;
  purpose: string;
  primaryTask: string;
  kind: ExplainerSceneKind;
  props: Record<string, unknown>;
  enteringKnowledge: string;
  question: string;
  newKnowledge: string;
  deferredInformation: string;
};

const fixtures: Fixture[] = [
  {
    title: "先问清问题",
    purpose: "用强数字 Hook 建立整条解释片的观看任务。",
    primaryTask: "让观众先看见 42% 的返工来自没有定位变化归属。",
    kind: "HeroReveal",
    props: { metric: "42%", qualifier: "受控测试样例：先定位变化归属，才知道应该复核什么。" },
    enteringKnowledge: "观众只知道修改变慢，却不知道原因。",
    question: "一个变化为什么会扩散成返工？",
    newKnowledge: "变化首先需要被定位，而不是立即修补。",
    deferredInformation: "下一拍才解释它会经过哪些对象。"
  },
  {
    title: "变化沿关系传播",
    purpose: "展示从意图到结果的稳定关系，而不是堆叠文字卡。",
    primaryTask: "让观众建立变化传播的最小模型。",
    kind: "RouteAndFlow",
    props: { nodes: ["创作意图", "项目对象", "预览证据", "最终结果"] },
    enteringKnowledge: "观众已知需要先定位变化。",
    question: "变化应该经过哪些可追踪对象？",
    newKnowledge: "意图、对象、预览和结果是同一条可复核链路。",
    deferredInformation: "下一拍才拆开不同类型的变化。"
  },
  {
    title: "先定位，再修复",
    purpose: "对比可追溯修复与直接覆盖的结果差异。",
    primaryTask: "让观众理解为什么不能用一次拖拽掩盖上游问题。",
    kind: "Comparison",
    props: {
      leftLabel: "从上游对象修复",
      rightLabel: "只覆盖最后画面",
      dimension: "可追溯性",
      verdict: "只有前者能让失效范围重新被验证。"
    },
    enteringKnowledge: "观众知道变化沿对象关系传播。",
    question: "为什么直接改最后画面常常留下旧问题？",
    newKnowledge: "从上游修复保留影响范围；覆盖只隐藏症状。",
    deferredInformation: "下一拍才拆开不同类型的变化。"
  },
  {
    title: "三类不同的变化",
    purpose: "逐步建立语义、视觉与交付三类变化的边界。",
    primaryTask: "让观众区分不同问题应回到的对象层。",
    kind: "ProgressiveClassification",
    props: { items: ["语义：改变观众听到什么", "视觉：改变观众看见什么", "交付：改变固定文件与批准"] },
    enteringKnowledge: "观众知道变化沿对象关系传播。",
    question: "所有变化都应该直接改时间线吗？",
    newKnowledge: "不同变化应落到语义、视觉或交付的对应对象。",
    deferredInformation: "下一拍才用真实本地来源说明证据边界。"
  },
  {
    title: "来源先于结论",
    purpose: "展示受管本地来源截图、高亮与适用边界。",
    primaryTask: "让观众区分来源原文、支持的主张与不能推断的范围。",
    kind: "EvidenceDocument",
    props: { focus: "受控测试来源与适用边界" },
    enteringKnowledge: "观众已知对象链路可以被复核。",
    question: "这条测试片中的结论究竟依赖什么来源？",
    newKnowledge: "来源、摘录、高亮和限制必须一起保存，不能由示意图替代。",
    deferredInformation: "下一拍才展示受控本地 UI 如何落实该流程。"
  },
  {
    title: "在界面中定位范围",
    purpose: "展示受控本地 UI 截图中的对象状态和操作焦点。",
    primaryTask: "让观众看见 UI 截图只说明操作路径，不伪装成外部产品事实。",
    kind: "UIWalkthrough",
    props: { focusRects: [{ x: 0.15, y: 0.36, width: 0.7, height: 0.22, label: "当前 Revision 范围" }] },
    enteringKnowledge: "观众知道来源与结论需要共同保存。",
    question: "怎样在操作界面中确认当前 Revision 的范围？",
    newKnowledge: "UI 只展示受控测试操作，不替代来源证据或创作判断。",
    deferredInformation: "下一拍才把验证层的内部计数放到图表中。"
  },
  {
    title: "验收覆盖面（确定性样例）",
    purpose: "用明确标注为内部演示的数据表达不同验证层的覆盖。",
    primaryTask: "让观众看见技术、结构和视觉验证应一起出现。",
    kind: "DataConclusion",
    props: {
      labels: ["结构", "预览", "文件"],
      values: [3, 5, 4],
      unit: "项",
      baseline: "0",
      source: "阶段 3 确定性验收样例（非现实统计）"
    },
    enteringKnowledge: "观众已经知道受控 UI 的职责边界。",
    question: "自动化至少要同时检查哪些技术层？",
    newKnowledge: "结构、真实预览和文件解码需要并列验证。",
    deferredInformation: "下一拍才回到已受管的本地真人素材。"
  },
  {
    title: "受管本地视频合同",
    // segment-01 是人物口播样片。本 E2E 只验证 RealityBroll 的本地化、权限与真实渲染合同，
    // 不把这段画面判断或宣称为对本测试叙事有语义相关性的 B-roll。
    purpose: "验证受管本地视频可作为 RealityBroll 进入合成，但不把它冒充为外部证据或叙事相关素材。",
    primaryTask: "确认本地视频的渲染和权利合同；不对其叙事适配性作结论。",
    kind: "RealityBroll",
    props: {},
    enteringKnowledge: "观众知道技术检查需要多个层共同成立。",
    question: "受管本地视频进入 Explainer Runtime 时，至少要验证什么？",
    newKnowledge: "真实解码、项目内路径和权限状态可被验证；叙事相关性仍需主工作流另行判断。",
    deferredInformation: "下一拍才把项目、预览和质量层收束为一个模型。"
  },
  {
    title: "稳定交付不是一个按钮",
    purpose: "把从项目事实到成片批准的层级同时保留在一个画面。",
    primaryTask: "建立质量验证与最终 Artifact 的分层关系。",
    kind: "LayerStack",
    props: {
      layers: ["创作意图", "项目 Revision", "真实 Preview", "质量结论", "固定 Artifact"],
      relationship: "上层结论必须能回到下层事实复核。"
    },
    enteringKnowledge: "观众知道本地视频渲染合同不能取代来源证据或叙事判断。",
    question: "一次导出为什么不能自行证明成片正确？",
    newKnowledge: "可交付结果依赖连续的项目、预览、质量与文件证据。",
    deferredInformation: "最后一拍再将流程收束为可重复步骤。"
  },
  {
    title: "可重复的验收节奏",
    purpose: "用阶段演进收束解释片，强调本脚本只验证受控本地视觉渲染。",
    primaryTask: "让观众带走从建模到预览的最小顺序。",
    kind: "HistoryTimeline",
    props: {
      events: [
        { date: "步骤 1", label: "建立 NarrativeMap", detail: "先定义观众问题" },
        { date: "步骤 2", label: "编译 Explainer Scene", detail: "每段有独立认知任务" },
        { date: "步骤 3", label: "真实 Preview", detail: "确认输出可播放、无黑帧" }
      ],
      source: "阶段 3 确定性验收流程"
    },
    enteringKnowledge: "观众知道可交付结果需要回到同一 Revision 复核。",
    question: "怎样把这些判断变成可重复的验收？",
    newKnowledge: "先建模型、再编译场景、最后用真实预览检查输出。",
    deferredInformation: "本脚本不覆盖旁白、字幕、权利或正式交付。"
  }
];

function states(): Array<Omit<ExplainerSceneState, "id">> {
  return [
    { phase: "entry", startFrame: 0, endFrame: 24, label: "建立当前问题" },
    { phase: "progressive", startFrame: 24, endFrame: 96, label: "逐步建立关系" },
    { phase: "settled", startFrame: 96, endFrame: 156, label: "保留阅读时间" },
    { phase: "exit", startFrame: 156, endFrame: sceneFrames, label: "释放给下一拍" }
  ];
}

async function assertVisualPreview(input: {
  snapshot: ProjectSnapshot;
  previewPath: string;
  fromFrame: number;
  toFrame: number;
  revision: number;
}): Promise<void> {
  const expectedDurationMs = Math.round(((input.toFrame - input.fromFrame) / input.snapshot.timeline.fps) * 1_000);
  const metadata = await probeMedia(input.previewPath);
  assert.ok(metadata.durationMs > 0, "真实 Preview 必须有可读取时长");
  assert.equal(metadata.videoCodec, "h264", "Preview 必须由 H.264 视频流组成");
  assert.ok(Math.abs(metadata.durationMs - expectedDurationMs) <= 1_000, `Preview 时长异常：期望约 ${expectedDurationMs}ms，实际 ${metadata.durationMs}ms`);
  await runProcess("ffmpeg", ["-v", "error", "-i", input.previewPath, "-map", "0:v:0", "-f", "null", "-"], 10 * 60_000);
  // 用 0.01 秒阈值捕捉任意连续黑帧；内部背景虽深色，但不会满足 98% 像素为黑的 blackdetect 条件。
  const blackDetect = await runProcess("ffmpeg", ["-hide_banner", "-i", input.previewPath, "-vf", "blackdetect=d=0.01:pix_th=0.10", "-an", "-f", "null", "-"], 10 * 60_000);
  assert.doesNotMatch(blackDetect, /black_start:/u, "真实 Preview 不得出现连续黑帧");
  const evidence = await inspectComposedFrames({
    projectRoot: input.snapshot.project.rootPath,
    previewPath: input.previewPath,
    revision: input.revision,
    fromFrame: input.fromFrame,
    toFrame: input.toFrame,
    fps: input.snapshot.timeline.fps
  });
  assert.ok(evidence.length >= 3, "每个 Preview 必须能从真实输出提取开头、中间和结尾合成帧");
}

/**
 * 对完整 Preview 的已解码 RGB 帧做 framemd5，证明状态变化进入了实际渲染结果。
 * 不能用 Program.states 的对象存在或单张关键帧代替这个检查。
 */
async function assertPhaseFrameDifferences(snapshot: ProjectSnapshot, previewPath: string): Promise<void> {
  const output = await runProcess("ffmpeg", [
    "-v", "error",
    "-i", previewPath,
    "-map", "0:v:0",
    "-an",
    "-f", "framemd5",
    "-"
  ], 10 * 60_000);
  const hashes = output.split(/\r?\n/u)
    .filter((line) => /^\d+,/u.test(line))
    .map((line) => line.split(",").at(-1)?.trim())
    .filter((hash): hash is string => Boolean(hash && /^[a-f0-9]{32}$/iu.test(hash)));
  assert.ok(hashes.length >= snapshot.timeline.durationInFrames, "完整 Preview 必须为每一个时间线帧提供可解码的像素哈希");

  for (const program of snapshot.explainerPrograms) {
    const scene = snapshot.scenes.find((candidate) => candidate.id === program.sceneId);
    assert.ok(scene && scene.type === "ExplainerScene", "帧差回归只能检查已绑定的 ExplainerScene");
    const phaseSamples = program.states.map((state) => {
      const localFrame = state.startFrame + Math.floor((state.endFrame - state.startFrame - 1) / 2);
      return hashes[scene.startFrame + localFrame];
    });
    assert.equal(phaseSamples.length, 4, `${program.kind} 必须完整声明四个阶段`);
    assert.ok(phaseSamples.every((hash): hash is string => Boolean(hash)), `${program.kind} 的四个阶段都必须出现在完整 Preview 中`);
    assert.equal(new Set(phaseSamples).size, phaseSamples.length, `${program.kind} 的 Entry/Progressive/Settled/Exit 必须产生不同的真实渲染帧`);
  }
}

type FixtureAssets = {
  evidenceSourceId: string;
  evidenceSnapshotId: string;
  uiScreenshotId: string;
  realityBrollId: string;
};

/** 测试素材全部在临时项目目录内生成或由仓库的用户提供样片裁出，避免把示意图说成外部证据。 */
function registerReadyFixtureAsset(input: {
  application: ReturnType<typeof createApplication>;
  projectId: string;
  name: string;
  kind: AssetKind;
  managedPath: string;
  metadata: Awaited<ReturnType<typeof probeMedia>>;
  role?: AssetRole;
}): string {
  const imported = input.application.registerImportedAsset({
    projectId: input.projectId,
    baseRevision: input.application.readProject(input.projectId).revision.number,
    name: input.name,
    kind: input.kind,
    managedPath: input.managedPath,
    sourceHash: `stage3-fixed-fixture-${input.name}`,
    role: input.role,
    provenance: {
      source: "local_import",
      acquiredAt: new Date().toISOString()
    }
  });
  input.application.applyMediaAnalysis({ projectId: input.projectId, assetId: imported.asset.id, metadata: input.metadata });
  return imported.asset.id;
}

async function createFixtureAssets(application: ReturnType<typeof createApplication>, projectId: string): Promise<FixtureAssets> {
  const projectRoot = application.readProject(projectId).snapshot.project.rootPath;
  const directory = join(projectRoot, "assets", "source", "stage3-fixed-explainer");
  await mkdir(directory, { recursive: true });

  const evidenceSourcePath = join(directory, "controlled-evidence-source.txt");
  const evidenceSnapshotPath = join(directory, "controlled-evidence-snapshot.svg");
  const uiScreenshotPath = join(directory, "controlled-ui-walkthrough.svg");
  const realityBrollPath = join(directory, "local-reality-broll.mp4");
  await writeFile(evidenceSourcePath, [
    "STAGE 3 CONTROLLED EVIDENCE FIXTURE",
    "Scope: verifies a local source, snapshot and highlight contract.",
    "Limit: it does not establish any external business or product fact."
  ].join("\n"), "utf8");
  await writeFile(evidenceSnapshotPath, `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#f6f8fc"/>
  <rect x="70" y="70" width="1140" height="116" rx="12" fill="#173b70"/>
  <text x="110" y="142" fill="#ffffff" font-family="Arial, sans-serif" font-size="34" font-weight="700">STAGE 3 CONTROLLED EVIDENCE FIXTURE</text>
  <rect x="95" y="276" width="1090" height="112" rx="10" fill="#dcebff"/>
  <text x="125" y="330" fill="#173b70" font-family="Arial, sans-serif" font-size="29">Scope: local source, snapshot and highlight contract.</text>
  <rect x="95" y="442" width="1090" height="112" rx="10" fill="#fff1c9"/>
  <text x="125" y="496" fill="#5f4814" font-family="Arial, sans-serif" font-size="27">Limit: no external business or product fact is asserted.</text>
</svg>`, "utf8");
  await writeFile(uiScreenshotPath, `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#101b2d"/>
  <rect x="48" y="44" width="1184" height="632" rx="20" fill="#172943" stroke="#77a9f5"/>
  <text x="94" y="116" fill="#e9f2ff" font-family="Arial, sans-serif" font-size="38" font-weight="700">Controlled local UI walkthrough</text>
  <text x="94" y="160" fill="#a9c7ee" font-family="Arial, sans-serif" font-size="23">Test-only interface state — not an external product screen</text>
  <rect x="170" y="258" width="940" height="210" rx="16" fill="#233e63" stroke="#8fc0ff" stroke-width="4"/>
  <text x="218" y="336" fill="#ffffff" font-family="Arial, sans-serif" font-size="32">Current Revision: R7</text>
  <text x="218" y="402" fill="#c7dcf8" font-family="Arial, sans-serif" font-size="27">Preview and source evidence are linked to this test range.</text>
  <rect x="170" y="528" width="320" height="70" rx="14" fill="#4b82cf"/>
  <text x="218" y="574" fill="#ffffff" font-family="Arial, sans-serif" font-size="27" font-weight="700">Inspect range</text>
</svg>`, "utf8");

  const sourceVideoPath = join(process.cwd(), "videos", "数字人口播", "segment-01.mp4");
  await access(sourceVideoPath).catch(() => {
    throw new Error(`阶段 3 固定测试缺少用户提供的本地视频素材：${sourceVideoPath}`);
  });
  // 只裁出临时项目内的短范围；原始用户素材保持只读。
  // 该人物口播样片只覆盖 RealityBroll 的受管路径、权限与渲染合同，未经过叙事相关性评估。
  await runProcess("ffmpeg", [
    "-y",
    "-stream_loop", "-1",
    "-i", sourceVideoPath,
    "-t", (sceneFrames / fps).toFixed(3),
    "-map", "0:v:0",
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    realityBrollPath
  ], 10 * 60_000);
  const realityMetadata = await probeMedia(realityBrollPath);
  assert.ok(realityMetadata.videoCodec && realityMetadata.durationMs >= (sceneFrames / fps) * 1_000 - 250, "受管本地 RealityBroll 必须是足够长的真实视频范围");

  return {
    evidenceSourceId: registerReadyFixtureAsset({
      application, projectId, name: "controlled-evidence-source.txt", kind: "document",
      managedPath: "assets/source/stage3-fixed-explainer/controlled-evidence-source.txt",
      metadata: { durationMs: 0, hasAudio: false, mime: "text/plain" }, role: "evidence"
    }),
    evidenceSnapshotId: registerReadyFixtureAsset({
      application, projectId, name: "controlled-evidence-snapshot.svg", kind: "image",
      managedPath: "assets/source/stage3-fixed-explainer/controlled-evidence-snapshot.svg",
      metadata: { durationMs: 0, hasAudio: false, width: 1280, height: 720, mime: "image/svg+xml" }, role: "evidence"
    }),
    uiScreenshotId: registerReadyFixtureAsset({
      application, projectId, name: "controlled-ui-walkthrough.svg", kind: "image",
      managedPath: "assets/source/stage3-fixed-explainer/controlled-ui-walkthrough.svg",
      metadata: { durationMs: 0, hasAudio: false, width: 1280, height: 720, mime: "image/svg+xml" }
    }),
    realityBrollId: registerReadyFixtureAsset({
      application, projectId, name: "local-reality-broll.mp4", kind: "video",
      managedPath: "assets/source/stage3-fixed-explainer/local-reality-broll.mp4",
      metadata: realityMetadata, role: "b_roll"
    })
  };
}

async function createFixtureProject(root: string): Promise<{ projectId: string; revision: number; snapshot: ProjectSnapshot; application: ReturnType<typeof createApplication> }> {
  const application = createApplication(root);
  const created = application.createProject({ name: "阶段 3 视觉解释片真实渲染验收", profile: "visual_explainer" });
  const projectId = created.snapshot.project.id;
  const assets = await createFixtureAssets(application, projectId);
  const evidenceState = application.manageEvidenceCapture({
    projectId,
    baseRevision: application.readProject(projectId).revision.number,
    action: "create",
    sourceAssetId: assets.evidenceSourceId,
    snapshotAssetId: assets.evidenceSnapshotId,
    sourceTitle: "阶段 3 受控本地证据测试来源",
    publisher: "VideoFlowCut 固定测试素材",
    sourceUrl: "urn:videocut:stage3:controlled-local-evidence",
    capturedAt: "2026-09-02T00:00:00.000Z",
    pageOrRange: "固定测试页面",
    excerpt: "Scope: verifies a local source, snapshot and highlight contract.",
    claim: "当前 Revision 保存了一个可读回的本地来源、快照和高亮范围。",
    limitation: "该受控样例不主张任何外部业务、产品或人物事实。",
    highlights: [{ x: 0.075, y: 0.38, width: 0.85, height: 0.16, label: "受控测试范围" }]
  });
  const evidenceCapture = evidenceState.snapshot.evidenceCaptures.at(-1);
  assert.ok(evidenceCapture, "固定 E2E 必须将本地来源登记为 EvidenceCapture");
  const story = application.updateStory({
    projectId,
    baseRevision: evidenceState.revision.number,
    title: "从变化到验收的解释模型",
    summary: "这是只验证 Explainer Program 真实渲染的确定性内部样例，不表达外部事实。",
    beats: fixtures.map((fixture) => ({ title: fixture.title, purpose: fixture.purpose }))
  });
  const narrative = application.manageNarrativeMap({
    projectId,
    baseRevision: story.revision.number,
    viewerQuestion: "怎样把一个变化变成可重复复核的结果？",
    promisedModel: "通过稳定的对象关系、解释场景和真实预览建立可追踪验收。",
    conclusion: "本脚本仅证明纯 Explainer 场景可以连续真实渲染，不证明完整声画交付。",
    beats: fixtures.map((fixture, index) => ({
      narrativeBeatId: story.snapshot.story.beats[index]!.id,
      enteringKnowledge: fixture.enteringKnowledge,
      question: fixture.question,
      newKnowledge: fixture.newKnowledge,
      deferredInformation: fixture.deferredInformation,
      claim: fixture.newKnowledge,
      evidenceCaptureIds: fixture.kind === "EvidenceDocument" ? [evidenceCapture.id] : []
    }))
  });
  const compiled = application.compileExplainerScenes({
    projectId,
    baseRevision: narrative.revision.number,
    plans: fixtures.map((fixture, index) => ({
      title: fixture.title,
      purpose: fixture.purpose,
      startFrame: index * sceneFrames,
      endFrame: (index + 1) * sceneFrames,
      narrativeMapBeatId: narrative.snapshot.narrativeMap!.beats[index]!.id,
      kind: fixture.kind,
      primaryTask: fixture.primaryTask,
      assetIds: fixture.kind === "UIWalkthrough" ? [assets.uiScreenshotId]
        : fixture.kind === "RealityBroll" ? [assets.realityBrollId]
          : undefined,
      evidenceCaptureId: fixture.kind === "EvidenceDocument" ? evidenceCapture.id : undefined,
      states: states(),
      props: fixture.props,
      visualTreatment: {
        mode: "remotion",
        intensity: index === 0 || index === fixtures.length - 1 ? "low" : "medium",
        primaryAttention: fixture.primaryTask,
        narrativePurpose: fixture.purpose
      }
    }))
  });
  const snapshot = compiled.snapshot;
  const durationSeconds = snapshot.timeline.durationInFrames / fps;
  assert.equal(snapshot.timeline.durationInFrames, expectedDurationFrames, "10 个无缝 Explainer Scene 必须组成固定 75 秒时间线");
  assert.ok(durationSeconds >= 60 && durationSeconds <= 90, `阶段 3 固定 E2E 必须保持在 60～90 秒，当前为 ${durationSeconds.toFixed(2)} 秒`);
  assert.equal(snapshot.explainerPrograms.length, fixtures.length, "每个确定性拍点必须编译为一个 Program");
  assert.ok(snapshot.explainerPrograms.every((program) => program.status === "ready"), "验收前所有 Program 必须处于 ready");
  assertProjectGraphValid(snapshot);
  return { application, projectId, revision: compiled.revision.number, snapshot };
}

async function renderPreview(input: {
  application: ReturnType<typeof createApplication>;
  projectId: string;
  revision: number;
  snapshot: ProjectSnapshot;
  renderer: RevisionRenderer;
  fromFrame: number;
  toFrame: number;
  key: string;
}): Promise<string> {
  const job = input.application.submitPreview({
    projectId: input.projectId,
    revision: input.revision,
    fromFrame: input.fromFrame,
    toFrame: input.toFrame,
    idempotencyKey: `stage3-explainer:${input.key}:${input.revision}:${input.fromFrame}:${input.toFrame}`
  });
  const result = await runPreviewJob(input.application, job, input.renderer);
  const previewPath = typeof result.path === "string" ? result.path : "";
  assert.ok(previewPath, "Preview Job 必须返回真实输出路径");
  await assertVisualPreview({ snapshot: input.snapshot, previewPath, fromFrame: input.fromFrame, toFrame: input.toFrame, revision: input.revision });
  return previewPath;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "videocut-explainer-stage3-"));
  let application: ReturnType<typeof createApplication> | undefined;
  try {
    const fixture = await createFixtureProject(root);
    application = fixture.application;
    const renderer = new RevisionRenderer(undefined, 1);
    if (fullRun) {
      const previewPath = await renderPreview({
        ...fixture,
        renderer,
        fromFrame: 0,
        toFrame: fixture.snapshot.timeline.durationInFrames,
        key: "full-75-seconds"
      });
      await assertPhaseFrameDifferences(fixture.snapshot, previewPath);
      console.log(JSON.stringify({
        mode: "full",
        durationSeconds: fixture.snapshot.timeline.durationInFrames / fps,
        sceneCount: fixtures.length,
        phaseFrameRegression: "passed",
        preview: keepWorkspace ? previewPath : "临时 Preview 已完成验证并将在退出时清理"
      }, null, 2));
    } else {
      // Smoke 保持完整 75 秒 Project，但每个 Scene 只渲染稳定阅读区 1 秒，避免本地日常回归耗尽数分钟。
      const previews: string[] = [];
      for (const [index, fixtureDefinition] of fixtures.entries()) {
        const fromFrame = index * sceneFrames + 108;
        const toFrame = fromFrame + fps;
        previews.push(await renderPreview({ ...fixture, renderer, fromFrame, toFrame, key: `smoke-${index}` }));
        console.log(`已验证 ${index + 1}/${fixtures.length}：${fixtureDefinition.kind} · ${fixtureDefinition.title}`);
      }
      console.log(JSON.stringify({ mode: "smoke", projectDurationSeconds: fixture.snapshot.timeline.durationInFrames / fps, sceneCount: fixtures.length, renderedSceneWindows: previews.length }, null, 2));
    }
  } finally {
    application?.close();
    if (keepWorkspace) console.log(`保留阶段 3 验收工作目录：${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
