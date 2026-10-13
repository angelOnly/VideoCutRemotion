---
name: asset-import
description: 将本地媒体安全地复制到受管项目目录，登记 AssetRole、Provenance 和用途就绪状态；不把文件存在或媒体分析成功扩大为值得进入成片。
---

# 素材导入、角色和来源

## 主任务执行边界

指定文件导入、来源整理、媒体参数和 Readiness 核验可由主任务直接执行，并遵守 [production-coordinator](../production-coordinator/SKILL.md) 的统一写入安排。本文对主体、画幅或异常的观察用于提供事实；哪些素材值得采用、如何裁切与放置等创意判断交导演或专项子代理。子代理需要新素材时返回明确获取请求，主任务导入并读回 Project、Revision、Impact 后续接原代理，不把导入成功当作创意采用。

## 导入不是创作选择

`asset-import` 解决的是“这个文件怎样成为项目内可靠、可追溯、可处理的 Asset”。它不判断一条 B-roll 是否值得离开人物，也不决定某张截图是否能证明主张。导入成功只意味着素材进入候选事实层，后续仍要由主工作流、素材搜索、Cutaway 或证据 Skill 决定怎样使用。

## 导入前确认用途

用户提供的文件可能是 A-roll、B-roll、人物 Mask、VoiceReference、证据、Style Reference 或生成画面。角色会改变后续检查：VoiceReference 需要单人清晰声音；证据截图需要来源与完整页面语境；Actor Mask 需要帧率、时长和边缘匹配；B-roll 需要动作、构图和可裁切时长。

不要因为扩展名是 mp4 就默认 `a_roll`。当前 Web 过去曾经把所有视频作为 Presenter 主线候选，这会在项目加入 Cutaway、生成视频和参考视频后产生严重错误。Role 应明确登记，主线必须由 `assemble_presenter_track` 接受一组明确选择的 A-roll ID。

## 当前导入流程

```text
read_project / browse_assets
→ 检查同一内容哈希是否已存在
→ import_media(base_revision_id, file_path, role, tags, provenance)
→ track_job
→ 读回 Asset、媒体元数据、处理状态和 failureReason
→ 必要时 update_asset_metadata
```

当前 `import_media` 会把本地文件复制到项目受管目录，并创建媒体分析任务。必须使用真实本地路径，不把远程 URL 传给 Timeline。导入后只有状态、文件、媒体分析满足对应用途，才允许下游使用。

Pexels 选定单视频页由 `visual-asset-sourcing` 交给主任务，走 `search_media_candidates(provider="pexels", query=选定页面URL)`、`acquire_media_asset` 与媒体 Worker 的正式获取链路；浏览器无需交回本地路径，也不使用 `import_media` 代替 Provider。只有用户已经拥有本地 MP4、明确选择本地导入时，才按本 Skill 的通用流程记录实际来源和用途。

## Provenance

素材记录来源页面、作者、原始 ID、取得时间和文件哈希。平台不验证素材权限、使用权、版权或署名条件，也不要求授权证明；下载、采用与导出只按技术条件和实际内容推进。

证据和生成画面必须明确区分。MiniMax 可以生成概念或情绪画面，但不能生成看起来像真实法规、投诉、论文、新闻或产品页面的“证据”。

## Readiness

当前代码的 Asset `status=ready` 主要表示媒体分析完成，但架构需要进一步判断本地字节、可检视、Timeline 可引用、当前 Worker 可渲染。现阶段 Skill 应结合 Asset、Job、Preview 和 Quality 判断，不把一个 ready 布尔值当成全部能力。

例如一条 H.265 视频可能能被 ffprobe 识别，却在浏览器 Player 无法解码；一张字体依赖的 SVG 可以在本机预览，却在 Render Worker 缺字体。每一种都应显示不同失败原因。

## 派生与去重

相同内容哈希不重复复制。代理、缩略图、波形、Mask、裁切版和 Derived Asset 应保存来源关系，不能伪装成新的原始证据。若需要不同颜色或构图的视觉资产，应记录变换过程。

## 失败恢复

媒体分析失败时必须保留 failureReason，判断是文件损坏、编解码器、无音轨、缩略图还是路径问题。无音轨对静音视频可以是合法状态，不应一律失败；但把它当 VoiceReference 或 A-roll 原声时就需要阻止。

## 不同素材类型的专项检查

### A-roll / 人物视频

除了编码和画幅，还要检查是否有原声、口型、人物位置、背景变化、可用前后余量、明显生成异常和是否适合目标画幅。人物视频进入 Project 后不自动成为主线；主工作流仍需明确选择 Asset ID、顺序和声音所有权。

### VoiceReference

检查单人、时长、采样率、噪声、混响、背景音乐和情绪代表性。文件技术可读不等于适合克隆。推荐的有效源范围应记录，避免每次使用整段长音频。

### Actor Mask

Mask 与人物视频的分辨率、帧率、时长和帧序必须一致。导入后需要播放检查头发、手指和快速动作，而不是仅看缩略图。Mask 失败时不能让后景 Effect 继续进入 Delivery。

### Evidence

保存原始页面/文件、来源、作者、抓取时间和目标范围。截取后的图片应能回到原证据；项目增加的高亮不能与原文混在一起。

### Style Reference

仅用于提取字体、色彩、材质、密度和运动语气，不自动成为成片素材。参考素材用于风格分析，是否进入正式 Scene 由具体创作需求决定。

### Generated Visual

保存 Provider、Workflow、Prompt 摘要、参考素材、种子、时间和内容哈希。生成画面只能用于允许的说明或情绪，不冒充真实证据和用户亲自拍摄。

## Source Asset 与 Derived Asset

Derived Asset 例如封面墙、评论云、产品组合、图表、手机 Mockup 和高亮截图。它们应保存父 Asset 和生成过程。Remotion 可以直接组合，也可以先生成 Derived Asset；选择取决于可编辑性、性能和复用。证据类 Derived Asset 不能丢失来源或修改原文。

## Import 与 Web 上传

用户在 Codex 提供本地路径时使用 MCP 导入；通过 Web 上传时也必须走同一个 Application Handler，产生相同 Asset、Hash、Job 和 Revision 语义。浏览器临时 Blob URL 不是 Project Asset。导入后通过 Web Inspector 或 `browse_assets` 确认 Role、来源和状态。

## 可渲染检查

媒体分析 ready 后，至少选一个目标场景或短 Preview 验证 Browser/Remotion Worker 能读。特殊编码、旋转元数据、透明通道、可变帧率和字体依赖可能只在渲染时失败。正式导出前仍需 Render Preflight；导入测试不替代交付检查。

## 导入错误案例

用户给了 `product-demo.mp4`、`product-demo-final.mp4` 和 `product-demo-final2.mp4`。不能按文件名选最新。应比较 Hash、时长、内容和用户说明；若内容相同，避免重复；若一个是带字幕版本，一个是干净素材，Role 和用途不同。

另一个常见错误是把下载页面保存的 HTML 当视频。必须检查 MIME、文件头和 ffprobe，而不是扩展名。

## 交接合同

进入事实包括文件、Project/Revision、用途和来源。输出是受管 Asset、Role、Provenance、Job 和可读的 Readiness。可能失效的是旧路径引用和基于旧媒体元数据的计划。验证包括文件存在、哈希、ffprobe、状态、重复检查。

导入完成后将结果交回调用它的主工作流或 `visual-asset-sourcing`，不要自行放入 Scene。

## 当前调用与读回：导入本地素材

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| 导入本地素材 | `import_media(base_revision_id, file_path, role?, tags?, provenance?)` | `track_job(job_id)` 后用 `browse_assets` 或 `read_project` 确认 Asset、Hash、状态和来源。 |
