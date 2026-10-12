# Script操作与失效范围

## 写入当前项目

标准流程是：

```text
read_script
→ 读取 TranscriptSentenceCandidate、现有 SemanticUnit、Script、SpeechSegment
→ 必要时回听源音频
→ apply_semantic_units
→ 读回 SemanticUnit 与新 Revision
→ apply_script
→ read_impact_report
→ 读回最终 Script / SpeechSegment
```

Script 修改会使 SpeechAsset、Caption、EffectCue、Cutaway 和 ActorPerformance 的部分结果失效或需要复核。不要在本 Skill 内假装这些下游已经更新；把 Impact 和新 Script 交回主要工作流。

## 当前调用与读回：语义与脚本

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| 语义与脚本 | `apply_semantic_units(base_revision_id, units)`；再以新 Revision 调 `apply_script(base_revision_id, semantic_unit_ids)` | `read_script`、`read_impact_report`；根据 stale 范围重建声音和包装。 |

## 当前调用与读回：原创新稿

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| 原创新稿 | `apply_authored_script(base_revision_id, source_note, units)`；units 是已审阅的完整思想，填写 text、kind、可选上下文与 pause_before，不填 candidate_ids | 整体替换 Script，建立 authored SemanticUnit / 待合成 SpeechSegment；不创建转写、假素材或估算时间。`read_script`、`read_impact_report` 后交给现有 VoiceReference / 语音链路；旧声音和包装按主线变化失效。原声剪辑仍使用上一行的转写候选。 |

apply_authored_script 是原创全文替换，不能拿它向真实原话 Script 局部追加过桥话。当前会话没有所需混合写入能力时保留原话项目，交回准确拟稿与能力缺口，不宣称已放置。
