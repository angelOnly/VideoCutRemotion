import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApplication, type EditingApplication } from "@videocut/application";
import type { AssetKind, ExplainerSceneKind, ExplainerSceneState, ProjectSnapshot, SpeechSegmentAsset } from "@videocut/contracts";
import { assertProjectGraphValid, millisecondsToFrames } from "@videocut/domain";
import { evaluateQuality } from "@videocut/quality";
import { probeMedia, runProcess } from "@videocut/speech";
import { inspectComposedFrames } from "../apps/server/src/preview-inspection.js";
import { RevisionRenderer, runExportJob, runPreviewJob, runRenderPreflight } from "../apps/render-worker/src/exporter.js";

/**
 * 阶段 3 的交付级离线 E2E。
 *
 * 它与 explainer-stage3.e2e.ts 的职责不同：旧脚本只覆盖纯视觉 Program 的渲染；
 * 本脚本把本地语音、稳定字幕、NarrativeMap、证据/图表 Scene、真实 Preview、
 * 当前 Revision 审片记录和 draft ExportArtifact 串成一条可重复的技术链路。
 *
 * 脚本不会把自动解码、抽帧或黑帧检测写成“人已审美通过”。因此只导出 draft，
 * 并将人工听感、可读性和首观众判断明确登记为 inconclusive。
 */
const fps = 24;
const keepWorkspace = process.argv.includes("--keep");

const narration = [
  "Every change begins with an owning project object, not with a blind timeline drag.",
  "That object tells us which revision, preview, captions, and export evidence need review.",
  "A visual explanation keeps the relationship on screen while the narration advances the question.",
  "This local acceptance specification records an evidence boundary and never claims an external business fact.",
  "The chart compares structure, preview, and file checks as internal technical counts, not market data.",
  "Finally, a fixed revision can produce a draft artifact after its technical evidence has been collected."
] as const;

/** 屏幕字幕是对英文技术旁白的短句摘要，明确标记为 manual，不伪装成逐字转写。 */
const technicalCaptionCards = [
  "变化先找到\n归属对象",
  "同一 Revision\n连接预览与交付",
  "视觉解释\n保持关系持续可见",
  "本地证据\n必须说明验证边界",
  "结构、预览、文件\n一起做技术检查",
  "固定 Revision\n再导出草稿文件"
] as const;

/** PNG 与文本源使用相同的本地规范内容，避免把色块或生成图伪装成可阅读证据。 */
const localEvidenceLines = [
  "STAGE 3 OFFLINE ACCEPTANCE SPECIFICATION",
  "Scope - Project objects, Preview evidence, Draft artifact",
  "Limit - Technical chain only, not external business evidence",
  "Human review remains required for audio, readability, and audience understanding"
] as const;

type SceneFixture = {
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

const sceneFixtures: SceneFixture[] = [
  {
    title: "先找到变化的归属对象",
    purpose: "用核心问题建立可追溯修改的观看任务。",
    primaryTask: "让观众知道变化不能从盲目拖动时间线开始。",
    kind: "HeroReveal",
    props: { metric: "1 个归属对象", qualifier: "先定位影响范围，再决定怎样修复。" },
    enteringKnowledge: "观众只知道修改会变慢。",
    question: "一个变化首先应该落在哪里？",
    newKnowledge: "变化先归属到项目对象，才能追踪它的下游影响。",
    deferredInformation: "下一拍才说明对象怎样连接预览和交付。"
  },
  {
    title: "关系会通向证据",
    purpose: "用持续存在的节点展示 Revision、Preview 和 Artifact 的关系。",
    primaryTask: "让观众看见同一事实怎样从项目进入可检查结果。",
    kind: "RouteAndFlow",
    props: { nodes: ["Project object", "Revision", "Preview evidence", "Draft artifact"] },
    enteringKnowledge: "观众知道修改需要一个归属对象。",
    question: "归属对象怎样影响最终结果？",
    newKnowledge: "对象、Revision、Preview 和 Artifact 是可复核的一条链。",
    deferredInformation: "下一拍才拆开视觉解释要承担的任务。"
  },
  {
    title: "解释不是连续标题卡",
    purpose: "用递进分类区分语义、视觉与技术验证的不同职责。",
    primaryTask: "让观众建立不同层各自负责什么的最小模型。",
    kind: "ProgressiveClassification",
    props: { items: ["语义：观众听到什么", "视觉：观众怎样理解关系", "技术：文件是否可复现"] },
    enteringKnowledge: "观众已经看到变化会沿关系传播。",
    question: "为什么不能让每个层都做同一件事？",
    newKnowledge: "语义、视觉和技术验证的职责不同，但共享当前 Revision。",
    deferredInformation: "下一拍才展示本脚本的本地证据边界。"
  },
  {
    title: "本地证据边界",
    purpose: "展示一个可追溯的本地技术验收来源及其限制。",
    primaryTask: "让观众知道证据对象和生成画面不能混为一谈。",
    kind: "EvidenceDocument",
    props: { focus: "离线测试范围与非业务事实声明" },
    enteringKnowledge: "观众知道不同职责仍要回到同一 Revision。",
    question: "这条 E2E 的证据到底能证明什么？",
    newKnowledge: "它证明本地对象、预览与文件链路，不证明外部业务事实或审美质量。",
    deferredInformation: "下一拍才用明确标注的内部计数展示技术覆盖面。"
  },
  {
    title: "技术覆盖面（内部样例）",
    purpose: "以明确非业务统计的图表并列呈现三类技术检查。",
    primaryTask: "让观众看见结构、预览和文件验证必须一起存在。",
    kind: "DataConclusion",
    props: {
      labels: ["结构", "预览", "文件"],
      values: [3, 5, 4],
      unit: "项",
      baseline: "0",
      source: "阶段 3 离线 E2E 内部计数（非业务统计）"
    },
    enteringKnowledge: "观众知道本地证据的用途与边界。",
    question: "自动化至少应把哪些技术层一起检查？",
    newKnowledge: "项目结构、真实预览和最终文件应并列验证。",
    deferredInformation: "最后一拍再收束为固定 Revision 的交付顺序。"
  },
  {
    title: "固定 Revision，保留判断边界",
    purpose: "把技术证据、人工判断和 draft Artifact 分层收束。",
    primaryTask: "让观众知道技术成功不等于已经完成正式交付。",
    kind: "LayerStack",
    props: {
      layers: ["本地素材与对象", "目标 Revision", "真实 Preview", "人工审片结论", "Draft Artifact"],
      relationship: "技术检查可自动化；听感、可读性和首观众判断仍需人工复核。"
    },
    enteringKnowledge: "观众已经看到三类自动化技术覆盖。",
    question: "怎样避免把工具成功误当成正式交付？",
    newKnowledge: "先固定 Revision 并收集证据，再由人决定是否进入 delivery。",
    deferredInformation: "本 E2E 至此结束，不代替真实观众或用户批准。"
  }
];

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/** 使用 Windows 自带的本地语音引擎生成测试旁白，不接入网络或 OmniVoice Bridge。 */
async function synthesizeOfflineSpeech(targetPath: string, text: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("阶段 3 交付 E2E 需要 Windows 本地语音引擎；当前平台没有可验证的离线语音实现。");
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "try {",
    "$voice = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' }) | Select-Object -First 1",
    "if ($null -eq $voice) { $voice = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled }) | Select-Object -First 1 }",
    "if ($null -eq $voice) { throw 'No enabled local SAPI voice is available.' }",
    "$synth.SelectVoice($voice.VoiceInfo.Name)",
    "$synth.Rate = 0",
    "$synth.Volume = 100",
    `$synth.SetOutputToWaveFile(${powershellLiteral(targetPath)})`,
    `$synth.Speak(${powershellLiteral(text)})`,
    "Write-Output $voice.VoiceInfo.Name",
    "} finally { $synth.Dispose() }"
  ].join("; ");
  const output = await runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], 120_000);
  return output.trim() || "Windows SAPI";
}

async function concatSpeechSegments(segmentPaths: string[], targetPath: string): Promise<void> {
  const inputs = segmentPaths.flatMap((path) => ["-i", path]);
  const labels = segmentPaths.map((_, index) => `[${index}:a]`).join("");
  await runProcess("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex", `${labels}concat=n=${segmentPaths.length}:v=0:a=1[audio]`,
    "-map", "[audio]",
    "-c:a", "pcm_s16le",
    targetPath
  ], 5 * 60_000);
}

function createStates(duration: number): Array<Omit<ExplainerSceneState, "id">> {
  assert.ok(duration >= 24, `每段离线旁白至少需要 1 秒以容纳完整 Explainer 状态，当前为 ${duration} 帧`);
  const entryEnd = Math.max(4, Math.floor(duration * 0.16));
  const progressiveEnd = Math.max(entryEnd + 4, Math.floor(duration * 0.48));
  const settledEnd = Math.max(progressiveEnd + 4, duration - Math.max(4, Math.floor(duration * 0.16)));
  return [
    { phase: "entry", startFrame: 0, endFrame: entryEnd, label: "建立当前问题" },
    { phase: "progressive", startFrame: entryEnd, endFrame: progressiveEnd, label: "逐步建立关系" },
    { phase: "settled", startFrame: progressiveEnd, endFrame: settledEnd, label: "保留阅读时间" },
    { phase: "exit", startFrame: settledEnd, endFrame: duration, label: "释放给下一拍" }
  ];
}

function importReadyAsset(input: {
  application: EditingApplication;
  projectId: string;
  name: string;
  kind: AssetKind;
  managedPath: string;
  metadata: Awaited<ReturnType<typeof probeMedia>>;
  role?: "evidence";
}): string {
  const imported = input.application.registerImportedAsset({
    projectId: input.projectId,
    baseRevision: input.application.readProject(input.projectId).revision.number,
    name: input.name,
    kind: input.kind,
    managedPath: input.managedPath,
    sourceHash: `stage3-delivery-${input.name}-local-fixture`,
    role: input.role,
    provenance: {
      source: "local_import",
      acquiredAt: new Date().toISOString()
    }
  });
  input.application.applyMediaAnalysis({ projectId: input.projectId, assetId: imported.asset.id, metadata: input.metadata });
  return imported.asset.id;
}

async function createLocalEvidenceFixture(projectRoot: string): Promise<{ sourcePath: string; snapshotPath: string }> {
  const directory = join(projectRoot, "assets", "source", "stage3-evidence");
  await mkdir(directory, { recursive: true });
  const sourcePath = join(directory, "offline-acceptance-specification.txt");
  const snapshotPath = join(directory, "offline-acceptance-specification.png");
  await writeFile(sourcePath, `${localEvidenceLines.join("\n")}\n`, "utf8");
  // 页面快照必须实际绘制同一份本地规范文本；它是技术测试来源，不伪装成外部业务证据。
  // FFmpeg filter 中必须转义盘符冒号；这里运行时为 C\:/Windows/...，不是双反斜杠。
  const fontFile = "C\\:/Windows/Fonts/arial.ttf";
  const drawText = [
    `drawtext=fontfile='${fontFile}':text='${localEvidenceLines[0]}':fontcolor=white:fontsize=34:x=105:y=105`,
    `drawtext=fontfile='${fontFile}':text='${localEvidenceLines[1]}':fontcolor=0x173B70:fontsize=28:x=115:y=280`,
    `drawtext=fontfile='${fontFile}':text='${localEvidenceLines[2]}':fontcolor=0x173B70:fontsize=28:x=115:y=420`,
    `drawtext=fontfile='${fontFile}':text='${localEvidenceLines[3]}':fontcolor=0x173B70:fontsize=24:x=115:y=540`
  ].join(",");
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "color=c=0xF6F8FC:s=1280x720:r=1",
    "-vf", `drawbox=x=70:y=70:w=1140:h=110:color=0x173B70:t=fill,drawbox=x=95:y=245:w=1090:h=86:color=0xDCEBFF:t=fill,drawbox=x=95:y=385:w=1090:h=86:color=0xFFF1C9:t=fill,drawbox=x=95:y=510:w=1090:h=76:color=0xE5EEF8:t=fill,${drawText}`,
    "-frames:v", "1",
    snapshotPath
  ], 120_000);
  return { sourcePath, snapshotPath };
}

async function createNarration(input: { application: EditingApplication; projectId: string }): Promise<{
  snapshot: ProjectSnapshot;
  voiceName: string;
}> {
  const projectRoot = input.application.readProject(input.projectId).snapshot.project.rootPath;
  const sourceDirectory = join(projectRoot, "assets", "source", "stage3-narration");
  await mkdir(sourceDirectory, { recursive: true });
  const segmentPaths = narration.map((_, index) => join(sourceDirectory, `segment-${index + 1}.wav`));
  const voiceNames = await Promise.all(narration.map((text, index) => synthesizeOfflineSpeech(segmentPaths[index]!, text)));
  assert.equal(new Set(voiceNames).size, 1, "同一条 E2E 旁白必须来自同一个本地语音身份");

  const segmentMetadata = await Promise.all(segmentPaths.map((path) => probeMedia(path)));
  assert.ok(segmentMetadata.every((metadata) => metadata.hasAudio && metadata.durationMs > 0), "每个本地旁白段都必须可播放");
  const segmentAssetIds = segmentPaths.map((path, index) => importReadyAsset({
    application: input.application,
    projectId: input.projectId,
    name: `stage3-local-narration-${index + 1}.wav`,
    kind: "speech",
    managedPath: `assets/source/stage3-narration/segment-${index + 1}.wav`,
    metadata: segmentMetadata[index]!
  }));

  const assemblyPath = join(sourceDirectory, "assembly.wav");
  await concatSpeechSegments(segmentPaths, assemblyPath);
  const assemblyMetadata = await probeMedia(assemblyPath);
  assert.ok(assemblyMetadata.hasAudio && assemblyMetadata.durationMs > 0, "组装后的离线旁白必须含可播放音轨");
  const assemblyAssetId = importReadyAsset({
    application: input.application,
    projectId: input.projectId,
    name: "stage3-local-narration-assembly.wav",
    kind: "speech",
    managedPath: "assets/source/stage3-narration/assembly.wav",
    metadata: assemblyMetadata
  });

  const transcript = input.application.applyTranscript({
    projectId: input.projectId,
    baseRevision: input.application.readProject(input.projectId).revision.number,
    assetId: assemblyAssetId,
    // 当前候选分句器以中文终止符、!/? 或换行作为候选边界；英文句号不承担该职责。
    text: narration.join("\n"),
    source: "manual"
  });
  assert.equal(transcript.snapshot.transcriptSentenceCandidates.length, narration.length, "每一段本地旁白应形成一个候选句");
  const semantic = input.application.applySemanticUnits({
    projectId: input.projectId,
    baseRevision: transcript.revision.number,
    units: transcript.snapshot.transcriptSentenceCandidates.map((candidate) => ({
      candidateIds: [candidate.id],
      text: candidate.text,
      kind: "statement" as const,
      confidence: 1,
      pauseBefore: { durationMs: 0, reason: "sentence" as const }
    }))
  });
  const segments = semantic.snapshot.speechSegments.slice().sort((left, right) => left.order - right.order);
  assert.equal(segments.length, narration.length, "语义段与本地旁白段数量必须一致");

  let cursorMs = 0;
  const timings = segments.map((segment, index) => {
    const startMs = cursorMs;
    const nominalEndMs = cursorMs + segmentMetadata[index]!.durationMs;
    const endMs = index === segments.length - 1 ? assemblyMetadata.durationMs : nominalEndMs;
    cursorMs = endMs;
    return {
      speechSegmentId: segment.id,
      startMs,
      endMs,
      startFrame: millisecondsToFrames(startMs, fps),
      endFrame: index === segments.length - 1 ? millisecondsToFrames(assemblyMetadata.durationMs, fps) : millisecondsToFrames(endMs, fps)
    };
  });
  assert.equal(timings.at(-1)?.endFrame, millisecondsToFrames(assemblyMetadata.durationMs, fps), "最终 SpeechTiming 必须覆盖真实旁白时长");
  const segmentAssets: SpeechSegmentAsset[] = segments.map((segment, index) => ({
    id: `stage3_local_speech_segment_${index + 1}`,
    speechSegmentId: segment.id,
    voiceReferenceAssetId: segmentAssetIds[index]!,
    assetId: segmentAssetIds[index]!,
    durationMs: segmentMetadata[index]!.durationMs,
    bridgeRunId: `local-sapi-stage3-${index + 1}`,
    schemaVersion: "windows-sapi-local-v1",
    quality: "passed"
  }));
  const assembled = input.application.applySpeechAssembly({
    projectId: input.projectId,
    generatedAssets: [],
    segmentAssets,
    speechAsset: {
      id: "stage3_local_speech_asset",
      assetId: assemblyAssetId,
      scriptRevision: semantic.snapshot.script.revision,
      segmentAssetIds: segmentAssets.map((asset) => asset.id),
      timing: { precision: "segment_exact", source: "Windows 本地 SAPI 的真实 WAV 时长", segments: timings },
      status: "ready"
    }
  });
  assert.equal(assembled.snapshot.timeline.captions.length, narration.length, "可播放 SpeechAsset 必须派生稳定字幕 Card");
  assert.ok(assembled.snapshot.timeline.captions.every((caption) => caption.precision === "segment_exact"), "离线 SAPI 只声明段级精度，不能伪造逐词时序");
  let captionState = assembled;
  for (const [index, caption] of captionState.snapshot.timeline.captions.entries()) {
    // 英文旁白较长，稳定字幕使用明确的中文屏幕摘要；这会在质量系统中保留 manual 复核提示。
    captionState = input.application.editCaptions({
      projectId: input.projectId,
      baseRevision: captionState.revision.number,
      captionId: caption.id,
      action: "update",
      text: technicalCaptionCards[index]!
    });
  }
  assert.ok(captionState.snapshot.timeline.captions.every((caption) => caption.textMode === "manual" && caption.text.length <= 80), "摘要字幕必须明确记录为手工屏幕文案");
  return { snapshot: captionState.snapshot, voiceName: voiceNames[0]! };
}

async function createExplainerProgram(input: { application: EditingApplication; projectId: string }): Promise<{ snapshot: ProjectSnapshot; revision: number; evidenceSceneFrame: number; chartSceneFrame: number }> {
  const afterSpeech = input.application.readProject(input.projectId);
  const projectRoot = afterSpeech.snapshot.project.rootPath;
  const fixture = await createLocalEvidenceFixture(projectRoot);
  const evidenceSourceId = importReadyAsset({
    application: input.application,
    projectId: input.projectId,
    name: "stage3-offline-acceptance-specification.txt",
    kind: "document",
    managedPath: "assets/source/stage3-evidence/offline-acceptance-specification.txt",
    metadata: { durationMs: 1, hasAudio: false, mime: "text/plain" },
    role: "evidence"
  });
  const evidenceSnapshotId = importReadyAsset({
    application: input.application,
    projectId: input.projectId,
    name: "stage3-offline-acceptance-specification.png",
    kind: "image",
    managedPath: "assets/source/stage3-evidence/offline-acceptance-specification.png",
    metadata: { durationMs: 1, hasAudio: false, width: 1280, height: 720, mime: "image/png" },
    role: "evidence"
  });
  // 文件存在性在这里提前确认，真正的可读性仍由后续 Render Preflight 和 Remotion Render 验证。
  assert.ok(fixture.sourcePath.endsWith(".txt") && fixture.snapshotPath.endsWith(".png"));

  const evidence = input.application.manageEvidenceCapture({
    projectId: input.projectId,
    baseRevision: input.application.readProject(input.projectId).revision.number,
    action: "create",
    sourceAssetId: evidenceSourceId,
    snapshotAssetId: evidenceSnapshotId,
    sourceTitle: "阶段 3 离线技术验收规范（测试素材）",
    publisher: "VideoFlowCut 离线 E2E",
    sourceUrl: "urn:videocut:stage3:offline-technical-fixture",
    capturedAt: "2026-09-02T00:00:00.000Z",
    pageOrRange: "固定测试页面",
    excerpt: "本地验收只验证项目对象、预览证据和 draft Artifact 的链路。",
    claim: "当前 Revision 绑定了一个可读回的本地 EvidenceCapture。",
    limitation: "该素材不代表外部业务事实、用户素材或人工创意审片结论。",
    highlights: [{ x: 0.085, y: 0.34, width: 0.79, height: 0.15, label: "离线技术验证范围" }]
  });
  const evidenceCapture = evidence.snapshot.evidenceCaptures.at(-1);
  assert.ok(evidenceCapture, "EvidenceCapture 必须写回当前 Revision");

  const story = input.application.updateStory({
    projectId: input.projectId,
    baseRevision: evidence.revision.number,
    title: "阶段 3：从项目对象到可复核的草稿文件",
    summary: "所有文字、数据和证据均是本地技术验收样例，不代表外部业务结论。",
    beats: sceneFixtures.map((fixture) => ({ title: fixture.title, purpose: fixture.purpose }))
  });
  const narrativeMap = input.application.manageNarrativeMap({
    projectId: input.projectId,
    baseRevision: story.revision.number,
    viewerQuestion: "怎样把视觉解释片的项目事实变成可复核的技术证据？",
    promisedModel: "Project 对象、NarrativeMap、Explainer Scene、Preview 与 Artifact 共同绑定当前 Revision。",
    conclusion: "本 E2E 证明技术链路可运行，但不代替人工判断视频是否真正好看、好听或适合观众。",
    beats: story.snapshot.story.beats.map((beat, index) => ({
      narrativeBeatId: beat.id,
      enteringKnowledge: sceneFixtures[index]!.enteringKnowledge,
      question: sceneFixtures[index]!.question,
      newKnowledge: sceneFixtures[index]!.newKnowledge,
      deferredInformation: sceneFixtures[index]!.deferredInformation,
      claim: sceneFixtures[index]!.newKnowledge,
      evidenceCaptureIds: index === 3 ? [evidenceCapture.id] : []
    }))
  });

  const speech = narrativeMap.snapshot.speechAsset;
  assert.ok(speech, "编译 Explainer Scene 前必须已有当前 SpeechAsset");
  assert.equal(speech.timing.segments.length, sceneFixtures.length, "每个 NarrativeBeat 使用一段真实旁白时序");
  const compiled = input.application.compileExplainerScenes({
    projectId: input.projectId,
    baseRevision: narrativeMap.revision.number,
    plans: sceneFixtures.map((fixtureDefinition, index) => {
      const timing = speech.timing.segments[index]!;
      const duration = timing.endFrame - timing.startFrame;
      return {
        title: fixtureDefinition.title,
        purpose: fixtureDefinition.purpose,
        startFrame: timing.startFrame,
        endFrame: timing.endFrame,
        narrativeMapBeatId: narrativeMap.snapshot.narrativeMap!.beats[index]!.id,
        kind: fixtureDefinition.kind,
        primaryTask: fixtureDefinition.primaryTask,
        evidenceCaptureId: fixtureDefinition.kind === "EvidenceDocument" ? evidenceCapture.id : undefined,
        states: createStates(duration),
        props: fixtureDefinition.props,
        visualTreatment: {
          mode: "remotion",
          intensity: index === 3 ? "low" : "medium",
          primaryAttention: fixtureDefinition.primaryTask,
          narrativePurpose: fixtureDefinition.purpose,
          quietReason: index === 3 ? "证据阅读时不叠加额外装饰。" : undefined
        }
      };
    })
  });
  const snapshot = compiled.snapshot;
  assert.equal(snapshot.explainerPrograms.length, sceneFixtures.length, "每个 NarrativeBeat 必须编译出一个 Explainer Program");
  assert.ok(snapshot.explainerPrograms.every((program) => program.status === "ready"), "导出前全部 Explainer Program 必须 ready");
  assert.equal(snapshot.timeline.durationInFrames, speech.timing.segments.at(-1)!.endFrame, "视觉 Program、字幕和 Dialogue 必须覆盖同一最终时长");
  assertProjectGraphValid(snapshot);
  const report = evaluateQuality(snapshot, compiled.revision.number);
  assert.equal(report.requiredFixes.length, 0, `阶段 3 技术对象不应存在导出阻塞：${report.requiredFixes.map((issue) => issue.code).join(", ")}`);
  const evidenceScene = snapshot.scenes.find((scene) => scene.type === "ExplainerScene" && snapshot.explainerPrograms.some((program) => program.sceneId === scene.id && program.kind === "EvidenceDocument"));
  const chartScene = snapshot.scenes.find((scene) => scene.type === "ExplainerScene" && snapshot.explainerPrograms.some((program) => program.sceneId === scene.id && program.kind === "DataConclusion"));
  assert.ok(evidenceScene && chartScene, "E2E 必须实际包含证据 Scene 与图表 Scene");
  return {
    snapshot,
    revision: compiled.revision.number,
    evidenceSceneFrame: Math.floor((evidenceScene.startFrame + evidenceScene.endFrame - 1) / 2),
    chartSceneFrame: Math.floor((chartScene.startFrame + chartScene.endFrame - 1) / 2)
  };
}

async function assertPlayableMedia(path: string, expectedDurationMs: number): Promise<void> {
  const metadata = await probeMedia(path);
  assert.ok(metadata.videoCodec, "输出必须含可解码视频流");
  assert.ok(metadata.hasAudio, "输出必须含可播放音轨");
  assert.ok(Math.abs(metadata.durationMs - expectedDurationMs) <= 1_000, `输出时长异常：期望约 ${expectedDurationMs}ms，实际 ${metadata.durationMs}ms`);
  await runProcess("ffmpeg", ["-v", "error", "-i", path, "-map", "0:v:0", "-f", "null", "-"], 10 * 60_000);
  await runProcess("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "null", "-"], 10 * 60_000);
  const blackDetect = await runProcess("ffmpeg", ["-hide_banner", "-i", path, "-vf", "blackdetect=d=0.25:pix_th=0.10", "-an", "-f", "null", "-"], 10 * 60_000);
  assert.doesNotMatch(blackDetect, /black_start:/u, "输出不得出现持续黑帧");
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "videocut-explainer-stage3-delivery-"));
  let application: EditingApplication | undefined;
  try {
    application = createApplication(root);
    const created = application.createProject({ name: "阶段 3 离线 Explainer 交付 E2E", profile: "visual_explainer" });
    const projectId = created.snapshot.project.id;
    const narrationState = await createNarration({ application, projectId });
    const program = await createExplainerProgram({ application, projectId });
    const renderer = new RevisionRenderer(undefined, 1);
    const expectedDurationMs = Math.round((program.snapshot.timeline.durationInFrames / program.snapshot.timeline.fps) * 1_000);

    const previewJob = application.submitPreview({
      projectId,
      revision: program.revision,
      fromFrame: 0,
      toFrame: program.snapshot.timeline.durationInFrames,
      idempotencyKey: `stage3-delivery-preview-r${program.revision}`
    });
    const previewResult = await runPreviewJob(application, previewJob, renderer);
    application.updateJob(previewJob.id, { status: "succeeded", result: previewResult });
    const previewPath = String(previewResult.path);
    await assertPlayableMedia(previewPath, expectedDurationMs);
    const frames = await inspectComposedFrames({
      projectRoot: program.snapshot.project.rootPath,
      previewPath,
      revision: program.revision,
      fromFrame: 0,
      toFrame: program.snapshot.timeline.durationInFrames,
      fps,
      frames: [0, program.evidenceSceneFrame, program.chartSceneFrame, program.snapshot.timeline.durationInFrames - 1]
    });
    await application.recordPreviewInspection({
      projectId,
      previewJobId: previewJob.id,
      revision: program.revision,
      frames: frames.map((frame) => ({ frame: frame.frame, relativePath: frame.relativePath }))
    });

    const run = await application.startProductionRun({
      projectId,
      baseRevision: program.revision,
      loadedSkills: ["project-basics", "production-director", "visual-explainer-director", "captions", "quality-verification", "export"],
      loadedReferences: ["stage3 离线技术 E2E；本地 SAPI 仅用于声音可播放性，不替代人工听感判断。"]
    });
    const editorial = await application.recordEditorialQualityReview({
      projectId,
      runId: run.id,
      revision: program.revision,
      passes: ["audio_only", "mute_visual", "audiovisual", "first_viewer", "mode_specific"],
      previewEvidence: [previewResult.relativePath as string, ...frames.map((frame) => frame.relativePath)],
      findings: [
        {
          pass: "audio_only",
          severity: "inconclusive",
          category: "audio",
          summary: "自动化已验证本地旁白音轨可解码，但未替代人工判断语速、重音、情绪或相邻段自然性。",
          evidence: "ffprobe 与 FFmpeg 已成功解码目标 Revision 的 Preview 音轨。",
          impact: "该项需要人工复听后才能作为正式 delivery 的声音结论。"
        },
        {
          pass: "mute_visual",
          severity: "inconclusive",
          category: "attention",
          summary: "自动化已抽取证据与图表范围的真实合成帧，但未替代人工判断阅读顺序、遮挡和可读性。",
          evidence: `已登记帧 ${program.evidenceSceneFrame} 与 ${program.chartSceneFrame} 的项目内 JPG 证据。`,
          impact: "证据阅读和图表理解仍需连续静音观看复核。"
        },
        {
          pass: "audiovisual",
          severity: "inconclusive",
          category: "pacing",
          summary: "自动化确认声画文件可播放且无持续黑帧，但未判断声画节奏是否自然。",
          evidence: "目标 Preview 已通过视频、音频解码与 blackdetect 技术检查。",
          impact: "正式交付前仍需完整声画播放。"
        },
        {
          pass: "first_viewer",
          severity: "inconclusive",
          category: "semantic",
          summary: "首次观众理解不能由离线脚本伪造。",
          evidence: "本脚本只有固定测试文案与技术输出，没有真人观看记录。",
          impact: "不能把本次 E2E 当作受众理解或用户批准。"
        },
        {
          pass: "mode_specific",
          severity: "inconclusive",
          category: "mode_specific",
          summary: "Explainer Scene 的 Program、EvidenceCapture 和 DataConclusion 已完成对象与渲染验证，但认知连续仍需人工审片。",
          evidence: "当前 Revision 已读回 6 个 ready Explainer Program，包含 EvidenceDocument 与 DataConclusion。",
          impact: "不得凭对象存在或单帧证据宣称解释片创意质量已通过。"
        }
      ]
    });
    assert.equal(editorial.editorialReview?.revision, program.revision, "Editorial Review 必须绑定目标 Revision");

    const preflight = await runRenderPreflight(application, projectId, program.revision);
    assert.equal(preflight.status, "passed", `Render Preflight 未通过：${preflight.checks.filter((check) => check.status === "failed").map((check) => check.code).join(", ")}`);
    const exportJob = application.submitExport({
      projectId,
      revision: program.revision,
      purpose: "draft",
      idempotencyKey: `stage3-delivery-draft-r${program.revision}`
    });
    const exportResult = await runExportJob(application, exportJob, renderer);
    const artifactId = String(exportResult.artifactId);
    const artifact = application.readExportArtifact({ projectId, artifactId });
    assert.equal(artifact.revision, program.revision, "ExportArtifact 必须固定到已审片的目标 Revision");
    assert.equal(artifact.purpose, "draft", "自动化 E2E 只能产生 draft，不能伪造正式 delivery");
    assert.equal(artifact.preflight.status, "passed", "Artifact 必须保存通过的 Render Preflight");
    assert.ok(artifact.validation.hasAudio && artifact.validation.durationMs > 0, "Artifact 必须保存实际视频与音轨的技术验证");
    await assertPlayableMedia(String(exportResult.path), expectedDurationMs);

    console.log(JSON.stringify({
      projectId,
      revision: program.revision,
      durationSeconds: program.snapshot.timeline.durationInFrames / fps,
      localVoice: narrationState.voiceName,
      sceneKinds: program.snapshot.explainerPrograms.map((entry) => entry.kind),
      captions: program.snapshot.timeline.captions.length,
      preview: keepWorkspace ? previewResult.path : "临时 Preview 已完成技术验证并将在退出时清理",
      artifact: keepWorkspace ? exportResult.path : "临时 draft Artifact 已完成技术验证并将在退出时清理",
      technicalValidated: [
        "NarrativeMap、EvidenceCapture、EvidenceDocument 与 DataConclusion 已绑定同一 Revision",
        "本地 SAPI 旁白、Dialogue 轨与 segment_exact 稳定字幕可播放",
        "Preview 和 draft Artifact 已完成 H.264/AAC 解码、时长、音轨、黑帧与合成帧检查",
        "Render Preflight 与 ExportArtifact 已持久化目标 Revision 的技术事实"
      ],
      notClaimed: [
        "自动化不替代人工只听声音、静音视觉、完整声画、首次观众与 Explainer 认知连续判断",
        "本次只导出 draft，未产生 delivery、用户批准或外部业务事实结论"
      ]
    }, null, 2));
  } finally {
    application?.close();
    if (keepWorkspace) console.log(`保留阶段 3 交付 E2E 工作目录：${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
