---
name: video-gen
description: |
  通过 Seedance 2.5、Seedance 2.0、Kling 和 Gemini Omni 进行 AI 视频生成。当用户希望生成视频片段——文生视频、图生视频、首尾帧 Transition、参考引导生成——或希望修改 / 编辑 / 延长现有生成片段（"change the X"、"把 X 改成 Y"、移除物体、替换背景）时使用。
user-invocable: true
---

# 视频生成

每次调用提交一个视频生成 Job，并返回 `jobId`。Job 状态和之后的回查属于 `track_progress`；本 Skill **不会**自动把视频放到 Timeline 上。

## 何时使用

只要用户希望生成视频片段——文生视频、图生视频、首尾帧 Transition、基于参考生成，或生成式编辑 / 延长现有视频（基于源片段产生新的生成画面；不是 Timeline 裁切）——就使用。

## 模型

| Model           | Reference                                            | Strengths                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seedance-2-5`  | [references/seedance25.md](references/seedance25.md) | 默认。4–30 秒、最多 50 个多模态参考、支持纯音频参考、Timestamp 控制，以及 mp4/mov 输出。新生成、编辑和延长中最强的 Seedance 选择。                          |
| `seedance2`     | [references/seedance2.md](references/seedance2.md)   | Seedance 2.0 完整模型。4–15 秒、丰富的多模态参考，最高 1080p 输出。                                                                                         |
| `seedance2fast` | [references/seedance2.md](references/seedance2.md)   | Seedance 2.0 Fast——**输入和 4–15 秒范围与 `seedance2` 相同，几分钟返回而不是约十分钟，便宜约 20%，最高 720p**。用户迭代且速度比峰值质量重要时使用。           |
| `seedance2mini` | [references/seedance2.md](references/seedance2.md)   | Seedance 2.0 Mini——**输入和 4–15 秒范围与 `seedance2` 相同，便宜约 50%，最高 720p**。用于低成本 Draft 和不需要完整模型 Fidelity 的高批量生成。              |
| `kling`         | [references/kling.md](references/kling.md)           | 通过 Prompt 使用 Camera-control 语言；擅长人物镜头中的细致情绪 / 表演控制。通过 `mode:"pro"` 输出 1080p。                                                |
| `omni`          | [references/omni.md](references/omni.md)             | 通过 `continueFrom` **原位修改现有片段**——Prompt 未提及的内容得到保留。可从文字或 `firstFrame` 图片快速、低成本生成 Draft。720p，3–10 秒。                  |

**重要：** 生成前，阅读所选模型的 Reference，了解能力、输入通道、Mode、Prompt 结构和模型专属行为。

## 模型选择

**对于新生成**，`seedance-2-5` 是**默认模型**。只有以下情况切换：

- **用户明确命名模型**（“用 Kling”“use Kling”“用 Omni”“用 mini”“/kling”）——直接切换，无需再次询问。
- **Seedance 明显无法或不会做好**——遇到已知 Seedance 弱项时，提议切换到 `kling`，并在提交前确认。
- **用户明确要求预计还会修改的快速 / 低成本 Draft**——提议 `omni`（720p、≤10 秒，也支持原位编辑），并在提交前确认。
- **用户需要 Seedance 1080p 输出**——优先 `seedance-2-5`；它和完整 `seedance2` 都支持 1080p。
- **用户希望低成本使用 Seedance 2.0 输入方式，或同时生成很多片段，并接受 720p**——提议 `seedance2mini`（4–15 秒、约为 2.0 完整模型成本的 50%），并在提交前确认。
- **用户正在迭代 2.0 风格输出，并重视周转速度**——提议 `seedance2fast`（480p 或 720p、4–15 秒、约为 2.0 完整模型成本的 80%，返回快得多），并在提交前确认。

否则保持 `seedance-2-5`。

**对于修改已经存在的片段**，在 Step 4 中选择——不是在这里。修改请求不是改变未来全新生成默认模型的理由。

访问说明：六个模型都需要 ChatCut Pro 或付费积分。绝不要把另一个模型说成绕过 ChatCut Pro 闸门的免费方案；用户询问免费路径时，改为提供免费的 Motion Graphic 动画。

## 工具参数

| Param             | Values                                                                                         | Default                           |
| ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| `prompt`          | 视频描述（必需）                                                                               | —                                 |
| `model`           | `seedance-2-5`、`seedance2`、`seedance2fast`、`seedance2mini`、`kling`、`omni`                 | seedance-2-5                      |
| `durationSeconds` | 秒                                                                                             | 5                                 |
| `ratio`           | 参见模型文档                                                                                   | 16:9                              |
| `resolution`      | `480p`、`720p`、`1080p`（模型专属；`seedance2fast` 支持 480p/720p，拒绝 1080p）                | 720p                              |
| `outputFormat`    | `mp4`、`mov`（仅 `seedance-2-5`）                                                              | mp4（生成）；mov（编辑/延长）     |
| `taskMode`        | `generate`、`edit`、`extend`（仅 `seedance-2-5`）                                              | generate                          |
| `name`            | 描述性 Asset 名称（必需）                                                                      | —                                 |
| `firstFrame`      | Project Asset Ref                                                                              | —                                 |
| `lastFrame`       | Project Asset Ref                                                                              | —                                 |
| `continueFrom`    | Video Asset Ref——**仅 `omni`**，要修改的片段                                                   | —                                 |

模型专属参数（例如 Kling `mode`、Seedance `refImages` / `refVideos` / `refAudios`）——参见对应模型 Reference。

## 输入解析

`firstFrame` / `lastFrame` / `refImages` / `refVideos` / `refAudios` 都接受 Project Asset Reference。优先使用来自 `browse_assets` 的完整 UUID 或短前缀；也接受 `asset://<id>` 和 Asset 工具返回的同 Project Asset URL。每个 Slot 的 Type：Frame Slot 和 `refImages` → Image；`refVideos` → Video；`refAudios` → Audio。

不接受外部 URL 和 Base64。如果来源是公共 URL，把它下载到 Sandbox Workspace，通过 `asset-import` + `push_asset` 导入本地文件，并传入产生的 Asset ID。

## 工作流

四步循环。每次新生成中，如果用户意图发生变化，从 Step 1 重新开始。

### Step 1——与用户对齐范围

编写任何 Prompt 前，对齐三个维度：

1. **时长与 Segment**——总长度、多少个 Shot，以及它们位于一个 Clip 还是多个 Clip 中。

   如果用户已经说明方向（“做一段”“in one video”“分别生成”“split into N shots”等），遵循它——不要自行质疑。

   否则，呈现两条路径，让用户选择：
   - **一个 Clip 内的 Multi-shot**（参见模型 Reference）——一次推理，Subject / Lighting / Style 在各 Sub-shot 之间天然保持物理一致；适合在单 Clip 时长上限内的连贯叙事。
   - **多个 Clip**——每个 Clip 都能独立控制和重新生成，但身份和风格一致性必须由 Anchor 承担；适合超过时长上限或存在硬场景切换的内容。

   提供取舍；不要替用户选择。

2. **内容**——每个 Clip 描绘什么。逐段复述理解。当内容模糊时（例如“generate a video of a girl dancing”），用户通常还没有指定以下一项或多项：
   - **Subject**：谁 / 什么是主要主体（外观、服装、定义特征）？
   - **Action**：他们在做什么？（对于说话 / 情绪镜头，具体微表情是什么？）
   - **Scene**：在哪里——环境、时间、场景细节？
   - **Lighting / color mood**：什么氛围？
   - **Camera**：是否有 Shot Size / Angle / Movement 偏好？
   - **Style**：视觉风格或参考（Cinematic / Anime / Documentary / ...）。

   聚焦当前具体请求中真正重要且无法安全推断的内容——不要把它变成填空练习。继续前，把已经理解的部分复述给用户。

3. **一致性 Anchor**——只在多个 Shot 复用角色、物体或场景时：确定跨 Shot 固定哪个 Anchor（参考图片或视频）。来源规则参见下方 §跨 Shot 的视觉一致性。

对每个维度检查用户原话：

- **清楚**——继续。
- **模糊或缺失**——询问用户。不要猜测，不要默认采用自己的解释。一次往返确认比浪费一次生成便宜。

#### 不要做什么

- **不要“说明后直接提交”**——宣布“我会做成 2 个 Clip”并立即提交，不是对齐，而是单方面决定后再通知。
- **不要默认把单视频请求拆成多个 Clip。** 一个 Clip 可以包含多个 Sub-shot（参见模型 Reference），并让 Subject / Lighting / Style 在其中天然保持物理一致。先呈现取舍，再让用户选择。
- **不要因为你觉得答案显而易见就跳过询问。**

#### 硬性 Override（用户明确原话优先）

- "one clip / single clip / 一条 / 一个镜头 / in 1 clip" → 绝不拆分，即使描述客观上很长。
- "N shots / N 段 / N 个镜头" → 准确生成 N 个。
- "use this image / 用这张图" → 使用它作为参考，不要替换。

### Step 2——编写 Prompt

Prompt 结构和参数组合参见所选模型 Reference（例如 Seedance 的 8 元素结构和 Mode；Kling 的 Prompt Tips）。提交前检查：

- `name` 是**描述性** Asset 名称——足够让用户（以及后续 Turn 中的你）在 Project Library 中识别该 Asset。避免 "Untitled" 或 "clip 1" 等模糊名称。
- 参数组合符合用户意图——参见模型 Reference 的 **Modes** 部分。
- 生成视频音频不是工具参数。Seedance 和 Kling 由后端开启音频后提交。
- 验证失败时，阅读错误并修复输入——**不要盲目重复提交相同无效参数**。

### Step 3——提交一个、等待、确认

**每次只提交一个生成 Job。** 除非用户明确要求并行生成多个 Clip，否则当前 Clip 完成并经过用户审阅前，不要提交下一个。并行提交会隐藏问题：如果第一个 Shot 存在漂移或取景错误，用户更愿意只重做一次，而不是丢弃多个同样偏离的 Shot。

- `submit_video.ratio` 只控制生成 Asset；它不会改变 Project Timeline 画布。如果用户要求最终输出宽高比（例如“9:16 竖屏”或“16:9 横屏”），在放置完成 Asset 前，使用 `manage_timelines` 的 action=update 把 Timeline 画布设为相同比例（例如 ratio:"9:16"）。如果用户要求无黑边 / Full-bleed，设置画布或更新/添加视觉 Item 时传入 `fit:"cover"`。
- 不要用本 Skill 管理 Job——使用 `track_progress` 立即读取状态，并遵循之后的回查指导。
- 提交后结束 Turn（告诉用户 Job 已创建），除非已经排队后续任务。
- Job 完成后，在继续下一个 Shot 前把结果呈现给用户审阅。
- 模型专属失败处理——参见模型 Reference。

### Step 4——迭代

用户需要下一个 Clip、修改或延续时，先判断现有 Clip 在下一次调用中**是什么**：

| 现有 Clip 是……                                                                                | 路径                                                         |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **被修改对象**——局部改变，其余保留                                                           | `omni` + `continueFrom`                                      |
| **重新生成的来源**——新运动 / Camera、全 Clip 风格改变、Extend、Bridge                         | `seedance-2-5` + `refVideos`；为 Edit/Extend 设置 `taskMode` |
| **无法复用**——意图已经变化                                                                    | 重新生成，从 Step 1 开始                                     |

**局部修改默认使用 `omni` + `continueFrom`。** 不要等用户说“其他内容保持不变”——“把气球改成黄色” / “remove the text in the corner”已经包含该含义。只有修改确实需要重新推理（运动、Camera、时长、全 Clip 风格）时才路由到 `seedance-2-5`，不要因为更熟悉 Seedance 就选择它。

以下任一情况存在时，`omni` 编辑不可用——明确说明，并改用 `seedance-2-5 + refVideos`，同时告诉用户整个 Clip 会被重新推理，而不是原位编辑：

- 源 Clip 长于 10 秒
- 输出必须保持 1080p（`omni` 返回 720p）
- 修改属于 Extend 或 Bridge（Omni 不支持）

**修改 `kling` 1080p Clip 没有无损路径。** `omni` 最高返回 720p；`seedance-2-5` 和 `seedance2` 可以输出 1080p，但仍会从头重新推理。提交前告诉用户每条路径会损失什么，并让他们选择。

然后应用常驻规则：

- **如果它是 Multi-shot Sequence 中的下一个 Shot**——复用已经建立的 Anchor（原则参见下方 §跨 Shot 的视觉一致性，Flag 级细节参见模型 Reference）。
- **如果用户反馈模糊**（“it doesn't feel right”）——重新生成前询问具体要改变什么。
- **如果同一个 Text Prompt 调整失败两次**——停止调整文字。改用参考图片，或切换到编辑路径（原位修改使用 `omni` `continueFrom`，重新生成使用 Seedance `refVideos`）。
- 每次新生成都从 Step 1 重新开始循环——范围发生变化时重新对齐。
- `submit_video` 会报告 Omni Edit Round；当它警告 Chain Depth 时，把建议转告用户，不要静默继续。

## 跨 Shot 的视觉一致性

仅靠文字无法可靠维持跨 Shot 的视觉身份；视觉参考对输出的约束远比文字准确。

### Anchor：一致性的基石

**Anchor** 是固定到每一个共享同一角色、物体或风格的 Shot 上的参考图片或视频。任何包含重复视觉元素的 Multi-shot Sequence 都需要 Anchor——不要试图只凭文字重现。

### 获取 Anchor

具备参考意识。当用户请求涉及重复角色 / 物体 / 场景时，在编写 Prompt **之前**思考应使用哪个 Anchor：

- **先检查 Project。** 用户已经提供或批准了什么？上传图片、之前已经生成并批准的 Shot，或更早的 Project Asset，都可以作为 Anchor。
- **匹配用户意图。** 如果用户指出特定 Asset（“use this photo”“像上一段那样”），就使用它。如果只用文字描述角色，目前不存在 Anchor，必须先建立。
- **有疑问时询问用户。** 不要猜测要固定哪个 Asset，也不要在用户可能已有目标时静默生成新 Anchor。

### 建立新 Anchor（需要用户同意）

没有适配的现有 Asset、必须生成一个时，先向用户提议——它会消耗积分，并塑造每个下游 Shot。模型专属路径参见所选模型 Reference。

### 使用 Anchor

- 在共享角色 / 物体 / 风格的**每个 Shot** 中传入 Anchor。具体 Flag 取决于模型——参见模型 Reference。
- 在 Prompt 中按外观描述 Anchor，而不是按名称："The BLACK RACING CAR with chrome exhaust" 比 "Fleetmaster" 约束强得多。当容易发生角色混淆时，添加明确否定："The motorcycle does NOT transform."
- 在 Prompt 中使用 `@Image1` / `@Video1` 引用 Anchor——不要使用 "the same car as before" 等模糊表达。
- 当某个 Shot 依赖上一轮生成时，在后续 Turn 使用 `track_progress` 检查直到 Terminal，然后把其 `outputAssetId` 用作 Anchor Reference。`track_progress` 是立即状态读取；`action=wait` 只是不阻塞的兼容 Alias。不要并行提交彼此依赖的 Shot。

### 多角色 Project

Project 包含多个具有不同属性的已命名角色时（例如具有火焰能量的 Faz、具有冰霜能量的 Kev），把每个角色视为**独立 Anchor**——每个角色一个 Reference Asset。在每个 Prompt 中：

- 命名**活动**角色并附上其独特属性（"Kev has **blue ice** electric energy"）。
- 为其他角色添加明确否定，防止属性泄漏（"NOT red fire energy, NOT Faz's look"）。
- 固定正确角色的 Anchor（模型专属 Flag——参见模型 Reference）。不要误用另一个角色的 Anchor。

缺少明确归属或否定中的任意一项，都会导致跨角色属性混合。

**同一帧中有多个角色。** 多个角色共同出现的 Shot（尤其面向 Camera 时）容易发生换脸或身体裁切。为每个角色添加**强位置 + 服装 Anchor**，并为该 Shot 优先使用**固定 Camera**：

- "the character on the LEFT wears a grey-blue tactical jacket, short beard, silver earring"
- "the character on the RIGHT wears a red cape with gold trim, long braided hair"
- "fixed camera, medium shot, both characters clearly separated"

位置词（left / right / foreground / background）+ 明显不同的服装颜色，会给模型足够信号把角色区分开。

### 文字调整失败时升级

同一个 Shot 的视觉身份问题（错误角色、漂移、颜色不匹配）在**两次 Text Prompt 调整**后仍存在时，停止调整文字。文字无法替代 Anchor。升级为：

- 添加或切换 Anchor。
- 使用模型支持的 Edit Mode（调用方式参见模型 Reference）。

对于同一个一致性问题，**不要**提交第三次纯文字重试。

### 何时跳过 Anchor

简单、一次性或探索性请求不需要 Anchor——直接生成。

## 运行

```ts
// Text-to-video (Seedance 2.5 default)
submit_video({
  model: "seedance-2-5",
  prompt: "A cat walks across a sunny windowsill",
  name: "Cat on windowsill",
});

// Image-to-video with Seedance 2.5 — pass the project asset id directly
submit_video({
  model: "seedance-2-5",
  prompt: "The scene comes to life, gentle breeze rustles the curtains",
  firstFrame: "abc12345",
  name: "Living room animation",
});

// Kling text-to-video — only after Model Selection check
submit_video({
  model: "kling",
  prompt: "A sports car drifts around a wet corner",
  name: "Car drift shot",
});
```

提交后返回 `jobId`，并默认结束 Turn。只有用户之后要求状态，或依赖步骤需要完成后的 Asset 时，才调用 `track_progress`。使用 `action=status`；它会立即返回，因此遵循之后的回查指导，不要循环，也不要期待 `action=wait` 阻塞。

## Config Mode

对于复杂多模态 Job，提前构建完整 Args Object，并通过一次调用传入：

```ts
submit_video({
  model: "seedance-2-5",
  prompt: "...",
  name: "...",
  refImages: ["def67890", "ghi24680"],
  refVideos: ["abc99999"],
  refAudios: ["jkl55555"],
  durationSeconds: 8,
  ratio: "9:16",
});
```

## 规则

- 始终提供带描述性的 Asset 名称 `name`。
- 默认仅提交。除非后续任务已排队，否则提交后结束 Turn。
- 不要尝试通过 `submit_video` 管理 Job——状态和之后的回查属于 `track_progress`。
- 生成消耗积分。提交前简短告诉用户即将生成什么。

