import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const repositoryRoot = process.cwd();
const skillsRoot = join(repositoryRoot, ".agents", "skills");
const pluginRoot = join(repositoryRoot, "plugins", "videoflowcut");
const pluginSkillsRoot = join(pluginRoot, "skills");
const pluginManifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
const pluginMcpPath = join(pluginRoot, ".mcp.json");
const mcpSourcePath = join(repositoryRoot, "apps", "server", "src", "mcp.ts");
const execFileAsync = promisify(execFile);

test("字体身份与选择操作分别位于实现合同和提交参考", async () => {
  const contract = await readFile(join(skillsRoot,"remotion-production/references/remotion-component-contract.md"),"utf8");
  for (const token of ["read_motion_capabilities","fontBindings","props.fonts","首次挂载前","哈希","实际字重"]) assert.ok(contract.includes(token),token);
  const writes=await readFile(join(skillsRoot,"remotion-production/references/submission-and-recovery.md"),"utf8");
  for(const token of ["fontSources","字体可用性与替代","用户明确指定且不接受替代","原作者可自主选择"])assert.ok(writes.includes(token),token);
  assert.match(contract,/不回退系统字体/);
  const source=await readFile(join(repositoryRoot,"apps/server/src/motion-tools.ts"),"utf8");
  assert.match(source,/registerTool\("read_motion_capabilities"/);
  assert.match(source,/readOnlyHint: true/);
});

test("字幕位置配置与无固定安全区合同一致，发布指引不要求测量或提示", async () => {
  const captions = await readSkill("captions");
  const motion = await readSkill("remotion-production");
  const contract = await operationKnowledge();
  assert.match(captions, /默认底部布局/u);
  assert.match(captions, /placement/u);
  assert.match(captions, /不划定动效禁入区域/u);
  assert.match(motion, /不强加统一标题栏或固定字幕保留带/u);
  assert.match(contract, /不测量字幕安全区相交来阻断/u);
  assert.doesNotMatch(motion + contract, /返回待审 warning|可重生成取得证据|Worker 保存真实透明帧的 `motion.visibility`/u);
});

test("视频Skill与MCP统一根时钟、选段字段和资源回收合同", async () => {
  const skill = await readSkill("remotion-production");
  const contract = await operationKnowledge();
  const component = await readFile(join(skillsRoot, "remotion-production/references/remotion-component-contract.md"), "utf8");
  for (const text of [skill, contract, component]) {
    for (const field of ["sourceStartMs", "sourceEndMs", "startFrame", "endFrame", "TimelineVideo"]) assert.ok(text.includes(field));
    assert.match(text, /不足一.*帧/u);
    assert.doesNotMatch(text, /源文件合计最多 512|解码结果合计最多 512|最长 30 秒/u);
  }
  // 验证当前播放语义；历史引擎名只属于迁移诊断，不是每份使用说明的必读内容。
  assert.match(component, /TimelineVideo 读取平台保存的作品根帧，不随内部 Sequence 重置/u);
  assert.match(component, /源毫秒和作品帧均为半开区间/u);
  assert.match(component, /正常速度重采样并静音/u);
  assert.match(component, /<Sequence from=\{60\} durationInFrames=\{60\}>[\s\S]*<TimelineVideo slot="footage"/u);
  const source = await readFile(join(repositoryRoot, "packages/motion-work/src/compiler.ts"), "utf8");
  assert.match(source, /createContext\(null\)/u);
  assert.match(source, /const frame=useContext\(FrameContext\)/u);
  assert.doesNotMatch(source, /export function BoundVideo/u);
});

const expectedSkills = [
  "asset-import",
  "audio-finishing",
  "sound-asset-sourcing",
  "avatar-performance",
  "captions",
  "cutaway-planning",
  "depth-composition",
  "effect-timing",
  "evidence-visualization",
  "export",
  "known-errors",
  "motion-case-library",
  "motion-brief-writing",
  "presenter-motion-director",
  "production-coordinator",
  "production-director",
  "project-basics",
  "quality-verification",
  "remotion-production",
  "scene-planning",
  "narration-writing",
  "semantic-continuity",
  "transcription",
  "visual-asset-sourcing",
  "visual-explainer-director",
  "visual-treatment-planning",
  "vlog-director",
  "voice-production",
  "web-editor-operator"
] as const;

const primaryWorkflows = ["presenter-motion-director", "visual-explainer-director", "vlog-director"] as const;

// 创意路由与客观准备分开验收，避免把所有 Skill 都强制变成新的代理。
const creativeSpecialists = [
  "narration-writing",
  "semantic-continuity", "voice-production", "avatar-performance", "visual-treatment-planning",
  "scene-planning", "visual-asset-sourcing", "cutaway-planning", "remotion-production",
  "depth-composition", "effect-timing", "evidence-visualization", "captions",
  "sound-asset-sourcing", "audio-finishing"
] as const;

const currentSceneTypes = ["PresenterScene", "ExplainerScene", "VlogMontageScene", "CutawayScene", "EndCardScene"] as const;

const specialistSkills = [
  "asset-import",
  "transcription",
  "narration-writing",
  "semantic-continuity",
  "voice-production",
  "avatar-performance",
  "visual-treatment-planning",
  "scene-planning",
  "effect-timing",
  "depth-composition",
  "cutaway-planning",
  "evidence-visualization",
  "captions",
  "audio-finishing",
  "sound-asset-sourcing",
  "remotion-production"
] as const;

const architectureTargets = new Set(["smooth_audio"]);

/** 已被 Skill 使用的 MCP 必须继续注册，避免再被误降级为“架构目标”。 */
const currentSkillTools = new Set([
  "apply_authored_script",
  "inspect_asset",
  "read_actor_capabilities",
  "submit_avatar_job",
  "read_narrative_map",
  "set_explainer_program_enabled"
]);

const compatibilityOnlyTools = new Set(["create_presenter_timeline"]);

// 宿主负责代理生命周期；这些名称不能被误注册为 VideoFlowCut MCP 来通过验收。
const hostCollaborationTools = new Set(["spawn_agent", "followup_task", "list_agents", "interrupt_agent"]);

const ignoredToolLikeTokens = new Set([
  // 机制元数据中的起始状态不是 start_* 操作。
  "start_state",
  "start_frame",
  "end_frame",
  "base_revision_id",
  "project_id",
  "asset_id",
  "scene_id",
  "timeline_item_id",
  "effect_cue_id",
  "run_id",
  "job_id",
  "preview_job_id",
  "voice_reference_id",
  "voice_reference_asset_id",
  "speech_asset_id",
  "speech_segment_ids",
  "semantic_unit_ids",
  "style_pack_id",
  "quality_rules",
  "source_url",
  "mcp_command",
  "idempotency_key"
]);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readSkill(name: string): Promise<string> {
  const own = await markdownFiles(join(skillsRoot, name));
  // 测试核对本能力完整知识；这不代表执行时加载全部参考或案例。
  return (await Promise.all(own.filter(path => !path.includes("references/cases")).map(path => readFile(path, "utf8")))).join("\n");
}

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await markdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** 用户工作区可暂存未跟踪的评审资料；CI 只约束进入 Git 的运行时 Skills 副本。 */
async function hasTrackedNestedExecutableSkills(): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--", "docs"], { cwd: repositoryRoot, encoding: "utf8" });
  return String(stdout).split(/\r?\n/u).some((path) => /(?:^|\/)\.agents\/skills\/.+\/SKILL\.md$/u.test(path));
}

async function operationKnowledge(): Promise<string> {
  const files = await markdownFiles(skillsRoot);
  return (await Promise.all(files.filter(path => !path.replace(/\\/g, "/").includes("/cases/")).map(path => readFile(path, "utf8")))).join("\n");
}

function localMarkdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)]+\.md)(?:#[^)]+)?\)/gu)]
    .map((match) => match[1]!)
    .filter((reference) => !reference.startsWith("http://") && !reference.startsWith("https://"));
}

function registeredToolNames(mcpSource: string): Set<string> {
  return new Set([...mcpSource.matchAll(/server\.registerTool\("([^"]+)"/gu)].map((match) => match[1]!));
}

function toolSourceBlock(mcpSource: string, name: string): string {
  const start = mcpSource.indexOf(`server.registerTool("${name}"`);
  assert.notEqual(start, -1, `MCP 未注册工具：${name}`);
  const next = mcpSource.indexOf("server.registerTool(", start + 1);
  return mcpSource.slice(start, next === -1 ? undefined : next);
}

function toolTokens(markdown: string): string[] {
  const toolPrefixes = /^(?:list|create|target|read|manage|browse|import|submit|apply|assemble|compile|align|render|inspect|record|complete|start|track|update|move|preview|rollback|validate|get|search|acquire|replace|edit|smooth|run)_[a-z0-9_]+$/u;
  return [...markdown.matchAll(/`([a-z][a-z0-9_]*)`/gu)]
    .map((match) => match[1]!)
    .filter((token) => toolPrefixes.test(token) && !ignoredToolLikeTokens.has(token));
}

function sceneTypesInTool(toolSource: string): string[] {
  return [...new Set([...toolSource.matchAll(/"([A-Z][A-Za-z]*Scene)"/gu)].map((match) => match[1]!))].sort();
}

/** 检查实际引用图，避免专业资料已发布却没有可达入口；不将可达性冒称创作验收。 */
async function reachableMarkdown(entry: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const pending = [resolve(entry)];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    for (const reference of localMarkdownLinks(await readFile(path, "utf8"))) {
      const target = resolve(dirname(path), reference);
      const fromRoot = relative(skillsRoot, target);
      assert.ok(fromRoot !== ".." && !fromRoot.startsWith("../") && !fromRoot.startsWith("..\\"), `专业资料越出唯一 Skills 源：${target}`);
      pending.push(target);
    }
  }
  return visited;
}

test("人物剪辑专业资料从导演与相关专项可达，发行内容保持一致", async () => {
  const grammar = resolve(skillsRoot, "presenter-motion-director/references/presenter-editing-grammar.md");
  for (const entry of ["presenter-motion-director", "visual-treatment-planning", "remotion-production"]) {
    const reachable = await reachableMarkdown(join(skillsRoot, entry, "SKILL.md"));
    assert.ok(reachable.has(grammar), `${entry} 无法沿正式引用读取人物剪辑语法`);
  }
  assert.equal(
    await readFile(join(pluginSkillsRoot, relative(skillsRoot, grammar)), "utf8"),
    await readFile(grammar, "utf8"),
    "专业资料的发行副本与唯一源不一致"
  );
});

test("方法与案例可达，但案例不再注册独立工作能力", async () => {
  const library = await reachableMarkdown(join(skillsRoot,"motion-case-library/SKILL.md"));
  const cases = await readdir(join(skillsRoot,"motion-case-library/references/cases"));
  assert.equal(cases.length,13);
  for(const id of cases){
    assert.ok(library.has(resolve(skillsRoot,`motion-case-library/references/cases/${id}/CASE.md`)));
    assert.equal(await exists(join(skillsRoot,id)),false);
    assert.equal(await exists(join(skillsRoot,`motion-case-library/references/cases/${id}/SKILL.md`)),false);
  }
  const methods=await reachableMarkdown(join(skillsRoot,"remotion-production/SKILL.md"));
  for(const file of ["visual-treatment-planning/references/art-direction.md","motion-brief-writing/references/performance-design.md","motion-brief-writing/references/execution-brief-template.md","remotion-production/references/material-space-and-time.md","remotion-production/references/submission-and-recovery.md"]){assert.ok(methods.has(resolve(skillsRoot,file)),file)}
  const template=await readFile(join(skillsRoot,"motion-brief-writing/references/execution-brief-template.md"),"utf8");
  for(const section of ["实际材料","声音与文字","连续演出","语义时间与源时间","版本与修订"])assert.ok(template.includes(section),section);
  assert.doesNotMatch(template,/同款座位|翻翻票/);
});

test("Skills V5 源唯一、插件发行副本完整且可被 Codex 发现", async () => {
  const onDiskNames = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "_shared")
    .map((entry) => entry.name)
    .sort();
  const releasedNames = (await readdir(pluginSkillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "_shared")
    .map((entry) => entry.name)
    .sort();
  const manifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
  const mcp = JSON.parse(await readFile(pluginMcpPath, "utf8"));

  assert.deepEqual(onDiskNames, [...expectedSkills].sort());
  assert.deepEqual(releasedNames, [...expectedSkills].sort());
  assert.equal(manifest.name, "videoflowcut");
  assert.equal(manifest.skills, "./skills/", "插件必须显式发布 Skills 目录");
  assert.equal(manifest.mcpServers, "./.mcp.json", "插件必须通过自身 MCP 配置暴露工具");
  assert.equal(mcp.mcpServers?.videoflowcut?.args?.[0], "./scripts/mcp-launcher.mjs", "插件 MCP 必须经统一运行器启动");
  assert.equal(await exists(join(skillsRoot, "_shared", "CURRENT_CAPABILITIES.md")), false, "运行时不得依赖 CURRENT_CAPABILITIES 快照");
  assert.equal(await exists(join(skillsRoot, "production-coordinator/references/project-writes.md")), true);
  assert.equal(await exists(join(skillsRoot, "visual-asset-sourcing", "references", "source-review.md")), true);
  assert.equal(await hasTrackedNestedExecutableSkills(), false, "docs 中不得保留第二棵可执行 .agents/skills");

  const allSkillFiles = await markdownFiles(skillsRoot);
  for (const name of expectedSkills) {
    const skillPath = join(skillsRoot, name, "SKILL.md");
    const skill = await readFile(skillPath, "utf8");
    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(skill);
    assert.ok(frontMatter, `${name} 缺少 YAML Front Matter`);
    assert.match(frontMatter![1], new RegExp(`^name:\\s*${name}$`, "mu"), `${name} 的 name 必须与目录一致`);
    assert.match(frontMatter![1], /^description:\s*\S+/mu, `${name} 缺少 description`);
    assert.match(skill, /返回|交回|交接|结果|交付|恢复|读取/u, `${name} 缺少正常工作结果`);
    assert.equal(
      await readFile(join(pluginSkillsRoot, name, "SKILL.md"), "utf8"),
      skill,
      `插件发行副本与根 Skills 源漂移：${name}`
    );
  }

  for (const markdownPath of allSkillFiles) {
    const markdown = await readFile(markdownPath, "utf8");
    assert.doesNotMatch(markdown, /CURRENT_CAPABILITIES/u, `${markdownPath} 不得读取手工能力快照`);
    for (const reference of localMarkdownLinks(markdown)) {
      const resolved = resolve(dirname(markdownPath), reference);
      assert.equal(await exists(resolved), true, `${markdownPath} 引用了不存在的资料：${reference}`);
    }
    const releasedPath = join(pluginSkillsRoot, relative(skillsRoot, markdownPath));
    assert.equal(await exists(releasedPath), true, `插件发行副本缺少共享资料：${relative(skillsRoot, markdownPath)}`);
    assert.equal(await readFile(releasedPath, "utf8"), markdown, `插件发行副本与根 Skills 源漂移：${relative(skillsRoot, markdownPath)}`);
  }
});

test("导演只选一条主流程，专项与同一交接约定连通",async()=>{
  const director=await readFile(join(skillsRoot,"production-director/SKILL.md"),"utf8");
  assert.match(director,/只按实际任务选择一个主要业务入口/);
  for(const workflow of primaryWorkflows)assert.ok(director.includes(`${workflow}/SKILL.md`));
  for(const role of creativeSpecialists){
    const reached=await reachableMarkdown(join(skillsRoot,role,"SKILL.md"));
    assert.ok(reached.has(resolve(skillsRoot,"_shared/PROJECT_REVISION_AND_HANDOFF.md")),role);
  }
});

test("协调入口可到达全部创意角色与共享合同，机械操作保留主任务短路径", async () => {
  const coordinatorPath = join(skillsRoot, "production-coordinator", "SKILL.md");
  const reachable = await reachableMarkdown(coordinatorPath);
  for (const name of ["project-basics", "production-director", ...primaryWorkflows, ...creativeSpecialists, "quality-verification", "export"]) {
    assert.ok(reachable.has(resolve(skillsRoot, name, "SKILL.md")), `协调入口无法到达 ${name}`);
  }
  const sharedContract = resolve(skillsRoot, "_shared/PROJECT_REVISION_AND_HANDOFF.md");
  for (const name of ["production-coordinator", "production-director", ...primaryWorkflows, ...creativeSpecialists, "quality-verification"]) {
    const reached = await reachableMarkdown(join(skillsRoot, name, "SKILL.md"));
    assert.ok(reached.has(sharedContract), `${name} 无法读取同一份代理交接合同`);
  }
  const coordinator = await readSkill("production-coordinator");
  assert.match(coordinator, /spawn_agent/u, "协调入口必须真实分派宿主子代理");
  assert.match(coordinator, /followup_task/u, "实际预览必须能够回到原负责人继续修订");
  assert.match(coordinator, /完整参数的机械修改可直接执行/u, "明确参数修改应有无需创意分派的短路径");
  assert.match(coordinator, /尚无 Project\/Revision/u, "空项目不能为了分派构造版本");
  for (const name of ["asset-import", "transcription", "export", "web-editor-operator"]) {
    const skill = await readSkill(name);
    assert.match(skill, /主任务/u, `${name} 应保留确定性执行或证据获取职责`);
    assert.match(skill, /子代理/u, `${name} 中的专业判断应明确交接`);
  }
});

test("正式提交与专业判断分工在唯一交接中维护",async()=>{
  const handoff=await readFile(join(skillsRoot,"_shared/PROJECT_REVISION_AND_HANDOFF.md"),"utf8");
  const writes=await readFile(join(skillsRoot,"production-coordinator/references/project-writes.md"),"utf8");
  assert.match(handoff,/不递归分派/);
  assert.match(handoff,/不能只换 `?base_revision_id`? 重发旧产物/);
  assert.match(handoff,/技术核验归主任务[\s\S]*审美归子代理/);
  assert.match(writes,/不能认证真实宿主调用/);
  assert.match(writes,/异步 Job[\s\S]*终态[\s\S]*Revision/);
  assert.match(await readSkill("quality-verification"),/inconclusive/);
});

test("宿主满额恢复有现有负责人接替路径，不依赖虚构名额回收", async () => {
  const coordinator = await readSkill("production-coordinator");
  const handoffPath = resolve(skillsRoot, "_shared/PROJECT_REVISION_AND_HANDOFF.md");
  const handoff = await readFile(handoffPath, "utf8");
  const routingPath = resolve(skillsRoot, "production-coordinator/references/task-routing.md");
  const routing = await readFile(routingPath, "utf8");
  assert.match(coordinator, /list_agents[\s\S]*上限是否包含主任务/u, "分派前须使用实际宿主范围核对名额");
  assert.match(coordinator, /completed[^\n]*不证明[^\n]*释放/u, "完成一轮不能冒充关闭线程");
  assert.match(coordinator, /interrupt_agent[^\n]*不[用把][^\n]*名额/u, "中断不能当作释放名额");
  assert.match(coordinator, /原负责人仍在列表且空闲[\s\S]*followup_task/u);
  assert.match(coordinator, /名额已满[\s\S]*现有、职责合适[\s\S]*只等待这一项依赖/u, "满额须复用现有负责人或等相关工作，不能再创建");
  assert.match(coordinator, /列表未满仍被拒绝[\s\S]*调用前后列表[\s\S]*原始错误/u, "不能把宿主异常误判为正常满额");
  assert.match(handoff, /task-routing\.md#负责人接替与结果接收/u);
  assert.ok((await reachableMarkdown(handoffPath)).has(routingPath));
  assert.match(routing, /接任者先确认输入版本与范围[\s\S]*交接未确认不算/u);
  assert.match(routing, /旧负责人迟到回复[\s\S]*历史材料[\s\S]*当前负责人重新判断/u, "接替后不得直接采用迟到结果");
  assert.ok((await reachableMarkdown(join(skillsRoot, "production-coordinator/SKILL.md"))).has(handoffPath));
});

test("子代理工具缺失使用可追溯事实交接，实际访问和交接结果分别验收", async () => {
  const coordinator = await readSkill("production-coordinator");
  const handoff = await readFile(join(skillsRoot, "_shared/PROJECT_REVISION_AND_HANDOFF.md"), "utf8");
  const routing = await readFile(join(skillsRoot, "production-coordinator/references/task-routing.md"), "utf8");
  const mcp = await operationKnowledge();
  assert.match(coordinator, /首次分派和续接后[\s\S]*本轮实际工具表/u);
  assert.match(handoff, /task-routing\.md#事实交接与能力核验/u);
  assert.match(routing, /工具不可见、Schema 不匹配、调用失败、结果已返回但材料不足/u, "故障阶段必须可区分");
  assert.match(routing, /读取工具、读取时的 Project\/Revision 及原始结果引用/u);
  for (const required of ["完整源码/Props/参数", "可访问路径", "实时 MCP Schema", "Impact"]) {
    assert.ok((handoff + coordinator).includes(required), `事实交接缺少 ${required}`);
  }
  assert.match(coordinator, /请求应说明对象、版本、范围和缺失项/u);
  assert.match(coordinator, /主任务记录实际工具缺口[\s\S]*正式只读 MCP[\s\S]*专业判断仍由原代理/u, "补事实不能回退为主任务创作");
  assert.match(coordinator, /需要观看的预览、帧或音频必须由接收者实际打开/u);
  assert.match(mcp, /主任务转交 Schema 不等于子代理工具可调用/u);
  assert.match(mcp, /主任务成功交接、子代理直接 MCP 访问恢复是两个结论/u);
  assert.match(routing, /新读取发现版本变化[\s\S]*接收者确认[\s\S]*不只替换包内版本号/u);
});

test("Presenter Skill 的概要、Gate A 与示范路线都先编译 Scene 再登记人物", async () => {
  const skill = await readSkill("presenter-motion-director");
  // 与 core.test.ts 的实际调用回归配对，防止示范路线再次引导到 ACTOR_SCENE_REQUIRED。
  assert.match(skill, /先读回 Project，确认目标 A-roll Item 已归属 PresenterScene/u, "人物登记前先确认真实 Scene 归属");
  const sceneSection = skill.indexOf("### Story 与 PresenterScene");
  const actorSection = skill.indexOf("### 人物表演");
  assert.ok(sceneSection >= 0 && actorSection > sceneSection, "Gate A 应先建立 Scene，再登记人物表演");
  const example = skill.slice(skill.indexOf("## 从空项目到交付的示范路线"));
  assert.match(example, /→ assemble_presenter_track\s+→ compile_presenter_scenes\s+→ manage_actor_performance/u);
});

test("Skill 中的 MCP 名称、输入字段和工具状态与代码一致", async () => {
  const mcpSource = (await Promise.all([mcpSourcePath, ...["motion-tools", "motion-library-tools", "media-intelligence-tools", "sound-tools", "source-research-tools", "media-search-tool"].map((name) => join(repositoryRoot, `apps/server/src/${name}.ts`))].map((path) => readFile(path, "utf8")))).join("\n");
  const currentTools = registeredToolNames(mcpSource);
  const contract = await operationKnowledge();

  const unknownTools = new Set<string>();
  for (const name of expectedSkills) {
    const skill = await readSkill(name);
    for (const token of toolTokens(skill)) {
      if (!currentTools.has(token) && !architectureTargets.has(token) && !compatibilityOnlyTools.has(token) && !hostCollaborationTools.has(token)) unknownTools.add(token);
    }
  }
  assert.deepEqual([...unknownTools], [], `Skill 引用了未分类 MCP 工具：${[...unknownTools].join(", ")}`);

  for (const hostTool of hostCollaborationTools) {
    assert.equal(currentTools.has(hostTool), false, `${hostTool} 必须由真实宿主提供`);
    assert.ok(contract.includes("`" + hostTool + "`"), `调用合同遗漏宿主工具边界：${hostTool}`);
  }

  for (const target of architectureTargets) {
    assert.equal(currentTools.has(target), false, `${target} 已进入 MCP 时必须先更新分类`);
    assert.match(contract, new RegExp("`" + target + "`"), `调用合同遗漏架构目标 ${target}`);
  }
  for (const tool of currentSkillTools) {
    assert.equal(currentTools.has(tool), true, `${tool} 已被 Skill 使用，MCP 不得缺失或被误写为架构目标`);
    assert.match(contract, new RegExp("`" + tool + "(?:`|\\()"), `调用合同遗漏当前工具 ${tool}`);
  }
  assert.equal(currentTools.has("create_presenter_timeline"), true);
  assert.match(contract, /兼容入口，不作为正式主链/u);

  const requiredInputs: Record<string, string[]> = {
    submit_motion_work: ["base_revision_id", "idempotency_key", "work"],
    inspect_motion_reference: ["source_url", "preview_index"],
    read_motion_work: ["job_id"],
    review_motion_work: ["asset_id", "outcome", "evidence", "reference_match", "note"],
    import_media: ["base_revision_id", "file_path"],
    inspect_asset: ["asset_id", "mode"],
    manage_asset_requirements: ["base_revision_id", "action"],
    search_media_candidates: ["base_revision_id", "asset_request_id", "provider", "query"],
    inspect_media_candidate: ["asset_candidate_id"],
    acquire_media_asset: ["base_revision_id", "asset_candidate_id"],
    read_asset_provenance: ["asset_id"],
    apply_manual_transcript: ["base_revision_id", "asset_id", "text"],
    apply_semantic_units: ["base_revision_id", "units"],
    apply_script: ["base_revision_id", "semantic_unit_ids"],
    manage_story: ["base_revision_id", "beats"],
    manage_voice_references: ["base_revision_id", "asset_id"],
    edit_captions: ["base_revision_id", "caption_id", "caption_ids", "action", "display", "format"],
      manage_audio: ["base_revision_id", "action", "event_frame", "onset_offset_frames", "source_start_frame", "source_end_frame", "effect_event"],
      browse_sound_sources: [],
    browse_local_sound_effects: ["query", "max_results"],
    inspect_local_sound_effect: ["root_id", "relative_path"],
    import_local_sound_effect: ["base_revision_id", "root_id", "relative_path"],
    assemble_presenter_track: ["base_revision_id", "asset_ids"],
    compile_presenter_scenes: ["base_revision_id", "scenes"],
    manage_actor_performance: ["base_revision_id", "timeline_item_id", "source", "mask_mode"],
    create_scene: ["base_revision_id", "type", "title", "purpose", "start_frame", "end_frame"],
    manage_visual_treatment: ["base_revision_id", "action"],
    manage_cutaways: ["base_revision_id", "action"],
    replace_scene_asset: ["base_revision_id", "cutaway_id", "asset_id", "source_start_frame", "source_end_frame"],
    manage_effect_cues: ["base_revision_id", "action", "cue_id", "scene_id", "type", "layer", "start_frame", "end_frame", "semantic_anchor", "covered_narrative_beat_ids", "motion", "quality_rules"],
    render_preview_range: ["revision", "from_frame", "to_frame"],
    inspect_composed_frames: ["preview_job_id"],
    record_editorial_quality_review: ["run_id", "revision", "passes", "preview_evidence", "findings"],
    record_creative_decision: ["run_id", "category", "decision", "rationale", "object_ids", "evidence", "delegation", "agent_id", "assignment_id", "role", "input_revision"],
    run_render_preflight: ["revision"],
    submit_export: ["revision", "purpose"],
    track_export: ["job_id"],
    read_export_artifact: ["artifact_id"],
    record_export_artifact_review: ["artifact_id", "passes", "evidence", "findings"],
    approve_export_artifact: ["artifact_id"]
  };

  for (const [tool, fields] of Object.entries(requiredInputs)) {
    const block = toolSourceBlock(mcpSource, tool);
    assert.match(contract, new RegExp("`" + tool), `调用合同遗漏当前工具 ${tool}`);
    for (const field of fields) {
      assert.match(block, new RegExp(`\\b${field}:`), `${tool} 的 MCP Schema 缺少字段 ${field}`);
      // 字段由实时 Schema 提供；技能保留操作语义，不重复维护参数全集。
    }
  }

  // 交付闭环已进入当前 MCP：预检、读取 Artifact、成片复核和批准必须是独立步骤，
  // 不能再把 Export Job succeeded 当成用户批准。
  for (const tool of ["run_render_preflight", "track_export", "read_export_artifact", "record_export_artifact_review", "approve_export_artifact"]) {
    assert.equal(currentTools.has(tool), true, `MCP 缺少交付闭环工具：${tool}`);
  }
});

test("声音待审与合成帧批量上限在剪辑工具和 Skill 中可发现", async () => {
  const mcpSource = await readFile(mcpSourcePath, "utf8");
  const audioTool = toolSourceBlock(mcpSource, "manage_audio");
  assert.match(audioTool, /允许草稿混合但阻挡交付/u);
  for (const name of ["audio-finishing", "sound-asset-sourcing"]) {
    const skill = await readSkill(name);
    assert.doesNotMatch(skill, /adopt_media_fragment|bind_media_adoption|SOUND_ADOPTION_REQUIRED/u);
    assert.match(skill, /soundPlanId、soundIntentId、planVersion/u);
    assert.match(skill, /不建立素材资格|不先创建采用资格/u);
  }
  const frameTool = toolSourceBlock(mcpSource, "inspect_composed_frames");
  assert.match(frameTool, /\.max\(12\)/u);
  assert.match(await readSkill("quality-verification"), /每次最多 12 帧/u);
  assert.match(await readSkill("known-errors"), /结束活动轮再续办不保证刷新/u);
});

test("重复帧诊断的 Skill 交接保留证据与剪辑报障边界", async () => {
  const skill = await readSkill("known-errors");
  assert.match(skill, /track_job.result.motionDiagnostics/u);
  assert.match(skill, /differences\[\]\.paths/u);
  assert.match(skill, /最多两个色阶/u);
  assert.match(skill, /缓存文件完整性仍要求哈希完全一致/u);
  assert.match(skill, /确认平台或服务自身 Bug 且无法继续才提交独立 Repair Ticket/u);
});

test("当前 Scene Registry 与 Skill 的可创建类型说明一致", async () => {
  const mcpSource = await readFile(mcpSourcePath, "utf8");
  const expected = [...currentSceneTypes].sort();

  // 读取入口和写入入口必须列出同一组 Scene，避免 Skill 基于过期类型生成请求。
  assert.deepEqual(sceneTypesInTool(toolSourceBlock(mcpSource, "browse_scene_types")), expected);
  assert.deepEqual(sceneTypesInTool(toolSourceBlock(mcpSource, "create_scene")), expected);

  const presenter = await readSkill("presenter-motion-director");
  const scenePlanning = await readSkill("scene-planning");
  assert.doesNotMatch(presenter, /UI\/DocumentScene/u, "Presenter 不得把 UI/DocumentScene 当成现有类型");
  assert.match(presenter, /`ExplainerScene` 或 `CutawayScene`/u);
  assert.match(scenePlanning, /`DocumentScene` 与 `UIShowcaseScene`[^\n]*不是当前 MCP 可创建类型/u);
  assert.doesNotMatch(scenePlanning, /^- (?:DocumentScene|UIShowcaseScene)：/mu, "Scene 类型列表不得出现尚未实现的可创建类型");
});

test("活动脚本与测试不再引用已删除的旧共享合同", async () => {
  const activeFiles = [
    join(repositoryRoot, "scripts", "presenter-stage1-live.e2e.ts"),
    join(repositoryRoot, "scripts", "presenter-creative-agent.eval.ts"),
    join(repositoryRoot, "tests", "core.test.ts")
  ];
  const legacySharedPattern = /_shared\/(editorial-principles|mcp-and-project-contract|decision-record|timing-precision|quality-vocabulary|skill-execution-report|source-map)\.md/u;
  for (const filePath of activeFiles) {
    assert.doesNotMatch(await readFile(filePath, "utf8"), legacySharedPattern, `${filePath} 仍引用已删除的旧共享合同`);
  }
});


test("用户选定六项案例从两条正常入口可达，固定版本素材与源码完整发布", async () => {
  const caseNames = ["sim-paper", "smooth-relay", "ticket-phone", "product-fan", "cover-flow", "comment-focus"];
  // 正常入口必须指向原创专项，不能靠测试直接加载教学案例冒充路由。
  for (const workflow of ["presenter-motion-director", "visual-explainer-director"]) {
    const reached = await reachableMarkdown(join(skillsRoot, workflow, "SKILL.md"));
    for (const name of caseNames) assert.ok(reached.has(resolve(skillsRoot, `motion-case-library/references/cases/motion-case-${name}/CASE.md`)), `${workflow} 无法到达 ${name}`);
  }
  for (const name of caseNames) {
    const folder = `motion-case-library/references/cases/motion-case-${name}`;
    const fixture = JSON.parse(await readFile(join(skillsRoot, folder, "assets/fixture.json"), "utf8"));
    const assets = await readdir(join(skillsRoot, folder, "assets"));
    assert.equal(fixture.caseId, name);
    assert.equal(fixture.selectedByUser, true);
    assert.ok(assets.includes("fixture.json") && assets.includes(fixture.preview));
    assert.ok(fixture.sourceFiles.length > 0);
    for (const source of fixture.sourceFiles) assert.ok(assets.includes(source), `${folder} 缺少源码 ${source}`);
    const integrity = JSON.parse(await readFile(join(skillsRoot, folder, "assets/integrity.json"), "utf8"));
    const frames = assets.filter(file => /^preview-\d+\.png$/u.test(file));
    assert.equal(frames.length, fixture.reviewFrames.length);
    assert.ok(frames.length > 0);
    for (const file of frames) assert.ok(fixture.reviewFrames.includes(Number(/\d+/u.exec(file)![0])));
    for (const file of assets) {
      const source = await readFile(join(skillsRoot, folder, "assets", file));
      assert.ok(source.length > 0);
      if (file !== "integrity.json") {
        assert.equal(createHash("sha256").update(source).digest("hex"), integrity.files[file], `${folder}/${file} 不再对应归档版本`);
      }
      assert.deepEqual(await readFile(join(pluginSkillsRoot, folder, "assets", file)), source, `${folder}/${file} 字节漂移`);
    }
    assert.deepEqual(Object.keys(integrity.files).sort(), assets.filter(file => file !== "integrity.json").sort());
  }
});
