# 文稿视频工坊：独立插件部署与验收记录

当前已安装独立插件 **textvideo-studio 0.1.4**。原正式 VideoFlowCut 0.1.82 未改动；新插件使用独立宿主、3410/3411 端口与数据目录。21 项生产相关测试通过，短稿、用户全文、第二模板、纯视觉修改和单句修改均已完成真实制作、发布、回调与客户端下载。全文整片约 143 秒及十个分镜均通过下载摘要、媒体协议及完整解码检查。纯视觉修改九段配音验证复用且最终 PCM 与基础一致；单句修改只新生成一段、复用八段，旧版视频保持不变。同 ID 模板更新的新旧冻结隔离也已通过。完整连续视听、正式前端与完整故障矩阵未验收，详见 [验收覆盖说明](textvideo-studio验收覆盖说明.md)。以下按版本保留历史过程，不能将旧版中间状态当成当前结论。

## 独立身份修正（2026-10-13）

本项目插件名为 `textvideo-studio`，显示名为“文稿视频工坊”，MCP 服务名同为 `textvideo-studio`。它不是 VideoFlowCut 的升级版本。

本轮早期错误地沿用 `videoflowcut` 名称，并在 `.candidate/production/codex-home` 隔离宿主安装过测试版。该错误安装已通过官方 `codex plugin remove` 移除。测试日志和失败任务保留，没有迁入新插件数据库。

旧 `plugins/videoflowcut` 的本轮修改已恢复到仓库 HEAD；本轮新增的错误发行文件移至 `.candidate/retired-plugin-additions` 留存。用户正式缓存 `C:/Users/13222/.codex/plugins/cache/videoflowcut/videoflowcut/0.1.82` 仍为原插件，未执行其安装、升级或卸载。此处只确认安装文件，不声称检查过旧 Runtime 的运行健康。

## 发行与调用链

源码发行目录：`plugins/textvideo-studio/`。Skills 从 `.agents/skills/` 同步，不能手改安装缓存。

```text
npm run plugin:build
→ 类型检查、Skills 同步、编译新插件 runtime/dist
→ npm run plugin:verify
→ node scripts/package-production-plugin.mjs <新的发行暂存目录>
→ codex plugin marketplace add <发行暂存目录>
→ codex plugin add textvideo-studio@textvideo-studio-production
→ 已安装插件/scripts/production-launcher.mjs start
→ 两阶段 HTTP API → SQLite → 后台 Codex → textvideo-studio MCP
→ 豆包配音/模板渲染 → 文件发布 → outbox 回调
```

上述安装命令必须在选定服务账户的 `CODEX_HOME` 下执行。本轮使用 `.candidate/textvideo-studio/codex-home`，没有改全局插件安装。

服务操作为 `node <已安装插件>/scripts/production-launcher.mjs start|status|stop`。MCP 启动器只连接现有服务，不创建第二个业务 Runtime。

## 环境与边界

本轮验证环境为 Windows、Node 24.14.0、Codex CLI 0.144.4；第三方依赖按锁文件预装，另需 Chromium、FFmpeg/ffprobe 和有效后台模型认证。不承诺其他系统已经验证。

| 配置 | 用途 |
| --- | --- |
| `TEXTVIDEO_PLUGIN_ROOT` | 已安装的新插件根目录 |
| `TEXTVIDEO_DEPENDENCY_ROOT` | 含固定版本 node_modules 的预置依赖目录 |
| `TEXTVIDEO_DATA_ROOT` | 独立 SQLite、模板、工程、音频、视频和日志 |
| `TEXTVIDEO_CODEX_HOME` | 独立后台 Codex 宿主 |
| `TEXTVIDEO_HOST` / `TEXTVIDEO_PORT` | 服务监听地址，本次 127.0.0.1:3410 |
| `TEXTVIDEO_RUNTIME_URL` | MCP 连接本实例的地址 |
| `TEXTVIDEO_API_TOKEN` | HTTP 服务令牌，不能写入发行包 |
| `CUSTOM_TEMPLATE_API_BASE_URL` | 模板平台基址，本次模拟平台 3411 |
| `CALLBACK_BASE_URL` / `CALLBACK_SECRET` | 回调平台和签名密钥 |
| `MEDIA_PUBLIC_BASE_URL` | 可访问的媒体路径基址，本地为 http://127.0.0.1:3410/media |
| `CODEX_EXECUTABLE` | 已验证的 Codex 可执行文件 |
| `REMOTION_BROWSER_EXECUTABLE` | 部署 Chromium 可执行文件 |
| `DOUBAO_API_KEY` / `DOUBAO_VOICES_FILE` | 豆包凭据及允许使用的音色映射 |

新插件不读取 `VIDEOFLOWCUT_*` 来定位 Runtime、数据或队列。模板、凭据、数据库、浏览器和第三方运行依赖不包含在插件包中。代价是部署需预先准备依赖和配置；不在任务中自动安装软件。

## 已完成的检查

- 类型检查通过；生产相关自动测试 17 项通过。包含模拟 Codex/供应商及协议媒体的测试，不能替代真实创作验收。
- 新插件 0.1.0 构建、摘要和独立身份校验通过。
- Release：`release-2ecdbb1c036a8790d8268acc204c7c1a7f6abd616636fc62ae04c84618d71473`。
- Skills 摘要：`b7f494a1a73cb1912298d5246cdae74bfcb1627946b0664408383c0edc8eab2a`。
- 官方安装完成；独立 Runtime 启动成功；后台新会话只发现 `textvideo-studio` 服务，实际调用 `read_runtime_release`、`read_production_task` 成功，MCP 与 Runtime 发行摘要一致。
- `healthz.productionReady` 当前仅为配置和文件存在检查，不代表真实豆包、模板制作、渲染和最终视频已验收。

## 制作验收状态

短稿任务 `textvideo-short-20261013`；全文任务 `textvideo-full-20261013`。原始请求、响应、后台事件、发行证据及回调记录保存在 `.candidate/textvideo-studio/`。

本记录初版时，短稿 Analysis 正在执行，全文 Analysis 已受理；真实 Render、完整视频、成片修改及连续视听均未完成。后续按实际证据补充，不用静态测试或握手成功替代业务结果。未执行整个旧测试套件，也未完成正式前端联调。

失败时保留原 run 和诊断；未知外部结果不能换键重放。受控停服后才切换发行；不覆盖旧数据库、工程和已发布视频。

## 0.1.1 修复与短稿分析结果

0.1.0 首个 Analysis 因 `context` 返回对象而校验失败。根因是提供给后台的 result-schema.json 只是字段说明，没有表达真实字段类型。0.1.1 改为从 Zod 校验器生成 JSON Schema，明确 context 为非空 Markdown 字符串，并校验分镜正文按顺序拼接后逐字等于输入。渲染请求登记也纳入串行队列，避免同键并发重复提交。

0.1.1 Release：`release-1060eeefb29c3cccd668ef61aa44c2bb9a0c22fa7c847a816228ebd2a579af2f`。类型检查、17 项生产测试、构建和发行校验均通过。通过官方安装流程切换，旧失败/取消记录仍在。

短稿任务 `textvideo-short-011-20261013` 的 Analysis run `8ec60252-7152-4782-ace6-6f0da7abb43e` 已成功：4 个分镜，32 秒为估算值；原文拼接一致；签名回调首轮 delivered。Render run `95ca8fb0-80a4-4e74-8c7f-07b2c95c84f0` 已受理，尚未完成。本轮完整稿任务为 `textvideo-full-011-20261013`，Analysis run `89885446-26c2-4f1d-9d38-0df5770ffc34` 正在执行。

独立身份核验原始证据：`.candidate/textvideo-studio/plugin-identity-check.json`。新插件为 0.1.1，原用户插件仍为 VideoFlowCut 0.1.82，旧仓库插件目录与 HEAD 内容一致。

全文 Analysis 已成功，正文按顺序拼接与用户输入逐字一致。全文 Render run 为 `58e6ef9b-3533-44d0-8cb5-6ffefae13eb0`，已受理；短稿 Render 正在执行。两阶段视频交付尚待验证。

## 0.1.2 多代理事件修复

短稿旧 Render `95ca8fb0-80a4-4e74-8c7f-07b2c95c84f0` 确定失败：执行器没有筛选 threadId/turnId，把导演子代理的自然语言初审当作主任务 JSON 交付。原短稿九段豆包音频均成功，提交正文完整拼接一致，实测合计 26.472 秒；没有产出正式视频。全文旧 Render 在未产生配音时明确取消。

新增 `turn-events.ts`，只收集主线程目标 turn 的消息和完成通知，忽略子代理和旧 turn；补两项事件顺序回归。音频工具增加同任务显式 `reuseRunId/reuseJobId` 引用，仍强制验证账号、任务、状态、参数及摘要；测试确认已失败制作中的成功音频能复用，unknown 不能复用或重新请求供应商。

19 项生产测试通过。0.1.2 Release 为 `release-31f06994b287c0e65dd2c7d0a40f1335f34bd56b50efb898ad8ea0c9be56ebdf`，Skills 摘要为 `17feceedb95e67108ede188b1f354633c61543117202a7595e8cbde46927821f`。受控停止后通过官方安装切换，保留原记录及成功 Analysis。

新增明确技术复测请求，没有复活终态旧 run：短稿 `75d03f9f-185e-4e4b-b34c-7599d99321aa`，全文 `fd4c4320-ab92-496b-be91-ce1539ae5baa`，二者仍属于原各自 task、引用原成功 Analysis。复测要求显式列出短稿成功配音引用，避免重复收费。此处不把技术复测声称为成功成片修改链。

## 0.1.3 候选发行检查

0.1.2 的本地词法查询发现发行打包缺陷：视频被排除，但机制 Markdown 仍声明 clip 文件，加载索引时因缺文件拒绝整库。0.1.3 仅在生成的发行副本移除未携带的视频引用和切片章节，保留机制正文、静态分镜并重新派生索引；不改原始参考库，也不把约 700 MB 视频切片加入插件。工具不再返回不可用的视频路径或旧预览服务地址。发行校验现在从已打包的资源实际执行查询和图文读取。

0.1.3 同时把健康检查改为 configurationReady 与 productionReady 分开；后者在未进行真实能力探测时为 null，避免配置存在被误报为生产就绪。

候选最终 Release：`release-4e6a1708868b9dae3919d5a42ac1eb7e3b70dd099497eb60b26d554810b4ddbd`，待安装目录 `.candidate/textvideo-studio/marketplace-013-final`。类型检查、19 项测试和实际发行资源检查通过。当前短稿仍由已安装 0.1.2 执行，不在活动制作中热切换；全文排队项已明确取消，待切换后继续技术复测。

## 0.1.4 渲染输入冻结修复

短稿 `75d03f9f-185e-4e4b-b34c-7599d99321aa` 的整片和四分镜已通过插件渲染并完成技术检查，但在随后保存审片记录后，工作工程摘要改变，发布被 SOURCE_CHANGED 拒绝。失败记录和真实渲染文件保留，不称为成功交付。

0.1.4 正式渲染前将输入复制到独立 `render-snapshots/<renderRequestId>/project`，从该快照编译渲染；内部 delivery 包含 renderRequestId，发布只核对实际渲染输入快照，成功后保存 source-snapshot 供修改。工作工程中的后续审片记录不改变已渲染源码身份。代价为每次正式渲染保存一份独立工程快照；不复制 node_modules 和 .cache。协议测试加入导出后写审片记录的实际场景。

0.1.4 包含 0.1.3 候选中的词法发行与健康语义修复；0.1.3 没有作为活动 Runtime 部署。当前 Release：`release-d377d9dccfbd9cfe8645a09f73eee1ffbba05869123605a8a4520375551138e0`。类型检查、19 项测试、构建和发行图文检索均通过。

实际复测 run：短稿 `204995d1-5888-4ca5-86a3-e49918ba2a9a`，全文 `935a1697-aa06-4bdb-924a-9a92915c7220`；原 task 和成功 Analysis 保持。短稿明确接回已经完成的工程和九段成功声音，经新插件重新渲染发布；不复制旧视频冒充新结果。

## 0.1.4 短稿两阶段真实闭环

短稿 Render `204995d1-5888-4ca5-86a3-e49918ba2a9a` 已 succeeded，成功回调首轮 delivered。四条确认分镜返回整片加四分镜共五个文件。客户端逐一下载并核对 SHA-256，五项均通过 GET、HEAD 200、Range 206。九段声音复用已成功音频，没有重新请求豆包。

下载目录：`E:/ai/skills/VideoCutRemotion/delivery/textvideo-studio-20261013/short/`。整片 `whole-video.mp4` 为 6,042,011 字节，SHA-256 为 `3535bb1408ec042767df0760d6d8f79fe5bc2fda6c5b6e55a8a09cee3a42800c`。逐文件报告见该目录 `download-report.json`。

本轮 Analysis 使用 0.1.1、Render 使用 0.1.4，属于保留成功分析的升级后制作复测，不称为单一版本从零完成全部验收。作者完成采样帧及技术检查，未完成全片连续听音。原 SOURCE_CHANGED 失败保留；0.1.4 从冻结渲染输入成功发布，验证了该修复的真实链路。

2026-10-13 再次核对独立身份，`plugin-identity-check.json` 已更新至 0.1.4；原正式 VideoFlowCut 仍为 0.1.82，仓库旧插件目录与 HEAD 一致。短稿纯视觉修改验收 run 为 `ee78a2c3-7f9e-41d8-944d-773c63711c8d`，指定上述成功版本为基础，目前排队；只提交成功不能算修改验收通过。

短稿五个下载文件均通过 FFmpeg 完整解码，整片容器实测时长为 31.957333 秒；视频画面为 1920×1080、30fps。AAC 封装尾部可能让容器时长略长于帧区间，不能混同为新增画面。探测原始结果见 `short/media-check.json`。

## 补充协议与故障测试

新增模拟平台测试后，类型检查及 20 项生产相关测试通过。HTTP 集成测试进一步注入发布目录故障和发布后登记中断，两次恢复均不增加 stub 制作调用次数，后者也不改变已发布文件修改时间。这里的制作执行器为明确 stub，不作为真实视频审美证据。

模板替换测试实际重打 ZIP：旧 Analysis 对应 Render 仍使用原摘要，新任务 Analysis 取得新摘要。交接身份、缺分镜、正文变化和文件摘要变化均拒绝发布。实际安装服务上的并发原样重发、历史 Analysis 重发、错误基础版本和跨任务引用拒绝另见 `.candidate/textvideo-studio/live-protocol-check.json`。

`scripts/production-simulator.mjs` 新增 `template-attempts.jsonl`，保存下载模板 ID、时间、大小及摘要。独立测试目录可用 `fault-config.json` 启用以下单次场景配置；清空为 `{}` 恢复正常：

```json
{"templateStatus":404}
```

```json
{"callbackStatus":429}
```

```json
{"callbackResponse":"drop-after-persist"}
```

callbackResponse 还支持 `non-json` 和 `business-reject`。这些是本地模拟平台控制项，不是正式生产 API。独立测试验证了回调落库后丢响应、同 eventId 重投及只保留一个接收结果；活动制作的模拟平台未注入故障。辅助脚本不属于插件 Runtime，0.1.4 制作进程未热替换。

其余实际排队项：短稿正文微调 `aa652fe6-07c0-48c0-8e8d-53165a4e83a0`；第二模板 Analysis `f943e916-3c0f-4da6-b9f7-95698636b775`。第二模板是本次独立验收夹具“结构解说”，1280×720 单人旁白，具有不同的固定外壳要求；不是把财经模板改 ID 冒充另一模板。短稿微调仅用于验收版本，不改变用户完整原稿测试。

## 片尾视觉缺陷与测试续接

全文导演对照真实预览和原片尾，发现片尾仍残留正文主持人卡。主任务查看已发布短稿 31 秒帧也确认此问题（`delivery/textvideo-studio-20261013/short/check-outro.png`）。因此，短稿技术发布闭环成功不等于画面验收通过；该基础版本作为审计样本保留。

尚未执行的旧视觉修改 `ee78a2c3-7f9e-41d8-944d-773c63711c8d` 和正文修改 `aa652fe6-07c0-48c0-8e8d-53165a4e83a0` 均已经正式 API 明确取消，没有发生配音和渲染。新的纯视觉修改兼片尾返修 run 为 `e7a06a4d-115f-4411-b0cf-8b36560f3aac`，planVersion 7，基础仍明确引用已发布的短稿。它会复用全部原配音，补查片尾首、中、末帧。正文微调将在此修正版成功后明确引用该版本，避免沿旧工程重新引入缺陷。全文由其原作者在当前 run 内修订，无须另起 run。

## 全文真实两阶段结果

用户完整稿任务 `textvideo-full-011-20261013`，成功 Analysis 为 `89885446-26c2-4f1d-9d38-0df5770ffc34`，Render 为 `935a1697-aa06-4bdb-924a-9a92915c7220`。Render 已 succeeded，resultVersion 1，成功回调 delivered。Analysis 使用 0.1.1，Render 使用 0.1.4，版本边界如实保留。

10 镜、36 段真实豆包音频，提交配音正文按场景及顺序逐字核对一致，音频合计 135.744 秒。完整画面 4293 帧、30fps、1920×1080，即 143.1 秒；整片容器实测 143.146667 秒。片尾残留已由本 run 原作者修复，原稿未改写。

下载目录：`E:/ai/skills/VideoCutRemotion/delivery/textvideo-studio-20261013/full/`。

- `whole-video.mp4`：19,194,177 字节；SHA-256 `fec42894a47451b126d9e12636c266329d34178c9c7c8fb1bef4bdc7eeccfc2a`。
- `scene-001.mp4` 至 `scene-010.mp4`：全部对应确认分镜及全局帧范围。
- `download-report.json`：11 个文件均通过 SHA-256、GET、HEAD 200、Range 206。
- `media-check.json`：11 个实际下载文件均完成解码，包含各自音视频规格和时长。

工程与原始证据：`.candidate/textvideo-studio/data/tasks/68c7f7eb-1221-492d-8941-aac8d7d04743/runs/935a1697-aa06-4bdb-924a-9a92915c7220/`。`source-snapshot/` 是实际渲染输入的可校验快照，`project/` 还保留后续导演和声音审查记录。独立正文核对见 `.candidate/textvideo-studio/full-speech-check.json`。

实际观察覆盖：多轮代表帧、预览视频抽帧、最终整片 12 个关键切口，以及主任务独立查看的 77 秒和 142 秒帧。片尾交界、首中末帧无正文残留。最终音轨完整解码，-20.8 LUFS、真峰值 -6.6 dBFS，未检出持续至少 0.5 秒且低于 -50 dB 的静音。未连续看听全片；后台独立音频 validator 曾受子进程权限限制，不能说该脚本通过，直接解码测时与其他技术检查另有记录。

后续主任务在本地验收环境，使用修正 Windows 路径判断的 validator，对**实际渲染 `source-snapshot`** 内确认稿、TTS、时间轴和声音执行完整句级审计，十镜通过。报告为 `full/sentence-audit.json`，原始日志为 `.candidate/textvideo-studio/full-sentence-validator.log`。这是独立补核，不改写后台原失败记录，也未修改渲染快照或视频。

## 模板整理脚本的缺陷回修

`scripts/prepare-finance-template.py` 回修两个已在真实制作发现的问题：正文 Sequence 在片尾起点卸载，防止高 z-index 主持人卡残留；音频校验用相对路径与系统分隔符判断边界，避免 Windows 合法路径被误拒。原共享模板未改，当前冻结包未替换。

新整理包版本为 2.0.1，候选文件 `.candidate/textvideo-studio/finance-template-201.zip`，34,812,963 字节，SHA-256 `19fa9c19cf81753de66358fb135c0a58b6e4d2fb657bed271c93a043a3f602ec`。该包通过 TypeScript、服务清单与声明路径校验；其中校验器已对上面的真实全文快照通过十镜审计。新包未作为当前全文的冻结输入，不把它称为已完整重跑的新模板成片。辅助模板脚本不属于插件 Runtime，本轮 Runtime 仍是已验证的 0.1.4。

## 指定成功成片的纯视觉修改结果

短稿修订 run `e7a06a4d-115f-4411-b0cf-8b36560f3aac` 已成功，resultVersion 2，回调 delivered。基础为原短稿 resultVersion 1。九段配音全部验证复用，作品源码只修改第二镜应用到奖杯连线的黄色强调，以及片尾正文层退出；原片头、片尾、正文和时序不变。

目录 `delivery/textvideo-studio-20261013/short-revised/` 中五个文件均通过下载摘要、HTTP 协议和完整解码；所有五个文件解码后的 PCM 音轨与各自基础版本逐字节一致。旧版五个发布 URL 已重新读取，摘要仍与修改前一致，记录于 `revision-check.json`。新整片 `whole-video.mp4` 为 6,039,544 字节，SHA-256 `ac8569e55af6845d035ed98c0bb780d1db6c13c834f417a9a2931d1fc9849540`。

导演检查真实帧和视频抽帧，主任务另查最终下载整片31秒帧，确认片尾没有主持人卡。未连续听音。此版本是目前可用的短稿修正版，原版保留作为缺陷及不可变版本证据。

正文微调后续 run 为 `fcaf09f6-4344-4255-99d1-c58e545ce5fa`，明确引用此成功修订版。测试仅将第四镜“全民恐慌”替换为“广泛而持续的恐慌”，要求只重新配受影响的一段，其他八段使用确切基础 Job 引用复用；用户全文测试不变。该请求已受理，尚未完成。

## 第二模板真实两阶段结果

独立夹具“结构解说”成功 Analysis 为 `f943e916-3c0f-4da6-b9f7-95698636b775`，Render 为 `4af66413-068a-444d-9e9d-6c6be6482c3a`，两阶段均由 0.1.4 插件执行且回调 delivered。其固定外壳为 1280×720、30fps、单人声音、深蓝底及顶部青线，无财经头像、片头片尾或配乐。三段真实声音合计 6.168 秒，视频 187 帧，约 6.233 秒。

下载目录 `delivery/textvideo-studio-20261013/structure/`：整片及三个分镜共四个视频，全部通过摘要、HTTP GET/HEAD/Range 和完整解码；整片 403,558 字节，SHA-256 `2b917b7ba0679a8d81c42ba0329e8aa58aea8881189d5fed61e3bde13b12e23b`。原作者和导演检查关键帧，主任务独立查看下载整片 5.5 秒画面，品牌、图解、字幕清晰且未见遮挡。仍未连续视听。

平台同 ID 包替换后，此 Render 最终仍使用旧冻结摘要 `2e141aa8f5d1d97c179c6fb368cb993a04268736c426b265a7746df20996b9b2`，没有被新版模板替换。完整工具与声音证据见该目录 `execution-audit.json`；实际调用只出现 `textvideo-studio`。

## 续验自动测试与运行隔离

补充真实 HTTP 回调故障测试，覆盖 429、超时、非 JSON 重试、业务拒绝死信及手工重投；保持相同 eventId、原始 body 和成功执行结果。21 项生产相关测试通过（含四项旧门面测试），类型检查通过。日志仍为 `.candidate/textvideo-studio/production-tests-final.log`。

使用已安装发行启动器再次请求启动，明确拒绝同一数据根的第二 Runtime，前后锁记录一致；当前 0.1.4 健康查询正常，证据 `.candidate/textvideo-studio/duplicate-start-check.json`。这不是停服重启测试；健康查询仍只有配置检查，`productionReady=null`。

## 同 ID 模板更新隔离结果

在第二模板旧 Analysis 成功后，模拟平台将相同 `customTemplateId=structure` 的 ZIP 从 `structure-test-1` 替换为 `structure-test-2`，固定品牌改为“结构解说·新版”。原 Analysis 原样重发返回原 run，旧冻结归档摘要不变，旧 Render 最终使用旧包。

新任务 `textvideo-structure-v2-014-20261013` 的 Analysis `5efacb5e-b6a5-4308-9102-75cb07eaae5c` 已成功，回调 delivered；冻结版本确认为 `structure-test-2`，摘要为 `c22c7128bbf31487d282e5562dd398fffc493cf67013cd14a50706d6e469db49`。原始核验记录 `.candidate/textvideo-studio/template-update-check.json`，满足本地真实发行的模板新旧隔离测试。此新版任务只分析，不另行配音或渲染。

## 单句修改的最终结果

短稿修改 run `fcaf09f6-4344-4255-99d1-c58e545ce5fa` 成功，resultVersion 3、回调 delivered；基础明确为 `e7a06a4d-115f-4411-b0cf-8b36560f3aac` 的 resultVersion 2。只将第四镜“全民恐慌”替换为“广泛而持续的恐慌”，未改用户全文任务。

实际九个配音 Job 全部成功：八段以基础 Job 的文本、音色、语速和摘要验证复用，只有 `scene_004_phrase_02` 请求新配音，实测 4.416 秒。九段文本及实际渲染快照中的声音清单与本次确认正文逐字一致；时长由 957 帧增至 974 帧，30fps 下约 32.467 秒，片尾顺延 17 帧，片尾本身仍为 67 帧。

下载目录 `delivery/textvideo-studio-20261013/short-text-revised/` 含整片及四个分镜，五个文件均通过 HTTP GET/HEAD/Range、摘要和完整解码。整片 6,154,926 字节，SHA-256 `ec921d502907445a8667e10b774bf9ada3fddf5be639a7c5a42a022378f40ad0`。

独立复核前三镜解码 PCM 与基础一致，第四镜音轨按新句改变；基础版五个已发布 URL 重新下载后摘要全部不变。`revision-check.json` 保存上述断言，`execution-audit.json` 保存真实发行、MCP、九段声音和源码快照引用。实际 MCP 调用仅为 `textvideo-studio`。

导演检查了实际预览视频抽帧；主任务另查看最终下载整片约 28.333 秒和 31.333 秒，确认新增文字未溢出、片尾无正文主持人残留。未连续看听。声音作者未及时完成清单落盘，后台主任务结束其任务后接手补齐，不以委派记录替代实际文件，最终工程冻结后再正式渲染。

交付入口为 `delivery/textvideo-studio-20261013/交付说明.md`。本轮队列中的第二模板、新包 Analysis、单句修改均已终态成功；取消的历史请求保持取消，不重放。
