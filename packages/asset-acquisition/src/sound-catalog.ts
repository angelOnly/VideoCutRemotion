/** 保存来源入口与实际访问能力，不镜像整库。 */
export const SOUND_SOURCES = [
  { id: "mixkit", name: "Mixkit", url: "https://mixkit.co/free-sound-effects/", tags: ["短提示", "界面", "转场"], access: "公开分类候选与按需原文件下载", },
  { id: "a-sound-effect", name: "A Sound Effect", url: "https://www.asoundeffect.com/shop/category/interface/", tags: ["专业合集", "界面", "Whoosh"], access: "原站试听；已取得文件通过本地导入", },
  { id: "freesound", name: "Freesound", url: "https://freesound.org/browse/packs/", tags: ["社区合集", "独立文件"], access: "仅作浏览器访问入口；原站试听与下载后通过正式导入取得，不提供搜索 API", },
  { id: "ear0", name: "耳聆网", url: "https://www.ear0.com/pack", tags: ["中文合集", "生活", "提示"], access: "原站试听，取得原文件后导入", },
  { id: "boom", name: "BOOM Library", url: "https://www.boomlibrary.com/sound-effects/", tags: ["专业音色", "设计音效", "付费合集"], access: "原站试听；不自动购买，只导入已取得文件", }
] as const;

export const MIXKIT_SOUND_CATEGORIES = ["interface", "transition", "notification", "whoosh", "click", "pop", "paper", "metal", "wood", "lifestyle", "technology", "nature", "human", "transport", "traffic", "footsteps", "water", "rain", "wind", "engine", "doors", "clock", "beep", "glitch", "error", "ambience", "appliances", "city", "forest", "beach", "electricity", "camera", "crowd", "cartoon"] as const;
export const MIXKIT_MUSIC_CATEGORIES = ["ambient", "cinematic", "minimalism", "corporate-music", "lo-fi-beats", "chillout", "electronic", "mood/calm", "mood/cheerful", "mood/atmospheric"] as const;

/** 自然语言映射到原站真实分类；不伪装为网站关键词搜索 API。 */
export function mixkitCategory(query: string, music = false): string | undefined {
  const value = query.trim().toLowerCase();
  const categories: readonly string[] = music ? MIXKIT_MUSIC_CATEGORIES : MIXKIT_SOUND_CATEGORIES;
  if (categories.includes(value)) return value;
  const rules: Array<[RegExp, string]> = music ? [[/安静|平静|calm/u, "mood/calm"], [/环境|氛围|ambient/u, "ambient"], [/克制|极简|minimal/u, "minimalism"], [/科技|electronic/u, "electronic"], [/轻松|lo.?fi|chill/u, "lo-fi-beats"], [/电影|cinematic/u, "cinematic"]]
    : [[/纸|paper|rustl|unfold/u, "paper"], [/金属|metal/u, "metal"], [/木|wood/u, "wood"], [/机械|servo|mechanic|slide|latch/u, "technology"], [/脚步|footstep/u, "footsteps"], [/门|door/u, "doors"], [/时钟|clock|tick/u, "clock"], [/故障|glitch/u, "glitch"], [/提示|确认|beep|confirm/u, "beep"], [/风|wind/u, "wind"], [/水|water/u, "water"], [/雨|rain/u, "rain"], [/弹|pop/u, "pop"], [/点击|click/u, "click"], [/飞入|划过|whoosh|swish/u, "whoosh"], [/交通|traffic/u, "traffic"], [/环境|ambient/u, "ambience"]];
  return rules.find(([pattern]) => pattern.test(value))?.[1];
}
