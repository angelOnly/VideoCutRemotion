# Seedance 2.5

使用 `model: "seedance-2-5"`（`submit_video` 的默认模型）生成前，请阅读本文档。

## 能力

- 时长：通过 `durationSeconds` 设置 4–30 的整数秒数（默认 5）。
- 分辨率：480p、720p（默认）或 1080p。Ark 将 1080p 输出编码为 10-bit H.265/HEVC。
- 画面比例：`16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`，或在锁定 Frame / Edit / Extend 任务中使用 Adaptive。
- 输出：省略 `outputFormat` 时，Generate 任务默认输出 mp4，Edit / Extend 任务默认输出 MOV。
- 始终启用音频生成。通过 Prompt 控制 Dialogue、Music、Ambience 和 Silence。
- 原生 Prompt / Audio 输出语言包括中文、英语、西班牙语、印度尼西亚语、马来语、泰语、阿拉伯语、葡萄牙语、越南语、日语和韩语。

## 输入

| Channel           | Tool param   |                   Limit |
| ----------------- | ------------ | ----------------------: |
| 精确首帧          | `firstFrame` |                       1 |
| 精确尾帧          | `lastFrame`  | 1，需要 first frame     |
| 参考图片          | `refImages`  |                      30 |
| 参考视频          | `refVideos`  |                      10 |
| 参考音频          | `refAudios`  |                      10 |

每个视频参考必须为 2–30 秒，总时长最多 30 秒。每个音频参考必须为 2–30 秒，总时长最多 30 秒。工具会验证数量；如果 Metadata 可用，在提交前检查源素材时长。

Seedance 2.5 支持纯音频参考生成。当 `refAudios` 是唯一输入时，不需要视觉参考。

Frame Mode 与 Reference Mode 仍然互斥。不要把 `firstFrame` / `lastFrame` 与任何 `refImages` / `refVideos` / `refAudios` 组合使用。

每个媒体输入都必须是来自 `read_project` 的 Project Asset Ref、`asset://<id>`，或同一 Project 的 Asset URL。先导入外部媒体。在 Prompt 中明确使用 `@Image1`、`@Video1` 和 `@Audio1` 引用输入，并紧接着说明每个参考控制什么。

## Task Mode

请求形态和 Prompt 决定任务：

| Intent               | Inputs                                      | Required controls                           |
| -------------------- | ------------------------------------------- | ------------------------------------------- |
| 文本生成             | 仅 prompt                                   | 所选比例和 4–30 秒时长                      |
| 参考生成             | 任意 reference array                        | 所选比例和 4–30 秒时长                      |
| 首帧                 | `firstFrame`                                | 比例变为 adaptive；4–30 秒                  |
| 首尾帧               | 两个 frame param                            | 比例变为 adaptive；4–30 秒                  |
| 视频编辑             | `refVideos` 中的源视频，`taskMode: "edit"`   | 继承源时长；输出为新视频                    |
| 视频延长             | `refVideos` 中的源视频，`taskMode: "extend"` | 设置延长时长；输出为新视频                  |

上游模型会从 Prompt 判断 Edit 和 Extend 意图。使用明确措辞，例如 `"Edit @Video1..."`、`"Replace..."`、`"Remove..."`、`"Extend @Video1 forward..."` 或 `"Continue @Video1..."`。不要在仅将视频作为语义参考的请求中，意外使用 Edit / Extend 用语。

对于 Edit，Seedance 会把比例和时长锁定为源视频。`submit_video` 会发送 `ratio: "adaptive"` 和 `duration: -1`；Edit 源必须为 4–30 秒。对于 Extend，它会发送 Adaptive 比例和请求的 `durationSeconds`。两条路径都默认输出 MOV，并始终创建新的生成 Asset；原始视频不会改变。

## Prompt 重写约定

本 Reference 用于把用户请求重写为一个干净、可直接提交的 Seedance Prompt。它不选择工具参数、不检查媒体、不导入 Asset，也不提交生成。保留用户想要的人物及其数量、关键道具、场景、因果事件顺序、空间关系、编辑目标、延长方向和最终状态。不要把参考中可见的细节转化为用户未提供的身份、年龄、职业、关系或故事事实。

提交参数与重写后的 Prompt 分开。不要把时长、比例、分辨率、Frame Rate、输出格式、模型名、API 设置或启用音频等设置写入 Prompt。用户提供的 Timestamp Range 属于创作方向，明确提供时应保留；不要仅为填满请求时长而发明数字 Timestamp。未提供 Timestamp 时，较长故事改用有序 Stage。

默认只生成一个最佳 Prompt，不附带分析、Prompt 外标题、Code Fence、改动说明或虚构的 Reference Label。完整保留已有 Reference Label，例如 `@Image1`、`@Video1` 和 `@Audio1`。如果请求的参考不可用，从 Prompt 中省略其 Label，只保留文字已确认的职责，并可在 Prompt 外用一句简短说明指出缺少什么。

对于实际使用的每个参考，说明其狭窄职责。参考图片可以定义人物、产品、道具、场景、Lighting 或关键状态；参考视频可以定义 Action、Camera Movement、Rhythm、Timeline，或作为 Edit / Extend 源；参考音频可以定义 Voice、Dialogue、Ambience、Sound Effects 或 Music。不要隐式继承一个参考的所有属性。如果视频只提供 Motion，需要时明确排除它的 Identity、Clothing 或 Setting。不要强行把无关参考写入 Prompt。

当完整输入列表已知时，把每个未使用的参考列在 `Unused references:` 区块中，并声明它不控制人物、场景、道具、Action、Camera 或 Sound。每个具名人物、群体、道具和场景使用一个明确映射。除非一张单人图片本身明确包含该群体，否则不要把它映射到同时出现在画面中的多个具名人物。

## 按 Mode 的重写规则

### Generate

对于纯文本生成，说明 Subject、Setting、主要 Event，以及用户要求时的可见 Style 或 Mood；只有相关时才写 Camera 和 Sound。对于参考生成，先写 Reference Role，再写 Subject Relationship、Event Sequence 和 Continuity Requirement。需要精确控制时，把抽象主张或情绪转化为可观察的 Action、Expression、Sound 或 Result。用户提供 Dialogue 时逐字保留；不要发明缺失台词。标明 Speaker，仅在指定时标明 Language；必要时说明其他人物保持自然安静。需要区分时，用 `{dialogue}` 表示 Spoken Line、`()` 表示 Music、`<>` 表示 Sound Effect。只有用户要求不生成文字时才写 `no subtitles`。

对于产品或流程 Prompt，把每一步表达为 Initial State、一个具体 Operation 和可观察的 End State。对于 Transfer、Pickup 或 Placement，每次变化后都说明唯一物品的归属。空间关系应锚定在 Counter、Table、Doorway 或 Vehicle 等稳定物体上，而不要只依赖 Screen-left / Screen-right。

### Edit

把 `@Video1` 视为唯一 Edit Master。说明要改变的确切 Object、Region 或 Sound，请求的 Replacement、Removal 或 Adjustment，以及保持不变的内容。保留源 Scene、Camera、Movement、Timing、Occlusion、Event Order 和所有未指定的可见元素。对于移动主体替换，要求新主体占据原主体的 Appearance Time、Movement Path、Speed 和 Occlusion Position，并声明原主体不再出现。不要把 Edit 重写成全新生成。

对于仅音频编辑，保留源 Picture、Action、Lip-sync Timing、Camera、Cut 和所有未指定声音。分别说明被修改的 Speaker 或 Sound Class，以及要保留的声音。

### Extend

说明延长方向是 Forward 还是 Backward。Forward Extend 从源视频最后一帧开始；Backward Extend 结束于源视频第一帧。添加新 Action 前，描述边界处 Pose 与 Orientation、Prop、Setting、Composition、Lighting、Sound State 和 Motion Trend 的连续性。绝不要修改原视频内容。每个延续人物或物体都保持为同一个连续实例：不要复制、拆分，也不要改变其身体或部件数量。

### Keyframe 与 Storyboard

对于 First-frame Mode，写 `@Image1 is the exact first frame.`，并分别说明它定义的 Composition、Subject Position、Pose、Prop、Setting 和 Camera Direction。对于 First-and-last-frame Mode，写 `@Image2 is the exact last frame.`，同样分别说明定义内容，然后描述两种状态之间的一次连续进程。其他参考可定义 Appearance 或 Material，但不得覆盖任一 Boundary Frame。

当多张图片定义有序关键状态时，说明它们的顺序，并描述每张图片控制的可观察状态；把它们视为语义 Anchor，而非逐像素固定帧。对于 Storyboard Grid，说明阅读顺序、要采用的 Shot Sequence，以及应忽略的 Sketch Style、Label、Arrow 或 Placeholder Figure。对于 Blockout Video，明确视频仅提供 Motion、Staging、Camera 和 Timing，还是也提供完整 Structure；从结果中排除 Construction Mark、Placeholder Material 和 Guide。

## Fidelity 与 Continuity 规则

把用户文字视为 Story Contract。不要改变人物数量或身份、关键道具、归属、关系、场景、因果顺序或结局。参考可以提供直接可见或可听见的特征，例如 Hairstyle、Clothing、Product Material、Room Layout、Movement、Camera Motion、Rhythm、Vocal Quality 或 Ambience。它不得覆盖文字定义的 Name、Relationship、Age、Occupation、Motivation 或 Plot Fact。

写作前在内部维护一份每个必需人物、群体、道具、场景、声源和最终状态的 Checklist。每个具名实体必须在 Prompt 中承担一个明确无歧义的职责。保持不同具名人物彼此独立：不要合并，也不要互换其 Appearance、Dialogue、Clothing、Prop、Action 或 Position。当某个物体唯一时，说明其数量和最终持有者或位置。空间关系重要时，相对于稳定物体表达，并在 Scene 之间保持 Orientation。

仅在控制所需的程度上，把内部或抽象方向转化为屏幕上可观察的行为。例如描述 Trigger、Gaze Shift、Hand Stopping、Breath、Posture、Expression、Action 或 Spoken Line，而不是添加新 Backstory。如果 Reaction 由可见事物触发，先显示 Trigger；或者通过明确 Eyeline / Camera Move 建立关系。不要把受伤表演、险些发生的事件或模拟事件改写成真实伤害或真实事件。

只有在能改善请求结果时才使用 Camera Term。说明 Camera 的 Subject、Start State、Direction 和 End State，而不是添加不受支持的技术参数。把少见或模糊术语展开为可见效果：说明什么保持清晰、什么变模糊、Camera 或 Subject 向哪个方向移动，以及 Foreground / Background 如何变化。不要把 Shot Number、Reference Number、Chapter Number 或 Step Number 转换成 Camera Angle。

保持各个声源彼此独立。说明每个 Audio Element 是 Spoken Dialogue、Voice Quality、Ambience、Sound Effect 还是 Music。对于多人对话，把每句台词绑定到对应 Speaker；必要时说明非发言者自然保持安静。除非用户要求，否则不要发明 Dialogue、Accent、Dialect、Narration、Lip Movement、Music、Subtitle、Signage 或 Voice-over。不要承诺仅靠 Prompt 就能精确渲染小文字、Formula、Label、Sign 或 Frame-accurate Timing。

## Story 与 Timing 重写

对于简短请求，保留一个简单连续 Action，不要用额外 Shot、Character 或 Event 填充。对于长故事，选择用户要求的 Scene、Trailer、Overview 或 Causal Arc。若范围未指定，保留一个完整主要 Event，而不要试图塞入所有 Subplot。压缩重复描述和非视觉 Exposition，同时保留 Relationship、Trigger Event、Critical Dialogue 和 Final State。

把较长 Prompt 组织为连续 Stage。每个 Stage 应包含一个主要 State Change、可理解的 Cause 或 Action，以及由下一个 Stage 继承的可观察 Ending。只有用户提供 Timing 或明确要求定时控制时，才使用明确 Timestamp Range。这些范围必须连续、不重叠、以整数秒表示，并应描述 Event Budget，而不是精确 Edit Point。如果外部给定时长不同于用户的创作时间线，保留 Event Order、Relative Pace 和 Final Outcome；改用无 Timestamp 的 Stage，而不是发明新 Timestamp。

当可用时长多于故事所需时，通过自然 Preparation、Eyeline、Pause、Reaction 或 Transition 扩展已有 Action。不要用重复动作、空镜头、新人物、新剧情事件或改变结局来填时间。优先使用以下基于状态的形式：

```text
Stage 1: Start with <visible initial state>. <One concrete action or event>. End with <observable state>.
Stage 2: Continue from <prior state>. <One concrete action or event>. End with <observable state>.
Stage 3: <Closing action or event>. End with <final visible state>.
```

## 可直接提交的重写模板

只使用请求所需的 Section。替换每个 Placeholder；最终 Prompt 中不要留下说明或 Template Syntax。

### 文本或参考生成

```text
Goal: <one clear video event and outcome>.

Reference roles:
@Image1 defines <one person, product, prop, setting, lighting, or key state>; do not use <unwanted properties>.
@Video1 defines <action, camera motion, rhythm, or timeline>; do not use <unwanted identity, clothing, or setting>.
@Audio1 defines <speaker or sound source>'s <voice, dialogue, ambience, sound effect, or music>.

Subjects and relationships:
<Person A> uses @Image1 for <specific visible attributes>.
<Prop A> belongs to <Person A>; there is only one <Prop A>.
<Person A> stands <stable spatial relationship>; <Person B> stands <stable spatial relationship>.

Event:
Start: <initial visible state>.
<Continuous main action with causal order>.
End: <final positions, prop ownership, and image state>.

Continuity:
Keep <identity, count, visible attributes, prop ownership, setting layout, camera axis, and sound relationships> consistent.
```

### 视频编辑

```text
Edit @Video1. It is the sole edit master and supplies the original setting, camera, camera movement, action timing, occlusion, and event order.

Change only <specific object, person, region, or sound> to <requested result>.
@Image1 defines only <replacement subject or object attributes>; do not use <unwanted image content>.

<Replacement subject> occupies the original subject's appearance times, movement path, speed, and occlusion positions. The original <subject> no longer appears.
All other visible people, props, background elements, actions, camera movement, cuts, and event order in @Video1 remain unchanged.
```

对于局部视觉 Edit，说明变更区域边界，并明确保留相邻物体。对于 Background Change，声明只改变保留 Subject Silhouette 之外的区域。对于 Addition 或 Removal，说明数量、位置、Appearance Time 和受影响区域。不要使用 Edit Prompt 重新设计源 Timeline。

### 仅声音的视频编辑

```text
Edit @Video1 only for sound. Keep its picture, subject actions, lip-sync timing, camera, cuts, and event order unchanged.

Change <named speaker or sound category> during <scope> by <removing, replacing, or adjusting it>.
@Audio1 supplies only <voice quality, dialogue, ambience, sound effect, or music>.
Keep <all other dialogue, ambience, action sounds, and music> unchanged.
```

### 向前或向后延长

```text
@Video1 is the source video.

Extend @Video1 <forward/backward>.
<For forward: The new first image continues @Video1's final frame.>
<For backward: The new final image naturally reaches @Video1's first frame.>
Maintain <pose and orientation, prop positions, setting layout, composition, lighting, sound state, and motion trend> at the boundary.

Then <new action outside the source video's existing content>.
End with <observable result>.

Keep <identity, clothing, unique props, setting layout, camera axis, and existing sound environment> continuous. Every continuing person and object remains one continuous instance without duplication, splitting, or changes to its part count.
```

### 首尾帧进程

```text
@Image1 is the exact first frame.
It defines <opening composition, subject positions, poses, props, setting, and camera direction>.
@Image2 is the exact last frame.
It defines <closing composition, subject positions, poses, props, setting, and camera direction>.
@Image3 defines only <specific appearance, material, prop, or setting attributes>; it does not override the first or last frame.

Start exactly from @Image1's state, then <continuous action and causal progression>, and naturally arrive at @Image2's state.
Keep <identity, count, prop ownership, setting layout, and camera direction> continuous between the boundary states.
```

## 最终 Prompt Checklist

- 只包含一个主要任务：Generate、Edit 或 Extend。明确要求先 Edit 再 Extend 时，拆成两个有序 Prompt，并把编辑输出作为第二个 Prompt 的源。
- 提交参数留在 Prompt 外，包括时长、比例、分辨率、Frame Rate、输出格式、模型名和 API 配置。
- 保留用户提供的所有身份、数量、关系、场景、因果、道具归属和结局事实。
- 每个使用的参考都有一个明确狭窄职责；不出现不可用或虚构的 Label。
- 不把从参考中观察到的内容提升为用户未提供的 Story Fact。
- 不同人物、群体、道具和声源保持各自映射，不交换职责。
- 长 Sequence 保持因果、Stage 之间的 Continuity 和可见 Ending State，不发明 Timestamp。
- Edit 写明唯一 Source Master、确切 Change Scope、保留内容和 Source Timeline 继承关系。
- Extend 写明方向、Boundary-frame Continuity、仅新增的内容和 Single-instance Continuity。
- Keyframe、Storyboard 和 Blockout 具有明确职责，并排除非最终 Artifact。
- Dialogue、Music、Ambience、Effect、Subtitle 和 Silence 只在用户要求时出现，并保持绑定到正确声源或 Speaker。
- 最终输出是一个干净 Prompt，不含 Meta-commentary、分析、参数说明或未请求的通用约束。

## Prompt 结构

像 Director 一样写，而不是 Keyword List：

1. 把每个输入映射到它的职责。
2. 用一句话概述 Subject + Setting + Event + Style。
3. 对较长 Clip 使用整数秒 Timestamp 描述 Sequence。
4. 在相关处说明 Shot Size、Camera Movement、Action、Performance、Lighting、Dialogue、Music 和 Sound Effect。
5. 以全局 Continuity 和 Negative Constraint 结尾。

使用没有间隙的连续 Timestamp Range，例如 `0-5s`、`5-12s`、`12-20s`。不要在一个范围中塞入过多内容；模型会省略或过度切分不可能的 Action Density。

对于很多参考，先列 Mapping，再写 Narrative：

```text
References: @Image1 is the hero product; @Video1 supplies camera motion only; @Audio1 supplies rhythm and vocal tone.
0-6s: ...
6-14s: ...
14-20s: ...
No subtitles. Keep the product geometry and label unchanged throughout.
```

支持 Negative Audio Instruction：`"no BGM"`、`"ambient sound only"`、`"no dialogue"` 或 `"no sound"`。不希望生成文字时写 `"no subtitles"`。

## 一致性

- 跨 Shot 共享人物、产品或场景时，复用同一组 Image Anchor。
- Motion / Style Continuity 重要时，在 `refVideos` 中带上最近获批的视频。
- 说明要从每个参考复制什么；除非确实需要，否则不要要求模型复制其所有属性。
- 身份漂移经过两次纯文本重试后，停止并添加或替换 Visual Anchor。

## 内容审核

包含真人的 Raw Reference 可能被拒绝。优先使用已授权 Portrait Asset 或符合条件的 Trusted Output。如果 Content Review 拒绝输入，显示失败并要求不同 / 已授权的参考；不要盲目重试同一媒体。

## 示例

```ts
submit_video({
  model: "seedance-2-5",
  name: "Twenty-second launch film",
  durationSeconds: 20,
  ratio: "16:9",
  resolution: "720p",
  refImages: ["product-image-id"],
  refAudios: ["soundtrack-id"],
  prompt:
    "References: @Image1 is the exact hero product; @Audio1 controls rhythm. 0-6s: macro reveal... 6-14s: orbit... 14-20s: final packshot. Preserve product geometry and label. No subtitles.",
});
```

