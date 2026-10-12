# 当前时间线操作与依赖

## 从 Script 到 NarrativeMap 的实际方法

已有采用稿时，辨认主张、观察、解释、证据和它们的依赖，再把共同完成一次理解或体验的内容组成段落。尚无稿件或草稿允许实质优化时，先由 narration-writing 形成完整解说与初步声画，材料探索可同步推进。NarrativeMap 保存采用后的观看关系，不替代完整解说正文和声画稿；不能按句号切分，也不能把画面先固定成组件后再让台词填空。

总导演随后选择各段主要对象、观察尺度和具体变化，写出入口画面、内部推进、出口留下的结果以及怎样接下一段。缺少材料时提出事实核实、网页与实拍获取、生成或原创动效需求；取得候选并审阅后，核对是否完成原定作用，再修订分镜或主线。动效专项细化这些决定，不从一句目标重新发明整段；语法名称不能直接锁定组件。

主线尚在形成时由导演提出关键问题，交 [素材专项](../../visual-asset-sourcing/SKILL.md) 探索；形成分镜后再按本镜要求精确补齐。候选中出现更清楚或更有表现力的过程，导演实际查看后可修改讲述和信息出现顺序。专项收到的是采用版本与真实范围，不能继续沿用已被替换的原分镜。

例如一段旁白：

> 平台并不是直接把广告费全部给创作者。广告主先付给平台，平台扣除分成，再按照播放和规则结算给创作者。

它不是三张卡。可以是一个 RouteAndFlow Scene：广告主、平台、创作者三个对象持续存在，资金路径先到平台，抽成分支出现，最后结算到创作者。官方规则在观众需要核对该比例或条件时进入：可以保持资金关系图作为参照，把真实原文放大到可读范围；也可以从真实规则页面引出图形解释，再回到原文确认限定。是否独立成段取决于阅读负荷与主线，不因它属于证据而强制另建画面。原文、解释性图形与推断分别可辨，比例、条件和结算方式不能超出实际来源。

## Scene 计划表

计划同时记录前后段入口/出口状态、共享对象、硬约束与允许调整的候选设计；它不是新增数据库字段要求。

每个 Scene 建议记录：

```text
scene purpose
entering knowledge / current question
primary visual object
persistent objects
progressive states
settled conclusion
voice range
caption role
asset/evidence requirements
audio role
exit and next-scene bridge
validation
```

这不是数据库字段要求，而是保证 Scene 能被主工作流、Remotion 和质量共同理解。

## Gate C：质量和交付

场景级 Preview检查 Entry、内部推进、Settled、阅读和 Exit；整片静音看是否能理解视觉逻辑，完整声画看旁白与视觉是否互补而非重复，首次观众看是否知道当前在解释哪个问题。证据、数据、来源和生成标记也必须通过。

质量问题应退回具体 Scene、证据、字幕、声音或 NarrativeMap。正式 delivery 遵循 `quality-verification` 与 `export`。

## 交接合同

原创交接必须带模型取舍、关键状态、固定作品版本、多 Beat 覆盖、命名事件帧与真实合成证据。代表段成立后继续全片，并用换题检查是否只是换标题。

本主工作流接收各专项结果并负责最终认知连续。完成时 NarrativeMap 与实际分镜对应，各 Scene 的观看过程和解释、证据、现实分工清楚；主声音、画内文字与字幕在完整合成中各有作用。记录真实 Preview、已观察范围、修订与未知，五轮按需提供专业观察，不以 AI 审美通过控制导出；技术与用途按当前合同核验，最终用户批准绑定目标 Revision 的具体 Artifact。

## 当前调用与读回：Explainer NarrativeMap

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| Explainer NarrativeMap | `manage_narrative_map(base_revision_id, viewer_question, promised_model, conclusion, beats)`；`read_narrative_map(project_id?)` | NarrativeMap 映射既有 Story Beat 的观众知识、问题与延迟披露；写入会让依赖的 Explainer Program 失效，写后读回对象、Revision、Impact 与 Preview。 |
