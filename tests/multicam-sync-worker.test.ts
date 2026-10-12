import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createApplication, type EditingApplication } from "@videocut/application";
import type { AssetKind, MediaMetadata, MulticamSyncPreview } from "@videocut/contracts";
import { DomainError } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";
import {
  assertMulticamAudioConsensus,
  buildReferenceAnchorFrames,
  findAudioNccMatch,
  pcmToAudioSignature,
  runMulticamSync,
  selectBestReliableAnchorCandidate,
  MULTICAM_PCM_SAMPLE_RATE
} from "../apps/job-worker/src/multicam-sync.js";

function pcmFromAmplitudeBuckets(amplitudes: number[]): Buffer {
  const samplesPerBucket = Math.round(MULTICAM_PCM_SAMPLE_RATE * 0.05);
  const output = Buffer.alloc(amplitudes.length * samplesPerBucket * 2);
  for (const [bucket, amplitude] of amplitudes.entries()) {
    for (let sample = 0; sample < samplesPerBucket; sample += 1) {
      const phase = (sample / samplesPerBucket) * Math.PI * 2 * 11;
      output.writeInt16LE(Math.round(Math.sin(phase) * amplitude), (bucket * samplesPerBucket + sample) * 2);
    }
  }
  return output;
}

function deterministicAmplitudes(length: number): number[] {
  let state = 0x53_9a_4d_21;
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return 1_500 + (state % 20_000);
  });
}

test("滑动 NCC 找到固定偏移，并把周期性声轨保留为低峰值差证据", () => {
  const referencePcm = pcmFromAmplitudeBuckets(deterministicAmplitudes(220));
  const targetPcm = pcmFromAmplitudeBuckets([
    ...Array<number>(40).fill(0),
    ...deterministicAmplitudes(220),
    ...Array<number>(20).fill(0)
  ]);
  const match = findAudioNccMatch({
    referenceSignature: pcmToAudioSignature(referencePcm),
    targetSignature: pcmToAudioSignature(targetPcm),
    independentPeakBuckets: 30
  });
  assert.ok(Math.abs(match.targetStartIndex - 40) <= 1, `应定位 40 个能量桶偏移，实际 ${match.targetStartIndex}`);
  assert.ok(match.correlation > 0.98);
  assert.ok(match.peakMargin > 0.08);

  const onePeriod = deterministicAmplitudes(50);
  const periodicReference = pcmToAudioSignature(pcmFromAmplitudeBuckets([...onePeriod, ...onePeriod, ...onePeriod]));
  const periodicTarget = pcmToAudioSignature(pcmFromAmplitudeBuckets([
    ...onePeriod, ...onePeriod, ...onePeriod, ...onePeriod, ...onePeriod, ...onePeriod
  ]));
  const ambiguous = findAudioNccMatch({
    referenceSignature: periodicReference,
    targetSignature: periodicTarget,
    independentPeakBuckets: 40
  });
  assert.ok(ambiguous.peakMargin < 0.08, "多个周期性相关峰不能被当成唯一同步结论");
});

test("锚点扫描会跳过前一低相关窗口，选择后一条仍满足唯一峰值的共同音轨", () => {
  const selected = selectBestReliableAnchorCandidate([
    {
      referenceFrame: 600,
      matches: [{
        targetAssetId: "camera-c",
        targetFrame: 1_670,
        match: { targetStartIndex: 0, correlation: 0.643, peakMargin: 0.31 }
      }]
    },
    {
      referenceFrame: 1_200,
      matches: [{
        targetAssetId: "camera-c",
        targetFrame: 2_270,
        match: { targetStartIndex: 0, correlation: 0.664, peakMargin: 0.22 }
      }]
    }
  ], 1);
  assert.equal(selected?.referenceFrame, 1_200, "前一窗口低于既有相关度门槛时，后一个可靠锚点应被选中");
  assert.equal(selected?.matches[0]?.match.correlation, 0.664);
});

test("大搜索半径不能把有限锚点扫描退化为只检查会话片尾", () => {
  const anchors = buildReferenceAnchorFrames({
    referenceRange: { startFrame: 24_000, endFrame: 36_000 },
    windowFrames: 240,
    fps: 24
  });
  assert.deepEqual(anchors, [24_000, 29_640, 35_280], "首、中、尾三个窗口应独立于目标机位的搜索半径");
});

test("多窗口共识要求严格主锚点，允许较低但唯一且同偏移的独立复核", () => {
  assert.doesNotThrow(() => assertMulticamAudioConsensus({
    assetName: "C 机",
    primary: { targetStartIndex: 0, correlation: 0.664, peakMargin: 0.31 },
    validation: { targetStartIndex: 0, correlation: 0.56, peakMargin: 0.27 },
    driftFrames: 1,
    driftLimitFrames: 3
  }), "主锚点可靠、独立窗口仍清晰且偏移一致时应形成多窗口共识");

  assert.throws(
    () => assertMulticamAudioConsensus({
      assetName: "B 机",
      primary: { targetStartIndex: 0, correlation: 0.408, peakMargin: 0.069 },
      validation: { targetStartIndex: 0, correlation: 0.7, peakMargin: 0.3 },
      driftFrames: 0,
      driftLimitFrames: 3
    }),
    (error: unknown) => error instanceof DomainError && error.code === "MULTICAM_SYNC_CORRELATION_LOW",
    "弱主锚点不能借尾部窗口绕过原始严格门槛"
  );
  assert.throws(
    () => assertMulticamAudioConsensus({
      assetName: "B 机",
      primary: { targetStartIndex: 0, correlation: 0.7, peakMargin: 0.069 },
      validation: { targetStartIndex: 0, correlation: 0.6, peakMargin: 0.3 },
      driftFrames: 0,
      driftLimitFrames: 3
    }),
    (error: unknown) => error instanceof DomainError && error.code === "MULTICAM_SYNC_PEAK_AMBIGUOUS",
    "即使相关度较高，相近峰值也不能当成唯一同步事实"
  );
  assert.throws(
    () => assertMulticamAudioConsensus({
      assetName: "B 机",
      primary: { targetStartIndex: 0, correlation: 0.7, peakMargin: 0.3 },
      validation: { targetStartIndex: 0, correlation: 0.56, peakMargin: 0.069 },
      driftFrames: 0,
      driftLimitFrames: 3
    }),
    (error: unknown) => error instanceof DomainError && error.code === "MULTICAM_SYNC_PEAK_AMBIGUOUS",
    "独立复核窗口也必须保留原峰值唯一性门槛"
  );
});

async function writeUniqueWav(path: string, durationSeconds: number): Promise<void> {
  const sampleRate = 48_000;
  const sampleCount = Math.round(sampleRate * durationSeconds);
  const data = Buffer.alloc(sampleCount * 2);
  let pseudo = 0x72_18_4b_3d;
  let lastBucket = -1;
  let amplitude = 0.4;
  for (let index = 0; index < sampleCount; index += 1) {
    const seconds = index / sampleRate;
    const bucket = Math.floor(seconds * 8);
    if (bucket !== lastBucket) {
      pseudo = (Math.imul(pseudo, 1_664_525) + 1_013_904_223) >>> 0;
      amplitude = 0.12 + ((pseudo % 8000) / 10_000);
      lastBucket = bucket;
    }
    const sample = amplitude * (
      0.72 * Math.sin(Math.PI * 2 * 223 * seconds)
      + 0.23 * Math.sin(Math.PI * 2 * 431 * seconds)
      + 0.05 * Math.sin(Math.PI * 2 * 719 * seconds)
    );
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 25_000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
}

async function createOffsetMediaFixture(root: string): Promise<{ reference: string; target: string }> {
  const audio = join(root, "shared.wav");
  const reference = join(root, "reference.mp4");
  const target = join(root, "target.mp4");
  await writeUniqueWav(audio, 55);
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=64x64:rate=24:duration=55",
    "-i", audio,
    "-map", "0:v",
    "-map", "1:a",
    "-c:v", "mpeg4", "-q:v", "5",
    "-c:a", "aac",
    "-shortest",
    reference
  ], 180_000);
  await runProcess("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=57",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=2",
    "-i", audio,
    "-filter_complex", "[1:a][2:a]concat=n=2:v=0:a=1[a]",
    "-map", "0:v",
    "-map", "[a]",
    "-c:v", "mpeg4", "-q:v", "5",
    "-c:a", "aac",
    "-shortest",
    target
  ], 180_000);
  return { reference, target };
}

async function addReadyVideo(input: {
  app: EditingApplication;
  projectId: string;
  name: string;
  sourcePath: string;
  sourceHash: string;
}): Promise<string> {
  const registered = input.app.registerImportedAsset({
    projectId: input.projectId,
    baseRevision: input.app.readProject(input.projectId).revision.number,
    name: input.name,
    kind: "video" as AssetKind,
    managedPath: `assets/source/${input.name}`,
    sourceHash: input.sourceHash,
    provenance: { source: "local_import", acquiredAt: new Date().toISOString() }
  });
  const asset = input.app.readProject(input.projectId).snapshot.assets.find((candidate) => candidate.id === registered.asset.id);
  assert.ok(asset, "导入后的测试素材必须可读取");
  const targetPath = join(input.app.readProject(input.projectId).snapshot.project.rootPath, asset.managedPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(input.sourcePath, targetPath);
  const metadata: MediaMetadata = await probeMedia(targetPath);
  input.app.applyMediaAnalysis({ projectId: input.projectId, assetId: asset.id, metadata });
  for (const job of input.app.listJobs(input.projectId)) {
    if (job.kind === "media_analysis" && job.status === "queued") input.app.updateJob(job.id, { status: "succeeded", result: { seeded: true } });
  }
  return asset.id;
}

test("多机位 Worker 从受管 PCM 中写入 candidate，并在 finally 清理 Job 缓存", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-multicam-worker-"));
  const app = createApplication(root);
  try {
    const created = app.createProject({ name: "多机位同步 Worker", profile: "vlog" });
    const projectId = created.snapshot.project.id;
    const fixture = await createOffsetMediaFixture(root);
    const referenceAssetId = await addReadyVideo({
      app,
      projectId,
      name: "camera-a.mp4",
      sourcePath: fixture.reference,
      sourceHash: "camera-a-content-hash"
    });
    const targetAssetId = await addReadyVideo({
      app,
      projectId,
      name: "camera-b.mp4",
      sourcePath: fixture.target,
      sourceHash: "camera-b-content-hash"
    });
    const submitted = app.submitMulticamSync({
      projectId,
      baseRevision: app.readProject(projectId).revision.number,
      title: "A/B 机共同现场声",
      assetIds: [referenceAssetId, targetAssetId],
      angleLabels: { [referenceAssetId]: "A 机", [targetAssetId]: "B 机" },
      referenceAssetId,
      masterAudioAssetId: referenceAssetId,
      maxSearchSeconds: 20,
      // 直接从完整原片读指定会话区间；不创建物理裁片。B 机比 A 机晚两秒开始共同现场声。
      sourceRanges: {
        [referenceAssetId]: { startFrame: 0, endFrame: 1_200 },
        [targetAssetId]: { startFrame: 48, endFrame: 1_248 }
      },
      idempotencyKey: "multicam-worker-real-audio"
    });
    const result = await runMulticamSync(app, submitted);
    assert.equal(result.duplicate, false);
    const plan = app.readMulticamPlan(projectId);
    assert.equal(plan.multicamGroups.length, 1);
    const group = plan.multicamGroups[0]!;
    assert.equal(group.status, "candidate", "音频相关只允许生成 candidate，不能绕过连续预览确认");
    const targetSync = group.angleSyncs.find((sync) => sync.assetId === targetAssetId)!;
    assert.equal(targetSync.status, "candidate");
    // B 机前置两秒静音：sessionFrame = sourceFrame - 48（项目为 24fps）。
    assert.ok(Math.abs(targetSync.sessionOffsetFrames + 48) <= 2, `预期约 -48 帧，实际 ${targetSync.sessionOffsetFrames}`);
    assert.equal(targetSync.evidence.referenceSourceHash, "camera-a-content-hash");
    assert.equal(targetSync.evidence.angleSourceHash, "camera-b-content-hash");
    assert.deepEqual(group.angleSyncs.find((sync) => sync.assetId === referenceAssetId)?.sourceRange, { startFrame: 0, endFrame: 1_200 });
    assert.deepEqual(targetSync.sourceRange, { startFrame: 48, endFrame: 1_248 });
    assert.match(targetSync.evidence.note, /连续预览确认/u);
    const preview = result.multicamSyncPreview as MulticamSyncPreview;
    assert.ok(preview && typeof preview.relativePath === "string", "自动同步必须同时生成受管并排预览");
    assert.equal(preview.fps, 24);
    assert.equal(preview.sessionEndFrame - preview.sessionStartFrame, 240, "预览必须固定为共同会话中的 10 秒窗口");
    const previewPath = join(app.readProject(projectId).snapshot.project.rootPath, preview.relativePath);
    const previewInfo = await stat(previewPath);
    assert.ok(previewInfo.isFile() && previewInfo.size > 0, "同步预览必须持久化为项目内 MP4");
    const previewMedia = await probeMedia(previewPath);
    assert.equal(previewMedia.videoCodec, "h264", "同步预览必须使用 Web/Render 已验证的 H.264 视频编码");
    assert.equal(previewMedia.audioCodec, "aac", "同步预览必须保留唯一主声音的 AAC 音轨");
    assert.equal(previewMedia.hasAudio, true, "同步预览必须可连续播放主声音");
    assert.equal(previewMedia.fps, preview.fps, "ffprobe 得到的真实 CFR 必须与写回对象一致");
    assert.equal(previewMedia.fps, 24, "同步预览必须固定到项目 Timeline FPS，而不是继承机位帧率");
    assert.equal(preview.durationMs, previewMedia.durationMs, "写回对象必须记录真实输出时长");
    assert.ok(Math.abs(preview.durationMs - 10_000) <= 120, "十秒共同窗口不能因编码或音轨而被截短");
    assert.equal(createHash("sha256").update(await readFile(previewPath)).digest("hex"), preview.contentHash, "预览哈希必须绑定实际文件");
    for (const sync of group.angleSyncs) {
      const window = preview.sourceWindows[sync.assetId]!;
      const range = sync.sourceRange!;
      assert.equal(window.startFrame, preview.sessionStartFrame - sync.sessionOffsetFrames);
      assert.equal(window.endFrame, preview.sessionEndFrame - sync.sessionOffsetFrames);
      assert.ok(window.startFrame >= range.startFrame && window.endFrame <= range.endFrame, "预览不得越出提交时的 sourceRange");
    }
    await assert.rejects(
      () => stat(join(app.readProject(projectId).snapshot.project.rootPath, "cache", "multicam", submitted.id)),
      /ENOENT/u,
      "完成或失败后均不能留下可被其它 Job 误读的 PCM 缓存"
    );
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
