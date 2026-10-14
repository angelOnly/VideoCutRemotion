# 模板文本生产的执行合同

此入口适用于含 taskId/runId/stage 的服务任务。读取本 run/input.json、result-schema.json、模板 renderer/renderer-manifest.json 及 instructions 全部文件。先调用 read_runtime_release 核对发行，再调用 read_production_task 读回事实。没有旧 Project、Revision、Asset/Cue 或 ExportArtifact，不为满足旧接口伪造这些对象。

Analysis 只形成可编辑文字分镜及估时。不得调用配音、帧预览、渲染；接口也会拒绝。保留输入事实、含义、原文及顺序，改稿须有明确授权。分镜 ID 稳定唯一，正文完整拼接；确认分镜不要求等于短字幕、配音句段或动画章节。模板阅读依据和需要交给 Render 的约束写入 context。

Render 以本次完整 dataList/otherRequirements 为准，覆盖分析旧稿与旧要求。启动持续负责的导演，按需要真实分派美术/运动和声音/审片作者，子代理不递归分派；本阶段已经提供完整稿，不默认另找素材或重写稿件。通用导演、构图、美术、演出、声音和审片方法沿原 Skills 的方法章节读取，执行接口统一使用本合同。旧项目写入、模型与搜索说明不适用于此发行版本。

完整模板是制作约束。固定素材、头像、Logo、包装、声音及片头片尾遵照包内说明。只在授权区域创作本期 Remotion 源码，不能仅放置文字卡代替所需解释。画面及实际运动回来后，由原作者继续修订。

## 制作工具与文件

- synthesize_speech_batch/read_speech_batch：整批自然句段优先一次登记。输入 speechBatchRequestId 与 segments；每段具有唯一 speechRequestId、segmentId、确认分镜 sceneId、text、voiceRef、speed。批次同键同输入返回原记录；不同输入冲突。服务按视频轮转、独立限制配音总并发 20 和单视频 5；不要按完成顺序匹配台词，也不要逐条搬运重复结果。
- synthesize_speech：speechRequestId、segmentId、text、voiceRef、speed；voiceRef 必须由模板声明且部署可解析。工具异步返回 id/state，read_speech_job 使用 speechJobId 读取原任务。正文、音色、参数不变且基础音频摘要通过时，使用 reuseJobId；同任务其他 Render 已确定成功的音频可同时显式指定 reuseRunId，工具仍核对归属、正文、音色、参数及文件摘要。unknown 音频不得复用。不同输入不得复用同键。
- retry_speech_validation：仅对 validation_failed 且音频已取得的原任务重做本地检查，不新增供应商请求。unknown 保留原任务，不承诺供应商可反查丢失结果。
- verify_sentence_audio：当前财经句段模板的固定审计工具，输入 timelineRef、speechBatchRequestIds，可选 renderRequestId 指向正式快照；服务核对确认正文、真实批次音频、字幕和 PCM 时长。不要把模板任意脚本交服务执行，也不在受限作者环境临时调用 FFmpeg 做同一审计。
- 配音成功后按工具 audioRef 把音频复制到本期工程 public 目录；记录确切文本、声音身份、实测时长和句段边界。字幕依真实句段分页，不伪造词级对齐。最终 spoken text 拼接必须对应确认正文，不添加结束语。
- search_motion_mechanisms/read_motion_mechanism：仅本地词法。围绕本场内容关系检索并核读原文、分镜；无结果调整词语或筛选，无向量/网络回退。
- 每个视频同时只执行一项渲染或固定媒体检查；静帧、连续预览及正式导出共用入口。RENDER_BUSY 表示本视频已有工作，查询并等待原任务，不换编号绕过。四个视频可并行，每项视频绘图最多 5 槽；额度由服务控制。
- preview_template_frames：提交renderRequestId和1～12个唯一全局frames，异步生成同一固定版本的图片；read_render_job返回readyFrames、sourceDigest和分组概览路径。长度1也用此接口。只有sourceDigest持久化后作者才可继续改工作目录；running不代表已冻结。按请求帧顺序看概览，用原尺寸图片检查中文细节。静态图片不能作为视频交付或代替运动和声音观察。
- 原作者交回可预览版本、关键静帧/动态范围及疑点；独立审片集中汇总同版问题，主任务去重后交原作者修订。记录真实修改和影响范围，复查修改位置及相邻切口；共用组件、字幕或全局时序变化扩大检查，不机械限制返修次数。部分静帧失败保留原证据，明确原因后只补必要范围；工程改变后不混用两版图片作为同版结论。
- retry_render_slices：只传原renderRequestId，在活动Run内恢复已明确failed、整片和固定快照仍可信的正式导出。使用原范围，只补未完成分镜；不适用于unknown、取消、终态Run、局部预览或未完成整片。整片或已登记文件损坏时先读原诊断，不能盲重放。
- render_template：renderRequestId、timelineRef（相对 project 的实际 JSON 时间轴文件）、ranges（完整确认分镜 ID 和全局半开帧区间）、checks（真实检查说明）、previewOnly。按本次运行时开关决定必要动态预览；正式交付 previewOnly=false，服务只绘制一次整片，再按已核验 TTS 时间轴与包装偏移确定的原范围生成分镜；切片模式由服务配置控制，快速候选不可靠时准确回退；局部动态预览仍直接绘制所选范围，期间不能修改工作目录。read_render_job 查询原 renderRequestId；不要因等待超时重复发起。新源码修订使用新的渲染键。read_render_job 的 readyFiles 仅包含渲染及检查完成的文件，允许提前审片；不要自行探测仍在写入的路径。所有文件成功后才是完整交付。
- 工具始终使用模板 wholeComposition；分镜不使用局部从零计时的 Composition。保留完整全片进度、跨句图形和片尾归属。旧准确模式保留模板原范围，整片时长可包含不属于任何分镜的片头片尾；混合模式按真实全局 scene 范围，首镜包含开头包装，末镜延长到 totalFrames 并包含 ending.outro，全部分镜连续覆盖整片。

最终将成功工具返回的 delivery.json 内容保存为本 run/result.json，保留准确 task/run/输入/模板/源码摘要及文件清单。工程、时间轴、配音保存在 project 中；审片计划、问题及观察记录放在本 run/qa 中，不参与源码快照摘要，供下一版本重制。工具做技术校验，作者做美术及真实视听，Worker 做完整性、发布与通知，三者不能互相代替。

## 指定成片修改

baseRenderRunId 指向明确成功版本，project 已是该版本的独立副本。读取旧成片、工程、声音和记录，以当前全文、当前要求及 revisionInstructions 判断影响。未受影响内容保持；视觉微调不无故重做声音，改稿或语速/音色改变时重新配受影响段并更新后续时序。完整导出整片及全部分镜，不覆盖基础版本。缺工程时报具体原因，不偷换最近版本。

## 恢复和交付边界

isError 先读原始诊断。相同配音键不同输入拒绝；unknown 保留原供应商请求和文件，不换 ID 盲重试。渲染等待只读原任务；明确失败且符合原正式作业续切条件时先使用retry_render_slices；其他失败修正真实原因后提交新编号，新源码修订也使用新编号。提交身份、发布、回调由服务负责，禁止直接修改数据库或已发布目录。

检查模板固定包装、准确正文、排版、真实运动、实际声音与最终文件。按实际观察记录覆盖和未完成项；不能把 ffprobe、完整解码、代表帧或静音代理说成完整连续视听。不等待额外用户确认来执行已授权测试流程，但最终用户定稿与自动测试通过分开。

## 按运行时开关执行主题审片与按需预览

以实际任务指令注入的服务配置为准。并行主题审片默认关闭，关闭时保留原单审片流程；按需预览默认关闭，关闭时保留原有必要动态预览步骤。不得自行将开关打开。以下优化只在对应开关开启时执行。

并行审片开启后，按已确认 chapters 与 scenes/dataList 关系建立唯一 unitId；没有章节归属时按确认分镜建立单元，不硬编码章节或句段数量，不重新拆稿。原视觉作者交回版本并结束写入；主任务统一批量生成必要静帧，等 read_render_job 返回 sourceDigest 与已核验 readyFrames 后分派。每批最多 12 张是上限，不要求凑满。

主任务核对宿主真实名额，最多使用配置上限（不超过 3）的独立审片代理，空闲者继续领取尚未检查的单元；优先安排复杂画面和实际疑点。导演并行审跨主题一致性、片头片尾与边界。独立审片只读分配的同版图片，不直接修改源码。结果包含 sourceDigest、unitId、assignmentId、真实 reviewerAgentId、已观察帧、问题证据及未完成范围。主任务归并同版同场景同帧范围同类别问题后，由原视觉作者集中返修。阻断问题须证明修复或明确升级；美术建议不自动变为阻断。

新源码用新 sourceDigest，只重取受影响单元及必要相邻切口；共享组件、字幕、全局时间轴或模板包装变化扩大范围。旧版通过不得直接覆盖新版，未变区域复用须有可信作者文件摘要等价证明。计划与结果保存 run/qa/review-plan.json、review-units 和 issue-ledger.json，工程中的真实 JSON、模板说明和时间轴仍参与摘要校验。

按需预览开启后，只有静帧不能回答的具体运动/声音疑点才考虑短动态预览；记录 sourceDigest、question、fromFrame/toFrame、consumer、真实连续检查方式和 passCriteria。提交时再次核实对应看/听能力；无能力时标记 professional_review_pending，不制造无消费对象的大范围预览。必要前置阻断关闭后冻结工程并正式绘制一次；已有同版已核验 whole-video 时直接读取 readyFiles 的原文件进行后续播放、提帧或真实视听，不再次渲染。

审片断流只恢复剩余只读单元。保留同版已完成帧和问题，记录旧分派、接替原因、宿主真实新 agentId 与新 assignmentId；接任者确认范围后续查。旧分派迟到结果保留历史，不能覆盖当前结论。媒体作业、TTS、视觉作者及可信整片保持各自原身份，通信中断不表示媒体失败。

### QA 辅助命令协议

开启优化时，实际任务指令给出随发行提供的 `review.cjs` 完整命令路径。主任务先创建本 run/qa，将每次请求写入 qa/request.json，再串行执行命令并读取 JSON 输出；子代理只回传结果，不并发改计划。此命令是内部记录辅助，不是 MCP 接口，不自行创建代理、检查图像或执行媒体。sourceDigest、静帧、agentId 和真实能力必须来自原工具/宿主已核实事实，不能用辅助记录自证。

- `initialize`：请求 `{ "operation":"initialize", "renderRequestIds":["原静帧作业ID"], "input":{ "runId":"实际Run", "sourceDigest":"已冻结摘要", "scenes":[{"sceneId":"确认分镜ID","fromFrame":0,"toFrame":100}], "chapters":[{"chapterId":"确认章节ID","sceneIds":["确认分镜ID"]}], "readyFrames":[{"frame":30,"sourceDigest":"已冻结摘要"}] } }`。示例帧号须换为真实数据；chapters 可省略。同版重复初始化会拒绝，需读原 review-plan.json 续接；新版初始化先归档原计划，全部状态从待审开始。
- `add_frames`：`{ "operation":"add_frames", "renderRequestIds":["原静帧作业ID"], "readyFrames":[{"frame":30,"sourceDigest":"当前冻结摘要"}] }`。同版后续补取的帧用此操作并入原计划，沿用原作业与文件 SHA 核验；相同帧路径或摘要变化拒绝。已有观察和问题保持；只有新增未观察帧落入已完成单元时，该单元回到 pending 并归档旧分派，必须用新 assignmentId 续查。空单元补帧后可领取；正在审查的单元补帧后由主任务将新增范围同步当前负责人。补帧本身不推进实际观察进度时间。
- `assign`：`{ "operation":"assign", "unitId":"实际单元", "agentId":"宿主真实代理", "assignmentId":"本次唯一分派" }`。先核实宿主容量并真实分派，再登记。
- `result`：`{ "operation":"result", "result":{ "unitId":"实际单元", "sourceDigest":"实际摘要", "assignmentId":"本次分派", "reviewerAgentId":"实际代理", "status":"partial", "observedFrames":[30], "observations":[] } }`。完整检查可用 completed；问题字段为 sceneId/frame/category/severity/evidence/problem/expected，evidence 必须为 initialize 返回的实际 `path#sha256`。结果可带 reviewedAudio=false 与 unobservedRanges；辅助器只管理静帧审查，始终保留整单元连续画面未审范围且 reviewedAudio=false，不能用 completed 声称连续视听通过。返回 accepted=false 时仅写 late-results.jsonl，不能更新通过结论。
- `takeover`：`{ "operation":"takeover", "unitId":"实际单元", "reason":"实际失联诊断" }`。只释放未完成分派并返回剩余帧；随后核实健康代理、真实续接，再用新 assignmentId 执行 assign，不重放媒体。
- `affected`：`{ "operation":"affected", "change":{ "sceneIds":["实际改动分镜"], "sharedComponent":false, "subtitles":false, "globalTimeline":false, "templatePackaging":false } }`。返回复查单元范围；这个范围不代表未改区域已自动通过，新版仍需可信等价证据或新观察。
- `preview`：`{ "operation":"preview", "input":{ "onDemand":true, "request":{ "sourceDigest":"实际摘要", "question":"具体疑点", "fromFrame":0, "toFrame":30, "consumer":"真实检查者", "passCriteria":"可核查标准", "needsVideo":true, "needsAudio":false, "continuousVideoAvailable":true, "continuousAudioAvailable":false } } }`。onDemand 必须等于本次实际开关；同版已核验整片可另传 verifiedWholeVideo 的 sourceDigest/fileRef。decision 只表示下一步选择，professionalReviewCompleted 始终为 false，不等于已看已听。

辅助命令失败时保留原请求、诊断及计划，纠正字段或读回原进度；不得清空同版计划、换媒体键或把命令失败当成媒体失败。命令不能证明业务质量通过，实际观察与阻断问题关闭仍由主任务汇总。


QA 初始化必须关联本 Run 的真实 renderRequestIds。辅助命令读原 render-jobs 记录，核对 kind/runId/sourceDigest/readyFrames，并读取静帧文件核对 SHA；不接受模型自行填相同摘要字符串作为可信证据。问题清单在每次接收结果后写入 issue-ledger.json。lastMeaningfulProgressAt 仅由新增观察帧或新问题推进，重复结果、心跳和改派不会伪装有进展。

局部返修时，initialize 可保持全片 scenes/chapters，只提供受影响范围本次重新取得的 readyFrames；没有新版证据的单元仍为 pending 且不可分派，不会强制生成全片静帧。新计划保留旧计划历史，不自动继承旧版通过。主任务结合历史与可信等价证据判断未变范围是否已覆盖；没有证明时如实保留待审，不以辅助器状态替代整体质量判断。

最终源码结束写入后重新执行 verify_sentence_audio，同一 sourceDigest 的真实审计必须匹配正式导出冻结版本。改源码后重新审计；失败先读原诊断修正，不换 renderRequestId 盲重试。混合模式使用时间轴实际 from/frames/utterances/ending 与包装全局范围，具体模式从 read_production_task 读回，模型不自行推断或切换。
