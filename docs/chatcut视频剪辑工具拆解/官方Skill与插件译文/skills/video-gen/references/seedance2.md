# Seedance 2.0

使用 `model: "seedance2"`、`model: "seedance2fast"` 或 `model: "seedance2mini"` 生成前，请阅读本文档。这些 Seedance 2.0 模型与新的默认模型 `model: "seedance-2-5"` 一样继续受到完整支持；后者有单独的 Reference。

## 能力

- 时长：通过 `durationSeconds` 设置 4–15 秒（默认 5 秒）
- 音频：始终开启（Music、Narration、Ambient）。Seedance 2.0 没有 Audio Toggle 参数。
- 画面比例：通过 `ratio` 使用 `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9` 或 `adaptive`。`adaptive` 会自动跟随输入图片的比例——设置 `firstFrame` 或 `lastFrame` 时，Backend 会自动把 `ratio` 重写为 `adaptive`。
- 分辨率：通过 `resolution` 使用 `480p`、`720p`（默认）或 `1080p`。成本随像素数量变化——Ark 按 Width × Height × fps × Seconds 计费，因此 1080p 的成本约为 720p 的 2.25 倍，480p 约为一半。一次性 Draft 选择 480p；只有用户需要交付质量时才选择 1080p。`seedance2mini` 最高 720p。

### `seedance2fast`——低延迟变体

`seedance2fast` 是 Seedance 2.0 Fast：输入、Mode 和 Reference 完全相同，4–15 秒范围相同，优化为几分钟返回，而不是约十分钟。相对完整 2.0 只有一个限制——支持 **480p 和 720p**，最高 720p（`resolution:"1080p"` 会被拒绝）。每秒成本约比完整 2.0 低 20%。当用户正在迭代，并希望保持 2.0 风格但不想等待时选择它；需要 1080p 或最终交付质量时使用完整 `seedance2`。

### `seedance2mini`——低成本变体

`seedance2mini` 是 Seedance 2.0 Mini：输入、Mode、Reference 和 4–15 秒范围完全相同，每秒成本约为一半。唯一差异是分辨率——Mini 只输出 **720p**；传入 `resolution:"1080p"` 会被拒绝。用于低成本 Draft 或高批量生成；用户需要 1080p 或最高 Fidelity 时使用完整 `seedance2`。本文档的其他内容均同样适用。

## 输入通道

分为两类：

- **Frame** 出现在生成 Clip 的特定位置（First / Last Frame）。
- **Reference** 影响生成（Style、Subject、Motion 或 Audio），但不会作为固定帧放进输出。参考被遵循得多严格，取决于 Prompt 如何描述它——从“完全使用这个风格”到“从中获得灵感”。

| Category      | Param                 | Meaning                                                                                                                                     |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frame**     | `firstFrame: string`  | 生成 Clip 的精确第一帧                                                                                                                      |
| **Frame**     | `lastFrame: string`   | 精确最后一帧；设置后启用 First-last-frame Transition Mode                                                                                  |
| **Reference** | `refImages: string[]` | 图片参考——例如 Subject Appearance、Style、Composition。不会放在输出中的特定帧。                                                           |
| **Reference** | `refVideos: string[]` | 视频参考——例如 Motion Continuity、Style，或作为 Edit / Extend / Bridge 的源。每个参考如何使用由 Prompt 驱动。                             |
| **Reference** | `refAudios: string[]` | 音频参考——例如 Rhythm、Melody、Ambient Tone。必须与至少一个 Image 或 Video Reference 组合。                                               |

限制：9 个 Ref Image、3 个 Ref Video、3 个 Ref Audio。每个文件 ≤200MB（Video）、<30MB（Image）、≤15MB（Audio）。

所有 Frame / Reference Slot 都接受 Project **Asset ID**（来自 `browse_assets` 的 UUID 或短前缀）、`asset://<id>`，或同一 Project 的 Asset URL。不接受外部 URL——先把它们下载到 Sandbox Workspace，再通过 `asset-import` + `push_asset` 导入本地文件。

## Mode（从参数推断）

Mode 会根据传入的参数自动推断——没有单独的 Mode 参数。

| Param combination                                                  | Mode                        | Notes                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仅 `prompt`                                                        | text-to-video               | 无视觉输入                                                                                                                                                                                                                                                                                    |
| 仅 `firstFrame`                                                    | image-to-video              | 从指定 Start Frame 向前制作动画                                                                                                                                                                                                                                                              |
| `firstFrame` + `lastFrame`                                         | first-last-frame transition | 严格 Start → End Frame                                                                                                                                                                                                                                                                         |
| 任意 `refImages` / `refVideos` / `refAudios`（单独或组合）         | reference-guided            | 由一个或多个 Reference 引导生成。每个 Reference 的作用（Style Guide、Subject Anchor、Motion Continuity、编辑现有 Footage、衔接 Segment……）由 **Prompt** 驱动，而不是由传入多少个 Ref 决定。具体 Prompt Pattern 参见 §Editing & Extending。 |

**Frame Mode 与 Reference Mode 互斥。** 不要把 `firstFrame` 或 `lastFrame` 与 `refImages`、`refVideos` 或 `refAudios` 组合。如果希望多模态参考影响 Opening / Closing Composition，使用 Reference Mode，并在 Prompt 中描述该意图；这是间接控制。当提供的图片必须是精确第一帧或最后一帧时，使用 Frame Mode。

## 内容审核

Seedance 会审核输入内容。有两类情况需要注意：

- **真人面孔**——上游不接受直接上传的原始含脸参考图片或视频。使用已授权 Portrait Asset，或在其 Trust Window 内、同一 ModelArk Account 下生成且未修改的 Trusted Output。对于 Project Image URL，ChatCut 可以通过已配置的 Volcengine Asset Library 重试一次；这不是保证，也不得向用户描述为不受限制的直接上传支持。
- **Copyright / IP-protected Likeness**——可识别的 Celebrity、Public Figure、知名 Fictional Character、Branded Mascot 仍会被阻止。如果提交失败且输入是可识别 IP Face，显示失败并要求不同参考。

_Trusted-output Reuse 仅适用于同一 Account 下符合条件、未修改的 ModelArk Output，并会在 Provider 文档规定的 Trust Window 后失效。_

## Seedance 错误处理

- 如果提交因 Content-review Error 失败，显示失败并要求用户提供不同 Reference。不要使用相同输入重试。

## Prompt 编写

Seedance 2.0 具有较强的意图理解能力。围绕八个元素组织 Prompt：

**Subject** + **Action** + **Scene** + **Lighting / Color** + **Camera** + **Style** + **Quality** + **Negative Constraints**

- **Subject**——谁 / 什么是主要主体（外观、服装、定义特征）。
- **Action**——主体在做什么；说话或情绪镜头还包括微表情。
- **Scene**——地点、时间、环境细节。
- **Lighting / Color**——氛围、Color Grading、Contrast、Mood。
- **Camera**——Shot Size、Angle、Movement（参见下方 **Camera Language**）。
- **Style**——视觉风格或 Genre（Cinematic、Anime、Documentary、Film-grain……）。
- **Quality**——分辨率和细节提示，例如“4K, sharp details, film-grade quality”。
- **Negative Constraints**——要避免什么（参见下方 **Quality & Stability Tails**）。

保持 Prompt 精简：中文 ≤500 个字符，英文 ≤1000 个词。过长 Prompt 会稀释重点——信息过密时模型可能丢掉细节。

### Prompt 中的 Reference

通过参数传入 Reference Asset 后，Prompt 通过 Type 和 Ordinal Number 引用它们。Seedance API 按请求中的出现顺序分配编号，不区分 Frame 与 Reference。

- `@Image1` / `@图片1`——当前 Mode 中的第一个 Image Input。在 Frame Mode 中这是 `firstFrame`；在 Reference Mode 中这是 `refImages[0]`。后续图片按 Array 顺序排列（`@Image2`、`@Image3`……）。
- `@Video1` / `@视频1`——`refVideos[0]`；`@Video2` 是 `refVideos[1]`，以此类推。
- `@Audio1` / `@音频1`——`refAudios[0]`；规则相同。

示例：`refImages: ["A", "B"], refVideos: ["C"]` → 在 Prompt 中，`@Image1` = A，`@Image2` = B，`@Video1` = C。

Prompt 中始终通过明确编号的 Reference（`@Image1`、`@Video1`、`@Audio1`）引用传入输入，而不要使用模糊描述。

**应当：** `"@Image1 (the dark-haired woman) walks into the scene from @Image2 (the living room)"`——清晰、无歧义。
**不要：** `"make the character look like that reference image"`——模糊；模型可能选错输入。

**在 `@ImageN` / `@VideoN` 后始终紧跟 Noun 或 Clarifier**——`@Image1 character walks...`、`@Image1 (the black car) drifts...`、`@视频1 的镜头继续`。不要直接连接 Verb、Position Word 或另一个 Number（例如 `@Image2 stands...`、`@图2位于...`、`@Image1 2 seconds later`）——模型可能错误分词该编号并生成错误数量。

### Quality & Stability Tail

对于以 Character 为主或能看见 Face 的 Clip，**始终附加 Quality 与 Stability Cue**，例如：

> `"4K, sharp details"` + `"character face stable, no mutation, no clipping, no duplicated limbs, hands and fingers anatomically correct"`

这些防失败 Tail 能实质提高命中率。除非用户明确要求 Raw / Lo-fi / Experimental 风格，否则默认包含。

### Camera Language

Seedance 2.0 对以下术语理解良好：

| Category  | Terms                                                          |
| --------- | -------------------------------------------------------------- |
| Shot size | Close-up, Medium Shot, Full Shot, Long Shot, Extreme Long Shot |
| Angle     | Low Angle, High Angle, Eye-level, Over-the-shoulder            |
| Movement  | Push-in, Pull-out, Pan, Dolly/Track, Following Shot, Orbit     |
| Effects   | Slow Motion, Time-lapse, Shallow Depth of Field, Handheld Feel |

**每个 Sub-shot 只使用一个 Camera Movement。** 避免在同一个 Sub-shot 中叠加相互冲突的 Movement（例如 Push-in + Pan-left，或 Dolly + Orbit）。一个 Beat 需要不同 Camera Move 时，使用另一个 Sub-shot——优先在同一 Clip 内串联 Sub-shot（参见下方 §一个 Clip 内的 Multi-shot）；只有总时长超过 15 秒或边界是硬场景切换时，才拆成多个 Clip。

## 一个 Clip 内的 Multi-shot

一次 4–15 秒 Seedance 生成并不只能使用一个 Camera Setup。通过清晰的 Sub-shot 结构（`Shot 1: ... → Shot 2: ...`，或 Timestamp 切片 `0–2s ... | 2–4s ...`），模型可以在一个 Clip 内把多个 Sub-shot 串成连续 Beat。

**特征。** 一次生成是单次推理——Subject Identity、Lighting、Color 和 Style 作为一次 Diffusion Process 的自然结果，在整个 Clip 中保持物理一致。如果把同样的 Beat 拆成多个独立 Clip，每个 Clip 都是独立推理；Subject Identity、Lighting 和 Color 容易在 Clip 之间漂移，需要 `refImages` / `refVideos` 保持对齐。

**何时退回多个 Clip。**

- 总时长超过 15 秒。
- Sub-shot 边界是切到完全无关 Scene 或 Subject 的硬切——基于 Anchor 的 Cross-clip Consistency 更适合这种情况。

单个 Sub-shot 仍遵循单 Camera Movement 规则。多个 Camera Movement 对应多个 Sub-shot，不是在一个 Sub-shot 中叠加。

**Prompt 结构。**

- 每个 Sub-shot 都使用八元素形式，但只填写相对于前一个 Sub-shot 发生变化的内容——其余内容让模型延续。
- 有意设置 Transition 时，把它写在 Sub-shot 边界（“camera cuts to a CU as she turns”）。
- Quality & Negative Tail 覆盖整个 Prompt；不要在每个 Sub-shot 中重复。

**示例（8 秒竖屏，4 个 Sub-shot）：**

```
8s, 9:16, cinematic.
Shot 1 (0–2s): Full shot, she walks onto the red carpet, soft top-light, slow forward dolly.
Shot 2 (2–4s): Medium shot, she turns to camera, holds @Image1 perfume bottle, key light from camera-left.
Shot 3 (4–6s): Close-up on @Image1, gentle rotation, shallow depth of field.
Shot 4 (6–8s): Medium shot, she smiles back at camera, dress hem flutters.
4K sharp details, character face stable, no mutation, no clipping, hands anatomically correct.
```

## Editing & Extending

这些是 `reference-guided` Mode 的 **Prompt 驱动 Use Case**——它们基于源 Clip 产生一个**新的生成 Video Clip**，不是 Timeline Edit。输出是全新 Asset；原始内容不被修改。

三种 Pattern 都通过 `refVideos` 传入源 Clip；Use Case 由 Prompt 要求决定。源视频必须是已完成生成（使用其 `assetId`）。

| Use case   | What the prompt asks                                                           | Example prompt                                        |
| ---------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Edit**   | 替换或调整元素，同时保留其余内容                                               | `"Replace the scarf in @Video1 with a red one"`       |
| **Extend** | 向前继续，或在前面补入更早 Footage                                             | `"Continue from @Video1, the character opens the door"` |
| **Bridge** | 填补 2–3 个 Segment 之间的 Gap（在 `refVideos` 中分别传入）                   | `"Smooth transition from @Video1 to @Video2"`         |

这些是常见 Pattern，不是穷举——`refVideos` 是灵活的 Reference Channel，Prompt 也可表达其他意图（Style Continuation、仅 Carry Motion 等）。

用户不满意结果时，优先 Edit，而不是从头 Regenerate——成本更低，也能保留已经有效的部分。

## Seedance 专属一致性实现

Seedance 2.0 是 Stateless——每次调用彼此独立。跨模型 Anchor **原则**（何时使用、如何获取、多角色、升级处理）参见 SKILL.md 的 §Visual consistency across shots。以下 Seedance 专属**实现**细节补充这些原则。

### 如何传入 Anchor（Seedance 参数）

- `refImages: [<imageAssetId>]`——固定静态 Image Anchor（Character、Style、Composition）。
- `refVideos: [<videoAssetId>]`——固定 Video Anchor（Motion Continuity、Edit / Extend / Bridge Source）。

### 明确需要一致性时，向后传递已获批 Shot

在明确要求一致性的 Multi-shot Sequence 中（Shot 间使用同一 Character、Scene 或 Style），第一个 Shot 获批后，把最近获批的 Shot 通过 `refVideos` 传入后续 Shot——**同时**继续传入 Static Image Anchor。组合 `refImages: [<character>] + refVideos: [<previous-approved-shot>]` 同时固定身份（来自 Image）和 Motion / Style Continuity（来自 Video），比单独使用任何一种更强。如果用户的一致性意图不清楚——例如下一个 Shot 的场景差异很大，不清楚什么应保持相同——**生成前询问**。不要假设。

### Shot 依赖前一次生成时

在后续 Turn 中通过 `track_progress` 检查前一个 Job，直到它到达成功 Terminal State。只有 ID 存在时，才把其 `outputAssetId` 传入 `refVideos`；如果 Job 失败、被取消或没有可用 Asset ID，显示该结果，不要提交依赖 Shot。`track_progress` 会立即返回，兼容别名 `action=wait` 也是如此；不要并行提交依赖 Shot。

### 建立新 Anchor——Seedance 路径

没有合适的现有 Asset，必须生成新 Anchor 时：

- **生成的 Character / Illustration** → 使用 `submit_image` 创建 Reference，再把其 Asset ID 传入 `refImages`。
- **真人照片** → 优先使用已验证 / 已授权的 Portrait Asset。Project Image 可以传入 `refImages`，但原始含脸上传可能被拒绝；ChatCut 只会通过已配置的 Asset Library 重试一次。如果仍失败，显示错误并要求已授权 Asset，而不要循环重试。
- **生成的 Photorealistic Character** → 不要承诺任意 `submit_image` 结果都会被信任。上游 Trust 仅限同一 Account 下符合条件、未修改的 ModelArk Output；否则使用 Non-photorealistic Anchor 或已授权 Portrait Asset。

### Multi-character——Seedance 参数

在 `refImages` 中固定正确 Character 的 Anchor。不要意外复用另一个 Character 的 Anchor。

### 升级处理——Seedance Edit Mode

在 `refVideos` 中复用外观最好的现有 Shot，并在 Prompt 中描述改动。这是 Seedance 用于打破一致性死循环的 “Edit Mode” 路径。

### 示例：带 Character Anchor 的双 Shot Sequence

```ts
// Shot 1 — anchor character appearance with a reference image
submit_video({
  model: "seedance2",
  refImages: ["character-ref-id"],
  prompt:
    "@Image1 black racing car drifts around a rain-soaked corner, left to right. Sparks fly from tires.",
  name: "Chase scene — shot 1 drift",
});

// In a later turn, check shot 1 with `track_progress` using action="status".
// Continue only after success and a non-empty `outputAssetId`; otherwise stop.

// Shot 2 — same character ref + shot 1 as video reference for motion continuity
submit_video({
  model: "seedance2",
  refImages: ["character-ref-id"],
  refVideos: ["<shot1-assetId>"],
  prompt:
    "Same @Image1 black racing car continues speeding. Carry forward the motion style of @Video1. Camera follows from behind.",
  name: "Chase scene — shot 2 follow-through",
});
```

