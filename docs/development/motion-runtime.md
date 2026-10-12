## 平台维护分支

只有平台开发任务进入以下流程；单片原创不以注册组件为前提。

## 新组件代码开发流程

### 1. 写组件 Brief

说明观众任务、支持的内容结构、适用/不适用场景、Asset Slot、Props、画幅、运动、质量规则和降级。不要从视觉外观开始。

### 2. 设计静态状态

用固定 Fixture 查看本段关键画面，验证信息层级、文本、资产、人物和画幅；主要表达依赖连续动作时同步完成必要试作。关键帧只证明静态构图，不能代替动态过程与完整场面验证。

### 3. 实现 TypeScript 组件

VideoFlowCut 当前 Runtime 使用 TypeScript/React/Remotion。推荐组件只依赖明确注入的 Props、Asset URL 和 Remotion API，保持纯函数式和确定性。示意：

```tsx
import {AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';

type MetricBackdropProps = {
  value: number;
  unit: string;
  label?: string;
  accent?: string;
};

export function MetricBackdrop(props: MetricBackdropProps) {
  const frame = useCurrentFrame(); // 在外层 Sequence 内是 Cue 局部帧
  const {fps} = useVideoConfig();
  const progress = interpolate(frame, [0, Math.round(fps * 0.3)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  return (
    <AbsoluteFill aria-label="metric-backdrop">
      {/* Settled Frame 的层级先成立，再让 progress 建立它 */}
    </AbsoluteFill>
  );
}
```

实际 Component 应从统一 Design Tokens、Asset Resolver 和安全工具库工作，避免每个组件复制字体加载、媒体错误和 Easing。

### 4. 注册 Props 与 Asset Slot

Props Schema 校验文本长度、数字范围、枚举和默认值；Asset Slot 指定 kind、required、数量和裁切策略。运行时缺必要 Asset 应产生明确 blocking 或降级，不渲染假卡片。

### 5. 测试

- 类型与 Schema；
- 最短/最长时长；
- 竖屏/横屏；
- 文本边界和中文/英文；
- Asset 缺失；
- Cue 在 Timeline 后半段的局部时间；
- Player 与 Render；
- Entry/Settled/Exit Golden；
- 性能与内存。

### 6. Registry 和版本

组件通过后加入 Registry，生产 Skill 才能发现。破坏性 Props 变化需要版本或迁移；不能让旧 Revision 因组件更新变得不可渲染。

## 修改已有组件还是新建组件

如果只是内容、颜色、强度、布局或时机变化，优先 Props/EffectCue；如果观众任务和信息结构相同，复用组件。若任务、结构和稳定画面完全不同，开发新组件或 Scene。共享色板不表示同一 Asset。

例如“展示三项分类”和“展示三款产品”都可能是三个对象，但前者需要比较坐标与类别关系，后者需要真实产品与视觉陈列；不应仅因数量相同复用一个通用 ThreeCards。


Runtime 0.1.63增加`smiley-sans-oblique`（得意黑，400 italic）与`maoken-yanbo-song-extralight/light/regular/medium/semibold/bold/black`（猫啃网烟波宋原件七个字重）。ID仍须以当前查询为准；烟波宋R原件标注200，不能自行改为400，也不能冒称为字魂同名字款。目录只限制字体身份，配色、描边和新动效由作者按内容生成，没有必须选择的字体模板。完整字体名称或分发许可未核实时，不能把参考简称登记成可用字体。


Runtime 0.1.64接入用户提供并确认采用的22份原件，目录共34份文件。包括`aa-jianhao`（Aa剑豪体）、`aa-houdi-hei`（Aa厚底黑）、`leefont-menghei`（Leefont蒙黑体，真实900）、`muyao-softbrush`、`pf-pinfan-hutu`、`sanji-liliang-bold`、`sanji-pomo`、`yunfeng-feiyun`、`wd-xl-huayou-jp-n`、`wd-xl-huayou-jp-s`、`wd-xl-huayou-sc`、`wd-xl-huayou-tc`、`canger-yumo-w01/w02/w03/w04`、`canger-shuyuan-w01/w02/w03/w04/w05`、`canger-feibai-w01`。简体中文优先查看滑油字SC版本；JP_N/JP_S/TC是不同地区字形版本，不把它们合并成同一文件。仓耳W01–W05等原件内部字重均标注400，但粗细已在不同文件轮廓中体现，必须选择对应ID，不另设CSS假粗体。云峰静龙行书只有预览图，未登记。不同文件不是同等数量的字族；制作仍查询实时ID、使用实际文案检查缺字，字体与动效不绑定。


0.1.62目录提供中文衬线候选`noto-serif-sc-semibold`（真实600）与`noto-serif-sc-black`（真实900）。需要宋／显示衬线时先检查查询是否包含这些实际文件，再用主字和最长纸条出真实字样；黑体不能替代明确要求的衬线轮廓。中粗或重字重的适用位置由作者观察决定，不给普通400字款加fontWeight:900冒充重字重。未知参考的确切字款不应成为必须同款的额外门禁，接近字款如实记录替代；具体字幅、侧转中途、纸条镜内阅读仍由原作者复核，登记字体不等于专业定稿。


Runtime 0.1.63的受管字体目录含得意黑原生窄斜与猫啃网烟波宋七个实际文件，以及既有Noto黑体/宋体。先读当前`read_motion_capabilities`，按真实ID建立`fontBindings`，使用平台注入的`props.fonts[槽位].family/weight/style`。得意黑为400 italic；烟波宋R原件字重200，不能因名称“常规”擅改为400。使用的是猫啃网开放版烟波宋，不能称为字魂同名字款。支持发行内OTF与TTF原件，不下载、不转换、不读系统字体。目录只约束字体身份，不规定颜色、描边或动效；作者按本次内容独立编写帧驱动动作，不需要选择花字模板。未核实完整名称或分发许可的参考字款不能冒充已登记能力。


Runtime 0.1.64另接入用户提供的22份原件，目录共34份文件：Aa剑豪体、Aa厚底黑、Leefont蒙黑体、Muyao-Softbrush、PF频凡胡涂体、滑油字JP_N/JP_S/SC/TC、三极力量体简-粗、三极泼墨体、云峰飞云体、仓耳与墨W01–W04、仓耳舒圆体W01–W05、仓耳非白W01。只登记实际文件，云峰静龙行书缺文件暂不登记；来源与授权信息随NOTICE-UserFonts.txt发行。各版本独立固定哈希，仓耳不同粗细虽内部字重都是400仍按对应文件选择；Leefont蒙黑体为900，其余新增原件为400 normal。文件名可为发行改用ASCII，字体字节与内部元数据不变。这里仍只扩充受管动画字体，不加入字幕模板或固定动效。


## 修复工单与候选部署合同

仅确认平台或服务自身 Bug 阻断任务才报修，服务未启动或原因未知不构成该条件。以下为修复任务维护合同，执行仍核对实时 Schema。




这些命令管理平台能力缺口，不是视频编辑命令。调用前仍以实时 Tool Schema 为准；它们不会创建或修改 Project Revision。



| 阶段 | MCP 命令与关键输入 | 允许的下一步 |

|---|---|---|

| 读取发行健康 | `read_runtime_release()` | 比较 `mcpReleaseId` 与 `runtime.releaseId`，并确认 API、媒体 Worker、渲染 Worker 均健康；不一致时不能确认部署或恢复。 |

| 剪辑阻断 | `report_editing_blocker(reported_revision, category, summary, reporter_id, idempotency_key, detail?, tool_name?, job_id?)` | 剪辑任务停在当前步骤；Ticket 保存 MCP 的 Release ID 和报告 Revision，不进入视频 Revision。Runtime 不可达时也可报告，不能因报障失败而伪造恢复。 |

| 修复接手与候选验证 | `list_repair_tickets(statuses?)`；`claim_repair_ticket(ticket_id, repairer_id)`；`mark_repair_candidate_ready(ticket_id, repairer_id, candidate_release_id, validation_summary)` | Repairer 只在隔离 Runtime/工作区验证根因修复与回归；候选 ID 必须是构建 Manifest 的 `release-<sha256>`，不能使用 latest 或口头版本。 |

| 非部署收口 | `resolve_repair_ticket_without_deployment(ticket_id, repairer_id, kind, evidence)` | 仅处于 claimed 的工单可由原接手 Repairer 收口；分类为 `invalid_input`、`duplicate` 或 `external_recovery`，证据为16至8000字符。拒绝不改变工单或视频 Revision；成功不声称代码已部署，Job 后来成功也不自动收口。 |

| 正式切换 | `mark_repair_deployed(ticket_id, repairer_id, deployment_evidence)` | 该命令自行读取当前 MCP/Runtime Release ID；只有两者一致且等于已验证候选版才会写入 deployed。旧 MCP 或旧 Runtime 必须先重新部署/重连。 |

| 剪辑恢复 | `acknowledge_repair_deployment(ticket_id, editor_id, observed_revision)` | 原报告者重新连接新版 MCP、读回当前 Project 后确认。`observed_revision` 必须仍是当前 Revision；成功后才继续剪辑。 |



修复任务不得把修改正式视频、修改插件缓存、临时跳过失败、在生产工作区跑候选 Worker，作为完成 Ticket 的方式。需要放弃接手时使用 `release_repair_ticket(ticket_id, repairer_id, reason)`，保留复现事实给下一位修复者。





## Skills 去冗余归入的开发资料

以下来自本轮优化前组件参考，是平台维护背景，不是每次创作要加载的步骤；当前配置值与接口以代码为准。

### Registry 结构与兼容
```ts
interface EffectDefinition {
  type: string;
  version: string;
  component: React.ComponentType<EffectProps>;
  propsSchema: ZodSchema;
  assetSlots: AssetSlotDefinition[];
  supportedLayers: Array<'rear'|'actor'|'front'|'fullscreen'>;
  supportedAspectRatios: string[];
  defaultMotion: MotionPreset;
  qualityRules: EffectQualityRule[];
  previewFixture: string;
}
```

具体代码结构可以调整，但职责必须清楚。

## 更新与兼容

组件版本变化可能改变旧 Revision 的渲染。Snapshot 应保存 Registry/Runtime 版本，或通过迁移保持旧 Props 可解释。破坏性更新需要 Golden 回归和旧项目兼容策略。

### 解码缓存与工作区配置

画布宽高64～1920偶数、fps15～60整数、作品至少2帧；不设30秒、900帧或累计像素帧门槛。原片按内容身份共享，不按槽复制。平台按需取帧，分块缓存按驻留量回收；原片与累计解码量不受512MiB作品门槛限制。完整输出按无损体积提前检查真实磁盘空间，失败不发布半件。运行配置VIDEOFLOWCUT_MOTION_FRAME_CACHE_MIB默认256、VIDEOFLOWCUT_MOTION_SCRATCH_MIB默认512、VIDEOFLOWCUT_MOTION_DISK_RESERVE_MIB默认1024、VIDEOFLOWCUT_MOTION_FRAME_TIMEOUT_MS默认12000；缓存限额不是整个进程内存上限，不用于静默降画质。

### 隔离和性能

受管作品由 AST/Import allowlist、确定性约束、独立 Chromium OS sandbox、响应级 CSP sandbox、网络拒绝、执行超时和输出限额共同隔离。AST 静态检查不代替安全沙箱，主工作台读取已验证的帧。缓存键应涵盖实际输入、资源与运行版本；修改一项参数应只影响其真实依赖。

### 历史提交合同的维护位置

受管视频合同曾随 managed-motion-12 发布，fontBindings 随 managed-motion-13 发布；这些是历史定位信息，生产作者以连接 Runtime 的能力查询和实时 Schema 为准。旧 source.json/Job 不注入新字段，缓存哈希与旧序列兼容；绑定或资源身份改变生成新版本，旧产物保持可读。

退役的 caption_safe_area 不接受新的 MCP 提交，历史快照中的标识在质量评估时忽略，不回写 Revision。平台不再采集 motion.visibility，也不输出固定字幕安全区的相交或缺测量提示；透明效果、帧完整性与语义锚点校验仍保留。实际构图和字幕竞争继续由合成观察判断。
