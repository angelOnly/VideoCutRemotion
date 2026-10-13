# VideoFlowCut 素材审阅 Skills 增量与阶段 1～5 漏洞收口方案

> 文档用途：直接指导 VideoFlowCut 下一轮代码与 Skills 收口开发。  
> 产品架构基线：`docs/ai_video_platform_architecture_development_plan.md` V6.2。  
> 本文范围：聚焦视频效果、剪辑判断、代码正确性、测试与可维护性。  
> 使用方式：本文已经内嵌需要补入现有 Skills 的专业正文、调用链和验收要求；开发 Agent 直接按本文修改当前仓库，不依赖其它仓库完成二次理解。

---

## 1. 本次调整的最终结论

本轮沿用 VideoFlowCut 现有核心架构：

```text
用户 / Codex
→ 主工作流与专项 Skills
→ video-editor-mcp / Browser Operator
→ Editing Application
→ Project / Story / Scene / Timeline / Revision
→ Remotion / Jobs
→ Quality / Export
```

ChatCut 对外可观察的职责分工是：后端把原始素材加工成可查询证据，Agent 根据当前任务按需查看素材，Skill 提供判断方法，MCP 将选择写入同一个可编辑项目，最后通过真实预览和导出结果复核。

本轮需要补充两项能力：

1. 在现有 MCP 和 Web 工作台中增加统一、只读、按需加密度的原素材审阅能力；
2. 把本文第 4 章给出的素材审阅与导演判断正文，增量写入现有主工作流与专项 Skills，使 Codex 在看到、听到真实素材以后有能力做比较、取舍和验证。

新的素材审阅闭环应是：

```text
Asset / Transcript / Shot Boundary
→ inspect_asset 低密度概览
→ 对候选范围查看短代理和上下文
→ 对快速动作、微表情、停顿和切口做密集复核
→ 现有 Skills 完成专业判断
→ 写入 SemanticUnit / StoryBeat / VlogEvent / ShotSelect / EvidenceCapture / VisualTreatment
→ Timeline / Preview
→ 完整声画复核
```

---

## 2. ChatCut 的素材理解方式应怎样映射到 VideoFlowCut

### 2.1 ChatCut 采用按需证据读取与 Agent 判断

ChatCut 的外部链路先把素材加工为可查询的元数据、转写、源时间窗口和处理状态，再由 Agent 依据当前任务缩小范围并审阅具体窗口。低密度概览用于发现候选，关键判断依赖具体时间窗口和实际预览。

VideoFlowCut 沿用这一职责分工：程序可靠交付可观察事实，Codex 结合当前视频目标与专业 Skills 形成选择、结构和验证结论。

### 2.2 素材审阅需要进入现有 Skills 的专业判断

素材审阅不是给每条素材生成一个固定“审美分”，而是让当前主工作流在真实声画证据上完成判断。需要写入现有 Skills 的专业方法可以归纳为六组。

第一组是**证据边界**。技术探测证明文件、编码、时长和音轨；转写证明语言候选；低密度抽帧证明采样时刻；短代理证明一段连续声画；用户说明提供业务背景；Codex 的专业解释必须引用前述证据并保留未知。任何一种证据都不能独自替代其它证据。

第二组是**完整取用范围**。一个可用范围不仅要包含句子或动作的“主要部分”，还要检查最小不失真范围、自然观看范围、必要上下文、句前句后余量、动作准备、主相位、结果和反应。人物说完一句话、动作碰到目标或镜头发生一次变化，都不自动等于可以切开的边界。

第三组是**关系判断**。重录、替代、Coverage、多机位、因果和对照关系必须由时间、内容、动作、视线、空间、声音或用户说明共同支持。相同文件夹、相同服装、相似构图和相邻时间不能自动证明两段素材可以互换，也不能证明两个反应发生在同一事件中。

第四组是**导演结构**。主工作流需要用观众承诺、事实时间线、观看时间线、故事脊椎、信息账本、Stringout、Selects 和节拍链组织素材。它们是连续判断方法，不要求新增一套项目对象：被采用的结论继续落入当前的 Story、SemanticUnit、VlogEvent、ShotSelect、VisualTreatment、Scene 和 Timeline。

第五组是**跨专业注意力与声音**。每个重要范围都要明确主视点、第一注意重点、第二注意重点和发现顺序；声音还要判断听觉视点、主导/支持/退让层、内在节奏、音乐 Spotting、J/L Cut、声音桥和静音。BPM、Onset、响度、镜头长度和运动强度只能提供线索，不能自动决定剪法。

第六组是**反事实与完整播放**。关键选择至少比较保持原状、换候选、延长、缩短、提前、延后、减弱或删除中的一种替代。写入 Timeline 后再完成只听声音、静音看画面和完整声画播放；技术通过、对象存在和关键帧截图不能代替最终审美判断。

### 2.3 现有对象已经足够承载判断结果

| 素材判断 | 当前应写入的对象 |
|---|---|
| 口播完整思想、重录、前提、停顿与顺序 | `SemanticUnit`、`Script`、`SpeechSegment` |
| 人物 Take、表演与画面版本 | `ActorPerformance`、`PresenterScene`、A-roll `TimelineItem` |
| Vlog 镜头事实、事件与选择 | `VlogShotAnalysis`、`VlogEvent`、`VlogShotSelect` |
| 解释片真实证据与限制 | `EvidenceCapture`、`NarrativeMap` |
| 每拍保持人物、解释、B-roll、证据或安静区 | `VisualTreatment`、`AttentionCurve` |
| 外部素材最终怎样进入成片 | `Cutaway`、`Scene`、`TimelineItem` |
| 本轮选择、拒绝与复核过程 | 可选 `SkillExecutionReport`，仅作为审计，不参与渲染 |

---

### 2.4 VideoFlowCut 与 ChatCut 的当前差距评估

结论需要分成三层看：

```text
核心架构：差距不大
代码能力覆盖：VideoFlowCut 已经很广，部分领域模型比外部可观察的 ChatCut 更显式
真实产品成熟度与成片效果：仍有明显差距
```

#### 核心架构已经基本对齐

两者都把“Agent 的创作判断”和“后端的确定性写入”分开；都以 Project 为共同事实中心；都区分源 Asset 与 Timeline 中的一次使用；都要求先读素材、再作决定、再写入 Script/Timeline，最后回到真实预览与导出结果复核。VideoFlowCut 的 V6.2 又明确了主工作流 Skill、专项 Skill、MCP、Editing Application、Revision、Remotion 与 Quality 的分工。因此，不需要为了素材审阅重新设计总架构。

#### VideoFlowCut 在显式工程模型上并不落后

VideoFlowCut 已经显式拥有 Story、Scene、Timeline、Revision、ImpactReport、Dirty Range、VisualTreatment、EffectCue、ActorPerformance、NarrativeMap、VlogEvent、VlogShotSelect、RenderPreflight、QualityReport 和 ExportArtifact。ChatCut 的外部拆解能确认 Project、Asset、Timeline、Track、Item、Script、Caption、任务和导出，但其私有内部对象并未公开。就“代码中能否追踪修改、失效、预览和交付”而言，VideoFlowCut 的设计已经较完整。

#### 最大差距一：源素材审阅仍未产品化

ChatCut 对外提供从 `browse_assets` 到 `inspect_asset`、转写检索、局部源时间画面和 Timeline Preview 的逐步收窄路径；Agent 可以先看素材卡，再看局部连续范围。VideoFlowCut 当前有 `browse_assets`、转写、Shot Boundary、Vlog Event/Select 和成片 Preview，但缺少统一的源素材局部审阅入口，也缺少在 Web 中循环查看源范围、Contact Sheet、密集帧和对应声音的完整工作面。

这不是一个小工具差异，而是当前最直接影响 Take 选择、动作完整、表演、B-roll 相关性和 Vlog 事件判断的产品差距。

#### 最大差距二：真实成片验证少于代码能力覆盖

VideoFlowCut 已经为 Presenter、Explainer、Vlog、Avatar 和混合场景写了大量领域对象和确定性 E2E，但现有阶段 3、阶段 4 测试主动把自己限定为技术链验证：离线 Explainer 只证明对象、Preview 与 Draft Artifact；Vlog 颜色块只证明 Shot Boundary、Montage、Ambient 和渲染链。ChatCut 的调研则至少对口播、访谈、无声 Vlog、影视高光、字幕、MG、Duck 和最终 MP4 做过真实项目读回或导出实验。

因此，当前差距主要是“代码已经能表达”与“真实内容已经证明剪得好”之间的差距。

#### 明显差距三：声音处理仍偏基础

VideoFlowCut 已经支持 Dialogue、BGM、SFX、淡入淡出、循环、Ducking 和显式 Onset 偏移，但人声降噪、接缝平滑、Room Tone、去齿音、响度统一、True Peak 收口和完整复听仍未形成一条成熟的 Dialogue Finishing 链。ChatCut 的外部工具和实验至少体现了 `smooth_audio`、Anchor/Follower Duck、声音事件与物理 Item 起点分离等更成熟的产品操作。

#### 明显差距四：Motion Graphics 的灵活度和产品化

VideoFlowCut 的 Remotion Registry、EffectCue、AssetBinding、Props、Motion、StylePack 和 Explainer Program 提供了较强的确定性与可测试性，但当前主要依赖已注册组件。ChatCut 的工具合同还包含代码生成 MG、素材化、Timeline 放置和 Shader 工作流，灵活度更高。VideoFlowCut 当前不必立刻复制 Shader，但需要先解决组件缺少正式内容时仍渲染占位、代表性样例不足和真实素材绑定后缺少完整审阅的问题。

#### Web 工作台的差距是“源素材与工作流成熟度”，不是有没有 AI 聊天

VideoFlowCut 已有素材、工作单、文字稿、声音、人物、场景、字幕、高级、任务/QC 面板，包含 Remotion Player、Timeline、Inspector、Revision、预检和导出。ChatCut 的优势在于成熟的素材局部查看、Timeline/文字稿协同、对象引用和经过真实用户流程验证的工作面。第一版不做 Web AI Chat 不构成核心差距；缺少源素材循环审阅和更成熟的局部对象操作才是实际差距。

#### Avatar、Explainer 和 Vlog 的比较要区分“实现广度”和“验证深度”

VideoFlowCut 已经显式实现 Avatar Job、ActorPerformance、NarrativeMap、EvidenceCapture、Explainer Program、Vlog Shot/Event/Select/Montage 等能力，功能表面比 ChatCut 当前公开可观察的合同更广。但 Avatar 中文口型、自动 Mask、真实事件理解、复杂解释片的认知效果和多段 Vlog 节奏尚未通过足够真实素材验证。因此这里不能简单说谁的架构更强；VideoFlowCut 的主要任务是把现有实现变成真实可用产品。

#### 综合判断

| 维度 | 当前判断 |
|---|---|
| 总体架构与职责分工 | 已基本对齐，差距小 |
| 项目状态、Revision、Impact 与交付对象 | VideoFlowCut 显式设计较强 |
| Skills 主工作流结构 | 已基本对齐，仍需补素材审阅正文并同步代码能力 |
| 源素材按需审阅 | 差距大，是当前首要补口 |
| 语义剪辑模型 | 架构较强，声画证据结合仍需加强 |
| Web 编辑工作面 | 功能已有，源素材审阅和产品成熟度仍有差距 |
| Remotion/MG | 确定性较强，灵活度与真实成片验证不足 |
| 声音 | 基础编排已具备，专业清理与复听差距明显 |
| Avatar/Explainer/Vlog | 实现覆盖广，真实编辑效果尚未充分证明 |
| 质量与交付 | 显式门禁较强，需更多真实 Artifact 与完整审片 |

所以，VideoFlowCut 与 ChatCut 的差距**不是大到需要重构核心架构**。真正大的差距集中在三件事：

```text
Codex 能否方便、准确地看懂真实原素材
→ 现有 Skills 能否基于声画证据作出专业取舍
→ 这些取舍是否已经在真实成片中反复验证
```

本轮应围绕这三件事收口，而不是继续扩张新的领域对象和视频类型。

---

## 3. 代码层应增加的统一原素材审阅能力

### 3.1 统一原素材审阅入口：`inspect_asset`

当前 `browse_assets` 只能回答“项目中有什么”，`submit_vlog_analysis` 只能回答“镜头变化边界大致在哪里”。Codex 仍缺少一条统一路径去查看某个源范围中的实际动作、人物表情、声音、前后镜头和可用切口。

建议以一个只读 MCP 作为统一入口：

```text
inspect_asset
```

它使用同一个工具合同，通过证据密度参数处理三类读取需求。具体字段名可以遵循现有命名风格调整，但语义必须完整。

#### `overview`：第一次浏览素材

用于回答“这份素材大致有什么，哪些范围值得继续看”。返回：

- Asset 元数据、处理状态、音轨事实和转写摘要；
- Shot Boundary 与源时间范围；
- 最多约 20～25 张带时间码的低密度 Contact Sheet；
- 当前素材被哪些 Timeline、Scene 或 Item 使用；
- 已知无声、缺转写、代理不可用等证据边界；
- 可以继续请求的候选范围。

`overview` 仅输出候选发现所需的概览信息。低密度抽帧只证明采样时刻的画面；涉及短暂动作、表情或精确边界时，进入 `range` 或 `dense` 复核。

#### `range`：审阅一个候选范围

用于回答“这一段具体发生了什么，是否值得进入候选”。返回：

- 指定源范围的短代理视频；
- 带时间码的 Contact Sheet；
- 对应转写和说话人信息；
- 音频波形、静音、响度和明显 Onset 等辅助证据；
- 前后相邻 Shot 或上下文范围；
- 当前范围是否已被项目使用，以及使用位置。

短代理保留真实画面和声音，Codex 直接查看或播放代理；文字摘要只作为定位和检索辅助。

#### `dense`：短范围密集复核

只用于会改变剪辑判断的短窗口，例如：

- 快速动作的准备、主相位、结果；
- 微表情和真实反应；
- 人物停顿、吸气、开口和句尾；
- 镜头运动起止；
- 口型与声音切点；
- 相邻机位是否真正覆盖同一动作；
- B-roll 中主体是否短暂离开安全区。

`dense` 设置严格的最大时长，只展开能够改变当前判断的最小窗口。

### 3.2 `inspect_asset` 是只读派生能力

联系表、短代理、波形和密集帧放在可重建缓存中，例如：

```text
project/cache/source-review/
```

缓存键由素材内容哈希、源范围和采样参数组成。这些文件作为可重建派生缓存保存，不进入 Revision，也不注册为正式成片 Asset。

真正的编辑判断仍由现有 Application Command 写入现有对象。

### 3.3 Web 素材审阅视图

素材审阅能力直接整合到现有 Assets / Inspector 区域：

- 原素材播放器；
- 源时间范围循环播放；
- Contact Sheet；
- 密集帧切换；
- 转写、说话人和声音概览；
- 前后 Shot 跳转；
- 当前源范围在 Timeline 中的使用位置；
- Browser Operator 可稳定定位的 Asset ID、源时间范围和模式。

Web 展示素材证据和已有项目对象；专业判断继续写入 SemanticUnit、StoryBeat、VlogEvent、ShotSelect、EvidenceCapture、VisualTreatment 等现有项目对象。

### 3.4 审美判断由 Codex 与专业 Skills 完成

程序负责损坏、全黑、严重失焦、重复文件、分辨率和音轨事实等技术预筛；以下专业判断由 Codex 结合当前主工作流、真实证据和完整播放完成：

- 哪个略抖镜头的真实反应更重要；
- 哪次重录更可信；
- 某个停顿是否承担情绪；
- 这个漂亮空镜是否支持当前观点；
- 哪个镜头在当前结构中承担不可替代的前因、结果或反应。

技术评分只用于缩小候选范围，最终选择由 Codex 结合当前主工作流、真实证据和完整播放作出。

---

## 4. Skills 需要增加的内容

本章内容已经按目标文件写成可直接复制的 Markdown 正文。开发 Agent 不需要再到其它仓库提炼、改写或重新解释；只需结合当前文件已有章节，避免重复后写入对应 Skill。


### 4.1 共享素材审阅方法的放置位置

新增：

```text
.agents/skills/_shared/SOURCE_REVIEW_METHOD.md
```

`SOURCE_REVIEW_METHOD.md` 作为 `_shared` 参考章节，由现有主工作流和专项 Skills 按需读取；运行时可发现 Skill 仍由 `.codex/config.toml` 中现有条目管理。

以下内容可直接作为该文件的主体初稿。

---

### `SOURCE_REVIEW_METHOD.md` 建议正文

#### 素材审阅的目的

素材审阅不是给每个镜头贴一个永久标签，也不是用清晰度、镜头长度或模型置信度自动选片。它的任务是让当前主工作流获得足以做判断的真实证据：素材中发生了什么，哪一段是完整表达或完整动作，人物和声音如何变化，前后文是否必需，以及当前判断还存在哪些未知。

同一个镜头在不同视频中可能承担完全不同的价值。略微抖动的反应镜头在品牌广告中可能不适合，在真实 Vlog 中却可能是事件情绪成立的唯一证据。因此，素材只保存事实、范围和可观察关系；“是否采用”必须回到当前视频的观众承诺和结构。

#### 证据层级

技术探测可以证明文件、编码、时长、帧率、音轨和时间轴；转写可以证明语言候选，但不能证明人物表情、动作和声音关系；低密度抽帧可以证明采样时刻的画面，但不能证明两帧之间发生了什么；多模态描述可以提供事件线索，但不自动具有精确切点能力；用户说明可以提供业务事实，但仍要和实际画面区分；专业解释必须建立在多个证据之上，并保留可能的替代解释。

当判断依赖快速动作、微表情、口型、语气或镜头运动起止时，不能只根据粗略联系表或文字摘要。应请求最小的 `dense` 源范围，然后再决定边界。

#### 四类陈述必须分开

审阅结果中的每个重要结论都应区分：

1. 画面或声音直接支持的事实；
2. 用户明确提供的身份、背景或业务说明；
3. 基于多项证据形成的专业解释；
4. 仍然未知或存在替代解释的部分。

故事表述应保持事实、用户说明、专业解释和未知的边界；模型描述只作为证据之一，未解决的未知继续显式保留。

#### 完整语言、动作与反应单位

镜头边界、句号、静音和音乐拍点都只是证据，不自动等于剪辑边界。对重要素材范围，至少检查：

- 最短到哪里仍不失真；
- 自然观看需要保留到哪里；
- 理解它需要哪些前后文；
- 动作准备、主相位、结果和反应是否完整；
- 人物呼吸、目光、手势和环境声是否需要余量；
- 切开后是否产生半个音节、半个动作、错误因果或突然情绪变化。

人物说完一句话不等于镜头可以立刻切走。一个目光、吸气、笑声、停顿或结果后的环境变化，可能是这句话真正产生意义的部分。

#### 重录、替代与 Coverage

相同台词、相同服装、相邻文件或相似构图不能自动证明两个范围可以替换。比较重录或多机位 Coverage 时，应同时检查完整性、表演、声音、动作、视线、空间、余量和前后衔接。

最后一次重录不一定最好。第一遍可能更真实，第二遍可能更准确；选择由当前视频承诺决定。访谈、证据和真实人物内容不得用两个残句拼成说话者从未完整表达过的新结论。

#### 事实时间线与观看时间线

审阅素材时先恢复事实顺序：事情真实怎样发生，人物何时知道什么，回答对应哪个问题，反应对应哪个事件。主工作流之后可以设计观看顺序，但每次重排都要检查是否制造了不存在的因果、同时性、知情状态或人物关系。

#### 观众状态与镜头功能

评估一个候选时，不问“它够不够漂亮”，而问：它是否改变观众的已知、问题、预期、情绪价值或注意重点。镜头可以承担建立空间、推进动作、展示细节、表现反应、提供证据、连接时间地点、形成氛围或给予恢复。相邻镜头功能完全相同且没有新变化时，通常需要删减或重新选择。

#### 反事实比较

高影响选择至少比较一个替代方案：

- 保持原镜头；
- 选择另一个 Take；
- 使用更长或更短范围；
- 提前或延后切入；
- 不插 B-roll；
- 保留原声而不是用音乐覆盖；
- 使用简单硬切而不是显性效果。

没有比较就容易把第一个可用方案误当成最佳方案。

#### 完整播放验证

单个候选镜头看起来成立，不代表放进整片仍然成立。选择写入 Timeline 后，至少完成：

- 只听声音，检查语言、环境、呼吸、接缝和节奏；
- 静音看画面，检查动作、表演、视线、空间和重复；
- 完整声画播放，检查注意力、情绪和信息关系；
- 从第一次观看者角度，确认观众是否知道人物在做什么、为什么关心、发生了什么变化。

技术通过、对象写入和抽到关键帧不能替代完整播放。

---

### 4.2 `project-basics` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/project-basics/SKILL.md`：

````markdown
## 源素材坐标与按需审阅合同

Asset 保存源文件及其处理事实；TimelineItem 保存某个成片版本对 Asset 源范围的一次使用。源素材审阅始终使用 Asset 的源时间或源帧坐标，不直接改变 Timeline。只有主工作流完成选择并调用现有写入工具后，判断才成为新的 Project Revision。

`inspect_asset` 是统一的只读审阅入口。`overview` 用来发现候选范围，适合第一次浏览整份素材；`range` 用来理解一个候选范围的连续动作、声音和上下文；`dense` 只用于快速动作、微表情、人物停顿、口型、镜头运动起止和精确切口等高影响短窗口。低密度概览不能支持的结论，必须进入更高密度证据后再写入项目。

Contact Sheet、短代理、波形和密集帧属于可重建审阅缓存，不是 Revision，也不替代 Asset。Agent 写入 Story、SemanticUnit、VlogEvent、ShotSelect、EvidenceCapture、VisualTreatment、Cutaway 或 TimelineItem 时，应保留能回到 Asset 与源范围的证据，使后续修订能够重新检查原素材。

标准读取顺序是：

```text
browse_assets
→ inspect_asset overview
→ 对候选范围使用 inspect_asset range
→ 只有边界或短暂事件会改变判断时使用 dense
→ 当前主工作流写入既有项目对象
→ read_project / read_impact_report
→ 在成片 Preview 中连续验证
```

源素材窗口中的判断只是选择依据。真正的结果仍要回到当前 Revision 的 Timeline、字幕、声音和完整 Preview；不能因为某一段原片单独看起来成立，就宣布它在成片中已经成立。
````

### 4.3 `production-director` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/production-director/SKILL.md`：

````markdown
## 素材证据进入导演选择的门槛

总导演不替 Presenter、Explainer 或 Vlog 主工作流逐镜选片，但必须确认当前主线建立在足够的素材证据上。文件名、转写关键词、Shot 技术分数、Provider 标题和一张缩略图只能用于发现候选，不能直接成为 Story、Event 或 Select 的事实依据。

主工作流进入包装前，需要能够回答五个问题：当前主线依赖哪些源素材事实；哪些候选已经查看过连续声画；哪些精确边界经过必要的密集复核；哪些判断仍属于专业解释或未知；哪些候选被采用、拒绝或保留为备选，以及它们怎样改变观众的已知、问题、预期、情绪和注意力。

建立主线时使用观众承诺、事实时间线、观看时间线、故事脊椎、信息账本、Stringout、Selects 和节拍链。它们是导演工作方法，不要求新增同名数据库对象。最终采用结果继续写入现有的 SemanticUnit、StoryBeat、NarrativeMap、VlogEvent、ShotSelect、VisualTreatment、Scene 和 Timeline；关键选择与拒绝理由可以写入 Creative Decision 或 SkillExecutionReport 作为审计。

若当前证据只足以发现候选，却不足以判断快速动作、微表情、真实反应或声音切口，总导演应让主工作流补看具体源范围，再继续选择。若素材本身无法兑现观众承诺，应缩小承诺或更换主线，而不是依赖音乐、B-roll 和动效制造素材不支持的故事。
````

### 4.4 `presenter-motion-director` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/presenter-motion-director/SKILL.md`，放在 Gate A 的源素材与 A-roll 说明之前：

````markdown
## Gate A 前的原素材审阅

人物口播不能只从 Transcript 选内容。转写可以帮助定位观点、问题和重录，但两次文字完全相同的 Take，仍可能在准确性、可信感、语气、眼神、手势、呼吸、环境声、可用余量和前后衔接上明显不同。人物承担信任或情绪时，表情和停顿本身就是内容证据；教程和产品演示中，UI、对象和操作画面则可能比人物更重要。

先用 `browse_assets` 确认候选 A-roll，再用 `inspect_asset overview` 了解素材结构。对可能采用的 Take 使用 `range` 查看完整声画；当决定取决于句首句尾、停顿、微表情、手势、跨 Take 切口或人物反应时，再对最小短窗口使用 `dense`。审阅完成后才进入 transcription、semantic-continuity 与 `assemble_presenter_track`。

主工作流对每个高影响 Take 至少记录：为什么选它；另一个 Take 为什么被拒绝；是否为了表演、呼吸或环境声保留了额外余量；切口是否需要 B-roll、CameraPunch、声音桥或保持原样；选择在只听声音、静音看画面和完整声画播放中是否都成立。

个人坦白、读书反思和价值判断通常优先保护人物的眼神、呼吸和停顿；促销或教程可能更重视产品、数字、UI 和动作清晰度。判断来自当前观众任务，而不是固定认为“最后一次重录最好”或“人物超过五秒就应该离开”。
````

### 4.5 `semantic-continuity` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/semantic-continuity/SKILL.md`：

````markdown
## 文字之外的源素材证据

当任务只涉及明显错字、低歧义口癖或已有可靠范围的文本重排时，可以先从 Transcript 和现有 SemanticUnit 工作；但以下判断不能只看文字：两次完整重录的选择；停顿究竟是卡壳、呼吸、犹豫还是情绪落点；回答脱离原问题后是否变义；跨 Take 拼接是否造成表演、口型或环境声断裂；人物反应是否真正属于当前事件；句首句尾是否存在半个音节或未完成口型；连接词删除后语气是否变得更绝对。

遇到这些情况，先读取对应 Asset 的 `range`；边界依赖短暂动作、微表情或发音时，再读取最小 `dense` 窗口。选择 SemanticUnit 时同时保护文字意义、声音自然、人物表演和真实上下文。一个文本更短、语法仍通顺的版本，可能已经让人物显得更确定、更冷漠或更绝对。

本 Skill 仍负责语言和内容连续性，不替主工作流决定视觉形式。完成后交付最终 SemanticUnit、Script、SpeechSegment、停顿策略、删留/重排理由、源范围证据和下游失效范围；Presenter、Explainer 或 Vlog 主工作流再决定人物、B-roll、字幕、声音和 Scene。
````

### 4.6 `visual-treatment-planning` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/visual-treatment-planning/SKILL.md`：

````markdown
## 从源素材证据建立 Visual Treatment

Visual Treatment 不能只根据 Script 关键词和 Effect Registry 决定。对每个重要 Beat，先读取人物、动作、证据、UI、产品或现实素材的真实范围，再明确主视点、第一注意重点、第二注意重点和发现顺序。若已有 Coverage，判断它是否真正增加环境、细节、反应、证据或动作信息；仅仅换景别并不构成新的观看功能。

动作类素材要检查准备、主相位、结果和反应；人物素材要检查眼神、表情、手势和停顿；证据和 UI 要检查来源全貌、状态变化、条件和可读时间。数字运镜必须写清从哪一种信息出发、最终让观众发现什么；没有新增发现时，保持原构图通常优于无目的推拉。

每个 Treatment 继续比较保持原状、最小处理和更强处理。决定中要说明：它解决的是理解、相信、感受、定位、记忆还是行动；证据来自哪个源范围；硬切、静止或原画面为何不足；处理后谁成为第一注意目标；哪些字幕、声音、人物动作或背景运动必须退让；删掉显性效果后，结构是否仍然成立。

横版与竖版分别检查主体、动作路径、负空间、字幕、证据和 UI。一个在横版中成立的并置关系，缩小后未必适合竖版；需要重新布局或编译不同 Timeline Variant，而不是统一缩放所有对象。
````

### 4.7 `visual-asset-sourcing` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/visual-asset-sourcing/SKILL.md`：

````markdown
## 候选本地化后的真实内容复核

Provider 返回的标题、标签、缩略图和技术元数据只能帮助发现候选。候选通过硬过滤并由 `acquire_media_asset` 本地化为 Project Asset 后，还要查看真实画面与可用范围，才能交给 Cutaway 或 Explainer 工作流。

先用 `inspect_asset overview` 确认主体、动作、地点、画幅、镜头运动、字幕/品牌、水印和整体结构；再用 `range` 查看可能采用的连续范围，判断真实动作、构图、方向、留白、可用时长和进入/退出余量。只有短暂动作、主体越界或精确切口会改变选择时，才使用 `dense`。

搜索结果需要向主工作流交付三类信息：候选实际支持当前 AssetRequest 的证据；候选与需求不匹配或被拒绝的原因；被接受 Asset 的可用源范围、构图限制和来源信息。最终是否全屏、PiP、持续多久、保留哪一层声音以及何时返回主画面，仍由 `cutaway-planning` 或对应 Scene 主工作流决定。
````

### 4.8 `cutaway-planning` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/cutaway-planning/SKILL.md`：

````markdown
## Cutaway 两端同时审阅

Cutaway 的判断同时涉及主画面和候选素材。先看当前成片范围：离开人物或主场景会失去什么，人物表情、动作、证据、空间关系或笑点反应是否仍需保留。再看候选源范围：实际发生什么，哪一段完整、构图和方向是否匹配、进入和退出是否有余量、声音是否需要延续。

标准流程是：

```text
读取当前成片范围
→ inspect_asset 查看候选源范围
→ 比较保持主画面、PiP、全屏三种方案
→ 确认 source range、构图、声音和返回策略
→ 写入 Cutaway
→ 连续播放进入、停留和返回
```

B-roll 至少承担解释、证明、具体化、地点建立、动作覆盖或情绪呼吸中的一种明确任务。候选“漂亮”或与关键词相关，不代表它适合离开人物。个人坦白和重要反应可能更需要保留人物；教程、证据、产品操作和地点建立则可能需要全屏接管。

验证时不能只看 Cutaway 中间一帧。必须播放进入前、完整停留和返回后的连续范围，检查 Dialogue、现场声、字幕、构图、动作方向和注意力是否自然。
````

### 4.9 `vlog-director` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/vlog-director/SKILL.md`：

````markdown
## 从技术 Shot Boundary 到导演 Event

`submit_vlog_analysis` 提供镜头变化边界、源范围、变化分数和音轨事实；它不说明镜头里发生了什么，也不决定故事价值。得到 Shot Boundary 后，先用 `inspect_asset overview` 建立素材地图；对可能构成事件的范围使用 `range` 查看连续动作和声音；对快速动作、反应、镜头运动起止和精确切点使用最小 `dense` 窗口。完成这些审阅后，才创建 VlogEvent 和 VlogShotSelect。

Event Map 中的目标、行动、变化、结果和反应必须能够回到真实 Shot 与源范围。Shot Select 要说明镜头功能、选择理由、动作余量、现场声策略以及它与前后镜头的因果、反应、相似、对立、递进或空间关系。scene score、文件顺序、清晰度和时长只用于技术筛选，不能自动进入 Montage。

不同素材使用不同事件判断。猫咪视频可能由声音触发、回头、移动、停下和反应构成事件；游泳视频需要保护准备、入水、划水、转身、到达和呼吸；旅行素材还要维护地点、方向、时间和环境声。主工作流应先让事件成立，再决定音乐、字幕和少量 Remotion，不能用卡点替代动作和反应。
````

### 4.10 `visual-explainer-director` 与 `evidence-visualization` 可直接追加的正文

将第一段追加到 `.agents/skills/visual-explainer-director/SKILL.md`：

````markdown
## 真实素材进入 NarrativeMap 与 ExplainerScene 前的审阅

旁白、页面标题和文件名不能替代对真实证据、UI、产品或现场素材的查看。需要使用某段真实素材建立 NarrativeMap、EvidenceCapture 或 ExplainerScene 时，先读取 `inspect_asset overview`，再对实际引用范围使用 `range`。确认素材真实显示什么、不能证明什么、状态变化是否完整、页面或视频上下文是否足够，以及观众需要先看全貌还是先看局部。

Explainer 主工作流把审阅结果写入现有 EvidenceCapture、NarrativeMap、VisualTreatment 和 ExplainerSceneProgram。一个局部截图只有在来源、条件、否定、单位和页面关系仍可辨认时才是证据；否则应扩大范围、先建立页面全貌或明确标为示意。
````

将第二段追加到 `.agents/skills/evidence-visualization/SKILL.md`：

````markdown
## 证据范围、聚焦与阅读顺序

证据可视化先建立来源环境，再逐步聚焦。页面、文档、UI 或视频证据进入高亮前，先确认原始 Asset、目标源范围、出处、主张和限制；高亮不能截掉改变含义的条件、否定、单位、比较基线或来源身份。

观众通常需要经历“看见来源全貌 → 知道要找什么 → 聚焦目标区域 → 读取关键内容 → 理解它支持和不支持什么”。若一开始只展示被裁切的局部，观众可能无法判断真实性；若全程保持整页，又可能无法阅读。Scene 的 Entry、Progressive、Settled 和 Exit 应服务这一阅读顺序，并给正常速度下的识别、阅读和比较时间。
````

### 4.11 `audio-finishing` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/audio-finishing/SKILL.md`：

````markdown
## 源声音与内在节奏审阅

Beat、Onset、BPM、响度和静音是声音证据，不是自动剪辑命令。对每一段先确定观众必须听清什么、听觉视点在哪里、哪一层主导、哪一层支持或退让，以及音乐、环境、动作声和静音分别承担什么功能。

人物口播和访谈的源范围需要结合 `inspect_asset range` 复听呼吸、语气、Room Tone、环境变化和切口；只有句首句尾、爆破音、短暂噪声或动作声会改变边界时，才使用 `dense`。停顿可能是冗余，也可能承担思考、反应、等待、笑点释放或结尾余韵；应比较保留、缩短和删除，而不是按统一阈值处理。

音乐先做 Spotting：哪里需要、为什么需要、何时进入、何时退出、没有音乐是否更准确。J/L Cut 和声音桥必须支持真实语义、动作、空间或视点；不能用声音暗示不存在的同时性和现场关系。SFX 绑定真实动作、信息变化或明确视觉事件，不能给每个字幕、转场和动画都配音。

后续 Dialogue Processing 需要比较原声、最小处理和较强处理。更干净不自动更好；降噪、EQ、去齿音、响度统一和限制器只有在解决可听问题且没有明显副作用时才采用。最终判断来自完整复听，而不是参数达标。
````

### 4.12 `captions` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/captions/SKILL.md`：

````markdown
## 字幕与源声画证据

字幕首先承担信息任务：语言可读、身份、时间地点、步骤、数据、证据或强调。决定文字内容和时机前，要检查最终 Script、真实声音、人物表情、关键动作、UI、证据页面和已有画内文字；声音和画面已经清楚完成任务时，字幕可以保持稳定或省略重复强调。

字幕不能提前泄露答案、包袱、反应或结果，也不能通过删掉“我觉得”“在这个条件下”等限定，把主观意见改成事实。分卡和换行保护否定、条件、数字单位、专名、问题/回答和完整短语；没有真实 word_exact 时，不制作伪精确逐词效果。

源素材审阅尤其用于判断字幕与人物、动作和环境声的关系。例如人物在一句话结束后有重要表情反应，字幕可以先稳定退出，让观众看反应；UI 或证据已经包含关键文字时，字幕应避免遮挡和重复。横竖屏分别检查人物、产品、UI、证据、平台控件和字幕安全区。

任何字幕修改若改变语气、对象、事实或上下文，应退回 SemanticUnit/Script；显示层不能用更顺的文案替换原内容。
````

### 4.13 `remotion-production` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/remotion-production/SKILL.md`：

````markdown
## 真实素材绑定前的审阅与渲染验证

EffectCue 或 ExplainerScene 绑定图片、视频、产品、证据或 UI Asset 前，先查看该 Asset 的真实内容、构图、运动路径和可用范围。AssetBinding 缺少必需内容、源文件不可用或 Props 不能完成组件任务时，Cue/Program 应进入 invalid 或 not_ready，并由 Web 与 Quality 显示具体原因；Renderer 不应把调试占位、通用文案或固定品牌渲染进正式画面。

视频 Asset 在 Cue 或 Scene 内要使用局部时间，确保从所选 source range 的起点播放，而不是继承全局 Composition Frame。每个代表性样例至少检查 Entry、Progressive、Settled 和 Exit；Settled Frame 要真正给观众识别、阅读或比较时间。

人物、字幕、证据和动效同屏时只设一个第一注意目标。进入全屏 Scene、人物做关键手势或证据正在阅读时，CameraPunch、大字幕、背景运动和 SFX 要相应退让。横版和竖版分别检查主体、动作路径、负空间和信息层级。

同类 Scene 批量生产前，先完成一个代表性样例，并与“不使用效果”或“最小处理”版本比较。若移除动效后信息没有损失，当前效果可能只是在装饰。
````

### 4.14 `avatar-performance` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/avatar-performance/SKILL.md`：

````markdown
## Avatar 输出作为候选人物素材审阅

Avatar Job 成功只证明 Provider 返回了文件。生成结果在成为正式 ActorPerformance 前，要像其它人物素材一样查看连续声画：检查句首延迟、爆破音、长元音、句尾闭嘴、身份、服装、背景、眨眼、表情、手部、姿态和镜头稳定；多段生成还要检查姿态复位、情绪跳变和人物尺度变化。

先用 `inspect_asset range` 查看完整生成段；口型、手部或短暂伪影会改变判断时，再用 `dense` 查看最小窗口。Provider 名称、输入中存在参考音频或 Capability Profile 中声明支持口型，都不能替代实际观看。Alpha/Mask 也必须由真实输出和边缘检查确认。

局部重生成完成后，比较新段与前后段的身份、光线、背景、目光、语速和情绪。只有生成 Asset、SpeechAsset、Script Revision、AudioMode、Mask/布局和完整 Preview 一致时，才把该人物段视为当前版本可用。
````

### 4.15 `quality-verification` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/quality-verification/SKILL.md`：

````markdown
## 源素材选择质量审查

质量复核除了检查项目结构、渲染和字幕，还要回到具体源素材选择。对高影响范围检查：选中的口播 Take 是否比被拒绝候选更适合当前观众承诺；是否截断完整思想、动作准备、结果或反应；B-roll 是否真实支持当前 Beat，而非只命中关键词；Vlog Event 是否来自实际动作与现场声；Explainer 证据是否保留来源、条件和限制；Avatar 段是否通过实际口型与连续性检查。

这类问题不使用统一审美总分。Finding 要引用 Project 对象、Asset、源范围、成片范围和可观察证据，并把修复退回正确负责人。若问题来自选错 Take，应退回 Presenter/Vlog 主工作流；若来自 Cutaway 使用方式，退回 cutaway-planning；若来自信息模型，退回 VisualTreatment 或 Explainer Scene；若来自声音处理，退回 audio-finishing。

最终继续使用五轮审片：只听声音、静音看画面、完整声画、首次观众、交付文件。Contact Sheet、单帧、技术测试和质量规则只能帮助定位，不能替代连续观看和真实听感。
````

### 4.16 `web-editor-operator` 可直接追加的正文

将下面章节直接追加到 `.agents/skills/web-editor-operator/SKILL.md`：

````markdown
## 源素材审阅操作合同

源素材审阅发生在现有 Assets / Inspector 工作区。先选中目标 Asset，确认 Asset ID 和源时间坐标；使用 overview 查看素材结构，使用 range 循环播放候选范围，只有精确动作、微表情、停顿、口型或切口会改变决定时才进入 dense。

对比两个 Take、两个机位或两个 B-roll 候选时，保持相同的上下文长度和播放条件，分别记录完整性、动作/表演、声音、构图、余量和当前视频功能。浏览器中看到的源范围、Selection 和循环状态只是审阅上下文；只有通过 MCP/Application 写入并生成新 Revision，选择才成为项目事实。

写入后必须返回 Timeline 或真实 Composition Preview，播放修改前后和受影响完整范围。不能把源素材窗口中单独成立的镜头，直接当作已经在成片中成立。
````

## 5. 更新后的现有 Skill 调用链

### 5.1 人物口播

```text
project-basics
→ production-director
→ presenter-motion-director
   → browse_assets / inspect_asset
   → transcription
   → semantic-continuity
   → voice-production / avatar-performance
   → StoryBeat / PresenterScene
   → visual-treatment-planning
   → visual-asset-sourcing / cutaway-planning / remotion-production
   → captions / audio-finishing
   → quality-verification
```

### 5.2 Vlog

```text
project-basics
→ production-director
→ vlog-director
   → submit_vlog_analysis
   → inspect_asset overview / range / dense
   → VlogEvent
   → VlogShotSelect
   → VlogMontageScene
   → captions / audio-finishing / 少量 Remotion
   → quality-verification
```

### 5.3 视觉解释片

```text
project-basics
→ production-director
→ visual-explainer-director
   → Script / NarrativeMap
   → inspect_asset（真实证据、UI、产品或现场素材）
   → EvidenceCapture / VisualTreatment
   → ExplainerSceneProgram
   → remotion-production
   → captions / audio-finishing
   → quality-verification
```

### 5.4 外部 B-roll

```text
AssetRequest
→ visual-asset-sourcing 搜索与本地化
→ inspect_asset 查看真实候选内容
→ cutaway-planning 决定是否使用和怎样使用
→ Timeline / Preview
→ quality-verification
```

---

## 6. 当前跨阶段公共代码漏洞

这些问题不属于某一个视频类型，但会影响所有阶段。

### P0-1：当前 `main` CI 失败

当前仓库的 Skills 测试仍把已经进入 MCP 的 `read_actor_capabilities`、`submit_avatar_job`、`read_narrative_map` 当成未来目标；同时 `docs/` 下存在第二棵 `.agents/skills` 归档目录，违反运行时 Skills 唯一来源测试。

修复方式：

- 删除、压缩或移出 `docs/` 中第二棵可执行 Skills；
- 更新 `tests/skills-v5-integration.test.ts` 的能力分类；
- 同步 `_shared/MCP_EXECUTION_CONTRACT.md`；
- 同步 Avatar、Explainer、Vlog 主 Skill 的当前能力说明；
- 保持测试严格，不通过放宽断言绕过漂移。

### P0-2：Skills 与代码能力漂移

当前部分 Skill 仍声称 Avatar、NarrativeMap 或 Vlog 工具不存在，而 MCP 已经实现。结果不是“文档看起来旧”，而是 Codex 会错误停止、错误降级或漏掉已有工具。

修复方式：代码、MCP、Skill、AGENTS 和测试在同一次修改中同步。当前能力应区分“已实现”“确定性测试通过”“真实 Provider 验证”“完整审美验证”，不能只写存在或不存在。

### P0-3：Renderer 仍会输出调试占位和硬编码成片文案

当前 Remotion Runtime 在素材缺失时会画出“缺少项目素材”，评论缺失时会画出“未提供项目评论”，并对 Effect 使用“关键数字”“产品展示”等通用回退；EndCard 固定写入 `VideoCut` 和“继续探索”。这些不是后台提示，而会直接进入 Preview 或成片。

修复方式：为每种 Effect 建立最小必需内容合同。内容或 AssetBinding 不完整时，Cue 进入 invalid/not_ready，并由 Web 和 Quality 显示问题；Renderer 只渲染满足合同的正式内容。EndCard 品牌、CTA 和文案来自项目数据。

### P0-4：Remotion 版本不一致

当前 `@remotion/bundler` 与 `@remotion/renderer` 是 `4.0.519`，`@remotion/player` 是 `4.0.409`，根依赖又没有显式声明 `remotion`，但 Runtime 直接从 `remotion` 导入。npm 扁平化可能暂时可用，却会增加 Web Player 与正式 Render Worker 行为不一致的风险。

修复方式：显式声明 `remotion`，并将 `remotion`、Player、Bundler、Renderer 锁定为同一精确版本。

### P0-5：Renderer、Preflight 和 Attribution 对“当前真正使用的素材”可能理解不一致

预检收集 Timeline、Scene、EffectCue、Mask 和 SpeechAsset 的引用时，只遍历当前 Revision 中真正会被 Composition 渲染的 ready/active 对象；旧或 stale Scene/Cue 由失效清理与复核流程处理。

修复方式：建立一个内部 `CompositionReachabilityResolver`，由 Renderer、RenderPreflight、缓存失效和 Artifact 依赖共同复用。它是实现函数，不是第二份项目状态。

### P1：QualityIssue ID 不稳定

质量问题每次重新计算都生成随机 ID，会破坏 Web 中的已解决、重新出现、忽略和 Marker 关联。

修复方式：由 revision、code、objectId 和 frameRange 生成稳定键。

### P2：核心文件过大

`edit-application/src/index.ts`、`mcp.ts` 和 `app.ts` 已经影响审查和后续修改。按现有业务域拆分文件，继续保持模块化单体、同一数据库和同一项目状态中心。

建议按 `assets / speech / presenter / avatar / explainer / vlog / advanced / quality / jobs` 拆分；MCP 保留一个统一 registry 入口，具体 handler 下沉。

### P2：大文件导入和 Job Retry 的代码正确性

大视频当前仍可能整文件读入内存；外部生成任务的 Retry 需要区分 failed、running、unknown 和 succeeded，避免结果未知时重复生成。

这两项主要影响稳定性，不是当前审美闭环的第一优先级，但应在真实长素材测试前处理。

---

## 7. 阶段 1：Presenter 与通用剪辑闭环的漏洞

### 7.1 缺少真正的原素材审阅闭环

现有流程能够转写、建立 SemanticUnit、生成 Story、组装 Presenter、搜索 B-roll 和渲染 Preview，但还缺统一 `inspect_asset`。Codex 对人物 Take、停顿、手势、表情和切口的判断容易退化为只看文字或素材 ID。

这是阶段 1 当前对成片效果影响最大的缺口，应优先修复。

### 7.2 真实 V5 Skills 驱动的成片验收不足

现有脚本证明 MCP 和 Application 可以承载预先写好的决定，但不能证明 Codex 读取 V5 Skills 后会自主选择更完整语义、更合适人物 Take、更克制的动效和更相关 B-roll。

需要用真实人物口播完成一次由 Codex 实际驱动的端到端测试，并保存：选择与拒绝理由、源范围、Preview、完整审片和最终 Artifact。

### 7.3 对白声音只有编排，缺少受控清理链

当前 `manage_audio` 可以处理 BGM、SFX、增益、淡入淡出、Ducking 和事件位置，但没有完整的人声降噪、低频处理、齿音抑制、响度统一和 True Peak 收口。

第一版实现受控 Dialogue Processing：保留原音频，生成 derived audio，提供原声、最小处理和较强处理对比，再由真实试听选择。处理链按实际噪声、齿音、低频、响度和峰值问题启用。

### 7.4 Effect 内容合同不完整

Renderer 的占位和硬编码问题会让“技术能渲染”掩盖“内容不完整”。阶段 1 应为 11 种 Effect 分别定义最小内容要求，例如 ProductFan 必须有实际产品 Asset，CommentCloud 必须有真实评论文本，EvidenceCard 必须有证据素材和说明，EndCard 必须有项目文案。

### 7.5 外部素材只有 Pexels 实际接入，且本地化后仍缺真实审阅

当前 Skill 已明确 Pixabay、WebEvidence、Creative Library 和 MiniMax 仍是目标。短期不必补齐所有 Provider，但至少要让已下载候选经过 `inspect_asset` 再进入 Cutaway，避免仅凭标题和缩略图选片。

### 阶段 1 收口证据

- 两次重录人物口播能根据画面、声音和语义选择 Take；
- 主线不依赖动效掩盖；
- 至少一个真实 B-roll 候选被拒绝并记录理由；
- 一条候选通过源范围审阅后进入 Cutaway；
- 对白清理有 A/B 试听；
- Renderer 不出现占位文案；
- 完整 Preview 和 Delivery Artifact 经过五轮审片。

---

## 8. 阶段 2：Avatar 的漏洞

### 8.1 当前 Bridge 文档没有确认独立的数字人口型工作流

现有 Bridge 业务应用是 FunASR、OmniVoice 和四个 MiniMax H3 视频生成应用。多参考视频支持参考音频，不等于已经证明输出严格按 SpeechAsset 完成中文口型。

因此，代码中的 Avatar Provider、Job 和 ActorPerformance 可以标记为 implemented，但“可靠中文口型”必须通过真实 Live E2E 才能标记 live_verified。

### 8.2 自动 Mask 和姿态仍不完整

当前请求和布局主要支持无 Mask 降级与人工静态锚点。它可以验证前景摆放，但不能代表真正的人物前后景、逐帧姿态和手势互动已经完成。

需要分别验证：

- Provider 是否真实返回 Alpha 或独立 Mask；
- 头发、手部、快速运动和半透明边缘；
- ActorLayout 是否随人物运动更新；
- 无可靠 Mask 时是否诚实降级到左右安全区或全屏 Scene。

### 8.3 局部重生成只验证了对象链，未验证人物连续性

修改一句 Script 后只重生受影响段是正确架构，但还需要真实检查前后段身份、姿态、目光、服装、背景、语速和情绪是否跳变。

### 8.4 Avatar 输出缺少统一源素材式审阅

生成的人物视频进入 `inspect_asset range/dense`，检查口型、句首句尾、异常手部、眨眼和段间连续；Provider Job 结果、素材就绪、Preview 和交付审片分别记录。

### 阶段 2 收口证据

- 10～20 秒中文 SpeechAsset 的真实人物生成；
- 句首、长元音、爆破音和句尾口型实际观看；
- 一次局部 Script 修改和局部人物重生成；
- 有 Mask 与无 Mask 两条明确路径；
- 前景和后景效果不挡脸、嘴和字幕；
- 多段人物连续播放通过。

---

## 9. 阶段 3：Visual Explainer 的漏洞

### 9.1 当前 Delivery E2E 主要证明技术链，不证明解释效果

现有阶段 3 E2E 使用本地技术旁白、内部测试文本和离线页面截图，并且明确只导出 Draft，把听感、可读性和首次观众理解标为 inconclusive。它很好地证明 NarrativeMap、EvidenceCapture、Explainer Program、Preview 和 Artifact 能运行，但不能证明真实解释片不再像动态 PPT。

### 9.2 缺少真实内容和真实证据测试

需要至少一条 60～90 秒真实主题解释片，包含：真实网页/文档证据、关系或流程、数据场景、现实素材和收束。EvidenceDocument 需要展示来源全貌、聚焦、高亮和限制，而不是只展示项目自己生成的测试说明。

### 9.3 Scene Grammar 需要整片级节奏验证

单个 Entry/Progressive/Settled/Exit 正确，不代表连续六个 Scene 的节奏成立。需要检查：

- 是否每句话都换卡片；
- 大 Scene 内部是否真正保持对象和关系持续；
- Settled Frame 是否给观众阅读时间；
- 高密度解释后是否有恢复；
- 字幕、图形、证据和声音是否争夺第一注意力；
- Presenter、Explainer 和现实素材之间的切换是否有认知理由。

### 9.4 Explainer Skill 与代码能力必须同步

当前 MCP 已有 NarrativeMap、EvidenceCapture 和 Explainer Program；对应 Skill 应明确这些正式执行入口，使 Codex 能进入已有的编译、Preview 和质量链路。

### 阶段 3 收口证据

- 一条真实 60～90 秒解释片；
- 至少包含 Comparison、ProgressiveClassification、RouteAndFlow、EvidenceDocument 中多种 Scene；
- 真实来源和限制可以读回；
- 完整播放时不逐句 PPT 化；
- 首次观众能够复述核心关系和结论；
- Draft 和 Delivery 的证据边界明确。

---

## 10. 阶段 4：Vlog 的漏洞

### 10.1 当前 E2E 使用颜色块，不证明真实素材理解

现有测试用三段颜色、形状和不同音高验证 Shot Boundary、Event、Select、Montage、Ambient 和 Preview，适合代码回归，但不能证明 Codex 会理解猫咪回头、游泳转身、人物反应或真实事件。

### 10.2 Shot Detection 只是技术边界

FFmpeg 场景变化分数不能代表镜头功能、事件意义、动作完整或表演价值。必须增加 `inspect_asset`，让 Codex 在创建 Event Map 和 Shot Select 前实际查看源素材。

### 10.3 Event Map 和 Shot Select 目前容易变成人工填表

对象存在不等于导演判断成立。每个 Event 应能回到真实 Shot 和源范围；每个 Select 应说明镜头功能、选择理由、动作余量、现场声和连续性关系。不能由文件顺序或 scene score 自动填充。

### 10.4 动作、空间和情绪连续性缺少真实验收

质量规则可以发现明显空 Scene、重复范围和 Ambient 绑定错误，但无法自动判断：动作是否重复、方向是否突变、借用的反应是否真实、音乐是否吞掉现场感。这些必须通过真实素材和连续播放验证。

### 阶段 4 收口证据

至少使用三套真实素材：

1. 猫咪：声音触发、回头、移动、停下和反应；
2. 游泳：准备、入水、划水、转身、到达和呼吸；
3. 访谈式纪录：问题、回答、环境、听者反应和真实语境。

每套均比较“只用 Shot Boundary”与“加入 inspect_asset + Vlog Skill”的结果，观察事件结构、动作完整、选镜、现场声和节奏是否改善。

---

## 11. 阶段 5：增强能力的漏洞

阶段 5 本身是扩展池，不能因为代码里出现入口就统一标记“完成”。每项能力应分别标记 implemented、deterministic_tested、live_verified、editorially_verified 和 delivery_ready。

### 11.1 `word_exact` 强制对齐缺少已确认业务工作流

当前 Bridge 文档只确认六个业务应用，没有列出独立词级强制对齐应用。代码允许传入 workflow ID 并校验对齐结果，这是正确的 Adapter 设计，但在真实 Provider、Schema、中文音频和 Live E2E 完成前，不能把逐词字幕和词级动效视为正式能力。

### 11.2 多机位当前主要是固定偏移同步

当前首版说明只支持相机内录，并把自动相关结果作为 candidate。尚需真实验证：

- 不同设备的时钟漂移；
- 长时间素材的非线性偏移；
- 独立录音机；
- 说话人切镜头；
- Program Cut 与现场反应；
- 多机位完整 Preview 和声音主轨。

### 11.3 Restricted Remotion Scene 不等于 Shader Runtime

现有受限 Scene Registry、CSS/SVG/React 动效可以继续使用，但它不等于 WebGL/GLSL Shader。若阶段 5 文档包含 Shader、LUT、像素级畸变或 GPU 转场，应继续标记未实现，不能因为存在 Blur、Glow 或 Mask 就称为 Shader 系统。

### 11.4 音乐生成仍缺正式 Provider 闭环

当前 Bridge 业务应用没有音乐生成。BGM 编辑、循环、淡入淡出和 Duck 已经是编辑能力；“生成合适音乐”仍需单独 Provider、真实试听、结构摆放和授权结果，不能由代码入口或提示词替代。

### 11.5 长视频与大量对象的性能尚未验证

所有阶段都铺开以后，需要真实测试：

- 数小时素材；
- 数百 Shot；
- 大量 Revision；
- 多个 Explainer Scene 与缓存；
- 大文件流式导入；
- Preview 局部失效；
- SQLite Snapshot 体积和恢复时间；
- Worker 崩溃后的 Job 对账。

这属于阶段 5 的工程成熟度，不应等到真实项目崩溃后才处理。

---

## 12. 建议开发顺序

这一轮聚焦以下开发顺序：

### 第一批：恢复可信基线

1. 修复当前 CI；
2. 删除 `docs/` 中第二棵可执行 Skills；
3. 同步 Avatar、Explainer、Vlog Skills 与 MCP；
4. 移除 Renderer 占位文案和硬编码 EndCard；
5. 统一 Remotion 版本；
6. 统一 CompositionReachability。

### 第二批：素材审阅闭环

1. 实现 `inspect_asset` 的 overview、range、dense；
2. 在 Assets / Inspector 中增加源素材播放器、Contact Sheet 和短范围循环；
3. 新增 `_shared/SOURCE_REVIEW_METHOD.md`；
4. 按本文第 4 章更新现有 Skills；
5. 增加 MCP 合同和缓存测试。

### 第三批：真实视频验收

1. 人物口播重录与停顿测试；
2. Avatar 中文口型与局部重生成；
3. 真实 60～90 秒 Explainer；
4. 猫咪、游泳、访谈式 Vlog；
5. Presenter → Explainer → Vlog → Presenter 混合成片。

### 第四批：效果问题集中修复

根据真实成片处理：

- 语义断裂和选错 Take；
- B-roll 弱相关；
- 动效密度与占位内容；
- 字幕、人物、证据和动效争抢；
- Dialogue 清理和音乐层级；
- Avatar 连续性；
- Explainer PPT 感；
- Vlog 事件与现场感。

### 第五批：代码治理

1. 稳定 QualityIssue ID；
2. 大文件按业务域拆分；
3. 大文件导入改为流式；
4. Job Retry 增加状态对账；
5. 加入长素材和大量对象压力测试。

---

## 13. 自动化与真实验收矩阵

| 验收层 | 自动化可以证明什么 | 不能证明什么 |
|---|---|---|
| 单元 / Contract | Schema、Revision、依赖传播、缓存、对象关系 | 素材选得好、节奏自然 |
| 确定性 E2E | MCP → Application → Preview → Artifact 可运行 | 真实事件理解、表演和审美 |
| 源素材审阅测试 | Contact Sheet、短代理、dense 范围可访问 | Codex 一定作出最佳选择 |
| Skill 行为测试 | Codex会比较证据、候选和反事实 | 最终观众一定喜欢 |
| 真实成片审片 | 语义、动作、表演、声音、注意力和节奏成立 | 不能由一次成功外推所有题材 |

每个阶段的“完成”至少要同时具有：

```text
代码已实现
+ 确定性测试通过
+ 真实素材链路通过
+ 完整声画审片记录
```

阶段 5 的外部 Provider 能力还需要额外的 Live E2E。

---


## 14. 可直接交给 Codex 的开发任务

```text
以当前 main、docs/ai_video_platform_architecture_development_plan.md V6.2
和根目录 Professional Skills V5 为唯一基线。

本轮主题：Source Review & Editorial Understanding 收口。
沿用现有主工作流、现有领域对象与 Editing Application 单一项目状态中心。

第一步修复当前基线：
1. 修复 CI；
2. 删除 docs 中第二棵可执行 Skills；
3. 更新 skills-v5-integration.test.ts 中已经实现的工具分类；
4. 同步 Avatar、Explainer、Vlog Skill 与当前 MCP；
5. 删除 Renderer 的调试占位和硬编码 EndCard；
6. 统一 remotion / player / bundler / renderer 的精确版本；
7. 让 Renderer、Preflight 与 Artifact 共用实际 Composition Reachability。

第二步实现统一只读 inspect_asset：
1. 支持 overview、range、dense 三种证据密度；
2. 返回源时间坐标、联系表、短代理、转写、音频概览、前后 Shot 和当前使用位置；
3. 所有派生文件进入 project/cache/source-review，作为可重建缓存；Revision 仅保存正式项目事实；
4. overview 负责低密度概览；dense 仅用于短窗口精确复核；
5. Web Assets / Inspector 能打开、循环和比较源范围；
6. Browser Operator 可按 Asset ID 和源范围稳定定位。

第三步更新 Skills：
1. 新增 .agents/skills/_shared/SOURCE_REVIEW_METHOD.md；
2. 按本文第 4 章增量更新 project-basics、production-director、
   presenter-motion-director、semantic-continuity、visual-treatment-planning、
   visual-asset-sourcing、cutaway-planning、vlog-director、
   visual-explainer-director、evidence-visualization、audio-finishing、captions、
   remotion-production、avatar-performance、quality-verification、web-editor-operator；
3. 将本文第 4 章给出的正文按目标文件直接写入现有 Skills，并保持当前主工作流与专项 Skill 的职责边界；
4. 专业判断使用本文已经给出的连续解释；列表只用于执行步骤和最后防漏。

第四步真实验收：
1. 两次重录人物口播；
2. 中文 Avatar 口型与局部重生成；
3. 真实 60～90 秒 Visual Explainer；
4. 猫咪、游泳和访谈式 Vlog；
5. Presenter + Explainer + Vlog 混合项目。

自动化测试负责结构和代码，完整声画审片负责效果。
发现架构或 Revision 错误立即修复；审美问题进入真实成片复盘后集中修正。
```

---

## 15. 最终完成标准

完成本轮以后，VideoFlowCut 应具备以下从素材证据到成片验证的真实闭环：

```text
Codex 看得到真实原素材
→ 知道粗略证据与精确证据的边界
→ 使用现有专业 Skills 比较 Take、动作、反应、声音和候选素材
→ 判断结果写入当前既有项目对象
→ Timeline 仍由确定性代码编译
→ 完整 Preview 重新验证选择是否成立
```

最终效果提升不来自更多固定规则，而来自：

```text
更可靠的素材证据
+ 更专业的判断方法
+ 更清楚的主工作流责任
+ 更早的真实声画复核
```
