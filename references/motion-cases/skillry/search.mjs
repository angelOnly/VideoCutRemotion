// 网页和命令行共用检索：硬筛选原片材料，软排序用途，避免把迁移建议当实见。
export const facets = {
  original_form: '原片形态', video_types: '适用视频类型', scenes: '段落场景',
  materials: '原片实见素材', methods: '动效方法', art: '美术特点',
};
const synonyms = [['手机','移动端','app'],['照片','图片','相片'],['新闻','资讯','报道'],['科普','科学','原理'],['对照','比较','对比'],['局部','细节','聚焦'],['三维','3d'],['录屏','界面','操作教程'],['跨尺度','尺度','微观','宏观']];
function tokens(query) {
  const q = query.toLowerCase().trim();
  return q.split(/[\s，,、；;]+/u).filter(Boolean).map(token => {
    const group = synonyms.find(g => g.includes(token));
    return group || [token];
  });
}
export function searchCases(cases, {query='', filters={}, limit=Infinity}={}) {
  const terms = tokens(query);
  return cases.flatMap(c => {
    if(/^\d+$/.test(query.trim()) && c.case_number!==Number(query.trim())) return [];
    if (!Object.entries(filters).every(([key,value]) => !value || (['methods','art'].includes(key) ? c[key].some(v=>v.toLowerCase().includes(value.trim().toLowerCase())) : Array.isArray(c[key]) ? c[key].includes(value) : c[key] === value))) return [];
    const weighted = [[String(c.case_number).padStart(3,'0'),20],[String(c.case_number),20],[c.slug,8],[c.title,6],[c.author,3],
      [c.scenario,8],[c.scenes.join(' '),9],[c.materials.join(' '),9],[c.video_types.join(' '),6],
      [c.methods.join(' '),5],[c.art.join(' '),3],[c.aliases.join(' '),4],[c.original_form,3]];
    let score = 0;
    for (const variants of terms) {
      const hit = weighted.reduce((total,[s,w]) => total+(variants.some(t => s.toLowerCase().includes(t)) ? w : 0),0);
      if (!hit) return [];
      score += hit;
    }
    return [{...c,score}];
  }).sort((a,b)=>b.score-a.score || a.case_number-b.case_number).slice(0,limit);
}
