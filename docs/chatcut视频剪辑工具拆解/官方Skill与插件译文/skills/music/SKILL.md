---
name: music
description: |
  ChatCut 共享背景音乐生成 Skill。当用户希望通过 `submit_music` 为 ChatCut 视频新生成音乐、背景音乐、片头主题、音乐底床或 BGM 时使用。
user-invocable: true
---

# 音乐

使用 `submit_music` 根据文本提示词创建新的背景音乐音频 Asset。在原生 SDK 中，它可能显示为 `submit_music`；在 Codex 连接器中，它显示为 `submit_music`。

该工具会提交生成任务并返回 `jobId`。`track_progress` 报告完成后，生成的音频 Asset 才可用。

## 能力边界

Mureka 是音乐生成模型。它会创建新的原创音乐 Asset；它不能编辑、清理、混音、分离或调整已有音频。

Mureka 也不能保证与精确节拍、Drop 或时间戳对齐。先生成音乐 Asset，再使用时间线工具完成放置、裁切、循环、淡入淡出和 Ducking。如果用户要求精确到节拍的同步，应说明这必须作为时间线/音频编辑处理，不能由生成模型保证。

## 工作流

1. 编写简洁提示词，描述风格、能量、乐器、情绪、速度和剪辑用途。
2. 适当时提供简短、具有描述性的 `name`。
3. 调用 `submit_music`。
4. 如果下一步编辑需要已经完成的 Asset，则使用 `track_progress`。
5. Asset 存在后，使用时间线工具放置、裁切、循环或进行 Ducking。

## 提示词结构

良好的提示词应组合以下内容：

- 类型或乐器：`"minimal electronic"`、`"warm acoustic guitar"`、`"cinematic piano"`
- 能量：`"upbeat"`、`"calm"`、`"tense"`、`"confident"`
- 用途：`"under a product walkthrough"`、`"intro sting"`、`"background bed under speech"`
- 约束：需要时使用 `"not distracting"`、`"no vocals"`、`"short loop feel"`

## 规则

- 不要让响亮的音乐盖住语音；降低音量，或在旁白下进行 Ducking。
- 不要用生成音乐替代用户提供的受版权保护曲目。

