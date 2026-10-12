# 当前时间线操作与依赖

## 当前能力边界

当前 MCP 已实现 `submit_vlog_analysis`、`read_vlog_plan`、`manage_vlog_events`、`manage_vlog_shot_selects`、`compile_vlog_montage` 和 `manage_vlog_music_beats`。它们能把已完成媒体分析的素材转换为技术 Shot Boundary、由导演确认的 Event Map/Shot Select，以及 Background 与 Ambient 轨上的 Montage；写入后应读回计划、Revision、Impact 和 Preview。

这不是自动事件理解或自动选片：Shot Boundary 只提供源范围、变化分数和音轨事实；Event、Select、源声保留和 Montage 顺序仍由主工作流根据真实审阅决定。上述 MCP 合同已经有确定性测试，但真实素材中的事件理解、复杂节奏、现场声连续和完整审美仍须通过 `inspect_asset`、连续 Preview 与五轮审片验证。无法以当前素材兑现判断时，输出清楚的 Event/Shot Plan 和能力缺口，不把计划写成成片。

## 当前项目对象如何承载 Vlog 计划

当前 Revision 已有 Shot Analysis、VlogEvent、VlogShotSelect、VlogMusicBeat、VlogMontageScene、TimelineItem 和 ProductionRun。`submit_vlog_analysis` 先形成技术边界证据；主工作流使用 `manage_vlog_events` 和 `manage_vlog_shot_selects` 明确事件与选择；`compile_vlog_montage` 才把已确认 Select 写入 Timeline。应明确哪些是源证据、哪些已进入 Timeline，并在每次写入后读回；不要让临时文本成为第二份 Timeline，也不要把技术边界误写成导演事件。

## 与主要专项的交接

- narration-writing：仅在需要新增或获准改写解说时使用，负责相应旁白与声画配合；实拍事件、真实对话和原声继续决定本片观看顺序，不为调用写作 Skill 强行增加旁白。

- `asset-import`：完整媒体和来源；
- `semantic-continuity`：真实对话/旁白的完整语义；
- `visual-asset-sourcing`：确有必要的建立镜头或补充，不替事件；
- `cutaway-planning`：补镜怎样进入和返回；
- `audio-finishing`：现场声、音乐、声音桥；
- `captions`：必要对话和坐标；
- `remotion-production`：地点、路线、时间、简单图形，不接管主线。

主工作流完成每次交接后重新看事件链，而不是让各工种独立优化造成整体失真。

## Gate C：交付

只听声音检查空间和事件，静音看画面检查动作、方向和重复，完整声画检查情绪与节奏，首次观众检查是否知道人物在做什么、为什么关心和最后发生了什么。正式 Delivery 仍遵循 `quality-verification` 与 `export`。

## 交接合同

本主工作流接收素材、镜头证据、Event Map、Shot Selects、现场声、字幕和必要包装，并负责整片收口。完成条件是事件和情绪来自真实素材、镜头功能清楚、连续性成立、环境声被保留、包装克制、辅助审阅与未审范围如实记录、能力缺口明确、交付绑定目标 Revision。

## 当前调用与读回：Vlog 事件与 Montage

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| Vlog 事件与 Montage | `submit_vlog_analysis(base_revision_id, asset_ids, scene_threshold?, idempotency_key?)`；`manage_vlog_events(base_revision_id, action, ...)`；`manage_vlog_shot_selects(base_revision_id, action, ...)`；`compile_vlog_montage(base_revision_id, shot_select_ids, ...)`；`read_vlog_plan(project_id?)` | 分析只产生 Shot Boundary、源范围、变化分数和音轨事实；导演确认 Event/Select 后才编译 Montage。写后读回计划、Revision、Impact 和 Preview，不能把技术边界当作自动故事选择。 |
