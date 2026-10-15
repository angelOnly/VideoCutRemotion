# 文稿视频工坊两阶段接口（当前实现）

插件及 MCP 服务名：`textvideo-studio`。本文件描述当前源码接口；真实验收结果见 [部署与验收记录](textvideo-studio部署与验收记录.md)。其他早期 Worker 文档保留为对接背景，不作为当前字段合同。

## 请求与防重

除 `/healthz` 和媒体外，HTTP 请求使用 `Authorization: Bearer <服务令牌>`；JSON 请求声明 `Content-Type: application/json`。当前服务绑定配置中的单一 accountId，不从正文接受账号覆盖。

客户端不传 requestId。后端按账号、阶段、完整有效请求的规范化摘要查重；对象键顺序不影响摘要，正文、数组顺序和完整要求参与摘要。同一请求返回原 requestId/runId，失败或取消后重发也不复活。未知字段一律拒绝。

`POST /narrate/ai_video_director/getAiVideoEditingAnalysisData`

```json
{
  "taskId": "示例任务",
  "content": "第一句。第二句。",
  "otherRequirements": "保留原文，按所选模板制作。",
  "plugin": {"customTemplateId": "3"}
}
```

Analysis 下载并冻结 `GET <CUSTOM_TEMPLATE_API_BASE_URL>/api/custom-templates/3/package` 返回的 ZIP。阶段只产出文字分镜和 estimated 时长，拒绝配音和渲染。content（最多 100000 字符）和 otherRequirements（最多 20000 字符）均允许省略，只传任意一栏即可；缺省栏归一化为空串，两栏至少一栏有实质内容，实际传入的原始字符串不裁剪。综合两栏识别台词、人物、章节、画面说明与明确替换，实际台词和可见人物/画面标签一起进入分镜 content，采用及替换说明保存在原有非空 Markdown context；不要求逐字符来源台账。

模板职责：analysisInstructions 定义原稿人物、动作、栏目标记的解释；speakerBindings 以可见人物名为键，值为 {speaker, voiceRef}，同一张表用于 Analysis 的文字输入、返回标签检查、Render 当前稿解析及配音装配。instructions 定义模板制作步骤、固定包装、专属字段和检查。Analysis 读取展开后的文字合同与人物表；Render 读取冻结 manifest 及 instructions。平台不维护栏目人物名单或公司标题来源规则。财经模板的标题来源检查随模板脚本发布，按该模板说明运行。

`POST /narrate/ai_video_director/getAiVideoEditingData`

```json
{
  "taskId": "示例任务",
  "templateId": "",
  "introUrl": "", "introIndex": 0,
  "outroUrl": "", "outroIndex": 0,
  "dataList": [
    {"id": "scene_001", "content": "【主持人】第一句。【嘉宾】第二句。【画面：展示图表】", "dur": 5, "extraData": {}},
    {"id": "scene_002", "content": "【无口播：3秒】【画面：企业概况图】", "dur": 3, "extraData": {}}
  ]
}
```

上述为现有网页提交格式；网页与转发接口不改，不传分析版本、隐藏人物信息或新增制作要求。服务按 taskId 关联最新一次 Analysis，只有其成功时受理，失败或未完成时不回退；从该记录读取原始要求。接收当前完整列表，不能恢复用户删掉的镜头或标签。网页的 dur 仅是估时，不能决定口播时长；extraData 沿现有接口接收，不用它暗补正文或人物。

人物标签来自冻结模板 manifest.speakerBindings 的键名，例如本示例模板声明“主持人”和“嘉宾”，则识别【主持人】、【嘉宾】；没有内置人物或旧栏目别名。平台另识别通用标签【画面：说明】、【章节：标题】和【无口播：3秒】。人物、画面及章节标签不朗读；普通括号、数字和标点保持原样。未知或破损的【】标签报具体分镜。纯画面必须有画面说明、明确正时长（至多 3600 秒）且无台词；口播不能用无口播标签绕过配音。每镜独立解释，不从上一镜或旧 Analysis 猜回被删人物；拆镜后需要固定人物时应在新镜保留相应可见标签。

归一化在请求摘要和保存前完成：内部 dataList.content 为实际台词，submittedContent（有标签时）保存提交原串，directing 是代码从本次文本计算的人物发言范围、画面、章节及无口播时长。范围只供制作与校验使用，不要求网页编辑。分镜 ID 为 1～80 位字母、数字、下划线或连字符，唯一且不能为 whole-video；分镜数量 1～200。改字、换标签、删镜和重排都以本次提交为准，参与现有幂等判断。

Render 的 input.json 保留当前 request，以及原 analysisInput、analysis 结果。旧分析只供理解采用关系，已执行的替换要求不重复执行；持续要求补充未指定部分，明确矛盾报具体分镜，不擅改确认稿。

原有内部指定版本 API 保留：提供 basePlanVersion、otherRequirements、dataList，引用同任务成功 Analysis；指定成片修改同时提供 baseRenderRunId 和 revisionInstructions。它供已有内部调用使用，不是网页新增协议。未建立新的网页模式、制作计划登记或数据库表。

受理返回 HTTP 202：

```json
{"status":0,"msg":"已持久化受理","data":{"taskId":"示例任务","requestId":"后端UUID","runId":"执行UUID","stage":"analysis","state":"queued","planVersion":1}}
```

planVersion 在每个新受理 run 增长；resultVersion 只在成功发布 Render 后增长。

## 状态、取消和回调

- `GET /ai_video_director/tasks/:taskId`：返回 runs、latestSubmitted、current、latestSuccess。run 含 stage/state/planVersion/request/result/error 及可选 callback，不返回执行令牌和内部 checkpoint。
- `POST /ai_video_director/runs/:runId/cancel`，正文 `{}`：排队任务直接取消，活动任务进入 cancelling 并通知后台；云端已发请求按实际结果保留，不伪造撤销收费。
- `POST /ai_video_director/callbacks/:eventId/retry`，正文 `{}`：只重投通知，保持原 eventId 和 payload，不重做视频。

执行状态：queued、running、recovering、unknown、cancelling、cancelled、failed、succeeded。通知状态独立：pending、retrying、delivered、dead_letter。unknown 阻塞同任务后续执行，不凭超时重做。

服务根据阶段回调 `<CALLBACK_BASE_URL>/ai_video_director/getAiVideoEditingAnalysisDataCallback` 或 `getAiVideoEditingDataCallback`。正文含 schemaVersion/eventId/taskId/requestId/runId/stage/state/planVersion/basePlanVersion/baseRenderRunId/resultVersion/status/data/error。成功 status=0，其余为 1；部分字段按阶段可缺省或为空。

Analysis 网页回调的 dataList.content 保留可见标签，dataInfo 沿原模板及估时信息返回；不要求网页持久化和回传内部版本或来源信息。

请求头：`X-Event-Id`、`X-Callback-Timestamp`、`X-Callback-Signature`。签名为 `HMAC-SHA256(CALLBACK_SECRET, timestamp + "." + 原始正文)` 的十六进制结果。接收方按 eventId 去重，以 HTTP 2xx 和 JSON 数字 `status: 0` 确认成功；字符串 `"0"` 不算成功。有限重试耗尽后死信，制作状态不因此回滚。

Render 成功的 data.dataList 为 N+1：首项 whole-video，随后为全部确认分镜，含 id/content/dur/durationSource=measured/url/extraData。extraData 保存种类、摘要、全局半开帧范围、宽高和 fps。媒体路径为 `/media/:taskKey/:runId/:序号.mp4`，支持 GET/HEAD/单段 Range；只有成功发布的 run 可读。

## 本插件的制作工具

| 工具 | 当前入参及边界 |
| --- | --- |
| read_runtime_release | 无参数，核对当前 MCP/Runtime 同版 |
| read_production_task | 无参数，读取会话绑定的 run |
| synthesize_speech | speechRequestId、segmentId、text、voiceRef、speed；可选 reuseJobId、reuseRunId。复用只接受同账号同任务 Render 的确定成功音频，参数与文件摘要必须匹配；省略 reuseRunId 时沿 baseRenderRunId 查找 |
| assemble_sentence_audio | assemblyRequestId、speechBatchRequestIds、planRef、expectedTimelineSha256。按当前人物范围核对句段和音色，合法无口播画面按明确时长推进；没有需配音片段时批次列表可为空 |
| verify_sentence_audio | timelineRef、speechBatchRequestIds、可选 renderRequestId。核验当前正文、人物、真实音色、音频归属与帧界；无口播仍检查结构和范围 |
| read_speech_job | speechJobId，只读当前 run 的原配音任务 |
| preview_template_frames | renderRequestId、frames，生成同一源码快照的实际静帧 |
| render_template | renderRequestId、timelineRef、checks；正式导出不传 ranges，服务推导整片和确认分镜范围；动态预览按实时 Schema 提供 ranges |
| read_render_job | renderRequestId，查询原任务，不重复提交 |
| search_motion_mechanisms | 本地词法检索，以实时 MCP Schema 为准 |
| read_motion_mechanism | 本地机制阅读，以实时 MCP Schema 为准 |

工具由后台会话绑定 runId 和令牌，客户端不能通过正文改成其他 run。配音和渲染均异步；unknown 只核查原任务，不换键盲重发。画面源码由当前工程作者完成，任务数据库和发布目录只能由服务写入。

## 失败与当前限制

参数错误返回 HTTP 400；基础引用或同键不同输入通常为 409；身份错误为 401/403；未就绪及未知连接为相应服务错误。错误正文为 status=1、msg、error.code，字段校验可含 error.fields。以实际原始响应判断，不把任何失败都解释成平台故障。

后台保存实际输入、结果 JSON Schema、阶段指令、thread/turn、插件证据和原始事件。主制作的完成通知必须匹配主 threadId/turnId，子代理完成不构成业务交付。发布和通知有独立检查点；收费未知结果不得自动重放。

从 0.1.3 起，healthz 用 configurationReady 表达配置与依赖文件检查，productionReady 在配置齐备但未完成能力探测时为 null，配置缺失时为 false；readinessScope 为 configuration_only。不再以配置存在冒充供应商认证及真实制作成功。对异常中断的会话续接仍采取保守 unknown；目前没有对终态失败 run 的通用复活接口。完整恢复故障矩阵、正式前端以及未列入部署记录的系统尚不能宣称验收通过。

## 本地候选 0.1.21 的内部职责拆分

本节描述本轮本地开发，不表示已部署。网页 Analysis/Render 提交格式保持现有合同。审片协议升级为 4：主 Codex 原生分派，`prepare_review` 指定检查项，`assign_review_work` 登记真实分派，主协调 `submit_review` 保存观察，`read_review` 读取状态；Worker 不启动审片模型。动态预览不再提交 `previewRequests`，仅使用实际 ranges 和可选 sourceDigest。字幕语义分页由作者提供，人物音色绑定来自模板 manifest。完整调用链、失败处理和验证见 [拆分开发验证](20261015Codex与Worker效果职责拆分开发验证.md)。
