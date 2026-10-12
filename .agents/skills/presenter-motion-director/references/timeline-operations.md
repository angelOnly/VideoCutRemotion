# 当前时间线操作与依赖

## 主线变化后的返工范围

- Script 文本变：相关 SpeechSegment、SpeechAsset、Caption、语义 Effect、Cutaway 和人物可能 stale；
- 只改 Voice 音色：人物口型、Dialogue、Timing 和音频审查受影响，Story不一定变；
- 只换 B-roll：Cutaway Scene、声音交接、Preview 受影响；
- 改 Effect Props：目标 Cue、布局和局部 Preview受影响；
- 改全片 Style：多个 Scene 和 Golden 需要复核；
- 改 Story 顺序：主线和全部语义绑定包装可能需要重投影。

不要“为了保险全部重做”，也不要假设下游自动正确。

## 用户可见的完成报告

报告应以观看结果为中心，而不是列工具：主线做了哪些删改、声音来源、哪些 Beat 保持人物、哪些使用解释/B-roll、为什么拒绝了哪些效果、当前质量问题、最终 Revision 和 Artifact。内部 ID 只在需要定位时提供。

## Gate C：交付

先核对当前 Revision 的 Project Graph、文件技术条件，按 `export` 生成目标文件，保留已有辅助审阅及未审范围。AI 审阅缺失不阻挡 draft 或 delivery 导出；文件完成后检查解码、时长、音轨和哈希，人工定稿绑定用户确认的具体 Artifact。

## 专项交接总表

给视觉作者本段完整句群、实际人物和字幕占用、要看的素材过程，以及返回
人物时的下一句与姿态。作者可选择同屏辅助或由素材／解释暂时接管，不能
为了始终保留人物，把主要操作缩到看不清。接管和返回都在实际声画里检查。
无可靠 Mask 或动作证据，不设计物体穿过手掌、躲到人物身后等假交互。

MG 交回设计依据、固定作品版本、覆盖 Beat、局部事件帧、入口/出口状态、当前证据和限制。人物同屏或全屏接管由内容与真实构图决定，不固定交替比例。

| 阶段 | 调用 Skill | 主工作流应接收什么 |
|---|---|---|
| 原创解说 | narration-writing | 完整朗读正文、逐段声画稿、事实与材料依据、修订差异 |
| 素材 | asset-import / transcription | 就绪 Asset、Transcript、失败和精度 |
| 内容 | semantic-continuity | SemanticUnit、Script、停顿、Impact |
| 声音 | voice-production | SpeechAsset、segment_exact、听感结论 |
| 人物 | avatar-performance | ActorPerformance、AudioMode、Mask 与降级 |
| 视觉计划 | visual-treatment-planning | 每 Beat Treatment、AttentionCurve、安静区 |
| 素材缺口 | visual-asset-sourcing | 本地 Asset、来源、候选取舍 |
| MG | remotion-production | Scene/EffectCue、Props、Preview Evidence |
| Cutaway | cutaway-planning | 使用范围、模式、声音、返回策略 |
| 字幕 | captions | Caption Program、布局和精度 |
| 声音收尾 | audio-finishing | Dialogue/BGM/SFX 关系和试听结论 |
| 质量 | quality-verification | Findings、负责人、通过/阻塞 |

## 完成标准

本工作流完成时，A-roll/Script/声音/人物版本一致；StoryBeat 与 PresenterScene 有真实关系；各重要 Beat 的保持或处理有明确作用；视觉、声音与相关上下文取得实际预览，并记录已审范围、修订与未知。五轮按需要提供专业观察，AI 未审或未关闭审美意见不构成导出禁令；技术与用途沿当前合同检查，最终用户批准绑定具体 Artifact。


`create_presenter_timeline` 是兼容入口，不作为正式主链；它按素材数量临时分组。正式人物主线使用 `assemble_presenter_track` 后接 `compile_presenter_scenes`，再登记人物。`align_presenter_to_speech` 因已有效果、缺画面或直接覆盖拒绝调整时，不绕过保护；交导演决定补画面、重生人物、修声音或保留差异。
