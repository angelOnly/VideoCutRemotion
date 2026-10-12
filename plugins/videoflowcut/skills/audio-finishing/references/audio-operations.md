# 声音轨道、混音与失效

## Ducking

Ducking 的目标是保持 Dialogue 可懂，而不是固定降低某个 dB。攻击和释放速度要避免音乐抽吸；旁白停顿很短时不要立刻全量回升；长无语音段可以恢复音乐。不同音乐频谱需要不同处理。

## SFX 与 onset

SFX 应绑定明确的叙事或视觉事件：预示变化、对象落定、数字完成、页面打开、按钮点击、路径完成、笑点或 Scene 转换。文件起点、可听起音、主要攻击峰值和尾音不是同一个时刻。先确认当前要同步哪一种感知，再由 effect-timing 根据真实源范围计算放置；静音检测提供的候选不能自动代表感知确认。

不能给每个元素入场都加同一种 Whoosh。大量 SFX 会使视频廉价，也会与语音辅音和音乐重音冲突。

### 声音功能、音色家族与包络

先在主要工作流的声画 Spotting 中确定预示、落定、反应或连接功能，再选择音色。预示型声音的起势和运动方向建立期待，主要攻击可在动作完成时到达；落定型用清楚、紧凑的攻击确认重点；反应型在语义反转之后进入，不提前提示答案；连接型以持续或衰减完成段落交接。它们是声音功能，不是要求每段都出现的四种素材。

同类事件可共享音色家族，通过攻击锐度、音高轮廓、持续、尾长与相对强度区分主次。一个包含起势和落定的完整包络可以覆盖多个相关视觉子动作，不必每个字、每条线分别发声。严肃判断不默认低频轰击，普通提醒不默认警报，文字强调也不自动需要旋律性提示；音色携带的情绪必须与内容一致。

### 用户音效包的审阅与选择

先用 `browse_assets(kind=audio)` 检查已登记候选。用户另给本地音效库时，通过 `browse_local_sound_effects` 发现已配置根目录中的候选，再用 `inspect_local_sound_effect` 获取所选文件与非静音起点候选；这两个工具不把素材加入 Timeline。文件名和分类只用于检索，实际采用前须审阅完整音频，判断是否带语音、旋律、强情境、前导和长尾，以及与本片语气是否适配。

对高影响事件比较适量候选与不使用的结果，记录采用的文件/源范围、功能、可听起音、攻击、尾音及拒绝其它候选的原因。用 `import_local_sound_effect` 将选中素材正规导入，完成分析与 Readiness 后才由 `manage_audio` 放置；若已在项目中，复用对应 Asset。用户提供文件表示候选来源，也不要求消耗整个音效包。

### 在线候选与按需获取

默认在线选音，由 [sound-asset-sourcing](../../sound-asset-sourcing/SKILL.md) 完成按功能检索、有限候选原声分析、取得原文件与采用依据。用 `browse_sound_sources` 读取当前无需 Key 的 Provider、分类和访问能力，Mixkit 音效与 Mixkit 音乐分开处理。来源名称不证明适配，本地用户音效包也按同一范围和试听标准选择。

`manage_asset_requirements` 使用 media_kind=audio、audio_brief、role=sfx/bgm 和结构化 sound 条件，不填画幅。`recommend_sound_candidates` 可对候选排序并建立分析子 Job；父任务成功不代表听过。`acquire_media_asset` 后等待文件取得与技术检查，再按已有选择直接试听或经 `manage_audio` 写入源范围。候选预览与原文件分别定位；分析不生成使用资格，不要求搜索 API Key 或下载 OAuth。

### 绑定一个实际动作，而非只绑定“这段有动画”

配声意图可按 [秒级初始节奏与预览修订](../../effect-timing/SKILL.md#秒级初始节奏与预览修订) 用秒级初始范围描述起势、攻击和尾音怎样接续；完整首版声画预览后，再按真实动作和音源起音修订对应部分。最终绑定使用本次确认的事件帧。动画节奏变化需复核音效，用户明确锁定的声音与总长不随示例缩短；可修改声音由导演结合完整场面决定，不因文件已存在而锁定，也不用持续音效掩饰空等。

原创作品可交付多个命名动作，只为有听觉价值的事件配声，用完整包络服务连续动作，不给每个元素都加音效。换作品版本后读取新的局部事件帧与 stale AudioCue；旧绝对帧不能继续冒充正确落点。无声代理不能证明声画通过。

为重要动效配音时，`manage_audio` 的 effect_event 指定 effect_cue_id、event_name、local_frame、sync_offset_frames。先区分同一作品里的标题进入、关系建立与结论落定；选择真正要强化的动作。可听事件全局帧为 Cue.startFrame + local_frame + sync_offset_frames，Item 起点仍为 event_frame − onset_offset_frames。sync_offset_frames 表达听觉相对视觉的预示/滞后，onset_offset_frames 表达所选声音源范围内部的偏移，二者不能混用。

绑定作品的完整持续动作时，带上实际 event_id、work_version、local_frame 和 end_local_frame，并显式设置 design.durationFrames。持续声终点必须等于 Cue.startFrame + end_local_frame + sync_offset_frames，因此播放时长为 end_local_frame − local_frame + onset_offset_frames；非循环源范围必须足够覆盖这段播放时长。仅缩短 source_end_frame 不能替代显式持续时长。淡出包含在播放范围内，不额外增加尾部帧。例如动作106–124、onset为0时，durationFrames为18；若真实源起音候选为3帧，则所需播放时长为21帧，不能把这3帧源前导混成声画偏移。

只在动作起势或落定发一声、允许声音自然短尾时，使用事件起点或终点的点绑定，省略 end_local_frame；此时可保留比动作范围长的源尾音。点绑定表达实际声音设计选择，不用于冒充完整持续动作。所有起音候选和未复听结果仍保持 inconclusive，并在实际段落里检查提前/滞后及尾音遮蔽。

平台固定当前视觉版本签名。同版本动效纯平移会同步移动关联声音；换作品、改 Props、内部运动、时长或删除动效会停用旧声音并标 stale。重新使用时显式提交复核后的 effect_event；只调音量不能恢复失效的关系。确实改成独立叙事事件才传 null 解除关联，不把解除关联作为绕过复核。源音效或源起点改变后也要重新确认 onset。自动跟随只保护物理关系，不能证明新位置的语音遮蔽与听感仍成立。

### 可感知且不遮蔽对白

先选合适音色与包络，再调整增益。短促高频攻击可能遮住辅音，长尾可能占据下一句，纯低频效果在小扬声器上可能弱化，需要实际复听。`manage_audio` 的 design 支持角色、局部增益包络、持续时长及循环交叉淡化；循环需显式设置并复核接缝，不通过隐式拉伸凑长度。通用 EQ 和降噪仍未实现。

不抢人声并不等于接近静音。对代表性连续段保持同一回放条件，比较有声、无该音效与调整版：重点是否更明确，语句是否仍可懂，攻击是否与动作吻合，尾音是否完成释放，相邻重复是否造成疲劳。若只在单独播放音效时有效，混入实际 Dialogue 后几乎无感或产生遮蔽，则尚未完成。

## 响度与动态

技术响度目标取决于平台，但专业判断不仅是最终 LUFS。Dialogue 各段应一致，音乐和 SFX 有动态，峰值不削波。过度压缩会让全片持续很响，没有高潮和安静。

## 当前能力边界

当前 `manage_audio` 接受已就绪原文件，原子写入 AudioCue 与声音 Item；design 可引用 SoundPlan 与意图版本。保留当前 soundPlanId、soundIntentId、planVersion，直接生成比较片或写入当前设计，不先创建采用资格。声音计划、文件、类型与源范围由技术路径检查；起音和最终混合按实际试听说明，分析记录和历史采用状态不影响正常使用。

角色 Duck 依据当前主声音范围、可听视频原声和 attack/hold/release 退让，演示声音主导时音乐同样让位。SFX 的 event_frame、onset_offset_frames 仍须明确；作品事件优先使用实际 eventMap 的 ID、版本和范围。上下文变化会使混合复核失效；源范围/循环参数变化还需重查起音和接缝。`preview_sound_alternatives` 用正式声音计算生成比较片，正式 Preview 后再 `review_sound_mix`。`set_audio_output_target` 仅设置最终完整文件测量目标，不自动调音量或取得听审通过。`smooth_audio`、Room Tone 生成、EQ、降噪、自动 J/L Cut 和通用 DAW 仍是架构目标。

具有 design 角色的 SFX 会实际使用 Duck，它不是被渲染忽略的通用字段。旁白或人物原声触发时，基础 gain_db 之外还会叠加 reductionDb，例如 -18 dB 与 -14 dB 在完整触发区间合为 -32 dB，实际触发范围仍取决于主声音、对齐与包络。当前修改这类 SFX 的 ducking 时需同时显式提供 `design: { role: "sfx" }`，也可带回已核对的计划/意图/版本；只传 ducking 会被旧 SFX 范围合同拒绝。已有计划关联会保留，关闭 Duck 后混合仍回到待审，须重新比较旁白清晰度和音效强度。

## 声音计划、候选比较与混音复核

`manage_sound_plans(project_id?, base_revision_id?, input?)` 无 input 只读，有 input 写计划并要求当前 base_revision_id。`input.action=create` 必须提供 startFrame、endFrame、narrationDirection、dominantRole、musicDirection 和 intents；配音前按项目 fps 将段落预估秒数换成完整整数帧范围，语音生成后再用 update 按实测时长修订，预估范围不等于锁定成片时长。update/remove 必须提供 soundPlanId，update 可省略未改字段。`recommend_sound_candidates(project_id?, input)` 输入 assetRequestId、candidateIds、analyzeTop，需追踪返回的音频子 Job。`preview_sound_alternatives(project_id?, input)` 固定 revision、fromFrame/toFrame 与 alternatives，每种方案沿用正式音频编辑规则。`manage_audio` 的 design 支持 role、soundPlanId、soundIntentId、planVersion、durationFrames、envelope、loopCrossfadeFrames、loopReview；具体字段和范围读取实际 Schema。

`review_sound_mix(project_id?, input)` 提交 baseRevision、previewJobId、outcome、method、note，只接受可追溯正式 Preview；候选比较不替代正式复核。`set_audio_output_target(project_id?, base_revision_id, target)` 设置 targetLufs、toleranceLu、maxTruePeakDbfs，最终文件测量不替代听感。
