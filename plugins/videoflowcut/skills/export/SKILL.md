---
name: export
description: 固定目标 Timeline/Sequence 与 Revision，区分 draft/delivery，检查质量和技术条件，异步导出并验证最终 Artifact；导出不修改创作状态，也不等同于用户批准。
---

# Draft、Delivery 与最终文件

## 主任务执行与专业审片

主任务负责固定 Revision、门禁与规格检查、导出提交、跟踪、最终文件读回和交付；按 [production-coordinator](../production-coordinator/SKILL.md) 管理执行。最终文件的表达、节奏、自然度和完整声画审阅交 `quality-verification` 审片子代理，主任务转录实际结果，不能用技术通过代替专业审片，也不能代替用户批准。创意失败回原专项或导演修订；本 Skill 不自行改稿、改时机或补设计。

## 导出是固定版本的交付动作

Export 读取一个不可变 Revision Snapshot，把它交给 Remotion Render Worker，并记录最终文件。它不应该在导出过程中自动修 Story、替换素材或调整效果。若质量门禁不通过，应返回负责人修复后产生新 Revision，再重新导出。

## Draft 与 Delivery

Draft 用于内部审阅、A/B 和技术调试；Delivery 用于对外交付。两者在技术条件满足后都可导出，不要求先有 AI 审阅、五轮覆盖或关闭全部 Findings。AI 未审或效果待复核如实提示，用户观看文件后决定是否定稿。

不要为了快速拿到文件把 Delivery 改成 Draft 后对外宣称完成。用途属于 Artifact 元数据和用户沟通的一部分。

Draft 仍受技术门禁约束，不用伪报动效或声音已审来取文件。草稿失败时只处理该用途的真实阻挡；现有完整 Preview 可以明确标记为内部待审预览，但不登记或宣称为 ExportArtifact。

## 导出前

确认 Project、目标 Timeline/Sequence、Revision、画幅、帧率、时长和编码规格。读取 QualityReport、EditorialReview、Preview Evidence、Asset/Provenance；使用 `run_render_preflight(revision,purpose)` 检查当前 Revision 的所有实际引用是否本地存在、可解码、字体/Mask/组件可用、Speech 与 Script 一致。Preflight 通过不替代真实 Preview、审片和最终文件验证。

导出阻挡来自确定性技术错误与用途不符，例如文件损坏/缺失、引用失效、版本错配、无法渲染。辅助审阅的遮挡、节奏、观感问题和缺少 Preview/Review 提供提示，不参与导出阻挡。

## 提交和跟踪

使用 `submit_export`，明确 revision 和 purpose，保存 Job ID，再 `track_job` 到终态。旧 Job 没有 purpose 时当前代码按 delivery 处理，防止绕过门禁。Remotion 失败会使正式导出失败，不会自动返回只有主轨的 FFmpeg 文件。

Job succeeded 后用 `track_export` 和 `read_export_artifact` 核对文件、目标 Revision、校验和哈希。`record_export_artifact_review` 只记录实际执行的一个或多个复核轮次，不必补齐五轮。人工定稿通过 `approve_export_artifact(artifact_id,file_hash,confirmed_by_user=true,note?)` 绑定用户实际确认的文件；调用前必须已有明确用户确认。缺少人工确认时交付文件并标明尚未定稿，不停在等待 AI 审阅，也不伪造批准。

## 最终文件验证

导出帧率来自固定 Revision 的 `timeline.fps`，不另外保存一套导出fps。项目改帧率后重新生成 Preview 与 Artifact，旧文件仍保留且不继承旧审片或批准。当前输出校验实测视频平均帧率与解码帧数，须匹配目标fps及完整/局部帧范围，结果读回 `fps`、`frameCount`；失败不发布可交付Artifact。作品自身fps可不同，合成按时间采样，不能把更高输出fps当成已新增原生运动细节。

检查文件存在且非零、容器可解码、视频时长与 Timeline 合理、画幅/帧率、音轨、头尾黑帧、缺帧、静音、关键画面和哈希。播放最终文件而不只播放 Web Preview，因为浏览器和 Render Worker 可能存在字体、解码和资源差异。

文件导出与人工定稿分别记录；用户观看后明确批准具体 Artifact，无需 AI 五轮报告。项目后续 Revision 不继承旧批准，新导出产生新文件和记录。

## 来源清单

导出保存实际使用素材的来源清单 SourceManifest，包括来源页面、Provider、作者、原始 ID、取得时间和文件哈希。来源记录用于追踪，不承担权利审核。

## Render Preflight 的检查范围

`run_render_preflight` 从目标 Revision 的 Timeline 反向遍历所有实际引用：源媒体、SpeechAsset、Mask、Effect AssetBinding、字体、Style和组件版本。素材库里存在同名可用文件不能证明当前引用正确。

Preflight 是当前 MCP 的独立步骤；仍需通过 Project/Asset/Quality/Preview 和最终导出试验覆盖其不能判断的语义、审美和完整观看风险。Preflight 结果、Artifact Review 和用户批准分别持久化，不能相互替代。

## 可重复性

Artifact 应记录 Project、Timeline/Sequence、Revision、Runtime/组件版本、规格、文件 Hash、时长、音轨和生成时间。对于生成/外部素材，还应关联 Provenance 和 Attribution。这样后续能解释用户批准的是哪一个文件。

## 导出规格

画幅、帧率、分辨率、编码、码率、音频采样率和声道由目标平台决定。第一版可以提供少量预设，不让 Agent自由组合未经测试的参数。预设也不能改变项目画幅而不重新检查布局。

## 失败后的行为

质量门禁失败不提交 Render；Render 失败保留日志但不发布临时文件；验证失败将 Job/Artifact标为失败或 degraded draft，不写“导出成功”；用户取消保留 Project，不删除已通过的旧 Artifact。

## 交接合同

输入是目标 Project/Timeline/Revision、purpose、规格、Quality、Preview。输出是 Job、固定 Revision 的 ExportArtifact、技术验证和已知限制。它不使 Story/Scene 失效。验证是最终文件技术检查、完整播放和批准记录。
