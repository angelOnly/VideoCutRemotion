# 专业知识恢复对照

对照基线为 `a128eee`（0.1.8）。下表记录维护源的去向；发行脚本按 manifest 的明确清单逐字复制，不在构建时删工具名或改写正文。`tests/fixtures/production-knowledge-baseline.json` 保存下列完整原段的 SHA-256（只计至少 80 字符的未改段落），测试逐段核对，接口适配段不伪称原文相同。效果是否成立仍需要真实作品连续看听。

| 原位置 | 唯一正文 | 处理与保留原段数 |
|---|---|---|
| `captions/SKILL.md` | `captions/references/caption-design.md` | 专业章节迁移，原位置改引用；旧操作保留原业务入口；9 个完整原段 |
| `voice-production/SKILL.md` | `voice-production/references/speech-performance.md` | 专业章节迁移，原位置改引用；旧操作保留原业务入口；8 个完整原段 |
| `effect-timing/SKILL.md` | `effect-timing/references/timing-design.md` | 专业章节迁移，原位置改引用；旧操作保留原业务入口；13 个完整原段 |
| `effect-timing/references/event-and-audio-binding.md` | `effect-timing/references/audio-placement-method.md` | 专业章节迁移，原位置改引用；旧操作保留原业务入口；2 个完整原段 |
| `motion-case-library/references/mechanism-retrieval.md` | `motion-case-library/references/mechanism-design.md` | 专业章节迁移，原位置改引用；旧操作保留原业务入口；10 个完整原段 |
| `motion-brief-writing/references/performance-design.md` | `motion-brief-writing/references/performance-design.md` | 保留完整参考，仅调整旧操作链接；23 个完整原段 |
| `motion-brief-writing/references/execution-brief-template.md` | `motion-brief-writing/references/execution-brief-template.md` | 保留完整参考，仅调整旧操作链接；10 个完整原段 |
| `visual-treatment-planning/references/art-direction.md` | `visual-treatment-planning/references/art-direction.md` | 保留完整参考，仅调整旧操作链接；37 个完整原段 |
| `visual-treatment-planning/references/art-directions.md` | `visual-treatment-planning/references/art-directions.md` | 保留完整参考，仅调整旧操作链接；11 个完整原段 |
| `remotion-production/references/material-space-and-time.md` | `remotion-production/references/material-space-and-time.md` | 保留完整参考，仅调整旧操作链接；21 个完整原段 |
| `remotion-production/references/remotion-component-contract.md` | `remotion-production/references/deterministic-motion.md` | 专业章节迁移，原位置改引用；旧操作保留原业务入口；2 个完整原段 |

## 接口调整与排除

- 字幕：保留阅读单位、声音单位、观看单位的区别，语义分卡、换行、固定字幕、字形与实际复核；将旧 Caption/token 工具承诺改为当前运行合同。模板无可靠 captionTiming 仍一段音频一张卡，不新建时间表。
- 配音：保留自然边界、过短与过长的两面判断、列表实例及四轮回听；不发行本地音色、旧生成字幕、Script/reconcile 写入和未发布停顿参数。模板使用现有批量配音身份及恢复规则。
- 时机：完整保留提前建立、共同落定、事后回应、持续参照与数字、列表、比较、因果实例。旧 Cue/Revision 写入字段只留原操作文件；专业参考使用动作、版本与可靠时间证据。
- 机制：完整迁移需求转换、对象映射、顺序/并行/嵌套/交叠连接与删外观保留关系的方法。旧向量召回、整片理解、历史工程与库维护操作不进入模板发行；现服务只使用实际词法工具。
- 美术、演出和实现：完整保留中文排印、六种美术方向、材质、危险中途、动作性格、完整演出结构、cover/contain/fill、源时间、Hermite 和确定性方法；将专业文件中的旧写入链接改回运行合同。开发到生产的旧源绑定诊断移回 submission-and-recovery，不发行该操作文件。
- 模板原有 visual/motion/audio 精简教学改为专业源路由与服务差异；没有维护第二份同义专业正文。其他业务入口继续引用同一方法，旧业务的操作文件仍保留。

## 角色读取与验证边界

manifest.roles 登记主协调、导演、视觉、声音/字幕和审片者的入口、完整必读参考与条件参考；新建与局部修改的区别由对应入口说明。发行校验核对角色引用、阶段闭包、路径边界、专业源唯一映射和字节一致。实际线程发现、实际正文读取与继承历史是运行时证据，不能用 manifest 配置代替实测；候选发行不代表已部署或新作品已验收。
