# 旁白与视频同步

当现有 Visual 决定 Narration Timing 时，从 `voice` Skill 使用本 Reference。任务不只是生成 TTS；还要让 Spoken Meaning 与屏幕内容对齐。

## 何时使用

- 用户已有 Video、Timeline、Screen Recording、Slide Animation、Product Demo、B-roll Edit、MG Explainer 或类似 Visual Sequence。
- 用户提供 Narration Text、要求你编写 Narration，或要求为该 Visual Sequence 添加、替换、重做、配音或生成 Voiceover。
- Timeline 已有 Narration / Voiceover，用户要求 Trim、Speed Up、Slow Down、Reorder、Replace 或 Retime Visual，同时保持现有 Voiceover 对齐。
- 视频包含有意义的 Visual Section：Slide Change、Product State、Screen Step、Chart / Data Moment、Scene Cut、Action Beat 或关键 Visual Event。

不要等待用户明确要求 Sync。只要存在 Visual Target，除非用户只想得到独立 Audio Asset，否则默认 Narration 应遵循 Visual Content 和 Pacing。

不要把它作为剪辑原始真人 Speech 的主要路径。编辑现有 Spoken Content 时使用 Talking-head Workflow。

## 工作流

1. 读取 Project State，并识别精确 Visual Target：Timeline Range、Video Asset、Selected Item 或完整 Composition。如果有多个合理候选，询问哪一个需要 Voiceover。
2. 检查 Conversation 中是否已有可用 Narration Plan、Storyboard 或 Script Table。把它视为 Draft Sync Map，而不是已批准的 TTS Input。只有它为同一个当前 Visual Target 标明 Visual Anchor 和 Time Range 时才复用。如果 Target 已改变、Table 缺少 Visual Evidence，或某个 Boundary 只是猜测，只验证缺失或不确定的 Boundary，不要重新开始全部 Visual Review。
3. 让 Sync Map 始终绑定当前 Visual State。如果 Map 建立后的一次 Edit 改变了 Visual Content 出现位置，把受影响 Row 标记为 Stale。放置或复用 Voiceover 前，根据当前 Timeline / Asset State 重建或 Patch 这些 Row。Visual Retiming Edit 后不要继续使用旧 Visual Window。
4. 生成 Audio 前理解 Visual。需要时使用 Project Read、Timeline Screenshot 和 `inspect_asset` 进行 Source-frame Sampling。按可见 Content Change 划分 Target，不要按任意等长 Interval 划分。
5. 根据真实 Visual Evidence 建立 Visual-voiceover Sync Map。在每个 Segment 都有已确认 Visual Anchor 和 Placement Start Frame / Time 前，不要生成 TTS 或放置 Voiceover。对每个 Segment 记录：
   - Visual Start / End Frame 或 Time
   - Visual Anchor：Slide Title、Product State、Screen Action、Chart / Data Point、Scene Content 或 Event
   - Evidence：已检查 Frame / Time、Screenshot 或 Visual-analysis Result
   - 分配给该 Visual Moment 的 Narration Text
   - Target Duration 和 Estimated TTS Duration
   - Fit Status：fits / too long / uncertain
   - Voiceover Placement Start Frame 或 Time
   - Confidence 或 Uncertainty
6. 拆分或编写 Narration，使其适配 Visual Map。每个 TTS Segment 绑定一个 Visual Segment 或一个有意的 Multi-shot Beat。不要为包含多个 Visual State 的视频创建一个长 Audio File。提交 TTS 前，把每句 Narration 映射到 Visual Segment，并检查 Estimated TTS Duration 是否可能短于对应 Visual Window。对于短 Window，优先使用 Phrase-length Copy，而不是完整 Sentence。`fit status` 为 `too long` 或 `uncertain` 时，不要提交 TTS；先精简措辞、拆分 Line、调整受支持 Speed，或请用户批准 Timing Tradeoff。
7. 如果用户尚未选择 Voice，遵循 `voice` Skill 的 Audition Workflow。按映射 Segment 生成 TTS。
8. 每个 TTS Segment 完成后，放置前读取真实 Audio Duration。如果真实时长超过 Visual Window，或会让 Narration 描述当前屏幕上不存在的 Visual，不要立即放到 Timeline。最终交付前修复不匹配：
   - 精简或拆分 Narration
   - 在受支持且自然时调整 Speech Speed
   - 把 Placement 移到更合适的 Visual Range
   - 只有能保留 Edit 意图时才延长或 Hold Visual
   - Tradeoff 会改变 Meaning 或 Style 时询问用户
9. 只有 Actual-duration Fit Check 通过后，才放置每个 Voiceover Segment。把它放在当前 Sync Map 对应的 Visual Start Time。如果存在 Original Audio、Music 或 Sound Effect，根据用户意图决定 Mute、Duck、Replace 还是 Mix。
10. Patch 或重建 Stale Row 后，在宣称完成前读取更新后的 Timeline Position。确认 Caption Text、Spoken Content、Visual Segment、Placement 和 Actual Audio Duration 仍然对应。
11. 交付前进行最终 Coverage Check。用户期望解释的每个 Visual Segment 都应有匹配 Voiceover，或有明确 Silence 原因。Voiceover 不应早于 Visual 出现，旧 Voiceover 不应残留在 Timing 已变化的 Footage 上。如果当前 Turn 改变任何有 Narration 支持的 Visual Timing，在宣称完成前的回复中加入 `Final sync check`。
12. 放置后验证。读取 Item Start / End / Duration，并检查每个 Segment Start、Middle、End 附近的代表性 Frame。Preview 或 Screenshot 足够范围的 Timeline，确认 Spoken Meaning 与当前 Visual Information 匹配。

## 规则

- 不要把一条生成 Narration Track 覆盖在 Multi-section Video 上就宣称完成。
- 不要让一个 TTS Segment 描述已经消失或尚未出现的 Visual。
- 不要仅为了适配 Timing 而改写用户提供的 Narration，并改变 Claim、Name、Number 或 Intended Meaning。应询问用户或保留 Meaning。
- 除非用户要求 Replace、Dub、Mute 或 Voice Over，否则不要覆盖有意义的 Original Speech。
- 不要把 Slide / Video Length 当成充分证据。使用可见 Anchor 和 Content Change。
- 在每行都映射到 Visual Segment，并根据该 Segment 的 Target Duration 完成检查前，不要把 Script Table 或 Narration Draft 当成可直接提交的 TTS Input。
- 不要使用平均划分或粗略时长估计作为 Placement Boundary。如果 Boundary 只是估计，在该 Range 周围检查更多 Frame，直到确认 Content-change Frame；或让用户批准近似值。
- 不要静默地从 Visual-driven Sync 切换到 Narration-driven Timing。这会改变 Edit Contract。延长 Visual、允许 Desync、重叠 Voiceover，或让 Narration Timing 驱动 Cut 前，先询问用户。
- 不要因为 Generated TTS Asset 成功完成，就把它视为可放置。真实 Audio Duration 必须先通过 Sync Map 的 Fit Check。
- Timeline 或 Visual-source Edit 改变 Visual Content 出现位置后，不要复用旧 Sync Map。先 Patch 或重建受影响 Row。
- 在根据当前 Timeline 检查预期 Voiceover Coverage 前，不要报告完成。
- Retiming Turn 不要在 Timeline Edit 后立即结束。先读取更新后的 Item Position，并为每个改变的 Visual / Voiceover Pair 报告 `Final sync check`。

## 输出格式

计划或报告执行时，使用以下紧凑结构：

- `target_visual`：Asset / Item / Timeline Range
- `segments`：Visual Range、Visual Anchor、Narration Text、TTS Asset、Audio Duration、Target Duration、Estimated Duration、Fit Status、Placement Range、Mismatch Handling、Map Status
- `mix`：Original Audio / Music 发生了什么
- `Final sync check`：每个 Segment 的 Pass / Fail、Stale-map Fix、Coverage Gap，以及应用的任何 Timing Fix

