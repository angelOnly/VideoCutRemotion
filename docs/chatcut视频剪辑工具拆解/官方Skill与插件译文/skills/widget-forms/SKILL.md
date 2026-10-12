---
name: widget-forms
description: 使用当前插件宿主支持的表单表面，向用户请求结构化的 ChatCut 输入。
---

# Widget Forms 宿主适配器

规范 Agent 使用的原始 `<widget>`、`<choices/>` 和 `<visual-option>` 标签只能在 ChatCut 内部渲染。绝不能从公开的 Codex 或 Claude Code 插件中输出这些标签。

## 语义契约映射

这个适配器负责定义插件宿主如何实现调用方的宿主无关表单契约。它不决定工作流需要哪些字段。

语义字段类型按以下方式映射：

- `short_text`：一个文本输入框。
- `explicit_consent`：一个明确的、初始未选中的确认控件，使用调用方提供的完整本地化文案。附件或另一个已提交字段绝不等同于同意。
- `audio_reference`：插件表单不能录制或上传媒体。渲染其他字段，要求用户把音频附加到对话中，然后加载 `asset-import`。把导入后的 ChatCut 音频 `assetId` 返回给调用工作流；绝不能把本地路径、附件 URL 或原始字节当作 Asset ID 返回。
- `playable_single_choice`：一个单选表面，使用稳定的选项值、本地化标签，并在宿主支持时附带可播放媒体。当宿主返回可见标签时，在上下文中保留值到标签的映射。
- `playable_preview`：一个只展示、不提交的音频表面，使用调用方提供的准确运行时媒体 URL。只使用宿主支持的安全媒体渲染器；绝不能输出原始 `<audio>` HTML，也不能把 URL 作为普通文本暴露。

## Codex

调用 ChatCut MCP 工具 `ask_followup_questions`。把相关字段放入一个表单，使用用户语言编写可见文本，并在调用后停止，直到提交的答案出现在对话中。字段和选项结构以当前工具 schema 为准。

把 `playable_single_choice` 映射成一个带有 `variant:"voice"` 的 `single` 字段。每个稳定值作为选项 ID，并把本地化标签、描述和 `audioUrl` 与调用方提供的同一个条目绑定。没有可播放媒体的操作不应包含 `audioUrl`。

不要仅仅为了显示 `playable_preview` 而调用 `ask_followup_questions`，因为被动预览不是问题。可用时使用 Codex 支持的音频附件/媒体渲染。如果当前宿主会话没有安全的运行时 URL 音频渲染器，应说明预览可在 ChatCut 项目 Asset 中使用，并继续调用方的独立分支决策；不要打印 HTML、裸 URL 或伪造的 Widget 标签。

把 `explicit_consent` 映射成一个仅包含一个确认选项的单选字段。使用调用方完整确认文案作为标签，不要预选。由于卡片不会强制必填，继续之前必须检查每个必填答案。

## Claude Code

遵循 `chatcut-plugin-basics-claude` 中的结构化输入方案：使用一个 `visualize.show_widget` Elicitation 表单，只通过 `.elicit-submit` 提交，并等待用户发送填写后的提示词。绝不能在 Claude Code 中调用 ChatCut 的 `ask_followup_questions`，因为该宿主不会渲染它的 MCP-App 结果。

把 `explicit_consent` 映射成一个未勾选的复选框，使用调用方提供的完整文案。不要为 `audio_reference` 添加文件选择器；在表单之外请求对话附件，并在用户发送后加载 `asset-import`。

对于 `playable_single_choice`，通过 `${CLAUDE_PLUGIN_ROOT}/assets/widget-media/manifest.json` 解析打包媒体键；当某个键不存在时，使用只有标签的卡片，并且绝不能嵌入或处理原始源 URL。把稳定值保留在标签到 ID 的映射中，而不是把它暴露为 DOM 音频键。运行时媒体 URL 不在打包的 manifest 中：不要把它们嵌入 Elicitation HTML。通过宿主正常的安全链接/音频表面提供它们，然后使用只有标签的确认控件。

