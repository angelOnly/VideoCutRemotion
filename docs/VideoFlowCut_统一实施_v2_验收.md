# VideoFlowCut 统一实施 v2：开发与验收记录

日期：2026年10月8日。实施依据为 `VideoFlowCut_统一实施包_v2/`，工作树基线为 `939ddd17882dfe3b08128bf4cd3d1dc3b14ec849`，与实施包一致。

## 实现范围

已按清单合入 F01—F17，共17个现有文件、22处修改。写入前全部核验片段 SHA-256 和唯一锚点；范围外35段原文与基线比对一致。F05原有前文和第2—10节、F07四字／手机／镜片／数学教学、历史案例原件及正式写入合同保留。F09为合并后的完整模板，含完整填写示范；F17替换旧关键词使用说明。

唯一可编辑 Skill 源仍为 `.agents/skills/`，对应17份发行副本已通过 `plugin:sync-skills` 同步到 `plugins/videoflowcut/skills/`。没有新增检索代理、模型服务、向量数据库或第二套索引。

## 修改文件

实施包列出的源文件：

- `.agents/skills/_shared/EDITORIAL_FOUNDATIONS.md`
- `.agents/skills/_shared/TOPIC_TO_FILM.md`
- `.agents/skills/production-director/SKILL.md`
- `.agents/skills/production-coordinator/SKILL.md`
- `.agents/skills/narration-writing/SKILL.md`
- `.agents/skills/narration-writing/references/writing-methods.md`
- `.agents/skills/visual-treatment-planning/SKILL.md`
- `.agents/skills/remotion-production/references/scene-art-and-motion.md`
- `.agents/skills/motion-brief-writing/SKILL.md`
- `.agents/skills/motion-brief-writing/references/execution-brief-template.md`
- `.agents/skills/effect-timing/SKILL.md`
- `.agents/skills/visual-asset-sourcing/SKILL.md`
- `.agents/skills/quality-verification/SKILL.md`
- `.agents/skills/visual-explainer-director/SKILL.md`
- `.agents/skills/remotion-production/SKILL.md`
- `.agents/skills/motion-case-library/SKILL.md`
- `.agents/skills/motion-case-library/references/skillry-retrieval.md`

新增 `references/motion-cases/skillry/tools/read-case-cards.mjs` 与 `tests/motion-reference-cards.test.mjs`。加载器沿用包内接口，补充严格UTF-8、记录字段、空源片段、编号与分页互斥，以及不存在的媒体文件所在目录链接的边界检查；注释、错误说明和测试名称改为中文。

更新 `references/motion-cases/skillry/README.md`，清除“Skill与网页都使用关键词搜索”的旧说明。更新 `scripts/check-topic-film-skills.mjs` 和 `tests/skills-v5-integration.test.ts`，覆盖各角色到语义说明和完整演出稿的实际链接；模板验收改为v2结构并保留内容与证据边界检查。

`package.json` 新增 `test:motion-reference`，默认 `test` 纳入 `.test.mjs` 文件，避免新测试仅能手动运行。没有修改MCP Schema或权限配置。

## 主要调用链

当前授权作者接收完整自然语言问题 → 读取 `motion-case-library` 与语义方法 → 从唯一 `case-catalogue.json` 读取全库卡片 → 模型比较表现关系和硬条件 → 深读入围 `analysis.md` 与必要媒体范围 → 导演／原作者采用具体关系并回写当前完整稿。

加载器内部是 `main → loadCards → selectCards → JSON`。默认索引相对脚本位置定位，支持分页或准确编号查询。返回索引哈希、总数、路径基准、卡片和分页游标；保持原字段、顺序与文本，不调用模型、不读取视频字节、不写文件。原 `search.mjs`、关键词CLI与网页行为保持。

## 失败处理与代价

非法参数、重复或未知编号、损坏索引、非法源范围、路径越界会明确失败，命令行退出码为1、错误写入标准错误，不输出半份JSON。不静默略过坏条目或放宽条件。无库、无权限、覆盖未完成或没有直接匹配时，Skill保留缺口并继续允许独立创作；不将参考文件存在或拆解阅读提升为连续视听通过。

每次开放式问题需要模型阅读当前完整卡片集合，增加上下文和比较开销；同任务复用已有候选，按索引哈希识别变化。加载器本身不保证语义准确率，静态网页没有新增聊天式语义搜索。

## 实际验证

| 验证 | 本次结果 |
|---|---|
| `npm run test:motion-reference` | 21/21通过，含构造数据、真实库分页与120条实际视频哈希 |
| `npx tsx --test tests/skills-v5-integration.test.ts tests/topic-film-skills.test.ts tests/creative-delegation.test.ts` | 25/25通过 |
| `node scripts/check-topic-film-skills.mjs` | 1227/1227静态合同检查通过 |
| `npm run plugin:sync-skills` | 仓库内发行副本同步完成 |
| `npm run plugin:verify` | Skills、现有发行Runtime、manifest及MCP入口校验通过 |
| `npm run typecheck` | 通过 |
| 修改范围外原文核对 | 35段保持，含F05与F07保护范围 |
| 差异空白检查 | 按Windows CRLF行尾规则通过 |

首轮集成测试有一项依赖旧模板标题，已按v2结构更新并复测通过。未运行全仓测试、真实视频制作、连续视听审片或多轮模型语义评测；同义改写、跨题迁移、硬条件、无匹配、实际采用及四组角色创作实验仍属于实施稿第4节的后续行为验收，不能以本表的静态和代码测试代替。

本轮完成仓库开发与发行副本同步，没有发布新Runtime、覆盖已安装插件缓存或切换生产服务，没有改动正式视频项目。仓库修改尚未提交Git；实施包及其他原有未跟踪文件保留。
