/** 在线目录仅保存入口，不下载整库；工程格式不决定视觉参考能否使用。 */
export const MOTION_SOURCES = [
  { id: "onda", name: "Onda", url: "https://remotion.onda.video/components", showcaseUrl: "https://remotion.onda.video/showcase", tags: ["文字", "图表", "强调", "组合场景"], note: "观察动态预览；有可用源码时可复用，否则依据视觉机制独立实现。" },
  { id: "jitter", name: "Jitter", url: "https://jitter.video/templates/all/", showcaseUrl: "https://jitter.video/templates/text/", tags: ["文字", "标题", "品牌", "社媒"], note: "模板格式不限制选型；独立编写 Remotion，不冒称已有源码导入。" },
  { id: "remotionlab", name: "RemotionLab", url: "https://remotionlab.com/showcase", showcaseUrl: "https://remotionlab.com/showcase", tags: ["中文", "字卡", "转场", "字幕"], note: "可观察公开预览；核对源码是否实际可取得，不批量抓取会员内容。" },
  { id: "mixkit", name: "Mixkit", url: "https://mixkit.co/free-after-effects-templates/", showcaseUrl: "https://mixkit.co/free-after-effects-templates/titles/", tags: ["标题", "身份条", "转场", "包装"], note: "AE 只是参考来源格式；无需安装 AE 才能用 Remotion 实现同类表达。" }
] as const;

export function motionSourceForUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("参考链接必须是无凭据的 HTTPS 公开页面");
  const source = MOTION_SOURCES.find((entry) => new URL(entry.url).hostname === url.hostname);
  if (!source) throw new Error("参考链接不属于已选择的四个在线来源");
  return source;
}
