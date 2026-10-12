# 声音候选取得与分析

## 在线来源和有限候选

先用 `browse_sound_sources` 读取当前无需 Key 的来源与访问能力，再 `search_media_candidates`。Mixkit 音效与音乐是独立 Provider；分类浏览不冒充全站任意全文搜索。不提供需要 Key 或 OAuth 的搜索、下载接口；其它网站只按浏览器入口和已发布导入能力处理。

`inspect_media_candidate` 返回来源、预览和技术过滤理由。挑选有限候选交给 `recommend_sound_candidates`，Qwen 对描述文字排序，不直接听音。父 Job 完成后继续追踪其中音频分析子 Job，再读取 `read_media_observations` 或 `search_media_fragments`：MiniCPM 实际观察到了什么，输入覆盖哪里，排除条件是否仍未知。模型漏检音乐或把电子音判断为旋律时保留不确定性，不能用更强提示词制造“无人声”的结论。

原声观察与用途匹配分开：声音需求仍用于在线搜索、文字排序和段落比较，初次声画观察不把标题、需求或期望答案传给模型。分析记录保留 context 供后续判断，但它不能生成声音事实。观察版本变化后重新分析所需候选，不把旧版带用途提示的响应当作新版独立观察。完整 JSON 尾部单个多余右括号可以恢复结构并保留提示；恢复不补事件范围、不把 unknown 改成 absent，也不代表适配通过。

## 采用必须回到原文件

准备采用时调用 `acquire_media_asset`，等待获取和媒体技术分析均成功；再通过 `analyze_media` 对原文件拟用范围做 review，必要时补上下文。预览与原文件分别保存身份，原文件重新定位，不能沿用预览的精确偏移。`read_media_observations` 分页读取事实与波形；技术起音、攻击候选和实际感知锚点分别记录。16kHz 模型输入用于语义，声道、底噪、精细攻击和尾音仍以实际原文件为准。

不足一秒的瞬态可能被模型误认成提示音或其他声源；描述成功但未给源范围时，只能用来筛选，不能自动扩成全文件覆盖。用 `inspect_asset` 的原文件连续音频与测量候选核对起音、尾音和语音/音乐条件；仍听不清则保留 inconclusive，选择其他候选或留白。遇到结构失败按 known-errors 报障，部署确认后才恢复已明确失败的分析；不靠反复强化用途提示逼出所需答案。

有实际依据时用 `correct_media_observation` 纠错，保留原文和旧记录；纠错只更新分析索引。范围与声音策略直接写入当前稿及声音绑定，不创建采用资格。未知项如实保留；声音是否适配由当前段落试听决定，辅助分析缺失不阻止合法原文件试排。

### 在线音效与动效事件关联

`browse_sound_sources()` 只读返回五个音效来源及已支持分类。`manage_asset_requirements` 的声音需求填写 media_kind=audio、audio_brief、role=sfx|bgm，fallback_plan 为 local_audio、omit_audio 或 ask_user，不填 visual_brief/target_aspect_ratio。使用已存在的 search/inspect/acquire/track 链：Mixkit query 是单个公开分类，不是任意关键词搜索；只下载被选中的原文件，不镜像全库。

`manage_audio` 可带 effect_event={effect_cue_id,event_name,local_frame,sync_offset_frames?}，平台固定当前视觉版本签名。event_frame = Cue.startFrame + local_frame + sync_offset_frames，Item.startFrame = event_frame − onset_offset_frames。动效纯平移自动跟随；内部内容、作品版本、时长改变或移除会停用关联音效并标 stale，须显式重新确认 effect_event。传 null 是有意解除关联，不是自动恢复方法。更换音效文件或源起点必须重新提供 onset_offset_frames。写后读回 AudioCue、Item、Impact，并在真实连续 Preview 中复核；这不增加自动听觉或词级定位能力。
