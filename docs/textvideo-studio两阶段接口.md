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

Analysis 下载并冻结 `GET <CUSTOM_TEMPLATE_API_BASE_URL>/api/custom-templates/3/package` 返回的 ZIP。阶段只产出文字分镜和 estimated 时长，拒绝配音和渲染。dataList 内容按序拼接必须逐字等于输入 content。内部 context 为非空 Markdown 字符串。

`POST /narrate/ai_video_director/getAiVideoEditingData`

```json
{
  "taskId": "示例任务",
  "basePlanVersion": 1,
  "otherRequirements": "本次完整生效要求。",
  "dataList": [
    {"id": "scene_001", "content": "第一句。"},
    {"id": "scene_002", "content": "第二句。"}
  ]
}
```

basePlanVersion 必须引用同任务成功 Analysis，可以引用历史成功版本。当前 dataList 和 otherRequirements 完整生效，不拿旧稿替换。分镜 ID 为 1～80 位字母、数字、下划线或连字符，必须唯一，不能使用保留值 `whole-video`；分镜数量 1～200。

指定成功成片修改时额外同时提供 `baseRenderRunId` 和非空 `revisionInstructions`。基础成片必须同任务、同 Analysis 且成功；服务复制其可校验工程快照。未受影响音频可显式复用；旧成片不会被覆盖。失败工程不能冒充成功修改基础。

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

请求头：`X-Event-Id`、`X-Callback-Timestamp`、`X-Callback-Signature`。签名为 `HMAC-SHA256(CALLBACK_SECRET, timestamp + "." + 原始正文)` 的十六进制结果。接收方按 eventId 去重，以 HTTP 2xx 和 JSON 数字 `status: 0` 确认成功；字符串 `"0"` 不算成功。有限重试耗尽后死信，制作状态不因此回滚。

Render 成功的 data.dataList 为 N+1：首项 whole-video，随后为全部确认分镜，含 id/content/dur/durationSource=measured/url/extraData。extraData 保存种类、摘要、全局半开帧范围、宽高和 fps。媒体路径为 `/media/:taskKey/:runId/:序号.mp4`，支持 GET/HEAD/单段 Range；只有成功发布的 run 可读。

## 本插件的制作工具

| 工具 | 当前入参及边界 |
| --- | --- |
| read_runtime_release | 无参数，核对当前 MCP/Runtime 同版 |
| read_production_task | 无参数，读取会话绑定的 run |
| synthesize_speech | speechRequestId、segmentId、text、voiceRef、speed；可选 reuseJobId、reuseRunId。复用只接受同账号同任务 Render 的确定成功音频，参数与文件摘要必须匹配；省略 reuseRunId 时沿 baseRenderRunId 查找 |
| read_speech_job | speechJobId，只读当前 run 的原配音任务 |
| preview_template_frame | frame，生成当前工程实际帧文件 |
| render_template | renderRequestId、timelineRef、ranges、checks、previewOnly；ranges 含 id/fromFrame/toFrame，使用完整 Composition 的全局半开帧，正式导出自动追加整片 |
| read_render_job | renderRequestId，查询原任务，不重复提交 |
| search_motion_mechanisms | 本地词法检索，以实时 MCP Schema 为准 |
| read_motion_mechanism | 本地机制阅读，以实时 MCP Schema 为准 |

工具由后台会话绑定 runId 和令牌，客户端不能通过正文改成其他 run。配音和渲染均异步；unknown 只核查原任务，不换键盲重发。画面源码由当前工程作者完成，任务数据库和发布目录只能由服务写入。

## 失败与当前限制

参数错误返回 HTTP 400；基础引用或同键不同输入通常为 409；身份错误为 401/403；未就绪及未知连接为相应服务错误。错误正文为 status=1、msg、error.code，字段校验可含 error.fields。以实际原始响应判断，不把任何失败都解释成平台故障。

后台保存实际输入、结果 JSON Schema、阶段指令、thread/turn、插件证据和原始事件。主制作的完成通知必须匹配主 threadId/turnId，子代理完成不构成业务交付。发布和通知有独立检查点；收费未知结果不得自动重放。

从 0.1.3 起，healthz 用 configurationReady 表达配置与依赖文件检查，productionReady 在配置齐备但未完成能力探测时为 null，配置缺失时为 false；readinessScope 为 configuration_only。不再以配置存在冒充供应商认证及真实制作成功。对异常中断的会话续接仍采取保守 unknown；目前没有对终态失败 run 的通用复活接口。完整恢复故障矩阵、正式前端以及未列入部署记录的系统尚不能宣称验收通过。
