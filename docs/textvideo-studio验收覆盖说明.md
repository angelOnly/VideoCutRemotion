# 文稿视频工坊验收覆盖说明

本记录区分源码自动测试、已安装插件上的真实业务结果和尚未检查的场景。测试名称含有方案编号，只代表该测试中实际断言的范围，不代表该编号下所有故障组合均已覆盖。

## 已取得的证据

| 范围 | 实际检查 | 证据位置 |
| --- | --- | --- |
| T01–T07、T22、T24、T30–T32 | 请求校验、历史分析引用、稳定摘要、账号及任务隔离、串行领取、终态重发、数据库重开；已安装服务额外验证并发重发和非法引用拒绝 | `tests/production-repository.test.ts`、`production-http.test.ts`；`.candidate/textvideo-studio/live-protocol-check.json` |
| T08 | 自动测试实际替换 ZIP；已安装插件执行旧 Analysis、平台同 ID 更新、旧 Render、新任务 Analysis，核对新旧摘要 | `.candidate/textvideo-studio/template-update-check.json` |
| T09 | 自动测试拒绝越界、损坏 ZIP；模拟平台支持下载 404 注入 | `tests/production-http.test.ts`、`production-simulator.test.ts`；未覆盖全部下载中断和缺声明组合 |
| T10–T12 | 拒绝交付身份、分镜数量、正文及摘要错误；发布目录故障和文件发布后登记中断恢复，stub 制作调用次数及文件修改时间不变 | `tests/production-http.test.ts`；这是隔离故障测试，未破坏活动制作目录 |
| T13–T15 | 500、429、超时、非 JSON、业务拒绝、死信重投；原 eventId 和 body 不变；模拟接收端持久化后丢响应并去重 | `tests/production-callback.test.ts`、`production-simulator.test.ts` |
| T16 | 同任务串行、unknown 阻塞、错误执行令牌拒绝回写 | `tests/production-repository.test.ts`；未完成真实进程崩溃与租约到期组合 |
| T17、T28 | 配音提交幂等、同键冲突、unknown 不再次请求供应商、截断响应诊断 | `tests/production-speech.test.ts`、`production-lexical.test.ts`；真实付费请求未故意断网 |
| T18、T26 | 自动测试取消保持旧成功结果；已安装服务执行排队取消及原样重发不复活，历史运行取消记录保留 | `.candidate/textvideo-studio/queued-cancel-check.json`；未独立核验全部运行中子进程树退出场景 |
| T20 | 真实视频 GET、HEAD、Range 和摘要；自动测试越界范围 416、不能访问 publication.json | 各交付目录 `download-report.json`、`tests/production-http.test.ts` |
| T21、T29 | 实际 MCP 仅加载独立生产服务；词法检索、阶段门控、真实配音与渲染记录；Analysis 不生成声音 | 各 run 的 `plugin-evidence.json`、`codex-instruction.txt`、日志；`tests/production-lexical.test.ts`、`production-speech.test.ts` |
| T23、T25、T27 | 真实纯视觉修改九段声音复用、五个成片 PCM 与基础一致；单句修改八段复用一段新生成、时序增加17帧、前三镜PCM不变、旧URL摘要不变；自动测试基础工程缺失明确拒绝 | `delivery/textvideo-studio-20261013/short-revised/`、`short-text-revised/revision-check.json` |
| D01、D02、D05 | 独立目录官方安装 0.1.4；后台 App Server 实际使用插件完成全文、短稿和第二模板 | `docs/textvideo-studio部署与验收记录.md`；各交付目录 `execution-audit.json` |
| D03 | 再次启动拒绝同数据根第二 Runtime，锁记录不变；多个后台会话运行于同一服务 | `.candidate/textvideo-studio/duplicate-start-check.json` |
| D07 | 本轮经受控停止完成 0.1.0 至 0.1.4 修复切换，旧任务与声音仍可查并复用，保存各版发行摘要 | 部署记录的历史版本段落与原始客户端记录 |

自动测试最终为 21 项全部通过，其中四项是原项目门面测试。类型检查、插件摘要校验通过。活动发行仍为 0.1.4；补充测试和模拟平台脚本没有热替换活动 Runtime。

## 尚未完成的验收

- T19 需要真实前端验证旧回调迟到时的展示策略；本轮没有正式前端。
- D04 的全部缺依赖、错凭据组合，D06 的实际停服与受理响应丢失组合，D08 的关闭桌面应用后存活检查未完整执行。已验证的 SQLite 重开、回调及 HTTP 媒体行为不能替代这些整机场景。
- T09、T16、T18 上述未覆盖组合仍保留，不将接口或源码层测试扩大为进程级验收。
- 没有完整连续观看和听音记录。关键帧、局部视频抽帧、完整解码、实测时长、响度和句级音频审计均已分别保存，但不能据此宣称完整声画体验验收通过。
- 财经模板整理器的新 2.0.1 候选包通过静态及已有成片快照的校验器验证，尚未以该新包从 Analysis 起完整重跑。

本轮交付为独立插件、本地真实两阶段业务闭环、测试视频和可追溯证据；不是正式前端上线或完整故障矩阵验收报告。
