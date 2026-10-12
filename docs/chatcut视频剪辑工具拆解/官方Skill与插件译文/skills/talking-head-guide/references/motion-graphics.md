### 视觉身份

Design Style 是视频已经确认的视觉语言。它为 MG 提供共同的语气、色彩逻辑、字体排印逻辑、视觉密度和运动语言。它让不同 MG 属于同一个家族，而不会强迫它们采用相同形状。它不决定哪些 MG 有用、何时出现、放在哪里，或是透明 / 不透明；这些仍然是每个 MG 独立的编辑决策。

在规划 MG 时刻之前先解决视觉语言。实际的风格对齐交互和实现细节使用活动 MG 工作流：

- **活动 Design Style**——除非用户要求改变整体风格，否则使用它。如果 Project Context 指出了活动 Design Style 但没有显示详情，在规划 MG 时刻前使用 `manage_design_style action="get"` 检查一次。
- **用户指定的风格 / 参考**——遵循它。如果它是自定义方向，而且尚未针对批量工作确认，则在用户需要批准外观时，用一个真实计划中的 MG 作为样例。
- **宽泛或模糊方向**——clean、premium、modern、professional、polished 或 YouTube-style emphasis 等质量词是目标，不是视觉语言。遵循活动 MG 工作流的风格对齐闸门：优先提供视觉 Preset 选项；当方向是文字 / 自定义时，使用一个代表性 MG 进行确认。
- **没有视觉方向**——使用活动 MG 工作流展示相关视觉 Preset 选项。可用时，Talking-head 可以作为 Catalog Filter。
- **“直接做” / “不要问”**——根据文字稿和画面选择一个具体的临时方向，然后在不进行用户风格确认的情况下继续。不要根据这个未经确认的猜测创建或更新 Design Style。

Picker 是视觉 Design Style 选择器。它展示 Preset 缩略图，让用户通过观看来选择视觉方向，而不是用文字描述风格。

1. 调用 `manage_design_style`，传入 `action: "list_presets"`，在场景明确时传入 `scenario: "talking-head"`，并传入用户的 `locale`。把 Scenario 用作 Catalog Filter，然后根据 Preset 描述和实际视频上下文选择合理的视觉选项。
2. 使用活动 Form/Widget 路径，把合理的返回 Preset 渲染为视觉选项；有视觉缩略图时，不要用纯文字风格名称替换它们。
3. Picker 是一次 Turn Boundary：展示后停止，等待用户提交选择。
4. 用户选择某个选项时，调用 `manage_design_style`，传入 `action: "apply_preset"` 和所选 `presetId`；然后在编写前使用 `action: "get"` 检查已应用的 Design Style。
5. 如果用户用文字回复而不是选择，把它视为用户方向，并沿自定义方向路径继续。

只持久化已经确认的视觉语言：

- **已选 Preset**——用户通过选择视觉选项确认了它。调用 `manage_design_style action="apply_preset"`。
- **自定义方向**——用户接受样例后，把它视为当前 MG 工作已经确认的方向。如果当前环境支持保存 Project Design Style，并且用户接受它作为共享 Project 风格，则使用已约定的风格事实保存/应用。
- **未经确认的猜测**——不要创建或更新 Design Style，包括用户说“直接做”时。

应用 Preset 或把自定义方向确认为 Project 风格后，用一两句自然语言告诉用户：这现在是视频的视觉风格；本视频后续 MG 默认会遵循它；以后仍可更改或调整。

### MG 适用的位置

当内容包含以下信息时，MG 能够实质性帮助理解或定位：

- **身份 / 上下文标签**——说话者姓名、角色、产品名称、日期、来源，或小型持续章节标签。
- **关键信息 / 引语**——值得强调的核心概念、定义、统计数据、结论或关键句。
- **结构化信息**——多个要点、步骤、比较、排名、列表或流程。
- **章节 / 话题标记**——开场标题、章节标题、话题转场，或章节之间的视觉分隔。
- **抽象概念**——因果关系、循环、系统、框架，或其他难以通过口头表达跟上的想法。

### 重复组件

一个视频通常应拥有一种视觉语言，但不应只有一种通用 MG 形状。

只有对于同一组件有意重复的实例，才复用一个 Motion Graphic Asset：相同的观众任务、相同的信息结构、相同的视觉形式，并通过属性改变内容。重复章节标记、反复出现的章节标签或重复状态 Badge 可以共享一个 Asset。开场标题、章节标记、引语、列表、图表和 CTA 等不同任务，通常应使用不同 Asset，但共享色板、字体排印、运动语气、间距和材质处理。

被接受的第一个 MG 证明该视觉语言在画面中有效。它不会自动成为无关 MG 的模板。

### 每个 MG 的决策

对于 talking-head 视频，不要只根据文字稿时序开始创建 MG。先检查目标帧：文字稿告诉你“什么”和“何时”；画面告诉你形式、放置和背景。

创建 MG 前，做出四个相互关联的编辑决策。它们为活动 MG 工作流和之后的 Timeline 放置做准备。

| 决策                   | 问题                                                   | 输出                                                        |
| ---------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| **内容**               | 哪个想法值得增加视觉层？                               | MG 表达的信息或视觉事实。                                   |
| **时序**               | 它应在语音的哪个时刻出现？                             | Timeline 起点、时长、阅读时间和内部运动节拍。               |
| **形式和放置**         | 它是什么类型的 MG，可以安全地放在哪里？               | MG 形式 / 尺寸，然后在 Asset 创建后进行 Timeline 放置。    |
| **背景**               | 它叠在 talking-head 镜头上，还是成为独立时刻？         | 透明叠层，或不透明 / 全屏节拍。                             |

#### 只适用于需要 Brief 的生成器工作流

只有当活动 Motion Graphics 工作流明确要求你为另一个模型或生成器编写生成 Brief 或请求时，才使用本小节，例如 Gemini / motion-graphic-gen。

Codex 直接编写工作流跳过本小节。如果你使用 `create_motion_graphic_from_code` / `edit_asset` 自己创建或编辑 JSX，不要使用 `referenceAssetIds`、`:template`、`:style`、Role Anchor 或 Gemini Brief 语言。

对于生成器工作流，把视觉语言带入工具调用。目前 Template 是生成参考，不是直接应用目标。来自 Design Style 的 Template Ref 与其他 Template ID 没有区别。对于新 MG Asset，只传入一个代码参考来源：只有当视觉任务、结构和画布角色都相同时，才使用同角色 Role Anchor，传入 `referenceAssetIds: ["<roleAnchorAssetId>:template"]`；否则直接使用匹配的 Template ID，例如 `referenceAssetIds: ["<templateId>:style"]`。如果没有匹配 Template，在 Brief 中写入已确认 Direction，并且任何已接受的 Role Anchor 只能用于同一角色。Template 的 Slot 数量不是用户约束：如果用户要求的 Bar、Row、Item 或数据点多于/少于 Template 展示的数量，应生成新结构，而不是让用户适配 Slot。

传入 Template 或 Role Anchor 时，让 Gemini Brief 聚焦内容、角色 / 大致形式、背景和画面约束。详细风格和运动语言由参考提供。

把四个共同决策映射到生成器 Brief：

- **内容** -> Brief 中的 `Content`。
- **时序** -> Timeline 起点；只有 MG 自己具有节拍时才增加内部 `Timing`。内部 `Timing` 值说明每个元素在_何时_出现，而不是_如何_移动；运动风格交给 Gemini。
- **形式和放置** -> Brief 中的 `Size & shape`，而不是最终画布放置。不要把最终 `left`、`top`、`right`、`bottom`、坐标，或 "lower-left" / "top-right" 等放置 Anchor 写进 Gemini Brief。
- **背景** -> `Background: transparent` 或 `Background: opaque`。

#### 1. 内容

选择 MG 表达的内容，而不只是它重复的文字。内容可以是说话者身份、提炼后的引语、关键术语、统计数据、列表、比较、关系图、章节标记，或对该观点的其他视觉表达。

#### 2. 时序

先选择 Timeline Anchor。MG 应与相关语音节拍或章节边界同时落下，而不是等说话者已经表达完观点后再跟上。使用 `find_transcript`；当 MG 具有内部节奏，例如列表项逐个出现或多步骤 Reveal 时，传入 `includeWordTimestamps: true`。

内部 Timing 值应相对于 MG 自己的起点。Timeline Item 起点是视频中的绝对位置；内部 Timing 是该起点之后 MG 内部的节奏。观点完全表达后退出。

#### 3. 形式和放置

创建 Asset 前，选择 MG 形式和可能的放置区域。活动 MG 工作流负责创建 Graphic；完成的 Asset 之后再放到视频画布上。

放置原则：

- **保护主体和安全区域。** 避开说话者的脸、头、头发、眼镜、嘴、下巴、重要产品或物体、相关手势、字幕以及现有屏幕元素。
- **保持字幕区域清晰。** 如果可能出现字幕，底部叠层必须位于字幕带上方，不能与字幕竞争或遮挡字幕。
- **区分叠层和全屏 MG。** 主体/安全区域保护适用于叠在 A-roll 上方的内容。全屏 MG 是有意替换 A-roll 的视觉节拍，因此在其持续期间可以覆盖说话者和背景。
- **保持构图有意图。** MG 应支持说话者和信息。它不应看起来像随机贴纸、与脸部竞争，或让画面失衡。

常见形式和区域：

| 内容类型                 | 常见形式                                                 | 常见区域                                                                                                                        |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **身份 / 上下文**        | 姓名标签或小型上下文标签                                 | 优先 Lower Third；根据镜头使用左下或右下。                                                                                      |
| **关键信息 / 引语**      | 字体排印引语、Pull Quote 或强调处理                      | 下中 / Lower Third；底部拥挤时使用侧边区域；重大金句、结论或停顿可以全屏。                                                       |
| **结构化信息**           | 列表、步骤堆栈、比较布局或紧凑图表                       | 左/右侧区域或底部横向区域；信息过密、无法作为叠层时使用全屏。                                                                   |
| **章节 / 话题标记**      | 全画面标题、标题叠层或侧边标题 Panel                     | 强开场或章节分隔使用全屏；轻提示使用 Lower Third；一侧有明显空白时使用侧边 Panel。                                               |
| **抽象概念**             | 概念视觉、关系图、循环、框架、Chart                      | 内容轻且能在字幕上方清楚阅读时用 Lower Third；更密集时使用侧边区域或全屏。                                                       |
| **微小辅助标签**         | Badge、状态标签、类似 Logo 的标记、章节标记              | 只有这类内容可以使用顶部角落。不要把左上/右上作为主要开场标题或章节标题的默认位置。                                               |

决定 Asset 形状时，使用 MG 自身的形式约束，而不是最终画布放置。好的示例："lower-third-style name tag"、"compact side treatment"、"bottom horizontal strip"、"full-screen title beat"。除非 MG 有意全画面显示，否则不要把最终画布坐标固化进 Asset。

对于说话者姓名标签等熟悉形式，给出形式和内容，不要过早强制尺寸。对于受约束的叠层，描述预期大致形式或可用区域。对于全屏 MG，在 **Size & shape** 中明确形式，并选择 `Background: opaque`。

只有当目标截图的画布色调影响可读性时才把它写入 Context，例如：`Other context: dark interior scene — keep the design bright/light enough to read clearly.`

#### 4. 背景

根据形式选择背景：

- talking-head 叠层使用 `Background: transparent`：Lower Third、侧边处理、引语处理、紧凑图表，以及其他叠在 A-roll 上方的 Graphic。透明 Root 内仍可包含半透明或实色 Panel。
- 当 MG 本身就是独立视觉表面时，使用 `Background: opaque`：全屏开场标题、强章节节拍、全屏信息布局和全屏强调时刻。
- 对于全屏不透明 MG，不要在下方添加单独的 `solid` Item 作为 Color Matte。MG 自己拥有整个画面；改为修改它的 `bgColor` / `transparentBackground` 属性。不要创建临时 Solid Fallback；如果在用生成的不透明 MG 替换旧版“透明 MG + Solid”Fallback 时遇到该结构，应删除两个 Fallback 组成部分，而不只删除旧 MG。

除非有意使用全屏节拍，否则默认透明叠层——静默猜测全屏/不透明会遮住说话者的脸，或让画面变空白。

#### 放置与审阅

- 使用 `edit_item`（Adds/Updates）放置。了解画面后，优先使用明确矩形：直接放置使用 `left/top/width/height`；当右侧/底部 Margin 更清楚时，使用 `right/bottom/width/height`。
  - **`left`**——明确 X 位置。**`right`**——距离画布右边缘的 Margin。不要同时传入两者。
  - **`top`**——明确 Y 位置。**`bottom`**——距离画布底边的 Margin，与 `right` 对称，例如 `{ right: 80, bottom: 150, width: 500, height: 350 }` 表示右下叠层。字幕安全默认值：`bottom: 162`（横屏 1080p）或 `bottom: 576`（竖屏 1080×1920）。不要同时传入 `top` 和 `bottom`。
- 叠层使用 Natural-box Asset：MG Asset 的 `width` / `height` 应紧密包围局部可见构图，而不是 Project 画布。把这个局部 Asset 放置并缩放到 Timeline 上。只有可见设计有意跨越整个画面时，才使用 Timeline 尺寸的 Asset。
- 来自 `track_progress` / Project 状态的 Asset 尺寸是调整大小和放置时的实用辅助，不是最终判断标准。
- 使用截图验证。一次工具调用传入多个帧——Settled State 会与任何短暂动画中间帧一起出现。**下结论前比较各帧**：只在批次中部分帧可见的表面截断、元素缺失或“设计损坏”可能只是动画，而不是真实缺陷。如果不明确，在调整前围绕可疑帧重新捕获更多帧。根据 Settled Frame 判断。放置多个 MG 时，把它们的 Settled Frame 批量放进一次调用。
- 检查完整画面：脸部/头部清晰、重要物体和手势清晰、相关时字幕区域清晰、MG 完整可见、MG 内容正确、文字可读、没有可读文字互相重叠，并且构图平衡且有意图。
- 如果失败，先调整位置和大小。如果位置/大小无法解决，编辑 Asset 或改变设计形式。扩展重复组件之前，先在目标帧验证每一种有意重复的组件。

