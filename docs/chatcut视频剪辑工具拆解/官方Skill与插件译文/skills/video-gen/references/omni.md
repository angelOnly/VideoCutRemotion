# Gemini Omni（`model: "omni"`）

使用 `submit_video` 的 `model: "omni"` 生成或编辑视频前，请阅读本文档。

我们提供 **Gemini Omni Flash**（`gemini-omni-flash-preview`）。面对用户时称为 “Gemini Omni”。

## 定位

Omni 是**编辑与 Draft Layer，不是 Finishing Model**。单次生成质量低于 Seedance 2；它的价值在于收敛：它是唯一可以**原位修改现有 Clip** 的模型——Prompt 未提及的内容会被保留（已验证：一次颜色修改在像素层面保持了 Position、Rigging、Highlight 和 Background 不变）。

在以下情况使用：

- 用户希望对现有生成 Clip 做**局部修改**（“把气球改成黄色”“remove the logo”“make it sunset”）——这是默认 Edit 路径，参见 SKILL Step 4。
- 用户希望得到预计还会修改的**快速、低成本 Draft**，再投入 Seedance / Kling 完成最终版本。

以下情况不要使用：

- Clip 必须是 **1080p**（Omni 只输出 720p）→ `kling` `mode:"pro"`。
- Clip 必须**超过 10 秒** → `seedance-2-5`、`seedance2` 或 `kling`。
- 改动是 **Extend 或 Bridge** → Seedance 模型 + `refVideos`（Omni 不支持 Extension 或 Interpolation）。
- Frame 必须显示**中文（或其他 CJK）文字**——参见下方 §文字渲染。

## Mode

| Inputs                      | Mode               | What happens                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 仅 `prompt`                 | generate           | 全新 Text-to-video Clip。                                                                                                                                                                                                                                                                                                            |
| `prompt` + `firstFrame`     | image-to-video     | 图片成为 Opening Frame；Prompt 描述 Motion。输出比例仍然跟随 `ratio`（已在 Probe 中验证）。                                                                                                                                                                                                                                          |
| `prompt` + `refImages`（≤3）| reference-to-video | Subject Reference：Prompt 把它们称为 Image 1..N，并描述一个包含这些 Subject 的**新** Scene（已在 Probe 中验证）。只支持图片，不能与 `firstFrame` 或 `continueFrom` 组合。这是唯一 Multi-image Mode——期望的 Closing Composition 通过 Prompt 描述，而不是固定成 Last Frame。 |
| `prompt` + `continueFrom`   | edit               | 根据 Prompt 修改引用 Clip；未提及内容保持不变。输出是**新 Asset**；源 Clip 保留在 Library 中。                                                                                                                                                                                                                                      |

输入 Mode 互斥——从 `refImages` / `firstFrame` / `continueFrom` 中只选择**一个**。`lastFrame` 会被拒绝：Omni 没有 End Keyframe（不支持 Interpolation），因此通过 `refImages` + Prompt 表达 Target Composition。`refVideos` / `refAudios` 也会被拒绝——Video 和 Audio Reference 属于 Seedance。

## 参数与限制

| Param                                              | Omni behavior                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `durationSeconds`                                  | 3–10。**它是目标，不是保证**——Omni 没有 Duration 参数；工具把目标注入 Prompt（Probe 中能精确到一帧）。Edit 时忽略，因为继承源时长。不要在自己的 Prompt 文本中再次写时长。                                          |
| `ratio`                                            | 只支持 `16:9` 或 `9:16`。不支持 1:1，也不支持 Adaptive。Edit 时忽略（继承源比例）。                                                                                                                                                                                              |
| `resolution`                                       | 省略。输出始终为 720p；传入 `1080p` 会报错。                                                                                                                                                                                                                                    |
| `firstFrame`                                       | 作为 Opening Frame 的 Image Asset Ref（Image-to-video）。不能与 `refImages` 或 `continueFrom` 组合。                                                                                                                                                                            |
| `refImages`                                        | 最多 3 个 Subject Reference（Reference-to-video）。不能与 `firstFrame` 或 `continueFrom` 组合。                                                                                                                                                                                 |
| `continueFrom`                                     | 要修改 Clip 的 Video Asset Ref。源必须 ≤10 秒。                                                                                                                                                                                                                                 |
| `mode` / `shotType` / `multiPrompts` / `lastFrame` | 不支持。`mode` / `shotType` / `multiPrompts` 仅用于 Kling；`lastFrame` 会被拒绝（没有 End Keyframe / Interpolation）。                                                                                                                                                           |

计费：按**实际生成时长**（Provider Reported）收费，而不是请求的 Target。约 0.4 积分 / 秒，是三个模型中每秒成本最低的——但每次 Edit Round 都是按完整价格进行一次完整重新生成，因此较长 Edit Chain 可能比一次 Kling Finish 更贵。用户持续迭代时，说明这一点。

## Prompt 技巧

- **使用英文编写 Prompt。** Google 只评测过英文；其他语言明确属于未经评测范围。
- **不使用 Negative Prompt，也不使用 `Avoid:` Block**——API 会拒绝 Negative Prompting Concept。用正向方式说明期望：不要写 “no camera shake”，改写为 “locked-off static camera”。
- Camera 与 Motion 通过自然语言控制：`"handheld shot"`、`"continuous smooth shot, no scene cuts"`、`"single unbroken take"`。
- Timing 可以使用带括号的 Time Code：`[0-3s] the balloon rises, [3-6s] it drifts out of frame`。
- Tracked Subject 保持在 **3 个以内**——Review 显示超过 3 个时容易合并和漂移。
- 对于 **Edit**：只直白描述改动（“Make the balloon yellow”）。在 Edit Chain 后续 Round 中，添加 “keep everything else exactly the same” 是有用 Anchor，但 Round 1 不需要。

## Edit Chain

每次 Edit 都以前一次输出作为输入，因此质量损失可能累积：

- 每次 `continueFrom` 调用中，`submit_video` 都会报告 **Edit Round**。
- 工具在 Chain Depth 较深（Round 4+）时发出警告，需转告用户：建议根据当前版本的描述从头 Regenerate，或在本轮 Prompt 中加入明确的 “keep everything else exactly the same” Anchor。
- 每个版本都是独立 Asset——用户始终可以从 Library 回退到较早 Round。

## 文字渲染

- **Frame 必须显示中文文字时不要使用 Omni。** 高笔画密度汉字（面、鬱、藏……）会稳定生成畸形 Glyph；日文 Kana 大多也会失败。CJK 文字使用 Motion Graphic Overlay，或使用其他模型。
- Latin Text 通常可用，但仍弱于 MG Overlay——任何必须 Pixel-crisp 的文字优先使用 Overlay。

## 限制

- 生成 Clip 和 Edit Source 都有 **10 秒硬上限**。
- **只支持 720p / 24fps。**
- **不支持 Extend、Bridge 或 First/last-frame Interpolation。**
- **没有 Audio Input**；生成 Clip 包含原生音频（Music / SFX 由 Prompt 控制）。不支持 Voice Editing——Edit 不能改变 Spoken Content。
- Talking Shot 的 Lip-sync 在约 6–7 秒后会下降；多人同框说话表现较弱。长 Talking-head Content 应使用其他模型。
- Content Policy 比其他模型更严格，边界难以预测（Brand Name 和对人物进行 Age-edit 是已知 Block）。如果 Prompt 被拒绝，避开 Brand / Real Person 后重新表述，而不是逐字重试。
- 所有输出都带有不可见 SynthID Watermark。
- 生成是同步的，通常不到一分钟即可返回；如果 `track_progress` 显示 Job 因 Provider Policy Message 失败，原样向用户显示。

