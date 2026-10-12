---
name: voice
description: |
  Text-to-Speech（TTS）、音色克隆、Voiceover、Narration 放置 / 同步，以及自定义 Sound Effect（SFX）生成器。当用户希望根据文字生成 Speech、希望从上传的参考音频克隆已获授权的音色、希望为现有 Video / Timeline 添加 / 替换 / 对齐 Narration 或 Voiceover、希望在 Visual Retiming Edit 后保持现有 Voiceover 同步、需要音色试听 / 选择，或明确需要 Sound Effects Library 中没有的新生成 / 自定义 Sound Effect 时使用。
user-invocable: true
---

# Voice 与 Sound Effect 生成器

生成 Voiceover（TTS）和 Sound Effect。对于 TTS，在调用 `submit_voice` 前选择明确的 Provider 和 Voice。

## 何时使用

- 根据文字生成 Voiceover / Narration
- 为视频创建 Text-to-speech Audio
- 为现有 Video、Timeline、Screen Recording、Slide Animation、Product Demo、B-roll Edit、MG Explainer 或其他 Visual Sequence 添加、替换或重做 Narration / Voiceover
- 在 Trim、Speed Up、Slow Down、Move、Reorder 或 Replace 所描述 Visual 后，让现有 Narration / Voiceover 继续保持对齐
- 用户尚未选择明确 Voice 时，提供并试听 TTS Voice Choice
- 根据 Reference Audio 克隆用户自己的音色，或用户明确获授权的音色
- 只有先检查 Sound Effects Library 后，才根据文字描述生成 Custom Sound Effect

## TTS（Text-to-Speech）

如果当前请求有现成 Visual Target，且用户希望为它生成 Narration、Voiceover、Dubbing 或 Replacement Speech，在编写新 Narration、使用现有 Narration Text 生成 TTS，或放置 Audio 前，阅读 [references/video-sync.md](references/video-sync.md)。即使用户没有明确说“sync”或“match the visuals”，也要这样做；Visual Target 的存在意味着 Narration Timing 和 Meaning 可能需要跟随 On-screen Content。只有没有 Visual Target，或用户只想根据文字获得独立 Audio Asset 时，才使用普通 Standalone TTS 路径。

如果 Timeline 已有 Narration / Voiceover，用户要求修改 Visual 同时保持该 Voiceover 对齐，也要阅读 [references/video-sync.md](references/video-sync.md)。即使不需要新 TTS，这仍是 Sync Maintenance Task。

最终 TTS 使用 Curated Voice 或 Cloned Voice 调用 `submit_voice`。`manage_custom_voice` 只用于 List、Create、Preview、Apply、Rename 或 Delete 克隆的 Fish Audio Voice。当前约定如下：

- `provider` 必需。中文优化 Narration 使用 `doubao`；英文或多语言 Narration 使用 `elevenlabs`；已 Ready 的 ChatCut Custom Voice 使用 `fish-audio`。
- `voiceId` 必需，且为 Provider-specific。不要混用 Catalog。
- `submit_voice` 只创建 Audio Asset。Timeline Placement、Replacement、Trimming 和 Alignment 之后通过 Timeline Tool 完成。
- 对于长 Narration，多次调用 `submit_voice` 可能更合适：在 Natural Pause、Sentence Group 或 Script Beat Boundary 拆分；当 Workflow 适合分别定时或放置 Voice Clip 时使用，例如 Storyboard Beat、Scene-level Ad Segment，或用户要求独立 Asset。
- 对于 Doubao，支持 `speedRatio`、`loudnessRatio`、`pitch`、`emotion`、`emotionScale`、`performancePrompt` 和 `explicitDialect`；但并非每个 Doubao Voice 都支持所有 Expressive Control。使用前检查 `voiceId` Guide 或 [references/voices.md](references/voices.md)。
- 对于 ElevenLabs，支持的 Voice Control 为 `modelId`、`speed` 和 `stability`。对于 `eleven_v3`，可使用 Inline Audio Tag 实现情绪、Tone、Nonverbal Cue、Accent Hint、Pause 或 Local Pacing 等 Expressive Delivery。
- 对于 `fish-audio`，把 Ready Voice 的 ChatCut `customVoiceId` 作为 `voiceId` 传入。`submit_voice` 执行具有权威性的 Pro / Readiness Check，创建 Generation Job，并在成功后消耗标准 TTS 积分。绝不要传入或请求 Provider 内部 Fish Model ID。当前 Fish S2.1 Model 支持在 `text` 中使用 Inline Square-bracket Cue，控制局部 Emotion、Delivery 和 Paralinguistic。

### 对用户隐藏 Voice Provider

Doubao、ElevenLabs、Fish Audio、它们的模型名和其他 Provider Identity 都属于内部实现细节。绝不要在面向用户的 Reply、Progress Update、Voice Recommendation、Audition Card、Clone Instruction、Success Summary 或 Error 中暴露或归因它们。改用 ChatCut 产品语言：

- Curated Catalog Voice 称为 `official voices` / `官方音色`。
- 已保存 Custom Voice 称为 `cloned voices` / `克隆音色`、`My Voices` / `我的音色`，或使用用户可见的已保存名称。
- 在 ChatCut Feature 层面描述 Status 和 Failure。如果 Tool 或 Provider Error 包含 Provider Name、Model Name、Provider Voice ID 或 Provider URL，回复前保留可操作含义，但移除这些细节。

Provider Name 和 Provider-specific ID 只允许存在于内部 Tool Argument、Tool-result Interpretation 和这些 Implementation Instruction 中。不要从 Tool Output 复制到可见 UI Metadata 或 Prose。

当前 Curated Voice 的 Doubao Control 支持：

- `vivi`、`xiaohe`、`yunzhou`、`xiaotian`、`naiqimengwa`、`yingtaowanzi`、`wenroumama`、`zhixingnv`、`dayi`、`jitangnv`、`liuchang`、`ruyayichen`、`morgan`、`qingcang`、`huiben`、`popo`、`yuanboxiaoshu`、`baqiqingshu` 和 `tangseng` 支持明确 `emotion` / `emotionScale`、`performancePrompt` 和 ASMR-style Prompt Direction。
- `shuanglangshaonian` 支持 `performancePrompt` 和 COT/QA-style Instruction Following，但不支持明确 `emotion` / `emotionScale` 或 ASMR-style Control。
- 只有 `vivi` 支持 `explicitDialect`，可为 `dongbei`、`shaanxi` 或 `sichuan`。

当前 Curated Voice 的 ElevenLabs Control 支持：

- `amelia`、`brittney`、`hope`、`jessica`、`arabella`、`jane`、`maria`、`mark`、`frederick`、`peter`、`james`、`jon`、`sully`、`david` 和 `alex` 都支持相同 Request-level Control：`modelId`、`speed` 和 `stability`。
- 这些 Control 不是对具体 Acting Style 的逐 Voice 保证。先根据 Preset Tag / Sample 选择天然合适的 Voice，再使用这些 Control 做适度 Delivery Adjustment。
- 对于 ElevenLabs `eleven_v3`，当用户要求情绪、Tone、Nonverbal Cue、Accent Hint 或 Local Pacing 等 Expressive Delivery 时，可使用 Inline Audio Tag。Official Example 涵盖以下实用 TTS 类别：Emotion / Tone Tag，例如 `[happy]`、`[sad]`、`[angry]`、`[excited]`、`[curious]`、`[sarcastic]`、`[crying]`、`[annoyed]`、`[appalled]`、`[thoughtful]`、`[surprised]` 和 `[mischievously]`；Vocal Delivery 和 Nonverbal Cue Tag，例如 `[whispers]`、`[laughs]`、`[sighs]`、`[exhales]`、`[inhales deeply]`、`[clears throat]`、`[snorts]`、`[swallows]`、`[wheezing]` 和 `[coughs]`；Pacing / Pause / Local Speed Tag，例如 `[slowly]`、`[pause]`、`[short pause]`、`[long pause]`、`[rushed]` 和 `[drawn out]`；以及 Accent / Special-performance Tag，例如 `[strong X accent]`（例如 `[strong French accent]`），再加 `[sings]`、`[singing]`、`[woo]` 和 `[pirate voice]`。Official Example 不是穷举；用户明确要求该 Delivery，且 Tag 描述 Voice 应如何听起来而不是 Visual Action 时，可以尝试类似 Auditory Tag。把 Tag 直接写进 `text`，靠近它要影响的短 Phrase。把 Tag 当作 Local Guidance，而不是 Paragraph-wide Control。
- 对于 `eleven_v3` 的 Pause 和 Pacing，需要时使用 Punctuation、Text Structure、较短 Generated Segment，或 `[short pause]`、`[slowly]` 等 Local Audio Tag。

Cloned Voice 的 Fish Audio Control 支持：

- 当前 `fish-audio` Route 使用 Fish S2.1。把简洁自然语言 Cue 直接以方括号形式放进 `submit_voice.text`，例如 `[happy]`、`[calm]`、`[angry]`、`[excited]`、`[whisper]`、`[laugh]`、`[sigh]`、`[gasp]`、`[pause]`、`[emphasis]`、`[inhale]` 或 `[exhale]`。S2.1 不受固定 Tag List 限制，因此 `[whispers sweetly]` 或 `[laughing nervously]` 等具体 Auditory Description 也有效。
- 把 Cue 放在要影响的 Phrase 或 Moment 之前。Fish S2.1 接受 Text 任意位置的 Cue，因此多个短 Cue 可以创建局部 Transition，例如 `[calm] 先别着急。[excited] 好消息是，我们已经找到解决办法了！` 或 `I thought it was over [gasp] but then the lights came back [relieved].`
- 只在请求的 Delivery 确实受益时节制使用 Cue。在 Transition 处优先使用一个清晰 Instruction，而不要堆叠冲突方向。把结果视为 Model Guidance，而不是 Deterministic Editing Boundary；当 Exact Clip-level Timing 或独立重试重要时，拆成多个 `submit_voice` 调用。
- 不要在该 Route 使用 Fish S1 旧版 `(parenthesis)` Emotion Syntax，也不要添加单独的 `emotion` Argument：S2.1 Cue 属于 `text` 内部。默认 Voice-cloning Preview Line 保持无 Tag。不要代表用户向 Custom Preview 添加 Cue，但要保留用户在 100 字符 Preview Limit 内有意写入的 Cue。

```ts
// English / multilingual via ElevenLabs
mcp__skill__submit_voice({
  provider: "elevenlabs",
  text: "Hello world",
  voiceId: "peter",
});

// Chinese via Doubao
mcp__skill__submit_voice({
  provider: "doubao",
  text: "你好世界",
  voiceId: "liuchang",
});

// With speed adjustment (Doubao only)
mcp__skill__submit_voice({
  provider: "doubao",
  text: "这是一段稍快的中文旁白。",
  voiceId: "liuchang",
  speedRatio: 1.5,
});

// With expressive Doubao controls
mcp__skill__submit_voice({
  provider: "doubao",
  text: "这次事故提醒我们，安全永远不能侥幸。",
  voiceId: "liuchang",
  emotion: "sad",
  emotionScale: 3,
  performancePrompt: "痛心但克制，语速稍慢，像新闻专题旁白",
  pitch: -1,
  speedRatio: 0.92,
});

// With ElevenLabs delivery controls
mcp__skill__submit_voice({
  provider: "elevenlabs",
  text: "The launch changed how teams plan their daily work.",
  voiceId: "peter",
  speed: 0.95,
  stability: 0.4,
});

// With local Fish Audio S2.1 delivery cues on a ready cloned voice
mcp__skill__submit_voice({
  provider: "fish-audio",
  voiceId: "<confirmed custom voice id>",
  text: "[calm] 先别着急。[excited] 好消息是，我们已经找到解决办法了！",
  name: "Expressive custom voiceover",
});
```

## 生成前的 Voice Audition

### 只在最终动作中发出原生 Clone Entry

`<clone-voice/>` 是可执行的 Editor Action，不是 Prose、Code 或内部 Process Label。绝不要引用它、用 Backtick 包裹它、把它描述为下一步，也不要在 Progress Update、Pre-tool Explanation、Plan 或其他中间 Assistant Message 中发出它。

先完成所有必需 Inspection 和 Tool Call。如果之后 Native Dialog 仍是正确 Route，在该次运行最后一个面向用户的 Assistant Message 中发出一条简短 Localized Instruction，紧接着**恰好一个** `<clone-voice/>`，然后立即结束 Message。之后不要调用其他 Tool、添加更多 Prose 或再次发出 Tag。如果仍需其他 Tool Call，就不要先发出 Tag。一次 Agent Run 最多渲染一个独立 Native Clone Entry。

### 根据 Host 和可用 Reference 选择 Clone Route

加载 `widget-forms` 或询问 Clone Input 前，先决定 Host Path：

- 在 Native ChatCut Editor 中，先检查用户是否已为当前 Clone Request 提供可读取 Audio Attachment，或可访问的 ChatCut Audio Asset。如果已提供，不要让用户再次选择同一文件，也不要发出 `<clone-voice/>`。执行 Creation Preflight，只收集缺失的 Name、Preview Text 和 Explicit Authorization，然后使用下方 Agent-driven Cloning Flow 配合该 Audio Asset。
- 在 Native ChatCut Editor 中，只有尚未提供可用 Reference 时才使用 Editor Dialog。给出一句简短 Localized Instruction，紧接着恰好一个 `<clone-voice/>`，然后停止。Dialog 负责 Recording / Upload、Authorization、Naming、Preview Generation 和其余 Interactive Flow。
- 在外部 Codex / Claude Host 中，绝不要发出 `<clone-voice/>`；这些 Host 不会渲染或 Dispatch Native Editor Action。使用下方 Agent-driven Attachment Flow。

Project 中任意已有 Voice 既不是 Consent，也不是 Cloning Reference。只有用户为当前 Clone Request 提供或指定该 Audio，并在之后给出下方要求的完整 Authorization 时，才使用 Direct Path。

### 根据 Live State 选择交互

把 Custom-voice Lookup 视为 Mandatory Gate。只要用户请求 TTS，但没有命名明确 Preset 或明确 Custom Voice，也没有明确选择或请求 Voice Cloning：

1. 如果尚未加载 `manage_custom_voice`，通过 `ToolSearch` 加载。
2. 调用 `manage_custom_voice action="list"`。
3. 使用返回的 Ready Voice 和 Name 选择下方交互。

在读取 Curated Voice Catalog、推荐 Official Voice 或渲染任何 Voice-selection UI 前执行。绝不要根据 Chat History 推断用户保存的 Voice。

明确要求 Clone Voice 已经是一种明确 Source Choice。此时不要仅为了在 Official、Saved 和 Cloned Voice 之间选择而调用 `manage_custom_voice action="list"`。先确认当前 Request 是否已经提供可用 Reference；执行任何必需 Creation Preflight；然后遵循所选 Host Route。Standalone Native Entry 只能在这些工作完成后，依照上方 Final-action Discipline 出现。

Agent 可以从 Narration Text 推断有用的 Tone、Mood、Delivery 或 Use-case Suggestion。把它们当作 Recommendation Signal，不是用户对 Voice Source 的选择。合理推断绝不能绕过下方 Existing Custom-voice Question。

渲染任何内容前，对请求分类：

- **明确 Custom Voice：** 用户命名一个 Ready Custom Voice，或选择唯一具名 Custom-voice Pill 时，使用该精确 Voice。用户选择 `Choose my cloned voice` 且有多个 Ready Voice 时，继续前只把这些 Ready Custom Voice 显示为可播放 Choice。
- **明确 Official Preset：** 使用或确认该精确 Preset；不要重新打开 Source-choice Branch。
- **已选择 Clone Action：** 只有现在才进入上方 Host-specific Cloning Route。在 Native Editor 中，显示简短 Instruction + `<clone-voice/>`。在外部 Codex / Claude Host 中，开始下方 Attachment Workflow。Agent 必须在紧接着的下一条 Reply 中主动提供该 Host-specific Entry。不要等待用户再次询问、让他们打开 Menu / Panel，或把 Clone Choice 留成未处理 Pill。在 Native Editor 中，先完成任何必需 Inspection / Preflight，再把唯一 Entry 放进该次运行最终 Assistant Message，并停止。
- **至少一个 Ready Custom Voice，但没有命名明确 Voice：** 始终先询问使用哪种 Source，再显示 Official Recommendation——即使用户描述了 Voice Trait，或 Narration Text 暗示 Tone。该 Source Question 优先于下方 Branch。在 Native ChatCut 使用 `<choices/>`，在外部 Host 使用当前 Host Adapter 对应的 Single-choice Surface。
  - 恰好一个 Ready Custom Voice 时，把它作为第一个、明确的 Option，例如 `Use “Joey”`，后跟 `Choose an official voice` 和 `Clone another voice`。
  - 多个 Ready Custom Voice 时，首先提供 `Choose my cloned voice`，后跟 `Choose an official voice` 和 `Clone another voice`。
  - 保留任何 Explicit 或 Inferred Voice Requirement。只有用户选择 Official-voice Branch 时才应用。
- **没有 Ready Custom Voice，也没有 Voice Preference：** 按 Conversation 本地化后提供 `Official voices` 和 `Clone my voice`。这是一次 Branch Decision，不是 Audition Grid 或 Structured Intake Form。
- **没有 Ready Custom Voice，但已有 Voice Requirement：** 优先使用 “middle-aged male”“warm female”“professional” 等 Explicit Requirement；否则可根据 Narration 合理推断 Trait 来指导 Recommendation。在同一个 Selection Surface 中显示 2–4 个匹配 Official Playable Card 和一个 Clone Action Card。不要在该 Reply 后附加独立 `<clone-voice/>` Button。

本地化 Branch Label，并根据 Live State 调整。使用以下含义：

- Chinese:
  - Named custom: `使用「<name>」`
  - Custom list: `选择我的克隆音色`
  - Curated catalog: `选择官方音色`
  - First clone: `克隆我的音色`
  - Additional clone: `克隆新音色`
- English:
  - Named custom: `Use “<name>”`
  - Custom list: `Choose my cloned voice`
  - Curated catalog: `Choose an official voice`
  - First clone: `Clone my voice`
  - Additional clone: `Clone another voice`
- Spanish:
  - Named custom: `Usar «<name>»`
  - Custom list: `Elegir mi voz clonada`
  - Curated catalog: `Elegir una voz oficial`
  - First clone: `Clonar mi voz`
  - Additional clone: `Clonar otra voz`

Native Chinese Example：

```text
<!-- No ready custom voice and no voice preference -->
<choices options="选择官方音色,克隆我的音色"/>

<!-- Exactly one ready voice named Joey and no voice preference -->
<choices options="使用「Joey」,选择官方音色,克隆新音色"/>
```

Trait 明确时，把 Action 放进 Playable Grid：

```html
<visual-option value="clone_voice" name="克隆我的音色" />
```

Voice Selection 中始终暴露一条适当 Cloning Path，但绝不要在同一 Reply 中同时显示 Clone Action Card 和独立 Native `<clone-voice/>` Entry。Provider Availability、Plan 和 Quota 决定用户选择 Cloning 后发生什么，而不是决定该 Choice 是否可见。提供该 Choice 不需要 Consent；只有在调用外部 Clone Tool 前，才需要 Explicit Permission 和受支持 Reference。

推荐、渲染或提交任何 TTS Voice Option 前，阅读 [references/voices.md](references/voices.md)。把该文件作为 Preset ID / `voiceId`、Provider Choice、Display Label、Tag 和 Sample URL 的 Preset Source。不要根据 Memory、Translated Name 或宽泛用户描述创建 Voice Option。

先确定两种相互独立的语言：

- User Conversation Language：用户与你对话所使用的语言。用于 Surrounding Copy、Option Name 和 Summary。
- Target Narration Language：要合成文字的语言。只用于选择 Provider 和 Voice Catalog。

收集 Input 或渲染 Choice 前加载 `widget-forms`。该 Skill 负责当前 Host 的 Form、Attachment 和 Media-card Behavior。本 Skill 负责 Voice Candidate、Required Field、Safety Rule 和传给 Voice Tool 的 Asset ID。不要在此嵌入 Host-specific UI Instruction。

`"help me generate ... voice over in Chinese"` 是一段英文对话，要求中文 Narration，因此 Audition Widget Copy 保持英文，而 Voice Candidate 来自 Doubao。

对于 Official Audition：

1. 按 Target Narration Language / Provider 和用户明确的 Gender、Age Range、Tone、Use-case Requirement 筛选 `references/voices.md`。如果没有 Explicit Requirement，用户选择 Official Voice 后，可根据 Narration 合理推断 Tone / Use-case Trait 来指导 Shortlist。把 Inferred Trait 表达为建议，而不是用户已声明 Preference。如果没有 Voice 满足所有 Explicit Requirement，说明这一点并提供最接近的受支持 Preset。
2. 选择 2–4 个匹配 Curated Preset。
3. 加载 `widget-forms`，请求一个 Required `playable_single_choice`。为每个 Curated Option 提供 Stable Preset ID、Localized Display Label、Localized Summary，以及 `references/voices.md` 中匹配的 Sample Path。每个文档中的 `/voice-samples/...` 值都是完整 Editor Asset Reference：逐字传入。绝不要添加推断出的 S3、CDN、Editor、Localhost 或 Production Base URL，也不要根据 Filename Pattern 重建 Absolute URL。这与 Custom Voice 的 `previewUrl` 不同，后者必须逐字使用 `manage_custom_voice` 返回值。
4. 只有本次 Audition 是第一个 Voice-selection Surface，且用户尚未选择 Official-voice Branch 时，才添加一个 Stable Value 为 `clone_voice` 的 No-media Action Option。没有 Ready Custom Voice 时 Label 为 `Clone my voice`；已有时为 `Clone another voice`；按上方含义本地化。在 Native ChatCut 中，它是没有 `media` 的紧凑 `<visual-option>`，不是独立 Button。在外部 Host 中，它是等价 Label-only Option。如果用户通过上方定义的 Localized Official-voice Branch 进入本次 Audition，只显示 Curated Official Voice；不要在 Audition Grid 中重复 Clone Action。
5. 等待用户选择。如果 Answer 映射到 `clone_voice`，在下一 Turn 渲染 Host-specific Cloning Entry / Workflow；不要从 Audition Reply 本身开始 Cloning。
6. 对于 Curated Preset，调用 `submit_voice`，把所选 Preset ID 作为 `voiceId`。
7. 对于现有 Custom Voice，调用 `manage_custom_voice action="apply"`，传入其完整映射 `customVoiceId`。用户请求 Final Speech 时，把同一 ID 作为 `voiceId` 传给 `submit_voice`，并使用 `provider: "fish-audio"`。

对于只包含 Custom Voice 的 Audition，包含每个具有 `previewUrl` 的相关 `ready` Custom Voice。使用完整 `customVoiceId` 作为 Stable Value、保存名称作为 Display Label、存在时使用 `previewText` 作为 Summary，并把 Tool 返回的精确 `previewUrl` 作为 Audio Media。不要 Copy、Download、Rewrite、按 Hostname Validate 或虚构该 URL。如果 Ready Voice 缺少 Preview，仍可按名称选择，不要虚构 Media。

保持每个 Curated Option 的 ID、Display Label、Sample 和 Summary 绑定到 `references/voices.md` 的同一 Row；保持每个 Custom Option 绑定到同一个 Tool-returned Voice Tuple。Target Narration Language 只选择 Curated Catalog；Conversation Language 控制所有可见 Copy。在 Context 中保留 Label-to-ID Map，让返回可见 Label 的 Host 仍能映射到精确 ID，无需再次确认。

## Custom Voice Cloning

Voice Cloning 是独立的 Consented Flow。Voice Selection 中必须主动提供它，但提供选项不等于开始 Clone。绝不要仅因为 Project 中存在一个 Clip 就克隆第三方 Voice。

### Native ChatCut Editor

如果用户尚未为当前 Clone Request 提供可用 Reference Audio Attachment 或 ChatCut Audio Asset，把 Creation 委托给现有 Editor Dialog。渲染 `<clone-voice/>`；不要先在 Agent Widget 中询问 Voice Name、Language、Reference Upload 或 Consent。Dialog 负责最新 Entitlement 和 Slot Check、Recording / Upload、Authorization、Durable Source Storage、Fish Audio Registration、Preview 和 Retry。

如果用户已经为当前 Clone Request 提供可用 Reference，不要把他们送回 Dialog，也不要要求重新选择文件。遵循下方 **Agent-driven cloning from an available reference**。Creation Preflight 成功后，只收集缺失 Field：Explicit Authorization、Voice Name 和 Preview Text。然后使用已解析的 ChatCut Audio Asset ID 调用 `manage_custom_voice action="clone"`。

对于 Dialog Path，由 Agent 负责呈现 Entry：用户选择 Clone Branch 后，立即主动发送一句简短自然、提示用户可点击下方 Button 开始 Clone 的话，然后恰好一个 `<clone-voice/>`。根据 Conversation 和 Language 调整措辞。在所有必需 Tool 完成后，它必须成为该次运行最终 Assistant Message；绝不要放进 Pre-tool 或 Intermediate Message。示例：

- Chinese: `可以点击下方按钮开始克隆你的音色啦。`
- English: `Click the button below to start cloning your voice.`
- Spanish: `Haz clic en el botón de abajo para empezar a clonar tu voz.`

这些只是示例，不是固定 Copy。不要说“follow these steps”，也不要暗示 Agent 将收集 Clone Input。绝不要等待另一条 User Prompt，也不要把用户重定向到 Editor Menu 自己寻找 Cloning。

用户点击 Apply 后，Editor 会把 Cloned-voice Attachment 和 `Continue generating with this voice.` 的本地化等价文本一起插入 Prompt Draft。等待用户发送该 Draft。附加的 Hidden Voice Context 包含精确 Custom Voice ID；实际请求 Final Speech 时，使用 `submit_voice provider="fish-audio"` 继续现有请求。不要发出 Raw `<audio>` HTML 或第二个 Retry / Apply Widget。

### 从可用 Reference 进行 Agent-driven Cloning

以下任一情况使用此 Flow：

- Native ChatCut Agent 已拥有用户为当前 Clone Request 提供的可读取 Attachment 或可访问 ChatCut Audio Asset；或
- 外部 Codex / Claude Host 因无法打开 Native Editor Dialog，正通过 Conversation Attachment 收集 Reference。

在用户提交 Explicit Permission 前，绝不要调用 Clone Action。ChatCut 在 Fish Audio Registration 前，会把每段提交的 Clone-source Recording 持久归档到自己的 User-file Storage。即使 Project Asset 后来被删除，该 Source 也会保留以支持未来 Provider Migration；不要仅为了创建 Voice 而要求用户重新录制或重新选择已经可访问的 Reference。

用户选择 `clone_voice` 后，先解析当前 Clone Request 已提供的任何 Reference，再要求另一次 Upload。不要使用 `providerAvailable:false` 阻断 Intake；Choice 渲染后 Provider Integration 可能被启用，Clone Action 才是权威 Availability Check。当 Account 无法再创建 Clone 时，在收集无用 Input 前使用 Entitlement 和 Slot Field 说明 Upgrade 或 Quota Full。如果 Clone Action 本身返回 `CUSTOM_VOICE_PROVIDER_NOT_CONFIGURED`，说明 Cloning 暂时不可用，并在 Context 中保留请求的 Name 和已导入 Reference Asset，以便之后重试 Flow。

询问 Name、Recording、Upload 或 Consent 前，调用 `manage_custom_voice action="check-create-access"`，并把该最新结果视为权威 Creation Preflight。不要只使用 `list` 做 Entitlement Check：`check-create-access` 会有意为不符合条件的 Free Account 发出 Runtime Feature-gated Upgrade Card。

- Free Account 且 `freeTrialAvailable:false`：不要收集另一个 Reference。说明 Free Custom-voice Slot 已被占用，用户必须删除现有 Voice 或 Upgrade 才能创建另一个。在 Native Editor 中产品会打开 Pricing Dialog；在 Agent Conversation 中，现有 Feature-gated Upgrade Card 是等价交互。不要虚构 Purchase URL，也不要绕到它后面继续 Cloning。
- Pro Account 且 `activeVoiceCount >= voiceSlotLimit`：不要收集另一个 Reference。准确说明当前 Active Voice 数量，以及已达到当前 Plan Limit；然后提供两个 Conversational Action：通过 Runtime Upgrade Card 升级 Plan，或 Close / Continue 使用现有 Voice。在用户升级或释放 Slot 前，不要调用 `clone`。
- 否则继续下方 Intake。Stale Preflight 绝不能覆盖 Clone Endpoint：如果 `clone` 仍返回 `FEATURE_NOT_INCLUDED` 或 `CUSTOM_VOICE_QUOTA_EXCEEDED`，遵循相同 Recovery Path，不要自动重试。

1. 说明 Reference Audio 将被安全处理，以创建可复用 Cloned Voice。不要说明底层 Provider。
2. 要求一个 Name、Explicit Authorization / Risk Confirmation、Preview Text 和一个有效 Reference Audio。用户已经提供 Reference 时，复用它，只询问其他缺失 Field。用户必须确认 Speaker 是自己或已获 Permission，并承诺不会把该 Voice 用于 Impersonation、Fraud 或 Unlawful Activity。ChatCut 会检测上传 Audio 的 Language，因此不要让用户选择 Language。稳定支持的 ChatCut Format 为 AAC、FLAC、M4A、MP3、OGG、WAV 和 WebM。要求 10 秒到 3 分钟；推荐 30–60 秒无 Music、Reverb 或 Background Noise 的干净 Solo Speech。
3. 加载 `widget-forms`，只请求以下 Host-neutral Intake Contract 中缺失的部分：
   - `voice_name`：`short_text`，Required。
   - `voice_reference`：`audio_reference`，只有尚未解析可用 Reference 时，才要求恰好一个 Required Recording 或 Attachment。
   - `preview_text`：`short_text`，Editable，最多 100 个 Unicode Character。预填下方 Localized Default，但允许用户替换成希望在 Cloned-voice Preview 中听到的任意文字。
   - `voice_consent`：`explicit_consent`，Required，初始未选中。Host 支持 Media Field 时，让 Adapter 把缺失 Field 放进一个 Intake。如果 Host 单独收集 Conversation Attachment，遵循 Adapter Attachment Flow，不要把附加 File 当成 Consent。不要重新询问用户已在当前 Clone Request 中明确提供的 Field。

Authorization 和 Use Commitment 是硬性 Continuation Gate。Intake 返回后，独立验证用户是否肯定地提交了上方要求的精确 Localized Authorization Option。出现该 Confirmation 前停止：不要导入附加 Reference，不要调用 `manage_custom_voice action="clone"` 或 `action="preview"`，也不要声称 Cloning 已开始。提供 Name、Attachment、泛泛的“yes”、之前无关的 Approval，或显示其他 Field 已完成的 Widget State 都不构成 Authorization。如果 Authorization 缺失或模糊，只再次请求完整 Authorization Confirmation，并等待用户 Answer。

Clone 前把提交结果 Normalize 为：

```ts
{
  voiceName: "<submitted name>",
  sourceAssetId: "<ChatCut audio assetId>",
  previewText: "<submitted preview text or localized default>",
  confirmedConsent: true,
}
```

所有可见 Copy 根据 User Conversation Language 本地化。Authorization Checkbox 使用与 Create Voice Dialog 相同的 Product Copy，不要改写：

- Chinese: `我确认拥有该音色或已获得克隆授权，并承诺不将其用于冒充他人、欺诈或其他违法用途。`
- English: `I confirm that I own this voice or have permission to clone it, and will not use it for impersonation, fraud, or unlawful purposes.`
- Spanish: `Confirmo que esta voz me pertenece o que tengo permiso para clonarla, y que no la utilizaré para suplantar identidades, cometer fraude ni otros fines ilícitos.`

使用 ChatCut 检测到的 Language Tag，不要要求用户手动识别 Language。

Intake 最终必须解析为 ChatCut Audio `assetId`。如果 Host 返回可读取 Attachment，加载 `asset-import`，把它导入 Targeted Project，并使用返回的 Audio `assetId`。绝不要把 Local Path、Attachment URL 或 Raw Bytes 传给 `manage_custom_voice`。没有可读取 Audio 时，停止并要求提供。Trim 用户提交 `preview_text` 周围的 Whitespace 后使用。如果为空，使用 Localized Default：

- Chinese: `这是你的克隆音色，希望你喜欢这个效果。`
- English: `This is your cloned voice. Hope you like it.`
- Spanish: `Tu voz clonada. Espero que te guste.`

根据 User Conversation Language 选择 Default。最终 Preview Text 必须包含 1–100 个 Unicode Character。如果提交值更长，在 Clone 前要求用户缩短；不要静默截断或换成 Default。保留用户措辞，不要根据 Conversation Context 重写。

然后调用：

```ts
mcp__skill__manage_custom_voice({
  action: "clone",
  sourceAssetId: "<uploaded audio asset id>",
  name: "<submitted voice name>",
  confirmedConsent: true,
  previewText: "<submitted preview text or localized default>",
});
```

Tool 会等待 Cloning 和 Preview Generation 都完成。返回 Ready Voice 和 `previewUrl` 后，请已加载的 `widget-forms` Adapter 渲染一个 `playable_preview`：使用完整 `customVoiceId` 作为 Stable Value、提交的 Voice Name 作为 Display Name、提交的 `previewText` 作为 Summary，并把 Tool 返回的精确 `previewUrl` 作为 Audio Media。这是 Display-only Preview，不是另一轮 Intake 或 Selection Form。绝不要把 URL 写在 Prose 中、发出 Raw `<audio>` Element，或换成不受支持的 Markdown Audio / Link Syntax。

紧接着 Playable Preview，要求一个 Single Branch Decision：`Retry` / `重试` / `Reintentar`，或 `Apply` / `应用` / `Aplicar`。该 Branch Decision 使用 `<choices/>`，不是另一个 Form Widget。等待期间，在 Context 中保持完整 `customVoiceId`、提交 Name、提交 `previewText` 和 `previewUrl` 的映射。

- `Retry` 表示为同一个 Voice 收集 Replacement Recording 或 Upload；不要消耗另一个 Slot，也不要在 Replacement 成功前丢弃先前 Ready Voice。如果当前 Tool Surface 无法原位 Replace Source，说明该限制，而不是创建第二个 Voice。
- `Apply` 表示为当前 AI Draft / Request 选择 Cloned Voice。调用 `manage_custom_voice action="apply"`，传入所选 `customVoiceId`。该 Action 执行权威 Pro / Readiness Check，不生成 Audio，也不消耗积分。成功后，保留 Custom Voice ID 作为 Selected Voice，并继续 Conversation；只有用户实际要求生成 Final Speech 时，才调用 `submit_voice` 并使用 `provider: "fish-audio"`。如果它返回 `FEATURE_NOT_INCLUDED`，不要把 Voice 表示为已 Applied，也不要合成。说明 Free Clone 可以 Preview，但用于 Generated Narration 需要 Pro；Runtime Feature-gated Upgrade Card 是 Agent 中与 Editor Paywall 等价的交互。

Free Plan 可以尝试一次 Clone 并试听 Preview，但不能把 Cloned Voice 用于 Final TTS。Pro Custom-voice Slot 数量等于 `floor(monthly plan credits / 100)`；Ready 或 Processing Voice 占用一个 Slot。Slot Access 不包含免费 Generation：Final Cloned-voice TTS 使用普通 Voice-generation Credit，并且只在 Generation 成功后扣除。Backend 对三条规则都拥有权威解释。

用户要求使用 Cloned Voice 生成 Final Speech 时，使用 ChatCut Custom Voice ID 调用 `submit_voice`：

```ts
mcp__skill__submit_voice({
  provider: "fish-audio",
  voiceId: "<confirmed custom voice id>",
  text: "<final narration text>",
  name: "Custom voiceover",
});
```

如果 Tool 返回 `FEATURE_NOT_INCLUDED` / `feature_not_included`，告诉用户 Free 可以使用一个 Custom-voice Preview Slot，但 Final Cloned Voice TTS 需要 Pro。不要重试、切换 Voice，或通过另一个 Tool 提交 Provider ID 来绕过 Gate。Runtime 会为该 Blocker 发出标准 Pricing Upgrade Card；邀请用户 Upgrade 后重试。对于 Paid Account，表述为：已创建 `activeVoiceCount` 个 Voice，并达到当前 Subscription Plan 的 `voiceSlotLimit`；提供 Upgrade Action 和 Close / Continue Action。不要把 Quota Error 套用 Free-account Paywall Copy。

## Sound Effect

对于普通 Editing Sound Effect（SFX），**不要**先生成。花费积分前，优先使用内置 Sound Effects Library：

1. 调用 `browse_library`，使用 `category:"sound-effects"` 和类似 `"whoosh"`、`"camera shutter"`、`"notification"`、`"censor beep"` 或 `"record scratch"` 的 Query。
2. 检查返回的 `library:sound:<id>`。
3. 使用 `edit_item` 放置；把 `fromFrame` 作为 Sound 的 Anchor / Editorial Moment Frame：

```ts
mcp__core__browse_library({
  category: "sound-effects",
  query: "short whoosh transition",
});

mcp__core__edit_item({
  adds: [
    {
      type: "audio",
      assetId: "library:sound:whoosh-short",
      fromFrame: 120,
      trackId: "A1",
    },
  ],
});
```

只有以下情况才通过 `submit_sound` 根据文字描述生成 Sound Effect：

- 用户明确要求 Generated / Original / Custom Sound。
- 请求的 Sound 过于具体，现有 Sound Effects Library 无法满足。
- `browse_library({ category:"sound-effects", query })` 没有返回合适 Match。

```ts
// Custom/generated sound effect after the library has no suitable match
mcp__skill__submit_sound({ prompt: "A dog barking in the distance" });

// With custom duration (0.5-22 seconds)
mcp__skill__submit_sound({
  prompt: "Thunder and heavy rain",
  durationSeconds: 15,
});

// High prompt adherence
mcp__skill__submit_sound({
  prompt: "Sci-fi laser gun firing",
  promptInfluence: 0.8,
});
```

**改善结果的提示：**

- 具体：`"A dog barking loudly"`，而不是只有 `"dog"`
- 加入 Context：`"Footsteps on wooden floor in an empty room"`
- 指定 Style：`"Cinematic whoosh"` 或 `"8-bit game sound"`

## 参数

### TTS

| Field        | Description                             | Notes           |
| ------------ | --------------------------------------- | --------------- |
| `provider`   | `doubao`、`elevenlabs` 或 `fish-audio` | Required        |
| `text`       | 要合成的文字                            | Required        |
| `voiceId`    | Curated ID 或 ChatCut Custom Voice ID   | Required        |
| `speedRatio` | Speech Speed                            | 仅 Doubao       |
| `modelId`    | ElevenLabs Model ID                     | 仅 ElevenLabs   |
| `stability`  | ElevenLabs Stability                    | 仅 ElevenLabs   |
| `speed`      | ElevenLabs Speech Speed                 | 仅 ElevenLabs   |
| `name`       | Asset Name                              | Optional        |

### Custom Voice

| Action                | Required fields                                            | Result                                                |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `list`                | 无                                                         | Entitlement、Slot Count、Existing Voice               |
| `check-create-access` | 无                                                         | 收集 Reference 前的权威 Create Gate                   |
| `apply`               | `customVoiceId`                                            | Pro / Readiness Check；不生成即选择 Voice             |
| `clone`               | `sourceAssetId`、`name`、`confirmedConsent`、`previewText` | 可复用 Fish Audio Voice + Preview                     |
| `preview`             | `customVoiceId`、`previewText`                             | 刷新的短 Audition                                     |
| `rename`              | `customVoiceId`、`name`                                    | 更新后的 Product / Provider Display Name              |
| `delete`              | `customVoiceId`、`confirmedDelete:true`                    | 永久删除 Provider Voice 并释放 Slot                   |

不要使用或暴露单独的 `manage_fish_audio_voice` Tool。Fish Model ID、Public / Unlisted Publishing、Arbitrary Tag、Cover Image 和 Provider-level Catalog Management 都是内部 Integration Detail。只有用户明确确认后才 Delete；简单名称变更使用 `rename`。

### Sound Effect

| Field             | Description       | Notes          |
| ----------------- | ----------------- | -------------- |
| `prompt`          | Sound Description | Required       |
| `durationSeconds` | Duration          | 0.5–22 秒      |
| `promptInfluence` | Prompt Adherence  | 0–1            |
| `name`            | Asset Name        | Optional       |

## 音色

使用 `submit_voice` `voiceId` Guide 和 [references/voices.md](references/voices.md) 查看当前 Curated Preset List、Display Label、Tag 和 Sample URL。

### Voice Preset 是 Provider-specific——不要混用

ElevenLabs 和 Doubao 有不同 Voice Catalog。`vivi` / `dayi` 只属于 Doubao；`mark` / `amelia` / `james` 只属于 ElevenLabs。把 Doubao Name 传给 ElevenLabs（例如 `voiceId: "vivi"` 搭配 `provider: "elevenlabs"`）会失败。

需要特定 Voice 和特定 Language 时：

- 中文 Narration → 使用 `provider: "doubao"`，搭配 Curated Doubao Preset（`vivi`、`dayi`、`xiaohe`、`yunzhou`、`liuchang` 等），或已配置 Doubao Catalog 中的 Raw `speaker_id`。
- 英文 / 多语言 → 使用 `provider: "elevenlabs"` 和 ElevenLabs Preset。

## 硬性规则——绝不能做的事

1. 绝不要使用另一个 Provider 的 Voice Preset Name。
2. 没有命名明确 Voice 时，在执行 Mandatory Custom Voice `list` Gate 前，绝不要渲染 Official Voice Recommendation。
3. 至少一个 Ready Custom Voice 存在时，绝不要使用 Explicit 或 Inferred Voice Trait 跳过 Source-choice Prompt。
4. 用户已经选择 Official-voice Branch 后，绝不要在 Official Audition 中重复 Clone Action。
5. Voice 只被宽泛描述、用户尚未确认明确 Preset 时，绝不要提交 TTS。
6. 检查 [references/voices.md](references/voices.md) 前，绝不要推荐或渲染 TTS Voice Option。
7. 绝不要声称稳定 Age、Regional Accent、Pronunciation Dictionary 或 Exact Duration Control；当前 Tool 没有把它们暴露为可靠 Field。
8. 除非用户要求，否则绝不要用 TTS 替换 Original Recorded Speech。
9. 用户肯定地提交 Cloning Intake 要求的完整 Ownership / Permission 和 Lawful-use Commitment 前，绝不要导入或克隆 Reference Voice。绝不要根据 Attachment、另一个已完成 Field、泛泛 Approval 或之前无关 Context 推断该 Confirmation。
10. 绝不要通过把 Provider Voice ID 传给 `submit_voice` 或另一个 Generation Tool 来绕过 Cloned-voice Pro Check。
11. 用户已为当前 Clone Request 提供可用 Reference 时，绝不要强制打开 Native Clone Dialog，也不要让用户重新选择 Audio。执行 Preflight Access，收集缺失 Authorization、Name 和 Preview Text，然后从其 ChatCut Audio Asset ID Clone。
12. 绝不要把 Project 中无关 Speech 当成 Cloning Reference 或 Cloning Permission。
13. 绝不要把 Cloned-voice Preview 渲染为 Raw `<audio>` HTML、Markdown Link 或 Bare URL。使用 `widget-forms` `playable_preview` 和 Tool 返回的精确 `previewUrl`；Retry / Apply 放进当前 Host 要求的独立 Branch Control。
14. 绝不要在 Intermediate Message 中发出 `<clone-voice/>`，也不要在一次 Agent Run 中发出超过一次。先完成必需 Tool；如果 Native Dialog 仍是正确 Route，发出一条最终 Localized Instruction + 一个精确 Tag，然后立即停止。
15. 绝不要向用户暴露 Doubao、ElevenLabs、Fish Audio、Provider Model Name、Provider-specific ID 或 Provider URL。使用 `official voice` 和 `cloned voice` 产品术语，并从可见 Error 和 Status Message 中清理 Provider Detail。

