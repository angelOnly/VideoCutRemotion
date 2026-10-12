# 配音合成、组装与放置

## VoiceReference

未指定参考参数时，`submit_voice_synthesis` 使用服务端默认音色入口，由服务端读取已配置的本地参考音频；剪辑任务不需要导入参考素材或向用户索要音频路径。这仍是音色克隆，不是不依赖音频的 TTS。默认工作流或文件缺失属于服务配置阻塞，提交 Repair Ticket，不私自换音色。

参考音频通常选择 3～15 秒、单人、清晰、低噪、音色稳定且与目标角色接近的范围。强背景音乐、多人说话、严重混响和情绪极端的片段会降低一致性。当前 VoiceReference 是本项目本地对象，不存在远端 Voice ID。

只有显式覆盖默认音色时，使用 `manage_voice_references` 登记已就绪本地音频，并保存实际用途说明。不能因为同一音频以前生成成功，就忽略新的目标语气和语言差异。

## 当前调用链

```text
read_script / read_speech_asset
→ 确认最终 SpeechSegment 与 Script Revision
→ 选择 VoiceReference
→ submit_voice_synthesis（只提交 stale/changed 段）
→ track_job
→ 下载每个 SegmentAsset
→ ffprobe 检查真实时长、采样率、声道和文件
→ 组装 SpeechAsset
→ read_speech_timing 得到 segment_exact
```

若已就绪的完整配音需要与 Scene 留白对齐，先读取每段真实时长及当前帧率，再用 `submit_speech_placement(base_revision_id, placements, duration_frames?, idempotency_key)` 按 Script 顺序提交全部 `speech_segment_id` 与 `start_frame`。相邻段不得重叠，也不得越过当前场景末帧。需要完整片尾时，用 `duration_frames` 明确总轨结束帧，末句后的静音不会延长字幕。Job 复用现有段音频生成带静音的新 Dialogue 总轨，并原子更新 SpeechTiming 和稳定字幕；跟踪终态后读回 Revision、试听并复核画面。此入口不重新调用 OmniVoice，不按文字估算发音时长；项目在 Job 期间变化时会拒绝旧提交，须重新读取后再判断。

每次 OmniVoice 调用前重新读取 Workflow Detail。默认音色 HTTP 入口只传待合成文本，参考音频来自服务端已有配置；显式 VoiceReference 入口上传参考音频和文本。两条入口内部都会自动转写参考音频，不提交不存在的 reference_text。默认音色产物保留真实 Bridge 审计，不伪造本地 VoiceReference 或素材 ID。

## 组装和停顿

SpeechAssembler 按 Script 顺序拼接真实段级文件，并应用明确的前置/后置停顿。极短交叉淡化只用于消除爆点，不能吞掉辅音或掩盖错误切口。每段真实时长加上停顿形成最终 `segment_exact`，它能支持段级字幕、Scene 和段首/段尾效果，但不能被描述为逐词时间。

## 音频所有权

人物视频原声、OmniVoice Dialogue 和静音必须明确三选一。使用 Dialogue 时 Actor 视频应静音；数字人视频若已包含最终声音，不再叠加 SpeechAsset；纯视觉人物可以 muted。当前质量系统会检查重复 Dialogue，但主工作流仍要主动选择。

## 参考声音的一致使用

同一 SpeechAsset 的 Segment 应尽量使用同一个 VoiceReference 和可比参数。更换参考范围会改变音色和空间。若某段需要明显不同情绪，先判断能否通过文本和表演实现；频繁更换参考会让人物身份不稳定。

## 局部重生决策

按问题与采用改动选择需要重生的 Segment，原因可以包括错读、漏读、音色或句尾异常、情绪不符，以及经导演采用的文案和声画节奏修订。优先复用仍有效的段音频；脚本变化后按实际 Impact 重新组装 SpeechAsset，并复核字幕、人物、动效与声音包装，不宣称未改段一定完全不受影响。

## Speech 与人物时长不一致

声音与人物画面时长不一致时，先区分明确锁定的声音、可调整声音版本、可用人物范围与既有编排。声音长于人物不等于必须拉伸人物、冻结说话口型或裁句尾。由总导演同时比较调整讲述、表演和画面：讲述已有作用就由人物外的有效镜头、Cutaway、图解或明确回看承接；静态或循环人物不能被当作自然说话表演。

需要修改声音时，先遵守现有授权与锁定约束。可修改旁白由导演为表达、观看顺序、阅读或节奏决定改稿与重生，不限于修正语义、表演错误。声音短于人物时，也先判断剩余画面是否承担动作结果、反应、环境与欣赏，不自动裁掉。声音改动后按实际时长重新组装，并复核字幕、Cue 和锁定编排。

## 技术质量

每个 SegmentAsset 检查非零文件、MIME、可解码、采样率、声道、真实时长、头尾静音和峰值。最终 Assembly 检查无重复段、顺序、空白、爆点和目标时长。技术通过后仍要四轮听感。

## 当前调用与读回：Story 与语音

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| Story 与语音 | `manage_story(base_revision_id, beats)`；`manage_voice_references(base_revision_id, asset_id)`；`submit_voice_synthesis(voice_reference_id? / voice_reference_asset_id?, speech_segment_ids?, idempotency_key?)` | `track_job`、`read_speech_asset`、`read_speech_timing`；旧 Timeline 必要时用 `rebuild_speech_timeline(base_revision_id)`。 |

## 当前调用与读回：旁白按帧留白

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| 旁白按帧留白 | `submit_speech_placement(base_revision_id, placements=[{speech_segment_id,start_frame}], duration_frames?, idempotency_key)`；按 Script 顺序提供全部当前已就绪段，起点为非负整数帧且互不重叠、不越过场景；可指定末段后的总轨结束帧 | Worker 复用现有段音频生成带静音总轨；成功后同一 Revision 更新 Dialogue、SpeechTiming 与稳定字幕。`track_job` 终态后读回并试听，旧 Revision 拒绝写入。 |
