---
name: voice-production
description: 将最终 SpeechSegment 交给 OmniVoice，默认使用服务端已有本地音色，也可显式指定 VoiceReference；下载并校验段级音频，使用真实时长组装 SpeechAsset 和 segment_exact，同时审查语速、重音、句尾与相邻段连续性。
---

## 当前文本模板任务入口

收到包含 taskId/runId/stage 的服务输入时，先读 [模板生产执行合同](../_shared/TEMPLATE_PRODUCTION.md)，以该合同执行本阶段。整批句段优先使用 synthesize_speech_batch/read_speech_batch，按稳定句段编号匹配；本地检查失败只恢复检查，结果未知不重复收费。原有方法章节继续用于专业判断；旧 Project/Revision 写入、本地模型、向量与网络取材分支不适用于模板服务，不调用已移除工具。


# OmniVoice 旁白生产、组装与听感

## 积极表演与当前声画共同校准

TTS 只使用当前准确纯旁白与接口明确支持的表演参数；来源、画面说明、美术建议、作者分析和例文说明不朗读。首版声音不锁死文本，合理改稿后按真实影响重配并复听相邻衔接；时长改变可能移动后续对象，不能承诺只改一个局部。普通背景换用而含义、指代与声音不变时保留既有配音。

已采用参考时延续其适用的讲述与动作关系。返回积极的表演安排：哪里进入处境、发现、解释、质疑、落读或完成，而不只有禁止情绪的指令。先保持自然句群，字幕短卡不要求拆成独立短音频。实际回听后再判断语气，改稿与重配允许改变原估时。

从导演与文案取得当前完整朗读稿、重音与必要读音，使用本机已配置语音链。返回真实时长、句段范围、对齐精度、音色/模型与未知；新声音同步回原文案、视觉和字幕作者。

当前声画协作沿 [主题到成片](../_shared/TOPIC_TO_FILM.md)；参考仅按当前稿已采用的范围使用。

## 执行角色与代理交接

当前授权作者完成专业判断，主任务统一正式提交；输入、完整产物、依赖变化与原作者续接沿 [角色交接](../_shared/PROJECT_REVISION_AND_HANDOFF.md)。

完整专业判断读取[专业方法](references/speech-performance.md)，新建时完整读取，局部修改只读受影响章节。

## 交接合同

输入是最终 SpeechSegment、Script Revision、VoiceReference 和表演意图。输出是 SegmentAsset、SpeechAsset、真实 `segment_exact`、质量结论和失败段。它会使 ActorPerformance、Caption 和 EffectTiming 需要重建或复核。验证是逐段、拼接、只听声音和声画检查。完成后结果回到 Presenter/Explainer 主工作流。

## 按当前操作读取

需要生成、写入或核对当前voice-production对象时，读取 [执行操作](references/synthesis-and-placement.md) 对应章节，返回准确参数和受影响范围；只讨论本段表达时不预读全部字段。
