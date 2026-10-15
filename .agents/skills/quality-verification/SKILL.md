---
name: quality-verification
description: 读取当前 Revision 的项目结构、真实 Preview、最终 Artifact 和视频类型规则，按需执行五轮专业观察、定位根因并回派修订；技术与用途按当前合同检查，AI 审阅不代替用户对具体文件定稿。
---

## 当前文本模板任务入口

收到包含 taskId/runId/stage 的服务输入时，先读 [模板生产执行合同](../_shared/TEMPLATE_PRODUCTION.md)，以该合同执行本阶段。原有方法章节继续用于专业判断；旧 Project/Revision 写入、本地模型、向量与网络取材分支不适用于模板服务，不调用已移除工具。


## 当前模板的主题审片

模板审片按 [当前审片合同](../_shared/template-production/references/review.md) 由主协调通过宿主原生代理分派。审片者只读明确检查包和实际媒体，回传目的、证据、观察、问题与未知；主协调使用 MCP 保存结果，不由 Worker 启动独立模型会话。静帧、连续画面、声音和完整声画证据分别说明，不能互相代替。复查和复用由 Codex 根据真实影响判断。

# 审片与交付核验

接收当前 Revision、真实对象、可访问 Preview/Artifact、目标范围和实际已看已听记录。结构、文件、专业观察和用户认可分别记录，工具成功或案例相似度不能证明作品好看。

专业审片时读取 [观看与返修](references/professional-review.md) 中本片类型和当前问题部分，连续观察前后语境，定位内容发展、素材契合、构图、中途、阅读、声音与切口。静帧仅证明相应状态，未听到的声音不写通过。按具体原因交原作者修订，跨段问题交导演。

核对输出文件、对象依赖或准备导出时读取 [技术交付](references/technical-delivery.md)。需要区分 ready、stale、证据不足与交付状态时读取 [证据状态](references/evidence-status.md)。可选审美意见不扩大成一律禁止导出的门禁。

返回版本、真实观看范围、观察方式、定位到对象/时间的问题、严重程度与返修责任。已有材料观察持续承接，依赖变化只复看受影响部分。独立审片由主任务真实分派，保存审计由主任务执行；遵循 [共享交接](../_shared/PROJECT_REVISION_AND_HANDOFF.md)。
