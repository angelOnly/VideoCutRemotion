---
name: create-motion-graphics
description: "当 ChatCut Desktop 中的 ACP 或本地 CLI Agent 需要在 Project 中添加、创建、手工编写、修补或放置 Motion Graphic JSX Asset 时使用。涵盖直接内联 JSX 编写、视觉语言、可编辑属性、Asset 绑定、Timeline 放置和本地验证。不适用于内置 ChatCut Agent。"
---

# 创建 Motion Graphics

当 ChatCut Desktop 中的 ACP 或本地 CLI 任务需要以内联 JSX 编写或修补 Motion Graphic Asset 时，使用本 Skill。内置 ChatCut Agent 改用 `motion-graphic-gen` 和 `submit_motion_graphic`。

ACP/本地 CLI Motion Graphics 由 Agent 直接编写。新 JSX Asset 使用 `create_motion_graphic_from_code`，现有 MG JSX 使用 `edit_asset`。此表面不提供 `submit_motion_graphic`；不要把请求转换成 Gemini Prompt 或生成 Brief。如果直接编写工具缺失，停止并报告 ChatCut 工具表面已经过时。

通过 Desktop MCP 工具路径以内联方式传入 Motion Graphic 源码。当工具可以直接接受内联 JSX 时，不要把代码暂存到 ChatCut 仓库、`ai-working/`、`/tmp`、本地 HTTP Server、生成的代码文件或猜测的应用路径中。

## 核心原则

- 当画布大小、fps、现有视觉语言、放置位置或 Timeline 冲突尚不清楚时，检查 Project 状态。
- 编写 JSX 前，在 **Before You Code** 中识别所需输入。
- 通过可用的内联代码 Asset 工作流创建或更新 Motion Graphic Asset；使用当前工具 Schema 确定准确 Payload 形状。
- 当编辑需要 Timeline 放置时，通过 Timeline 编辑工作流放置或移动 Asset。
- 结构或视觉变化后，重新读取 Project 状态并验证可见帧。

## 编码前

编写 JSX 前，只识别本次编辑所需的信息：

- **放置**：起始时间、时长、已知时的目标层，以及 Graphic 必须与之构图的目标帧。
- **在剪辑中的角色**：这个 Motion Graphic 在视频中承担什么任务。
- **内容**：必须出现的准确文字、数字、媒体或视觉事实。
- **时序**：内部运动是否应与语音、音乐或视觉事件同步。
- **视觉来源**：用户提供的风格、Project Design Style、品牌色/字体，或已接受的现有 Motion Graphic。
- **可编辑字段**：哪些文字、颜色、数字、Boolean、图片或视频值应成为属性。

只询问缺失且会实质改变结果的高杠杆输入。

## 与用户对齐

你是初级设计师；用户是负责人。方向是高杠杆选择——编写前把它显式呈现，比完成后重新编写便宜得多。

风格对齐闸门：

把视觉方向与批量许可分开。用户命名的文字/自定义风格可以决定方向，但在用户确认一个代表性 MG 前，它不允许创建多个 MG。只有活动 Design Style、已选择的视觉 Preset，或此前已经接受的代表性 MG，才能授权批量编写。

- 如果没有活动 Design Style，而且用户没有命名风格，在编写前停止，让用户选择方向。
- 宽泛质量形容词是目标，不是已命名视觉风格。如果用户只说 MG 应当 clean、premium、modern、professional、polished 或类似表达，使用视觉 Preset 缩略图，不要自行发明方向。
- 优先使用 Catalog Design Style Preset：调用 `manage_design_style` 并传入 `action: "list_presets"`，展示 3–6 个合理视觉选项，让用户选择或覆盖。
- 加载 `widget-forms`，并输出一个带准确 Preset ID 的 ChatCut `<widget><form-visual>` Picker。不要调用 `ask_followup_questions` 或 `visualize.show_widget`。
- 可以推荐其中一个选项，但仍要展示完整选项集合。目标是视觉对齐，不是给出一个单一最佳猜测。
- 当不明显时，还要询问 MG 是叠在视频上的 Overlay，还是占据整个画面。

编写前选择分支：

- 一个 MG：使用活动 Design Style、已接受样例或用户命名的方向并继续。
- 多个 MG，且已有活动 Design Style、已选视觉 Preset 或此前接受的代表性 MG：使用批量 Design Map 继续。
- 多个 MG，只有文字/自定义方向，无论多清楚：准确创建一个代表性 MG，放置它，渲染合成帧，然后停止等待确认。用户确认前，不要创建第二个 MG Asset 或 Item。
- 多个 MG，只有宽泛质量形容词：先使用视觉 Preset Picker。

当任务需要视觉风格对齐时，先检查活动 Project Design Style。如果没有活动 Design Style，而且用户没有给出清楚风格方向，使用上面的风格对齐闸门。

用户保存的 Design Style 是 Library，不代表 Project 已确认。如果 `manage_design_style list` 显示保存的 Style，但没有活动 Project Design Style，不要静默推断或选择其中一个；使用 `list_presets` 和视觉对齐，除非用户选择了某个保存 Style 或要求使用它。

Catalog Design Style Preset 可作为带图片预览的视觉风格选项。当没有活动 Design Style 或用户风格时，先使用 `list_presets` 查看可用 Catalog 候选，并展示 3–6 个合理视觉起点。它们不必匹配用户请求的每一个细节；Preset 缩略图用于建立有用的视觉预期，编写时仍可适配。优先使用视觉选项而不是纯文字选项，因为看到效果通常比命名效果更清楚。当没有任何 Catalog Preset 合理接近时，不要强迫使用；只有此时才用文字方向。

使用 Catalog Preset 时，调用 `manage_design_style` 并传入 `action: "list_presets"`；只有场景明确时才传 `scenario`。当有足够多合理匹配时，根据每个 Preset 的 `description` 作为面向 Agent 的匹配指导选择 6 个；只有确实没有 6 个适配项时才减少。绝不要把完整 Catalog 渲染成用户选项。把每个准确返回 ID 放入 `<visual-option preset-id="..."/>`；ChatCut 会解析当前名称和缩略图。不要为 Catalog 选项发明 `value`、`name` 或 `media`，也不要在同一个视觉 Picker 中混入自定义非 Preset 方向。如果自定义方向会有帮助，在 Picker 外用普通文字描述。除非用户要求详情，否则不要在 Picker 下重复 Catalog 描述。把 Catalog 选项表述为视觉起点，而不是强制选项：用用户的语言简短说明，他们可以选择接近的选项，也可以描述不同方向。如果用户要求刷新，再次调用 `list_presets`，展示另一组最多 6 个合理匹配。不要重复当前风格选择交流中已经展示的 Preset；宁可少于 6 个，也不要重复。使用 `action: "apply_preset"` 应用用户选择。应用 Preset 或保存 Style 后，在编写 MG 代码前调用 `manage_design_style` 并传入 `action: "get"`；Preset 名称和 `list_presets` 描述只是 Picker 指导，不是完整运动/设计规范。不要根据未经确认的推荐创建或更新 Design Style。

视觉风格 Picker 是一次 Turn Boundary。输出 Widget 后停止。在用户选择出现在聊天中之前，不要应用 Preset、创建 MG Asset、检查更多帧，或根据自己的推荐继续详细 MG 规划。

对于同一个场景或话题中的一批相关 MG，只询问一次共享方向——不要为每个 Item 发明不同美学，也不要逐个 MG 询问。

当批量方向是文字或自定义，而不是视觉 Preset 或活动 Design Style 时，上述代表性 MG 闸门是硬停止点。用户命名的文字风格只会跳过 Preset Picker；它不会确认多个 MG 的视觉语言。代表性 MG 只验证视觉语言；它不会定义之后每个 MG 的形式。

只有以下情况跳过风格 Picker：

- 用户已经命名视觉风格、材质、参考或视觉语言（"做 editorial 杂志风的"、"做个 80s 复古印刷"、"magazine style 那种"）——逐字把它作为方向。对于多个 MG，在用户确认样例之前，这仍进入代表性 MG 分支。
- 用户明确跳过对齐（"直接做" / "don't ask, just do it"）：做出最佳猜测，在聊天中说明该方向，然后继续正常编写、帧检查和一致性工作流。

## Project 视觉语言

使用活动 Project Design Style、用户提供的风格、品牌 Asset，或已接受的现有 Motion Graphic，作为手工编写 JSX 的视觉语言。视觉语言意味着共享色板、字体排印逻辑、运动语气、间距、密度、材质处理和完成度。

Design Style 活动时，从完整 `designSpec` / `styleGuide` 工作，而不只看名称或 Catalog 摘要。把运动、字体排印、颜色和材质的明确风格规则视为实现约束。

把 Design Style 的结构、材质和 Template Note 视为视觉词汇，而不是默认容器。通过字体排印、标记、几何、纹理、运动、间距和材质表达风格；只有当有限边界的阅读表面确实是编辑机制时，才使用有边界的阅读表面。

不要仅仅因为一次性 Motion Graphic 需要样式，就创建或更新 Project Design Style。对于同一视频中的多个 Motion Graphic，保持一套连贯视觉系统，除非用户要求有意对比；让每个 MG 的内容和编辑任务决定其形式。

## 视觉系统与放置

把同一视频中的多个 MG 视为一个视觉系统。共享风格来自色板、字体排印、运动语气、间距、材质和完成度。

批量编写前，为计划中的 MG 制作紧凑 Design Map：观众任务、内容、视觉机制、它如何在文字之外承载含义、语音范围、Settled Frame、阅读时间、大小、构图关系、内部运动节拍，以及其形式是否有意重复。

让每个 MG 的内容和编辑任务决定形式。保持相同视觉语言，同时选择适合该时刻的构图、大小、放置、时长和节奏。

编写 JSX 前选择视觉机制。使用已确认视觉语言和内容的观众任务，决定 Graphic 如何在文字之外承载含义。只有当有边界的阅读表面确实是正确机制时，才把 Wrapper 命名为形式。

文字很少应独自承担整个 Graphic。把关键词、统计数据或主张与具体的非文字视觉角色结合，让结果不只是 Wrapper 中的文案。

常见默认值必须有存在理由。只有当有限边界阅读确实是编辑机制时，才使用有边界的阅读表面；否则让 MG 形式来自画面关系和观众任务。

只有对于观众任务、信息结构和视觉形式都相同的有意重复组件，才复用 MG Asset。共享色板、字体排印、运动或有边界表面处理属于视觉语言，不是复用同一 Asset 的理由。

放置和时长属于 Settled Frame 构图的一部分。根据语音范围、已检查帧、阅读时间和视觉任务之间的关系，选择每个 MG 的位置、大小、Anchor、起点和终点。不要把固定 Safe Zone 作为默认放置；只有画面关系和观众任务重复时，重复 Anchor 才是有意设计。如果 Graphic 与它解释的时刻没有整合感，改变形式、时序、Scale，或跳过。

使 MG Asset 时长与它要占据的 Timeline 范围一致。内部运动节拍必须在已放置 Item 时长内完成；当编辑时序发生实质变化时，更新或重新创建 MG，不要依赖更短的 Timeline Item 截断更长 Asset。

批量工作中，并排比较合成的 Settled Frame。MG 应共享视觉语言，但重复表面、Anchor 或节奏应指向重复观众任务；否则在报告完成前修改形式、放置或时序。

创建适合当前任务的 Asset 形状。对于 Overlay，Asset Box 应紧密包围可见 Graphic 的局部构图。只有可见设计有意跨越整个画面时，才使用 Timeline 尺寸。

## 可编辑属性

把用户可见且可能改变的值公开为可编辑属性。

- 可见文字、主色、强调色和关键数字值应成为属性。
- 当用户可能合理改变字体时，字体选择应成为 `font` 属性。
- 图片和视频来源必须是 `image` / `video` 属性。
- 代码 Key 必须与 Property Schema Key 完全一致。
- 从 `item.props` 读取值；不要硬编码用户之后可能合理希望改变的可见内容。
- Item 级 Property Override 只用于观众任务、信息结构和视觉形式都相同的有意重复组件。如果其中任何一项不同，应创建另一个 MG Asset，并只共享色板、字体和运动逻辑。

Property Entry 应声明稳定 Key、面向用户的 Label、Type 和 Default Value。支持的 Property Type 包括 text、number、color、boolean、select、font、image 和 video。

## 字体

Motion Graphics 必须使用 ChatCut Renderer 可用的字体，使预览和本地导出保持一致。不要依赖 `STKaiti`、`PingFang SC`、`Microsoft YaHei`、`Arial`、`Helvetica`、`Comic Sans MS`、`system-ui`、`-apple-system` 或通用 CSS Family 等机器专属系统字体作为主要渲染字体；不同机器的可用性不同，可能触发 Fallback。

选择或替换字体时，调用 `search_fonts`，并逐字使用返回的 Canonical Family Name 作为 `fontFamily` 值，以及匹配 `font` 属性的 `defaultValue`。使用 Catalog 返回的 Google Fonts 或 Project 自定义字体。如果用户要求的机器专属字体不在 Catalog 中，说明无法保证一致的本地渲染，搜索感觉相似的受支持替代字体，并使用它，除非用户明确接受字体 Fallback。

## Asset

Motion Graphics 内渲染的图片和视频必须已经登记为 Project Asset，或通过可编辑 Asset 属性传入。

- 不要在 JSX 中硬编码媒体 URL。
- `<Img>` 和 `<Video>` 只能使用从 `item.props` 读取的 URL。
- 渲染前保护空图片/视频属性；空 `src` 可能导致运行时崩溃。
- 要为某个 Timeline 实例替换渲染 Asset，更新该实例的可编辑属性值，而不是修改共享 Asset 代码。

## 设计原则

当前活动 Desktop Agent 是直接编写 Motion Graphics 的设计师。不要只是满足约束，或把文字放进 Wrapper。编写 JSX 前，把 Settled Frame 设计成一个具体视觉对象。

编写代码前决定：

- **目的**：因为这个 MG 存在，观众应该更快理解什么。
- **方向**：具体视觉语言，而不只是 "clean"、"modern" 或 "professional"。
- **记忆点**：3 秒后观众应记住的一个视觉想法、空间动作或运动节拍。
- **机制**：字体排印、几何、图表、纹理、图片或运动如何在文字之外承载含义。
- **工艺**：字体排印、颜色、运动、空间构图和材质处理如何遵循所选方向。

编写代码前，为这个具体设计选择清楚的美学方向。坚定执行一个方向，而不是回退到泛化外观。

默认质量标准：有辨识度、达到生产级、具有明确意图。当用户没有指定风格但要求继续时，选择一个有观点的具体视觉方向。不要仅仅因为风格未指定，就回退到安全、基础或泛化设计。

克制不等于平淡。Minimal 或精致 MG 仍然需要已命名的设计语言、准确层级和一个令人记住的视觉决策。

把 Design Style 的运动语言视为约束，而不只是 Mood。如果它要求 Hard Cut、无 Opacity、无 Translate、无 Glow、无 Easing、逐词、静态 Bar 或顺序 Node，就逐字实现；不要替换为 Fade、Spring、Sweep、Glow 或漂移动画。

运动必须有存在理由。不要把 Shine、Sheen、Light-sweep、Scan-line、Shimmer、Glow 或 Glossy Pass 作为默认润色；只有风格或编辑任务明确表示扫描、加载、反射、能量或检测时才使用。优先使用字体排印、Mask、Stagger、Data Bar，以及与内容绑定的时序。

材质处理属于视觉语言。不要只为了让表面显得经过设计，就添加 Glass、Blur、重阴影、Gradient、Grain、纸张纹理、Glow 或其他表面润色；只有已确认风格或视觉任务要求这些材质时才使用。

Graphic 包含文字时，建立清楚层级。存在 Design Style Type System 时使用它。没有定义 Type System 时，让大小、字重、间距和时序对比在视频尺度上清楚可见。

先设计最可见的帧，然后动画进入该布局。按重要性编排：第一个移动元素是层级领导者。当视觉任务变化时，改变方向、时长、Easing 感受和 Stagger 节奏。

Anti-slop 规则是底线，不是上限。避免泛化 AI 生成美学：紫/蓝渐变背景、到处使用伪 Glassmorphism、可预测的 Feature Tile 布局，或缺少上下文特征的 Cookie-cutter 设计。在同一视觉系统内，当视觉任务变化时改变形式、构图和节奏；保持颜色和字体排印逻辑足够连贯，让这些 MG 属于同一个家族。

不要默认使用卡片形 Overlay。除非确实需要有边界的阅读表面，否则避免只是承载文字的浮动 Panel、Ticket、Note 或圆角矩形；它们经常与画面脱离，让视频看起来像 UI，而不是 Motion Design。

当强烈材质、纹理、Gradient、Glow、Depth、密集构图或大胆运动属于已确认视觉语言或编辑任务时，应使用它们。不要因为同一种效果的泛化版本会很糟，就回避有表现力的设计。

不要默认居中、对称布局。根据内容考虑不对称、重叠、大量负空间或受控密度。意外的空间选择会让 Motion Graphics 显得经过设计，而不是被生成。

角色、插图或复合形状是一个视觉实体。当多个部分必须视觉连接、贴合或对齐时，把它们渲染在同一个 `<svg>` 中，使用共享坐标空间和已命名 Anchor。在不同 Wrapper 中分别硬编码 `left` / `top` 会产生可见空隙。

### 文字布局安全

对于包含文字的 MG，动画前先把 Settled Frame 设计成真实布局。相关文字块使用 Flexbox 或 Grid、`gap`、`padding`、`maxWidth`、`lineHeight` 和自然换行。除非文字有意作为装饰或字体艺术，否则不要用彼此独立的硬编码 `top` 值堆叠可读文字。

可编辑文字可能比默认值更长。为合理的更长文案预留空间，允许使用 `whiteSpace: "normal"` 和 `overflowWrap: "break-word"` 换行；当内容无法干净适配时，降低层级、大小、密度，或改变形式。

动画 Transform 不影响布局。如果文字在其他文字附近 Scale、Pulse、Slide 或 Stagger，为最大动画状态留出视觉余量。有意重叠可用于 Graphic Layer、阴影、标记或装饰性字体排印；普通可读文字不得碰撞。

除非每一行都是有意固定的，否则避免为动态文字强制使用 `<br>` 或手动换行。优先使用宽度约束的自然换行。

使用以下基础 Component 形状：

```javascript
const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const props = item.props || {};
  const accentColor = props.accentColor;

  const rootStyle = {
    position: "absolute",
    inset: 0,
    backgroundColor: "transparent",
  };

  return <div style={rootStyle}>{/* content */}</div>;
};
```

## Motion Graphic 代码契约

违反规则会导致运行时崩溃。必须严格遵守。

1. **语法：** 纯 JavaScript JSX。不要使用 TypeScript。
2. **Import：** 不写 Import Statement。以下 Global 已预注入：`React`、`spring`、`useCurrentFrame`、`useVideoConfig`、`interpolate`、`interpolateColors`、`Math`、`random`、`Easing`、`AbsoluteFill`、`Sequence`、`Series`、`Img`、`Video` 和 `Audio`。
3. **使用已注入 Global：** Hook 和 Component 可直接使用；不要通过 Namespace Object 访问。
4. **Export：** 不要写 `export default`。定义 `const Component = ...`。
5. **时序：** Component 内不要使用 `Sequence` Wrapper。使用平坦、由 Frame 驱动的逻辑。
6. **逻辑：** JSX Prop 中不要写内联逻辑。在 `return` 前预先计算值。
7. **Helper：** 不要使用未定义函数。使用复数形式 `interpolateColors`。所有 Helper 在本地定义。
8. **AbsoluteFill：** `AbsoluteFill` 是 Component，不是 Style Object。绝不要 Spread。它可以用于内部 Layer，但绝不能作为 Root。
9. **Root Element：** Root 必须是 `<div style={rootStyle}>`。
10. **Asset：** `<Img>` 和 `<Video>` 的 Source 必须从 image/video 可编辑 Prop 读取。绝不要硬编码 URL。如果没有提供 Asset，使用形状、文字和 CSS 设计。
11. **Hook：** 从 `useCurrentFrame()` 获取 Frame，不要从 `useVideoConfig()` 获取。
12. **Local Box：** Component 必须接受 `({ item })` Prop。Asset 的 `width`/`height` 是围绕可见局部构图的 MG Natural Box，不是 Timeline 画布；使用 `position:absolute; inset:0` 填满该 Box。Timeline 放置决定最终屏幕大小和位置。
13. **布局控制：** 文字块和结构化内容使用 Flexbox 或 Grid。当设计依赖空间关系、复合形状、画框处理或绘制/动画标记时，使用 SVG 或绝对几何。除非请求要求单行文字，否则允许文字自然换行。
14. **可编辑 Prop：** Component 必须从 `item.props` 读取可编辑值。绝不要在 `props.key` 后添加 `|| "Default"` 或 `?? false` 等 Fallback；声明的运行时属性已经有值。
15. **Property Schema：** 声明匹配的可编辑属性。包含所有可见文字内容以及主色/强调色。
16. **图片/视频 Prop：** 保护空 URL；只有 URL 为 Truthy 时才渲染 `<Img>` 或 `<Video>`。
17. **背景：** 默认背景透明。如果添加背景表面，公开一个 `transparentBackground` Boolean 属性。

## 放置与审阅

不要只根据时序编写 JSX。先检查目标帧：时序告诉你何时；画面告诉你形式、放置和背景。对于一批 Overlay，制作一张目标帧截图/Contact Sheet，并在选择最终 Anchor、大小和时长之前，决定每个 MG 的 Settled Frame、语音范围、阅读时间和放置关系。

先设计 Settled Frame：选择 MG 最易读的时刻，把最终布局放在那里，然后动画进入该构图。

编写 JSX 前，做出四个相互关联的编辑决策。它们为 Motion Graphic Asset 和之后的 Timeline 放置做准备。

| 决策                   | 问题                                                                   | 输出                                                             |
| ---------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **内容**               | 哪个想法值得增加视觉层？                                               | MG 表达的信息或视觉事实。                                        |
| **时序**               | 它何时应出现和离开？                                                   | 语音范围、阅读时间、时长和任何内部运动节拍。                     |
| **形式和放置**         | 它是什么类型的 MG，在合成画面中应位于哪里？                           | MG 形式/大小，然后在 Asset 创建后用 `edit_item` 放置。           |
| **背景**               | 它是画面上的 Overlay，还是独立时刻？                                  | 透明或不透明背景。                                               |

放置原则：

- 根据检查过的帧，把画面和 MG 一起构图：主体、摄像机取景、视觉重量、存在时的字幕，以及 MG 的任务。
- 把 MG 放在能够让该时刻画面最易读的位置。
- 必要信息应在无需放大的视频尺度上可读；如果 MG 感觉与画面脱离，改变形式、时序、Scale，或跳过。
- 只有字幕已经存在或计划添加时，才考虑字幕。
- 把全画面 MG 视为有意节拍，而不是 Overlay 难以放置时的变通方法。

除非有意使用全画面节拍，否则默认透明 Overlay。透明 Overlay 仍使用 Natural-box Asset；不要仅为了放置而使用透明的 Timeline 尺寸 Asset。

放置并审阅：

- 使用 `edit_item`（Adds/Updates）放置。了解画面后，优先使用明确矩形：一个水平 Anchor、一个垂直 Anchor、Width 和 Height。
- 使用截图验证。一次工具调用传入多个帧——Settled State 会与任何短暂动画中间帧一起出现。下结论前比较各帧：只在部分批次帧中可见的表面截断、元素缺失或“设计损坏”是动画，不一定是真实缺陷。如果不明确，调整前围绕可疑帧重新捕获更多帧。根据 Settled Frame 判断。
- 检查完整画面：必要信息在视频尺度上清楚，存在字幕时仍可读，MG 内容正确、文字可读，并且构图平衡且有意图。
- 对于文字密集的 MG，检查文字显示最多的 Settled Frame。检查文字互相重叠、行被截断、溢出 Natural Asset Box，以及可读内容是否被动画 Scale 或 Translate 状态遮盖。
- 如果失败，先调整位置和大小。如果位置/大小无法解决，改变设计形式。扩展前，在目标帧验证每一种重复组件形式。

## Asset 与 Timeline 流程

### 创建新 Asset

通过当前 ChatCut Asset 创建工具传入内联 JSX 和可编辑 Property Metadata，创建新的 Motion Graphic Asset。准确字段名和接受的 Duration 格式以工具 Schema 为准。

根据编辑要求选择 MG Natural Box、时长、Asset 名称、描述和 Property Schema。Asset 时长应匹配预期放置范围，包括内部进入、停留和退出时序。Asset 创建步骤只创建 Asset；Timeline 放置是独立步骤。

对于 `create_motion_graphic_from_code`，把 Natural Box 作为 `width`/`height` 传入；只有有意全画面 MG 才使用 Timeline 尺寸。如果内容只占屏幕一部分，使用 `edit_item` 放置并缩放有边界 Asset，而不是把屏幕坐标固化进全画布 MG。

### 修补现有 Asset

修补前，检查现有 Asset 代码和 Property Schema。除非所请求修改需要改变，否则保留无关行为、Property Key 和 Timeline 时序。

通过当前 Asset 更新工具，使用完整内联替换源码修补。

### 放置到 Timeline

使用 Timeline 编辑工作流完成放置、移动、裁切和每实例 Property Override。当工具表面支持验证时，对大型或不确定 Transaction 先 Dry-run。

## 验证

工具调用成功不等于验证完成。

- 创建或更新 Asset 后，重新读取 Asset 状态。
- 放置、移动、裁切或设置 Property Override 后，重新读取 Timeline 状态。
- 对于可见变化，使用正常 ChatCut 视觉验证路径检查一个真实合成帧。
- 对于批量工作，并排比较合成 Settled Frame；验证每个视觉任务都有合适形式，重复表面/Anchor/节奏是有意设计，并且每个放置都适配自己的目标帧。
- 如果结果错误，重试前先分类失败：工具 Shape 无效、JSX 无效、Property Key 缺失/错误、Timeline 放置、异步 Asset 就绪状态，或画布/导出安全。
- 使用 Timeline 编辑修复放置问题，使用 JSX/Property 修改修复错误渲染。

