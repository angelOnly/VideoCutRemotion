# 模板文本生产入口

本入口用于含 taskId/runId/stage 的服务任务。运行时以本 Run 的阶段技能视图为准；仓库维护源位于 `template-production/`，本文件只路由，不另维护操作协议。

先核对 read_runtime_release 与 read_production_task 的实际发行和阶段。Analysis 只读取本 Run 输入、结果协议及已展开的模板文字合同，不加载制作源码、不调用生成工具。Render 依据当前完整确认稿和冻结模板制作，不从旧稿恢复已删除内容。

- Analysis：读取 [文字阶段入口](template-production/analysis.md)。
- Render：读取 [主协调入口](template-production/render/production-coordinator/entry.md) 和 [协调合同](template-production/references/render.md)。
- 声音与字幕：读取 [声音合同](template-production/references/audio.md)，自然分段、语义分页和演出由作者决定，服务核对真实音频、正文及范围。
- 审片：读取 [审片合同](template-production/references/review.md)。主 Codex 原生分派，审片者只读观察并回传，主协调通过 MCP 登记和保存；Worker 不启动审片线程、不决定固定检查目的或复查范围。
- 导出：读取 [交付合同](template-production/references/export.md)。正式范围由服务从冻结时间线推导；主协调完成创作并选定原作业后交出 await_runtime，Worker 完成技术校验、发布与回调。

旧 Project/Revision/Asset/Cue 工具不属于此模板服务。旧文件审片命令和 run/qa JSON 不再作为当前状态；审片状态通过 prepare_review、assign_review_work、submit_review、read_review 保存，原生代理身份由主协调真实分派后报告，不由记录字段自证。

只在本 Run 授权工程中修改。保持配音、媒体和分派的原身份；未知结果不换键重放，不伪造观察或交付。指定成片修改从明确基础版本的工程副本继续，真实差异交原作者；缺工程或证据时报告具体缺项，不能偷换其他版本。
