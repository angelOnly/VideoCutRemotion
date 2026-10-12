# 受管运行、字体与导出故障

## 协调者、创意负责人和修复任务的边界

主任务按[协调入口](../../production-coordinator/SKILL.md)只读核对当前 Project、Revision、Job 和副作用。创意方案是否仍成立交回原子代理判断；本 Skill 中的“重新判断”不授权主任务补做创意。剪辑任务遇到工具或 Runtime 故障时暂停该步并诊断，只有确认平台或服务自身 Bug 且无法继续才提交独立 Repair Ticket，环境和源码修复交独立修复任务。本 Skill 后文的重提、修复和恢复方法均受[运行合同](../../production-coordinator/references/project-writes.md)约束：需要部署修复时，原剪辑任务重新连接并确认部署后，才由主任务基于重新读取的事实提交；没有副作用本身不构成重试许可，结果未知不得重放。

素材搜索错误以结构化 `code`、`stage`、`recovery` 和副作用信息定位。`ASSET_PROVIDER_UNKNOWN` 是名称无效，先读 `list_asset_providers`；`ASSET_PROVIDER_NOT_CONFIGURED` 才是已知服务未启用。只有 `sideEffects="none"` 与 `safeToRetry=true` 同时成立且有具体纠正依据时，主任务可纠正参数或等待限流时间后再搜索一次，重复失败先诊断原因，确认平台 Bug 阻断后才报障；这项搜索纠正不适用于下载、生成、项目写入或结果未知。`ASSET_NETWORK_TIMEOUT` 等环境故障先按已有授权恢复与只读诊断，不能单凭超时认定服务 Bug，不能在剪辑中改代理配置。部分候选的 `diagnostics.complete=false` 不等于空结果；保留已得候选和警告，不复用其作为完整搜索结论。

## 浏览器和 Render Worker 不一致

检查是否使用同一 Revision Snapshot、资源路径、字体、编解码器、画幅和 Runtime 版本。浏览器正常而导出失败时，不用浏览器截图冒充最终 Artifact；修复环境或资源。

## Remotion 组件失败

受管字体先查询 `read_motion_capabilities`，使用 `fontBindings` 与平台注入的 `props.fonts`。`MOTION_IMPORT_REJECTED: useEffect/useState/delayRender/continueRender` 若来自字体加载代码，由原作者按已发布合同改写；不能只删第一个导入后继续使用浏览器全局。`MOTION_FONT_UNKNOWN` 先核对实际目录；已登记文件缺失、变化、加载失败或超时属于平台修复范围，失败不替换绑定字体、不生成半件 Asset。`MOTION_FONT_CACHE_CORRUPT` 表示完整作品字体副本或绑定损坏，不静默重生覆盖。没有字体文件加载错误，不应把字形覆盖或排版问题扩大成Runtime崩溃。

新受管视频按videoBindings源毫秒半开范围、作品startFrame/endFrame及fps检查，帧数以endFrame-startFrame为准，允许1毫秒取整与不足一帧余量；不匹配时Schema拒绝创建Job。调整选段或作品范围后提交经确认的新版本，不加源码偏移掩盖差值。MOTION_VIDEO_SOURCE_SHORT保留实际源证据，由修复任务核查PTS与边界，不冻结末帧。TimelineVideo读取作品根时钟，Sequence只改变显示与布局。历史产物可读，旧引擎重新生成返回MOTION_ENGINE_UPGRADE_REQUIRED，须按新合同提交。MOTION_DISK_SPACE检查真实空间与安全余量；MOTION_VIDEO_WORKING_SET检查单块工作区配置，不以累计解码512MiB要求导演拆件。MOTION_VIDEO_CHANGED会使解码缓存失效，防止恢复原片后误用错误帧；剪辑任务仍沿Repair Ticket报障，不自行修改平台。

动画Job失败时读取track_job.error与result.diagnostic的实际错误码和信息；成功后读取Asset、固定版本及videoDecodes，不把缓存统计或临时帧当成可交付作品。候选实现新增track_job.result.motionProgress的stage、currentFrame、lastCompletedFrame和lastProgressAt；必须核对实际部署后读取，不能从updatedAt续租心跳推断进展。失败报告在result.motionFailure中保留首次异常栈、附加错误、浏览器事件、退出状态和reportPath，运行诊断独立于素材和Revision。

`MOTION_NONDETERMINISTIC` 先读取 `track_job.result.motionDiagnostics`：其中 `reportPath` 指向包含具体帧号、可见差异幅度和区域的 JSON，`differences[].paths` 相对于报告目录，分别保存首次画面、重复截图和放大差异图。失败证据独立保留，临时帧缓存清理，不创建作品 Asset 或视频 Revision。哈希不同会继续比较黑、白背景上的合成像素；每个通道最多两个色阶的差异标为 `tolerated` 并允许生成待审代理，超过则失败。不能只看全图平均差异忽略局部丢字，也不能把 tolerated 当作审美通过；缓存文件完整性仍要求哈希完全一致。剪辑任务遇到失败先核对原因；确认平台或服务自身 Bug 且无法继续才提交独立 Repair Ticket，由修复任务依据对比证据定位，不重放写入或自行放宽检查。

候选渲染器对内部 index.html 的“but got no response”最多恢复两次：这是并发导航的 CDP 响应事件竞态，每次仍须完整渲染成功。持续失败保留 Job 诊断，不由剪辑任务重放写入；资源、安全、内容和外部生成错误不走该恢复。

先区分 Props/AssetBinding 错、组件 Bug、局部时间错误、资源不可读和布局问题。生产任务使用 Registry 或受管作品；平台组件开发失败不能绕过受管链执行未审核代码作为 Fallback。组件修复后需要 Registry/Golden/Player/Render 回归。

## Export 失败

导出条件失败时先查看该 purpose 的技术阻挡；AI 审阅缺失或待复核不阻挡制作和导出。Render 失败时查看日志和 Asset；文件技术验证失败时保留临时诊断但不发布。禁止静默交付只有 A-roll、缺字幕或缺动效的降级文件。

## 日志和用户沟通

历史 Repair Ticket 先按工具、错误码、Release、Job 和根因审计；没有 Job 关联不等于平台缺陷，Job 后来成功也不等于原报告已经处理。平台缺陷沿候选验证、正式部署、原报告剪辑任务重连确认的路径收口。正确输入拒绝、重复报告或宿主外部恢复，由修复者接手后调用 `resolve_repair_ticket_without_deployment`，明确分类和证据；不能以此替代真正需要部署的修复，也不能批量按状态猜测关闭。

用户需要知道发生了什么、是否产生副作用、下一步是什么；不需要看到无法行动的长堆栈。内部日志保存 Project、Revision、Job、run_id、工具、错误码和资源，但避免泄露密钥和敏感本地内容。
