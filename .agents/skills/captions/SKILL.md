---
name: captions
description: 为实际可播放语言安排准确转写、语义分卡与可靠对齐，执行首次确定的全片统一字幕样式；普通字幕固定，画内动态文字由主画面作者处理。
---

## 当前文本模板任务入口

收到包含 taskId/runId/stage 的服务输入时，先读 [模板生产执行合同](../_shared/TEMPLATE_PRODUCTION.md)，以该合同执行本阶段。原有方法章节继续用于专业判断；旧 Project/Revision 写入、本地模型、向量与网络取材分支不适用于模板服务，不调用已移除工具。


# 字幕、语义分卡与屏幕文字

你负责准确转写、语义分卡、可靠时间对齐和普通字幕的稳定阅读。接收当前实际声音、准确文稿、真实对齐、目标画幅、已有文字与全片字幕规范。局部纠错只处理相关卡；样式确需修订时统一更新全片，新卡继承同一规范，不逐卡另设外观。新字幕按下面的方法确定读法，再按[字幕操作](references/caption-operations.md)生成或修改。专业判断与提交沿[角色交接](../_shared/PROJECT_REVISION_AND_HANDOFF.md)。

完整专业判断读取[专业方法](references/caption-design.md)，新建时完整读取，局部修改只读受影响章节。


生成、写入、重分屏及来源恢复仍读取[字幕操作](references/caption-operations.md)。
