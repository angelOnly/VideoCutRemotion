import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(path), "utf8").replace(/\r\n/g, "\n");
const roles = ["motion-case-library/references/cases/motion-case-attention-programme/CASE.md", "motion-case-library/references/cases/motion-case-attention-programme/references/transfer-guide.md", "production-director/references/asset-briefing.md", "narration-writing/SKILL.md", "visual-treatment-planning/references/art-direction.md", "motion-brief-writing/references/performance-design.md", "visual-asset-sourcing/references/source-review.md", "_shared/SCENE_DESIGN_HANDOFF.md", "production-coordinator/references/task-routing.md", "quality-verification/references/professional-review.md"];

test("主题路由把材料探索接入首轮，并保留导演采用与实际媒体观察边界", () => {
  const director = read(".agents/skills/production-director/SKILL.md");
  const coordinator = read(".agents/skills/production-coordinator/SKILL.md");
  const source = read(".agents/skills/visual-asset-sourcing/references/source-review.md");
  const topic = read(".agents/skills/_shared/TOPIC_TO_FILM.md");
  assert.ok(director.includes("../_shared/TOPIC_TO_FILM.md"));
  assert.ok(director.includes("references/asset-briefing.md"));
  assert.ok(coordinator.includes("../_shared/TOPIC_TO_FILM.md"));
  assert.match(coordinator, /spawn_agent/);
  assert.match(coordinator, /followup_task/);
  assert.doesNotMatch(coordinator, /导演提出专项范围后再派发/);
  assert.match(source, /网页线索不冒称已看过视频/);
  assert.match(topic, /只有用户明确改任务/);
  assert.doesNotMatch(director, /直接进入对应 CASE/);
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
