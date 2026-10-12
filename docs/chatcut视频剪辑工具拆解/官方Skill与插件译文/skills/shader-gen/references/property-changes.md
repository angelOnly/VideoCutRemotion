# Shader 属性修改

每当任务触及可编辑 Shader 属性时阅读本文：添加、重命名或移除 Property Key；修改 Default；把硬编码 Shader Constant 提升为属性；或更新一个已应用 Effect/Transition Override。

## 数据模型

三层，严格按以下顺序：

1. `asset.properties`——Effect 或 Transition Asset 上的可编辑 Property **Schema**。声明每个 Key（Type、Label、Default，以及 `min`/`max`/`step` 或 `options`）。事实来源。
2. `item.propertyOverrides`——每个已应用 Item 的 Override。稀疏存储：只需存储该特定 Effect/Transition Item 与默认值不同的值。
3. `ctx.properties`——传给 Shader Processor 的运行时 Object。通过合并 Schema Default 与已应用 Item Override 构建。

Shader Property Type 为：`number`、`boolean`、`color`、`select`、`vec2`。Motion Graphic Property 也是 Array，但使用不同 Type 集合——不要把 `text`、`font`、`image` 或 `video` 等 Motion Graphic 专属 Type 用于 Shader。

**前提规则：** Shader 代码读取 `ctx.properties.key` 之前，以及已应用 Item Override 能为该 Key 显示控件之前，该 Key 必须已经存在于 `asset.properties` 中。

对于 Shader Asset，`asset.properties` 始终是 Array。Array 中每个 Object 是一个可编辑 Property Entry。

## 决策表

以下情况使用 `edit_asset`：

- Shader 代码开始读取新的 `ctx.properties.key`
- 添加、重命名或移除 Property Key
- Property Type、Label、Options 或 Default 发生改变

以下情况对已应用 Item 使用带 `propertyOverrides` 的 Update：

- 该 Key 已经存在于 Effect/Transition Asset 上
- 某个已应用 Effect/Transition Item 应使用不同于 Asset Default 的值

不要使用 `propertyOverrides` 添加 Schema。不要用 `edit_asset` 设置一次性实例值。

## 把硬编码值提升为属性

当用户要求调整硬编码 Shader 值（Intensity、Radius、Color、Softness、Direction、Center Point 或任何可调值）时，在同一 Turn 中同时修改 Shader，**并且**把该值提升为 Property。这样用户下次可以通过编辑器 Property Control 自助调整。

以下情况跳过提升：

- 用户明确表示一次性使用（“just this once”“only for this item”）
- 值属于结构：Texture Binding Name、Pass ID、循环展开所需 GLSL Constant，或与 Shader 正确性绑定的数学值
- Asset 是用户不拥有的锁定 Template

工作流（一个 Turn）：

1. 获取当前 Shader Asset 代码和 Property
2. 定位硬编码 Literal
3. 用 `ctx.properties.<key>` 替换，并 Fallback 到当前值，使现有 Item 渲染保持完全相同
4. 在 `properties` Array 内添加匹配 Entry，并设置合理的 `min`/`max`/`step` 或 `options`
5. 一次 `edit_asset` 调用同时传入更新后的 `code` 和 `properties`
6. 如果用户还要求具体新值，把它应用为新的 `defaultValue`（Baseline），或应用为该特定已应用 Item 的 `propertyOverride`

示例——提升 Intensity Constant：

```ts
const props = ctx.properties as { intensity?: number } | undefined;
const intensity = props?.intensity ?? 0.6;
```

```json
"properties": [
  {
    "key": "intensity",
    "label": "Intensity",
    "type": "number",
    "defaultValue": 0.6,
    "min": 0,
    "max": 1,
    "step": 0.01
  }
]
```

示例——提升 Center Point：

```json
"properties": [
  {
    "key": "center",
    "label": "Center",
    "type": "vec2",
    "defaultValue": [0.5, 0.5]
  }
]
```

## Asset 级修改

Schema 发生变化时，在同一个 `edit_asset` 调用中更新 Shader Asset 的 `code` 和 `properties`。Update 时会运行验证，并拒绝不受支持的 Property Shape，或 Shader 专属/Motion Graphic 专属 Type 混用。

1. 获取包含 Code 和 Property 的当前 Asset
2. 更新 Code，从 `ctx.properties` 读取目标 Key
3. 使用新 `properties` Array 和新 `code` 调用 `edit_asset`
4. 如果重命名了 Key，把受影响的已应用 Item Override 迁移到新 Key

尽可能保持 Key 稳定——重命名会产生迁移工作。

## Item 级修改

前提：Key 必须已经存在于 `asset.properties`。如果不存在，不要更新 `propertyOverrides`——先进入“把硬编码值提升为属性”或“Asset 级修改”。

只更新值应不同于 Asset Default 的那个已应用 Effect/Transition Item。

```json
{ "propertyOverrides": { "intensity": 0.8 } }
```

```json
{ "propertyOverrides": { "center": [0.45, 0.55] } }
```

