import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(path), "utf8").replace(/\r\n/g, "\n");
const roles = ["motion-case-library/references/cases/motion-case-attention-programme/CASE.md", "motion-case-library/references/cases/motion-case-attention-programme/references/transfer-guide.md", "production-director/references/asset-briefing.md", "narration-writing/SKILL.md", "visual-treatment-planning/references/art-direction.md", "motion-brief-writing/references/performance-design.md", "visual-asset-sourcing/references/source-review.md", "_shared/SCENE_DESIGN_HANDOFF.md", "production-coordinator/references/task-routing.md", "quality-verification/references/professional-review.md"];

test("指定案例从首次取材进入真实角色交接，材料回来更新全文且获取继续执行", () => {
  const bodies = roles.map(path => read(`.agents/skills/${path}`));
  const [example, guide, director, writer, visual, motion, sourcing, handoff, coordinator, review] = bodies;
  assert.match(example, /首次写声画草稿和取材请求/);
  for (const title of ["读完整意思", "候选里能看见", "用方式倒推", "材料成组", "相近内容", "搜索起点"]) assert.ok(guide.includes(title) && director.includes(title), title);
  assert.match(read(".agents/skills/production-director/SKILL.md"), /直接进入对应 CASE/);
  assert.match(writer, /当前全文及对应句群声画说明/);
  assert.match(visual, /取材请求按\[素材到场面\]/, "取材方法归导演参考，视觉正文不再复制同一流程");
  assert.match(director, /先与文案、原视觉作者把当前这段需要的画面说清/);
  assert.match(motion, /材料变动影响字位、路径、遮挡或声音时一起修改/);
  assert.match(sourcing, /已有有效观察与选段直接承接/);
  assert.match(sourcing, /没有观察时先了解全貌，再看可能采用的连续范围与必要前后文/);
  assert.match(handoff, /材料角色｜搜索起点｜实际需要什么｜在本片里做什么/);
  assert.match(coordinator, /得到明确获取决定后，主任务继续取得实际文件/);
  assert.match(review, /不因下载成本地文件而重新要求整套概览和审批/);
  assert.doesNotMatch(sourcing, /最高 720p|需求至少包含：|抽象机制通常优先 Remotion|不按拟用范围截取/);
  assert.match(read(".agents/skills/production-coordinator/SKILL.md"), /真实分派/); assert.match(coordinator, /followup_task/);
});

test("根 Skills 与发行副本保持同一份协作正文", () => {
  for (const path of roles) assert.equal(read(`plugins/videoflowcut/skills/${path}`), read(`.agents/skills/${path}`), path);
});

test("默认前期资料不直连历史案例，动画交接仍可到达机制方法与受管实现", () => {
  // 这里只核对资料路由，不把链接可达当成模型已按阶段执行。
  const links=(path:string)=>[...read(`.agents/skills/${path}`).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(match=>match[1]!);
  for(const path of ["_shared/TOPIC_TO_FILM.md","production-director/references/asset-briefing.md",
    "production-director/references/story-and-shot-design.md","narration-writing/SKILL.md",
    "visual-treatment-planning/SKILL.md","production-coordinator/references/task-routing.md"]){
    assert.ok(!links(path).some(link=>link.includes('/references/cases/')||link.includes('validated-index.md')),path);
  }
  const motion=links('motion-brief-writing/SKILL.md');
  assert.ok(motion.includes('../motion-case-library/references/mechanism-retrieval.md'));
  assert.ok(motion.includes('../remotion-production/SKILL.md'));
  assert.ok(links('motion-case-library/SKILL.md').includes('references/validated-index.md'),'用户明确请求的历史分支仍保留');
});
