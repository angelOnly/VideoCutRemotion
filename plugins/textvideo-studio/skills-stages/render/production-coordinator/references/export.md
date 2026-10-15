# 固定版本导出与完整交付

render_template 提交 renderRequestId、相对工程的 timelineRef、完整确认分镜 ranges、真实 checks 和 previewOnly。ranges 使用全局半开帧区间并保持确认 ID 和顺序，正式输出 previewOnly=false。具体策略从本 Run 实际配置读回，不由模型自行切换。

新策略由服务按确认分镜全局范围并行绘制，复用画面合成整片并处理连续音轨。全部范围连续覆盖整片，首镜包含开头包装，末镜含片尾；分镜均使用 wholeComposition 的全局时钟。旧作业沿其创建时固定策略恢复，不因新部署悄悄改切法。

服务统一排队、限制视频和全局并发，处理画面、音频与文件核验。read_render_job 只在恢复、异常或有决策需要时读取原作业；默认返回摘要与 deliveryPath，确需详情再传 details:true；readyFiles 仅含已核验文件，可以提前观察，全部成功才完整交付。原正式作业明确失败且快照可信时 retry_render_slices 仅恢复失败部分；unknown、取消或快照损坏按原诊断核查，不盲重放。

正式导出已受理且没有可独立推进的工作时，返回 {result:{kind:"await_runtime",renderRequestId:"原编号"}} 结束本轮；Worker 保存等待检查点并监听原作业终态，完成或异常后续接原线程。正常等待不反复调用 read_render_job，不发送最终交接，不另起作者或重新提交媒体。事件丢失、重启或结果未知沿原作业与检查点恢复，不能把存在线程 ID 当成已恢复成功。

静帧审查、已发现阻断问题的返修及受影响范围复查在正式导出前完成。媒体完整成功后读取 deliveryPath，将正式返回 delivery.json 保存为本 run/result.json，保持 task/run、输入/模板/源码摘要及整片加全部分镜文件清单。发布和回调由服务负责，不直接修改已发布目录。技术结果、实际视听范围与用户定稿分别说明。

最终交接返回 {result:{kind:"final",taskId,runId,inputDigest,resultPath}}。Worker 核对当前文件身份、完整性及媒体技术要求后发布，并在同一事务保存成功结果及通知事件。通知失败只重投原事件，不调用模型、配音或渲染；文件已发布与网页业务接受分别报告。

当前运行环境不要求连续观看或听审。未观察内容仅如实记入 checks，不创建 final 审片任务、不返回待审说明文件、不等待人工审核；检查记录中的未听审不影响正常发布。技术失败仍按真实诊断处理。
