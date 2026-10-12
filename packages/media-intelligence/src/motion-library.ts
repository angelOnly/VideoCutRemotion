import { digest } from "./index.js";

export const MOTION_TEXT_VERSION = "motion-relations-v1";
export const MOTION_INSTRUCTION_VERSION = "motion-query-v1";
export const MOTION_QUERY_INSTRUCTION = "根据给定的视觉变化需求，检索能够实现相应对象关系、保持关系、观察变化、文字组织和接管过程的运动机制。优先动作与时序关系相符，不以题材名称、配色或无关业务数字相同为主要依据。";
export const MOTION_VIDEO_PROMPT = "描述所给范围中真实出现的运动。区分背景、主对象、附属层、文字与观察位置；按可见顺序说明哪些保持、哪些变化、哪些同时发生，以及新旧重点怎样接管。每个判断定位到实际时间范围或输入帧；文字无法辨清、速度或重叠未被采样覆盖时明确未知。不要根据导演预期补出原片没有的动作，不推测原作者代码或精确缓动参数。";
export const motionCacheKey = (source: string, identity: unknown, config: unknown, mode: string) =>
  `motion:${digest([source, identity, config, 1024, mode, MOTION_TEXT_VERSION, MOTION_INSTRUCTION_VERSION, MOTION_QUERY_INSTRUCTION])}`;

/** 长机制沿原始完整段落保存映射，避免任意截断后平均丢失动作关系。 */
export function mechanismChunks(text: string): string[] {
  const paragraphs = text.split(/\n+/u).map(value => value.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (chunks.length && chunks[chunks.length - 1].length + paragraph.length < 1500) chunks[chunks.length - 1] += `\n${paragraph}`;
    else chunks.push(paragraph);
  }
  return chunks;
}
