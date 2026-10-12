# 音色预设

本页是 Agent 使用的 Curated Preset Snapshot。Backend 保存 Source of Truth，并让本文件与其同步。

使用 Tag 作为选择 Filter。使用 Description 作为实用提示。除非 TTS Provider 为其提供明确参数，否则 Age、Accent、Pronunciation 和 Exact Duration 都不是稳定 Control。

## Doubao 中文音色

使用 Doubao 进行中文优化 Narration。

| Preset               | Official display | English display      | Tags                                                           | Selection hint                                                |
| -------------------- | ---------------- | -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `vivi`               | Vivi             | Vivi                 | female, young, friendly, general, short-explainer              | 日常中文 Narration、产品介绍、短 Explainer                    |
| `xiaohe`             | 小何             | Xiaohe               | female, young, soft, calm, tutorial, walkthrough               | 平静 Tutorial、产品 Walkthrough、Instructional Narration      |
| `yunzhou`            | 云舟             | Yunzhou              | male, young, neutral, business, explainer                      | Business Explainer、Fact Read、产品 Narration                 |
| `xiaotian`           | 小天             | Xiaotian             | male, young, bright, upbeat, casual                            | Casual Creator-style Video 和轻量 Social Narration            |
| `naiqimengwa`        | 奶气萌娃         | Childlike Boy        | male, child, cute, storybook, character                        | 可爱男孩 Character Line 和儿童故事                            |
| `yingtaowanzi`       | 樱桃丸子         | Cherry Voice         | female, child, cartoon, roleplay, character                    | Animation / Kid-oriented Character Dialogue                   |
| `wenroumama`         | 温柔妈妈         | Warm Mom             | female, middle-aged, warm, family, gentle                      | 家庭、Lifestyle、Parenting、温柔 Explanation                  |
| `zhixingnv`          | 知性女声         | Knowledgeable Female | female, middle-aged, calm, knowledge, explainer                | Education、Culture、Thoughtful Explainer                       |
| `dayi`               | 大壹             | Dayi                 | male, young, steady, formal, documentary, video-voiceover      | Formal Voiceover、Documentary、Corporate Narration             |
| `jitangnv`           | 鸡汤女           | Inspirational Female | female, young, warm, inspirational, emotional, video-voiceover | Motivational、Uplifting、Emotional Video Narration             |
| `liuchang`           | 流畅女声         | Smooth Female        | female, young, smooth, polished, video-voiceover, narration    | 干净产品 Narration 和精致 Video Voiceover                     |
| `ruyayichen`         | 儒雅逸辰         | Yichen               | male, young, elegant, premium, culture, video-voiceover        | Culture、Premium、Poetic、Documentary-style Narration          |
| `morgan`             | Morgan           | Morgan               | male, middle-aged, deep, knowledge, explainer                  | 深沉 Knowledge Explainer、Documentary、严肃 Narration          |
| `qingcang`           | 擎苍             | Qingcang             | male, old-like, authoritative, audiobook, character            | 有分量的 Narration、Dramatic Read、Audiobook Scene             |
| `huiben`             | 儿童绘本         | Storybook Voice      | female, young, gentle, storybook, audiobook                    | 温柔 Storybook 或 Bedtime-style Narration                     |
| `popo`               | 婆婆             | Grandma              | female, old, warm, story, character                            | Grandmother Character、Folk Story、Nostalgic Narration         |
| `yuanboxiaoshu`      | 渊博小叔         | Erudite Uncle        | male, middle-aged, knowledge, calm, explainer                  | 平静 Explainer、Cultural Commentary、Educational Narration     |
| `baqiqingshu`        | 霸气青叔         | Confident Uncle      | male, middle-aged, confident, audiobook, narrative             | Audiobook Narration、Long-form Story、Dramatic Read            |
| `shuanglangshaonian` | 爽朗少年         | Cheerful Teen        | male, young, cheerful, youthful, roleplay, character           | 明亮 Roleplay、Teen / Creator Dialogue、Youthful Scene         |
| `tangseng`           | 唐僧             | Tang Seng            | male, old-like, calm, roleplay, character                      | Monk-like Dialogue、Traditional Story、Steady Narration        |

重要说明：当前 Doubao seed-tts-2.0 Resource 没有提供明确的通用 Old-male Voice。`qingcang` 和 `tangseng` 是 Old-like Approximation，不是可保证的 Old-male Control。

### Doubao Control 支持

Curated Doubao Voice 的基础 Control：`speedRatio`、`loudnessRatio` 和 `pitch`。

Expressive Control：

- 支持 `emotion`、`emotionScale`、`performancePrompt` 和 ASMR-style Prompt Direction：`vivi`、`xiaohe`、`yunzhou`、`xiaotian`、`naiqimengwa`、`yingtaowanzi`、`wenroumama`、`zhixingnv`、`dayi`、`jitangnv`、`liuchang`、`ruyayichen`、`morgan`、`qingcang`、`huiben`、`popo`、`yuanboxiaoshu`、`baqiqingshu`、`tangseng`。
- `shuanglangshaonian` 只支持 `performancePrompt` 和 COT/QA-style Instruction Following。不要对该 Voice 使用 `emotion`、`emotionScale` 或 ASMR-style Prompt Direction。
- 只有 `vivi` 支持 `explicitDialect`；允许值为 `dongbei`、`shaanxi` 和 `sichuan`。

## ElevenLabs 英文 / 多语言音色

使用 ElevenLabs 进行英文或多语言 Narration。Official Accent Label 是 English-source Voice Cue，不是 Target-language Accent Control。

| Preset      | Accent   | Tags                                                       | Selection hint                                             |
| ----------- | -------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `amelia`    | British  | female, young, upbeat, narrative-story, social-media       | Story Read、Podcast Intro、Reel、热情 Advertisement         |
| `brittney`  | American | female, young, upbeat, social-media, fun                   | Creator Video、Recap、Hot-topic Commentary、How-to Clip     |
| `hope`      | American | female, young, upbeat, clear, social-media                 | 清晰 Short-form Narration 和快速 Explainer                  |
| `jessica`   | American | female, middle-aged, calm, conversational, narrative-story | 从容 Narration、自信 Product Copy、Direct Read              |
| `arabella`  | American | female, young, gentle, emotive, narrative-story            | Fantasy、Romance、Wellness、Atmospheric Story               |
| `jane`      | British  | female, old, professional, audiobook, narrative-story      | Long-form Book Pacing 和 Classic Narration                  |
| `maria`     | American | female, old, calm, grandmother, narrative-story            | Grandmother-style Narration 和 Reflective Story Delivery    |
| `mark`      | American | male, young, casual, conversational, natural               | Dialogue、Assistant-style Reply、Informal Script            |
| `frederick` | British  | male, middle-aged, calm, documentary, narrative-story      | History、Science、Mystery、Factual Film                     |
| `peter`     | American | male, middle-aged, confident, credible, narrative-story    | 可信 Narration、Explainer、Brand Read                       |
| `james`     | American | male, middle-aged, deep, husky, narrative-story            | Audiobook、更厚重 Story Narration、Professional VO          |
| `jon`       | American | male, middle-aged, calm, grounded, narrative-story         | 清晰 Message、Commercial、可信 Narration                    |
| `sully`     | American | male, old, deep, storyteller, narrative-story              | 深沉 Elderly Narration 和温暖 Authoritative Read             |
| `david`     | British  | male, old, deep, storyteller, narrative-story              | Classic Audiobook Passage 和 Grounded Dramatic Read          |
| `alex`      | American | male, young, confident, entertainment-tv, social-media     | YouTube、Shorts、Entertainment Clip                         |

### ElevenLabs Control 支持

所有当前 Curated ElevenLabs Preset 都支持相同 Request-level Control：`modelId`、`speed` 和 `stability`。

重要限制：

- 这些是 Provider / Model-level Control，不是逐 Voice Capability Switch。当前没有 Curated ElevenLabs Preset 被排除，但可听结果会随 Source Voice 的 Natural Delivery 变化。
- 对于 ElevenLabs `eleven_v3`，当用户要求情绪、Tone、Nonverbal Cue、Accent Hint 或 Local Pacing 等 Expressive Delivery 时，可以使用 Inline Audio Tag。Official Example 涵盖以下实用 TTS 类别：Emotion / Tone Tag，例如 `[happy]`、`[sad]`、`[angry]`、`[excited]`、`[curious]`、`[sarcastic]`、`[crying]`、`[annoyed]`、`[appalled]`、`[thoughtful]`、`[surprised]` 和 `[mischievously]`；Vocal Delivery 和 Nonverbal Cue Tag，例如 `[whispers]`、`[laughs]`、`[sighs]`、`[exhales]`、`[inhales deeply]`、`[clears throat]`、`[snorts]`、`[swallows]`、`[wheezing]` 和 `[coughs]`；Pacing / Pause / Local Speed Tag，例如 `[slowly]`、`[pause]`、`[short pause]`、`[long pause]`、`[rushed]` 和 `[drawn out]`；以及 Accent / Special-performance Tag，例如 `[strong X accent]`（例如 `[strong French accent]`），再加 `[sings]`、`[singing]`、`[woo]` 和 `[pirate voice]`。Official Example 不是穷举；用户明确要求该 Delivery，且 Tag 描述声音应如何听起来而不是 Visual Action 时，可以尝试类似 Auditory Tag。把 Tag 直接写进 `text`，靠近它要影响的短 Phrase。把 Tag 当作 Local Guidance，而不是 Paragraph-wide Control。
- 对于 `eleven_v3` 的 Pause 和 Pacing，需要时使用 Punctuation、Text Structure、较短 Generated Segment，或 `[short pause]`、`[slowly]` 等 Local Audio Tag。

## 试听 Sample

每个 Curated Preset 都有一个由 Editor 管理的 Audition Asset，路径为：

```text
/voice-samples/<provider>-<preset>.mp3
```

示例：

- `/voice-samples/doubao-morgan.mp3`
- `/voice-samples/doubao-zhixingnv.mp3`
- `/voice-samples/elevenlabs-peter.mp3`
- `/voice-samples/elevenlabs-sully.mp3`

这些路径是完整 Editor Asset Reference。在 Audition Widget 中逐字使用文档中的路径。不要在前面添加或推断 S3 Bucket、CDN、Editor、Localhost 或 Production Origin，也不要把路径转换成 Absolute URL。Filename Pattern 记录的是 Editor Asset；它不会暴露存储位置。

调用 `submit_voice` 前渲染 Voice Audition Widget 时，优先使用这些 Sample。

