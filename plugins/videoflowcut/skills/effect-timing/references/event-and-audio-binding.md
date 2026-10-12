# 事件、起音与音频Item映射

## Event Anchor 与物理 Item 的区别

同一范围事件可选起势或落定的单次声音：不填写 endLocalFrame，localFrame 使用实际起点或终点（作品末尾按最后一帧）；需要完整持续声时才同时绑定起止范围。不要因为视觉动作持续三秒就强制所有音效也持续三秒。

受管作品有 eventMap 时，声音绑定提供 eventId 与 workVersion，并按 eventMap.fps 换算到项目帧率；startFrame/endFrame 是作品局部坐标。先选动作开始、落定或维持中的听觉锚点，再设置相对视觉偏移。持续声音显式填写时长或已复核的循环，不用一个短声音的起点冒充整段声音结构。作品平移可以跟随，内部版本或节奏改变需重读事件并复核。

“Ding 应在结论被听见时发生”是 Event Anchor。SFX Item 可能要更早开始，因为文件前导；动画也可能要更早进入，让稳定帧在结论落音。把所有 Item startFrame设为语义帧会导致观众实际感知错位。

当前 `manage_audio` 已持久化 media_event、onsetOffset 与可选 effect_event。后者以 Cue ID、动作名称、局部帧及听觉相对视觉偏移绑定一次具体动作，平台固定当前作品和内部时序签名。不要只在 note 写“结论落定”，实际却对齐到另一个动作。Cue 纯平移可同步移动音效；换作品、改内部运动或时长后停止旧声音并要求重新确认，不按比例推算新落点。这不提供自动词级或自动感知定位，校正仍需连续声画证据。

## 当前写入和验证

普通 Registry Cue 可修改 Motion；ManagedMotion 内部时序由源码/Props 固定，需重新生成版本。整体平移只改变 Cue 时间，内部重定时必须重新交付事件帧、读回 stale AudioCue 并复核。

使用 `manage_effect_cues` 写入 start/end、semantic_anchor、motion 和 quality_rules。当前 MotionLayoutCompiler 已消费 `spatial_anchor`、进入/稳定/退出预设与 `style_pack_id`；不同组件的实际曲线、素材布局和人物关系仍必须以 Preview 验证。写后读取 Impact，渲染目标范围，检查进入、中间、Settled、退出和前后完整语句。

### 将感知落点转换为音频范围

统一使用项目帧率，把所选源片段开头定义为零点。设可听起音相对偏移为 O，主要攻击相对偏移为 P，希望攻击对齐的视觉帧为 V，则音频 Item 起点为 V−P，可听起音事件帧为 V−P+O。当前 `manage_audio` 的 `onset_offset_frames` 填 O，`event_frame` 填可听起音事件帧；不能把攻击峰值偏移误称起音偏移。对于没有明显渐强的短音效，O 与 P 可能接近，但仍需实际确认。

这只是定位方法，不是自动检测能力。预进入、主要攻击与尾音的数值来自所选文件与源范围，不能用示例数值或统一零偏移。若计算越过 Timeline/Scene 的可用范围，选择更短攻击的候选或重新设计事件，不截掉必要起势后声称同步完成。
