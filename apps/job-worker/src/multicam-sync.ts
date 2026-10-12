import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { CompletedMulticamAngleSync, EditingApplication } from "@videocut/application";
import type { Asset, Id, JobRecord, MulticamSourceRange, MulticamSyncPreview, ProjectSnapshot } from "@videocut/contracts";
import { assetById, DomainError, millisecondsToFrames } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";

/**
 * 同步阶段只保留低采样率的单声道 PCM。这里比较的是短时能量轨迹而不是 UTF-8 转码后的
 * stdout，也不把文件名、拍摄日期或视频画面相似度误当成同步证据。
 */
export const MULTICAM_PCM_SAMPLE_RATE = 4_000;
export const MULTICAM_ENERGY_HOP_SECONDS = 0.05;
const ANALYSIS_WINDOW_SECONDS = 10;
const MIN_REFERENCE_DYNAMIC_RANGE = 0.004;
/** 主锚点的门槛不能因尾部复核较难而整体下调。 */
const MIN_CORRELATION = 0.65;
/** 已由主锚点唯一定位后，独立复核窗允许受话筒和现场声差异影响而稍低，但仍须清晰可辨。 */
const MIN_VALIDATION_CORRELATION = 0.55;
const MIN_PEAK_MARGIN = 0.08;
const INDEPENDENT_PEAK_SECONDS = 3;
const TAIL_SEARCH_SECONDS = 2;
const MIN_DRIFT_WINDOW_SEPARATION_SECONDS = 20;
/** 锚点扫描固定为三个位置，避免长素材把同一任务放大成全片穷举。 */
const MAX_ANCHOR_SCAN_CANDIDATES = 3;
/** 同步核对只需要能看清口型和动作，固定小画幅可避免多机位原片在 Worker 中放大为高成本渲染。 */
const SYNC_PREVIEW_TILE_WIDTH = 640;
const SYNC_PREVIEW_TILE_HEIGHT = 360;
const ANALYSIS_VERSION = "multicam-audio-ncc-v2-anchor-scan";

type MulticamSyncPayload = {
  requestedRevision: number;
  title: string;
  assetIds: Id[];
  angleLabels: Record<Id, string>;
  sourceHashes: Record<Id, string>;
  referenceAssetId: Id;
  masterAudioAssetId: Id;
  maxSearchSeconds: number;
  /** 旧排队 Job 可缺失；当前提交会由 Application 写入每个机位的完整范围。 */
  sourceRanges?: Record<Id, MulticamSourceRange>;
};

type AudioSegment = {
  signature: number[];
  startFrame: number;
  requestedDurationFrames: number;
};

export type AudioNccMatch = {
  /** targetSignature 中与 referenceSignature[0] 对齐的能量桶下标。 */
  targetStartIndex: number;
  correlation: number;
  /** 与相距足够远的次优峰的差值；相邻同一峰不会被误判为二义性。 */
  peakMargin: number;
};

/** 一个锚点对每个待同步机位的 NCC 结果；只有所有机位都可靠时才可作为 Group 的共同锚点。 */
export type AnchorWindowMatch = {
  targetAssetId: Id;
  targetFrame: number;
  match: AudioNccMatch;
};

export type AnchorScanCandidate = {
  referenceFrame: number;
  matches: readonly AnchorWindowMatch[];
};

const assetPath = (snapshot: ProjectSnapshot, asset: Asset) => (
  isAbsolute(asset.managedPath) ? asset.managedPath : join(snapshot.project.rootPath, asset.managedPath)
);

const secondsToFrames = (seconds: number, fps: number) => Math.round(seconds * fps);
const framesToSeconds = (frames: number, fps: number) => frames / fps;
const clamp = (value: number, lower: number, upper: number) => Math.max(lower, Math.min(upper, value));
const safeFilePart = (value: string) => value.replace(/[^a-zA-Z0-9._-]/gu, "_");

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

function isMulticamSourceRange(value: unknown): value is MulticamSourceRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).every((key) => key === "startFrame" || key === "endFrame")
    && Number.isInteger(candidate.startFrame) && Number.isInteger(candidate.endFrame)
    && (candidate.startFrame as number) >= 0 && (candidate.endFrame as number) > (candidate.startFrame as number);
}

function isMulticamSourceRangeRecord(value: unknown): value is Record<Id, MulticamSourceRange> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isMulticamSourceRange);
}

/** Worker 仍独立验证提交合同，避免直接调用或旧 Job 绕过 Application 的 submit 校验。 */
function readPayload(job: JobRecord): MulticamSyncPayload {
  const requestedRevision = Number(job.payload.requestedRevision);
  const title = typeof job.payload.title === "string" ? job.payload.title.trim() : "";
  const assetIds = Array.isArray(job.payload.assetIds)
    ? job.payload.assetIds.filter((assetId): assetId is Id => typeof assetId === "string" && Boolean(assetId.trim()))
    : [];
  const angleLabels = job.payload.angleLabels;
  const sourceHashes = job.payload.sourceHashes;
  const referenceAssetId = typeof job.payload.referenceAssetId === "string" ? job.payload.referenceAssetId : "";
  const masterAudioAssetId = typeof job.payload.masterAudioAssetId === "string" ? job.payload.masterAudioAssetId : "";
  const maxSearchSeconds = Number(job.payload.maxSearchSeconds);
  const sourceRanges = job.payload.sourceRanges;

  if (job.kind !== "multicam_sync" || !Number.isInteger(requestedRevision) || requestedRevision < 1 || !title
    || assetIds.length < 2 || new Set(assetIds).size !== assetIds.length
    || !isStringRecord(angleLabels) || !isStringRecord(sourceHashes)
    || !referenceAssetId || !masterAudioAssetId || !assetIds.includes(referenceAssetId) || !assetIds.includes(masterAudioAssetId)
    || !Number.isInteger(maxSearchSeconds) || maxSearchSeconds < 20 || maxSearchSeconds > 1_800
    || assetIds.some((assetId) => !angleLabels[assetId]?.trim() || !sourceHashes[assetId]?.trim())
    || new Set(assetIds.map((assetId) => angleLabels[assetId]?.trim())).size !== assetIds.length
    || (sourceRanges !== undefined && (!isMulticamSourceRangeRecord(sourceRanges)
      || Object.keys(sourceRanges).length !== assetIds.length || Object.keys(sourceRanges).some((assetId) => !assetIds.includes(assetId as Id))))) {
    throw new DomainError("多机位同步任务缺少有效的机位、哈希、参考机位或搜索范围合同", "MULTICAM_SYNC_PAYLOAD_INVALID");
  }
  return {
    requestedRevision,
    title,
    assetIds,
    angleLabels: Object.fromEntries(assetIds.map((assetId) => [assetId, angleLabels[assetId]!.trim()])) as Record<Id, string>,
    sourceHashes: Object.fromEntries(assetIds.map((assetId) => [assetId, sourceHashes[assetId]!.trim()])) as Record<Id, string>,
    referenceAssetId,
    masterAudioAssetId,
    maxSearchSeconds,
    sourceRanges: sourceRanges === undefined
      ? undefined
      : Object.fromEntries(assetIds.map((assetId) => [assetId, {
        startFrame: sourceRanges[assetId]!.startFrame,
        endFrame: sourceRanges[assetId]!.endFrame
      }])) as Record<Id, MulticamSourceRange>
  };
}

/**
 * 把 s16le PCM 变成 50ms 的对数能量差分。音量绝对值、话筒增益和固定 DC 偏移都不应
 * 决定同步；差分会保留共同声音事件的变化形状，并让纯音/静音无法伪造高置信同步。
 */
export function pcmToAudioSignature(
  pcm: Uint8Array,
  sampleRate = MULTICAM_PCM_SAMPLE_RATE,
  hopSeconds = MULTICAM_ENERGY_HOP_SECONDS
): number[] {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isFinite(hopSeconds) || hopSeconds <= 0) {
    throw new DomainError("PCM 同步参数无效", "MULTICAM_PCM_PARAMETERS_INVALID");
  }
  const samplesPerBucket = Math.max(1, Math.round(sampleRate * hopSeconds));
  const sampleCount = Math.floor(pcm.byteLength / 2);
  const energy: number[] = [];
  for (let sampleStart = 0; sampleStart + samplesPerBucket <= sampleCount; sampleStart += samplesPerBucket) {
    let squaredSum = 0;
    for (let offset = 0; offset < samplesPerBucket; offset += 1) {
      const byteIndex = (sampleStart + offset) * 2;
      let sample = pcm[byteIndex]! | (pcm[byteIndex + 1]! << 8);
      if (sample >= 0x8000) sample -= 0x10000;
      squaredSum += sample * sample;
    }
    const normalizedRms = Math.sqrt(squaredSum / samplesPerBucket) / 0x8000;
    energy.push(Math.log1p(normalizedRms * 12));
  }
  if (energy.length < 2) return [];
  return energy.slice(1).map((value, index) => value - energy[index]!);
}

function arrayVariance(values: readonly number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  let sumSquares = 0;
  for (const value of values) {
    sum += value;
    sumSquares += value * value;
  }
  return Math.max(0, sumSquares - (sum * sum) / values.length);
}

/**
 * 在一个固定窗口内做滑动 NCC。峰值边界会排除同一相关主峰附近的桶，随后才拿次优峰
 * 判断二义性，避免把一个正常宽峰错误当成两条不同的同步解释。
 */
export function findAudioNccMatch(input: {
  referenceSignature: readonly number[];
  targetSignature: readonly number[];
  independentPeakBuckets?: number;
}): AudioNccMatch {
  const { referenceSignature, targetSignature } = input;
  if (referenceSignature.length < 20 || targetSignature.length < referenceSignature.length) {
    throw new DomainError("共同音轨窗口过短，无法计算可靠同步", "MULTICAM_SYNC_SIGNAL_INSUFFICIENT");
  }
  let referenceSum = 0;
  let referenceSumSquares = 0;
  for (const value of referenceSignature) {
    referenceSum += value;
    referenceSumSquares += value * value;
  }
  const referenceVariance = referenceSumSquares - (referenceSum * referenceSum) / referenceSignature.length;
  if (referenceVariance < MIN_REFERENCE_DYNAMIC_RANGE) {
    throw new DomainError("参考机位音轨缺少足够的动态声音，不能用于自动多机位同步", "MULTICAM_SYNC_SIGNAL_INSUFFICIENT");
  }

  const targetSums = new Float64Array(targetSignature.length + 1);
  const targetSquares = new Float64Array(targetSignature.length + 1);
  for (let index = 0; index < targetSignature.length; index += 1) {
    const value = targetSignature[index]!;
    targetSums[index + 1] = targetSums[index]! + value;
    targetSquares[index + 1] = targetSquares[index]! + value * value;
  }

  const scores = new Float64Array(targetSignature.length - referenceSignature.length + 1);
  scores.fill(Number.NEGATIVE_INFINITY);
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let targetStart = 0; targetStart < scores.length; targetStart += 1) {
    const targetSum = targetSums[targetStart + referenceSignature.length]! - targetSums[targetStart]!;
    const targetSumSquares = targetSquares[targetStart + referenceSignature.length]! - targetSquares[targetStart]!;
    const targetVariance = targetSumSquares - (targetSum * targetSum) / referenceSignature.length;
    if (targetVariance < MIN_REFERENCE_DYNAMIC_RANGE) continue;
    let crossSum = 0;
    for (let offset = 0; offset < referenceSignature.length; offset += 1) {
      crossSum += referenceSignature[offset]! * targetSignature[targetStart + offset]!;
    }
    const numerator = crossSum - (referenceSum * targetSum) / referenceSignature.length;
    const denominator = Math.sqrt(referenceVariance * targetVariance);
    const score = denominator > 0 ? numerator / denominator : Number.NEGATIVE_INFINITY;
    scores[targetStart] = score;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = targetStart;
    }
  }
  if (bestIndex < 0 || !Number.isFinite(bestScore)) {
    throw new DomainError("共同音轨中没有可比较的动态窗口，不能生成同步候选", "MULTICAM_SYNC_SIGNAL_INSUFFICIENT");
  }
  const independentPeakBuckets = Math.max(1, input.independentPeakBuckets ?? 1);
  let nextIndependentScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < scores.length; index += 1) {
    if (Math.abs(index - bestIndex) < independentPeakBuckets) continue;
    nextIndependentScore = Math.max(nextIndependentScore, scores[index]!);
  }
  return {
    targetStartIndex: bestIndex,
    correlation: bestScore,
    // 搜索范围本身小到没有第二个独立位置时，不能凭空制造一个“竞争峰”。
    peakMargin: Number.isFinite(nextIndependentScore) ? bestScore - nextIndependentScore : 1
  };
}

function assertReliableMatch(match: AudioNccMatch, assetName: string, phase: "锚点" | "末尾"): void {
  if (match.correlation < MIN_CORRELATION) {
    throw new DomainError(
      `机位“${assetName}”在${phase}窗口的共同音轨相关性仅为 ${match.correlation.toFixed(3)}，低于 ${MIN_CORRELATION}；不能创建同步候选。`,
      "MULTICAM_SYNC_CORRELATION_LOW"
    );
  }
  if (match.peakMargin < MIN_PEAK_MARGIN) {
    throw new DomainError(
      `机位“${assetName}”在${phase}窗口存在相近的多个音频相关峰（峰值差 ${match.peakMargin.toFixed(3)}），无法唯一确定同步偏移。`,
      "MULTICAM_SYNC_PEAK_AMBIGUOUS"
    );
  }
}

function isReliableMatch(match: AudioNccMatch): boolean {
  return match.correlation >= MIN_CORRELATION && match.peakMargin >= MIN_PEAK_MARGIN;
}

function assertReliableValidationMatch(match: AudioNccMatch, assetName: string): void {
  if (match.correlation < MIN_VALIDATION_CORRELATION) {
    throw new DomainError(
      `机位“${assetName}”在独立复核窗口的共同音轨相关性仅为 ${match.correlation.toFixed(3)}，低于 ${MIN_VALIDATION_CORRELATION}；不能以单个主锚点创建同步候选。`,
      "MULTICAM_SYNC_VALIDATION_CORRELATION_LOW"
    );
  }
  if (match.peakMargin < MIN_PEAK_MARGIN) {
    throw new DomainError(
      `机位“${assetName}”在独立复核窗口存在相近的多个音频相关峰（峰值差 ${match.peakMargin.toFixed(3)}），无法确认主锚点偏移。`,
      "MULTICAM_SYNC_PEAK_AMBIGUOUS"
    );
  }
}

/**
 * 至少一个主锚点必须满足原严格门槛；远端独立窗口只承担“同一偏移再次成立”的复核，
 * 因而可使用单独的较低下限。两者都必须峰值唯一，并落在既有漂移容差内。
 */
export function assertMulticamAudioConsensus(input: {
  assetName: string;
  primary: AudioNccMatch;
  validation: AudioNccMatch;
  driftFrames: number;
  driftLimitFrames: number;
}): void {
  assertReliableMatch(input.primary, input.assetName, "锚点");
  assertReliableValidationMatch(input.validation, input.assetName);
  if (input.driftFrames > input.driftLimitFrames) {
    throw new DomainError(
      `机位“${input.assetName}”在锚点和独立复核窗口的偏移相差 ${input.driftFrames} 帧，超过 ${input.driftLimitFrames} 帧；首版不自动变速补偿，请拆短段或人工重同步。`,
      "MULTICAM_SYNC_DRIFT_EXCEEDED"
    );
  }
}

/**
 * 自动同步不把 maxSearchSeconds 误作参考锚点时间：它只限制每次 NCC 的目标搜索半径。
 * 这里在源素材坐标上挑最多三个均匀分布的位置（首、中、可安全留出漂移窗口的末尾），
 * 不读取文件名、creation_time 或画面信息。这样较大的搜索半径不会反而让锚点退化为只检查片尾。
 */
export function buildReferenceAnchorFrames(input: {
  referenceRange: MulticamSourceRange;
  windowFrames: number;
  fps: number;
}): number[] {
  const driftSeparationFrames = secondsToFrames(MIN_DRIFT_WINDOW_SEPARATION_SECONDS, input.fps);
  const latestSafeAnchor = Math.max(
    input.referenceRange.startFrame,
    input.referenceRange.endFrame - input.windowFrames - driftSeparationFrames
  );
  const middle = input.referenceRange.startFrame + Math.round((latestSafeAnchor - input.referenceRange.startFrame) / 2);
  return [...new Set([input.referenceRange.startFrame, middle, latestSafeAnchor])]
    .sort((left, right) => left - right)
    .slice(0, MAX_ANCHOR_SCAN_CANDIDATES);
}

/**
 * 共同锚点必须让所有目标机位同时通过现有相关度和峰值唯一性门槛。优先选择最弱机位相关性也更强的
 * 候选，避免“平均分很高但某个角度勉强过线”的 Group；随后才比较总相关性、峰值差和位置以保持稳定。
 */
export function selectBestReliableAnchorCandidate<T extends AnchorScanCandidate>(
  candidates: readonly T[],
  expectedTargetCount: number
): T | undefined {
  const reliable = candidates.filter((candidate) => (
    candidate.matches.length === expectedTargetCount && candidate.matches.every((entry) => isReliableMatch(entry.match))
  ));
  return reliable.sort((left, right) => {
    const leftCorrelations = left.matches.map((entry) => entry.match.correlation);
    const rightCorrelations = right.matches.map((entry) => entry.match.correlation);
    const weakestCorrelation = Math.min(...rightCorrelations) - Math.min(...leftCorrelations);
    if (weakestCorrelation !== 0) return weakestCorrelation;
    const totalCorrelation = rightCorrelations.reduce((sum, value) => sum + value, 0) - leftCorrelations.reduce((sum, value) => sum + value, 0);
    if (totalCorrelation !== 0) return totalCorrelation;
    const leftMargins = left.matches.map((entry) => entry.match.peakMargin);
    const rightMargins = right.matches.map((entry) => entry.match.peakMargin);
    const weakestMargin = Math.min(...rightMargins) - Math.min(...leftMargins);
    if (weakestMargin !== 0) return weakestMargin;
    return left.referenceFrame - right.referenceFrame;
  })[0];
}

/**
 * 每个机位的源范围通过固定偏移映射到同一 session 后必须仍有交集；
 * 这避免三台机位分别在不同会话片段“各自同步成功”却没有可切换的共同时间轴。
 */
function resolveCommonSessionRange(input: {
  referenceRange: MulticamSourceRange;
  sourceRanges: Record<Id, MulticamSourceRange>;
  referenceFrame: number;
  matches: readonly AnchorWindowMatch[];
}): MulticamSourceRange | undefined {
  let startFrame = input.referenceRange.startFrame;
  let endFrame = input.referenceRange.endFrame;
  for (const match of input.matches) {
    const targetRange = input.sourceRanges[match.targetAssetId];
    if (!targetRange) return undefined;
    const sessionOffsetFrames = input.referenceFrame - match.targetFrame;
    startFrame = Math.max(startFrame, targetRange.startFrame + sessionOffsetFrames);
    endFrame = Math.min(endFrame, targetRange.endFrame + sessionOffsetFrames);
  }
  return Number.isInteger(startFrame) && Number.isInteger(endFrame) && startFrame >= 0 && endFrame > startFrame
    ? { startFrame, endFrame }
    : undefined;
}

function canUseCommonRangeForDualWindow(input: {
  commonRange: MulticamSourceRange | undefined;
  anchorFrame: number;
  windowFrames: number;
  driftSeparationFrames: number;
}): boolean {
  const { commonRange } = input;
  if (!commonRange) return false;
  const tailFrame = commonRange.endFrame - input.windowFrames;
  return input.anchorFrame >= commonRange.startFrame && input.anchorFrame + input.windowFrames <= commonRange.endFrame
    && tailFrame >= commonRange.startFrame && tailFrame - input.anchorFrame >= input.driftSeparationFrames;
}

async function extractAudioSegment(input: {
  path: string;
  outputPath: string;
  startFrame: number;
  durationFrames: number;
  fps: number;
}): Promise<AudioSegment> {
  const durationSeconds = framesToSeconds(input.durationFrames, input.fps);
  try {
    await runProcess("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v", "error",
      // PCM 文件由本 Job 的 cache 目录持有；不能复用 transcription 的固定文件名，避免并发覆盖。
      "-ss", framesToSeconds(input.startFrame, input.fps).toFixed(6),
      "-i", input.path,
      "-t", durationSeconds.toFixed(6),
      "-map", "0:a:0",
      "-vn",
      "-ac", "1",
      "-ar", String(MULTICAM_PCM_SAMPLE_RATE),
      "-f", "s16le",
      "-y",
      input.outputPath
    ], Math.min(15 * 60_000, Math.max(120_000, Math.ceil(durationSeconds * 2_000))));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DomainError(`FFmpeg 无法提取多机位共同音轨：${detail}`, "MULTICAM_SYNC_FFMPEG_FAILED");
  }
  // runProcess 的 stdout 是文本；PCM 必须从文件读回，不能经 UTF-8 字符串中转。
  const pcm = await readFile(input.outputPath);
  const signature = pcmToAudioSignature(pcm);
  if (signature.length < 20) {
    throw new DomainError("多机位音轨提取后没有足够 PCM 数据，不能完成同步", "MULTICAM_SYNC_SIGNAL_INSUFFICIENT");
  }
  return { signature, startFrame: input.startFrame, requestedDurationFrames: input.durationFrames };
}

function assertInputAssets(snapshot: ProjectSnapshot, payload: MulticamSyncPayload): Map<Id, Asset> {
  const assets = new Map<Id, Asset>();
  for (const assetId of payload.assetIds) {
    const asset = assetById(snapshot, assetId);
    if (asset.status !== "ready" || asset.kind !== "video" || !asset.metadata?.hasAudio
      || !asset.metadata.videoCodec || asset.metadata.durationMs <= 0 || !asset.sourceHash) {
      throw new DomainError("自动多机位同步只能处理已完成媒体分析、含真实音轨的本地视频机位", "MULTICAM_SYNC_ASSET_NOT_READY");
    }
    if (asset.sourceHash !== payload.sourceHashes[assetId]) {
      throw new DomainError(`机位“${asset.name}”的源哈希已变化，不能把旧同步任务写入当前项目。`, "MULTICAM_SYNC_SOURCE_CHANGED");
    }
    assets.set(assetId, asset);
  }
  if (!assets.has(payload.referenceAssetId) || !assets.has(payload.masterAudioAssetId)) {
    throw new DomainError("多机位参考机位和主声音必须属于本次已提交的机位集合", "MULTICAM_SYNC_ASSET_MEMBERSHIP_INVALID");
  }
  return assets;
}

/**
 * 自动同步可直接从完整原片读取指定区间，不产生临时视频裁片。缺失字段只兼容旧排队 Job；
 * 新 Job 在 Application 层已要求完整覆盖每个机位，这里仍重复校验防止直接调用绕过。
 */
function normalizeSourceRanges(
  snapshot: ProjectSnapshot,
  assets: Map<Id, Asset>,
  payload: MulticamSyncPayload
): Record<Id, MulticamSourceRange> {
  const explicit = payload.sourceRanges !== undefined;
  const ranges = payload.sourceRanges;
  if (explicit && (!ranges || Object.keys(ranges).length !== payload.assetIds.length
    || Object.keys(ranges).some((assetId) => !payload.assetIds.includes(assetId as Id)))) {
    throw new DomainError("多机位同步源范围没有完整覆盖提交机位", "MULTICAM_SOURCE_RANGES_INVALID");
  }
  const normalized: Record<Id, MulticamSourceRange> = {};
  for (const assetId of payload.assetIds) {
    const asset = assets.get(assetId)!;
    const duration = millisecondsToFrames(asset.metadata!.durationMs, snapshot.timeline.fps);
    const range = ranges?.[assetId] ?? (explicit ? undefined : { startFrame: 0, endFrame: duration });
    if (!range || !Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame)
      || range.startFrame < 0 || range.endFrame <= range.startFrame || range.endFrame > duration) {
      throw new DomainError(`机位“${asset.name}”的同步源范围不在真实素材边界内`, "MULTICAM_SOURCE_RANGE_INVALID");
    }
    normalized[assetId] = { startFrame: range.startFrame, endFrame: range.endFrame };
  }
  return normalized;
}

async function assertSourceFilesExist(snapshot: ProjectSnapshot, assets: Iterable<Asset>): Promise<void> {
  for (const asset of assets) {
    try {
      const info = await stat(assetPath(snapshot, asset));
      if (!info.isFile()) throw new Error("不是文件");
    } catch {
      throw new DomainError(`机位“${asset.name}”的受管源文件不存在或不可读，不能同步。`, "MULTICAM_SYNC_SOURCE_MISSING");
    }
  }
}

/**
 * 将同一 session 的各机位源窗口并排编码为受管 MP4。预览只保留明确指定的主声音，
 * 因而人工核对时不会被多条相同现场声叠加后的回声误导。
 */
async function createMulticamSyncPreview(input: {
  snapshot: ProjectSnapshot;
  jobId: Id;
  assetIds: readonly Id[];
  assets: Map<Id, Asset>;
  angleSyncs: readonly CompletedMulticamAngleSync[];
  masterAudioAssetId: Id;
  sourceRanges: Record<Id, MulticamSourceRange>;
  sessionStartFrame: number;
  sessionEndFrame: number;
  fps: number;
}): Promise<MulticamSyncPreview> {
  const durationFrames = input.sessionEndFrame - input.sessionStartFrame;
  if (!Number.isInteger(input.sessionStartFrame) || !Number.isInteger(input.sessionEndFrame) || durationFrames <= 0) {
    throw new DomainError("多机位同步预览没有有效的共同会话窗口", "MULTICAM_SYNC_PREVIEW_RANGE_INVALID");
  }
  if (!Number.isFinite(input.fps) || input.fps <= 0 || input.fps > 120) {
    throw new DomainError("多机位同步预览缺少有效的项目 FPS", "MULTICAM_SYNC_PREVIEW_FPS_INVALID");
  }
  const syncByAssetId = new Map(input.angleSyncs.map((sync) => [sync.assetId, sync]));
  if (syncByAssetId.size !== input.assetIds.length || input.assetIds.some((assetId) => !syncByAssetId.has(assetId))) {
    throw new DomainError("多机位同步预览缺少机位偏移，不能拼接不受证据约束的画面", "MULTICAM_SYNC_PREVIEW_SYNC_MISSING");
  }
  const sourceWindows: Record<Id, MulticamSourceRange> = {};
  for (const assetId of input.assetIds) {
    const sync = syncByAssetId.get(assetId)!;
    const sourceRange = input.sourceRanges[assetId];
    if (!sourceRange) throw new DomainError("多机位同步预览缺少受管源范围", "MULTICAM_SYNC_PREVIEW_RANGE_INVALID");
    const startFrame = input.sessionStartFrame - sync.sessionOffsetFrames;
    const endFrame = input.sessionEndFrame - sync.sessionOffsetFrames;
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame)
      || startFrame < sourceRange.startFrame || endFrame > sourceRange.endFrame) {
      throw new DomainError("多机位同步预览窗口超出已经验证的原始素材范围", "MULTICAM_SYNC_PREVIEW_RANGE_INVALID");
    }
    sourceWindows[assetId] = { startFrame, endFrame };
  }

  const masterInputIndex = input.assetIds.indexOf(input.masterAudioAssetId);
  if (masterInputIndex < 0) throw new DomainError("多机位同步预览找不到已指定的主声音机位", "MULTICAM_SYNC_PREVIEW_MASTER_AUDIO_INVALID");
  const masterAudioAsset = input.assets.get(input.masterAudioAssetId);
  // 自动同步依赖共同音轨；没有主声音时不能静默产出一个看似已完成的同步预览。
  if (!masterAudioAsset?.metadata?.hasAudio) {
    throw new DomainError("多机位同步预览的主声音机位没有可播放音轨", "MULTICAM_SYNC_PREVIEW_MASTER_AUDIO_INVALID");
  }
  const previewDirectory = join(input.snapshot.project.rootPath, "previews", "multicam-sync");
  const relativePath = join("previews", "multicam-sync", `${safeFilePart(input.jobId)}.mp4`);
  const outputPath = join(input.snapshot.project.rootPath, relativePath);
  const temporaryPath = join(previewDirectory, `${safeFilePart(input.jobId)}.partial.mp4`);
  const durationSeconds = framesToSeconds(durationFrames, input.fps).toFixed(6);
  const columns = Math.ceil(Math.sqrt(input.assetIds.length));
  const filterParts: string[] = [];
  const tileLabels: string[] = [];
  const layout: string[] = [];
  const arguments_: string[] = ["-hide_banner", "-nostdin", "-v", "error"];
  for (const [index, assetId] of input.assetIds.entries()) {
    const asset = input.assets.get(assetId);
    const sourceWindow = sourceWindows[assetId];
    if (!asset || !sourceWindow) throw new DomainError("多机位同步预览找不到受管机位素材", "MULTICAM_SYNC_PREVIEW_ASSET_MISSING");
    arguments_.push(
      "-ss", framesToSeconds(sourceWindow.startFrame, input.fps).toFixed(6),
      "-t", durationSeconds,
      "-i", assetPath(input.snapshot, asset)
    );
    const label = `sync_tile_${index}`;
    filterParts.push(
      `[${index}:v:0]scale=${SYNC_PREVIEW_TILE_WIDTH}:${SYNC_PREVIEW_TILE_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${SYNC_PREVIEW_TILE_WIDTH}:${SYNC_PREVIEW_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black[${label}]`
    );
    tileLabels.push(`[${label}]`);
    layout.push(`${(index % columns) * SYNC_PREVIEW_TILE_WIDTH}_${Math.floor(index / columns) * SYNC_PREVIEW_TILE_HEIGHT}`);
  }
  // xstack 会继承输入的帧率/时间基；必须在合成后显式重采样为项目 FPS，避免不同机位的
  // VFR 或高帧率元数据让并排预览与写回的 Session Frame 坐标发生漂移。
  filterParts.push(`${tileLabels.join("")}xstack=inputs=${tileLabels.length}:layout=${layout.join("|")}:fill=black[sync_stack]`);
  filterParts.push(`[sync_stack]fps=fps=${input.fps}:round=near[sync_preview]`);
  await mkdir(previewDirectory, { recursive: true });
  await rm(temporaryPath, { force: true }).catch(() => undefined);
  try {
    await runProcess("ffmpeg", [
      ...arguments_,
      "-filter_complex", filterParts.join(";"),
      "-map", "[sync_preview]",
      "-map", `${masterInputIndex}:a:0`,
      // H.264/AAC 是当前 Web Player 与 Render Worker 已验证的交集；不要把 MPEG-4 Part 2
      // 或未约束的可变帧率 MP4 交给浏览器连续核对。
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-r", String(input.fps),
      "-vsync", "cfr",
      "-movflags", "+faststart",
      "-shortest",
      "-y",
      temporaryPath
    ], Math.min(15 * 60_000, Math.max(120_000, Math.ceil(durationFrames / input.fps * 4_000))));
    const media = await probeMedia(temporaryPath);
    const expectedDurationMs = Math.round(durationFrames / input.fps * 1_000);
    const durationToleranceMs = Math.max(120, Math.ceil(2_000 / input.fps));
    const actualFps = media.fps;
    if (media.videoCodec?.toLocaleLowerCase() !== "h264" || media.audioCodec?.toLocaleLowerCase() !== "aac" || !media.hasAudio
      || !Number.isFinite(media.durationMs) || media.durationMs <= 0
      || !Number.isFinite(actualFps) || Math.abs(actualFps! - input.fps) > 0.001
      || Math.abs(media.durationMs - expectedDurationMs) > durationToleranceMs) {
      throw new DomainError("多机位同步预览不是与项目 FPS 一致的 H.264/AAC 连续声画 MP4", "MULTICAM_SYNC_PREVIEW_INVALID");
    }
    const output = await stat(temporaryPath);
    if (!output.isFile() || output.size <= 0) throw new DomainError("多机位同步预览文件为空", "MULTICAM_SYNC_PREVIEW_INVALID");
    await rename(temporaryPath, outputPath);
    const contentHash = createHash("sha256").update(await readFile(outputPath)).digest("hex");
    return {
      relativePath,
      contentHash,
      durationMs: Math.round(media.durationMs),
      // 只有在 ffprobe 已确认与项目 FPS 一致后，才将真实输出帧率写回同步预览对象。
      fps: actualFps!,
      sessionStartFrame: input.sessionStartFrame,
      sessionEndFrame: input.sessionEndFrame,
      sourceWindows
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new DomainError(`FFmpeg 无法生成多机位同步连续预览：${detail}`, "MULTICAM_SYNC_PREVIEW_FAILED");
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function frameFromSignatureIndex(startFrame: number, index: number, fps: number): number {
  return startFrame + secondsToFrames(index * MULTICAM_ENERGY_HOP_SECONDS, fps);
}

async function matchTailWindow(input: {
  cacheDirectory: string;
  sequence: number;
  reference: Asset;
  target: Asset;
  snapshot: ProjectSnapshot;
  fps: number;
  referenceFrame: number;
  expectedOffsetFrames: number;
  windowFrames: number;
  referenceRange: MulticamSourceRange;
  targetRange: MulticamSourceRange;
}): Promise<{ offsetFrames: number; match: AudioNccMatch; targetFrame: number }> {
  const expectedTargetFrame = input.referenceFrame - input.expectedOffsetFrames;
  const radiusFrames = secondsToFrames(TAIL_SEARCH_SECONDS, input.fps);
  const targetStart = Math.max(input.targetRange.startFrame, expectedTargetFrame - radiusFrames);
  const targetLastStart = Math.min(input.targetRange.endFrame - input.windowFrames, expectedTargetFrame + radiusFrames);
  if (input.referenceFrame < input.referenceRange.startFrame || input.referenceFrame + input.windowFrames > input.referenceRange.endFrame
    || targetLastStart < targetStart) {
    throw new DomainError("多机位指定源范围内没有完整的末尾漂移窗口；请扩大同一会话范围、拆短段或改用人工同步点。", "MULTICAM_SYNC_DRIFT_WINDOW_UNAVAILABLE");
  }
  const referencePcm = await extractAudioSegment({
    path: assetPath(input.snapshot, input.reference),
    outputPath: join(input.cacheDirectory, `tail-${input.sequence}-reference.pcm`),
    startFrame: input.referenceFrame,
    durationFrames: input.windowFrames,
    fps: input.fps
  });
  const targetPcm = await extractAudioSegment({
    path: assetPath(input.snapshot, input.target),
    outputPath: join(input.cacheDirectory, `tail-${input.sequence}-target.pcm`),
    startFrame: targetStart,
    durationFrames: targetLastStart - targetStart + input.windowFrames,
    fps: input.fps
  });
  const match = findAudioNccMatch({
    referenceSignature: referencePcm.signature,
    targetSignature: targetPcm.signature,
    independentPeakBuckets: Math.max(1, Math.round(0.5 / MULTICAM_ENERGY_HOP_SECONDS))
  });
  const targetFrame = frameFromSignatureIndex(targetPcm.startFrame, match.targetStartIndex, input.fps);
  return { offsetFrames: input.referenceFrame - targetFrame, match, targetFrame };
}

/**
 * 自动同步只写入 candidate。它先以一个可搜索的锚点找固定偏移，再以共同覆盖范围的末尾
 * 独立窗口核对漂移；任何一个证据不足都抛出 DomainError，因此 Application 不会创建 Group。
 */
export async function runMulticamSync(application: EditingApplication, job: JobRecord): Promise<Record<string, unknown>> {
  const payload = readPayload(job);
  const existing = application.readMulticamPlan(job.projectId).multicamGroups.find((group) => group.syncJobId === job.id);
  if (existing) {
    return {
      requestedRevision: payload.requestedRevision,
      revision: application.readProject(job.projectId).revision.number,
      multicamGroupId: existing.id,
      duplicate: true
    };
  }

  const state = application.readProject(job.projectId);
  const snapshot = state.snapshot;
  const fps = snapshot.timeline.fps;
  if (!Number.isFinite(fps) || fps <= 0) throw new DomainError("项目 Timeline FPS 无效，不能归一化多机位同步坐标", "MULTICAM_SYNC_FPS_INVALID");
  const assets = assertInputAssets(snapshot, payload);
  await assertSourceFilesExist(snapshot, assets.values());

  const reference = assets.get(payload.referenceAssetId)!;
  const sourceRanges = normalizeSourceRanges(snapshot, assets, payload);
  const referenceRange = sourceRanges[reference.id]!;
  const windowFrames = secondsToFrames(ANALYSIS_WINDOW_SECONDS, fps);
  const driftSeparationFrames = secondsToFrames(MIN_DRIFT_WINDOW_SEPARATION_SECONDS, fps);
  if (referenceRange.endFrame - referenceRange.startFrame < windowFrames * 2 + driftSeparationFrames) {
    throw new DomainError("参考机位指定源范围不足以完成锚点与独立末尾窗口同步验证", "MULTICAM_SYNC_DRIFT_WINDOW_UNAVAILABLE");
  }
  const maxSearchFrames = secondsToFrames(payload.maxSearchSeconds, fps);
  const anchorFrames = buildReferenceAnchorFrames({ referenceRange, windowFrames, fps });
  const cacheDirectory = join(snapshot.project.rootPath, "cache", "multicam", safeFilePart(job.id));
  await mkdir(cacheDirectory, { recursive: true });

  try {
    type ScannedAnchor = AnchorScanCandidate & { reference: AudioSegment };
    const scannedAnchors: ScannedAnchor[] = await Promise.all(anchorFrames.map(async (referenceFrame, index) => {
      const referenceAnchor = await extractAudioSegment({
        path: assetPath(snapshot, reference),
        outputPath: join(cacheDirectory, `anchor-reference-${index}.pcm`),
        startFrame: referenceFrame,
        durationFrames: windowFrames,
        fps
      });
      return { referenceFrame, reference: referenceAnchor, matches: [] };
    }));
    const targets = payload.assetIds.filter((assetId) => assetId !== reference.id).map((assetId) => assets.get(assetId)!);

    for (const [targetIndex, target] of targets.entries()) {
      const targetRange = sourceRanges[target.id]!;
      for (const [anchorIndex, candidate] of scannedAnchors.entries()) {
        const targetSearchStart = Math.max(targetRange.startFrame, candidate.referenceFrame - maxSearchFrames);
        const targetLastStart = Math.min(targetRange.endFrame - windowFrames, candidate.referenceFrame + maxSearchFrames);
        // 这个位置无法让目标机位完整覆盖时，仅淘汰当前候选；其它锚点仍可能可验证。
        if (targetLastStart < targetSearchStart) continue;
        const targetSearch = await extractAudioSegment({
          path: assetPath(snapshot, target),
          outputPath: join(cacheDirectory, `anchor-${targetIndex}-${anchorIndex}-${safeFilePart(target.id)}.pcm`),
          startFrame: targetSearchStart,
          durationFrames: targetLastStart - targetSearchStart + windowFrames,
          fps
        });
        let match: AudioNccMatch;
        try {
          match = findAudioNccMatch({
            referenceSignature: candidate.reference.signature,
            targetSignature: targetSearch.signature,
            independentPeakBuckets: Math.max(1, Math.round(INDEPENDENT_PEAK_SECONDS / MULTICAM_ENERGY_HOP_SECONDS))
          });
        } catch (error) {
          // 某个窗口静音或动态不足不应阻止随后候选；所有窗口都不足时会在统一门禁处失败。
          if (error instanceof DomainError && error.code === "MULTICAM_SYNC_SIGNAL_INSUFFICIENT") continue;
          throw error;
        }
        const targetFrame = frameFromSignatureIndex(targetSearch.startFrame, match.targetStartIndex, fps);
        const sessionOffsetFrames = candidate.referenceFrame - targetFrame;
        const commonStartFrame = Math.max(referenceRange.startFrame, targetRange.startFrame + sessionOffsetFrames);
        const commonEndFrame = Math.min(referenceRange.endFrame, targetRange.endFrame + sessionOffsetFrames);
        const tailReferenceFrame = commonEndFrame - windowFrames;
        // 先排除无法执行原有远端漂移复核的锚点，不能因“当前相关最高”绕过第二个独立窗口。
        if (tailReferenceFrame - candidate.referenceFrame < driftSeparationFrames || tailReferenceFrame < commonStartFrame) continue;
        candidate.matches = [...candidate.matches, { targetAssetId: target.id, targetFrame, match }];
      }
    }

    // 先保留现有可靠性排序，再排除“每对机位可对齐、全部机位却没有共同会话范围”的假候选。
    const rangeReadyAnchors = scannedAnchors.filter((candidate) => canUseCommonRangeForDualWindow({
      commonRange: resolveCommonSessionRange({
        referenceRange,
        sourceRanges,
        referenceFrame: candidate.referenceFrame,
        matches: candidate.matches
      }),
      anchorFrame: candidate.referenceFrame,
      windowFrames,
      driftSeparationFrames
    }));
    const selectedAnchor = selectBestReliableAnchorCandidate(rangeReadyAnchors, targets.length);
    if (!selectedAnchor) {
      const strongest = scannedAnchors.flatMap((candidate) => candidate.matches)
        .sort((left, right) => right.match.correlation - left.match.correlation)[0];
      if (strongest) assertReliableMatch(strongest.match, assets.get(strongest.targetAssetId)!.name, "锚点");
      throw new DomainError(
        "有限锚点扫描中没有一个位置能让所有机位同时通过共同音轨相关性、唯一峰值和远端漂移窗口范围检查；请改用人工同一事件标记。",
        "MULTICAM_SYNC_ANCHOR_SCAN_UNVERIFIED"
      );
    }

    const referenceAnchorFrame = selectedAnchor.referenceFrame;
    const commonSessionRange = resolveCommonSessionRange({
      referenceRange,
      sourceRanges,
      referenceFrame: referenceAnchorFrame,
      matches: selectedAnchor.matches
    });
    if (!commonSessionRange) {
      throw new DomainError("多机位指定源范围没有共同可切换会话区间", "MULTICAM_SYNC_COMMON_RANGE_INVALID");
    }
    const angleSyncs: CompletedMulticamAngleSync[] = [{
      assetId: reference.id,
      label: payload.angleLabels[reference.id]!,
      sessionOffsetFrames: 0,
      method: "audio_correlation",
      confidence: 1,
      peakMargin: 1,
      driftFrames: 0,
      sourceRange: referenceRange,
      status: "candidate",
      evidence: {
        referenceSourceFrame: referenceAnchorFrame,
        angleSourceFrame: referenceAnchorFrame,
        windowFrames,
        analysisVersion: ANALYSIS_VERSION,
        referenceSourceHash: reference.sourceHash!,
        angleSourceHash: reference.sourceHash!,
        note: "参考机位被固定为会话坐标原点（sessionOffsetFrames=0）；已在指定源范围内选出所有目标机位均可验证的共同锚点。"
      }
    }];

    for (const target of targets) {
      const anchor = selectedAnchor.matches.find((candidate) => candidate.targetAssetId === target.id)!;
      assertReliableMatch(anchor.match, target.name, "锚点");
      const targetRange = sourceRanges[target.id]!;
      const angleAnchorFrame = anchor.targetFrame;
      const sessionOffsetFrames = referenceAnchorFrame - angleAnchorFrame;
      const tailReferenceFrame = commonSessionRange.endFrame - windowFrames;
      const tail = await matchTailWindow({
        cacheDirectory,
        sequence: targets.indexOf(target) + 1,
        reference,
        target,
        snapshot,
        fps,
        referenceFrame: tailReferenceFrame,
        expectedOffsetFrames: sessionOffsetFrames,
        windowFrames,
        referenceRange,
        targetRange
      });
      const driftFrames = Math.abs(tail.offsetFrames - sessionOffsetFrames);
      const driftLimitFrames = Math.max(2, Math.round(fps * 0.12));
      assertMulticamAudioConsensus({
        assetName: target.name,
        primary: anchor.match,
        validation: tail.match,
        driftFrames,
        driftLimitFrames
      });
      angleSyncs.push({
        assetId: target.id,
        label: payload.angleLabels[target.id]!,
        sessionOffsetFrames,
        method: "audio_correlation",
        confidence: clamp((anchor.match.correlation + tail.match.correlation + 2) / 4, 0, 1),
        peakMargin: Math.min(anchor.match.peakMargin, tail.match.peakMargin),
        driftFrames,
        sourceRange: targetRange,
        status: "candidate",
        evidence: {
          referenceSourceFrame: referenceAnchorFrame,
          angleSourceFrame: angleAnchorFrame,
          windowFrames,
          analysisVersion: ANALYSIS_VERSION,
          referenceSourceHash: reference.sourceHash!,
          angleSourceHash: target.sourceHash!,
          note: `共同音轨 NCC 在指定源范围内选定锚点：相关=${anchor.match.correlation.toFixed(3)}、峰值差=${anchor.match.peakMargin.toFixed(3)}；共同范围末尾相关=${tail.match.correlation.toFixed(3)}、偏移差=${driftFrames} 帧。自动结果仅为 candidate，仍需连续预览确认口型、动作和现场声。`
        }
      });
    }

    // 预览窗口固定在已通过共同锚点的 10 秒会话内；它不是正式 Timeline，
    // 只作为自动 candidate 升级前的连续声画核对证据。
    const syncPreview = await createMulticamSyncPreview({
      snapshot,
      jobId: job.id,
      assetIds: payload.assetIds,
      assets,
      angleSyncs,
      masterAudioAssetId: payload.masterAudioAssetId,
      sourceRanges,
      sessionStartFrame: referenceAnchorFrame,
      sessionEndFrame: referenceAnchorFrame + windowFrames,
      fps
    });
    let completed;
    try {
      completed = application.completeMulticamSync({
        projectId: job.projectId,
        jobId: job.id,
        angleSyncs,
        syncPreview
      });
    } catch (error) {
      // Group 未落库时不能留下看似可确认、实际上没有同步事实绑定的孤立预览。
      await rm(join(snapshot.project.rootPath, syncPreview.relativePath), { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      requestedRevision: payload.requestedRevision,
      revision: completed.state.revision.number,
      multicamGroupId: completed.group.id,
      multicamSyncPreview: syncPreview,
      angleSyncs: completed.group.angleSyncs.map((sync) => ({
        assetId: sync.assetId,
        sessionOffsetFrames: sync.sessionOffsetFrames,
        confidence: sync.confidence,
        driftFrames: sync.driftFrames
      })),
      duplicate: completed.duplicate
    };
  } finally {
    // 成功、FFmpeg 失败、低相关和 Application 写入冲突都清理每 Job 缓存，不残留可被后续任务误读的 PCM。
    await rm(cacheDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
