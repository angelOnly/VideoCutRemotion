import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readRuntimeConfig } from "@videocut/project-overview";
import { boundMotionFontSchema, type BoundMotionFont, type MotionSubmission } from "./schema.js";

const catalogSchema = z.object({ schemaVersion: z.literal(1), fonts: z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u), name: z.string().min(1),
  file: z.string().regex(/^[A-Za-z0-9_-]+\.(?:otf|ttf)$/u), weight: z.number().int().min(100).max(900),
  style: z.enum(["normal", "italic"]), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  // 许可仅记录来源信息，不把已授权商业字体限制为OFL；文件身份与加载校验继续执行。
  license: z.string().trim().min(1).max(160), licenseFile: z.string().regex(/^[A-Za-z0-9_-]+\.txt$/u).optional(), sourceUrl: z.string().url()
}).strict()) }).strict();

export interface PreparedMotionFont { binding: BoundMotionFont; dataUrl: string; format: "otf" | "ttf"; }
/** 未登记是选择问题；这个异常仅在提交前查目录时产生，不代表渲染任务失败。 */
export class MotionFontUnknownError extends Error {
  constructor(readonly fontId: string) {
    super(`MOTION_FONT_UNKNOWN: ${fontId}；请查询字体库并由原作者推荐已有字体供用户选择`);
    this.name = "MotionFontUnknownError";
  }
}
export const motionFontProps = (fonts: BoundMotionFont[]) => Object.fromEntries(fonts.map(font =>
  [font.slot, { family: font.family, weight: font.weight, style: font.style }]));

/** 发行只读目录由启动器固定；源码运行时定位自身目录，不读系统字体或用户路径。 */
export function motionFontsRoot(): string {
  const release = readRuntimeConfig().runtime.distributionDirectory;
  return release ? join(release, "fonts") : typeof __dirname === "string" ? join(__dirname, "fonts")
    : join(dirname(fileURLToPath(import.meta.url)), "..", "fonts");
}

function catalog(root: string) {
  try {
    const parsed = catalogSchema.parse(JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")));
    if (new Set(parsed.fonts.map(font => font.id)).size !== parsed.fonts.length) throw new Error("字体 ID 重复");
    return parsed.fonts;
  } catch (error) { throw new Error(`MOTION_FONT_CATALOG_INVALID: ${String(error)}`); }
}

function fontBytes(font: ReturnType<typeof catalog>[number], root: string): Buffer {
  let bytes: Buffer;
  try {
    const resolvedRoot = realpathSync(root), path = realpathSync(join(resolvedRoot, font.file));
    const child = relative(resolvedRoot, path);
    if (isAbsolute(child) || child.startsWith("..")) throw new Error("字体路径超出发行目录");
    // 烟波宋原件约25MiB；保留完整字形，以32MiB限制单文件，不在线改造字体。
    if (!statSync(path).isFile() || statSync(path).size > 32 * 1024 * 1024) throw new Error("字体文件无效或超过32MiB");
    bytes = readFileSync(path);
  } catch (error) { throw new Error(`MOTION_FONT_FILE_INVALID: ${font.id}；${String(error)}`); }
  const validFormat = font.file.endsWith(".otf") ? bytes.toString("ascii", 0, 4) === "OTTO" : bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00010000;
  if (!validFormat) throw new Error(`MOTION_FONT_FORMAT: ${font.id} 的字体格式与扩展名不符`);
  if (createHash("sha256").update(bytes).digest("hex") !== font.sha256) throw new Error(`MOTION_FONT_CHANGED: ${font.id} 文件校验值不符`);
  return bytes;
}

export function listMotionFonts(root = motionFontsRoot()) {
  return catalog(root).map(font => {
    fontBytes(font, root);
    const { file: _file, ...info } = font;
    return info;
  });
}

/** 工作台只按发行ID取原件；哈希放进URL，缓存不能把旧链接悄悄指向新字形。 */
export function readMotionFontFile(id: string, hash: string, root = motionFontsRoot()) {
  const font = catalog(root).find(entry => entry.id === id);
  if (!font) throw new MotionFontUnknownError(id);
  if (hash !== font.sha256) throw new Error("MOTION_FONT_VERSION_MISMATCH: 字体目录已更新，请刷新字体库");
  return { bytes: fontBytes(font, root), contentType: font.file.endsWith(".otf") ? "font/otf" : "font/ttf" };
}

export function bindMotionFonts(work: Pick<MotionSubmission, "fontBindings">, root = motionFontsRoot()): BoundMotionFont[] {
  const entries = Object.entries(work.fontBindings ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return [];
  const available = catalog(root);
  return entries.map(([slot, id]) => {
    const font = available.find(candidate => candidate.id === id);
    if (!font) throw new MotionFontUnknownError(id);
    fontBytes(font, root);
    return boundMotionFontSchema.parse({ slot, fontId: id, hash: font.sha256,
      family: `VFC_${font.sha256}`, weight: font.weight, style: font.style });
  });
}

/** Worker 用提交时固定的身份复核，不因目录更新而偷偷换字体。 */
export function prepareMotionFonts(work: MotionSubmission, bound: BoundMotionFont[], root = motionFontsRoot()): PreparedMotionFont[] {
  const current = bindMotionFonts(work, root);
  if (JSON.stringify(current) !== JSON.stringify(bound)) throw new Error("MOTION_FONT_BINDING_MISMATCH: 字体绑定与固定输入不符");
  if (!current.length) return [];
  const available = catalog(root);
  const data = new Map<string, string>();
  return current.map(binding => {
    const font = available.find(f => f.id === binding.fontId)!;
    const format = font.file.endsWith(".ttf") ? "ttf" : "otf";
    if (!data.has(binding.fontId)) data.set(binding.fontId, `data:font/${format};base64,${fontBytes(font, root).toString("base64")}`);
    return { binding, dataUrl: data.get(binding.fontId)!, format };
  });
}
