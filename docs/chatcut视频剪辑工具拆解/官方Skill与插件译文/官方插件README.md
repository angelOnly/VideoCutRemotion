# ChatCut Agent 插件

ChatCut Agent 插件将 Codex 和 Claude Code 连接到 ChatCut，使你能够在 AI 协助下编辑 ChatCut 视频项目。

你可以用它导入媒体、修改项目时间线、创建 MG 动画、生成素材、转录音频、添加字幕、导出视频，并验证编辑结果是否已在编辑器中显示。

## 包含内容

- `codex/` - Codex 插件包。
- `claude/` - Claude Code 插件包。
- `codex/.codex-plugin/plugin.json` - Codex 插件元数据。
- `claude/.claude-plugin/plugin.json` - Claude Code 插件元数据。
- `codex/.mcp.json` - Codex MCP 服务器配置。
- `codex/skills/` - 宿主适配器，以及指向 `apps/agent/.claude/skills/` 中规范剪辑 Skills 的直接符号链接。
- `claude/skills/` - Claude 专用适配器，以及指向同一组规范 Agent Skills 的直接符号链接。
- `codex/assets/` - 插件图标和品牌素材，通过符号链接与 Claude 共享。

## 要求

- 一个 ChatCut 账号。
- 支持插件的 Codex，或 Claude Code 2.x（CLI 或桌面应用）。
- 对你想要编辑的 ChatCut 项目的访问权限。

## 身份验证

插件通过 ChatCut 托管的 MCP 端点连接到 ChatCut：

```text
https://api.chatcut.io/api/external-mcp/mcp
```

安装插件或首次使用插件时，由宿主处理身份验证（Codex 使用 `codex mcp login chatcut`，Claude Code 使用 `claude mcp login plugin:chatcut:chatcut`）。按照登录流程连接你的 ChatCut 账号。

各宿主的安装说明：Codex 请访问 [chatcut.io/chatgpt](https://chatcut.io/chatgpt)，Claude Code 请访问 [chatcut.io/claude](https://chatcut.io/claude)（可由 Agent 执行的副本位于 [./docs/claude-code-install.md](./docs/claude-code-install.md)）。

## 示例提示词

安装插件并完成身份验证后，可以尝试以下提示词：

- `把这个视频导入我的 ChatCut 项目。`
- `添加一个简单的 MG 动画叠层。`
- `生成旁白和背景音乐。`
- `转录这个片段并添加字幕。`
- `导出当前项目。`

## 仓库

公开插件仓库为：

```text
https://github.com/ChatCut-Inc/agent-plugin.git
```

## 支持

产品信息请访问 [chatcut.io](https://chatcut.io)。

