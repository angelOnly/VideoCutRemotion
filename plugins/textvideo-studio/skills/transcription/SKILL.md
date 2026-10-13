---
name: transcription
description: 通过当前 FunASR Bridge 生成可追溯 TranscriptText 和候选句，核查高风险文字并交给 semantic-continuity；不把标点分句或估算时间伪装成 SemanticUnit 或 word_exact。
---

# FunASR 转写与文本证据

## 主任务执行边界

转写提交、事实回听纠错和时间精度核查可由主任务执行；标点候选不升级为剪辑选择，删留、重排、Take、停顿和新稿创作交 `semantic-continuity` 子代理。按 [production-coordinator](../production-coordinator/SKILL.md) 排序可能回写项目的 Job，读回实际文本、Revision 和 Impact 后把源证据交给子代理，不在主线程顺手优化表述。

## 转写的边界

转写回答“音频大致说了什么”，不回答“成片应保留什么”，也不自动给出剪辑切点。当前 FunASR 工作流公开完整文本输出，没有可靠 Segment、Token、说话人或词级时间。因此本 Skill 的责任是保存可追溯文本、发现识别风险、生成阅读候选，并把语义判断交给 `semantic-continuity`。

## 接口调用

每次正式任务先读取 `docs/asr接入.md` 和实时 Workflow Detail，取得最新 `schemaVersion`、fields、itemSlots 和 outputs。FunASR 输入一个音频文件，输出 `kind=text`。工作流保存或重建后 Schema 可能变化，不能长期硬编码当前 field 或 itemSlot ID。

调用链：

```text
已就绪音频 Asset
→ submit_transcription
→ track_job 到 succeeded/failed
→ 读取 TranscriptText、原始 Bridge 信息和错误
→ 读回 TranscriptSentenceCandidate
```

FunASR 不可用或用户提供了准确文稿时，可以通过 `apply_manual_transcript` 写入全文，但仍不能伪造时间。

## 高风险内容必须回听

人名、机构、地名、产品、数字、日期、比例、单位、否定词、因果和转折可能改变事实。中英文混说、专业术语、相似音和背景噪声也容易出错。模型可以提出候选修正，但应回听最小必要范围；不要为了让句子更通顺把说话者原意改成编辑者自己的表述。

当用户文稿、ASR、画内字幕和音频冲突时，保留各来源，标注冲突，再决定是修 Transcript 识别错误还是进入 Script 改写。两者属于不同操作。

## 候选句不是语义单元

项目可按标点生成 TranscriptSentenceCandidate，只是为了阅读和后续组合。一个完整思想可能跨多个候选句，尤其是“不是……而是……”“因为……所以……”“第一……第二……最后……”或省略主语的连续表达。相反，一个很长候选句也可能包含多个独立观点。

只有 `semantic-continuity` 基于上下文调用 `apply_semantic_units` 后，才形成 SemanticUnit 和 SpeechSegment。

## 时间精度

当前全文转写不提供词级时间。项目未来可以先用 VAD/静音切出具有真实源范围的 TranscriptChunk，再分别转写，但这只是 `chunk_coarse`。按字数、字符或标点平均分配音频时长不允许作为任何正式同步依据。

## 真人长素材与 VAD

长访谈或 Vlog 可以先在本地执行 VAD/静音切片，再将每个具有真实 Source Range 的 Audio Chunk 送给 FunASR。这样得到 `chunk_coarse`，有助于查找内容，但切片不能过短。若一段因果或句子跨越静音边界，语义 Skill仍要合并。

VAD 是物理声音证据，不知道说话者意图。沉默可能是思考或事件，不应因为 VAD 判断“无语音”就从视频删除。

## 多人、说话人和画内文本

当前 FunASR 没有说话人识别。多人访谈不能凭文本顺序猜 Speaker；需要画面、音轨、用户说明或未来 Diarization。画内字幕可以帮助校正专名，但可能是旧版或错误字幕，不能自动覆盖声音。

## 标点和 ITN

FunASR 内部使用自动语言和 ITN，数字可能被规范为阿拉伯数字，标点也可能不可靠。TranscriptText 应保存原始输出；人工修正记录来源。语义分卡和最终字幕由下游决定，不在这里为“好看”重写文字。

## 实际故障和恢复

- Bridge 409：重新读取 Workflow Detail，不能只换 schemaVersion；
- failed：保存 error，不创建空 Transcript；
- succeeded 但没有 text output：视为失败；
- 音频不可解码：先标准化或修 Asset；
- ComfyUI 重启后 run 丢失：对账本地 Job和已有 Transcript，避免重复提交。

## 交接合同

输入是已就绪音频 Asset 和当前 Project。输出是 TranscriptText、候选句、原始调用信息和高风险核对结果。它会使旧语义判断可能失效。验证是读回文本、检查失败原因、回听关键范围，并明确时间精度。完成后把全部结果交给 `semantic-continuity`，不能直接开始逐句动效。

## 当前调用与读回：转写

| 阶段 | 当前 MCP 命令与关键输入 | 写后读回 / 下一步 |
|---|---|---|
| 转写 | `submit_transcription(asset_id, idempotency_key?)`；人工文本用 `apply_manual_transcript(base_revision_id, asset_id, text)` | Job 完成后 `read_script`；候选句不等于 SemanticUnit。 |
