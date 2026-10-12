import { readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DomainError } from "@videocut/domain";
import { probeMedia, runProcess } from "@videocut/speech";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac"]);
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_ENTRIES = 2_000;
const MAX_RESULTS = 100;

type SoundEffectRoot = {
  id: string;
  canonicalPath: string;
};

export type LocalSoundEffect = {
  rootId: string;
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  durationMs: number;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
};

export type LocalSoundEffectInspection = LocalSoundEffect & {
  onset: {
    detectedNonSilentOnsetMs?: number;
    method: "silencedetect";
    limitation: string;
  };
};

export type ResolvedLocalSoundEffect = {
  absolutePath: string;
  effect: LocalSoundEffect;
};

function isWithinRoot(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference !== "" && difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

function portableRelative(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

function assertSafeRelativePath(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || isAbsolute(trimmed) || /^[a-zA-Z]:/u.test(trimmed)) {
    throw new DomainError("本地音效只能使用已配置根目录内的相对路径", "LOCAL_SFX_PATH_UNSAFE");
  }
  const parts = trimmed.split(/[\\/]+/u);
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new DomainError("本地音效相对路径不能包含空段、. 或 ..", "LOCAL_SFX_PATH_UNSAFE");
  }
  return parts;
}

async function configuredRoots(rawRoots: string[]): Promise<SoundEffectRoot[]> {
  const raw = rawRoots.map((entry) => entry.trim()).filter(Boolean);
  if (raw.length === 0) {
    throw new DomainError("未配置本地音效根目录；请设置 VIDEOFLOWCUT_SFX_ROOTS 后重新连接 MCP。", "LOCAL_SFX_ROOTS_UNCONFIGURED");
  }
  const roots: SoundEffectRoot[] = [];
  const seen = new Set<string>();
  for (const configured of raw) {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(resolve(configured));
    } catch {
      throw new DomainError(`本地音效根目录不可访问：${configured}`, "LOCAL_SFX_ROOT_UNAVAILABLE");
    }
    const information = await stat(canonicalPath);
    if (!information.isDirectory()) {
      throw new DomainError(`本地音效根目录不是目录：${configured}`, "LOCAL_SFX_ROOT_INVALID");
    }
    const key = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({ id: `sfx-root-${roots.length + 1}`, canonicalPath });
  }
  return roots;
}

async function summarize(root: SoundEffectRoot, absolutePath: string): Promise<LocalSoundEffect | undefined> {
  const information = await stat(absolutePath);
  if (!information.isFile()) return undefined;
  const extension = extname(absolutePath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) return undefined;
  const metadata = await probeMedia(absolutePath);
  if (!metadata.hasAudio || !Number.isInteger(metadata.durationMs) || metadata.durationMs <= 0) return undefined;
  return {
    rootId: root.id,
    relativePath: portableRelative(root.canonicalPath, absolutePath),
    name: basename(absolutePath),
    extension,
    sizeBytes: information.size,
    durationMs: metadata.durationMs,
    audioCodec: metadata.audioCodec,
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
  };
}

async function resolveEffect(input: { configuredRoots: string[]; rootId: string; relativePath: string }): Promise<{ root: SoundEffectRoot; absolutePath: string; effect: LocalSoundEffect }> {
  const roots = await configuredRoots(input.configuredRoots);
  const root = roots.find((entry) => entry.id === input.rootId);
  if (!root) throw new DomainError("本地音效根目录标识不存在或当前配置已改变", "LOCAL_SFX_ROOT_NOT_FOUND");
  const candidate = resolve(root.canonicalPath, ...assertSafeRelativePath(input.relativePath));
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate);
  } catch {
    throw new DomainError("本地音效文件不存在或无法解析", "LOCAL_SFX_NOT_FOUND");
  }
  if (!isWithinRoot(root.canonicalPath, canonicalPath)) {
    throw new DomainError("本地音效路径越出了已配置根目录；拒绝导入或检测该符号链接目标", "LOCAL_SFX_PATH_ESCAPE");
  }
  const effect = await summarize(root, canonicalPath);
  if (!effect) throw new DomainError("本地音效不是可分析的受支持音频文件", "LOCAL_SFX_UNSUPPORTED");
  return { root, absolutePath: canonicalPath, effect };
}

export async function browseLocalSoundEffects(input: {
  configuredRoots: string[];
  query?: string;
  maxResults?: number;
}): Promise<{ roots: Array<{ id: string }>; effects: LocalSoundEffect[]; truncated: boolean }> {
  const roots = await configuredRoots(input.configuredRoots);
  const query = input.query?.trim().toLocaleLowerCase();
  const maxResults = Math.max(1, Math.min(MAX_RESULTS, input.maxResults ?? 50));
  const candidates: Array<{ root: SoundEffectRoot; absolutePath: string }> = [];
  let scannedEntries = 0;
  let truncated = false;
  for (const root of roots) {
    const visitedDirectories = new Set<string>();
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (truncated || visitedDirectories.has(directory)) return;
      visitedDirectories.add(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (truncated) return;
        scannedEntries += 1;
        if (scannedEntries > MAX_SCAN_ENTRIES) {
          truncated = true;
          return;
        }
        const candidate = join(directory, entry.name);
        let canonicalPath: string;
        try {
          canonicalPath = await realpath(candidate);
        } catch {
          continue;
        }
        // 遇到指向根外的符号链接时跳过，而不是沿链接泄漏其它路径的文件清单。
        if (!isWithinRoot(root.canonicalPath, canonicalPath)) continue;
        const information = await stat(canonicalPath).catch(() => undefined);
        if (!information) continue;
        if (information.isDirectory()) {
          if (depth < MAX_SCAN_DEPTH) await visit(canonicalPath, depth + 1);
          continue;
        }
        if (!information.isFile() || !AUDIO_EXTENSIONS.has(extname(canonicalPath).toLowerCase())) continue;
        const relativePath = portableRelative(root.canonicalPath, canonicalPath);
        if (query && !relativePath.toLocaleLowerCase().includes(query)) continue;
        candidates.push({ root, absolutePath: canonicalPath });
      }
    };
    await visit(root.canonicalPath, 0);
  }
  const effects: LocalSoundEffect[] = [];
  for (const candidate of candidates) {
    if (effects.length >= maxResults) {
      truncated = true;
      break;
    }
    const effect = await summarize(candidate.root, candidate.absolutePath).catch(() => undefined);
    if (effect) effects.push(effect);
  }
  return { roots: roots.map((root) => ({ id: root.id })), effects, truncated };
}

export async function inspectLocalSoundEffect(input: {
  configuredRoots: string[];
  rootId: string;
  relativePath: string;
}): Promise<LocalSoundEffectInspection> {
  const resolved = await resolveEffect(input);
  const silenceOutput = await runProcess("ffmpeg", [
    "-hide_banner", "-nostdin", "-i", resolved.absolutePath,
    "-vn", "-af", "asetpts=PTS-STARTPTS,silencedetect=n=-45dB:d=0.03", "-f", "null", "-"
  ], 120_000);
  const match = /silence_end:\s*(-?\d+(?:\.\d+)?)/u.exec(silenceOutput);
  const onsetSeconds = match ? Number(match[1]) : undefined;
  const detectedNonSilentOnsetMs = onsetSeconds !== undefined && Number.isFinite(onsetSeconds) && onsetSeconds >= 0
    ? Math.round(onsetSeconds * 1_000)
    : undefined;
  return {
    ...resolved.effect,
    onset: {
      detectedNonSilentOnsetMs,
      method: "silencedetect",
      limitation: detectedNonSilentOnsetMs === undefined
        ? "没有检测到静音结束边界；这不等于人工确认音效从第 0 ms 开始。"
        : "起点仅由静音结束检测得到；使用时仍须在 manage_audio 中明确 event_frame 与 onset_offset_frames 并试听。"
    }
  };
}

/** 受控导入只把已 realpath 限制过的绝对路径交回 MCP 的既有 importLocalMedia 流程。 */
export async function resolveLocalSoundEffectForImport(input: {
  configuredRoots: string[];
  rootId: string;
  relativePath: string;
}): Promise<ResolvedLocalSoundEffect> {
  const resolved = await resolveEffect(input);
  return { absolutePath: resolved.absolutePath, effect: resolved.effect };
}
