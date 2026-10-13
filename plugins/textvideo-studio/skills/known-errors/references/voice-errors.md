# 声音与Bridge工作流故障

## Bridge 409

工作流 Schema 已变化或不可用。重新读取 Workflow Detail，检查 available/reason，用新的 schemaVersion、fields 和 itemSlots 重建请求。不能只替换版本号而保留旧 field ID。

## run_id 丢失

ComfyUI 重启后旧 run 可能无法查询。检查本项目 Job、请求摘要、本地下载和目标 Asset。如果输出已下载并验证，不重复生成；任务无法恢复时核对当前 MCP 是否提供明确恢复入口；没有副作用本身不构成重提许可。对生成内容要记录新 run 和结果差异。
