---
name: known-errors
description: 处理 Revision 过期、素材未就绪、Bridge 409、run_id 丢失、输出缺失、浏览器解码、Remotion、Mask、Preview、导出和结果未知等确定性错误；创作问题退回专业负责人。
---

# 按真实阶段处理故障

先保存完整原始返回，检查 `isError` 后再解析；文本 Schema 拒绝不能被 JSON 解析错误覆盖。区分参数拒绝、业务冲突、运行失败与写入结果未知，并读回当前对象和原 Job。

普通搜索未命中、素材不合适、理想字体缺失不是平台 Bug。服务停止或连接失败先检查状态，按根 AGENTS 已授权方式恢复；原因未知继续只读诊断。仅确认平台或服务自身 Bug 导致无法继续才报独立 Repair Ticket，同一根因沿用原单。其他无依赖工作继续。

- 参数、Revision、Schema、结果未知：读 [提交错误](references/submission-errors.md)，明确是否执行和是否有副作用，再决定当前合同允许的动作。
- 素材、解码、审阅证据、Mask：读 [媒体错误](references/media-errors.md)，依据实际范围与 diagnostics 分流，不能把部分证据或超时说成素材损坏。
- Bridge、run_id、声音工作流：读 [声音与Bridge错误](references/voice-errors.md)，先核对原任务与输出，不重复生成。
- 受管作品、字体、浏览器、渲染、导出：读 [运行错误](references/runtime-errors.md)，交对应原作者或修复任务，不修改校验来放行。

无副作用本身不是重试许可。只有实时合同明确允许的纠正或恢复分支才能继续；结果未知不得重放。恢复后返回原负责人确认依赖与预览，恢复成功不等于专业质量通过。
