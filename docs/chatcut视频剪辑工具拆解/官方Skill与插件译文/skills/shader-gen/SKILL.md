---
name: shader-gen
description: |
  用于 WebGL 视频特效、转场、Mask 和调色（LUT / 调色 / 电影感 / film look）的 AI Shader 生成器。当用户需要视频特效（滤镜 / 特效）、转场（转场 / crossfade / wipe / cube / 3d）、Mask（蒙版 / 遮罩 / reveal）、Zoom / Push-in（推近 / 推镜头）或调色时使用——生成新 Shader 前，先尝试内置特效（Zoom、内置 LUT）。
user-invocable: true
---

# Shader 生成器

仅提交：创建一个后端生成 Job，并返回 `jobId`。提交后使用 `track_progress` 工具管理 Job 生命周期。

**新 Shader 始终使用 `generate.ts`。** 手工编写只用于编辑现有 Asset 代码——生成失败时绝不能把手工编写作为 Fallback。

## Catalog 优先规则——生成前先尝试现有 Asset

生成 Shader 前，调用 `browse_library`，除非用户指定的准确 Asset ID 已经在 `browse_assets` 中可见。

`browse_library` 是内置 Effect、内置 Transition 和 Project Effect/Transition Asset 的事实来源。Built-in 是稳定的全局 Asset ID，而不是每 Project DB Asset，因此它们可能不会出现在 `browse_assets` 中。

使用 `edit_item` 应用 Catalog Entry，**不要**调用 `submit_shader`。

合适的 Catalog 搜索：

```text
browse_library(query: "zoom")
browse_library(category: "transitions", query: "dissolve")
browse_library(category: "audio-fx")
```

只有没有 Catalog Entry 足够接近用户意图时才生成。

### `builtin:zoom` 与所有 Effect 使用相同的 Track-bound 放置

Effect 始终具有 Timeline Geometry。对整个 Clip 的 Effect，传入 `targetItemId`；ChatCut 会把它解析为覆盖该 Clip 的 Clip-anchored Range。对于明确 Timeline Range，传入 `trackId` + `trackBoundFrom` + `trackBoundDurationInFrames`。

```text
# Zoom on the entire video clip
edit_item(json: '{"adds":[{"type":"effect","assetId":"builtin:zoom","targetItemId":"<clip-id>","propertyOverrides":{"magnification":1.5,"shape":"hold"}}]}')

# Zoom on a sub-range of the clip (e.g. frames 90–150 only, a punch zoom on a beat)
edit_item(json: '{"adds":[{"type":"effect","assetId":"builtin:zoom","mode":"track-bound","trackId":"<trackId>","trackBoundFrom":90,"trackBoundDurationInFrames":60,"propertyOverrides":{"magnification":2,"shape":"punch"}}]}')
```

使用 `preview_timeline({views:["timeline"],tracks:["V1"]})` 获取 Track Item ID 和 Timeline Frame Range。需要准确 Item 详情时使用 `inspect_item({itemId:"..."})`。

| Key             | Type   | Range / values                             | Default | Notes                                          |
| --------------- | ------ | ------------------------------------------ | ------- | ---------------------------------------------- |
| `magnification` | number | 1–4                                        | `1.5`   | Zoom 倍率；1 = 不放大，2 = 放大 2 倍          |
| `focalPointX`   | number | 0–1                                        | `0.5`   | 水平焦点（0 = 左，1 = 右）                     |
| `focalPointY`   | number | 0–1                                        | `0.5`   | 垂直焦点（0 = 上，1 = 下）                     |
| `shape`         | select | `punch` / `hold` / `slow-push` / `instant` | `hold`  | 动画曲线                                       |
| `focalMode`     | select | `auto` / `manual`                          | `auto`  | `auto` 选择主体；`manual` 使用 focalPoint     |
| `easeInFrames`  | number | 0–60                                       | `8`     | 进入过渡帧数                                   |
| `easeOutFrames` | number | 0–60                                       | `8`     | 退出过渡帧数                                   |

使用默认 Zoom 时完全省略 `propertyOverrides`。只发送希望改变的 Key——Patch 语义。

### Clip-anchored 与 Adjustment-track

Effect Item 有两种放置方式，两者都具有具体时间范围：

- **Clip-anchored**：对整个 Clip 传入 `targetItemId`，或包含一个与 Clip 相交的明确范围。存储范围是该 Clip 的局部范围，并会在 Clip 移动时跟随。
- **Adjustment-track**：对空 Track 空间上的范围传入 `trackId` + `trackBoundFrom` + `trackBoundDurationInFrames`。该范围在 Timeline 上是绝对位置。

整个 Clip 的 Effect 使用 `targetItemId`。只有所请求范围不同于 Clip 完整时长时，才使用明确 Track Geometry。

### 内置 LUT 属性

```text
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<clip-id>","assetId":"builtin:slog3-s709","propertyOverrides":{"intensity":1}}]}')
```

| Key         | Type   | Range | Default | Notes                           |
| ----------- | ------ | ----- | ------- | ------------------------------- |
| `intensity` | number | 0–1   | `1`     | LUT 强度；1 = 完整应用          |

替换：删除 Effect，然后用不同 `assetId` 重新添加。移除：删除 Effect Item。

用户上传的 `.cube` LUT Asset 使用完全相同的形状——只有 `assetId` 不同。参见下方“应用现有 LUT Asset”。

## Beta 状态闸门

新 Shader 生成仍处于 Beta。生成前警告用户，并等待明确确认。

使用用户语言。中文："新的特效/转场生成目前还是 beta 阶段，可能会有不稳定的问题。如果你坚持要做，我可以帮你实现。" 如果用户已在同一请求中确认，则跳过。

## 支持的目标

Effect 和 Transition 可应用于 `video`、`image` 和 `gif` Item。

## 类型路由

生成任何内容前，先检查两条非生成路径：

1. **Catalog Entry**——对内置和 Project Effect/Transition 使用 `browse_library`。
2. **用户上传、并且已存在于 Project Library 中的 `.cube` LUT Asset**——绑定它，而不是生成；参见下方“应用现有 LUT Asset”。它会在 `browse_assets` 中显示为 `type: effect`，且 `editableProperties` 中包含一个 `lut` Type Entry。

| 用户需要                                                             | `--type`     |
| -------------------------------------------------------------------- | ------------ |
| 视频外观（颜色、Blur、Glow、Grain、Distortion）                      | `effect`     |
| 调色 / Look（Teal-orange、Cinematic、Vintage、LUT-style）            | `effect`     |
| 可见性控制（Mask、Reveal、Wipe、Shape Cutout、Gradient Fade）        | `effect`     |
| 片段之间混合（Crossfade、Dissolve、Slide、3D Cube/Page Flip）        | `transition` |

表格中的 "LUT-style" 表示**生成一份类似 LUT 的全新 GLSL 调色**——只在用户需要新内容时使用。如果用户要应用 Library 中已有 `.cube` 文件，不要生成；绑定现有 Asset。

生成路径没有单独的 LUT 或 Mask Generator——它们都属于 `effect`。

## 应用现有 LUT Asset

**默认目标是 Timeline。** “应用这个 LUT”表示在 Clip 上创建一个 `edit_item` Effect。只有当用户要求修改源素材在所有出现位置的效果——该 Asset 剪出的每个 Clip，或对画面进行 Log-to-Rec.709 标准化——才使用 `edit_asset sourceLut`，因为它会改变该 Asset 在每个 Timeline 上的所有实例。

用户上传的 `.cube` 文件会成为 **`category: "lut"` 的 Effect Asset**。把它应用到 Clip **不是**生成——它与内置 LUT 使用相同的 `edit_item` Effect Shape，只是把该 Asset 自身 ID 作为 `assetId`：

```text
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<clip-id>","assetId":"<lut-effect-asset-id>","propertyOverrides":{"intensity":1}}]}')
```

要点：

- `assetId` 是 LUT Effect Asset 的真实 ID。不存在字面量 `"lut"` Asset ID，也不存在嵌套在 `propertyOverrides` 中的 LUT Binding。
- `propertyOverrides` 只携带 `intensity`（0–1，默认 1）。`.cube` Binding 位于 Asset 上，不位于 Effect Item 上。
- 使用 `browse_assets type:"effect"` 查找 ID：LUT Asset 是 `editableProperties` 中包含 `lut` Type Key 的对象。内置 LUT 来自 `browse_library category:"luts"`。
- `targetItemType` 默认为 `video`；也支持 `image`、`gif`。
- 替换：删除 Effect，用另一个 LUT 的 `assetId` 重新添加。移除：删除 Effect Item。
- 要为整个源 Clip 在所有出现位置调色，而不是只修改一个 Timeline Item，对 Video/Image/GIF Asset 使用 `edit_asset` Update，并传入 `{"sourceLut":{"assetId":"<lut-effect-asset-id>"}}`；`{"sourceLut":null}` 可移除。
- 如果 `.cube` 尚未进入 Project，你无法通过此表面导入：此表面没有 LUT 导入路径，而且 `.cube` 也不是接受的聊天附件，因此绝不要让用户把文件发送给你。让用户把它拖入编辑器 Media Pool——编辑器会把它登记为 LUT Asset，随后它会出现在 `browse_assets` 中。不要告诉用户 ChatCut 无法处理 `.cube`；编辑器可以。

此路径不要调用 `submit_shader`。

应用后，使用 `preview_timeline` 确认 Effect 已列在目标 Clip 的 Track 上。不要仅根据 `edit_item` Response 报告成功。

## 用法

调用 `submit_shader` 前，用一个具体句子重述用户意图，然后立即继续。`track_progress` 返回后，用一行说明生成了什么——**不要**问“要保留还是重新生成”。

```ts
submit_shader({
  type: "effect",
  prompt: "Chromatic aberration with RGB split",
  name: "Chromatic Aberration",
});

submit_shader({
  type: "transition",
  prompt: "Smooth crossfade with soft edge",
  name: "Crossfade",
});

submit_shader({
  type: "effect",
  prompt: "Cinematic teal-orange color grade",
});

submit_shader({
  type: "effect",
  prompt: "Stronger version",
  referenceAssetIds: ["effect_asset_id"],
});
```

## 策略

- 提交，然后停止。告诉用户 Job 已创建。
- 提交后使用 `track_progress` 工具检查状态/等待。
- 生成始终产生 Library Asset——绝不要因为 Timeline 尚未就绪而拒绝。
- **应用是独立且可选的。** 只有用户明确要求时才应用（“加到视频”“apply”“用到第一段”）。存在歧义时，默认只生成到 Library。

## 编辑现有属性

每当即将编辑 Shader `asset.properties`、已应用 Effect/Transition 的 `item.propertyOverrides`，或把硬编码 Shader 值提升为属性时，先阅读 [`references/property-changes.md`](references/property-changes.md)。

它强调 Shader `properties` 是 Array，但允许的 Shader Property Type 只有 `number`、`boolean`、`color`、`select` 和 `vec2`。Motion Graphic Property 也是 Array，但使用不同 Type 集合。

## 参数

| Param               | Description                                                                                                                                                       | Default |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `type`              | `"effect"` 或 `"transition"`（必需）                                                                                                                           | —       |
| `prompt`            | Shader 描述（必需）                                                                                                                                                | —       |
| `name`              | Library 中显示的 Asset 名称                                                                                                                                        | —       |
| `referenceAssetIds` | Asset ID。Image ID → 模型查看它作为视觉灵感。Effect/Transition ID → 复用其代码作为风格 Anchor（每次提交 ≤1，Kind 必须匹配 `type`）。 | —       |

## 输出

返回 `{ success, job: { jobId, status }, manage: { status, wait, watch } }`。

## 应用到 Timeline

只有用户明确要求时执行。使用 `view:"timeline"` 刷新受影响 Timeline；适合时传入 `track` 缩小读取范围。

### Effect

```text
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<id>","assetId":"<id>","enabled":true,"propertyOverrides":{}}]}')
```

### Transition

需要同一 Track 上两个相邻 Endpoint。`edit_item` 会验证实时接缝可行性，并拒绝需要 Freeze Frame 或与相邻 Transition 重叠的时长。如果添加失败，使用建议的 `durationInFrames` 重试、裁切 Clip 暴露 Handle、删除/缩短相邻 Transition，或保留 Hard Cut。

```text
edit_item(json: '{"adds":[{"type":"transition","assetId":"<id>","outgoingItemId":"<id1>","incomingItemId":"<id2>","durationInFrames":30}]}')
```

## 验证

### 后端验证

通过 `generate.ts` 生成时，后端会自动处理验证（Transpile、AST Security、Class Structure、失败重试）。

### 手工代码验证

**绝不要从头编写 Shader 代码。** 新 Shader 始终使用 `generate.ts`。本节**只**用于修改已经生成的现有 Shader 代码。

手工编写 Shader 代码时，先阅读 `${CLAUDE_SKILL_DIR}/references/design-principles.md`。如果修改涉及可编辑属性，还要阅读 `${CLAUDE_SKILL_DIR}/references/property-changes.md`。

典型工作流：

1. 使用 Shader `assetId` 和 `includeCode: true` 调用 `inspect_asset`——读取当前源码。
2. 在自己的上下文中编辑源码。
3. 调用 `edit_asset`，传入 `action=update`、相同 `assetId`，并把完整替换源码内联到 `json.code`。Update 时会自动运行验证——代码无效时，更新会被拒绝并返回错误详情。

