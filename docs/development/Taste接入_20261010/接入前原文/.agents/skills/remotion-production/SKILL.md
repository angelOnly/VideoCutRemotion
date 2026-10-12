---
name: remotion-production
description: 根据已采用的美术和演出实现受管 Remotion 作品，处理素材绑定、坐标与源时间、局部修订、提交和合成验证；设计尚缺时由原作者续接对应方法。
---

# 受管 Remotion 实现与修订

接收当前完整采用稿、实际素材、准确文字和声音、已有源码、目标 Scene 与前后接口。作者负责具体实现与修订，主任务负责正式项目写入、生成和渲染提交。

## 按修改范围进入

新建或实质重构场面，先读已经适配本片材料与美术的机制组合稿，包括真实对象、连接、共同坐标、源时钟与命名事件，不是几个编号。尚未形成则由原作者使用 [视觉美术](../visual-treatment-planning/SKILL.md) 和 [演出设计](../motion-brief-writing/SKILL.md) 继续深化，再写主要源码。优先在同一受管作品保持场面连续，不把参考指令贴进 Props，也不把机制描述当作已有源码。只改已有文字、颜色、位置或切口时直接查看当前源码与受影响参数，沿用原组合，不重新启动整片主线和案例检索。

写图片、真实视频、字体、Props 或命名事件前，读取 [受管组件合同](references/remotion-component-contract.md) 对应章节并核对实时 `read_motion_capabilities`。素材必须通过真实绑定，字体使用登记身份；不凭历史版本说明推断当前会话能力。

裁切、局部观察、附着标注或跨段视频接续，读取 [素材坐标与时间](references/material-space-and-time.md)，使用完整 cover/contain/fill、点映射和源时钟公式。修漂移或重播直接进入这里，不重新搜全库或重写故事。辅助数学函数在 [scripts/material-math.mjs](scripts/material-math.mjs)，不能假定受管 TSX 可导入本地模块。

提交、查询、Review、Cue 放置或异常时，主任务读取 [提交与恢复](references/submission-and-recovery.md)，固定当前输入和版本，获取真实 Job 与输出再读回影响。已结束失败、结果未知和无副作用参数拒绝分开处理，不重放不确定写入。

## 验证与返回

关键状态必须来自当前源码、素材和字体；动态与声音检查实际连续范围。构图与字形问题回美术，关键中途与注意交接回演出，漂移、重播、范围和绑定错误回实现。保留成立的选择，不因局部问题重新加载全部资料。

返回完整 TSX、Props、绑定、命名事件、放置参数、对应版本、失效范围和实际观察。记录真实未看未听部分；按 [角色交接](../_shared/PROJECT_REVISION_AND_HANDOFF.md) 续接原负责人直至交付。
