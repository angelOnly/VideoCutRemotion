# 旁白、字幕与声音收尾

声音作者以确认正文和模板声明的声音资源为输入，负责精确文本、音色身份、自然句段、实际时长、字幕时序、混音意图和真实听审。可以同时负责字幕与收尾，但分别交回还未完成的音频、时间轴和观察，不把“音轨存在”当成声音工作完成。

## 专业方法与本服务边界

完整读取[自然分段与表演](../../voice-production/references/speech-performance.md)和[字幕阅读与分卡](../../captions/references/caption-design.md)。声音句群、字幕卡和场面各按用途划分；短句与长句的代价、列表承接、四轮回听和中文阅读诊断只维护在这些正文中，不以本页代替。

字幕作者根据语义和实际看听决定分页及阅读时长，可通过装配计划 scenes[].captions 明确给出 utteranceId、text、startFrame、endFrameExclusive。作者时序不冒称自动或逐词精确对齐；已有可靠 captionTiming 则按其真实音频摘要核验。仅模板明确声明 captionTimingPolicy=utterance 时要求句段边界或可靠对齐。实际材料仍有冲突时交原作者调整相应范围，明确能力缺口，不全片重配。voiceRef 来自模板与实际服务解析，不猜身份。

## 当前声音提交与恢复

优先 synthesize_speech_batch 一次登记完整句段。稳定 speechBatchRequestId 下，每段有 speechRequestId、segmentId、sceneId、精确 text、voiceRef、speed。read_speech_batch 默认返回计数、异常和 detailsRef；该引用保存原始完整 JSON，具体处理时可传 details:true。按身份接回，不能按完成先后拼台词，也不逐条搬运全量数组给协调者。

局部段使用 synthesize_speech/read_speech_job。相同键不同输入拒绝；成功音频的复用核对文本、音色、参数、归属与文件摘要，跨 Run 显式 reuseRunId。unknown 沿原 job/run 核查，不复用或换键重新收费。已有音频 validation_failed 时仅 retry_speech_validation，不重新请求供应商。

配音批次成功后，由主协调调用 assemble_sentence_audio，传 assemblyRequestId、speechBatchRequestIds、planRef 和当前时间线文件的 expectedTimelineSha256。计划只写自然句段顺序、gapBeforeFrames、tailFrames、作者字幕页及帧界或可靠 captionTiming 引用及章节归属；批次已明确的值不重复抄写。服务按稳定 ID 接回、验证摘要、复制到 public、复用可信 PCM 测量并计算覆盖音频的帧界。模板必须声明 timelineDataRef 与 sentence-timeline/1；不支持时报告合同范围，不解析任意 TypeScript。原键同输入只返回原记录，不覆盖作者后续改稿；冲突读回真实差异，不新发 TTS。装配期间暂停同文件写入。视觉对象、BGM、SFX 和源码保留，时长改变交视觉作者重校动作与接管，不自动缩放。听查每段起句、重音、语速、句尾与前后连接，尤其留意分段后语气不断重置、半音节截尾、异常长停顿和重复句。短淡化只能消除爆点，不能修复错读、断义和明显语气跳变；问题段需要真实重做并更新依赖。

## 音乐先做 Spotting，再决定包络

先写这一段实际听到的过程：谁是主声音，音乐何时开始、支持哪项情绪或结构、何时退让、何时退出，哪里只需要旁白或留白。使用模板已有资源，不先铺满一首歌再被动压低。复杂证据、重要结论或高密度阅读可以减弱或退出音乐；画面已经密集变化时，音乐保持稳定常比同时加新变化更清楚。

Spotting 写在当前声音稿：资源引用、实际可用范围、全局进入/退出位置、功能、需要退让的旁白区间、尾音与下一章的关系。循环或裁切需顺着乐句检查，避免硬截、突然重启和尾音被片尾切掉；旁白时长变化后重新核对裁切、淡出、章节和压低范围。

Ducking 以听清语言为目标：在旁白发声前合理开始退让，句内保持稳定，不随每个短停顿剧烈起伏；句尾和音乐自然节拍之后平滑恢复。下降/恢复时机和幅度根据实际音乐密度与旁白决定，不套固定 dB 当作已通过。若压低后仍遮蔽，先减少竞争声层、调整频段或取消无作用音乐，不能只无限提高总音量。

效果声绑定已命名的动作或信息变化。区分音源文件开始、可听起音、主攻击和余尾；视觉落定要对应感知落点，不能把文件起点机械贴到动作帧。主攻击服务重点，尾音避开下一句或下一事件；每张卡都配同一种转场声会疲劳。声音桥可跨动画场面维持主题或提前建立下一关注，但不得暗示确认稿没有的事实关系。

## 复听、修订与交回

先只听声音判断文字、拼接、停顿、层级和音乐结构，再带画面检查字幕换页、图形落点、效果声起音和章节接管。重大混音疑点可以比较当前版本、最小处理和不使用该声音的版本；采用能改善理解与节奏且副作用较小的结果，不因已经铺入就保留。

最终文件检查开头无意空白/爆音、声道、句段及章节接点、最后一句与尾音。具备能力时完整复听并核查耳机和普通扬声器可懂度；仅听局部就只报告局部。无听觉能力时音色、遮蔽、情绪与听感保持 inconclusive，明确待听范围；波形、探针和静音代理不能代替听审。

正文、音色或速度改变只重做受影响段，按实测时长更新后续字幕和动作；纯视觉微调不重做声音。最终源码停止写入后执行 verify_sentence_audio，审计的 sourceDigest 必须匹配正式导出；失败按具体诊断修，不换键盲重试。服务按固定导出策略生成连续音轨和文件，作者不手写切片拼音轨绕过正式核验。

交回批次/音频/时间轴引用、计数与异常段、Spotting 与包络决定、实际听过的方法和范围、受影响字幕/动作及未完成事项；保持完成生成、完成技术核验和完成听审三个结论可区分。

### 装配计划文件结构

`planRef` 指向 project 内 JSON；工具字段说明提供与运行校验同源的完整 JSON Schema。最小形式为 `{"scenes":[{"sceneId":"确认分镜ID","utterances":[{"id":"配音segmentId","gapBeforeFrames":0}],"tailFrames":0}],"chapters":[{"chapterId":"时间线章节id","sceneIds":["确认分镜ID"]}]}`。scenes 按确认稿顺序完整列出；utterances 可省略以采用批次顺序，显式填写时须完整覆盖该分镜句段。停顿放在 scenes[].utterances[]，句段使用 id，不是 segmentId；不在顶层添加 segments、sentences 或 utterances。章节归属用 chapterId。gapBeforeFrames 是相对上一句结束的留白，首句须包含实际片头或章节转场占用；以真实包装帧数填写，不照抄示例 0。captionText 只改换行；语义分页使用 scenes[].captions，不能与 captionTiming 同时指定。可靠对齐按 captionTiming 的当前音频摘要证据，不造对齐文件。装配成功前不手算音频帧界绕过服务。

### 指定人物与无口播范围

按服务从本次可见标签计算的 directing.speechTurns 拆自然句段（普通无标签稿沿模板安排），每段不得跨发言边界。角色及音色绑定读取本模板 renderer-manifest.json 的 speakerBindings；未指定时由作者按模板安排，通用 Worker 不根据人物名称或音色编号猜角色。装配根据已确认范围写 utterance.turnId/speaker/voiceRef，核验文本、顺序、人物与音色，不能按句段到达顺序重新猜人。

kind=visual 且正文为空、画面说明非空和 durationSec 正数，允许 utterances=[]、captions=[]；装配按明确时长推进。全部画面均无口播时 speechBatchRequestIds=[]，不提交空配音批次，仍执行装配和当前版本核验。模板 intro 按原实测帧播放，句段和字幕避开片头，保留首句停顿/片头内部间隔及尾帧，不虚造台词。有台词缺音频仍失败。
