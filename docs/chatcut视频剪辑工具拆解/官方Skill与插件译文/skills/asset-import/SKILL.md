---
name: asset-import
description: 通过托管的外部连接器，把本地、已附加或已下载的媒体导入 ChatCut 项目。
---

# 素材导入

当 Codex 能够在本地读取文件时，使用这个宿主适配器。托管的外部 MCP 不会暴露后端 Agent 的 `push_asset` 工具，因此不要在这个插件中沿用共享的 `push_asset` 工作流。

1. 当媒体可能已经存在于项目中时，先检查 `browse_assets`；不要创建重复素材。
2. 需要时，把公共 URL 下载为本地文件。
3. 调用 `import_media`，传入 `{"action":"create_session"}`。
4. 使用返回的 token 和 endpoint，运行一次本 Skill 的 `scripts/upload-media.mjs`，并且一次最多传入四个本地文件。更大的文件集合要拆成每批四个文件，并为每一批创建一个会话。

```bash
"<bundled-or-global-node>" <this-skill-dir>/scripts/upload-media.mjs --token <token> --endpoint <endpoint> /path/to/source-1.mp4 /path/to/source-2.wav
```

相对于这个 Skill 解析辅助脚本；不要搜索工作区。优先使用 Codex 自带的 Node 运行时，否则使用 `PATH` 中的 Node 18 或更高版本。在前台运行辅助脚本，并从 stdout 读取它最终输出的 JSON。不要把它放到后台运行，也不要虚构状态文件。

媒体准备和上传必须使用这个辅助脚本。不要用手写的 `ffprobe`、`ffmpeg`、`curl`、元数据、转码或预签名上传命令替代它。媒体字节会直接上传到存储，不得经过 ChatCut 后端。

后续时间线工作使用每个返回的 `imports[].result.assetId`。在进行文字稿或字幕工作之前，等待 `track_progress` 的 `transcription` 目标完成。只有在执行依赖实际字节的操作（例如云端导出、`pull_asset` 或远程帧检查）之前，才需要等待 `upload` 目标完成。

如果辅助脚本返回包含 `retry` 的错误，应在要求时创建新的导入会话，并严格使用返回的参数重新运行。如果宿主策略拒绝传输用户文件，应停止操作，而不是尝试改用本地编辑或其他上传变通方案；告诉用户上传被拒绝，并请用户使用 ChatCut 编辑器的上传界面，或授予所需权限。

