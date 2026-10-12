- 字幕以类似 SRT 的有序 Card 列表编辑。先用 `read_captions` 读取一次，然后把其中的 Card ID 和 Revision 与 `set_card_text`、`set_card_style`、`set_card_span_style`、`merge_cards` 或 `reset_card` 配合使用。字幕样式使用 `captionStyle:{version:1,...}` CSS Slot，并与 `fontFamily`、`fontFallbacks`、`presentation` 和 `pagination` 并列；几何信息属于 Layout，绝不属于 captionStyle。如果用户指定一个 Card，使用 `set_card_style`；如果用户指定准确文字/词语，使用 `set_card_span_style`。每个 Span Entry 具有并列字段：`{"text":"...","style":{...},"activeStyle":{"animation":{...}}}`。`style` 是始终可见的外观；`activeStyle` 只在该 Span 中带时序的词正在被说出时应用。**绝不要**把 `activeStyle` 放进 `style`。动画是在稳定普通文字之上采样活动叠层。如果高亮背景本身应淡入淡出或移动，把 `backgroundColor` 放进 `activeStyle`，而不是 `style`；`style` 中的背景会始终可见，如果活动绘制没有差异，动画可能不可见。Span 动画支持使用 `opacity`、有类型的 `transform` 字段（`translateX`、`translateY`、`scale`、`rotate`），以及受限的 `clipPath:"inset(...)"` 编写确定性的进入/退出关键帧。真正从左到右的荧光笔擦除应从 `inset(0 100% 0 0)` 变到 `inset(0)`；不要使用 Polygon/Path/Round 裁切或浏览器动画名称。"Swipe" 是应通过 Inset 或 Translate 关键帧表达的意图，不是字面量 `highlightAnimation:"swipe"` 值。绝不要把 Span 请求转移到 Track 范围的 `style`/`source_update`，也绝不要声称不支持 Card 或 Span 动画。全局分段只能通过 `resegment_cards` 应用（`natural`、`short-phrase` 或 `word-by-word`）；样式、字体大小和框体几何不是分段操作。旧版 `display_text` 词语 Override 只用于兼容。**绝不要**为了修复字幕措辞或边界而编辑文字稿——`manage_transcript fix` 只用于修复 ASR 听错的源词。

### 目标

通过屏幕文字提高无障碍访问性和参与度。

字幕从源文字稿开始。当用户要求翻译或双语字幕时，使用 `edit_captions` 的 `translate` Action；其中的 `languageCode` 是翻译目标。语言属于普通字幕源，因此使用 `set_sources` 在已存在的翻译之间切换。

### Preset

优先使用内置字幕 Preset，因为它们提供更稳定、经过测试的结果。只使用真实存在的内置 `edit_captions` Preset 名称；不存在 `youtube` 或 `vox` Preset。

- 对于一般风格请求，先通过 `edit_captions` 的 `template` Action 列出感知语言的 Preset，然后选择一个，或向用户提供相关返回 Preset 供其选择。
- 只有在用户明确要求自定义外观或特定调整时，才使用自定义 `style` / `layout`。
- 对于调整，从最接近的 Preset 开始，只修改用户要求的属性。

### 可选的强调跟进

首次创建并验证字幕后，如果用户尚未要求强调，只询问一次他们是否需要。问题应以实际字幕内容为基础：只提及相关类别——例如数据、概念或结论、人物、组织或产品名称、步骤或动作，以及对比或风险——并提供让 Agent 决定的选项。把所选类别视为指导，而不是必须强调每一个匹配项。不要中断用户明确要求的端到端工作流；只在所请求工作完成后提供此选项。

强调是 Opt-in。用户提出要求后，使用 `read_captions` 读取完整字幕序列。先选择内容能够为理解、记忆、行动、决策、状态跟踪或表达效果增加独立价值的 Card。抑制铺垫、填充和重复 Payload；当每个相邻选择都增加独立内容时可以连续选择，并让内容决定要强调多少个 Span。

在每个符合条件的 Card 内，选择仍然保持真实的最小连续逐字 Span。保留否定或情态、条件、范围或不确定性、必需单位或指代对象、不可缺少的动作宾语，并在需要时保留对比的两侧。如果同一文字出现多次，使用 `occurrence`；使用 `languageCode` 指定一个双语 Projection。

使用 `set_card_span_style` 应用所请求的 Span，然后再次读取字幕，并验证产生的 `inlineStyles`。不要改变字幕措辞、时序、Card 边界、换行、位置、节奏或整体样式。

