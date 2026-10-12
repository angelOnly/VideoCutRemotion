# 原材料与复现边界

## 可以立即使用的教学资料
成片、原任务、最终固定输入和实现、报告、图片与本輪提取的关键帧已经附带。无需用户再查找这些文件，Codex可从本目录按需读取。

## 不要混淆三种“完整”
- **完整案例教学资料：**看得到完整视频，读得到实际输入、源码、范围和边界。本目录为这一用途整理。
- **原始项目归档：**还需要全部源媒体、Project快照、字幕、声音关系和历史版本。本包未完整拥有。
- **一键精确重渲染：**需要匹配Runtime与字体、重建素材ID和绑定、原生字幕/声音配置。本轮没有实现或验证。

## 原包已经附带的三张图片
`assets/materials/chair.jpg`、`art.jpg`、`identity.jpg`均从原包已绑定的原件复制，逐项对manifest哈希。图片EXIF与字节保留，不把其自动旋转版本改名冒充原件。来源URL与文件hash见 [materials.json](../source/materials.json)。

## 两份未附带的大视频
原包明确因体积未包含这两份源文件。四槽来自以下区间：

| 槽 | 原项目相对路径 | 源SHA-256 | 入出点 |
|---|---|---|---|
| `pubgRoad` | `assets\source\3065d81b310deb7f5baa.mp4` | `3065d81b310deb7f5baa01e52974b50bef9a72f9ceddca63f94e99e7e587289f` | 0—3033ms → 作品284—375帧 |
| `lolChase` | `assets\source\847a7cb4c803743e99fb.mp4` | `847a7cb4c803743e99fb1bcc65bdc3f1d82d0c99fbf043ea37e7610434bf5196` | 200000—201600ms → 作品364—412帧 |
| `pubgRoom` | `assets\source\3065d81b310deb7f5baa.mp4` | `3065d81b310deb7f5baa01e52974b50bef9a72f9ceddca63f94e99e7e587289f` | 184000—185333ms → 作品401—441帧 |
| `lolCamp` | `assets\source\847a7cb4c803743e99fb.mp4` | `847a7cb4c803743e99fb1bcc65bdc3f1d82d0c99fbf043ea37e7610434bf5196` | 464567—467834ms → 作品430—528帧 |

原包报告的项目目录是 `E:/ai/VideoCut/workspace/projects/project_6a9de441-d23e-4315-91f6-f4884640c959`。这是用户侧原记录，不是当前沙箱中已访问的路径。确需原件时，在用户机器通过现有项目/Asset记录按上表定位，核对hash；原记录若含来源URL则按合法可用入口重新取得。当前小包没有这两份视频的完整URL，不能凭片名补一个。

新主题不需要重新取得本例游戏视频。它应自主检索自己的材料，使用本例方法，不沿用旧Asset ID。复现同一旧片则必须解决这些依赖，不能用最终片裁出游戏来冒充独立原源。

## 字体
本目录只保存 `source/font-bindings.json` 中的ID、实际字重和hash。字体原件没有附带，按当前已发布目录核对。新Runtime同名ID字节变化也不能声称像素完全一致。不得把字体文件随本资料包二次分享。

## 声音与字幕
`assets/audio/speech-2.wav`从原包复制，ffprobe时长26.280秒，与报告完整WAV长度一致。报告记录了合成增益和最终输出目标；该原始WAV不等于最终MP4中经过混音编码的AAC字节。

完整最终脚本、21张Caption Card对象及164个token原始alignment不在小包。不能从原输入的文案和若干事件帧伪造这些文件。本例的全部字幕可在成片中观看。确需精确重建原生字幕，在原项目通过当前可用字幕/对齐读取接口导出真实对象；没有接口就明确缺口，不直接改正式数据库。

## source.json与manifest的不同hash
`source.json`文件hash标识固定输入文件；`manifest.version`是受管作品版本；`manifest.previewHash`是受管动画资源hash，不是最终混入字幕和声音的MP4的hash。正式导出的 `preview.mp4`另有SHA-256。不同对象的hash本来就不相等，不能误判为错配。

## 只学习时不阻塞
这些缺口无需让本例从案例库消失；准确说明即可看视频和读方法。只有要求精确重渲染时才需要补相应依赖，不把搜齐旧原件变成每个新主题的前置任务。
