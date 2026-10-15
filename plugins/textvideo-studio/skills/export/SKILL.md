---
name: export
description: 提交固定版本的模板媒体导出、读取原作业并核对完整交付。
---

# export

读取 [导出合同](../production-coordinator/references/export.md)。主协调提交准确 task/run、renderRequestId、timelineRef、真实检查记录；正式分镜全局半开范围由冻结时间线推导；服务负责固定计算、并发额度、校验与发布。

只交付全部技术核验成功后的 1 个整片和 N 个确认分镜。readyFiles 可提前用于实际观察，但少量 readyFiles 不代表整任务完成。选定正式原作业后返回 await_runtime，成功由 Worker 直接读取原 delivery.json 交付，不复制 result.json；不能凭路径自行拼成功结果。

等待不改变作业身份；明确失败按原诊断与已发布恢复能力处理，未知结果不换键重放。技术交付、真实观察和用户定稿分别报告。
