# 模板演出与机制操作

新建或实质重构动画时完整读取[连续演出](../../motion-brief-writing/references/performance-design.md)、[机制需求与组合](../../motion-case-library/references/mechanism-design.md)及[时机方法](../../effect-timing/references/timing-design.md)。复杂场面按[执行稿结构](../../motion-brief-writing/references/execution-brief-template.md)写同一稿。既定改字、改色或小偏移继续原设计，仅复核受影响部分。

当前模板只提供本地词法 search_motion_mechanisms 与 read_motion_mechanism。首次通常取 3 个候选，核读入围 1～2 项，已有 ID 直接定位。需要空间分镜时传 include_storyboard=true；静态图不能证明速度或声音。具体参数读取当前 MCP Schema，不调用向量或整片资料能力。

采用在当前稿保存真实 ID、source_sha256、完整对象映射、保留关系、舍弃外观、补做接点和实际观察范围。检索结果不等于演出完成。无结果先调整关系描述与软筛选；仍无匹配如实记录缺口，作者完成本片设计，不伪造编号。

五层模型应先建立整体，再随讲述理解前四层，最后转到应用层；允许提前建立与交叠，但不能把三个意思在第一秒同时演完后只等字幕。动作后长期只换字幕时按专业方法诊断后续发展；有表达作用的静止可以保留。
