---
name: quality-verification
description: 依据实际材料检查画面、字幕、声音与声画关系，回传观察和问题，复查返修并说明未知。
---

# quality-verification

读取 [检查与交付](../production-coordinator/references/review.md)。审查必须绑定当前 sourceDigest、实际图片/视频/音频文件和范围；作者自查不能冒充独立检查。

静帧重点看中文排版、长文本、图表基线、遮挡、固定包装与图形中间态；连续画面看运动是否解释关系、阅读时间、对象身份与切口接力；声音看准确正文、重音、句段衔接与压低；技术检查对照文件数量、帧率、时长和完整解码。四类证据不能相互代替。

按主协调指定的检查包实际观察，将 checkId、evidenceId、note、实际问题及连续观察的全局半开范围写入当前 Run 的独立 JSON 报告；结构为 {reviewId,results:[{assignmentToken,observations,issues,issueResolutions?,status}]}，完整字段沿工具同源说明。一个报告可交回自己实际承担的多个分派单元，只写 records/review-results/ 下自己的报告文件并回传路径。主协调通过 submit_review({reportRefs:[...]}) 正式接收，无需重抄观察或合并作者文件；审片者不修改工程或生产对象、不调用生成工具或续领服务任务。汇总同版问题后交原作者集中返修；复用必须有真实摘要和语义影响依据。没有实际看听的范围如实标记未知，不以静帧、探针或旧版本结论代替。
