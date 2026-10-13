# 受管动画组件与资源合同

按当前实现问题读取对应章节。单片作品通过已发布 MCP 保存固定源码、Props 与资源并渲染，不修改平台 Registry、安装依赖或绕过 MCP。正式使用前核对实时 Schema 与 read_motion_capabilities；仓库里存在某字段不表示当前会话已经发布。

## 编码或选择组件前的输入

取得本段当前采用稿、准确文字与事实、实际素材和源范围、目标画幅、放置位置及前后接口；需要同步时还有本版声音与精度。局部改字或切口直接读原作品与受影响参数。设计缺失再回原作者的[美术](../../visual-treatment-planning/references/art-direction.md)或[演出方法](../../motion-brief-writing/references/performance-design.md)，不让组件默认值补创意。

现成组件能保留所需内部变化时复用；需要对象持续、真实视频共场或特定接管而组件无法兑现时，编写本片受管作品。案例是教学，不是 Registry 的别名，名称相似不能把连续过程替成整体进出场的固定卡片。

StylePack 只影响 Runtime 实际消费的配置，不能假定一个 stylePackId 已控制全部字体、色彩和运动。本片已采用的选择通过真实 Props、绑定和源码落实；关键状态与合成检查沿演出方法，不另写一套美术流程。

## Props 与素材输入

组件只使用固定输入和允许接口，不自行读数据库、文件系统、环境变量或网络。Props 暴露用户可见且可能修改的内容，如文字、数值、颜色、布局与必要运动参数；内部常量和临时状态留在源码。类型、范围与合法资源由当前 Schema 校验。

图片用 imageBindings 将项目 Asset 映射到 props.assets，源码使用 Remotion Img；视频用 videoBindings 和下文的 TimelineVideo；字体用 fontBindings。不能把本地路径、外部 URL、搜索缩略图或浏览器缓存地址直接当作项目绑定。真实素材的可见区域和必要条件决定 cover/contain，不能为了填满画布裁掉关键内容。

作品内部原图和原视频的采用绑定，统一见[取得操作](../../visual-asset-sourcing/references/acquisition-operations.md#公共素材理解与声音链)。作品槽位、源身份与使用范围必须对应当前版本，外层 motion 槽指的是生成作品，不能代替内部原件用途。

## 局部时间与 Remotion Sequence

外层把 Cue 放到 Sequence 中，或由 Runtime 统一计算 localFrame = globalFrame - startFrame。组件在 Sequence 内用 useCurrentFrame() 已得到该序列局部帧，不再减项目全局起点。

内部再嵌套 Sequence 会再次重置 useCurrentFrame()，用于该层布局动画；TimelineVideo 读取平台保存的作品根帧，不随内部 Sequence 重置。这是视觉布局时间与源片时间的区别。

项目播放固定作品允许不同 fps，透明帧按 floor(项目局部帧 × 作品fps / 项目fps) 读取。内部源毫秒、绑定帧与事件仍属于固定作品时钟，不因项目 fps 改写；升采样不会增加运动细节。各时间映射与完整公式见[素材坐标与时间](material-space-and-time.md)。

Cue 应完整容纳采用的变化、阅读与出口，不能用更短 Item 截断未完成动作。整体平移可更新放置；内部时序或设计改变要生成新作品，并复核事件和声音。

## 受管动态视频

work.videoBindings 是可选命名记录，不设作品视频选段总数上限，允许顺序、同源多范围与交叠使用；实际负载受资源校验约束。每槽声明 assetId、sourceStartMs、sourceEndMs、startFrame、endFrame，可选 decodeScale。源毫秒和作品帧均为半开区间，作品帧从本作品0开始；源身份、内容哈希与范围随作品固定，改绑或改范围提交新版本。只绑定有真实时长与内容哈希的 ready 源视频，不嵌套受管动效 Asset。Provider 复用分块串行解码、内存帧缓存与磁盘回收；单块预算不等于浏览器总内存预算。真实资源不足须明确诊断，不静默删镜头、降质量或发布半件作品。

源码通过 '@videoflowcut/motion' 的 TimelineVideo 引用 slot。fit 支持 cover、contain、fill，默认 cover；style 负责画布内静态或帧驱动布局。视频按真实 PTS 以作品 fps 正常速度重采样并静音，VFR 保留原时间间隔；不传任意视频 URL，也不传 offsetInFrames。

平台在作品帧 F 取绑定的第 F - startFrame 帧，实际输出数为 endFrame - startFrame。源范围须覆盖正常速度所需时长，允许1毫秒取整及不足一作品帧的选段余量；不能向上取整多出一帧。TimelineVideo 在绑定范围外不显示；源不足、哈希变化、越界或解码失败明确报错，不冻结、循环或补帧。

下面是同一槽跨内部 Sequence 继续播放的最小示例。30 fps、120帧作品的 footage 绑定 startFrame=0、endFrame=120，并给足对应源范围；第60帧只是布局变了，源内容不从头开始：

~~~tsx
import React from 'react';
import {AbsoluteFill, Sequence} from 'remotion';
import {TimelineVideo} from '@videoflowcut/motion';

export default function Motion() {
  return (
    <AbsoluteFill>
      <Sequence from={0} durationInFrames={60}>
        <TimelineVideo slot="footage" fit="cover" />
      </Sequence>
      <Sequence from={60} durationInFrames={60}>
        <div style={{position: 'absolute', left: '55%', top: '20%', width: '40%', height: '50%', overflow: 'hidden'}}>
          <TimelineVideo slot="footage" fit="contain" />
        </div>
      </Sequence>
    </AbsoluteFill>
  );
}
~~~

全屏转窗口、全貌与局部同屏沿用同一槽位与根时钟。跨作品要分别声明真实源起点，按[坐标与时间](material-space-and-time.md)核对接点，不能因组件重新出现就假定自然续播。源画面与依附标注共享变换；目标本身移动时固定源点不是跟踪，只在可靠范围标注或重新设计。

decodeScale 按真实观察尺度选择，缩小解码不改变归一化坐标，但会降低细节。实际显示宽高、旋转/SAR 以 Worker 读回为准；显式解码缩放的范围与输出尺寸由实时能力校验。短选段不会缩小原始文件字节。当前单图绑定原文件上限为8 MiB，超出时通过正式素材能力换合适载体，不外部压图绕过。

完整作品不因30秒、900帧或累计解码量被要求拆件。平台按内容身份共享原片、有界取帧与回收缓存；透明输出仍需要实际磁盘空间，Worker 提前及渲染中检查，空间不足、损坏或卡死明确失败，不降画质、丢片段或发布半件 Asset。缓存配置属于平台维护，不进入作者的设计步骤。

内部视频始终静音，原声需在 Timeline/Audio 链明确源范围和声音归属，并在同一 Preview 复核。素材能正确解码不等于动作、裁切、接管或听感已通过。

## 命名事件与声音

源码可导出 resolveMotionEvents(props, {fps, durationInFrames})，返回 id、meaning、startFrame 和可选 endFrame。动画与事件共用同一份时序常量或函数，避免手写另一张与画面无关的事件表。持续动作交起止，是否持续发声由当前声音设计决定。

平台固定 eventMap 版本，读回作品实际事件后交时机与声音作者。起音、主攻击、视觉感知偏移和 Item 换算统一见[事件与声音绑定](../../effect-timing/references/event-and-audio-binding.md)。仅整体移动与内部改时序的失效范围不同，改版后复核受影响声音，不沿用旧绝对帧。

## 字体身份与实际字重

编写前查当前 read_motion_capabilities 的真实目录。fontBindings 将槽固定到实际 fontId，平台校验文件哈希并在首次挂载前加载，通过 props.fonts[槽位] 的 family、weight、style 注入。原件的粗细与样式才是实际字形：名称常规未必为400，不同文件也可能同为400，不制造 CSS 假粗体。

例如文字样式使用 `style={{fontFamily: props.fonts.title.family, fontWeight: props.fonts.title.weight, fontStyle: props.fonts.title.style}}`，字号、颜色与运动按本片设计。不覆盖 props.fonts，也不另用 useEffect、FontFace、浏览器全局或网络加载字体；允许导入的接口以当前能力为准。

用本片中文、数字、标点、最长行检查缺字与换行；目录登记不证明每个字符都有覆盖。字体缺失、变更、损坏或加载失败明确失败，不回退系统字体或发布半件。普通字款选择由原视觉作者完成；指定理想字体未收录时，进入[字体选择与恢复](submission-and-recovery.md)，不把扩目录变成所有制作前置。用户授权不能代替真实文件身份。

## 透明画布与合成空间

Registry Overlay 的自然盒由其组件合同决定；受管作品采用目标画布大小的透明缓存，内部排版从源码/Props 修改并重渲染。full_frame 是作品坐标系，不表示遮挡全屏；不假定通用 Inspector 能直接移动可见内容的自然盒。

作品内部标题、主体、来源和图形按本片设计，不强加统一标题栏或固定字幕保留带。字幕默认位置不构成其他对象的禁入区，平台不测量字幕安全区相交来阻断；真实人物、字幕、证据和前后画面在请求画幅的合成里核对。

短时叠加可以用 Effect，完整视觉模型需要相应 Scene。选择依据当前观看与放置关系，不因有大标题就必建全屏，不把完整解释挤成人物旁边的小挂件。

## 登记组件适合时直接使用

具体组件和参数以当前能力为准。下表只说明使用时要保留的内容条件，不是所有作品的必选菜单。

| 表达 | 使用判断 |
|---|---|
| MetricBackdrop | 数值、单位、语境与基线一起可读；不持续跳数妨碍阅读 |
| ProductFan、PortfolioWall | 使用真实产品/封面，保留识别面积；多到读不清时分组，不用通用方块代替 |
| CommentCloud | 真实评论或明确示意；作为环境时退让，需核对原文时给阅读空间 |
| EvidenceCard | 真实来源、原文与限定；短卡装不下完整证据就改变载体 |
| CameraPunch | 有具体表情、语义或心理距离作用，焦点正确，不每句重复推近 |
| DeviceShowcase | 真实界面与状态可辨，复杂操作不能缩成难读小屏 |
| ContentCarousel | 数量和顺序服务当前展示，按逐项解释或快速浏览安排识别时间 |
| FullScreenMeme / ComicReaction | 当前语气支持且笑点明确，来源清楚，不代替真实人物反应 |
| GlowCTA、EndCard | 行动理由、真实入口、结果和必要阅读清楚，结尾声音有收束 |

各段可以共用排印、颜色与运动语气，形式仍由内容决定。组件覆盖率属于工程测试，不是创作目标。

## 随机与碰撞的任意帧重建

渲染可能跳帧、重复取同一帧或并发计算。使用固定种子与按时间求值的轨迹、预计算状态或其他可复现方法；固定初值不等于修复依赖“已经播放上一帧”的模拟。不能依赖 Date.now()、未固定随机或网络时序。

落稳对象保留身份和后续接触状态，远近细节变化不能改变几何身份。重复取帧、乱序跳帧及连续播放应得到同一状态，再观察关键接触前后。数学一致不代替碰撞观感、遮挡与收势。避免每帧解析大 JSON 或重建不必要布局；需要派生素材时沿正式能力保留来源。

## 提交与失败入口

当前稿、源码、Props、资源与画布形成固定作品版本。提交、查询、审阅、Cue 放置、参数拒绝和旧引擎恢复统一见[提交与恢复](submission-and-recovery.md)。历史产物可读，重新生成仍按当前合同，不猜旧源范围或覆盖已使用的 Asset。

源码只能使用允许接口和帧驱动能力，不联网、读宿主文件、临时装包或放宽隔离。失败保留原始诊断，参数拒绝、Worker 失败和结果未知分开处理；不通过改名掩盖校验误判。技术检查与实际专业观察分别记录，旧版审阅不自动继承。
