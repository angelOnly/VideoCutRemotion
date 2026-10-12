# 字幕生成、编辑与版式操作

## 文本事实来源

字幕来自最终观众会听到的 Script/Speech，而不是原始 ASR、旧文稿或模型改写。数字、专名、否定、条件和单位必须与实际声音一致。若用户要求字幕做摘要或标题，应明确它不是逐字字幕，并避免改变事实。

## 修改范围

仅改文字错字通常不改变主线时长；改分卡和 Timing 会影响 Preview；改 Style 可能影响全片布局；主声音变化使 Caption stale。Impact 应与修改类型一致。

## 当前工具与能力

当前 MCP 可 `generate_source_audio_captions`、`generate_speech_captions`、`read_source_audio_alignment`、`apply_source_caption_program`、`read_captions` 与 `edit_captions`。原声 A-roll 默认调用 `generate_source_audio_captions`；当前完整 SpeechAsset 已组装到唯一 Dialogue 时，用 `generate_speech_captions(base_revision_id, idempotency_key?)` 从最终可听音频生成字幕。两条入口复用 FunASR 的真实 `startMs/endMs`：每个 Provider 字幕 segment 自动对应一屏，不重生 TTS。按本片既定行数排版，不在同一时刻合并多个 segment。

自然 SpeechSegment 是配音生产单位，不是强制一屏的阅读单位。不要因一段自然旁白的默认字幕溢出，就拆碎配音、按字符均分时间、缩小字或删成摘要。旁白入口保留 Script、SpeechSegment、SpeechAsset、Dialogue 和画面，只在成功后原子替换未人工改写的默认字幕；新卡和重建卡继承全片规范，已有人工改写或旧项目不同局部版式不能静默覆盖。Job 期间暂缓其他项目写入，结束后读回当前 Revision；冲突先对账，不自动重放。`source_audio` 表示从实际音频派生，Alignment 的 `speechSource` 明确记录最终旁白来源，不是假 A-roll，也不会把字幕 token 升级成 SpeechTiming 的 word_exact。

Provider 能提供严格 token 时间时，Alignment 标记为 `provider_token_timed`，才可在单段实际排版超出既定行数、Provider 分段明显破坏完整语义、回听确认错分段，或用户明确要求重新分屏时，读取 Alignment 并用 `apply_source_caption_program` 原子覆盖默认 Program。它不能手填时间、按字符均分时间或改写实义词。若 Alignment 标记为 `tokenPrecision: unavailable`，其 Provider segments 仍是可正常使用的 `sentence_exact` 原声字幕；但没有可验证的新切点，`apply_source_caption_program` 必须拒绝，不能为了排版或错字猜测时间。此时应保留默认段、重新取得带严格 token 证据的对齐，或回到源音频完成可追溯的纠错。

新项目使用 `Timeline.captionFormat` 作为全片普通字幕样式的权威来源。设置或统一修订时使用 `edit_captions(action="set_global_format", format=..., base_revision_id=...)`，不带 `caption_id` 或 `caption_ids`；它统一整条 Timeline，清除旧 Card 的局部 format/emphasis，新生成或重建字幕继承同一规则。旧项目未切换前仍按历史卡片解释，进入当前固定字幕路线时用同一入口明确切换，不修改历史 Revision。

`read_captions` 返回对象中的 `projectId`、`revision`、`presentation`（`global` / `legacy_per_card`）、`captionFormat` 与 `captions`；统一样式在全片字段读取，不再假定每张卡复制一份 format。

统一样式后，单卡 `update` / `reset` 用于正文、纠错、显隐或恢复来源文案，不改变 Script、SpeechSegment 和声音；单卡 format/emphasis 与 `bulk_source_format` 会被拒绝并指向全片入口。旧未切换项目仍保留历史局部编辑能力，但不作为新任务逐镜设计字幕的路径。主线原文或时序变化时旧 Card 会明确 stale 或重建，不能静默沿用；历史 `chunk_coarse` 仅供旧 Revision 读取，新的原声字幕不会创建它。

已实现的单卡 `edit_captions(action=update)` 可提交 `display: {mode: "shown", ranges: [{startFrame, endFrame}]}`，ranges 使用 Timeline 绝对帧的半开区间，位于本卡原始范围内、按先后排列且互不重叠，最多 50 段；shown 省略 ranges 表示显示整卡。`display: {mode: "hidden"}` 隐藏整卡且不能带 ranges，`display: null` 恢复整卡显示。这只改变显示，不删除原文或 token，不改原 Card 边界与语音对齐，也不能把范围延伸到下一句。

全片静态位置使用 `format.placement: {leftPercent, topPercent, widthPercent}`，以左上角百分比定位字幕框，替代底部定位。leftPercent、topPercent 为 0～95，widthPercent 为 5～100，leftPercent + widthPercent 不超过 100；`placement: null` 恢复底部布局。框的位置与宽度不代表逐帧动画或自动避让；多画幅与长行仍需真实合成检查。动态画内短语、跟随对象的标签及跨句变化交受管作品，普通字幕不复制进作品。

主任务只在当前会话 Schema 提供这些字段时提交，读回 Caption、显示与位置、Revision 和 Impact，再把实际合成交原专项复核。范围无效、内容 stale 或字段缺失时按当前错误与报障合同处理，不删除对齐信息来取得显示效果。

识别错词、数字和英文显示可依据实际回听、与当前配音对应的已确认原稿，或用户明确修改指令。对已有对齐 Card 调用 `edit_captions(action=update, text, source_text_review)`：实际回听用 `{note}` 或 `{basis:"listening",note}`；已确认原稿用 `{basis:"confirmed_script",note,scriptRevision,speechSegmentIds}`，服务端核验当前 SpeechAsset、脚本版本、字幕所在片段及新文字属于该原稿；用户指令用 `{basis:"user_instruction",note,instruction,source}` 保存明确要求及来源。服务端保留原 sourceText、Alignment、时间、原文与新文审计，不改声音或 Script。原稿/用户指令依据不能声明实际听过，声音本身读错交回配音。标点、空格和换行不需要实义纠错记录；纠错后重分屏需先明确 reset，再重新复核。

任何修改后要读回 Caption、Revision、Impact，渲染真实 Preview。只看文本 JSON 不能发现遮挡、行宽、画幅和阅读时间问题。

## 静态版式参数与拒绝分类

本轮开发合同在 `format` 中提供 `font_id`、`line_height`（1～2）、`max_lines`（1 或 2）、`padding_horizontal` / `padding_vertical`（每侧 0～72 像素）、`border_radius`（0～72 像素）和 `box_width`（`content` / `full`），与已有字号、字色、位置、底板和阴影一起使用。HTTP 与读回采用相应 camelCase 字段。字体从 `read_motion_capabilities` 的 Runtime 登记库选择 `fontId`；受管作品的 `fontBindings` 不会自动控制 Caption，应显式设置字幕 `font_id`。不提交任意字体路径或伪造身份。

单行或双行规则在首次设计中确定，`max_lines` 不会自动创造真实语音切点，也不是缩字或裁字许可；溢出时按可靠对齐重分卡。全片框宽、内边距、行高与最大行数一起决定固定占位，连续检查长短句基线与底板高度。新能力只在连接会话 Schema 已提供时提交；仓库实现不代表旧 Runtime 已部署，缺字段时回传具体能力差异。

字幕阴影沿美术选择：当前开发合同 `format.text_shadow:null` 明确关闭；对象 `{offsetX,offsetY,blur,color,opacity}` 指定单层阴影（偏移 -20～20 像素、模糊 0～40 像素、颜色 #RRGGBB、透明度 0～1）。省略保留已有选择，历史未设置的卡沿用旧黑影；HTTP 与读回字段为 `textShadow`。统一项目通过全片入口修改；单卡与同源批量仅用于尚未切换的旧项目。预览与导出共用解释，提交前核对当前会话 Schema，旧会话缺字段不能假称已可控制。

关闭背景传 `background_color:null` 并省略 `background_opacity`；透明度0非法，有背景时允许0.1至1。需要白色或其他底板时沿全片字幕背景配置落实，不让主画面作品补画字幕带。旧未切换项目的 `bulk_source_format` 仍要求同一 `sourceTimelineItemId`，不以是否 A-roll 判断；统一项目一律使用全片入口。先检查 `isError` 并保存原始文本，不能直接 JSON 解析丢失协议错误；明确参数拒绝沿共享运行合同纠正，不把输入非法误报平台故障。

## 来源链与显示核对

`read_quality_report` 复用同一来源、真实时间和完整覆盖校验认定当前旁白字幕；有效的 `speechSource` Program 不需要伪造 `speechSegmentId` 或补“一段一卡”。缺卡、过期、错误旁白/原稿和破损覆盖仍阻挡，静音间隙不要求字幕填满。

字幕未指定 placement 时使用默认底部布局；bottomPercent 和 horizontalInsetPercent 控制字幕自身距离与宽度，不划定动效禁入区域，也不会约束其他对象。主画面重要内容避让已确定的字幕，字幕不随相机和场景变换。预览与导出共用样式解释和 Runtime 字体；读回全片 captionFormat、实际有效样式与最终合成，不能只看卡片 JSON 的局部颜色。

质量报告仍提示缺失时，先查当前 SpeechAsset、Program 完整性、真实时间和双向来源引用，不能给每个 SpeechSegment 人为补一张卡。修改读回的显示设置与实际渲染分别核对。
