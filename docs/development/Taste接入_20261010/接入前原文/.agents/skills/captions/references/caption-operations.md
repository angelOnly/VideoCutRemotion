# 字幕生成、编辑与版式操作

## 文本事实来源

字幕来自最终观众会听到的 Script/Speech，而不是原始 ASR、旧文稿或模型改写。数字、专名、否定、条件和单位必须与实际声音一致。若用户要求字幕做摘要或标题，应明确它不是逐字字幕，并避免改变事实。

## 修改范围

仅改文字错字通常不改变主线时长；改分卡和 Timing 会影响 Preview；改 Style 可能影响全片布局；主声音变化使 Caption stale。Impact 应与修改类型一致。

## 当前工具与能力

当前 MCP 可 `generate_source_audio_captions`、`generate_speech_captions`、`read_source_audio_alignment`、`apply_source_caption_program`、`read_captions` 与 `edit_captions`。原声 A-roll 默认调用 `generate_source_audio_captions`；当前完整 SpeechAsset 已组装到唯一 Dialogue 时，用 `generate_speech_captions(base_revision_id, idempotency_key?)` 从最终可听音频生成字幕。两条入口复用 FunASR 的真实 `startMs/endMs`：每个 Provider 字幕 segment 自动对应一屏，不重生 TTS。一个 segment 可以自然排成一至两行，但同一时刻不合并多个 segment。

自然 SpeechSegment 是配音生产单位，不是强制一屏的阅读单位。不要因一段自然旁白的默认字幕溢出，就拆碎配音、按字符均分时间、缩小字或删成摘要。旁白入口保留 Script、SpeechSegment、SpeechAsset、Dialogue 和画面，只在成功后原子替换未人工改写的默认字幕；统一版式沿用，已有不同局部版式或人工改写会拒绝静默覆盖。Job 期间暂缓其他项目写入，结束后读回当前 Revision；冲突先对账，不自动重放。`source_audio` 表示从实际音频派生，Alignment 的 `speechSource` 明确记录最终旁白来源，不是假 A-roll，也不会把字幕 token 升级成 SpeechTiming 的 word_exact。

Provider 能提供严格 token 时间时，Alignment 标记为 `provider_token_timed`，才可在单段实际排版超过两行、Provider 分段明显破坏完整语义、回听确认错分段，或用户明确要求重新分屏时，读取 Alignment 并用 `apply_source_caption_program` 原子覆盖默认 Program。它不能手填时间、按字符均分时间或改写实义词。若 Alignment 标记为 `tokenPrecision: unavailable`，其 Provider segments 仍是可正常使用的 `sentence_exact` 原声字幕；但没有可验证的新切点，`apply_source_caption_program` 必须拒绝，不能为了排版或错字猜测时间。此时应保留默认段、重新取得带严格 token 证据的对齐，或回到源音频完成可追溯的纠错。

单卡 `update` / `reset` 可用于当前 SpeechAsset 或已审计 `source_audio` 的稳定 Card：屏幕文案最多两行、有限字号/颜色/字幕位置、深色底板及受限透明度、一个连续强调短语，或恢复来源文案；不会改 Script、SpeechSegment 和声音。原声 A-roll 需要统一底板时，读取明确 Card ID 后以 `action=bulk_source_format`、`caption_ids` 与 `format` 原子应用到同一 A-roll，避免逐张提交造成 Revision 冲突。批量版式不接受 display 或显示时间范围，也不会新增、删除、拆分或重定时 Card。历史 `chunk_coarse` 仅供旧 Revision 读取；新的原声字幕不会创建它。若主线原文或时序变化，旧 Card 会被明确 stale 或重建，不能静默沿用。`occurrence` 从 0 开始，仍没有逐词时间或逐词动画能力。

已实现的单卡 `edit_captions(action=update)` 可提交 `display: {mode: "shown", ranges: [{startFrame, endFrame}]}`，ranges 使用 Timeline 绝对帧的半开区间，位于本卡原始范围内、按先后排列且互不重叠，最多 50 段；shown 省略 ranges 表示显示整卡。`display: {mode: "hidden"}` 隐藏整卡且不能带 ranges，`display: null` 恢复整卡显示。这只改变显示，不删除原文或 token，不改原 Card 边界与语音对齐，也不能把范围延伸到下一句。

静态位置使用 `format.placement: {leftPercent, topPercent, widthPercent}`，以左上角百分比定位字幕框，替代该卡旧的底部定位。leftPercent、topPercent 为 0～95，widthPercent 为 5～100，leftPercent + widthPercent 不超过 100；`placement: null` 恢复旧布局。框的位置与宽度不代表任意逐帧动画或自动避让；多画幅与长行仍需真实合成检查。动态短语、跟随对象的标签及跨句变化继续交受管作品。

主任务只在当前会话 Schema 提供这些字段时提交，读回 Caption、显示与位置、Revision 和 Impact，再把实际合成交原专项复核。范围无效、内容 stale 或字段缺失时按当前错误与报障合同处理，不删除对齐信息来取得显示效果。

识别错词、数字和英文显示可依据实际回听、与当前配音对应的已确认原稿，或用户明确修改指令。对已有对齐 Card 调用 `edit_captions(action=update, text, source_text_review)`：实际回听用 `{note}` 或 `{basis:"listening",note}`；已确认原稿用 `{basis:"confirmed_script",note,scriptRevision,speechSegmentIds}`，服务端核验当前 SpeechAsset、脚本版本、字幕所在片段及新文字属于该原稿；用户指令用 `{basis:"user_instruction",note,instruction,source}` 保存明确要求及来源。服务端保留原 sourceText、Alignment、时间、原文与新文审计，不改声音或 Script。原稿/用户指令依据不能声明实际听过，声音本身读错交回配音。标点、空格和换行不需要实义纠错记录；纠错后重分屏需先明确 reset，再重新复核。

任何修改后要读回 Caption、Revision、Impact，渲染真实 Preview。只看文本 JSON 不能发现遮挡、行宽、画幅和阅读时间问题。

## 静态版式参数与拒绝分类

`bulk_source_format` 要求同一来源使用 `sourceTimelineItemId`，旁白音频生成的有效来源卡也适用，不以素材是否 A-roll 判断。关闭背景传 `background_color:null` 并省略 `background_opacity`；透明度0非法，有背景时允许0.1至1。移除背景不建立白色字幕带，白带仍需原视觉作者的正式可渲染对象和真实合成验证。先检查 `isError` 并保存原始文本，不能直接JSON解析丢失协议校验错误；明确参数拒绝沿共享运行合同纠正，不把输入非法误报平台故障。

## 来源链与显示核对

`read_quality_report` 复用同一来源、真实时间和完整覆盖校验认定当前旁白字幕；有效的 `speechSource` Program 不需要伪造 `speechSegmentId` 或补“一段一卡”。缺卡、过期、错误旁白/原稿和破损覆盖仍阻挡，静音间隙不要求字幕填满。

字幕未指定 placement 时使用默认底部布局；bottomPercent 和 horizontalInsetPercent 控制字幕自身距离与宽度，不划定动效禁入区域，也不会约束其他对象。预览不绘制固定安全框，不输出安全区相交提示。受管字体绑定不自动控制原生 Caption 轨，maxLines 不是当前显示参数；需要的能力以连接会话 Schema 为准。

质量报告仍提示缺失时，先查当前 SpeechAsset、Program 完整性、真实时间和双向来源引用，不能给每个 SpeechSegment 人为补一张卡。修改读回的显示设置与实际渲染分别核对。
