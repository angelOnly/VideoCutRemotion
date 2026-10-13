# 人物生成、Mask与声音所有权

## 声音所有权和口型

`use_source_audio`、`use_dialogue_track`、`muted` 必须明确。使用 OmniVoice 替换声音时，人物视频原声要静音；已有数字人视频自带最终声音时，不再叠加 Dialogue。口型检查包括整体延迟、爆破音、句尾、长元音和明显嘴型错误。Cutaway 可以在短范围内遮盖小问题，但不能长期用 B-roll 掩盖整段口型失配。

## Mask 与前后景

Mask 需要检查分辨率、帧率、时长、头发、手指、快速动作、半透明边缘和背景泄露。一个静帧边缘正确不代表整段正确，必须播放完整运动路径。

无 Mask 或 Mask 不可靠时，降级顺序是增大图形与人物距离、使用左右安全区、减少穿插、使用普通前景 Overlay、切 Fullscreen、最后不使用。不能因为 EffectCue 支持 rear layer，就宣称真实后景遮挡成立。

## Provider Capability 应怎样描述

未来每个 Avatar Provider 需要明确：接受文本还是最终音频；是否保留用户音色；是否输出 Alpha/Mask；支持的分辨率、帧率和时长；口型语言；表情、目光、手势和姿态；局部重生；随机性；隐私和数据处理。营销页说“支持手势”不等于能在某个词精确指向左下。

主工作流只选择真实支持的表演。若 Provider 只能生成自然说话人物，就使用标准构图和安全区，而不规划精确产品互动。

## 人物生成的分段策略

以 SpeechSegment 为基础生成可以局部重做，但过短会产生姿态重置。可以把多个连续 Segment 合为一个人物生成段，同时保留内部 SpeechTiming；在自然 Scene 边界、情绪变化或 Cutaway 处换段。生成段和 TTS 段不必一一对应，但关系必须可追溯。

## 当前执行

使用 `read_actor_performances` 检查已有绑定，用 `read_actor_capabilities` 读取项目中登记的 Provider、输入、Mask、音频驱动口型、局部重生成和隐私信息；用 `manage_actor_capabilities` 创建、更新或移除已确认的能力档案；用 `manage_actor_performance` 登记 Timeline Item、来源、MaskMode、AudioMode、MaskAsset 和 SpeechAsset。每次写入后读回 ActorPerformance、Revision、Impact 和 Preview。

当前 MCP 已实现 `submit_avatar_job`：它固定 `base_revision_id`，以已登记 Capability Profile、单张本地化人物参考图、可选 SpeechAsset 和明确范围提交 MiniMax H3 多参考生成人物。实际调用前 Worker 会读取 Bridge 的最新 Schema；当前生成只支持无 Mask 的前景降级，人物声音只能使用 Dialogue 或静音，且不承诺逐帧姿态、目光或手势追踪。提交后用 `track_job` 与 `read_actor_performances` 读回。

上述对象链和 MCP 合同已经有确定性测试，但 Provider 可用性、中文口型、真实 Mask、局部重生成连续性与完整审美仍必须由实际输出和 Preview 验证。Capability Profile 或参考音频存在不等于口型已通过；失败或结果未知时，不伪造生成成功，交回主工作流说明可执行降级和缺口。

## Avatar 输出作为候选人物素材审阅

Avatar Job 成功只证明 Provider 返回了文件。生成结果在成为正式 ActorPerformance 前，要像其它人物素材一样查看连续声画：检查句首延迟、爆破音、长元音、句尾闭嘴、身份、服装、背景、眨眼、表情、手部、姿态和镜头稳定；多段生成还要检查姿态复位、情绪跳变和人物尺度变化。

先用 `inspect_asset range` 查看完整生成段；口型、手部或短暂伪影会改变判断时，再用 `dense` 查看最小窗口。Provider 名称、输入中存在参考音频或 Capability Profile 中声明支持口型，都不能替代实际观看。Alpha/Mask 也必须由真实输出和边缘检查确认。

局部重生成完成后，比较新段与前后段的身份、光线、背景、目光、语速和情绪。只有生成 Asset、SpeechAsset、Script Revision、AudioMode、Mask/布局和完整 Preview 一致时，才把该人物段视为当前版本可用。
