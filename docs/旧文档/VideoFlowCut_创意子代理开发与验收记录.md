# VideoFlowCut 创意子代理开发与验收记录

日期：2026-09-14。

依据用户批准的[落地方案](./VideoFlowCut_创意子代理分工与落地方案_待审阅.md)完成第一版代码与工作流修改。工程回归、候选发行检查和实际子代理交接已执行；真实合成中发现的独立动效计时缺陷也已修复。本文只将取得证据的项目标为通过，不把静帧审阅称为完整动态审片或成片交付通过。

## 1. 已实现的调用链

```text
主任务：project-basics → production-coordinator
  → 宿主 spawn_agent 启动导演
  → 导演：production-director → 选择一个主要视频工作流
  → 导演提出当前专项范围，主任务真实分派专项子代理
  → 专项返回输入 Revision、完整产物、参数和证据请求
  → 主任务核对事实、按实时 MCP Schema 提交
  → 等待 Job 终态，读回对象、Revision 和失效范围
  → 宿主 followup_task 将真实作品、合成及版本交回原专项
  → 专项修订；跨段冲突交导演；专业审片交审片子代理
  → 主任务保存审计、完成技术检查及允许范围内的交付
```

完整视频的导演判断运行在子代理中。局部字幕、声音、B-roll、Remotion 等创意可以直接分派专项。已经明确全部参数的机械操作由主任务执行。一个子代理可使用多个相关 Skill，不递归分派、不按案例数量建代理。

主任务统一排序正式项目写入，包括异步生成、渲染、审计和质量记录；它可以回填真实对象 ID，不能补做遗漏的创意。发生版本变化时回传差异给原负责人确认，不直接换版本重放旧产物。

## 2. 修改范围

| 位置 | 实际变化 |
|---|---|
| `AGENTS.md` | 明确协调者、导演、专项与审片执行位置，以及统一提交、真实分派、防递归和失败返回 |
| `.agents/skills/production-coordinator/SKILL.md` | 新增主任务协调入口、完整/局部/机械路由与真实交接闭环 |
| `project-basics`、导演及三个主要工作流、创意专项、质量、客观准备和共享合同 | 调整入口、角色与交接段落，保留原专业知识与案例 |
| `known-errors` | 补充协调者只读对账、创意重判断回原子代理、平台恢复遵循 Repair Ticket 的入口约束 |
| `packages/contracts/src/index.ts` | `CreativeDecision` 增加可选 `CreativeDelegation` |
| `packages/edit-application/src/index.ts` | 校验与保存委派来源，复用原 ProductionRun 审计存储 |
| `apps/server/src/mcp.ts` | `record_creative_decision` 接收可选 `delegation`，映射到内部合同 |
| `packages/edit-domain/src/index.ts` | 修复独立可渲染 Cue 未参与时间线计时的问题 |
| `tests/creative-delegation.test.ts` | 新增五项审计及真实 MCP Schema 回归 |
| `tests/skills-v5-integration.test.ts` | 覆盖协调入口可达、职责、真实分派说明、完整产物及版本/证据交接 |
| `tests/managed-motion.test.ts` | 新增独立动效计时、预览边界、失效/删除与历史版本回归 |
| `scripts/creative-delegation.e2e.ts`、`package.json` | 增加隔离候选实测入口，执行与保存真实 MCP 轨迹 |
| 插件 manifest、`plugins/videoflowcut/skills/`、`runtime/dist/` | 从根 Skill 源同步并正常构建发行包；最终版本 0.1.24 |

根 `.agents/skills/` 仍是唯一可编辑运行时 Skill 源。插件副本通过现有同步脚本生成，未引入第二套调度服务、工作单模型调用引擎或身份权限系统。既有发现方式可找到新增目录，无需增加另一套路由配置。

开始实施前已保存相关文件基线。本次差异与工作区原有动效、声音等未提交改动分开核查，没有回退原有工作。未创建提交或 PR。

## 3. 委派审计合同

MCP 参数示例仅说明已实现字段，不代表一次真实分派：

```json
{
  "delegation": {
    "agent_id": "宿主返回的真实代理标识",
    "assignment_id": "本次分派的稳定标识",
    "role": "specialist",
    "input_revision": 1
  }
}
```

职责枚举为 `director`、`specialist`、`reviewer`。标识必须非空且不超过 160 字符；输入版本必须为安全正整数，且实际存在于本项目历史。保存的是子代理真实使用的输入版本，不自动替换成保存审计时的版本。产物和证据继续使用已有 `objectIds`、`evidence`。

字段可选，旧报告和没有委派信息的明确操作继续兼容。审计追加不创建视频 Revision，也不能解除审片或交付门禁。来源字段是自报追溯数据，不能认证宿主确实调用过代理；实际调用须同时核对本任务的宿主分派与续接记录。

## 4. 工程验收结果

| 验收项 | 结果及证据 |
|---|---|
| 最终全量测试 | **350 通过、0 失败、0 跳过**；约 95 秒，记录见 `full-tests-final.log` |
| 委派审计回归 | 历史输入保留、无 Revision 副作用、非法来源拒绝、本项目版本归属、旧报告兼容、并发追加和 MCP Schema 读写通过 |
| Skill 路由及发行同步 | 新协调入口可发现，三个主要工作流与创意专项可达，专业资料和插件副本一致 |
| 类型检查 | `npm run typecheck` 通过 |
| 发行构建与结构检查 | `plugin:build`、最终 `plugin:build-runtime`、`plugin:verify` 通过 |
| 差异检查 | `git diff --check` 通过 |
| 候选运行健康 | 实际候选 MCP 与 Runtime 的 Release ID 一致，API、媒体 Worker、渲染 Worker 健康 |

最终候选 Release ID：

```text
release-2b814915b30e74e52622a5689e1d41ef408ac198040bc3c23e46265e523755d3
```

构建仍有既有的 Web bundle 大于 500 KB 和 CJS `import.meta` 回退提示，本次构建与实际候选执行均通过。

证据目录：[本次验收资料](/E:/ai/VideoCut/.repair-validation/creative-delegation-20260914/)。

## 5. 真实子代理与候选样段

本次实际调用了以下宿主子代理，而不是把手写代理标识当作执行证据：

| 代理 | 实际工作与回传 |
|---|---|
| `/root/acceptance_director` | 给出六秒解释动效 Brief，选择 Explainer，建项后重新绑定真实 Project/R1 |
| `/root/acceptance_motion` | 返回完整创作说明、TSX、Props、时序和交接 JSON；多次绑定实际输入版本；观察 R7 合成后定位标题遮挡并交付完整 v2；继续接收 R11 合成 |
| `/root/workflow_review` | 独立审查代码和路由，发现并推动补齐旧错误恢复的入口约束 |
| `/root/acceptance_review` | 独立观察实际画面，复核技术修复及审阅证据边界 |

导演与专项决定的样段主题为“入库只是准备，入片要看用途”。作品为 768×1344、24 fps、144 帧；由文字、CSS、SVG 构成，不使用外部素材。主任务没有改写其创意或补写源码。

隔离项目：`project_6c2e8cdd-2b84-426f-ab4a-1d51bd44b2f5`。候选端口为 `51998`，工作区为独立的临时目录 `videocut-creative-delegation-z2mwRP`，没有使用生产数据库或 Worker 队列。

原作品 Job：`job_e06d7914-dc58-41c7-be20-102f285aeff0`；Asset：`asset_14eca80b-7034-4dd4-bd85-c477c53c0f6a`。主任务生成后回传原专项，专项亲自观察八个真实关键帧，以 `inconclusive` 登记证据不足，之后才进入待审合成。

首版 R7 合成 Job：`job_6c45ae43-3f1a-453c-bfbe-d7baa380f0b8`。专项随后通过实际逐帧证据发现遮挡并修订：R8 保存首版 failed，R9 生成 v2，R10 保存 v2 待审结论，R11 将同一 Cue 换绑为 v2 并实际合成。

第二版 Asset：`asset_bdd10ef8-0366-4477-a028-41c25ce6dcf7`；最终 R11 Preview Job：`job_b47cf46d-9167-4f7e-a0bd-3bba962b0213`。`ffprobe` 验证最终视频流恰好 6 秒、144 帧；合成器附带 AAC 静音轨，容器总时长约 6.059 秒。音量检测为约 -91 dB，属于技术检查，不冒充实际听审。

可查看[最终真实合成预览](/E:/ai/VideoCut/.repair-validation/creative-delegation-20260914/acceptance/composed-preview-final.mp4)、[候选上下文与对象](/E:/ai/VideoCut/.repair-validation/creative-delegation-20260914/acceptance/context.json)、[完整 v2 动效交接](/E:/ai/VideoCut/.repair-validation/creative-delegation-20260914/acceptance/motion-v2.json)、[独立流程复核](/E:/ai/VideoCut/.repair-validation/creative-delegation-20260914/acceptance/workflow-review.md)。首版作品、R7 合成与各轮审阅全部保留。原始 MCP 调用保存在同目录各阶段的 `trace.json`；它们证明候选调用，宿主分派事实另见本任务实际协作记录。

## 6. 验收发现与修复

第一处是验收驱动省略作品审阅，既有门禁正确拒绝了 Cue 放置。驱动已拆成生成、原专项审阅、合成阶段，不能先放置再补填通过记录。调用前保存 `attempted` 和参数，断连后标记 `unknown` 并停止，保留幂等键用于只读对账；合成阶段比较 Schema 归一后的完整作品输入，不能只检查源码。

第二处是平台计时缺陷：空项目中的 Scene 为 draft，原逻辑只统计有效 Item、ready Scene，以及挂在已停用 Program 下的 Cue，导致实际能渲染的独立动效不产生预览时长。R5 明确返回“局部预览范围无效”，没有创建 Preview Job。复现记录已通过 `report_editing_blocker` 保存到隔离 SQLite 的独立工单 `repair_ticket_5a927b5d-1482-486e-868f-a46292fbc302`；报障前后视频 Revision 都为 5。

用户要求遇到问题继续修复后，计时改为复用合成器的全部实际可达 Cue 集合。没有将 draft Scene 或待审作品提升为通过，也没有塞入占位视频或绕过预览范围校验。回归验证了创建、移动、审阅失败、恢复待审、失效、删除及旧版本不可变。升级隔离候选后，原专项确认已有版本变化，使用同一作品、Scene 与 Cue 完成 R7 真实合成；原 R5 历史快照保持不变。

第三处来自真实创意复核：首版移动引用在第 70–79 帧遮住“时间线”标题，约 0.42 秒。动效子代理补取逐帧证据后决定只把该标题移到右上方，保持文案、运动路径、事件帧及总时长；返回完整 v2 源码和参数。主任务保存其失败结论、取得新版本确认、生成新 Asset，再以同一 Cue 换绑并合成，没有自行修改创意源码。专项在第二版第 68–81 帧的实际作品证据中确认遮挡消除；独立审片子代理又从 R11 实际合成抽取这 14 帧逐一复核，确认修复，未见新的明确必须返工问题。

最终[独立复核报告](/E:/ai/VideoCut/.repair-validation/creative-delegation-20260914/acceptance/quality-review-final.md)及其来源审计、7 条 `frames` 观察和连续证据不足的 Finding，已通过实际 `record_creative_decision`、`record_editorial_quality_review` 保存。读回[质量报告](/E:/ai/VideoCut/.repair-validation/creative-delegation-20260914/acceptance/context.json.quality.json)仍保留 `MOTION_WORK_REVIEW_REQUIRED` 和 `EDITORIAL_MOTION` 阻断；质量与审计写入前后视频版本均为 R11，没有把工程验收成功升级为成片通过。

## 7. 失败处理、代价与验收边界

缺少完整产物时回原子代理补全；创意问题回专项，跨段问题回导演。上游或版本变化须重新确认受影响方案。未知写入只读对账，工具/Runtime 阻断保存独立工单；子代理不可用时不能退回主任务创作。证据不足保留待审。

工程测试和两版真实样段证明了委派审计、生成、回传、版本重确认、问题定位、原专项修订和实际合成链路。七种边界路由另做了独立前向推演；推演不等于全部情形都经过实际宿主故障注入。完整 Presenter/Explainer/Vlog 成片、所有专项创意效果、宿主完全不可用和真实传输中断，没有被本样段穷尽覆盖。

审阅者目前主要取得关键帧证据，因此专业连续动态审片仍保留 `inconclusive`；没有宣布五轮成片审片、delivery 导出或用户批准通过。预览可播放与技术合成成功不能代替这些结论。

第一版增加子代理调用、上下文转交与等待；正式写入串行。委派字段不提供身份强隔离。计时修复会在后续正常提交重算时，将原先遗漏但实际可渲染的 Cue 纳入时长，可能延长旧项目的可播放范围；不会重写历史 Revision。

本任务完成的是源码、Skill、回归与隔离候选验证。生产 Runtime 的正式切换和原剪辑任务重新连接确认尚未执行，不能仅凭插件目录版本或本记录宣称已部署。

## 8. 复跑入口

```powershell
npm run test:creative-delegation
npm run plugin:sync-skills
npm run typecheck
npm run plugin:build
npm run plugin:verify

# 使用新的上下文路径创建隔离候选项目；已有上下文会拒绝覆盖。
npm run test:creative-delegation-live -- prepare <context.json>
# 子代理绑定真实输入版本后返回完整作品。
npm run test:creative-delegation-live -- render <context.json> <motion.json>
# 回传真实作品，取得子代理审阅及完整合成交接后继续。
npm run test:creative-delegation-live -- compose <context.json> <compose.json>
```

中断时使用 `inspect` 只读对账；`review` 保存子代理对实际作品的结论，`audit` 保存委派来源及子代理提供的局部质量记录，`blocker` 保存实际阻断。候选升级使用 `upgrade` 显式提供前后 Release ID 与原因，不静默改发行物。该驱动只操作自己创建的临时工作区，不能拿来执行正式视频项目。
