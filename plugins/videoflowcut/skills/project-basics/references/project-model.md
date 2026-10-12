# 项目对象与依赖模型

当需要判断“这次应该改哪个对象、会影响什么”时读本页。项目启动沿[项目定位](../SKILL.md)，提交与失败处理沿[写入与恢复](../../production-coordinator/references/project-writes.md)，不在这里重复工具清单。

## 修改应落在哪一层

| 对象 | 保存什么 | 什么时候修改 |
|---|---|---|
| Project / CreativeBrief | 工程、画幅、受众、用途及用户锁定条件 | 改变整片目标或规格；区分锁定总长、实测声音时长和可调整的初稿节奏 |
| Asset | 原始或生成文件、哈希、来源、角色与处理状态 | 更换源文件或更新素材事实；同名文件不代表同一素材 |
| TimelineItem | 某份素材在时间线上的一次使用 | 调整这一次的物理播放关系；不自动改变其它使用 |
| Transcript / SemanticUnit / Script | 识别文字、完整思想、最终保留内容与顺序 | 删留或重排原话；标点产生的候选句不等于完整思想 |
| SpeechSegment / SpeechAsset | 配音生产单位及实际声音 | 改变要说的内容或声音；字幕时间以实际声音证据为依据 |
| Story | 讲什么、为何按这个顺序发展 | 修改论证或事件顺序 |
| Scene / VisualTreatment | 一段内容怎样被看见、主画面和内部状态 | 改变视觉任务与表达方式 |
| EffectCue / AssetBinding | 效果的一次放置、语义锚点、层级与素材绑定 | 调整效果时机或本次使用；受管作品内部内容改为新作品版本 |
| Caption / Audio / ActorPerformance | 屏幕文字、声音安排、人物表演及声音归属 | 分别修改字幕、混音或人物表现，不能一律靠移动效果解决 |
| Job / ProductionRun / Quality / ExportArtifact | 异步执行、过程审计、观察结论、固定版本的最终文件 | 查询执行与证据；它们不是第二份可编辑的成片 |

例如删一句口播，应先确认完整思想与 Script，再按影响修订声音、字幕和效果；只把已确定的对象向右移，不重建 Story。Story、Scene 与 Timeline 属于同一 Revision，不能各自维护互不一致的版本。

Asset 和它的一次使用必须分开：同一视频可在多处使用，替换源文件与替换一条 Cutaway 的影响不同。用真实 ID、哈希、状态和来源确认目标，不用文件名猜身份。源素材观察使用 Asset 的源时间；时间线放置使用成片时间，换算见[素材坐标与时间](../../remotion-production/references/material-space-and-time.md)。

## 依赖变化与证据范围

Revision 是项目事实版本。修改后读取 ImpactReport，确认哪些对象改变、重算、失效（stale）及哪些范围需重新预览。ID 存在并不证明语义仍成立：素材可能还绑定着有效句子，却已不适合改写后的意思。可确定的引用、范围与资源错误由技术校验发现；内容关系由原作者复核。

Job 成功只表示相应处理完成：转写成功不等于原话取舍已完成，预览成功不等于已连续观看，导出成功不等于用户认可。旧 Preview、审阅与 Artifact 只证明其所属版本，不能自动覆盖新修改。具体证据身份查[证据与交付状态](../../quality-verification/references/evidence-status.md)。

另做长短版或横竖版，需要当前能力支持的独立成片版本；不能用覆盖或回退冒充平行版本。`rollback_revision` 是基于当前版本恢复历史内容并产生新 Revision，旧文件不会随之改变。代码预留了对象，也不代表本会话已发布对应操作。

## 改帧率时才读

项目时钟保存于 `timeline.fps`，固定受管作品另有自己的时钟。当前创建合同支持15至60整数帧率、省略默认24；执行前仍查实时 Schema。原素材不因项目改帧率而重新下载。

先用 `preview_project_frame_rate_change` 检查真实时长、取整偏差、阻挡对象与重建范围，再由主任务以当前 `base_revision_id` 调用 `set_project_frame_rate` 并读回 Project/Impact。同值不增加版本。零帧短范围、源末端越界、无法保持的关系及相关回写 Job 未终态须先处理，不换版本数字重放旧方案。

变更后把差异交原作者，重新生成合成预览并复核声画；不因改帧率重做配音或伪造转写证据。旧作品审阅与同步预览属于原规格。纯帧位置可能量化，反复切换不保证精确恢复；分数帧率尚未开放，输出需核验实际 fps 与 frameCount。

## 按当前问题继续

- 素材是否可用、源范围如何观察：查[源素材审阅](../../visual-asset-sourcing/references/source-review.md)。审阅缓存不是素材采用，也不改变视频 Revision。
- 改动怎样提交、冲突如何处理：查[项目写入](../../production-coordinator/references/project-writes.md)。
- 版本和事实如何交给作者：查[角色交接](../../_shared/PROJECT_REVISION_AND_HANDOFF.md#代理角色与交接)。

## 明确创作偏好与工作台默认

工作台“创作默认偏好”只保存用户主动设置的讲述、视觉、运动、背景和声音要求，可全部清空。`create_project` 的 `brief.explicitCreativePreferences` 接收 `dimensions`（narration、visual、motion、background、sound）及 notes；只在新项目初始化时继承工作台默认，本次明确项优先。未指定项由导演判断，不要求用户选择风格。兼容 tone 与 narration 使用同一讲述口吻，allowHighDensityMotion 不作为机制协作或惯性的开关。

当前任务收到新明确要求时，主任务使用 `update_creative_brief(base_revision_id, brief)` 保存差异；explicitCreativePreferences=null 清空本任务偏好。保存不回写默认，不静默改已有作品、候选或在途 Job；将受影响内容续接原作者。导演自己的方向与依据使用当前完整稿和现有 `record_creative_decision`，不冒充用户偏好。实际执行前核对实时 Schema。
