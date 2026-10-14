---
name: project-basics
description: 核对模板生产的 task、run、阶段、模板、工程和原作业身份。
---

# project-basics

读取 [基础事实](../production-coordinator/references/base.md)，先调用 read_runtime_release 和 read_production_task 核对本任务事实及能力。身份来自输入与正式返回，不从路径猜测。

确认当前阶段及固定模板、输入摘要；Render 的工程、时间轴和源码摘要共同确定可检查版本。服务冻结文件字节不表示模型已读取。工具结果先检查 isError，结果未知时沿原作业核查，不换键重放。只读事实与没有依赖的查询可以并行，正式修改、生成、渲染提交由主协调排序；排序提交不要求等待异步任务结束。
