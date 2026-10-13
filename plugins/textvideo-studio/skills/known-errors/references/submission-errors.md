# 参数拒绝、版本冲突与未知结果

## 先区分技术错误和创作问题

`inspect_asset` 返回 `diagnostics.status=partial|unavailable` 是带有效证据与缺口的正常审阅结果，不按通用工具报错停工。依据 `diagnostics.recovery` 分流：`diagnostics.recovery=inspect_available_evidence` 把实际图片、代理与失败位置交原素材作者决定下一步；`diagnostics.recovery=select_another_candidate` 暂不采用当前候选，继续正常搜索与获取；`diagnostics.recovery=report_platform_failure` 才停止受影响步骤并报修，其他无依赖工作继续。`issues[].owner=source|capability|unknown` 分别表示该素材/范围不可用、解码能力限制、原因尚不确定；空输出与超时不能证明原视频损坏。未生成连续代理的 range/dense 不得凭截图宣称正式选段审阅通过。`sideEffects=review_cache_only` 如实表示缓存写入，不是下载/生成重试许可，不改 Asset 状态或视频 Revision。`not_ready` 等待媒体分析；真正的工具调用错误、非法输入和未知写入结果仍沿原合同处理。

字体未收录与替代统一沿[字体可用性与替代](../../remotion-production/references/submission-and-recovery.md#字体可用性与替代)，不在错误方法中另立用户确认流程。输入拒绝与已经执行的任务按原始诊断区分；已登记文件损坏先定位，仅确认平台 Bug 阻断时才报修。

素材获取故障修复并确认部署后，先读回候选和旧 Job；仅明确 `failed` 且未登记素材时，可通过 `acquire_media_asset` 使用新幂等键恢复原候选。平台重新核验当前技术条件，旧失败 Job 不改写；执行中或结果未知时不得恢复提交，人工拒绝也不能用此路径覆盖。

技术错误有明确状态或合同，例如 Revision 冲突、Schema 409、文件损坏、Job 失败、Asset 不可读、Remotion 渲染异常。创作问题是语义不完整、B-roll 无关、节奏单调、字幕竞争和 Scene 像 PPT。不要把所有问题都放进 known-errors，也不要用重试处理审美问题。

## Revision 过期

项目默认24fps不再表示无法改成30fps。先读实时工具表与 `timeline.fps`，使用 `preview_project_frame_rate_change` 核对报告，再经 `set_project_frame_rate` 正式提交。`PROJECT_FPS_PENDING_JOB` 要求对账相关未终态任务；`PROJECT_FPS_RANGE_COLLAPSED` 等错误定位实际短范围和切口，不偷偷丢片段或修改原件。分数帧率尚未支持，需明确规格范围。`OUTPUT_FRAME_RATE_MISMATCH` 表示实际 Preview/Export 的帧率或帧数不符合固定Revision，按平台工单处理，不用旧文件冒充新输出。

症状：写入基于旧 `base_revision_id` 被拒绝。处理：重新 `read_project` 和目标对象，查看其它修改与 Impact，重新判断原操作是否仍成立，再基于新 Revision 提交。禁止简单替换 Revision 数字后重放。

## Project 未定位或对象不存在

先 `list_projects` / `target_project`。对象 ID 来自当前 Revision；旧 Scene、Cue 或 Item 可能已被删除。不要用名称猜 ID，也不要创建一个“差不多”的新对象掩盖引用失效。

## Job succeeded 但输出缺失

这是失败，不是成功。检查 outputs kind、downloadUrl、MIME、文件大小和本地注册。文本工作流读取 text，不寻找文件；音视频要下载并校验。HTML 错误页不能当媒体。

## 结果未知的通用规则

稳定 MCP 连接在已部署 Runtime 通过发行摘要与健康核验后，才会在两次调用之间切换业务进程。新连接按输入、输出与行为合同检查变化；说明文字仍发送目录更新通知，但不把说明变化误当参数变化。输入约束、默认值、输出结构和 readOnly 等行为提示变化仍须刷新。

`MCP_TOOL_SCHEMA_CHANGED` 表示该次未执行：有宿主工具刷新能力时重新读取实时表并判断参数；没有刷新能力或实际重读后仍是旧表时，报告独立 Repair Ticket，由修复任务处理兼容发行或连接更新，不能反复发同一写入。结束活动轮再续办不保证刷新，已运行旧连接的外壳代码也不会因安装新版自动替换。不能只因 Release 同版就认定工具表已刷新，也不能为通过而跳过实质参数保护。`MCP_CALL_CANCELLED` 表示排队期间取消、未执行；`MCP_CALL_OUTCOME_UNKNOWN` 不表示失败前没有写入，必须按下面的对账规则处理。部署切换后仍需重新读取当前 Project/Revision，并由原剪辑任务确认 Repair Ticket；保留了项目定位不等于保留了当前 Revision。

`Transport closed` 表示宿主到连接管理层本身已经断开，不能通过重复提交写操作恢复，也不能声称后台 Runtime 健康就代表这个任务已经接上。修复任务应使用宿主支持的会话恢复机制，并以原任务的真实调用作为恢复证据。

```text
先读 Job
→ 读 Project/Revision
→ 查目标对象和本地文件
→ 判断是否已有副作用
→ 仅在当前合同明确允许的纠正或恢复分支继续
```

不要把“没有收到响应”当“没有执行”。

## 常见错误代码与归属示例

| 情况 | 首先检查 | 返回负责人 |
|---|---|---|
| `PROJECT_NOT_TARGETED` | Project ID / target_project | project-basics |
| Revision conflict | 当前 Revision 和并发修改 | 原专项重新判断 |
| `UNSUPPORTED_MEDIA` / media failed | 扩展、MIME、ffprobe、编码 | asset-import |
| Bridge 409 | Workflow Detail 与新 Schema | transcription / voice / provider |
| `PREVIEW_NOT_READY` | Job 类型、状态、Revision | web/quality |
| `COMPOSED_FRAME_EXTRACTION_FAILED` | Preview 文件、帧范围、ffmpeg | preview runtime |
| `PROJECT_GRAPH_INVALID` | 悬空 Story/Scene/Item/Cue | Application + 原负责人 |
| 旧版 `EDITORIAL_REVIEW_REQUIRED` | 当前发行已取消 AI 审阅导出依赖；核对 Runtime/MCP 版本 | 平台修复 |
| `REMOTION_EXPORT_FAILED` | Runtime、Asset、字体、组件 | remotion/export |
| B-roll 无关 | 不是技术重试问题 | visual-treatment/cutaway |

具体错误名称以当前代码为准，表格用于分类思路。

## 不允许的恢复

- 删除数据库行让错误“消失”；
- 将 failed Job 改成 succeeded；
- 使用旧 Preview/帧冒充新证据；
- 伪造审阅通过；
- Remotion 失败时交付只含主轨文件；
- 工具缺失时伪造返回；
- 创作问题反复重试同一技术任务。

## 交接

技术错误恢复后返回原主工作流或专项 Skill，让其重新判断结果是否仍符合创作意图。已恢复不代表质量通过；必要时重新 Preview 和审片。

## 参数拒绝与原始错误证据

`manage_effect_cues` 的 `CUE_OUT_OF_SCENE` / `INVALID_CUE_RANGE` 若同时返回 `stage=validation`、`sideEffects=none`、`safeToRetry=true`、`recovery=correct_input`，表示范围检查发生在 Revision 保存前。读取返回的 `sceneId`、`sceneRange`、`requestedRange` 和字段依据，并核对当前 Revision；交回原作者修订完整放置参数后纠正一次，不原样重放。`covered_narrative_beat_ids` 只声明内容覆盖，不扩大所属 Scene。完整 ManagedMotion 要有能容纳完整时长的 Scene，不能由主任务擅自截短作品、拆件或扩大原场景。旧版 unknown、版本冲突、保存失败和未知异常不获得此许可，仍走报障与对账。

受管作品的源码诊断区分名称与读取：`<RuleLine top={148}/>` 是合法属性传参，`top={window.top}` 的值仍是禁用全局访问。不要为了消除平台误判要求作者把合法属性改名。`work.source` 拒绝只有同时提供 `stage=validation`、`sideEffects=none`、`safeToRetry=true`、`recovery=correct_input` 以及行列、原因和纠正依据，才可回交原作者修订并提交一次；这些字段表示提交层确认尚未创建 Job，不表示原样自动重试。诊断与合法语法矛盾时报告平台工单，重复拒绝先诊断，确认平台 Bug 阻断后才报障。Worker 编译复用同一校验器，但任务已经入队，其源码错误没有提交前重试许可；读取失败 Job 与诊断后走修复和对账。字体沿上述单一字体方法处理。

调用结果先检查 `isError`，保存完整文本后再按实际内容解析 JSON；协议层 Schema 拒绝可能只有文本，解析失败不得覆盖原始错误。参数拒绝、业务冲突、运行故障和写入结果未知分别记录。仅明确 `stage=validation`、`sideEffects=none`、`safeToRetry=true`、`recovery=correct_input` 并指出字段纠正依据的参数拒绝，允许按实时 Schema 纠正后提交一次；不重放原请求，重复拒绝先诊断，确认平台 Bug 阻断后才报障。协议层文本拒绝必须核对实时 Schema 和当前 Revision，确认未进入业务执行后才能纠正。此例外不允许重试已创建的下载、生成 Job、运行失败或结果未知，不更换幂等键绕过。字体选择沿上述单一字体方法。
