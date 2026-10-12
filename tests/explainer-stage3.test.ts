import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication, type EditingApplication } from "@videocut/application";
import type { AssetKind, ExplainerSceneKind, ExplainerSceneState, Id } from "@videocut/contracts";
import { assertProjectGraphValid, DomainError, resolveCompositionReachability } from "@videocut/domain";
import { evaluateQuality } from "@videocut/quality";

async function createTestApplication(): Promise<{ root: string; app: EditingApplication; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "videocut-explainer-test-"));
  const app = createApplication(root);
  return {
    root,
    app,
    dispose: async () => {
      app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

/** 阶段 3 测试只构造已完成分析的受管事实，不以虚构网页或文件路径替代来源。 */
function addReadyAsset(
  app: EditingApplication,
  projectId: string,
  name: string,
  kind: AssetKind,
  options: { generated?: boolean; role?: "evidence" | "style_reference" } = {}
): string {
  const generated = options.generated ?? false;
  const imported = app.registerImportedAsset({
    projectId,
    baseRevision: app.readProject(projectId).revision.number,
    name,
    kind,
    managedPath: `assets/source/${name}`,
    sourceHash: `${name}-${generated ? "generated" : "source"}-hash`,
    role: options.role,
    provenance: generated
      ? {
        source: "generated",
        acquiredAt: new Date().toISOString()
      }
      : {
        source: "provider",
        provider: "测试来源库",
        sourceUrl: `https://example.test/source/${encodeURIComponent(name)}`,
        acquiredAt: new Date().toISOString()
      }
  });
  const image = kind === "image" || kind === "derived";
  app.applyMediaAnalysis({
    projectId,
    assetId: imported.asset.id,
    metadata: {
      durationMs: image || kind === "document" ? 1 : 1_000,
      hasAudio: false,
      width: image ? 1280 : undefined,
      height: image ? 720 : undefined,
      mime: kind === "document" ? "application/pdf" : image ? "image/png" : "video/mp4",
      videoCodec: kind === "video" ? "h264" : undefined
    }
  });
  return imported.asset.id;
}

function createEvidenceCapture(app: EditingApplication, projectId: string, sourceAssetId: string, snapshotAssetId: string) {
  const state = app.manageEvidenceCapture({
    projectId,
    baseRevision: app.readProject(projectId).revision.number,
    action: "create",
    sourceAssetId,
    snapshotAssetId,
    sourceTitle: "原始研究页面",
    publisher: "测试研究机构",
    sourceUrl: "https://example.test/research/original-study",
    capturedAt: "2026-09-02T00:00:00.000Z",
    pageOrRange: "第 3 页，表 1",
    excerpt: "原文明确说明该结论只适用于已观察到的样本。",
    claim: "证据支持样本内存在可测量差异。",
    limitation: "不能外推到未被该研究覆盖的人群。",
    highlights: [{ x: 0.12, y: 0.24, width: 0.48, height: 0.16, label: "原文限定条件" }]
  });
  const capture = state.snapshot.evidenceCaptures.at(-1);
  assert.ok(capture, "创建 EvidenceCapture 后必须可从当前 Revision 读回");
  return { state, capture };
}

function createStoryAndNarrativeMap(
  app: EditingApplication,
  projectId: string,
  titles: string[],
  evidenceCaptureId?: string
) {
  const storyState = app.updateStory({
    projectId,
    baseRevision: app.readProject(projectId).revision.number,
    title: "理解机制而非罗列结论",
    summary: "每一拍回答一个递进问题。",
    beats: titles.map((title, index) => ({
      title,
      purpose: `让观众完成第 ${index + 1} 个认知步骤`
    }))
  });
  const mapState = app.manageNarrativeMap({
    projectId,
    baseRevision: storyState.revision.number,
    viewerQuestion: "这个机制到底怎样运作？",
    promisedModel: "从现象、结构到结论的可复核模型",
    conclusion: "观众能够说清差异来自哪里，并知道证据的边界。",
    beats: storyState.snapshot.story.beats.map((beat, index) => ({
      narrativeBeatId: beat.id,
      enteringKnowledge: index === 0 ? "只知道一个表面现象" : `已理解前 ${index} 个步骤`,
      question: `${beat.title} 要解决什么问题？`,
      newKnowledge: `理解 ${beat.title} 对整体模型的作用。`,
      deferredInformation: index === titles.length - 1 ? "没有额外延迟信息" : "下一拍再说明具体因果与限制。",
      claim: `第 ${index + 1} 拍的可复核主张`,
      evidenceCaptureIds: evidenceCaptureId && index === 4 ? [evidenceCaptureId] : []
    }))
  });
  const narrativeMap = mapState.snapshot.narrativeMap;
  assert.ok(narrativeMap, "NarrativeMap 必须写入当前 Revision");
  return { storyState, mapState, narrativeMap };
}

type ExplainerPlan = {
  title: string;
  purpose: string;
  startFrame: number;
  endFrame: number;
  narrativeMapBeatId: Id;
  kind: ExplainerSceneKind;
  primaryTask: string;
  assetIds?: Id[];
  evidenceCaptureId?: Id;
  states: Array<Omit<ExplainerSceneState, "id">>;
  props?: Record<string, unknown>;
};

function continuousStates(duration: number): Array<Omit<ExplainerSceneState, "id">> {
  return [
    { phase: "entry", startFrame: 0, endFrame: 6, label: "建立问题" },
    { phase: "progressive", startFrame: 6, endFrame: 14, label: "逐步揭示关系" },
    { phase: "settled", startFrame: 14, endFrame: duration - 4, label: "停留以便阅读" },
    { phase: "exit", startFrame: duration - 4, endFrame: duration, label: "为下一拍释放画面" }
  ];
}

function validProps(kind: ExplainerSceneKind): Record<string, unknown> {
  switch (kind) {
    case "HeroReveal":
      return { metric: "42%", label: "核心差异" };
    case "Comparison":
      return { leftLabel: "旧方式", rightLabel: "新方式", dimension: "反馈速度" };
    case "ProgressiveClassification":
      return { items: ["输入事实", "机制解释", "可执行结论"] };
    case "RouteAndFlow":
      return { nodes: ["观察", "判断", "行动"] };
    case "EvidenceDocument":
      return { focus: "原文限定条件" };
    case "UIWalkthrough":
      return { steps: ["打开设置", "确认开关", "保存结果"] };
    case "DataConclusion":
      return {
        values: [42, 18],
        labels: ["方案 A", "方案 B"],
        source: "原始研究页面，第 3 页表 1",
        unit: "%",
        baseline: "0%"
      };
    case "PeopleGrouping":
      return { groups: ["新用户", "熟练用户"], dimension: "使用经验" };
    case "LayerStack":
      return { layers: ["输入层", "规则层", "结果层"], relationship: "上层依赖下层提供的稳定输入" };
    case "HistoryTimeline":
      return {
        events: [
          { date: "2020", label: "问题首次出现" },
          { date: "2024", label: "规则完成修订" }
        ],
        source: "公开历史档案"
      };
    case "QuotePortrait":
      return { quote: "先理解问题，再决定工具。", attribution: "研究负责人", source: "公开访谈记录" };
    case "RealityBroll":
      return {};
  }
}

function createPlan(input: {
  kind: ExplainerSceneKind;
  narrativeMapBeatId: Id;
  startFrame?: number;
  endFrame?: number;
  assetIds?: Id[];
  evidenceCaptureId?: Id;
  states?: Array<Omit<ExplainerSceneState, "id">>;
  props?: Record<string, unknown>;
}): ExplainerPlan {
  const startFrame = input.startFrame ?? 0;
  const endFrame = input.endFrame ?? startFrame + 24;
  return {
    title: `${input.kind} 场景`,
    purpose: "让观众在稳定画面中完成当前认知任务",
    startFrame,
    endFrame,
    narrativeMapBeatId: input.narrativeMapBeatId,
    kind: input.kind,
    primaryTask: "建立并验证当前认知关系",
    assetIds: input.assetIds,
    evidenceCaptureId: input.evidenceCaptureId,
    states: input.states ?? continuousStates(endFrame - startFrame),
    props: input.props ?? validProps(input.kind)
  };
}

test("EvidenceCapture 必须绑定真实来源与归一化高亮，并拒绝生成素材伪装成证据", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "阶段 3 证据合同", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const sourceAssetId = addReadyAsset(context.app, projectId, "original-study.pdf", "document", { role: "evidence" });
    const snapshotAssetId = addReadyAsset(context.app, projectId, "original-study-page.png", "image", { role: "evidence" });
    const generatedAssetId = addReadyAsset(context.app, projectId, "generated-proof.png", "image", { generated: true, role: "evidence" });
    const { capture } = createEvidenceCapture(context.app, projectId, sourceAssetId, snapshotAssetId);

    assert.equal(capture.sourceAssetId, sourceAssetId);
    assert.equal(capture.snapshotAssetId, snapshotAssetId);
    assert.equal(capture.highlights.length, 1);
    assert.deepEqual(capture.highlights[0], { x: 0.12, y: 0.24, width: 0.48, height: 0.16, label: "原文限定条件" });
    assert.match(capture.excerpt, /样本/u, "EvidenceCapture 必须保存实际摘录，而非仅有网页标题");

    const beforeFailures = context.app.readProject(projectId);
    assert.throws(
      () => context.app.manageEvidenceCapture({
        projectId,
        baseRevision: beforeFailures.revision.number,
        action: "create",
        sourceAssetId: generatedAssetId,
        snapshotAssetId,
        sourceTitle: "生成页面",
        sourceUrl: "https://example.test/generated",
        excerpt: "这不是可追溯的原文。",
        claim: "虚构主张",
        limitation: "没有真实限制",
        highlights: [{ x: 0, y: 0, width: 0.2, height: 0.2 }]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "EVIDENCE_SOURCE_ASSET_INVALID"
    );
    assert.throws(
      () => context.app.manageEvidenceCapture({
        projectId,
        baseRevision: beforeFailures.revision.number,
        action: "create",
        sourceAssetId,
        snapshotAssetId: generatedAssetId,
        sourceTitle: "真实来源配生成截图",
        sourceUrl: "https://example.test/source",
        excerpt: "原文摘录仍然存在。",
        claim: "真实主张",
        limitation: "仍有适用边界",
        highlights: [{ x: 0, y: 0, width: 0.2, height: 0.2 }]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "EVIDENCE_SNAPSHOT_ASSET_INVALID"
    );
    assert.throws(
      () => context.app.manageEvidenceCapture({
        projectId,
        baseRevision: beforeFailures.revision.number,
        action: "create",
        sourceAssetId,
        snapshotAssetId,
        sourceTitle: "越界高亮",
        sourceUrl: "https://example.test/highlight",
        excerpt: "原文摘录。",
        claim: "测试高亮边界",
        limitation: "仅用于测试",
        highlights: [{ x: 0.9, y: 0.2, width: 0.2, height: 0.2 }]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_EVIDENCE_HIGHLIGHT"
    );
    assert.equal(context.app.readProject(projectId).revision.number, beforeFailures.revision.number, "无效证据写入必须原子回滚");
    // 创建必填与局部更新可省略是同一合同，不能为了必填说明破坏更新/删除。
    for (const highlights of [undefined, [], [{ x: 828, y: 828, width: 480, height: 155 }], [{ x: 0, y: 0, width: 0, height: 0.1 }]]) {
      assert.throws(() => context.app.manageEvidenceCapture({
        projectId, baseRevision: beforeFailures.revision.number, action: "create", sourceAssetId, snapshotAssetId,
        sourceTitle: "坐标合同回归", sourceUrl: "https://example.test/coordinate-contract", excerpt: "测试原文",
        claim: "验证归一化范围", limitation: "仅用于隔离测试", highlights
      }), (error: unknown) => error instanceof DomainError && ["EVIDENCE_HIGHLIGHT_REQUIRED", "INVALID_EVIDENCE_HIGHLIGHT"].includes(error.code));
      assert.equal(context.app.readProject(projectId).revision.number, beforeFailures.revision.number);
    }
    const updated = context.app.manageEvidenceCapture({ projectId, baseRevision: beforeFailures.revision.number,
      action: "update", evidenceCaptureId: capture.id, limitation: "仅更新限制，不替换高亮" });
    assert.deepEqual(updated.snapshot.evidenceCaptures[0]!.highlights, capture.highlights);
    const removed = context.app.manageEvidenceCapture({ projectId, baseRevision: updated.revision.number,
      action: "remove", evidenceCaptureId: capture.id });
    assert.equal(removed.snapshot.evidenceCaptures.length, 0);
  } finally {
    await context.dispose();
  }
});

test("NarrativeMap 可编译十二种 Explainer Program，局部状态连续且纯解释片仍有实际时长", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "阶段 3 七种视觉语法", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const sourceAssetId = addReadyAsset(context.app, projectId, "research-source.pdf", "document", { role: "evidence" });
    const snapshotAssetId = addReadyAsset(context.app, projectId, "research-snapshot.png", "image", { role: "evidence" });
    const uiAssetId = addReadyAsset(context.app, projectId, "real-product-screen.png", "image");
    const portraitAssetId = addReadyAsset(context.app, projectId, "real-expert-portrait.png", "image");
    const brollAssetId = addReadyAsset(context.app, projectId, "real-workplace-broll.mp4", "video");
    const { capture } = createEvidenceCapture(context.app, projectId, sourceAssetId, snapshotAssetId);
    const kinds: ExplainerSceneKind[] = [
      "HeroReveal",
      "Comparison",
      "ProgressiveClassification",
      "RouteAndFlow",
      "EvidenceDocument",
      "UIWalkthrough",
      "DataConclusion",
      "PeopleGrouping",
      "LayerStack",
      "HistoryTimeline",
      "QuotePortrait",
      "RealityBroll"
    ];
    const { narrativeMap } = createStoryAndNarrativeMap(context.app, projectId, kinds, capture.id);
    const readMap = context.app.readNarrativeMap({ projectId });
    assert.equal(readMap.narrativeMap?.id, narrativeMap.id);
    assert.equal(readMap.narrativeMap?.beats.length, kinds.length);
    assert.equal(readMap.narrativeMap?.beats[4]?.evidenceCaptureIds[0], capture.id, "NarrativeMap 应显式交接证据而不是自由文本引用");

    const compiled = context.app.compileExplainerScenes({
      projectId,
      baseRevision: readMap.revision,
      plans: kinds.map((kind, index) => createPlan({
        kind,
        narrativeMapBeatId: narrativeMap.beats[index]!.id,
        startFrame: index * 24,
        endFrame: (index + 1) * 24,
        assetIds: kind === "UIWalkthrough" ? [uiAssetId]
          : kind === "QuotePortrait" ? [portraitAssetId]
            : kind === "RealityBroll" ? [brollAssetId]
              : undefined,
        evidenceCaptureId: kind === "EvidenceDocument" ? capture.id : undefined
      }))
    });
    const programs = context.app.readExplainerScenePrograms({ projectId }).programs;
    assert.equal(programs.length, kinds.length);
    assert.deepEqual(programs.map((program) => program.kind), kinds);
    assert.ok(programs.every((program) => program.status === "ready" && program.cacheKey.length === 32));
    assert.ok(programs.every((program) => {
      const scene = compiled.snapshot.scenes.find((candidate) => candidate.id === program.sceneId);
      if (!scene) return false;
      const duration = scene.endFrame - scene.startFrame;
      return scene.type === "ExplainerScene"
        && program.states[0]?.startFrame === 0
        && program.states.at(-1)?.endFrame === duration
        && program.states.every((state, index) => index === 0 || program.states[index - 1]!.endFrame === state.startFrame)
        && new Set(program.states.map((state) => state.phase)).size === 4;
    }), "每个 Program 的 Entry/Progressive/Settled/Exit 必须连续覆盖 Scene 局部帧");
    assert.equal(compiled.snapshot.timeline.items.length, 0, "解释片的视觉主体可由 Remotion Program 直接产生，不要求伪造物理视频 Item");
    assert.equal(compiled.snapshot.timeline.durationInFrames, 288, "没有物理 Item 的 Explainer-only 项目仍应以 Scene 结束帧计算时长");

    const evidenceProgram = programs.find((program) => program.kind === "EvidenceDocument");
    assert.ok(evidenceProgram, "十二种 Program 中必须包含 EvidenceDocument");
    const changedEvidence = context.app.manageEvidenceCapture({
      projectId,
      baseRevision: compiled.revision.number,
      action: "update",
      evidenceCaptureId: capture.id,
      excerpt: "更新后的原文摘录明确了新的适用限制。"
    });
    const staleProgram = changedEvidence.snapshot.explainerPrograms.find((program) => program.id === evidenceProgram.id);
    const staleScene = changedEvidence.snapshot.scenes.find((scene) => scene.id === evidenceProgram.sceneId);
    assert.equal(staleProgram?.status, "stale", "证据变化必须使依赖它的 Program 失效");
    assert.equal(staleScene?.status, "stale", "证据变化必须使实际 Scene 一起进入待重编译状态");
    assert.ok(changedEvidence.revision.impact.stale.includes(evidenceProgram.id));
    assert.equal(context.app.readExplainerScenePrograms({ projectId, sceneId: evidenceProgram.sceneId }).programs[0]?.status, "stale");
  } finally {
    await context.dispose();
  }
});

test("新增解释 Scene 类型拒绝伪造事实，并在质量报告中持续阻塞失真的 Revision", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "阶段 3 新增视觉语法门禁", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const sourceAssetId = addReadyAsset(context.app, projectId, "quote-source.pdf", "document", { role: "evidence" });
    const snapshotAssetId = addReadyAsset(context.app, projectId, "quote-source-page.png", "image", { role: "evidence" });
    const portraitAssetId = addReadyAsset(context.app, projectId, "real-speaker.png", "image");
    const brollAssetId = addReadyAsset(context.app, projectId, "real-scene.mp4", "video");
    const generatedBrollAssetId = addReadyAsset(context.app, projectId, "generated-scene.mp4", "video", { generated: true });
    const { capture } = createEvidenceCapture(context.app, projectId, sourceAssetId, snapshotAssetId);
    const { narrativeMap } = createStoryAndNarrativeMap(context.app, projectId, ["分组", "层级", "历史", "引语", "现实"]);
    const baseRevision = context.app.readProject(projectId).revision.number;

    assert.throws(
      () => context.app.compileExplainerScenes({
        projectId,
        baseRevision,
        plans: [createPlan({
          kind: "HistoryTimeline",
          narrativeMapBeatId: narrativeMap.beats[2]!.id,
          props: { events: [{ date: "2020", label: "第一次记录" }, { date: "2024", label: "规则更新" }] }
        })]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "HISTORY_TIMELINE_FACTS_REQUIRED"
    );
    assert.throws(
      () => context.app.compileExplainerScenes({
        projectId,
        baseRevision,
        plans: [createPlan({
          kind: "QuotePortrait",
          narrativeMapBeatId: narrativeMap.beats[3]!.id,
          assetIds: [portraitAssetId],
          evidenceCaptureId: capture.id
        })]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "QUOTE_PORTRAIT_EVIDENCE_CAPTURE_BLOCKED"
    );
    assert.throws(
      () => context.app.compileExplainerScenes({
        projectId,
        baseRevision,
        plans: [createPlan({
          kind: "RealityBroll",
          narrativeMapBeatId: narrativeMap.beats[4]!.id,
          assetIds: [generatedBrollAssetId]
        })]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "REALITY_BROLL_ASSET_REQUIRED"
    );
    assert.equal(context.app.readProject(projectId).revision.number, baseRevision, "新增类型的拒绝路径不能留下半成品 Revision");

    const compiled = context.app.compileExplainerScenes({
      projectId,
      baseRevision,
      plans: [
        createPlan({ kind: "PeopleGrouping", narrativeMapBeatId: narrativeMap.beats[0]!.id, startFrame: 0, endFrame: 24 }),
        createPlan({ kind: "LayerStack", narrativeMapBeatId: narrativeMap.beats[1]!.id, startFrame: 24, endFrame: 48 }),
        createPlan({ kind: "HistoryTimeline", narrativeMapBeatId: narrativeMap.beats[2]!.id, startFrame: 48, endFrame: 72 }),
        createPlan({ kind: "QuotePortrait", narrativeMapBeatId: narrativeMap.beats[3]!.id, startFrame: 72, endFrame: 96, assetIds: [portraitAssetId] }),
        createPlan({ kind: "RealityBroll", narrativeMapBeatId: narrativeMap.beats[4]!.id, startFrame: 96, endFrame: 120, assetIds: [brollAssetId] })
      ]
    });
    const readyReport = evaluateQuality(compiled.snapshot, compiled.revision.number);
    assert.equal(readyReport.issues.some((entry) => /^(PEOPLE_GROUPING|LAYER_STACK|HISTORY_TIMELINE|QUOTE_PORTRAIT|REALITY_BROLL)_FACTS_INVALID$/u.test(entry.code)), false);

    // 模拟历史 Revision 被外部旧数据污染；质量系统仍要在导出前阻断，而不能只相信编译入口。
    const invalidSnapshot = structuredClone(compiled.snapshot);
    const program = (kind: ExplainerSceneKind) => {
      const target = invalidSnapshot.explainerPrograms.find((candidate) => candidate.kind === kind);
      assert.ok(target, `必须找到 ${kind} Program`);
      return target;
    };
    program("PeopleGrouping").props = { groups: ["单一标签"], dimension: "使用经验" };
    program("LayerStack").props = { layers: ["只有一层"], relationship: "没有可解释关系" };
    program("HistoryTimeline").props = { events: [{ date: "2020", label: "唯一事件" }], source: "公开档案" };
    program("QuotePortrait").evidenceCaptureId = capture.id;
    program("RealityBroll").assetIds = [generatedBrollAssetId];
    const invalidReport = evaluateQuality(invalidSnapshot, compiled.revision.number);
    for (const code of [
      "PEOPLE_GROUPING_FACTS_INVALID",
      "LAYER_STACK_FACTS_INVALID",
      "HISTORY_TIMELINE_FACTS_INVALID",
      "QUOTE_PORTRAIT_FACTS_INVALID",
      "REALITY_BROLL_FACTS_INVALID"
    ]) {
      assert.ok(invalidReport.issues.some((entry) => entry.code === code && entry.level === "blocking"), `${code} 必须阻断交付`);
    }
  } finally {
    await context.dispose();
  }
});

test("Data、Comparison、Classification 和有空档的状态范围必须在编译前被拒绝", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "阶段 3 解释事实门禁", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const { narrativeMap } = createStoryAndNarrativeMap(context.app, projectId, ["数据", "比较", "分类", "状态范围"]);
    const currentRevision = context.app.readProject(projectId).revision.number;

    assert.throws(
      () => context.app.compileExplainerScenes({
        projectId,
        baseRevision: currentRevision,
        plans: [createPlan({
          kind: "DataConclusion",
          narrativeMapBeatId: narrativeMap.beats[0]!.id,
          props: { values: [42], labels: ["方案 A"], source: "原始表格", unit: "%" }
        })]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "DATA_CONCLUSION_FACTS_REQUIRED"
    );
    assert.throws(
      () => context.app.compileExplainerScenes({
        projectId,
        baseRevision: currentRevision,
        plans: [createPlan({
          kind: "Comparison",
          narrativeMapBeatId: narrativeMap.beats[1]!.id,
          props: { leftLabel: "旧方式", rightLabel: "新方式" }
        })]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "COMPARISON_FACTS_REQUIRED"
    );
    assert.throws(
      () => context.app.compileExplainerScenes({
        projectId,
        baseRevision: currentRevision,
        plans: [createPlan({
          kind: "ProgressiveClassification",
          narrativeMapBeatId: narrativeMap.beats[2]!.id,
          props: { items: ["只有一个分类"] }
        })]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "CLASSIFICATION_ITEMS_REQUIRED"
    );
    assert.throws(
      () => context.app.compileExplainerScenes({
        projectId,
        baseRevision: currentRevision,
        plans: [createPlan({
          kind: "HeroReveal",
          narrativeMapBeatId: narrativeMap.beats[3]!.id,
          states: [
            { phase: "entry", startFrame: 0, endFrame: 5, label: "建立" },
            { phase: "progressive", startFrame: 6, endFrame: 14, label: "揭示" },
            { phase: "settled", startFrame: 14, endFrame: 20, label: "阅读" },
            { phase: "exit", startFrame: 20, endFrame: 24, label: "退出" }
          ]
        })]
      }),
      (error: unknown) => error instanceof DomainError && error.code === "EXPLAINER_STATE_GAP_INVALID"
    );
    const afterFailures = context.app.readProject(projectId);
    assert.equal(afterFailures.revision.number, currentRevision, "任何一项事实或状态不完整时都不能留下半成品 Scene");
    assert.equal(afterFailures.snapshot.explainerPrograms.length, 0);
    assert.equal(afterFailures.snapshot.scenes.length, 0);
  } finally {
    await context.dispose();
  }
});

test("局部启停 Program 保留其它对象、可恢复并持久化，失败不产生 Revision", async () => {
  const context = await createTestApplication();
  try {
    const projectId = context.app.createProject({ name: "局部主视觉回归", profile: "hybrid" }).snapshot.project.id;
    const assetId = addReadyAsset(context.app, projectId, "unused-old-visual.png", "image");
    const { narrativeMap } = createStoryAndNarrativeMap(context.app, projectId, ["旧比较", "其它场景"]);
    const compiled = context.app.compileExplainerScenes({ projectId, baseRevision: context.app.readProject(projectId).revision.number, plans: [
      createPlan({ kind: "Comparison", narrativeMapBeatId: narrativeMap.beats[0]!.id, assetIds: [assetId] }),
      createPlan({ kind: "HeroReveal", narrativeMapBeatId: narrativeMap.beats[1]!.id, startFrame: 24, endFrame: 48 })
    ] });
    const program = compiled.snapshot.explainerPrograms[0]!;
    // 缺省字段的既有 Revision 必须继续正常渲染。
    assert.equal(program.disabled, undefined);
    assert.ok(resolveCompositionReachability(compiled.snapshot).explainerProgramIds.has(program.id));
    const withCue = context.app.createEffectCue({ projectId, baseRevision: compiled.revision.number, sceneId: program.sceneId, type: "CameraPunch", layer: "actor", startFrame: 0, endFrame: 24 });
    const before = context.app.readProject(projectId);
    const off = context.app.setExplainerProgramEnabled({ projectId, baseRevision: withCue.revision.number, programId: program.id, enabled: false });
    assert.equal(off.snapshot.explainerPrograms[0]!.disabled, true);
    for (const key of ["scenes", "story", "narrativeMap", "effectCues", "timeline", "audioCues", "assets", "sourceCaptionPrograms"] as const) {
      assert.deepEqual(off.snapshot[key], before.snapshot[key], `${key} 不得跟随旧主视觉被删除或重建`);
    }
    assert.deepEqual(off.snapshot.explainerPrograms[1], before.snapshot.explainerPrograms[1]);
    assert.deepEqual(off.revision.impact.changed, [program.id]);
    assert.deepEqual(off.revision.impact.stale, []);
    assert.ok(off.revision.impact.dirtyRanges.some((range) => range.startFrame === 0 && range.endFrame === 24));
    const reachable = resolveCompositionReachability(off.snapshot);
    assert.ok(!reachable.explainerProgramIds.has(program.id));
    assert.ok(!reachable.assetIds.has(assetId), "旧主视觉独占的素材不再是渲染依赖");
    assert.ok(reachable.effectCueIds.has(withCue.snapshot.effectCues[0]!.id));
    assert.equal(evaluateQuality(off.snapshot, off.revision.number).issues.some((item) => item.code === "EXPLAINER_SCENE_PROGRAM_MISSING"), false);
    for (const input of [
      { baseRevision: withCue.revision.number, programId: program.id, enabled: true },
      { baseRevision: off.revision.number, programId: "missing", enabled: false },
      { baseRevision: off.revision.number, programId: program.id, enabled: "false" as unknown as boolean }
    ]) assert.throws(() => context.app.setExplainerProgramEnabled({ projectId, ...input }));
    assert.deepEqual(context.app.readProject(projectId), off);
    const reader = createApplication(context.root);
    try { assert.equal(reader.readProject(projectId).snapshot.explainerPrograms[0]!.disabled, true); } finally { reader.close(); }
    const on = context.app.setExplainerProgramEnabled({ projectId, baseRevision: off.revision.number, programId: program.id, enabled: true });
    assert.equal(on.snapshot.explainerPrograms[0]!.disabled, false);
    assert.ok(resolveCompositionReachability(on.snapshot).assetIds.has(assetId));
    assert.equal(on.snapshot.explainerPrograms[0]!.cacheKey, program.cacheKey);
    assert.equal(context.app.repository.getRevision(projectId, compiled.revision.number).snapshot.explainerPrograms[0]!.disabled, undefined, "历史不被覆盖");
    const stale = context.app.repository.commit(projectId, on.revision.number, "模拟上游失效", (snapshot) => { snapshot.explainerPrograms[0]!.status = "stale"; });
    const staleOff = context.app.setExplainerProgramEnabled({ projectId, baseRevision: stale.revision.number, programId: program.id, enabled: false });
    assert.throws(() => context.app.setExplainerProgramEnabled({ projectId, baseRevision: staleOff.revision.number, programId: program.id, enabled: true }), /失效|未就绪/u);
    assert.equal(context.app.readProject(projectId).revision.number, staleOff.revision.number);
    assert.equal(evaluateQuality(staleOff.snapshot, staleOff.revision.number).issues.some((item) => item.code === "EXPLAINER_PROGRAM_STALE" && item.objectId === program.id), false);
    const malformed = structuredClone(staleOff.snapshot);
    malformed.scenes.find((scene) => scene.id === program.sceneId)!.type = "PresenterScene";
    assert.throws(() => assertProjectGraphValid(malformed), /ExplainerScene/u);
  } finally { await context.dispose(); }
});

test("停用最后 Program 不撑出空尾，不把纯解释片伪装为已具备主视觉", async () => {
  const context = await createTestApplication();
  try {
    const projectId = context.app.createProject({ name: "停用主视觉时长", profile: "visual_explainer" }).snapshot.project.id;
    const { narrativeMap } = createStoryAndNarrativeMap(context.app, projectId, ["唯一主视觉"]);
    const compiled = context.app.compileExplainerScenes({ projectId, baseRevision: context.app.readProject(projectId).revision.number, plans: [createPlan({ kind: "HeroReveal", narrativeMapBeatId: narrativeMap.beats[0]!.id })] });
    const program = compiled.snapshot.explainerPrograms[0]!;
    const off = context.app.setExplainerProgramEnabled({ projectId, baseRevision: compiled.revision.number, programId: program.id, enabled: false });
    assert.equal(off.snapshot.timeline.durationInFrames, 0);
    assert.ok(evaluateQuality(off.snapshot, off.revision.number).issues.some((item) => item.code === "EXPLAINER_PRIMARY_VISUAL_MISSING" && item.level === "blocking"));
    const withCue = context.app.createEffectCue({ projectId, baseRevision: off.revision.number, sceneId: program.sceneId, type: "MetricBackdrop", layer: "front", startFrame: 0, endFrame: 20, props: { value: "42", unit: "%", label: "技术测试" } });
    assert.equal(withCue.snapshot.timeline.durationInFrames, 20, "局部停用不能裁掉仍然实际渲染的 Cue");
    const on = context.app.setExplainerProgramEnabled({ projectId, baseRevision: withCue.revision.number, programId: program.id, enabled: true });
    assert.equal(on.snapshot.timeline.durationInFrames, 24);
  } finally { await context.dispose(); }
});

test("PresenterScene 与 ExplainerScene 可以保留在同一 Hybrid 项目和同一 Revision", async () => {
  const context = await createTestApplication();
  try {
    const created = context.app.createProject({ name: "阶段 3 Presenter/Explainer 混合回归", profile: "hybrid" });
    const projectId = created.snapshot.project.id;
    const aRollAssetId = addReadyAsset(context.app, projectId, "hybrid-a-roll.mp4", "video");
    const story = context.app.updateStory({
      projectId,
      baseRevision: context.app.readProject(projectId).revision.number,
      title: "人物提出问题，再进入解释画面",
      summary: "验证两种 Scene 不需要拆成两个项目或两份 Revision。",
      beats: [
        { title: "人物提出问题", purpose: "由 A-roll 建立观看问题" },
        { title: "解释对象关系", purpose: "由 Explainer Scene 建立关系模型" }
      ]
    });
    const presenterTrack = context.app.assemblePresenterTrack({
      projectId,
      baseRevision: story.revision.number,
      assetIds: [aRollAssetId]
    });
    const presenter = context.app.compilePresenterScenes({
      projectId,
      baseRevision: presenterTrack.revision.number,
      scenes: [{
        title: "人物提出问题",
        purpose: "由受管 A-roll 建立观看问题。",
        startFrame: 0,
        endFrame: 24,
        narrativeBeatIds: [story.snapshot.story.beats[0]!.id]
      }]
    });
    const presenterScene = presenter.snapshot.scenes.find((scene) => scene.type === "PresenterScene");
    assert.ok(presenterScene, "混合项目必须先保留 PresenterScene");

    const narrative = context.app.manageNarrativeMap({
      projectId,
      baseRevision: presenter.revision.number,
      viewerQuestion: "人物提出问题后，关系如何被具体解释？",
      promisedModel: "A-roll 负责问题，ExplainerScene 负责持续可见的关系。",
      conclusion: "两种 Scene 共用一个 Project、Story、Timeline 与 Revision。",
      beats: story.snapshot.story.beats.map((beat, index) => ({
        narrativeBeatId: beat.id,
        enteringKnowledge: index === 0 ? "观众刚看到人物提出问题。" : "观众已经知道需要一个解释模型。",
        question: index === 0 ? "人物正在提出什么问题？" : "对象之间怎样连接？",
        newKnowledge: index === 0 ? "问题由人物主线建立。" : "关系由 ExplainerScene 在同一项目内展开。",
        deferredInformation: index === 0 ? "下一拍再建立对象关系。" : "本段已完成最小解释。"
      }))
    });
    const compiled = context.app.compileExplainerScenes({
      projectId,
      baseRevision: narrative.revision.number,
      plans: [createPlan({
        kind: "RouteAndFlow",
        narrativeMapBeatId: narrative.snapshot.narrativeMap!.beats[1]!.id,
        startFrame: 24,
        endFrame: 48,
        props: { nodes: ["人物问题", "项目对象", "解释结论"] }
      })]
    });

    const retainedPresenter = compiled.snapshot.scenes.find((scene) => scene.id === presenterScene.id);
    const explainerScene = compiled.snapshot.scenes.find((scene) => scene.type === "ExplainerScene");
    assert.ok(retainedPresenter && retainedPresenter.type === "PresenterScene", "编译 Explainer 不得删除同一 Revision 中的 PresenterScene");
    assert.ok(explainerScene && explainerScene.status === "ready", "同一 Revision 必须写入 ExplainerScene");
    assert.equal(compiled.snapshot.timeline.items.find((item) => item.assetId === aRollAssetId)?.sceneId, presenterScene.id, "Presenter A-roll Timeline Item 必须仍绑定原 PresenterScene");
    assert.equal(compiled.snapshot.timeline.durationInFrames, 48, "混合 Scene 必须共同决定同一 Timeline 的最终时长");
    assertProjectGraphValid(compiled.snapshot);
  } finally {
    await context.dispose();
  }
});
