# 固定版本导出与完整交付

render_template 提交 renderRequestId、相对工程的 timelineRef、完整确认分镜 ranges、真实 checks 和 previewOnly。ranges 使用全局半开帧区间并保持确认 ID 和顺序，正式输出 previewOnly=false。具体策略从本 Run 实际配置读回，不由模型自行切换。

新策略由服务按确认分镜全局范围并行绘制，复用画面合成整片并处理连续音轨。全部范围连续覆盖整片，首镜包含开头包装，末镜含片尾；分镜均使用 wholeComposition 的全局时钟。旧作业沿其创建时固定策略恢复，不因新部署悄悄改切法。

服务统一排队、限制视频和全局并发，处理画面、音频与文件核验。read_render_job 只读取原作业，waitMs 最长 60000 并用 afterDigest 等待实际变化；默认返回摘要与 deliveryPath，确需详情再传 details:true；readyFiles 仅含已核验文件，可以提前观察，全部成功才完整交付。原正式作业明确失败且快照可信时 retry_render_slices 仅恢复失败部分；unknown、取消或快照损坏按原诊断核查，不盲重放。

完整成功后保存正式返回 delivery.json 为本 run/result.json，保持 task/run、输入/模板/源码摘要及整片加全部分镜文件清单。发布和回调由服务负责，不直接修改已发布目录。技术结果、实际视听范围与用户定稿分别说明。
