# Kling

使用 `submit_video` 的 `model: "kling"` 生成视频前，请阅读本文档。

## 模型与任务

我们只提供 **Kling V3 Omni**，内部始终作为 `omni-video` 任务提交。不要向用户暴露模型变体（V3 / O3 / O1 / 2.6 / 2.5 Turbo）——统一称为 “Kling”。

## 能力

- 时长：3–15 秒（只能是整数，默认 5 秒）
- 画面比例：`16:9`、`9:16`、`1:1`
- Mode：`std`（默认）或 `pro`（质量更高、速度更慢）
- Prompt：最多 2500 个字符
- 输入图片：最小 300×300，最大 10MB，JPG/JPEG/PNG（不接受 Data URL）
- 原生音频生成（始终开启）
- Multi-shot Storyboard：一个 Job 内包含 2–6 个 Shot，并在 Shot 之间保持身份一致

## 输入通道

| Param                 | Meaning                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `firstFrame: string`  | Start Frame                                                                                          |
| `lastFrame: string`   | End Frame（Omni-video 在提供 End Frame 时必须同时提供 First Frame）                                 |
| `refImages: string[]` | Style / Subject Reference（与 First / Last Frame 合计 ≤7；在 Prompt 中引用为 `@Image1`、`@Image2`） |

图片输入接受 Project **Asset Reference**。优先使用来自 `browse_assets` 的 UUID 或短前缀；也接受 `asset://<id>` 和 Asset 工具返回的同 Project Asset URL。工具边界会拒绝外部 URL 和 Base64——先把它们导入 Project。

工具 Schema 为了与 Seedance 保持对称，也接受 `refVideos` 和 `refAudios`，但 **Kling 当前会忽略它们**——参见 §限制。

## Kling 专属参数

| Param                                         | Values                      | Default                 |
| --------------------------------------------- | --------------------------- | ----------------------- |
| `mode: "std" \| "pro"`                        | `std`、`pro`                | `std`                   |
| `shotType: "customize" \| "intelligence"`     | `customize`、`intelligence` | Multi-shot 时必需       |
| `multiPrompts: [{ prompt, duration, index }]` | Shot Array                  | `customize` 时必需      |

## Prompt Reference

通过参数传入 Reference Asset 时，在 Prompt 中按 Type 和 Ordinal 引用：

- `@Image1`、`@Image2`……——按出现顺序排列的 Reference Image（如果提供 `firstFrame`，它排在最前面，然后是 `refImages` Array 顺序）

示例：`"@Image1 character walks into the scene, maintaining the style of @Image2"`

## Multi-shot Storyboard

在一个 Job 中提交 2–6 个 Shot；Kling 会在它们之间保持身份一致，无需显式 Anchor。

**`shotType: "intelligence"`**——传入一个描述整个 Sequence 的 Top-level `prompt`；模型自动拆解。用户需要快速 Coverage，且不需要逐 Shot 时长控制时使用。

**`shotType: "customize"`**——省略 Top-level `prompt`；改为传入 `multiPrompts`。每个 Shot 都是独立完整 Scene。Backend 规则：

- 2–6 个 Shot
- 每个 `prompt` ≤512 个字符
- 每个 `duration` 为 ≥1 的整数
- `duration` 总和必须等于 `durationSeconds`（Job 总时长）
- `index` 从 1 开始且连续：Shot 1 → `index: 1`，Shot 2 → `index: 2`……（Kling 会拒绝从 0 开始或有间断的 Index）

示例：

```ts
submit_video({
  model: "kling",
  shotType: "customize",
  durationSeconds: 12,
  ratio: "16:9",
  multiPrompts: [
    {
      index: 1,
      duration: 4,
      prompt:
        "[Shot 1] MCU. Slow dolly in. Key from camera-left, 5500K. ... Motion settles as ...",
    },
    {
      index: 2,
      duration: 4,
      prompt: "[Shot 2] WS. Static. ... Motion settles as ...",
    },
    {
      index: 3,
      duration: 4,
      prompt: "[Shot 3] CU. Pan right. ... Motion settles as ...",
    },
  ],
  name: "Cafe scene storyboard",
});
```

使用 `customize` 时，按照以下规则把每个 Shot 写成独立完整 Shot。

## Prompt 结构（必要规则）

Kling 是**技术脚本型**模型。它不会自动拆解 Scene，也不会自动推断 Camera Movement。每个 Shot 都需要明确结构。以下八条规则可以叠加——每条针对一种具体失败模式。

### 1. Motion Endpoint——每个 Shot 都必需

每个 Shot 以 `Motion settles as <specific ending state>` 结尾。缺少它时，生成经常卡在 99% 或突然结束。适用于 Single-shot Prompt、Image-to-video，以及 `customize` Storyboard 中的每个 Entry。

```
✗ A young woman walks down a rainy alley, neon reflections in puddles.
✓ A young woman walks down a rainy alley, neon reflections in puddles.
  Motion settles as she pauses under a red lantern, turns her face slightly toward camera.
```

### 2. Hollywood 标准 Shot Size（英文）

每个 Shot 开头写英文术语 + 缩写。模糊中文术语（近景 / 中景）和缺少范围的 Prompt 都会降低识别率。

| Shot size        | Abbr | Use for                     |
| ---------------- | ---- | --------------------------- |
| Extreme close-up | ECU  | Eye、Finger、Single Tear    |
| Close-up         | CU   | Face / Single Object        |
| Medium close-up  | MCU  | Head + Shoulders、Dialogue  |
| Medium shot      | MS   | Waist Up                    |
| Medium long shot | MLS  | Full Body、Mid-distance     |
| Wide shot        | WS   | Full Environment、Establish |

### 3. 明确声明 Camera Movement

每个 Shot 至少需要一个 Movement（`static` 也有效——必须明确写出，绝不要省略）。每个 Shot 最多组合 2 个；3 个以上会降低质量。

| Category    | Movements                                             |
| ----------- | ----------------------------------------------------- |
| Static      | static                                                |
| Push / Pull | dolly in, dolly out, pull back                        |
| Pan / Tilt  | pan left, pan right, tilt up, tilt down               |
| Tracking    | lateral tracking left/right, following shot           |
| Orbit       | slow 180 orbit（快速动作避免使用——容易产生眩晕）      |

速度修饰词：`very slow / slow / medium / fast / whip`。组合示例：`slow dolly in, then static`。

按 Drama Type：Emotional → `static` 或 `very slow dolly in`；Action → `lateral tracking`；Reveal → `slow pan` 或 `slow pull back`；Product → `slow 180 orbit`。

### 4. Lighting Triplet

只写 “Warm lighting” 太模糊。三项都要写清：

- **Direction**：例如 `key from camera-left window`
- **Color Temperature**：明确的 Kelvin 数值（2700K–7500K）
- **Color Tone**：例如 `warm amber`、`teal-and-amber`、`cool blue`、`neutral`

缺少任一项都可能造成 Frame 间 Face Drift 和 Shadow 不一致。

### 5. 顺序动作——`first / then / finally`

一个 Shot 内包含多步 Action 时，使用明确的顺序结构。平铺描述（“he walks in and turns around”）会让 Temporal Reasoning 混乱。

```
First, she reads the open book calmly.
Then, she looks up suddenly as if hearing something, eyes widening.
Finally, she closes the book and stands up.
Motion settles as she stands fully upright, hand resting on the closed book.
```

### 6. ≥5 秒 Shot 使用 Time Slicing

对于包含多个 Beat 的 Shot，说明每个 Beat 占多少秒：

```
[Shot 2 / MCU / 6s]
  - 0–2s: Grandmother wraps the scarf around granddaughter's neck
  - 2–4s: Her fingers smooth the wool at the throat
  - 4–6s: Granddaughter closes her eyes, leans into grandmother's hand
Motion settles as grandmother's hand rests on the girl's cheek.
```

### 7. 情绪 → 物理表现（≥3 个）

用具体物理 Signal 替换抽象情绪词。一个 Signal 会显得机械；组合至少 3 个。

| Emotion | Combine 3+ of                                                                        |
| ------- | ------------------------------------------------------------------------------------ |
| Sad     | eyes glisten, lower lip trembles, breath becomes shallow, fingers curl loosely       |
| Scared  | pupils contract, breath catches in throat, cold sweat on forehead, hands tremble     |
| Happy   | eye-corner crinkles, mouth corners lift asymmetrically, shoulders relax, soft exhale |
| Angry   | jaw clenches, nostrils flare, knuckles whiten, breath quickens                       |

```
✗ Marcus looks scared.
✓ Marcus's pupils contract as his eyes widen, breath catches in his throat,
  a thin film of cold sweat forms on his forehead, his left hand trembles at his side.
```

### 8. Complexity Ceiling——每个 Shot ≤7 个 Element

计算 Element：每个 Character ≈1，每个独立 Physical Event ≈1，每个 Continuous Action ≈1，每个 Background Environment ≈1，Secondary Dynamics（Wind / Fog / Falling Leaves）≈0.5。超过上限 → 拆成两个 Shot。

## Multi-character Anchor

两个 Character 同框时，模型会发生 Attribute Leakage（A 的 Clothing 出现在 B 上）。使用明确归属 + 明确否定，再加 Position Word 和 Outfit Color：

```
The character on the LEFT is @character_A — grey-blue tactical jacket, short beard.
NOT red cape, NOT braided hair.
The character on the RIGHT is @character_B — red cape with gold trim, long braided hair.
NOT grey-blue jacket, NOT short beard.
Camera: fixed, medium shot, both characters clearly separated.
```

## 真人照片 Reference

把真人照片作为 Reference 时，照片满足以下条件效果最佳：正面（旋转 0–15°）、≥1024×1024、光线均匀、Neutral Expression、无遮挡。

## Drama / 情绪 Shot 原则

当请求涉及 Character Performance 或细致情绪控制时，重点使用以下原则（来自 Operations Research 的提炼）：

- **不使用文学性词语**——把 “sad / shocking / eerie” 替换为物理描述（规则 §7）。
- **Action Vectorization**——为每个 Action 提供 Start Point、Trajectory 和 Force / Frequency，而不只是 Verb。
- **Bio-consistency**——每种情绪强制至少 3 个 Micro-expression（Throat Swallow、Jaw Tension、Blink Rate）。
- **Frame Anchoring**——每个 Shot 必须声明 Shot Size + Camera + Lighting（规则 §2 / §3 / §4）。
- **Motion Endpoint 必需**——没有例外（规则 §1）。
- **双语分工**——Narrative 可使用任意语言；技术指令（`Camera`、`Lighting`、`Motion settles`、`[Speaker:]`、`@reference`）使用英文。

## 限制（不要承诺这些能力）

- **Voice Binding / Voice Cloning**：仅 Kling O3 Omni 支持——V3 Omni 不支持。不要提供。
- **Motion Brush**：Kling Web UI 功能，不在 Public API 中。
- **通过 Reference Video 进行 Motion Control**：当前 Integration 不会转发；工具 Schema 接受 `refVideos`，但目前对 Kling 提交没有作用。
- **`negative_prompt` Field**：Omni-video 不接受。把规避要求直接写入 `prompt` 文本，例如 `… Avoid: blurry hands, extra fingers.`
- **Element Library Binding**：目前尚未上传到 Kling Element Library，因此当前没有对应参数。

## 失败处理

- 卡在 99% / 突然结束 → 几乎总是缺少 Motion Endpoint（规则 §1）。
- 不同 Job 之间 Face Drift → 每个 Shot 复用相同 `refImages` Entry；在后续 Turn 中通过 `track_progress` 检查前一个 Shot，直到 Terminal，再把其 Frozen Frame 用作下一个 Shot 的 `firstFrame`。`action=wait` 只是非阻塞兼容别名。对于一个 Job 内的 2–6 个 Shot，优先使用 Multi-shot Storyboard。
- 两个同框 Character 发生 Identity Bleed → 使用上方 Multi-character Anchor Block。
- 同一 Drift 经过**两次**纯文字重试后 → 停止调整文字。添加或切换 Reference Image。

