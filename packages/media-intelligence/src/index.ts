import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnalysisDepth, AssetRequest, MediaFact, MediaMatch, MediaObservation, MediaSearchQuery, MediaSource, SourceTimeRange, SourceRegion } from "@videocut/contracts";

export const MODEL_WORKFLOWS = {
  video: "ee8e9c17-bd16-566f-ad2d-a7ec239bf4b8",
  embedding: "15904667-24ab-5e91-bc56-19ee2ad9eb4f"
};
export const ANALYSIS_VERSION = "media-observation-v5-review";
export const EMBEDDING_VERSION = "qwen3-embedding-0.6b:97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3";
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
export const assetRequestVersion = (request: AssetRequest) => digest({ ...request, status: undefined, updatedAt: undefined, createdAt: undefined });
export const timeRangeSchema = z.object({ startMs: z.number().finite().nonnegative(), endMs: z.number().finite().positive() }).strict()
  .refine((range) => range.endMs > range.startMs, "源范围结束必须晚于开始");
export const regionSchema = z.object({ page: z.number().int().positive().optional(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine((region) => region.x + region.width <= 1 && region.y + region.height <= 1, "区域必须在完整画面内");
export const factSchema = z.object({
  modality: z.enum(["visual", "audio", "speech", "text"]), text: z.string().trim().min(1).max(6000),
  range: timeRangeSchema.optional(), region: regionSchema.optional(),
  basis: z.enum(["model", "measurement", "transcript", "human"]),
  precision: z.enum(["sampled", "model_estimated", "provider_timed", "measured", "reviewed"]),
  speechPresence: z.enum(["present", "absent", "unknown"]).optional(),
  musicPresence: z.enum(["present", "absent", "unknown"]).optional(),
  keywords: z.array(z.string().trim().min(1).max(120)).max(30).default([])
}).strict();
export const analysisInputSchema = z.object({
  assetId: z.string().min(1).optional(), candidateId: z.string().min(1).optional(),
  exportArtifactId: z.string().min(1).optional(), previewJobId: z.string().min(1).optional(),
  depth: z.enum(["discovery", "index", "review"]).default("index"),
  range: timeRangeSchema.optional(), region: regionSchema.optional(),
  modalities: z.array(z.enum(["visual", "audio", "speech", "text"])).min(1).max(4).default(["visual", "audio", "speech", "text"]),
  context: z.string().max(8000).default(""), idempotencyKey: z.string().min(1).max(240).optional()
}).strict().refine((input) => [input.assetId, input.candidateId, input.exportArtifactId, input.previewJobId].filter(Boolean).length === 1, "必须指定一个素材、候选、导出或预览")
  .refine((input) => !(input.exportArtifactId || input.previewJobId) || input.depth === "review" && !input.region, "成片与预览仅支持时间范围复核");
export type AnalysisInput = z.infer<typeof analysisInputSchema>;
export const searchQuerySchema = z.object({
  query: z.string().trim().min(1).max(2000), modality: z.enum(["visual", "audio", "speech", "text"]),
  assetIds: z.array(z.string().min(1)).max(200).optional(), candidateIds: z.array(z.string().min(1)).max(200).optional(),
  minDurationMs: z.number().positive().max(3_600_000).optional(), excludeSpeech: z.boolean().optional(), excludeMusic: z.boolean().optional(),
  excludedTerms: z.array(z.string().min(1).max(100)).max(30).optional(), allowMute: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0)
}).strict();

export function intersection(a: SourceTimeRange, b: SourceTimeRange): SourceTimeRange | undefined {
  const startMs = Math.max(a.startMs, b.startMs), endMs = Math.min(a.endMs, b.endMs);
  return endMs > startMs ? { startMs, endMs } : undefined;
}
export function mergeRanges(ranges: SourceTimeRange[]): SourceTimeRange[] {
  const result: SourceTimeRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startMs - b.startMs)) {
    const previous = result.at(-1);
    if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs);
    else result.push({ ...range });
  }
  return result;
}
export function uncoveredRanges(target: SourceTimeRange, covered: SourceTimeRange[]): SourceTimeRange[] {
  let cursor = target.startMs;
  const missing: SourceTimeRange[] = [];
  for (const range of mergeRanges(covered.map((range) => intersection(range, target)).filter((range): range is SourceTimeRange => Boolean(range)))) {
    if (range.startMs > cursor) missing.push({ startMs: cursor, endMs: range.startMs });
    cursor = range.endMs;
  }
  if (cursor < target.endMs) missing.push({ startMs: cursor, endMs: target.endMs });
  return missing;
}
/** 全时长目录与抽样覆盖分开；发现层不把跨过的间隙算作理解。 */
export function planWindows(durationMs: number, depth: AnalysisDepth, requested?: SourceTimeRange): SourceTimeRange[] {
  const target = timeRangeSchema.parse(requested ?? { startMs: 0, endMs: durationMs });
  if (target.endMs > durationMs + 0.01) throw new Error("分析范围超过真实源时长");
  const size = depth === "discovery" ? 5000 : 30000;
  const stride = depth === "discovery" ? 30000 : 28000;
  const windows: SourceTimeRange[] = [];
  for (let startMs = target.startMs; startMs < target.endMs; startMs += stride) {
    const endMs = Math.min(target.endMs, startMs + size);
    if (endMs - startMs < 100) {
      if (durationMs >= 100) windows.push({ startMs: Math.max(target.startMs, endMs - 100), endMs });
      else throw new Error("模型时间窗口不得短于 100 毫秒");
    } else windows.push({ startMs, endMs });
    if (endMs >= target.endMs) break;
  }
  return windows;
}
export function regionContains(outer: SourceRegion | undefined, inner: SourceRegion | undefined): boolean {
  const full: SourceRegion = { x: 0, y: 0, width: 1, height: 1 };
  const a = outer ?? full, b = inner ?? full;
  return a.page === b.page && a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
}

/** 初次观察不接收用途、标题或期望答案；上下文保存在记录中，留给后续检索与采用判断。 */
export function analysisPrompt(modalities: string[], range: SourceTimeRange | undefined, reviewContext?: string): string {
  const labels: Record<string, string> = { visual: "画面主体和动作（visual）", audio: "实际声音（audio）", text: "可见原文（text）", speech: "语言（speech）" };
  // 素材初看保持盲观察；专项复核的问题真正送入模型，但不把问题中的预期当证据。
  if (reviewContext?.trim()) return `本次是针对实际媒体的专项模型复核。请逐项回答下面的问题，将可观察结果写入facts，不确定或超出输入/采样能力的部分写入unknowns。问题中的脚本、候选答案和预期均不是观察证据，不得照抄当作听见或看见。音频字词核查须直接依据音轨；无法区分的同音字、精确同步、快速动作必须明确不确定。不得宣称人工听审或自动验收通过。\n复核问题：\n${reviewContext.trim()}\n输出合同：只输出一个JSON对象，facts为事实数组，每条包含modality（仅限${modalities.join("、")}）、text中文具体回答、keywords数组；声音事实可包含speechPresence/musicPresence（present/absent/unknown）。逐字听辨作为audio事实，保留重复和不确定处。unknowns为不确定项字符串数组。能定位才填写相对本窗口的startMs/endMs，范围0到${range ? range.endMs - range.startMs : "实际输入时长"}毫秒。不要给未观察内容补全答案或精确时间。`;
  if (modalities.length === 1 && modalities[0] === "audio") {
    return `请仔细听实际输入的整段音频，仅描述能听到的声学特征与事件，不猜具体发声物体或用途。描述短促或持续、次数、起音与尾音、音高/摩擦/冲击等。判断可辨语音与有组织音乐：听到为present，能确认没有为absent，证据不足为unknown。\n`
      + `仅输出一个完整JSON对象，结束后不要追加文字或括号。顶层facts为事实数组，unknowns为不确定项字符串数组。每条事实包含modality固定audio、text中文描述、keywords关键词数组、speechPresence及musicPresence三态字段。能听出事件发生范围时增加startMs和endMs，单位为本段相对毫秒，必须在0到${range ? range.endMs - range.startMs : "实际音频时长"}以内；不能定位就省略两项。没有可辨事实可以返回空facts，并说明原因。`;
  }
  return `请逐项分析实际输入的${modalities.map((modality) => labels[modality]).join("、")}，每种有内容的模态分别给出事实，无法观察的模态写入 unknowns。视觉与原声不能互相代替。标题、字幕、上下文不能当作听到的声音。未知就写未知，不猜型号、来源真实性或精确同步。\n`
    + `输出 JSON，结构示例：{"facts":[{"modality":"${modalities[0] ?? "audio"}","text":"中文事实","keywords":["关键词"],"speechPresence":"unknown","musicPresence":"unknown"}],"unknowns":["不确定项"]}。modality只能是所请求的${modalities.join("、")}；不确定内容放unknowns数组。speechPresence、musicPresence只放在audio事实内部，取present、absent或unknown。音乐指有组织的音乐，不把单一纯音自动归为配乐。`
    + `如果能辨认事实发生的局部范围，可以增加数值startMs、endMs；无法定位就省略，不照抄格式示例的时长，不补造起止点。`
    + `时间为当前输入窗口相对毫秒，范围不得超出${range ? range.endMs - range.startMs : "图片没有时间，省略时间字段"}。声音属性只在audio事实填写。短动作给出可见范围，无法判断连续性需写明。不要输出时间精度或已审阅的声明。只输出完整JSON，结束后不要追加文字或括号。`;
}

/** 模型只提供候选语义，不能自行将精度提升为 measured/reviewed。 */
export function parseObservation(raw: string, range: SourceTimeRange | undefined, modalities: string[]): { facts: MediaFact[]; unknowns: string[] } {
  const modelFact = z.object({ modality: z.enum(["visual", "audio", "speech", "text"]), text: z.string().trim().min(1).max(6000), startMs: z.number().finite().nonnegative().optional(), endMs: z.number().finite().positive().optional(), keywords: z.array(z.string().min(1).max(120)).max(30).optional(), speechPresence: z.enum(["present", "absent", "unknown"]).optional(), musicPresence: z.enum(["present", "absent", "unknown"]).optional() });
  const schema = z.object({ facts: z.array(z.unknown()).max(100), unknowns: z.array(z.string()).max(100).default([]) });
  try {
    // 只修复字符串外的中文分隔符与弯引号，不改写事实文字或补充字段。
    let normalized = "", quote: string | undefined, escaped = false;
    for (const char of raw.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")) {
      if (quote) {
        if (!escaped && char === quote) { normalized += '"'; quote = undefined; }
        else { normalized += char; escaped = !escaped && char === "\\"; }
      } else if (char === '"' || char === "“") { normalized += '"'; quote = char === "“" ? "”" : '"'; escaped = false; }
      else normalized += char === "，" ? "," : char === "：" ? ":" : char;
    }
    // 允许模型连续返回数个完整 JSON 对象；不从任意说明文字中猜测事实。
    const objects: unknown[] = [];
    let objectStart = -1, nesting = 0, inString = false, escape = false, extraClosingBrace = false;
    for (let index = 0; index < normalized.length; index++) {
      const char = normalized[index];
      if (inString) { if (!escape && char === '"') inString = false; escape = !escape && char === "\\"; continue; }
      if (char === '"' && nesting) { inString = true; escape = false; continue; }
      if (!nesting && !/\s/u.test(char) && char !== "{") {
        // 只容忍一个完整对象之后孤立的右括号；不截取说明文字、不补未闭合的内容。
        if (objects.length === 1 && normalized.slice(index).trim() === "}") { extraClosingBrace = true; break; }
        throw new Error("JSON 对象外存在无效文本");
      }
      if (char === "{") { if (!nesting) objectStart = index; nesting++; }
      if (char === "}") { nesting--; if (!nesting) objects.push(JSON.parse(normalized.slice(objectStart, index + 1))); }
    }
    if (nesting || !objects.length || objects.length > 30) throw new Error("模型 JSON 不完整或过多");
    const parts = objects.map((object) => schema.parse(object));
    const parsed = schema.parse({ facts: parts.flatMap((part) => part.facts), unknowns: parts.flatMap((part) => part.unknowns) });
    const unknowns = [...parsed.unknowns];
    if (extraClosingBrace) unknowns.push("完整 JSON 后有一个多余右括号，已仅修复结构并保留原文；不代表事实或声音适配已复核");
    const facts: MediaFact[] = [];
    for (const value of parsed.facts) {
      const checked = modelFact.safeParse(value);
      if (!checked.success) { unknowns.push("有一条模型事实结构无效，已单独排除并保留原文"); continue; }
      const fact = checked.data;
      if (!modalities.includes(fact.modality)) continue;
      let factRange: SourceTimeRange | undefined;
      if (range && fact.startMs !== undefined && fact.endMs !== undefined) {
        const startMs = fact.startMs, endMs = fact.endMs;
        if (endMs <= startMs || endMs > range.endMs - range.startMs + 1) { unknowns.push("模型事实范围越界，已保留原文并排除该事实"); continue; }
        factRange = { startMs: range.startMs + startMs, endMs: range.startMs + endMs };
      }
      if (range && !factRange) unknowns.push("这条事实尚无可靠源时间范围，不能作为连续采用范围的覆盖证明");
      facts.push({ modality: fact.modality, text: fact.text, range: factRange, basis: "model", precision: fact.modality === "visual" ? "sampled" : "model_estimated", keywords: fact.keywords ?? [], ...(fact.modality === "audio" ? { speechPresence: fact.speechPresence ?? "unknown", musicPresence: fact.musicPresence ?? "unknown" } : {}) });
    }
    return { facts, unknowns };
  } catch {
    return { facts: [], unknowns: ["模型输出没有通过结构校验；原始响应已保存，不能据此确认关键事实"] };
  }
}

/** 中文字符二元组用于词法召回，避免默认英文分词漏掉中文素材。 */
export function lexicalTokens(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/gu) ?? []);
  for (const chunk of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (chunk.length === 1) tokens.add(chunk);
    for (let index = 0; index < chunk.length - 1; index++) tokens.add(chunk.slice(index, index + 2));
  }
  return tokens;
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== 1024 || b.length !== 1024 || [...a, ...b].some((value) => !Number.isFinite(value))) throw new Error("向量必须是有效的 1024 维数值");
  const norm = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0) * b.reduce((sum, value) => sum + value * value, 0));
  if (norm < 1e-12) throw new Error("向量不能为零");
  return Math.max(-1, Math.min(1, a.reduce((sum, value, index) => sum + value * b[index], 0) / norm));
}

export function matchObservation(source: MediaSource, observation: MediaObservation, query: MediaSearchQuery, vectorScore?: number, factScores?: Array<number | undefined>): MediaMatch[] {
  if (source.hash !== observation.sourceHash) return [];
  const tokens = lexicalTokens(query.query);
  return observation.facts.flatMap((fact, factIndex) => {
    if (fact.modality !== query.modality) return [];
    const scoreForFact = factScores ? factScores[factIndex] : vectorScore;
    const haystack = `${fact.text} ${fact.keywords.join(" ")}`.normalize("NFKC").toLowerCase();
    const indexed = lexicalTokens(haystack);
    const lexicalScore = tokens.size ? [...tokens].filter((token) => indexed.has(token)).length / tokens.size : 0;
    if (!lexicalScore && (scoreForFact === undefined || scoreForFact < 0.25)) return [];
    // 条件以同一源区间求交，含人声的一小段不会吞掉前后可用范围。
    const audio = observation.facts.filter((entry) => entry.modality === "audio" && entry.range && fact.range && intersection(entry.range, fact.range));
    const boundaries = fact.range && (query.excludeSpeech || query.excludeMusic) && !(query.allowMute && query.modality === "visual")
      ? [...new Set([fact.range.startMs, fact.range.endMs, ...audio.flatMap((entry) => { const range = intersection(entry.range!, fact.range!)!; return [range.startMs, range.endMs]; })])].sort((a, b) => a - b) : [];
    const parts: Array<SourceTimeRange | undefined> = boundaries.length ? boundaries.slice(0, -1).map((startMs, index) => ({ startMs, endMs: boundaries[index + 1] })) : [fact.range];
    const fragments = parts.map((range) => {
      const rejected: string[] = [], unknown: string[] = [], conditions: string[] = [];
      for (const word of query.excludedTerms ?? []) if (haystack.includes(word.normalize("NFKC").toLowerCase())) rejected.push("命中排除词：" + word);
      const checkAudio = (property: "speechPresence" | "musicPresence", label: string) => {
        if (query.allowMute && query.modality === "visual") { if (!conditions.includes("本次采用必须静音")) conditions.push("本次采用必须静音"); return; }
        if (!source.hasAudio) { if (query.modality === "audio") rejected.push("源文件没有音轨"); return; }
        const overlapping = audio.filter((entry) => range && intersection(entry.range!, range));
        if (overlapping.some((entry) => entry[property] === "present")) { rejected.push("拟用范围实际含" + label); return; }
        const absent = overlapping.filter((entry) => entry[property] === "absent").map((entry) => entry.range!);
        if (!range || uncoveredRanges(range, absent).length) unknown.push("拟用范围没有足够的无" + label + "证据");
      };
      if (query.excludeSpeech) checkAudio("speechPresence", "人声");
      if (query.excludeMusic) checkAudio("musicPresence", "音乐");
      return { range, rejected, unknown, conditions };
    });
    // 同条件相邻范围可以合并；中间的未知或违例区间不能被跨越。
    const joined: typeof fragments = [];
    for (const fragment of fragments) {
      const previous = joined.at(-1);
      if (previous?.range && fragment.range && previous.range.endMs === fragment.range.startMs && JSON.stringify([previous.rejected, previous.unknown, previous.conditions]) === JSON.stringify([fragment.rejected, fragment.unknown, fragment.conditions])) previous.range.endMs = fragment.range.endMs;
      else joined.push({ ...fragment, range: fragment.range && { ...fragment.range } });
    }
    return joined.map(({ range, rejected, unknown, conditions }) => {
      if (query.minDurationMs) {
        if (!range || range.endMs - range.startMs < query.minDurationMs) rejected.push("同一连续可用范围不足所需时长");
        else if (fact.precision === "sampled") unknown.push("低密度画面观察尚未确认整个连续范围，需复核");
      }
      const status = rejected.length ? "rejected" : unknown.length ? "insufficient" : conditions.length ? "conditional" : "usable";
      return { source, observationId: observation.id, range, region: fact.region ?? observation.region, text: fact.text, score: scoreForFact === undefined ? lexicalScore : 0.45 * lexicalScore + 0.55 * Math.max(0, scoreForFact), lexicalScore, semanticScore: scoreForFact, status, reasons: [...rejected, ...unknown], conditions } satisfies MediaMatch;
    });
  });
}
