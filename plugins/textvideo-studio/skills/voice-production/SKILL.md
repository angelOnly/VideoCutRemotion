---
name: voice-production
description: 按确认正文与模板音色批量生成动画旁白并核验实际时长。
---

# voice-production

读取 [声音与字幕](../production-coordinator/references/audio.md)。以完整确认正文建立自然句段；句段用于语音连贯，不能反过来重拆业务分镜。每段绑定稳定 segmentId、speechRequestId、sceneId、精确 text、voiceRef 和 speed，批量提交并按身份接回，不按完成顺序拼台词。

音色由模板声明和实际服务解析，不能猜声音身份。审听重音、语速、句尾和相邻段连续；技术成功与实际听审分别记录。正文、音色或速度改变时只重做受影响段，更新后续实测时间；未受影响音频需核验复用条件。

回传完成/失败/待定数量、批次与时序文件引用、异常段及真实听审范围，不反复交接完整返回数组。unknown 沿原作业核查，不换键制造重复供应商请求。
