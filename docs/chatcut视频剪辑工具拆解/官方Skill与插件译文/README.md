# ChatCut 官方 Skill 与插件译文

> 来源：用户提供的 ChatCut Agent Plugin 中文译文 ZIP。归档版本声明为 `0.2.25`。本目录只为后续阅读方便而保存 Codex 路径下的官方 Skill 与参考资料；它是历史阅读资料，不是对当前 ChatCut MCP 能力的保证。

> 历史快照提示：2026-08-27 已确认该 ZIP 有 15 个 Skill，而当前本机缓存有 16 个，且若干同名 Skill 的文本长度不同；因此下方归档正文只能作为历史方法资料，当前工具/字段/可用 Skill 必须以当次运行时 Schema 为准。完整对照见 [附录 C](../附录C-官方插件包与运行时对照.md)。

## 先看什么

| 你想理解的问题 | 推荐文件 |
| --- | --- |
| 插件是什么、为何不能直接用 ZIP 安装 | [插件元信息.md](./插件元信息.md)、[官方插件README.md](./官方插件README.md) |
| Plugin、Project、Timeline、轨道、Item 与运行时合同 | [chatcut-plugin-basics](./skills/chatcut-plugin-basics/SKILL.md) |
| 口播、访谈、Script、清理、字幕、B-roll、MG 和音乐顺序 | [talking-head-guide](./skills/talking-head-guide/SKILL.md) |
| 多机位同步母版和节目版 | [multicam-sync](./skills/multicam-sync/SKILL.md) |
| 字幕、转写与无声素材 | [transcription](./skills/transcription/SKILL.md) |
| 背景音乐、旁白、定制声音 | [music](./skills/music/SKILL.md)、[voice](./skills/voice/SKILL.md) |
| MG、特效、转场、LUT | [create-motion-graphics](./skills/create-motion-graphics/SKILL.md)、[shader-gen](./skills/shader-gen/SKILL.md) |
| 结构与合成画面验证 | [verification](./skills/verification/SKILL.md) |

## 目录结构

```text
官方Skill与插件译文/
├─ README.md                         本索引与使用边界
├─ 官方插件README.md                 ZIP 根目录的官方说明
├─ 插件元信息.md                     Plugin manifest 的可读摘要
├─ docs/claude-code-install.md       仅为保留官方 README 的安装说明链接
└─ skills/                           Codex 路径下的 Skill 与 references
```

本次只归档 Codex 路径的完整 Skill；Claude 路径与其内容高度重复，且不是本次调研使用的宿主。唯一保留的 Claude 安装说明仅用于完整保存官方 README 的阅读链接，不应被理解为本次推荐的安装路径。

## 阅读时必须保留的边界

1. **这是方法说明，不是运行时工具表。** 当前 MCP 是否暴露某个工具，以当次会话 manifest 为准。
2. **不要执行文档中的命令。** 原 ZIP 中缺少它自己提到的一部分配置、资源和辅助脚本；本目录也只保留可阅读文本。
3. **不要把官方流程直接写成实测事实。** 本拆解正文仍按“已实测 / 工具合同明确 / Skill 明确 / 待验证”标注。
4. **不要用它替换插件。** 要安装或更新 ChatCut，应使用官方产品内流程或完整插件包。

## 与本拆解正文的关系

更完整的对照见 [附录 C](../附录C-官方插件包与运行时对照.md)。本文档的核心结论仍应优先阅读：

- [01-产品全景与核心结论.md](../01-产品全景与核心结论.md)
- [04-时间线轨道与改动联动.md](../04-时间线轨道与改动联动.md)
- [05-Script-IR与口播语义剪辑.md](../05-Script-IR与口播语义剪辑.md)
- [08-实测记录浏览器验证与字段样例.md](../08-实测记录浏览器验证与字段样例.md)
