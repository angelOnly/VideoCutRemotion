---
name: production-coordinator
description: 协调确认稿的 Remotion 动画制作，按真实职责分派、提交工具并接回结果。
---

# production-coordinator

本入口只处理 Render。Analysis 使用独立的文字阶段视图。

先读取当前冻结模板 renderer/renderer-manifest.json 及其 instructions 指定的制作说明，按模板确定人物、栏目包装、专属数据和检查步骤；这些业务约定不从通用技能或历史任务猜测。通用技能负责协调和专业执行方法。

先读 [基础事实](references/base.md) 与 [协调合同](references/render.md)；当前输入已完整提供的基础事实不重复读取。明确持续负责的导演，可由主协调兼任并读取导演方法；需要独立导演时真实分派，不额外建立只转述稿件的角色；确认稿已具备时让视觉、声音作者同时处理各自已具备输入的工作，不默认重写文案或取材。子代理不递归分派，只有主任务提交正式制作工具；主协调通过宿主原生代理分派审片，接回只读观察后使用审片 MCP 保存结果；Worker 不启动审片线程、不自动续派，审片者不修改工程。根据真实名额续接原作者，不能用审计字段冒充真实委派。

导演（含主协调兼任）保存完整稿的章节、场面及跨段关系；视觉按实际模板接口实现；声音按真实音频形成时序。每次交接只带当前完整稿引用、源码摘要、实际差异、职责和未完成事项。导演与视觉必须能理解完整内容，不能用摘要替代稿件。

进入检查时按需读 [检查与交付](references/review.md)；工具失败才读 known-errors。已有负责人继续受影响部分，不另建重复任务。

## 当前确认输入的采用边界

网页沿原接口提交可见分镜文本，服务在受理时解析本次标签并沿任务记录关联分析。request.dataList 的 submittedContent（存在时）保留用户提交原串，content 是实际台词，directing 是从本次文本重新计算的内部信息；网页不维护这些字段。以当前镜头集合、顺序、台词和标签为准，不从旧分析恢复删镜、旧句或被删标签。analysisInput 是原始两栏，analysis.context 是初次采用说明；已采用的替换指令不重复执行。otherRequirements 沿任务记录传入，持续要求补充未指定部分；明确矛盾时报具体分镜，不暗改请求。没有指定人物时沿模板安排，不按问句猜已指定人物。

指定 speechTurns 按人物边界拆现有自然句段，保留 turnId，segmentId 继续作为 utterance.id；不跨人物、不按问号猜角色。visualDirections 与 chapter 交视觉作者，绝不拼入 TTS。kind=visual 只用明确画面与 durationSec 推进，不能从配音失败推断无口播。
