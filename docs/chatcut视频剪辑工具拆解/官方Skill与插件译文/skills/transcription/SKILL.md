---
name: transcription
description: 用于 ChatCut 转录、文字稿就绪状态、字幕、文字稿修复、口头填充词清理以及语音驱动编辑的准备工作。
---

# 转录

1. 使用 `browse_assets` 识别视频/音频 Asset 及其转录状态。
2. 对于新导入的本地媒体，先完成 `asset-import` 工作流。
3. 使用目标为 `transcription` 的 `track_progress` 检查状态。它返回当前状态；遵循返回的再次检查建议，不要繁忙轮询。
4. 使用 `find_transcript` 查找带时间戳的文本。
5. 只有在转录就绪后，才使用当前字幕工具启用、检查、翻译或设置字幕样式。

不要因为一次 pending 状态就判定转录卡死。明确的失败终态应立即处理；否则至少等待 `max(5 minutes, min(60 minutes, 2 x asset duration))`，时长未知时则应在多次检查之间至少留出 10 分钟。

`no_audio` / 无语音是一种成功的终态分析结果：媒体可以使用，只是没有可读取或可制作字幕的文字稿。不要把它报告为转录失败，也不要重试，除非用户说明该媒体中确实包含本应被检测到的语音。

当一次运行确实失败或卡死时，调用 `manage_transcript`，传入 `action:"retry_transcription"` 和 Asset ID，然后再次检查转录进度。源文字稿中的错误词语应使用文字稿修复操作修正，而不是在源文字稿本身错误时改写可见字幕。

进行语义型语音编辑时，加载 `talking-head-guide` 并使用 Script 工作流。机械清理只用于固定填充词和停顿；不要用破坏性的物理时间线裁切替代理解文字稿的编辑方式。

