---
name: project-basics
description: 在任何 VideoFlowCut 项目读写前建立完整运行合同：发现 MCP、定位 Project/Timeline/Revision、理解对象边界、处理并发与结果未知，并把结构、预览、最终文件和交付状态分开。
---

# 项目定位与操作边界

任何 VideoFlowCut 项目读写前，发现当前实际 MCP 工具及 Schema，读取已连接 Runtime 版本；用 `list_projects`、`target_project`、`read_project` 定位真实项目、Revision、Timeline、目标对象、素材与未结束 Job。不凭名字猜 ID，不因用户只改局部就新建整片。

尚无项目时记录这个事实，由导演提出明确建项参数，主任务创建后读回真实版本。恢复原任务优先续接原项目、当前稿和既有负责人。视频创作从 [协调入口](../production-coordinator/SKILL.md) 调度。

不熟悉对象关系或本次操作涉及依赖、就绪、stale 时，读取 [项目模型](references/project-model.md) 对应章节；Project、Sequence/Timeline、Asset、Story、Script、Scene、Cue 与 ExportArtifact 不混用。当前代码存在的能力不等于本会话已发布能力。

实际提交或 Job 恢复时，主任务读取 [写入与恢复](../production-coordinator/references/project-writes.md)。带当前 `base_revision_id`，写后读回版本、目标与影响；异步任务按其真实合同排序。结果未知先对账，不简单换版本或幂等键重放。

剪辑只使用已发布 MCP，不改平台代码或绕过接口。暂时连接失败、服务停止与原因未知先只读诊断并按已有授权恢复；只有确认平台/服务自身 Bug 且阻断当前工作才报独立 Repair Ticket。返回真实项目事实、输入版本、目标范围、可用与待处理事项；协作沿 [唯一交接约定](../_shared/PROJECT_REVISION_AND_HANDOFF.md)。
