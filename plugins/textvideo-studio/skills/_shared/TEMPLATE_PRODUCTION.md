# 模板文本生产的执行合同

此入口适用于含 taskId/runId/stage 的服务任务。读取本 run/input.json、result-schema.json、模板 renderer/renderer-manifest.json 及 instructions 全部文件。先调用 read_runtime_release 核对发行，再调用 read_production_task 读回事实。没有旧 Project、Revision、Asset/Cue 或 ExportArtifact，不为满足旧接口伪造这些对象。

Analysis 只形成可编辑文字分镜及估时。不得调用配音、帧预览、渲染；接口也会拒绝。保留输入事实、含义、原文及顺序，改稿须有明确授权。分镜 ID 稳定唯一，正文完整拼接；确认分镜不要求等于短字幕、配音句段或动画章节。模板阅读依据和需要交给 Render 的约束写入 context。

Render 以本次完整 dataList/otherRequirements 为准，覆盖分析旧稿与旧要求。启动持续负责的导演，按需要真实分派美术/运动和声音/审片作者，子代理不递归分派；本阶段已经提供完整稿，不默认另找素材或重写稿件。通用导演、构图、美术、演出、声音和审片方法沿原 Skills 的方法章节读取，执行接口统一使用本合同。旧项目写入、模型与搜索说明不适用于此发行版本。

完整模板是制作约束。固定素材、头像、Logo、包装、声音及片头片尾遵照包内说明。只在授权区域创作本期 Remotion 源码，不能仅放置文字卡代替所需解释。画面及实际运动回来后，由原作者继续修订。

## 制作工具与文件

- synthesize_speech：speechRequestId、segmentId、text、voiceRef、speed；voiceRef 必须由模板声明且部署可解析。工具异步返回 id/state，read_speech_job 使用 speechJobId 读取原任务。正文、音色、参数不变且基础音频摘要通过时，使用 reuseJobId；同任务其他 Render 已确定成功的音频可同时显式指定 reuseRunId，工具仍核对归属、正文、音色、参数及文件摘要。unknown 音频不得复用。不同输入不得复用同键。
- 配音成功后按工具 audioRef 把音频复制到本期工程 public 目录；记录确切文本、声音身份、实测时长和句段边界。字幕依真实句段分页，不伪造词级对齐。最终 spoken text 拼接必须对应确认正文，不添加结束语。
- search_motion_mechanisms/read_motion_mechanism：仅本地词法。围绕本场内容关系检索并核读原文、分镜；无结果调整词语或筛选，无向量/网络回退。
- preview_template_frame：指定 frame，生成实际图片后用图像工具查看。静态画面合格不等于运动和声音合格。
- render_template：renderRequestId、timelineRef（相对 project 的实际 JSON 时间轴文件）、ranges（完整确认分镜 ID 和全局半开帧区间）、checks（真实检查说明）、previewOnly。先预览必要范围；正式交付 previewOnly=false，工具自动增加整片。read_render_job 查询原 renderRequestId；不要因等待超时重复发起。新源码修订使用新的渲染键。
- 工具始终使用模板 wholeComposition；分镜不使用局部从零计时的 Composition。保留完整全片进度、跨句图形和片尾归属。整片时长可包含不属于任何分镜的片头片尾。

最终将成功工具返回的 delivery.json 内容保存为本 run/result.json，保留准确 task/run/输入/模板/源码摘要及文件清单。工程、时间轴、配音、检查记录全部保存在 project 中，供下一版本重制。工具做技术校验，作者做美术及真实视听，Worker 做完整性、发布与通知，三者不能互相代替。

## 指定成片修改

baseRenderRunId 指向明确成功版本，project 已是该版本的独立副本。读取旧成片、工程、声音和记录，以当前全文、当前要求及 revisionInstructions 判断影响。未受影响内容保持；视觉微调不无故重做声音，改稿或语速/音色改变时重新配受影响段并更新后续时序。完整导出整片及全部分镜，不覆盖基础版本。缺工程时报具体原因，不偷换最近版本。

## 恢复和交付边界

isError 先读原始诊断。相同配音键不同输入拒绝；unknown 保留原供应商请求和文件，不换 ID 盲重试。渲染等待只读原任务；明确失败后修正实际原因再提交新渲染键。提交身份、发布、回调由服务负责，禁止直接修改数据库或已发布目录。

检查模板固定包装、准确正文、排版、真实运动、实际声音与最终文件。按实际观察记录覆盖和未完成项；不能把 ffprobe、完整解码、代表帧或静音代理说成完整连续视听。不等待额外用户确认来执行已授权测试流程，但最终用户定稿与自动测试通过分开。
