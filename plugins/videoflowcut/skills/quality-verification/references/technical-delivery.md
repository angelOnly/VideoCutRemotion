# 结构、文件与技术交付

## 确定性技术检查矩阵

| 域 | 需要检查的事实 | 典型负责人 |
|---|---|---|
| Project Graph | Story、Scene、Item、Cue、Caption、Speech、Actor 是否悬空 | Application / project-basics |
| 时间 | start/end、Scene 边界、局部时间、SpeechTiming 精度 | effect-timing / Application |
| Asset | 文件、Hash、元数据、可解码、Binding、来源 | asset-import / sourcing |
| 人物 | AudioMode、Mask、Speech/Script 版本 | avatar-performance |
| 字幕 | 文本一致、时序、越界、画幅 | captions |
| Remotion | Registry、Props、Asset、字体、Player/Render | remotion-production |
| 音频 | Dialogue 唯一、音轨、缺音、头尾 | audio-finishing / export |
| Artifact | Revision、时长、画幅、音轨、黑帧、哈希 | export |

Quality Skill 应读取这些结果，但不能把可由代码确定的错误全推给视觉模型。

## Review 的版本约束

音效与动效关联的检查分两层：结构上读 AudioCue.effectEvent、对应 Cue、localFrame、syncOffsetFrames、作品版本签名及实际 Item；听感上复核选中的动作是否正是需要强化的动作、攻击是否相合、尾音是否干扰下一句。纯平移自动跟随不代表混音仍成立，stale 声音被停用也不代表原声音需求已兑现。源文件、动作前后语境和完整混合声画需要分别检查；检测指标或外部模型描述只作为辅助证据，未实际完成相应感知输入时仍保留 inconclusive。

EditorialReview 只适用于它绑定的 Revision。新 Revision 即使只改一个 Cue，也至少需要重新检查 Dirty Range；如果改变 Style、主声音、Story、Scene 长度或音乐结构，还需要更大范围甚至整片。旧 Artifact 的 Review 不能自动用于新导出。

## 交接合同

输入是当前 Revision、结构、Preview、Artifact 和模式规则。输出是 Findings、负责人、必须修复项、通过/阻塞、复核范围和 Delivery 建议。辅助结论不控制 Export Gate，文件生成只受技术与用途条件限制。四级证据和五轮方法用于说明实际检查了什么。

## Draft 与 Delivery

Draft 用于内部审片、A/B 和调试，可以在完整 Editorial Review 前产生，但必须明确标记。Delivery 固定目标 Revision，检查技术条件和实际用途；AI 审片、五轮覆盖与 Findings 不构成额外导出门禁。已完成与待完成的声画复核如实交付，用户观看实际文件后决定是否定稿。Remotion 失败不能静默交付只有主轨的降级文件。

用户批准必须对应具体 ExportArtifact。后续项目继续编辑不会改变已批准文件；用户说“这个版本可以”时，应记录其看到的 Revision/Artifact，而不是模糊的“当前项目”。

## 当前调用与读回：预览

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| 预览 | `render_preview_range(revision?, from_frame?, to_frame?, idempotency_key?)` | `track_job(job_id)` 成功后，`inspect_composed_frames(preview_job_id, frames?)` 会保存当前 Revision 的帧证据；仍须连续播放需要的范围。 |

### 阶段审片、对账与恢复

`read_quality_report` 在现有只读入口返回 `productionReconciliation`、`editorial.openFindings` 和 `editorial.coverage`。对账从当前 Story、VisualTreatment、有效 Cue/Cutaway/Program 推导，不另存一份 Timeline。共用 Scene 的字幕/声音只作为场景内线索，不能推断已兑现每拍设计；缺少明确关联时先核实，不为消除提示强行改成留白。

`observations` 每项包含 `pass`、`preview_job_id`、`start_frame`、`end_frame`（成片坐标，排他）、`method`、`observation`。方法为 frames、continuous_video、audio、audiovisual；抽帧不能表示连续观看或听觉输入。服务端固定返回证据 ID、Revision、文件哈希、路径与记录时间，并验证成功 Preview、实际媒体时长和所需音轨。这仅证明证据可追溯，不能证明审美或真实试听成立。旧自由文字保留可读，但不获得全片覆盖资格。

先登记修后观察，再用 `resolutions=[{finding_id,evidence_ids,note}]` 关闭原问题；不能用空 findings 清空待修项。证据必须晚于原发现、属于当前 Revision 和对应 Pass，并覆盖原范围或新版本可定位对象的完整范围；跨版本无法定位对象时需全片复核。证据失效会恢复待审。辅助 Findings 的 blocking、major、inconclusive 严重程度如实保留，但不阻挡制作、修订或导出。first_viewer 需一份覆盖整片的连续声画观察，不能由多个短样片相加冒充。
