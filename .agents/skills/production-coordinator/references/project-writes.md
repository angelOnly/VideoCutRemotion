# 项目提交、读回与恢复

主任务在正式写入、生成、渲染或保存审计前查本页。专业判断与完整交接沿[共同约定](../../_shared/PROJECT_REVISION_AND_HANDOFF.md)，各专项的具体字段以实时 MCP Schema和下方对应参考为准；这里不维护另一份完整工具清单。

## 一次提交的完整循环

先确认真实 Project、当前 Revision、目标对象与上下游依赖、未完成 Job，以及该修改是否已通过别处提交。对象选错时先查[项目模型](../../project-basics/references/project-model.md)，不把所有改动都塞进时间线。

主任务按原作者完整产物装配真实 ID与参数，不补创意。确定性项目写入携带当前 `base_revision_id`；异步接口按其真实合同使用 Asset、固定 revision 或幂等键，不能为形式一致虚构字段。新调用采用刚读回的版本，不能把新版本数字换进未重新确认的旧方案。

异步 Job 若会在完成时回写项目，依赖写入必须等其终态，再读回 Revision、目标对象和 Impact。按顺序发出请求不等于后台已按依赖完成。互不依赖的研究与设计可以继续，正式写入仍由主任务排序。

写后读回对象与 ImpactReport，核对改变、重算、stale、冲突和需要重做的范围；不能只看 success。取得对应版本的真实预览或声音后回原作者，跨段影响交导演。作品生成、独立作品观察、合成观察和整片交付是不同结论；技术检查与实际观看不可互相替代。明确参数的局部修改只核对受影响范围，不重跑整片创意。

## 失败与不确定结果

先检查 `isError`，保存完整原始文本，再按实际内容解析 JSON。协议层拒绝可能只有文字，解析失败不能覆盖原始错误。以下情况分开处理：

| 状态 | 下一步 |
|---|---|
| Revision 冲突 | 重读项目、对象与 Impact，把实际差异交原作者确认；不自动替换版本重发 |
| 超时、断连、提交结果未知 | 查询原 Job、Revision、Asset与已有输出对账；不换幂等键重放，也不把未收到响应当成未执行 |
| 明确参数拒绝 | 只有 `stage=validation`、`sideEffects=none`、`safeToRetry=true`、`recovery=correct_input` 且有字段纠正依据，才按实时 Schema修订后提交一次；不原样重放，重复失败先核对原因，确认平台 Bug 阻断后才报障 |
| 协议层文本拒绝 | 核对实时 Schema和当前 Revision，确认未进入业务执行后才纠正；未知结果不获得重试许可 |
| 已创建或已失败的下载、生成 Job | 读取原任务及诊断，只走当前 MCP明确支持的恢复分支；不套用提交前参数纠正规则 |
| 服务未启动、连接失败或原因未知 | 先只读诊断并执行已有授权的恢复；没有证据不能认定平台 Bug |
| 普通素材不合适、搜索无结果、创意不成立 | 回原作者调整策略，不报平台故障；只暂停受影响依赖 |

素材搜索的窄例外：正式错误同时提供 `sideEffects="none"`、`safeToRetry=true` 和恢复依据，才按服务目录纠正参数或等待 `retryAfterMs` 后再搜索一次；重复失败先核对原因，确认平台 Bug 阻断后才报障，不扩展到下载、生成和未知写入。详细诊断查[参数拒绝与未知结果](../../known-errors/references/submission-errors.md)。

只有确认平台或服务自身 Bug 导致无法继续，才调用 `report_editing_blocker`，沿已有同根因工单补充证据。不能为报障新建视频 Revision，不能改源码、配置、插件缓存或用脚本绕过 MCP。ComfyUI 的状态检查和指定启动方式沿根 AGENTS.md 的授权例外执行，不因单纯启动既有服务要求新版部署确认。

需要新版修复时，原剪辑任务重新连接 MCP，核对 `read_runtime_release` 的 Runtime/MCP releaseId与 Worker健康，再读当前 Project/Revision并调用 `acknowledge_repair_deployment`。旧会话不能确认新版。候选验证和部署由修复任务负责，仓库开发资料 `docs/development/motion-runtime.md` 保存候选验证与部署流程，剪辑任务不读取该开发流程代替正式工具。

## 按这次操作查对应资料

只读当前相关行，不要求全员预读全部参考。

| 本次操作 | 详细方法与合同 |
|---|---|
| 字体未收录、受管作品提交与完整范围放置 | [作品提交与恢复](../../remotion-production/references/submission-and-recovery.md)：原视觉作者按该文件的字体可用性方法修订，主任务核验并提交；范围或源码拒绝回原作者 |
| 搜索、下载、采用与源范围观察 | [素材取得](../../visual-asset-sourcing/references/acquisition-operations.md)、[源素材审阅](../../visual-asset-sourcing/references/source-review.md) |
| 原创文稿、原话剪辑与配音 | [文稿操作](../../semantic-continuity/references/script-operations.md)、[配音放置](../../voice-production/references/synthesis-and-placement.md) |
| 字幕生成与显示修改 | [字幕操作](../../captions/references/caption-operations.md) |
| 视觉计划、场面与辅助镜头 | [场面写入](../../scene-planning/references/scene-operations.md#当前项目写入)、[辅助镜头](../../cutaway-planning/SKILL.md)；从已明确设计映射字段，计划保存不代替实际放置 |
| 声音候选、轨道与混音 | [声音取得](../../sound-asset-sourcing/references/acquisition-and-analysis.md)、[声音操作](../../audio-finishing/references/audio-operations.md) |
| 人物主线与人物生成 | [人物时间线](../../presenter-motion-director/references/timeline-operations.md)、[人物操作](../../avatar-performance/references/actor-operations.md) |
| 项目帧率 | [项目模型的帧率变更](../../project-basics/references/project-model.md#改帧率时才读) |
| 预览、导出与文件核验 | [技术交付](../../quality-verification/references/technical-delivery.md)、[导出](../../export/SKILL.md) |

## 保存审计时才读

ProductionRun与SkillExecutionReport记录实际工作过程，不参与动画编译，不是第二份成片状态。记录实际用到的能力、决定、对象、证据及未完成项，不能用已加载Skill或工作单代替真实宿主调用。

`record_creative_decision` 的可选 delegation 使用 `{agent_id, assignment_id, role, input_revision}`；前两者为真实非空标识，role为director、specialist或reviewer，input_revision是当前Run所属Project的真实历史版本。保存后报告使用agentId、assignmentId、inputRevision等字段，产物继续关联现有objectIds/evidence。输入版本可早于提交后版本，但主任务仍需核对依赖。

这些字段不能认证真实宿主调用，也不证明当前负责人已接任或实际看过媒体；接替与迟到结果按共同交接约定核对。旧报告没有delegation可继续读，不能补造代理身份。
