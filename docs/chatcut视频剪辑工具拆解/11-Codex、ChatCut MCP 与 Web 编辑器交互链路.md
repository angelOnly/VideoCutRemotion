# 11｜ChatCut Web 原生 Agent、Codex 与 MCP：两个 Agent 怎样围绕同一项目协作

> 本篇定位：拆解 ChatCut 的 Hosted Web / Agent Plugin 路径中的身份、状态、控制面和交接边界。它不从少量外部接口反推 ChatCut 的私有队列、素材证据库或原生 Agent 内部架构；具体实测和连接状态统一放在第 08 篇。

## 先用一句大白话说清楚

ChatCut 里至少有两种完全不同的“会帮你剪片的 Agent”：

1. **ChatCut Web 原生 Agent**：用户在 ChatCut Web 编辑器的 AI 面板里对话、@ 某条素材或某段文字稿，由 ChatCut 自己的 Web 产品处理。
2. **Codex 外部 Agent**：用户在 Codex 中对话；Codex 读取 ChatCut 插件提供的 Skill，再通过 Hosted MCP 读写 ChatCut 项目。

它们可以围绕同一个 ChatCut 项目协作，但目前没有证据表明它们共享同一段聊天、同一份推理过程、同一个任务 ID，或同一份剪辑计划。

最准确的比喻是：

> 它们像两位拿着不同工作笔记的剪辑师，能打开同一个项目文件；不是一个 Agent 的两个窗口。

## 阅读本篇时，先区分四种结论

| 标记 | 它代表什么 | 例子 |
| --- | --- | --- |
| **已实测** | 本轮通过当前 ChatCut Hosted MCP、项目读回或浏览器实际观察过。 | MCP 可以读写同一个项目；本轮检查的 manifest 没有原生聊天调用工具。 |
| **官方 UI / Skill / MCP 合同明确** | ChatCut 对外说明或工具合同直接写明的能力。 | Web 有 AI Panel、Agent 模式、@ 引用；MCP 有项目、素材、文字稿和时间线读写面。 |
| **合理推断 / 协作建议** | 为了避免两个入口互相踩状态，基于已知接口提出的安全做法。 | 切换编辑者前重新读目标时间线范围。 |
| **未验证** | 外部文档和实测都不足以证明的内部实现。 | Web 原生 Agent 用什么模型、怎样抽帧、是否有向量库、怎样调度 Skill。 |

后面的“Agent”“理解素材”“调度”等词，都必须带着这四层边界来读。

---

## 1. 先把总图改正：不是一条链，而是两条入口汇入同一个项目

~~~mermaid
flowchart TB
    U1[用户：ChatCut Web 中提需求] --> W[ChatCut Web AI Panel / 原生 Agent]
    U2[用户：Codex 中提需求] --> C[Codex 外部 Agent]

    W -->|ChatCut 内部路径：未公开| P[同一个 ChatCut 项目]
    C --> S[ChatCut Plugin Skills：给 Codex 的工作方法]
    S --> C
    C --> M[Hosted ChatCut MCP]
    M --> P

    P --> E[Web 编辑器：素材库、文字稿、Timeline、预览]
    E -->|用户手动修改| P

    W -. 当前未证明可读 .-> C
    C -. 当前未证明可读 .-> W

    classDef native fill:#355c7d,color:#fff,stroke:#243f56
    classDef external fill:#6c5b7b,color:#fff,stroke:#463b50
    classDef project fill:#2a7d5f,color:#fff,stroke:#1c513e
    class W native
    class C,S,M external
    class P,E project
~~~

这张图最重要的两条线是：

- **实线**：可以从公开合同或实测中确认的项目读写关系。
- **虚线**：没有工具合同或实测支持，不能假装存在的“两个 Agent 直接互通”。

尤其要避免写成下面这种误解：

~~~text
错误理解：
ChatCut Web Agent → 把素材理解结果交给 Codex → Codex 调 ChatCut MCP

目前没有这条已证实链路。

已证实的最小链路：
Codex → Hosted MCP → ChatCut 项目 ← ChatCut Web Agent / 用户在 Web 的操作
~~~

---

## 2. 五个角色各自负责什么

| 角色 | 它实际面对什么 | 已知职责 | 不应把它误写成什么 |
| --- | --- | --- | --- |
| **ChatCut Web 原生 Agent** | Web 的 AI Panel、用户消息、@ 引用、项目工作区。 | 官方 UI 说明它会读取消息、理解上下文并执行编辑任务；口播场景对外承诺可选 take、剪口癖、收紧节奏、加 MG。 | 不能写成“它一定调用了和 Codex 一样的 MCP / Skill / 证据库”。 |
| **Codex 外部 Agent** | Codex 对话、用户目标、ChatCut Skill 文本、MCP 返回。 | 选择何时读项目、何时读取文字稿或局部画面、何时写入、何时复核；也承担外部 Agent 的剪辑判断。 | 不是 ChatCut Web 原生 Agent 的远程分身。 |
| **ChatCut Plugin Skill** | 给 Codex 的 Markdown 工作说明。 | 告诉 Codex 先后顺序、风险、验证规则和专业剪辑方法。 | 不是后台服务，不会自己抽帧、转写或调用 MCP。 |
| **Hosted ChatCut MCP** | 认证后的远程项目接口。 | 读取或修改项目事实，启动或追踪某些异步任务，返回结构化结果。 | 不是“导演大脑”；当前也没有公开的原生 AI 聊天桥接接口。 |
| **ChatCut 项目 / Web 编辑器** | 可编辑的 Asset、Timeline、Track、Item、字幕和可见预览。 | 保存当前剪成什么样，并让用户在 Web 中看、听、继续改。 | 不是 Codex 的聊天记忆，也不是 Web Agent 的完整推理日志。 |

### 2.1 “Codex 剪辑编排层”到底是不是 ChatCut 设计的？

这个词很容易造成歧义，应该拆成两句话：

- **ChatCut 设计并提供了外部协作合同**：插件内的 Skill、Hosted MCP、项目模型、编辑器交接规则，都会约束 Codex 应怎样操作 ChatCut。
- **Codex 在自己的会话里执行判断与工具调用**：模型如何阅读当前用户对话、如何结合 Skill、如何决定下一步调用哪一个 MCP，是 Codex 这个外部 Agent 的执行过程。

所以，文档中“Codex 剪辑编排层”只是一个**外部协作角色**，不是已经被逆向确认的 ChatCut 内部微服务，也不是 ChatCut Web Agent 的另一个名字。

更准确的关系是：

~~~text
ChatCut 提供：项目、工具合同、操作方法和可见编辑器
        ↓
Codex 使用：这些合同来完成外部 Agent 的判断、调用和复核
        ↓
ChatCut 项目保存：最终可编辑的时间线事实
~~~

---

## 3. ChatCut Web 原生 Agent：公开知道什么，不知道什么

### 3.1 已公开的 Web 工作面

官方 UI 说明里可以确认，ChatCut Web 有：

- AI Panel，其中包含 **Agent** 模式；官方描述为“AI 读取消息、理解上下文并执行编辑任务”；
- 用户可在输入框中用 **@ 引用** 特定 Timeline Item、素材、某个时间点或文字稿选区；
- Skills 选择器，用户可选预设 Skill 或保存自己的 Skill 来指导当前消息；
- 口播剪辑场景，对外描述为：选最佳 take、删除填充词、收紧节奏、添加 MG；
- 文字稿面板：用户通过删词删句影响口播/访谈的时间线；Agent 修改时，删除结果会在该面板中显示为删除线；
- 生成中的素材会在“素材库”显示进度或失败状态。

这说明 Web 原生 Agent **确实是 ChatCut 产品本身的一个用户入口**，而不是 Codex 产生的界面幻觉。

### 3.2 Web 原生 Agent 接到的上下文，能确定到什么程度？

@ 引用非常关键。它不是让 Agent 猜“你说的是哪一段”，而是把用户明确指向的对象带进 Web 对话上下文，例如：

~~~text
“把 @这个 Timeline Item 缩短”
“在 @这句文字上加一个强调动画”
“从 @这个时间点开始换画面”
“删掉 @选中的这段文字稿”
~~~

因此，Web 原生 Agent 至少能得到“用户指的是哪个项目对象 / 哪段文本 / 哪个时间点”这一类有边界的上下文。

但下面这些内部过程没有被公开：

- 它是否先对整条视频做抽帧；
- 它使用什么语音识别、镜头切分或视觉模型；
- 它是否保存了向量检索库或“素材证据包”；
- 它怎样把用户意图分解为剪辑计划；
- 它是否、何时、以何种方式调用内部 Skill；
- 它的聊天任务 ID、推理过程、重试和冲突处理机制。

因此，不能从“Web 有 Agent 按钮”倒推为一套已经证实的内部导演系统。

### 3.3 Web 的 Skill 和 Codex 插件的 Skill，不能默认等同

Web UI 的 Skills 选择器说明：Web Agent 可以被预设或用户保存的工作流引导。

Codex 插件目录里的 Skill 说明：Codex 在使用 Hosted MCP 时应遵守哪些方法和边界。

两者概念相似，都是“给 Agent 的可复用工作方法”，但目前没有证据证明：

- 两边读取的是同一份 Skill 文件；
- 同名 Skill 的内容完全一致；
- Web Agent 也会暴露相同 MCP 工具；
- Web Agent 的一次调用过程能被 Codex 看见。

因此，本篇将它们分别称为 **Web Skill 选择器** 与 **Codex 插件 Skill**，不再混称为“同一套 Skill”。

---

## 4. Codex 外部 Agent：它不是只会选工具的空调度器

用户提出的理解有一半对、一半需要修正：

> “Codex Agent 是不是只判断要调用什么 Skill，再由 Skill 自动调 MCP？”

正确答案是：**Skill 不会自动执行；Codex 既做调度，也做编辑判断。**

### 4.1 三层不是一回事

~~~mermaid
flowchart LR
    A[用户目标<br/>“剪成 60 秒访谈精华”] --> B[Codex Agent]
    B --> C[读取合适的 Skill<br/>方法、限制、检查点]
    C --> B
    B --> D[调用 MCP<br/>读 / 写 / 启动任务 / 查询状态]
    D --> E[ChatCut 项目事实]
    E --> B
    B --> F[下一轮判断<br/>继续、复核、等待、询问用户]
~~~

| 层 | 具体做什么 | 它不会做什么 |
| --- | --- | --- |
| **Skill** | 例如告诉 Agent：先让文字稿就绪，先稳住 A-roll，再做字幕、MG、音乐；重大阶段要复核。 | 不会自行运行代码，不会在后台“自动调 MCP”。 |
| **Codex Agent** | 理解用户目标，阅读当前项目事实，选择用哪些 Skill，把 Skill 变成当前项目的具体判断和下一次工具调用。 | 不拥有 ChatCut 项目数据库，也不应凭空假设隐藏 ID 或旧时间线仍有效。 |
| **MCP** | 根据工具合同读取或写入项目、启动或查询异步任务，返回结果。 | 不会替 Agent 决定“这句话是否值得保留”“这个音效是否合适”。 |
| **ChatCut 项目** | 保存素材、轨道、Item、文字稿、字幕等可编辑事实。 | 不自动把这些事实解释成用户意图或完整导演思路。 |

### 4.2 Codex 怎么判断“保留什么、删什么”？

这不是一个 MCP 的固定算法，也不是只靠“某个工具返回 success”就能完成。以口播/访谈为例，外部 Codex Agent 的合理工作方式是：

1. **先拿到目标**：例如时长、受众、平台、要保留的观点、是否要紧凑或正式。
2. **读取能支撑判断的项目事实**：先确认目标项目和素材，再读取文字稿、脚本或指定范围；必要时看局部源画面或合成预览。
3. **根据 Skill 的编辑方法做取舍**：例如去掉重复起句、口癖、无效停顿；保留让观点成立的前因后果；选择更完整、更自然的一次 take。
4. **把取舍写成可编辑的项目变更**：口播语义编辑优先走 Script 工作流，而不是从头到尾手工删 Item。
5. **读回并复核下游层**：语义剪辑改变了口播时间后，再检查字幕、MG、B-roll、音乐是否仍对齐。

其中第 3 步是 Agent 的编辑判断；第 4 步是 ChatCut 的受控项目写入。二者不能混为“ChatCut MCP 自动导演”。

对 ChatCut Web 原生 Agent，外部只能看到它能完成某些编辑结果；它内部是否也按上述五步工作，**未验证**。

### 4.3 “判断”不等于把所有素材一次性交给模型

当前外部 Codex 路径的 Skill 明确要求：先从项目上下文出发，按需加深，不要默认把完整项目拓扑或全部时间线全读一遍。

这意味着外部 Agent 正确的做法是“先小范围定位，再扩大”，而不是把所有视频帧、所有轨道和全部文本一次性塞进上下文。例如：

~~~text
用户说：“把陈清泉讲电动车安全的那段做成 45 秒。”

先：确认项目和目标素材
再：按文字稿找“电动车安全”附近的语段
再：读该段的 Script / Timeline 范围
必要时：看该段的源画面或合成帧
最后：根据目标取舍并写回
~~~

这是 **Codex 插件 Skill 的工作纪律**。它不证明 ChatCut Web 内部也有相同的检索和上下文压缩实现。

---

## 5. 素材理解：ChatCut 对外暴露的是“受控读取面”，不是已证实的证据库

以前把这一层写成“素材处理 / 证据生产层 → 证据库 → Codex”会产生误导。那种写法像是在描述一个已知的内部系统；对 ChatCut 来说，当前外部证据不够。

### 5.1 外部 Codex 实际可拿到哪些素材事实

| 读取面 | 外部 Agent 能得到什么 | 适合回答什么 | 不能扩大成什么 |
| --- | --- | --- | --- |
| “browse_assets” | 素材列表、类型、状态、部分元数据，以及可按转写文字定位的线索。 | 项目里有什么素材、哪条素材可用、哪个素材可能说过某句话。 | 不是对整段像素内容做任意视觉语义搜索。 |
| “trigger_transcript” + “track_progress” | 转写是否启动、是否仍在处理、是否就绪、是否无音频等状态。 | 能否开始基于文字稿的口播剪辑。 | 不是公开的 ASR 模型、音频预处理或队列架构说明。 |
| “find_transcript” | 文字与源时间 / 时间线时间的对应；可按工具选项取得更细粒度时间。 | “这句话在哪里”“删掉这句会影响什么位置”。 | 不是全项目导演语义图。 |
| “read_script” | 口播语义编辑要用的脚本表面。 | 这段话要不要保留、压缩、重排。 | 不是原始多模态理解的全部中间结果。 |
| “inspect_asset” | 指定源时间附近的文字稿范围、概览帧或精确帧。 | 指定位置画面是什么、说了什么。 | 不是一个可自由检索的视觉向量数据库。 |
| “preview_timeline” / 合成帧读取 | 时间线轨道、Item、字幕、局部合成结果。 | 最终观众此时能看到什么。 | 不是对原始素材的全面分析。 |

此外，若 Codex 能合法读取用户提供的原始本地文件，插件规则允许它用本地只读能力检查源文件或抽取局部帧；如果素材只存在于用户已上传的 ChatCut Web 项目中，则外部 Codex 应通过“inspect_asset”等受控入口读取，而不是把它当成本地文件随意扫描。

### 5.2 因此，“素材理解是谁做的”要分场景回答

| 场景 | 能确定的事实 | 不知道的部分 |
| --- | --- | --- |
| 用户只在 ChatCut Web 上传，并在 Web Agent 对话 | Web Agent 可能利用项目上下文执行编辑；用户也能通过 @ 引用指定对象。 | 它内部如何处理视频、文字和音频，没有公开。 |
| 用户在 Codex 中使用 ChatCut 插件 | Codex 能通过 MCP 获取转写、局部帧、脚本、时间线等外部事实；也可在有原始文件时做只读源检查。 | ChatCut 是否把这些东西先加工成了统一的多模态索引，没有公开。 |
| 两个入口都操作同一项目 | 两边最终能影响和读取同一份项目事实。 | 它们是否共享“素材理解结果”“推荐候选”“剪辑计划”没有证据。 |

因此，下面两句话都不够准确：

~~~text
不准确：素材理解全是 Codex 自己做的。
不准确：ChatCut 一定先给 Codex 一个完整的预计算多模态证据包。

准确：外部 Codex 通过 ChatCut 对外暴露的文字稿、局部帧、脚本和时间线读取面，逐步取得完成当前任务所需的事实；
Web 原生 Agent 的内部理解链路未公开。
~~~

---

## 6. 同一个项目，不等于同一个聊天任务

### 6.1 共享的是什么

ChatCut 项目是两条路径真正的交汇点。以当前工具合同和项目模型，能作为协作事实的至少包括：

- 项目身份和目标 Timeline；
- 素材库中的 Asset，以及导入、处理、生成后的可用状态；
- Track、Item、源偏移、帧范围、位置、图层关系等时间线结构；
- 文字稿 / Script、字幕和已写入的可见编辑结果；
- 可查询的上传、转写、生成或导出任务状态；
- Web 编辑器看到的同一份项目结果。

### 6.2 不共享的是什么

| 内容 | Web 原生 Agent 与 Codex 外部 Agent 是否已证实共享 | 为什么 |
| --- | --- | --- |
| Web AI Panel 的聊天消息 | **未证实；当前 Hosted MCP 没有读取入口** | 本轮检查的 manifest 没有“read_chat”一类工具。 |
| Web 中的 @ 引用 | **未证实** | @ 引用属于 Web 对话输入上下文，未见对外读取合同。 |
| Web Agent 的任务 ID、计划、思考过程 | **未证实** | manifest 中没有“run_agent”“chat_agent”等原生 Agent 操作入口。 |
| Codex 对话历史、它读过哪些 Skill | **不共享** | 它们属于 Codex 会话上下文，不是 ChatCut 项目事实。 |
| 当前时间线实际内容 | **可共享 / 可读回** | 两边围绕同一项目、Timeline 和 Asset 工作。 |

因此要牢牢记住：

> **同一个 projectId，不等于同一个聊天任务。**

“我已经在 Web 的 AI Panel 说过要剪掉第二段”这件事，Codex 不会自动知道；但如果 Web Agent 已经把第二段从项目中删掉，Codex 在重新读取项目后可以看到**结果**。

### 6.3 用户先在 Web 上传素材，Codex 怎样找到正确任务？

推荐的、可由现有公开接口支持的最小交接是：

~~~mermaid
sequenceDiagram
    participant U as 用户
    participant W as ChatCut Web
    participant C as Codex
    participant M as Hosted MCP
    participant P as ChatCut 项目

    U->>W: 上传素材，或在 Web 创建项目
    W->>P: 保存 Asset / Timeline
    U->>C: 提供项目 editor URL，或明确选择该项目
    C->>M: 用 URL 中的 projectId 定位 / target 项目
    M->>P: 读取项目和素材库
    P-->>M: 返回可访问的项目事实
    M-->>C: Codex 根据项目事实继续工作
    C->>M: 写入已确认的编辑
    M->>P: 保存修改
    P-->>W: Web 编辑器显示同一份修改
~~~

这里 Codex 知道“是哪一个任务”的依据不是猜测文件名，也不是读取 Web 聊天，而是：

1. 用户提供的 editor URL 中的项目身份，或明确指定的项目；
2. MCP 读回的项目和素材库事实；
3. 用户在 Codex 中补充的目标、版本或范围。

如果项目里有多条 Timeline，仍要明确目标 Timeline；“项目相同”也不自动等于“要修改同一条版本线”。

### 6.4 一个实用但尚非 ChatCut 原生功能的交接包

为了让两位 Agent 不靠猜测协作，可以把下面信息放进 Codex 的第一条消息或手工交接说明里：

~~~text
项目：<editor URL / projectId>
目标 Timeline：<长版 / 竖版精华 / 某条序列>
当前阶段：<仅素材已上传 / A-roll 已定 / 等字幕复核>
本次范围：<只改 00:18–00:42 / 只做口播删减>
已做决定：<保留观点、风格、不可改的片段>
下一位要做：<做 MG / 加字幕 / 只验证>
~~~

这是基于现有边界提出的**协作建议**，不是“ChatCut 已经有一个自动跨 Agent 交接协议”。

### 6.5 跨入口交接的架构：要同时绑定三件事

“把 Web 项目交给 Codex”不是只传一个链接。为了不操作错项目、错版本或错范围，交接至少要同时完成三种绑定：

~~~mermaid
flowchart TB
    A[访问身份\n当前账号是否有权读写] --> P[Project 身份\nprojectId]
    P --> T[编辑上下文\n目标 Timeline、版本、范围]
    T --> R[当前项目读回\nAsset、Item、处理状态]
    R --> C[Codex 可开始规划或写入]

    W[Web 上传 / Web 编辑] --> P
    W --> T
    C -. 不自动获得 .-> H[Web 聊天、@ 引用、原生 Agent 计划]
~~~

| 绑定 | 它解决什么问题 | 典型载体 | 少了会发生什么 |
| --- | --- | --- | --- |
| **访问身份** | 当前外部会话是否能读取、写入这个项目 | ChatCut 账号授权与项目访问权 | 不能把“浏览器里看得到”误当成 MCP 也有访问权 |
| **Project 身份** | Codex 到底接手哪个素材库和项目容器 | editor URL 中的 `projectId` / 明确选择 | 不能按最近项目名或文件名猜测 |
| **编辑上下文** | 本轮改哪条 Timeline、哪个版本、哪段范围 | Timeline ID、当前阶段、范围、保护对象 | 同一 Project 内仍可能改到错误版本线 |

**[已实测，当前会话边界]** 2026-08-31 再次调用 `list_projects` 返回 `Auth required`。之后 `codex mcp login chatcut` 虽报告登录成功，但同一已运行会话中的 `mcp__chatcut__list_projects` 仍返回 `Auth required`。这说明“访问身份”不是概念上的第一步，而是实际阻断条件：即使用户浏览器中能打开一个项目，当前 Codex MCP 会话也未必已刷新到可读取该项目的授权。它不能反推出 ChatCut 不支持 Web / Codex 协作，也不能据此猜测内部鉴权实现；本轮“Web 手传后外部 Codex 接手”只能停在身份绑定之前，需在新的可用会话中重测。

三种绑定完成后，外部 Codex 还要读取 Project 与 Asset 当前事实，才能建立自己的工作上下文：

~~~text
Web 上传素材
→ Project 素材库登记 Asset
→ 用户交出 projectId 与目标 Timeline
→ Codex target_project
→ read_project / browse_assets / 必要时 inspect_asset
→ 基于最新事实形成计划
→ MCP 写入
→ Web 编辑器显示同一项目的可编辑结果
~~~

这是一种**项目状态交接**，不是聊天交接。Web 原生聊天、@ 引用、原生 Agent 的计划和推理不会因 `projectId` 自动进入 Codex 上下文；Codex 的对话历史和读取过哪些 Skill 也不会自动写回 Web Agent。需要跨入口协作时，应把“当前阶段、已做决定、目标 Timeline、范围、保护对象、下一步责任”显式写成一份交接包或项目级任务事实。

第 08 篇只负责说明这条交接链哪些环节已经实机读回、哪些仍待验证；本篇只解释为什么它需要这些状态边界。

---

## 7. 两条路径各自怎么走

### 7.1 路径 A：用户只在 ChatCut Web 中和原生 Agent 工作

~~~text
用户在 Web 上传素材
→ 在 AI Panel 发消息，必要时 @ 素材 / 时间点 / 文字稿
→ ChatCut Web 原生 Agent 执行产品内编辑
→ 项目、文字稿、时间线和预览更新
→ 用户在 Web 继续微调或发下一轮消息
~~~

对外可确认的是入口、引用方式和可见结果。中间的“原生 Agent 如何理解素材、如何生成计划、是否分多个内部工具调用”属于未公开部分。

### 7.2 路径 B：用户在 Codex 中让外部 Agent 操作 ChatCut

~~~text
用户在 Codex 指定目标项目和剪辑目标
→ Codex 读取插件 Skill，定位项目
→ MCP 读取 Asset / 文字稿 / Script / 局部时间线
→ Codex 做当前任务的编辑判断
→ MCP 原子写入或启动异步工作
→ Codex 读回结构，必要时查看合成帧
→ ChatCut Web 编辑器显示可编辑结果
~~~

这里的“写入”不是把一个扁平 MP4 传回网页，而应落成可继续编辑的项目状态：原始素材、时间线 Item、字幕、音频、叠层或生成 Asset 仍各自存在。

### 7.3 两条路径交替时，正确的协作节奏

如果用户先让 Web Agent 改了一轮，随后又让 Codex 接手，外部 Codex 应先重新读取相关项目范围；反向交接也是一样。

~~~mermaid
sequenceDiagram
    participant W as Web Agent / 用户
    participant P as ChatCut 项目
    participant C as Codex 外部 Agent

    W->>P: 完成一批 Web 编辑
    C->>P: 重新读目标 Timeline、Script、素材状态
    C->>C: 基于最新事实规划下一步
    C->>P: 写入一批 Codex 编辑
    C->>P: 读回 / 看局部合成结果
    W->>P: 用户在 Web 审看和微调
~~~

这条“先读再写、写后读回”的规则有充分的合同依据：官方插件 Skill 明确要求，用户可能已经在浏览器手动修改项目，非平凡操作前不能依赖旧的 Item ID、轨道结构、素材就绪状态或时间线位置。

---

## 8. 口播 / 访谈里，语义判断、时间线写入和下游复核怎样分工

这一部分最容易被误会成“ChatCut 的 Agent 自动知道一切”。更清楚的拆法如下。

### 8.1 先确定主线：观众最终要听到什么

对语音主导视频，官方 Talking Head Skill 的核心原则是：

> A-roll 的语义和最终语音时序先稳定；MG、B-roll、音乐和字幕都依赖这条最终时序。

所以外部 Codex 路径通常先做：

~~~text
文字稿就绪
→ read_script
→ 判断保留、删减、重排哪些完整语义
→ apply_script 原子提交
→ 读回最终语音时间线
→ 再处理字幕、MG、B-roll、音乐
~~~

“保留什么”由用户目标和 Agent 的编辑判断共同决定；“把它变成最终时间线”由 ChatCut 的 Script / 时间线写入逻辑完成。

### 8.2 Script 为什么比逐帧手工删更像“剪辑”

逐帧删 Timeline Item 只能表达“把这里拿掉”。Script 工作流表达的是“这句要不要让观众听见、这句在新的说话顺序里在哪”。

官方 Skill 对语义口播剪辑的约束是：先读 Script，在清理或语义选择后，以新的 Script 状态作为真相来源，再用语义判断选择更好的 take、清理重说、保留必要上下文、必要时重排。

因此：

- **Code / MCP 擅长**：检查编辑是否可写、提交项目改变、维护项目的帧级时间线事实。
- **Agent 擅长**：判断一句话是不是重复、是否缺前提、哪一次表达更自然、压缩后是否仍说得通。
- **用户擅长**：定义目的、风格、不可删的观点，以及对审美和事实的最终确认。

不能因为 Script 是原子提交，就推断 ChatCut 已公开了“所有下游字幕、音效、MG 的自动语义重锚算法”。

### 8.3 改完主线后，什么会自动处理，什么必须复核？

已明确的规则是：

- 时间线删除默认会留下空隙；只有显式使用 ripple 才会移动同一轨后续内容；
- ripple 只影响同一条 Track；
- 因此语音主线改动后，字幕、MG、B-roll、音乐等相关轨道可能失去对齐，必须检查；
- 批量 Script / 转写改动完成后，官方规则要求再做一次字幕 refresh，之后才能进行字幕特有编辑或声称字幕正确；
- 结构改变后需要读回，并在必要时看合成帧或实际播放，而不是只看工具返回“success”。

这说明 ChatCut 的项目层提供了确定性、可检查的编辑对象；但“哪些下游对象该怎么跟着移动”仍需要 Agent 的工作流和验证，不应神化为已证实的万能自动联动。

---

## 9. MCP 在这条链路里的真实职责

不需要把所有 MCP 工具堆成一张清单，更重要的是理解它们在两条 Agent 协作中的位置。

| 环节 | 代表性外部工具面 | 它给 Codex 的能力 | 它不代表什么 |
| --- | --- | --- | --- |
| 定位项目 | 项目列表、目标项目、编辑器 URL、项目读取。 | 确保外部 Agent 在正确的 ChatCut 项目中工作。 | 不能读到 Web AI Panel 的历史聊天。 |
| 发现素材 | “browse_assets”。 | 查看项目中已经上传 / 导入 / 生成的素材及就绪状态。 | 不能默认搜索整条视频的视觉语义。 |
| 准备文字稿 | “trigger_transcript”“track_progress”。 | 发起或等待转写，辨别就绪、处理中、无音频或失败。 | 不公开底层 ASR、缓存、队列或模型。 |
| 精确定位 | “find_transcript”“inspect_asset”。 | 用文字找到时间，或读取指定源时刻附近的帧和转写事实。 | 不能证明存在通用多模态检索库。 |
| 语义剪辑 | “read_script”“apply_script”。 | 让 Agent 以完整语义单位编辑口播主线，并原子提交。 | 不是 MCP 自己给出“最好版本”的结论。 |
| 布局与验证 | “preview_timeline”、单 Item 读取、合成帧。 | 检查 Track、Item、字幕、局部画面是否真的在正确位置。 | 不等于已完成整条片子的人工审片。 |
| 异步生成 / 导出 | 对应提交与状态追踪工具。 | 追踪生成或导出是否到达终态。 | 一次提交成功不代表画面、声音和版权都正确。 |

本轮对当前 Hosted MCP manifest 的检查还确认：没有暴露名称为“run_agent”“chat_agent”“read_chat”“analyze_video”“multimodal”的入口。

这个观察只能得出：

> 当前外部 Codex 无法通过该 manifest 直接发起、读取或驱动 ChatCut Web 原生 Agent 的聊天任务。

它**不能**得出“ChatCut 不存在 Web 原生 Agent”或“ChatCut 不具备多模态能力”。

---

## 10. Web 编辑器、浏览器交接与异步状态

### 10.1 Web 编辑器为什么是协作工作台，而不只是预览

对外部 Codex 来说，ChatCut Web 编辑器既是用户能看见的时间线，也是项目的真实可编辑表面。MCP 写入后，用户应该能在同一项目中看到 Asset、Track、Item、字幕或生成结果，而不是只拿到一个不可编辑的本地成片。

工具返回的 editor URL 或 browser handoff 的意义是“把正确项目打开给用户看”。它不意味着：

- Codex 已读取了 Web Agent 的聊天；
- 浏览器截了一张图就能证明整条成片正确；
- 编辑器页面和外部 Agent 之间有实时思想同步。

### 10.2 进度至少有两类

| 进度 | 用户关心的问题 | 外部 Codex 可依据的证据 |
| --- | --- | --- |
| **后台任务进度** | 转写、上传、生成、导出是否还在跑？ | 对应任务的状态查询，例如“track_progress”或导出追踪。 |
| **编辑结果进度** | 它是否真的出现在时间线上、在正确的画面和时刻？ | 项目结构读回、局部合成帧、Web 编辑器播放或导出后审片。 |

Web 素材库也会给生成中的 Asset 显示进度；但目前没有公开证据证明 Web 原生 Agent 的每个内部推理步骤，会同步成 Codex 对话中的逐步状态。

外部 Codex 若要给用户提供清楚的过程，应报告“已经依据了什么、现在在等待什么、刚刚写入了什么、接下来要验证什么”，而不是声称能展示 ChatCut Web Agent 的隐藏思考。

---

## 11. 两个 Agent 同时写项目时，哪里会卡住

### 11.1 真实风险不是“两个模型争论”，而是项目快照过期

例如：

1. Codex 读到某段口播在 690 帧；
2. 用户在 Web 中把它拖到 740 帧，或让 Web Agent 改了 Script；
3. Codex 仍按 690 帧写字幕或 MG；
4. 结果对象可能错位，或写入因条件不满足而被拒绝。

因此，当前能从工具合同推出的最低安全规则是：

~~~text
准备做非平凡写入
→ 重新读相关 Asset / Script / Timeline 范围
→ 基于最新结果写入
→ 写后读回
→ 有可见画面变化时，再做局部画面或播放复核
~~~

这是**合理推断的协作协议**，不是已经实测的 ChatCut 多人并发合并算法。

### 11.2 目前没有证实的协调能力

以下能力都不应该提前写成 ChatCut 已有：

- Web Agent 和 Codex Agent 的共享任务队列；
- Web 聊天到 Codex 聊天的消息同步；
- 两位 Agent 对同一 Timeline 的锁、版本合并或冲突提示；
- “某个 Web 编辑已完成”的 MCP 推送事件；
- 原生 Agent 的完整计划、推理过程和逐步审批状态可被外部读取。

如果产品需要高频双入口协作，这些就是后续应重点单独调研或设计的能力，而不是从 MCP 能改 Timeline 这一点就自动得到。

---

## 12. 本篇最终结论

ChatCut 的准确外部架构，应当这样理解：

~~~text
ChatCut Web 原生 Agent
    └─ 面向 Web 用户，内部执行链路未公开

Codex 外部 Agent
    └─ 读取 ChatCut 插件 Skill
    └─ 通过 Hosted MCP 查询和修改项目
    └─ 在 Codex 会话内完成自己的编辑判断和下一步调度

两者的共同事实中心
    └─ ChatCut 项目：Asset、Timeline、Track、Item、Script、字幕、可追踪任务和可见编辑器
~~~

因此：

- ChatCut Web Agent 是 ChatCut 的产品能力；
- Codex Agent 是通过 ChatCut Plugin 接入的外部 Agent；
- Skill 是方法说明，不是会自己跑的后台程序；
- MCP 是受控项目接口，不是导演本身；
- 项目是共享的，聊天和推理不是；
- ChatCut 对外暴露了文字稿、局部帧、Script 与时间线等素材读取面，但没有公开一个可称为“完整多模态证据库”的内部架构；
- 对 Web 原生 Agent 的素材理解和导演规划，只能描述其可见能力，不能把未经公开或验证的内部设计套到 ChatCut 身上。

## 参考依据

- [ChatCut 官方 Skill 中文译文：chatcut-plugin-basics](./官方Skill与插件译文/skills/chatcut-plugin-basics/SKILL.md)：Hosted MCP、项目模型、浏览器交接、陈旧状态与读回规则。
- [ChatCut 官方 Skill 中文译文：transcription](./官方Skill与插件译文/skills/transcription/SKILL.md)：转写、异步状态、无音频终态与语义编辑入口。
- [ChatCut 官方 Skill 中文译文：talking-head-guide](./官方Skill与插件译文/skills/talking-head-guide/SKILL.md)：口播 / 访谈先稳 A-roll、再做字幕、MG、B-roll、音乐的工作顺序。
- [ChatCut 官方 UI 功能译文](./官方Skill与插件译文/skills/product-help/references/ui-and-features.md)：Web AI Panel、Agent、@ 引用、Web Skills 选择器、文字稿和素材库行为。
- [第 08 篇：实测记录、浏览器验证与字段样例](./08-实测记录浏览器验证与字段样例.md)：本轮 Hosted MCP、项目与浏览器的实测记录。
