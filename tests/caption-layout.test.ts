import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplication } from "@videocut/application";
import type { CaptionCard, ProjectSnapshot } from "@videocut/contracts";
import { evaluateQuality, evaluateQualityWithBrowser } from "@videocut/quality";
import { activeCaptionsAtFrame } from "@videocut/remotion";
import { layoutCaptionWithMeasure, layoutCaptionConservatively } from "../packages/remotion-runtime/src/caption-layout.js";
import { measureCaptionLayouts } from "../packages/quality-system/src/caption-measurement.js";
import { RevisionRenderer, runRenderPreflight } from "../apps/render-worker/src/exporter.js";

const measuredWidth = (text: string) => Array.from(text).length * 10;

function caption(id: string, text: string, startFrame: number, endFrame: number): CaptionCard {
  return {
    id,
    speechSegmentId: `segment_${id}`,
    sourceText: text,
    text,
    textMode: "derived",
    startFrame,
    endFrame,
    style: "stable",
    precision: "segment_exact"
  };
}

test("字幕布局只产生显式一到两行，不能装下时返回 CAPTION_LAYOUT_OVERFLOW", () => {
  const twoLines = layoutCaptionWithMeasure({
    text: "今天我们一起看，如何把视频剪得更精彩。",
    compositionWidth: 150,
    format: { fontSize: 10, fontWeight: 700, color: "#ffffff", bottomPercent: 7, horizontalInsetPercent: 0, textAlign: "center" }
  }, measuredWidth, "browser");
  assert.equal(twoLines.ready, true);
  if (twoLines.ready) {
    assert.equal(twoLines.lines.length, 2);
    assert.deepEqual(twoLines.lines, ["今天我们一起看，", "如何把视频剪得更精彩。"]);
  }

  const tooLong = layoutCaptionWithMeasure({
    text: "这是一段在当前宽度下无论怎样分成两行都无法完整显示的超长字幕内容。",
    compositionWidth: 80,
    format: { fontSize: 10, fontWeight: 700, color: "#ffffff", bottomPercent: 7, horizontalInsetPercent: 0, textAlign: "center" }
  }, measuredWidth, "browser");
  assert.deepEqual(tooLong, { ready: false, code: "CAPTION_LAYOUT_OVERFLOW", reason: "TWO_LINES_INSUFFICIENT", measurement: "browser" });

  const explicitThirdLine = layoutCaptionWithMeasure({
    text: "第一行\n第二行\n第三行",
    compositionWidth: 200,
    format: { fontSize: 10, fontWeight: 700, color: "#ffffff", bottomPercent: 7, horizontalInsetPercent: 0, textAlign: "center" }
  }, measuredWidth, "browser");
  assert.equal(explicitThirdLine.ready, false);
  if (!explicitThirdLine.ready) assert.equal(explicitThirdLine.code, "CAPTION_LAYOUT_OVERFLOW");
});

test("统一字幕轨按半开区间选择唯一 Card，质量门禁阻止空段、无效时间、重叠和溢出", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-caption-layout-quality-"));
  const application = createApplication(root);
  try {
    const created = application.createProject({ name: "字幕轨质量门禁" });
    const snapshot = structuredClone(created.snapshot);
    snapshot.timeline.durationInFrames = 96;
    snapshot.timeline.captions = [
      caption("first", "第一条字幕", 0, 30),
      caption("overlap", "第二条字幕", 29, 48),
      caption("empty", "   ", 48, 60),
      caption("invalid", "时间无效", 70, 70),
      caption("overflow", "这是一段故意非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的字幕，用于验证不能悄悄折成第三行。", 60, 90)
    ];
    assert.deepEqual(activeCaptionsAtFrame(snapshot.timeline.captions, 29).map((entry) => entry.id), ["first", "overlap"]);
    assert.deepEqual(activeCaptionsAtFrame(snapshot.timeline.captions, 48).map((entry) => entry.id), ["empty"]);

    const codes = new Set((await evaluateQualityWithBrowser(snapshot, created.revision.number)).issues.map((entry) => entry.code));
    assert.ok(codes.has("CAPTION_TIMELINE_OVERLAP"));
    assert.ok(codes.has("CAPTION_SEGMENT_EMPTY"));
    assert.ok(codes.has("CAPTION_SEGMENT_TIME_INVALID"));
    assert.ok(codes.has("CAPTION_LAYOUT_OVERFLOW"));
  } finally {
    application.close();
    await rm(root, { recursive: true, force: true });
  }
});

const reportedCaptionInput = {
  text: "先说流量，它更像这个月\n能用多少水，解决的是总量。",
  compositionWidth: 768,
  format: { fontSize: 40, fontWeight: 700, color: "#ffffff", backgroundColor: "#111111",
    bottomPercent: 12, horizontalInsetPercent: 10, textAlign: "center" as const }
};

test("真实字宽统一质量与预检：保守预算误报的两行通过，真正溢出仍阻断", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-caption-browser-quality-"));
  const application = createApplication(root);
  try {
    assert.equal(layoutCaptionConservatively(reportedCaptionInput).ready, false, "先复现原1.25em预算超限");
    const [valid, narrow, emphasized, thirdLine, mixed] = await measureCaptionLayouts([
      reportedCaptionInput,
      { ...reportedCaptionInput, compositionWidth: 400 },
      { ...reportedCaptionInput, emphasisScale: 2, emphasisFontWeight: 900 },
      { ...reportedCaptionInput, text: "一\n二\n三" },
      { ...reportedCaptionInput, text: "5G network / Wi-Fi 测速 👨‍👩‍👧‍👦 AVATAR" }
    ]);
    assert.deepEqual(valid, { ready: true, measurement: "browser", lines: reportedCaptionInput.text.split("\n") });
    for (const result of [narrow, emphasized, thirdLine]) assert.equal(result!.ready, false);
    assert.equal(mixed!.ready, true, "拉丁字偶距与emoji组合按完整字串测量");
    const created = application.createProject({ name: "字幕测量隔离回归" });
    const state = application.repository.commit(created.snapshot.project.id, created.revision.number, "创建隔离字幕夹具", (snapshot) => {
      delete snapshot.timeline.captionFormat; // 本夹具复核旧版逐卡格式的浏览器预算问题。
      snapshot.timeline.width = 768;
      snapshot.timeline.height = 1344;
      snapshot.timeline.durationInFrames = 24;
      snapshot.scenes = [{ id: "scene_fixture", type: "PresenterScene", title: "字幕隔离夹具", purpose: "测试字宽",
        startFrame: 0, endFrame: 24, assetIds: [], narrativeBeatIds: [], status: "ready", stylePackId: "default-clean" }];
      snapshot.speechSegments = [{ id: "segment_reported", semanticUnitIds: [], text: reportedCaptionInput.text, order: 0,
        pauseBefore: { durationMs: 0, reason: "sentence" }, status: "ready" }];
      snapshot.timeline.captions = [{ ...caption("reported", reportedCaptionInput.text, 0, 24), format: reportedCaptionInput.format }];
    });
    const original = application.readProject(state.snapshot.project.id);
    const report = await evaluateQualityWithBrowser(state.snapshot, state.revision.number);
    assert.equal(report.issues.some((entry) => entry.code.startsWith("CAPTION_LAYOUT_")), false);
    assert.ok(evaluateQuality(state.snapshot, state.revision.number).issues.some((entry) => entry.code === "CAPTION_LAYOUT_MEASUREMENT_REQUIRED"), "静态预算不得宣称已证实溢出");
    const preflight = await runRenderPreflight(application, state.snapshot.project.id, state.revision.number);
    assert.equal(preflight.checks.some((entry) => entry.code.includes("CAPTION_LAYOUT_")), false);
    assert.deepEqual(application.readProject(state.snapshot.project.id), original, "测量/预检不写视频Revision");
    assert.equal(application.repository.listJobs(state.snapshot.project.id).length, 0, "测量不创建Job");

    const previousBrowser = process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE;
    process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE = join(root, "不存在的浏览器.exe");
    try {
      await assert.rejects(evaluateQualityWithBrowser(state.snapshot, state.revision.number), { code: "CAPTION_LAYOUT_MEASUREMENT_UNAVAILABLE" }, "浏览器不可用须失败，不能退回估算通过");
    } finally {
      if (previousBrowser === undefined) delete process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE;
      else process.env.VIDEOFLOWCUT_BROWSER_EXECUTABLE = previousBrowser;
    }
  } finally { application.close(); await rm(root, { recursive: true, force: true }); }
});

/**
 * 这不是 DOM mock：通过现有 Render Worker 拉起 Remotion/Chromium，确认真实字体、目标宽度和
 * whiteSpace: pre 组合下，合格两行会产出文件，三行风险会以显式错误失败而非悄悄截断。
 */
test("Remotion 真实字体排版只渲染一到两行，溢出会失败而不是自动折三行", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-caption-layout-render-"));
  const application = createApplication(root);
  const renderer = new RevisionRenderer(undefined, 1);
  try {
    const created = application.createProject({ name: "字幕真实渲染" });
    const base = structuredClone(created.snapshot) as ProjectSnapshot;
    delete base.timeline.captionFormat; // 显式覆盖历史逐卡格式的兼容渲染。
    base.timeline.durationInFrames = 24;
    base.timeline.captions = [caption("valid", "今天我们一起看，如何把视频剪得更精彩。", 0, 24)];
    const validTarget = join(root, "valid-caption.mp4");
    await renderer.renderRange(base, 0, 1, validTarget);
    assert.ok((await stat(validTarget)).size > 0, "两行字幕必须经真实 Renderer 生成可读文件");

    // 有底板的正常短字幕在元数据选择阶段也必须成立，不能把暂未定宽的 Composition 当作溢出。
    const backed = structuredClone(base);
    backed.timeline.width = 768;
    backed.timeline.height = 1344;
    backed.timeline.captions[0]!.format = {
      fontSize: 32, fontWeight: 750, color: "#ffffff", backgroundColor: "#111111",
      bottomPercent: 7, horizontalInsetPercent: 8, textAlign: "center"
    };
    await renderer.renderRange(backed, 0, 2, join(root, "backed-caption.mp4"));

    const reported = structuredClone(backed);
    reported.timeline.captions = [{ ...caption("reported", reportedCaptionInput.text, 0, 24), format: reportedCaptionInput.format }];
    await renderer.renderRange(reported, 0, 2, join(root, "reported-caption.mp4"));

    const overlapping = structuredClone(base);
    overlapping.timeline.captions = [
      caption("first", "第一屏字幕", 0, 24),
      caption("second", "第二屏字幕", 0, 24)
    ];
    await assert.rejects(
      () => renderer.renderRange(overlapping, 0, 1, join(root, "overlap-caption.mp4")),
      /CAPTION_TIMELINE_OVERLAP/u,
      "统一字幕轨必须明确拒绝同帧双字幕，而非把两个 Sequence 叠在一起"
    );

    const overflowing = structuredClone(base);
    overflowing.timeline.captions = [caption("overflow", "这是一段故意重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复的长字幕。", 0, 24)];
    await assert.rejects(
      () => renderer.renderRange(overflowing, 0, 1, join(root, "overflow-caption.mp4")),
      /CAPTION_LAYOUT_OVERFLOW/u,
      "Renderer 必须显式拒绝三行风险，不能由浏览器自动折行或截断"
    );
  } finally {
    application.close();
    await rm(root, { recursive: true, force: true });
  }
});
