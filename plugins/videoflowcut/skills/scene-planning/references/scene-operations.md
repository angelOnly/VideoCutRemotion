# Scene类型、范围与写入

## 把分镜映射为可执行范围

先沿导演分镜找持续的对象与空间模型。可以在同一 Scene 中完成多个相连镜头或 Beat；需要建立新空间、观看关系或主画面时再拆。拆分后为每个范围保留原分镜的作用，检查主要事件是否仍完整、前后信息时机是否改变；工具边界迫使改变表达时，返回总导演调整，不静默切碎。

每个范围区分已有素材、待搜索、待生成与原创制作，说明实际源长度、可用动作余量和计划显示时间。源视频播完后，画面是转为真实静帧供检查、明确回看、图形展开还是下一镜接管，必须有可执行设计；不能隐式冻结或循环。材料尚未取得时可以保留分镜计划，正式创建对象不使用虚构 Asset ID。

短素材可以参与较长段落：真实动作建立事实，局部解析、阅读、比较或感受继续发展表达。定格不代表事件继续发生，重放不代表发生第二次；原声是否保留、何时退出或由讲述接管需明确。源时间与观看时间分别记录，不能因扩展段落改写事实。

真实视频可以通过Timeline/Cutaway参与，也可以在提供`videoBindings`与`TimelineVideo`的Runtime中进入受管作品，最多四个正常速度静音选段。源毫秒与作品startFrame/endFrame固定，内部Sequence只改变布局、不重置视频时间；资源按有界缓存和真实磁盘需求管理，不为旧累计预算拆件。具体合同见[Remotion组件合同](../../remotion-production/references/remotion-component-contract.md#受管动态视频)，实际剪辑以连接Runtime与实时Schema为准。全屏转窗口时交清同一源时刻、对象位置和原声归属。抽帧定格需要可追溯、画质适用且正式登记的源静帧；低清联系表不直接承担主画面。原创图形可以保持状态，源视频不因结束而人为冻结或循环；超出实际能力时返回具体缺口。

定向选材采用后，接收真实源范围、动作余量、原声策略、画幅裁切与组合限制，再细化状态和镜头接点。不能只接一个 Asset 名称而丢失此前的采用依据；素材变化影响内部状态或前后接续时，把差异交导演和原负责人确认后再执行。

## 当前 Scene Type 的选择

当前 MCP 的 `create_scene` 只可创建以下五种类型：

- PresenterScene：人物关系和语言主导；
- ExplainerScene：认知模型、关系、状态或数据主导；
- CutawayScene：现实素材、完整展示或短中断；
- VlogMontageScene：事件、动作、反应和环境声主导；
- EndCardScene：收束、记忆与行动。

来源阅读、文档和 UI 操作目前没有独立的 Scene 类型。先把真实文档、网页、截图或 UI 录屏登记为 Asset：需要解释状态、关系或阅读顺序时使用 `ExplainerScene`，需要完整展示或短暂打断人物主画面时使用 `CutawayScene`。`DocumentScene` 与 `UIShowcaseScene` 在本 Skill 中只是在描述观看任务，不是当前 MCP 可创建类型，也不能传给 `create_scene`。

类型帮助默认布局和质量规则，不代替具体任务。

## 创作范围与执行范围

创作段落表示一个完整观看任务；Scene 表示项目中的叙事和空间范围；受管作品表示一份固定时长、画幅和帧率的渲染版本。三者可以对应，但不是强制一一对应。按语义先设计整段，再根据当前实现能力确定 Scene、Cue、作品和 Cutaway 的实际边界。

同一视觉任务中的连续对象，应保留身份、空间基线与关系；中间可经历多次聚焦、变形、比较和停留。具体变化来自当前内容。跨 Scene 或因渲染预算拆成多件作品时，写清交接对象的末态与初态、位置、尺度、颜色、阅读状态及运动方向；运动中接续还要匹配速度与相位。不能仅因两件作品时间首尾相接就认定视觉连续。

优先在可行的自然稳定点拆分。不得为适应单件预算，把一个仍在发生的关键动作直接截断；也不能通过拼接重复入场制造“连续覆盖”。完整设计可以包含一个自然切镜，持续运动不是所有边界的硬要求。

本版本不为创意状态新增通用自动编译器。状态设计写进创作说明，由受管作品的帧驱动代码实现。需要人物或实拍接管时，由现有 Timeline、Scene、Cutaway 与层级规则共同实现；关键事件不能在被其它画面遮住时悄悄播放完。

## 锁定与自动编译

用户通过 Web 精调 Scene 或 Cue 后，后续自动编译不应静默覆盖。若项目已有 direct_override 或批准状态，重编译应保留、产生冲突或请求复核。删除上游 Beat 后，锁定对象也不能留下悬空语义。

## 当前项目写入

主任务用 `manage_visual_treatment` 保存当前 Beat/Scene 已明确的主视觉、第一注意目标、强度及必要的安静理由或替代方案；字段从同一份采用稿映射，缺少设计再回原作者。它保存计划，不自动生成素材或效果，也不替代 Scene/Timeline 的实际放置。跨对象的关键取舍沿[项目审计](../../production-coordinator/references/project-writes.md#保存审计时才读)记录，不要求美术作者重新填写同义说明。需要 Cutaway 时按[辅助镜头操作](../../cutaway-planning/SKILL.md)建立对象，读取主线变化后的 Impact 并复核相关性、进入和返回。

内部状态不依赖新增通用编译器：设计写入 creativeBrief，受管帧代码落实变化，Scene/Cue 负责合法放置。按主线变化读回 stale，不能用 fit 裁短作品后恢复 ready。

当前 MCP 可以 `browse_scene_types`、`create_scene`，Presenter 正式链路还可使用 `compile_presenter_scenes`。创建 Scene 时必须有真实 start/end frame、purpose、类型和相关 Asset。架构中的完整 Scene Compiler、内部 State 和可编辑 Scene Props 尚未全部实现时，可以先形成计划并使用当前能表达的范围，不声称复杂渐进状态已经自动编译。

`compile_explainer_scenes` 会创建带内置主视觉的 Program，并不是空场景接口。实时 Schema 按 kind 分支列出内容条件，例如 HeroReveal 的 props.metric、RouteAndFlow 的 props.nodes，以及 Comparison 的双方名称和比较维度；真实 UI、证据与实拍类型另有素材要求。由原创 ManagedMotion 独立承担主视觉时，导演可选择现有 create_scene 创建基础 ExplainerScene，另交 VisualTreatment 与 Cue 参数，不必为随后停用而填充内置 Program。已有 Program 的局部替换仍按停用合同处理。

读取工具结果先检查 isError 并保留完整 text；成功结果才按 JSON 解码。编译业务错误返回 code/message，宿主或协议参数错误仍可能是纯文本；不能让二次解析错误遮住原始诊断，也不能据此重试写入。

Scene 创建后读回 Project、Scene、Timeline、Impact，并渲染必要范围。若 Scene 内部需要 Remotion 组件，再调用 `remotion-production`；时机交给 `effect-timing`，空间交给 `depth-composition`。

## 当前调用与读回：Scene 与 Effect

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| Scene 与 Effect | `create_scene(base_revision_id, type, title, purpose, start_frame, end_frame, asset_ids?)`；`manage_effect_cues(base_revision_id, action=create|update|remove, cue_id?, scene_id?, type?, layer?, start_frame?, end_frame?, ...)` | 默认 create 必须有 Scene、类型、层级与范围；update 必须有 cue_id，只改明确字段，不更换 Scene/类型/层级；remove 只传身份与 cue_id，保留 Asset。Effect 的 `narrative_purpose`、`audience_task`、`semantic_anchor`、`spatial_anchor`、`asset_bindings`、`props`、`motion`、`style_pack_id` 与 `quality_rules` 仍按实际类型约束；随后读回 Cue 与 Impact，移动需复查原/新范围。 |
