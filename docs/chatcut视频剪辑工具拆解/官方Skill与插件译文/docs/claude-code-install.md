# Claude Code 安装说明——ChatCut

本文从 Public Marketplace Repository 安装 ChatCut Plugin：

`https://github.com/ChatCut-Inc/agent-plugin.git`

示例使用 `main` Git Ref。

## Host Environment Gate

首先判断当前 Conversation 是运行在用户本机的 Claude Code Desktop App（或 Claude Code CLI Terminal）中，还是运行在 Web / Remote Workspace（Web 版 claude.ai、Cloud / Remote Sandbox、隔离 CI Runner）中。

如果位于 Web 或隔离 Remote Workspace，在运行安装命令前停止。该环境无法修改本机的 `~/.claude` Plugin Directory，因此无法为 Desktop App 安装或配置 ChatCut。告诉用户：在他们准备编辑视频的机器上打开 Claude Code Desktop App，在那里开始一段新 Conversation，然后粘贴与 Conversation Language 匹配的安装 Prompt。其他任何语言都使用英文 Prompt。

English:
`Read chatcut.io/claude to install the ChatCut plugin and set up a new task for me.`

Chinese:
`阅读 chatcut.io/claude，帮我安装 ChatCut 插件并创建一个新任务。`

如果位于用户本机的 Claude Code Desktop App 中，继续本文。完整编辑体验（In-app Browser Pane 中的 Live Editor）需要 Desktop App；普通 Terminal `claude` Session 可以安装和认证 Plugin，但完整 Guided Editing Workflow 需要 Claude Code Desktop 的 Browser Pane。在纯 Terminal Session 中，提供干净 Editor Link，并让用户手动打开。
如果不确定，运行命令前询问用户。

## Agent 执行约定

如果你是为用户阅读本文的 Claude Code Agent，运行命令前完整阅读本 Guide。不要在 Install、Login 或 Verification 后停止。

必需顺序：

1. 完成 Host Environment Gate。在 Web / Remote Workspace 中，到此停止，并带着安装 Prompt 把用户引导到 Desktop App。
2. 安装、登录并验证 ChatCut Plugin。
3. 完成 Required Final Step：打开用户的第一段 Editing Conversation。
4. 在 Final Step 中打印一个 Required Self-report 前，Setup 仍未完成。

用户要求你 Setup ChatCut 时，自行运行命令；不要只描述命令。

## Prerequisite

验证 Claude Code CLI 可用且版本足够新（Plugin Marketplace Support 随 Claude Code 2.x 提供）：

```bash
claude --version
```

如果 `claude` 不在 PATH，在安装任何新内容前，先定位 Claude Desktop App Bundled CLI。macOS 位于 `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude`（选择最新 `<version>`）；Windows 在 Claude Desktop App Data Directory（`%LOCALAPPDATA%`）下查找 `claude-code` Runtime。下方每条命令都用该完整 Quoted Path 替代 `claude`。只有 Bundled CLI 也不存在时，才在使用 Official Installer 安装 CLI 前询问用户。

运行 Marketplace Command 的 Shell 必须能访问 Git：

```bash
git --version
```

## 安装

添加 Marketplace：

```bash
claude plugin marketplace add https://github.com/ChatCut-Inc/agent-plugin.git
```

如果该步骤或其他 Network Step 因 Timeout、Connection Reset、TLS、DNS 或 Proxy Error 失败，且用户正在运行本地 HTTP(S) Proxy，则通过该 Proxy 重试。先读取 System Proxy（macOS：`scutil --proxy`）；常见 Local Proxy Port 包括 7890、7897、1080、8080 和 8888。例如同时把 `HTTPS_PROXY` 和 `HTTP_PROXY` 设置为 `http://127.0.0.1:7897`，重新运行失败命令；测试后不要留下错误 Proxy 配置。

Marketplace 注册名为 `chatcut-inc`。确认并安装：

```bash
claude plugin marketplace list
claude plugin install chatcut@chatcut-inc
```

此时不要开始 New Conversation。先完成 Login 和 Verification。

## 登录

认证 ChatCut MCP Server（Claude Code 使用 `plugin:<plugin>:<server>` Namespace Plugin Server）：

```bash
claude mcp login plugin:chatcut:chatcut
```

该命令会在用户 Browser 中打开 ChatCut OAuth Page，并在 Localhost Callback 完成；用户可能需要登录 chatcut.io 并点击 Approve。

`claude mcp login` 需要 Interactive Terminal。如果它因 `"stdin isn't a terminal"` 失败（Agent 通过 Shell Tool 运行时常见），改为在 Pseudo-TTY 下运行——以下 Variant 已验证可以完成同一 Browser Flow：

```bash
CLAUDE_BIN="${CLAUDE_BIN:-claude}" python3 - <<'PY'
import os, pty, select, signal, sys, time
claude = os.environ.get("CLAUDE_BIN", "claude")
pid, fd = pty.fork()
if pid == 0:
    os.execvp(claude, [claude, "mcp", "login", "plugin:chatcut:chatcut"])
end = time.time() + 180
status = None
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    done, code = os.waitpid(pid, os.WNOHANG)
    if done:
        status = code
        break
if status is None:
    os.kill(pid, signal.SIGTERM)
    _, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
PY
```

`claude` 不在 PATH 时，把 `CLAUDE_BIN` 设置为完整 CLI Path。该 Pseudo-TTY Wrapper 仅适用于 macOS / Linux；Windows 上让用户在 Interactive PowerShell Window 中自行运行 `claude mcp login plugin:chatcut:chatcut`。运行前告诉用户 Browser Window 将打开以登录 ChatCut；等待 Output 中出现 `"Authenticated"`，并把非零 Exit 视为 Login Failed。

## 验证

```bash
claude mcp get plugin:chatcut:chatcut
claude plugin details chatcut@chatcut-inc
```

预期：Server 显示 `Status: ✔ Connected`，URL 为 `https://api.chatcut.io/api/external-mcp/mcp`；Plugin Inventory 列出 15 个 Skill + 1 个 MCP Server。如果 Server 显示 `"Needs authentication"`，重新运行 Login Step。如果 Plugin 缺失，重新运行 `claude plugin marketplace list` 确认 Marketplace Name，并使用该精确 Name 重新安装。

## 必需的最终步骤：打开用户的第一段 Editing Conversation

**必需：** 当前 Installation Conversation **无法**访问刚安装的 ChatCut Tool——Claude Code 会在 Session Start 捕获该 Session 的 Plugin 和 MCP Tool List。不要在这里尝试 ChatCut Tool Call；它们会失败。必须创建全新 Conversation；在你创建 One-click Handoff 或把精确 Startup Prompt 交给用户前，工作尚未完成。

根据用户实际 Conversation Language 解析 `startupPromptLanguage`，不要根据 Operating System Language，也不要询问。逐字使用下方匹配 Prompt；其他语言翻译 English Prompt。

Chinese:
`ChatCut 插件已经安装好了，请你用 Claude Code 的内置浏览器面板打开一个 ChatCut 项目，把项目名称命名为"我的第一个ChatCut视频"，然后先告诉我你整体可以做什么，尤其是这三部分：视频剪辑（语音清理、字幕、转场、补充素材等）、MG 动画制作、素材生成（视频、旁白、音乐、音效等）。之后问我有什么素材、想做什么样的视频，告诉我你可以根据我的具体需求一步步开始制作，并且我也可以随时在内置浏览器的 ChatCut 编辑界面里自己调整时间线、字幕、MG 动画等任何内容，就像使用传统编辑器一样。`

English:
`The ChatCut plugin is already installed. Please use Claude Code's in-app Browser pane to open a ChatCut project, name the project "My First ChatCut Video", then first tell me an overall view of what you can do, especially these three parts —— video editing (speech cleanup, captions, transitions, b-roll, etc), motion graphics creation, assets generation (video, voiceover, music, sound effects, etc). After that, ask me what materials I have and what kind of video I want to make. Tell me you can start making it step by step based on my specific needs and that I can also hop into the ChatCut editor in the Browser pane anytime and adjust things by myself — timeline, captions, motion graphics, anything — just like a traditional editor.`

Spanish:
`El plugin de ChatCut ya está instalado. Usa el panel de navegador integrado de Claude Code para abrir un proyecto de ChatCut, nombra el proyecto "Mi primer video de ChatCut" y luego primero dame una visión general de lo que puedes hacer, especialmente estas tres partes: edición de video (limpieza de voz, subtítulos, transiciones, b-roll, etc.), creación de motion graphics y generación de recursos (video, voz en off, música, efectos de sonido, etc.). Después pregúntame qué materiales tengo y qué tipo de video quiero crear. Dime que puedes empezar a crearlo paso a paso según mis necesidades y que también puedo entrar en el editor de ChatCut dentro del navegador integrado en cualquier momento para ajustar la línea de tiempo, los subtítulos, los motion graphics o cualquier otro elemento, igual que en un editor tradicional.`

Claude Code Host——按顺序执行：

1. **HANDOFF CHIP。** 如果当前 Session 有 Task-spawning Tool（例如 Claude Code Desktop Session Server 上的 `spawn_task`），调用一次：Title 使用根据 `startupPromptLanguage` 本地化的 `"My First ChatCut Video"`，把解析后的 Startup Prompt 作为 New Session Prompt。它会创建 One-click Chip；只有用户点击后 New Session 才会启动，因此告诉用户点击 Chip 开始。
2. **FALLBACK。** 如果不存在该 Tool 或调用报错，在可复制 Block 中打印解析后的 Startup Prompt，并告诉用户：打开一个**新的** Claude Code Conversation（当前 Conversation 无法使用 ChatCut），在那里粘贴。

Required Self-report（结束 Turn 前恰好打印一个）：

- (A) `"Created a one-click handoff — click the chip to start your first ChatCut conversation."` 包含 Chip / Session Title。还要使用 User Language 说明当前 Installation Conversation 无法使用 ChatCut，Editing 将在 New Conversation 中进行。只有 Spawn Call 实际成功时才报告 (A)。
- (B) `"Could not create the handoff automatically"`——提供 Paste-in Prompt，说明哪个 Tool 不可用或哪次 Call 失败，并让用户粘贴到 New Conversation。

Completion Gate：打印报告 (A) 或 (B) 前，不要告诉用户 ChatCut 已安装或 Setup 已完成。绝不要声称 New Conversation 已启动——在 Claude Code 中始终由用户触发（点击 Chip 或粘贴）。

## 第一段 Conversation 应做什么

供参考（这会在**新** Conversation 中发生，由 Plugin Skill 驱动）：Agent 创建 / Target Project，然后在 In-app Browser Pane 中通过 `Claude_Browser` MCP Tool（例如 `preview_start {url}`）打开返回的 `browserHandoff.url`，并保留返回的 One-time `editor-boot-token`（它会自动登录 Editor）。不要为 Claude Code URL 添加 `theme=codex`，也不要虚构 Codex-only Workbench 参数；在 Claude Code Pane 中，Manual File Drop 和 Import Button 必须保持可用。Browser Pane 会要求用户批准 ChatCut Origin 一次。用户可在该 Pane 中实时观察 Import、Transcription 和 Timeline Edit，并可随时手动编辑。

## 更新

之后刷新时：

```bash
claude plugin marketplace update chatcut-inc
claude plugin update chatcut@chatcut-inc
```

然后重启 Claude Code（或开始 New Conversation），并重新运行上方 Verification Command。

