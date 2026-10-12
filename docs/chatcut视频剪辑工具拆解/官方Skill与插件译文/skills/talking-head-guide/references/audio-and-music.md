## Track 角色（开启自动 Ducking）

Track 的 `role` 是驱动音频混音的唯一声明。使用 `edit_track` 设置它，引擎会由此生成无缝 Ducking——跟随 Track 在语音下自动降低，在停顿中自动恢复——无需手动调节任何音量。只有两种角色，外加关闭状态：

- 口播 / 访谈 / 课程 Track（以及任何 Voiceover / Narration）是 **anchor**：把它的 `role` 设为 `anchor`。其他内容都会在它下面 Duck——必须设置，否则不会发生 Ducking。
- 应当位于语音下方的背景音乐、环境底床和 B-roll 音频底床 → **follower**：设置 `role: follower`（会在所有 anchor 下自动 Duck）。
- 短音效（SFX）、Stinger、Hit、Whoosh、Click 和其他剪辑强调通常不参与 Ducking → 默认不设置其 Track 角色，除非用户明确要求这些强调在语音下变小。
- 任何应排除在 Ducking 之外的内容 → 不设置 `role`（none）。

没有角色的 Track 行为与现在完全一致——角色是附加且安全的，因此只在内容用途明确时设置。

**先读取现有布局。** 创建 Track 或放置新片段前，读取当前 Track 名称和角色——如果某个 Track 已经为这种内容设置了标签（例如名为 “Music” 的 `follower`、名为 “VO” 的 `anchor`），把新片段放到那里，并匹配其角色；只有找不到合适 Track 时才创建新 Track。**先整理，再分配——角色按 Track 设置，因此尽量让一个 Track 只有一种角色。** 如果同类内容散布在多个 Track（例如语音同时位于 A1 和 A3），先把它们合并到一个 Track：使用 `edit_item` 移动片段（`updates[].trackId`），然后按 ID 使用 `edit_track` 删除清空的 Track。之后只设置一次角色。整理 Track 时，按照混音工程师阅读 Session 的方式堆叠——**语音/VO 放在最上方音频轨 A1，音乐放在下面**——并使用 “VO” 或 “Music” 等简短名称，让语音容易找到。这是合理默认值，不是硬性规则；如果用户意图要求不同布局，应遵循用户意图。但要保持有意的分离——不同说话人、时间上重叠的片段或刻意分层的内容分别保留在自己的 Track 上（并分别获得相应角色）。分配后重新读取 Project，确认每个应作为 Anchor/Duck 的 Track 都已正确设置，同时音乐的基础音量保持不变。

## 背景音乐

### 目标

设定情绪，并抚平语音中的微小空隙。

### 原则

- 使用 `edit_track` 把音乐 Track 的 `role` 设置为 `follower`（并把口播 Track 的 `role` 设置为 `anchor`）。这一对设置会开启自动 Ducking——引擎在语音期间降低音乐，在停顿中恢复。
- 尽可能让 `edit_track` 根据当前 Timeline 响度初始化 `audioRouting.duckDepthDb`。只有在用户明确希望语音下的音乐更响或更轻时，才自行传入 `audioRouting.duckDepthDb`。
- 默认保持 BGM 片段的基础 `decibelAdjustment` 自然。不要先使用很大的负片段增益预先降低音乐，再同时设置手动 `duckDepthDb`；只有用户明确要求更低的整体底床，以及更强/更弱的语音 Duck 时，才同时做两者。
- 默认不要把短音效（SFX）或 Stinger 放在 follower Track 上。把它们放在对应剪辑时刻，仅在明显过响或过轻时调整 Item 音量。
- 不要有突出的歌词
- 使用以秒为单位的 `audioFadeIn` / `audioFadeOut` 让 BGM 淡入淡出，通常为 1–2 秒。不要给这些字段传帧数。
- 语气与内容匹配

### 适配时长

A-roll 时序最终确定后，让 BGM 适配最终视频范围。目标时长从 BGM 起点延伸到真实内容结束（视频 / 视觉 / 语音 Item），计算时不包含 BGM 本身，因此音乐绝不能延长渲染范围。

- 除非用户指定不同 BGM 起点，否则从第 0 帧开始 BGM。
- 如果生成的 BGM 比目标长，在 BGM 起点放置一个 `audio` Item，把时长设为目标时长，并添加淡出。不要让完整音乐 Asset 超过最后一个视觉 Item。
- 如果生成的 BGM 比目标短，不要把一个音频 Item 拉长到超过 Asset 时长；那会以静音结束。应平铺多个 `audio` Item，直到覆盖目标时长。
- 放置平铺 BGM 前，考虑计划中的 1–2 秒重叠，计算覆盖完整目标时长所需 Segment 数量。一次性放置所有 Segment，让整条 Timeline 都有覆盖，再把最后一个 Segment 裁切到目标终点。
- 对平铺 BGM，交替使用音频 Track（例如 A2/A3），让相邻重复段可以重叠 1–2 秒。让前一个 Segment 淡出，后一个 Segment 在重叠区淡入。

### 引擎如何 Duck 音乐

只要音乐 Track 的 `role` 是 `follower`，Ducking 就会自动发生：引擎会在有声音的 `anchor` Track（语音 / Voice）下降低该 Track，并在停顿和结尾恢复到完整音量。这需要两部分同时存在——音乐 Track 为 `role: follower`，口播 Track 为 `role: anchor`（参见上面的 Track 角色）。如果没有任何内容被设为 `anchor`，就不会发生 Ducking，音乐会保持完整音量。

把音乐设置为在没有语音时正常、可听的基础音量。要调节语音下的降低深度，更新 follower Track 的 `audioRouting.duckDepthDb`；否则保持不设置，让 `edit_track` 在可用时根据 Timeline 响度自动初始化。不要通过大幅降低片段音量、同时手动加深 Duck 来解决语音清晰度。要让某个 Track 完全不参与 Ducking（例如必须穿透的 Stinger），不要设置其 `role`（none）。

