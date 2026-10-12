import { z } from "zod";

const text = z.string().trim().min(1);
const list = z.array(text).min(2);
const displayText = { sourceCaption: text.max(1600).optional().describe("作者明确选择的上屏来源或署名；不自动展示内部 source 元数据"), eyebrow: text.max(160).optional() };
const props = <S extends z.ZodRawShape>(shape: S) => z.object({ ...displayText, ...shape }).passthrough();

/** HTTP 与 MCP 共享各内置主视觉的内容合同；附加美术参数仍原样保留。 */
export function explainerPlanWithContent<S extends z.ZodRawShape>(fields: S) {
  const base = z.object(fields).strict();
  return z.discriminatedUnion("kind", [
    base.extend({ kind: z.literal("HeroReveal"), props: props({ metric: text.describe("可核对的核心数字或对象") }) }),
    base.extend({ kind: z.literal("Comparison"), props: props({ leftLabel: text, rightLabel: text, dimension: text }) }),
    base.extend({ kind: z.literal("ProgressiveClassification"), props: props({ items: list }) }),
    base.extend({ kind: z.literal("RouteAndFlow"), props: props({ nodes: list }) }),
    base.extend({ kind: z.literal("EvidenceDocument").describe("必须绑定已有 EvidenceCapture；页面素材必须能渲染"), props: props({}).optional() }),
    base.extend({ kind: z.literal("UIWalkthrough").describe("必须绑定已就绪的真实界面截图或录屏，不能使用生成素材"), props: props({}).optional() }),
    base.extend({ kind: z.literal("DataConclusion"), props: props({ values: z.array(z.number().finite()).min(1), labels: z.array(text).min(1), source: text, unit: text, baseline: text }).describe("values 与 labels 必须同长度；数据来源、单位和基线不可省略") }),
    base.extend({ kind: z.literal("PeopleGrouping"), props: props({ groups: list, dimension: text }) }),
    base.extend({ kind: z.literal("LayerStack"), props: props({ layers: list, relationship: text }) }),
    base.extend({ kind: z.literal("HistoryTimeline"), props: props({ events: z.array(props({ date: text, label: text, detail: text.optional() })).min(2), source: text }) }),
    base.extend({ kind: z.literal("QuotePortrait").describe("必须绑定真实人物或机构视觉素材，不能绑定 EvidenceCapture"), props: props({ quote: text, attribution: text, source: text }) }),
    base.extend({ kind: z.literal("RealityBroll").describe("必须绑定已就绪、非生成的图片或视频，不能绑定 EvidenceCapture"), props: props({}).optional() })
  ]);
}
