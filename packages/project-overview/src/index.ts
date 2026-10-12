import { delimiter, join } from "node:path";

/**
 * 这是面向项目维护者的单一阅读入口：只保留配置、顶层流程、关键类名和 MCP 能力目录。
 * 具体的 HTTP、数据库、渲染和 Provider 实现仍留在各自模块，避免把内部细节重复维护一份。
 */

export const RUNTIME_CONFIG_DEFAULTS = {
  workspaceDirectoryName: "workspace", // 未设置工作区时，在当前目录下使用的子目录名。
  serverHost: "127.0.0.1", // 默认仅监听本机，避免开发服务意外暴露到局域网。
  serverPort: 3100, // Server 与本地 Runtime 默认使用的 API 端口。
  webOrigin: "http://127.0.0.1:5173", // Vite 开发工作台的默认来源地址。
  logLevel: "info", // 未配置日志级别时的 Fastify 日志详细程度。
  bridgeApiBaseUrl: "http://127.0.0.1:8188/comfyui-bridge/v1", // ComfyUI Bridge 的默认 HTTP API 根地址。
  maxAssetDownloadBytes: 512 * 1024 * 1024, // 普通素材下载的最大文件体积：512 MB。
  maxWikimediaDownloadBytes: 256 * 1024 * 1024, // Wikimedia Commons 素材下载的最大文件体积：256 MB。
  maxGeneratedVideoBytes: 512 * 1024 * 1024, // Bridge 生成视频下载的最大文件体积：512 MB。
  runtimeId: "manual", // 未由插件启动时，标识当前 Runtime 为手工启动实例。
  releaseId: "manual" // 未由插件发行启动时，标识 MCP 与 Runtime 未绑定正式发行物。
} as const;

export type RuntimeEnvironment = Record<string, string | undefined>;

/**
 * 运行时真正使用的 Node 配置。调用 readRuntimeConfig() 时才读取环境变量，
 * 因此测试或插件启动器在导入模块后修改环境变量仍保持原先的行为。
 */
export interface RuntimeConfig {
  /** 动效缓存限额是同时驻留量，不是作品累计处理量。 */
  motion: { frameCacheBytes: number; scratchBytes: number; diskReserveBytes: number; frameTimeoutMs: number };
  /** 项目文件、数据库、受管素材和导出产物的根目录。 */
  workspace: {
    /** 当前实际使用的工作区绝对路径。 */
    root: string;
  };
  /** HTTP Server 和 Web 工作台之间的连接配置。 */
  http: {
    /** Server 监听的网络地址。 */
    host: string;
    /** Server 监听的网络端口。 */
    port: number;
    /** 允许访问 Server 的 Web 工作台来源地址。 */
    webOrigin: string;
    /** 是否由 Server 直接托管已构建的 Web 静态文件。 */
    serveWeb: boolean;
    /** Fastify 日志级别。 */
    logLevel: string;
  };
  /** 与 ComfyUI Bridge 通信的入口配置。 */
  bridge: {
    /** Bridge HTTP API 根地址。 */
    apiBaseUrl: string;
  };
  /** 冻结到分析 Job 的外部 HTTP 配置；不管理模型进程。 */
  semantic: {
    videoWorkflowId: string;
    audioWorkflowId: string;
    imageWorkflowId: string;
    embeddingWorkflowId: string;
    modelRevision: string;
    embeddingRevision: string;
  };
  /** 第三方素材 Provider 的可选凭据；总览只显示是否已配置。 */
  providers: {
    /** 可选 yt-dlp 可执行路径；缺省使用 python -m yt_dlp。 */
    youtubeDownloaderPath?: string;
  };
  /** 下载外部或生成素材时的文件大小保护阈值。 */
  downloads: {
    /** 普通 Provider 素材的最大下载字节数。 */
    maxAssetBytes: number;
    /** Wikimedia Commons 素材的最大下载字节数。 */
    maxWikimediaBytes: number;
    /** Bridge 返回生成视频的最大下载字节数。 */
    maxGeneratedVideoBytes: number;
  };
  /** 本机音效库只允许通过这些受控根目录被 MCP 浏览和导入。 */
  localSoundEffects: {
    /** 由系统路径分隔符分隔的根目录；空数组表示未配置。 */
    roots: string[];
  };
  /** 插件发行版 Runtime 和 Remotion 渲染器的可选路径与实例信息。 */
  runtime: {
    /** 插件发行 Runtime 的根目录。 */
    distributionDirectory?: string;
    /** Runtime 内部控制令牌；只能以“是否已配置”对外展示。 */
    runtimeToken?: string;
    /** 用于识别当前 Runtime 实例的名称。 */
    runtimeId: string;
    /** 当前 Runtime / MCP 应共同持有的不可伪造发行版本标识。 */
    releaseId: string;
    /** 已构建 Web 静态文件的目录。 */
    webRoot?: string;
    /** 发行版 Remotion 渲染入口。 */
    remotionEntry?: string;
    /** Remotion 额外查找依赖的 node_modules 目录。 */
    nodeModules?: string;
    /** 切换前已准备并启动验证的浏览器，不从插件目录临时下载。 */
    browserExecutable?: string;
    /** 开发态 Render Worker 的源码根目录。 */
    renderSourceRoot?: string;
    /** 开发态 Remotion Contracts 的入口文件。 */
    remotionContractsEntry?: string;
  };
}

export interface ReadRuntimeConfigOptions {
  /** 供测试注入；生产默认读取 process.env。 */
  environment?: RuntimeEnvironment;
  /** 供测试注入；生产默认读取 process.cwd()。 */
  cwd?: string;
}

function configuredPathRoots(value: string | undefined): string[] {
  return value?.split(delimiter).map((entry) => entry.trim()).filter(Boolean) ?? [];
}

/** 集中读取所有 Node 端运行配置，不在这里校验 Provider 或启动外部服务。 */
export function readRuntimeConfig(options: ReadRuntimeConfigOptions = {}): RuntimeConfig {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const motionLimit = (raw: string | undefined, key: string, fallback: number, multiplier = 1) => {
    const value = Number(raw ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(value * multiplier)) throw new Error(`动效配置 ${key} 必须为正安全整数`);
    return value * multiplier;
  };
  return {
    motion: {
      frameCacheBytes: motionLimit(environment.VIDEOFLOWCUT_MOTION_FRAME_CACHE_MIB, "VIDEOFLOWCUT_MOTION_FRAME_CACHE_MIB", 256, 1024 * 1024),
      scratchBytes: motionLimit(environment.VIDEOFLOWCUT_MOTION_SCRATCH_MIB, "VIDEOFLOWCUT_MOTION_SCRATCH_MIB", 512, 1024 * 1024),
      diskReserveBytes: motionLimit(environment.VIDEOFLOWCUT_MOTION_DISK_RESERVE_MIB, "VIDEOFLOWCUT_MOTION_DISK_RESERVE_MIB", 1024, 1024 * 1024),
      frameTimeoutMs: motionLimit(environment.VIDEOFLOWCUT_MOTION_FRAME_TIMEOUT_MS, "VIDEOFLOWCUT_MOTION_FRAME_TIMEOUT_MS", 12000)
    },
    workspace: {
      root: environment.VIDEOCUT_WORKSPACE ?? join(cwd, RUNTIME_CONFIG_DEFAULTS.workspaceDirectoryName)
    },
    http: {
      host: environment.HOST ?? RUNTIME_CONFIG_DEFAULTS.serverHost,
      port: Number(environment.PORT ?? RUNTIME_CONFIG_DEFAULTS.serverPort),
      webOrigin: environment.WEB_ORIGIN ?? RUNTIME_CONFIG_DEFAULTS.webOrigin,
      serveWeb: environment.SERVE_WEB === "true",
      logLevel: environment.LOG_LEVEL ?? RUNTIME_CONFIG_DEFAULTS.logLevel
    },
    bridge: {
      apiBaseUrl: environment.COMFYUI_BRIDGE_URL ?? RUNTIME_CONFIG_DEFAULTS.bridgeApiBaseUrl
    },
    semantic: {
      videoWorkflowId: environment.VIDEOCUT_VIDEO_ANALYSIS_WORKFLOW_ID ?? "ee8e9c17-bd16-566f-ad2d-a7ec239bf4b8",
      audioWorkflowId: environment.VIDEOCUT_AUDIO_ANALYSIS_WORKFLOW_ID ?? "863d530d-8066-52b2-a59d-de4301f41013",
      imageWorkflowId: environment.VIDEOCUT_IMAGE_ANALYSIS_WORKFLOW_ID ?? "d8bc75ad-5737-5d68-b9fd-44739c4700df",
      embeddingWorkflowId: environment.VIDEOCUT_EMBEDDING_WORKFLOW_ID ?? "15904667-24ab-5e91-bc56-19ee2ad9eb4f",
      modelRevision: environment.VIDEOCUT_ANALYSIS_MODEL_REVISION ?? "073dbbc8c5bc0af2d789e1ce12e7c17a6be746e1",
      embeddingRevision: environment.VIDEOCUT_EMBEDDING_MODEL_REVISION ?? "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
    },
    providers: {
      youtubeDownloaderPath: environment.VIDEOCUT_YT_DLP_PATH?.trim() || undefined,
    },
    downloads: {
      maxAssetBytes: Number(environment.VIDEOCUT_MAX_ASSET_DOWNLOAD_BYTES ?? RUNTIME_CONFIG_DEFAULTS.maxAssetDownloadBytes),
      maxWikimediaBytes: Number(environment.VIDEOCUT_MAX_WIKIMEDIA_DOWNLOAD_BYTES ?? RUNTIME_CONFIG_DEFAULTS.maxWikimediaDownloadBytes),
      maxGeneratedVideoBytes: Number(environment.VIDEOCUT_MAX_GENERATED_VIDEO_BYTES ?? RUNTIME_CONFIG_DEFAULTS.maxGeneratedVideoBytes)
    },
    localSoundEffects: {
      roots: configuredPathRoots(environment.VIDEOFLOWCUT_SFX_ROOTS)
    },
    runtime: {
      distributionDirectory: environment.VIDEOFLOWCUT_RUNTIME_DIST,
      runtimeToken: environment.VIDEOFLOWCUT_RUNTIME_TOKEN,
      runtimeId: environment.VIDEOFLOWCUT_RUNTIME_ID ?? RUNTIME_CONFIG_DEFAULTS.runtimeId,
      releaseId: environment.VIDEOFLOWCUT_RELEASE_ID ?? RUNTIME_CONFIG_DEFAULTS.releaseId,
      webRoot: environment.VIDEOFLOWCUT_WEB_ROOT,
      remotionEntry: environment.VIDEOFLOWCUT_REMOTION_ENTRY,
      nodeModules: environment.VIDEOFLOWCUT_NODE_MODULES,
      browserExecutable: environment.VIDEOFLOWCUT_BROWSER_EXECUTABLE,
      renderSourceRoot: environment.VIDEOFLOWCUT_RENDER_SOURCE_ROOT,
      remotionContractsEntry: environment.VIDEOFLOWCUT_REMOTION_CONTRACTS_ENTRY
    }
  };
}

/**
 * 插件发行 Runtime 才需要补齐三条发行路径。集中在这里可让启动入口不再散落
 * process.env 读写；未设置时严格保持原来的“不覆盖调用方显式配置”行为。
 */
export function applyReleaseRuntimeDefaults(
  releaseDirectory?: string,
  environment: RuntimeEnvironment = process.env
): RuntimeConfig {
  const distributionDirectory = environment.VIDEOFLOWCUT_RUNTIME_DIST ?? releaseDirectory;
  if (distributionDirectory) {
    environment.VIDEOFLOWCUT_RUNTIME_DIST ??= distributionDirectory;
    environment.VIDEOFLOWCUT_WEB_ROOT ??= join(distributionDirectory, "web");
    environment.VIDEOFLOWCUT_REMOTION_ENTRY ??= join(distributionDirectory, "remotion", "render-entry.cjs");
  }
  return readRuntimeConfig({ environment });
}

/** 用户只需按这个顺序理解整条业务调用链；每一步内部实现由对应应用层封装。 */
export const CORE_PRODUCTION_FLOW = [
  // 第 1 步：把外部文件变成项目可追溯、可管理的素材记录。
  {
    step: 1,
    name: "素材读取",
    responsibility: "创建项目、导入受管素材、登记来源与媒体分析。",
    entryPoints: [
      { name: "EditingApplication", kind: "项目应用类" },
      { name: "AssetProviderRegistry", kind: "素材 Provider 类" },
      { name: "ProjectRepository", kind: "持久化类" }
    ]
  },
  // 第 2 步：从音视频中提取事实，不在此阶段替用户做创作判断。
  {
    step: 2,
    name: "理解视频",
    responsibility: "转写、素材审阅、Vlog 事件分析或多机位同步，形成可追溯事实。",
    entryPoints: [
      { name: "FunASRService", kind: "转写服务类" },
      { name: "EditingApplication", kind: "项目应用类" }
    ]
  },
  // 第 3 步：依据已确认的事实形成故事与视觉计划。
  {
    step: 3,
    name: "导演规划",
    responsibility: "由主工作流组织故事、场景、人物、视觉处理和素材需求。",
    entryPoints: [{ name: "EditingApplication", kind: "项目应用类" }]
  },
  // 第 4 步：把计划编译为实际时间线、声音和视觉内容。
  {
    step: 4,
    name: "成片生产",
    responsibility: "编译时间线、语音、字幕、音频、效果、人物或生成素材。",
    entryPoints: [
      { name: "EditingApplication", kind: "项目应用类" },
      { name: "OmniVoiceSegmentService", kind: "语音服务类" },
      { name: "ComfyUIBridgeClient", kind: "Bridge 客户端类" },
      { name: "RevisionRenderer", kind: "渲染器类" }
    ]
  },
  // 第 5 步：通过真实预览和门禁后，固定为可交付的导出文件。
  {
    step: 5,
    name: "预览与交付",
    responsibility: "真实预览、质量审查、渲染预检、导出 Artifact 与批准。",
    entryPoints: [
      { name: "EditingApplication", kind: "项目应用类" },
      { name: "evaluateQuality", kind: "质量函数" },
      { name: "RevisionRenderer", kind: "渲染器类" }
    ]
  }
] as const;

/** 只列真实公开类、函数或 SDK 入口，帮助阅读，不把用户带入内部文件或具体算法。 */
export const KEY_APPLICATION_ENTRIES = [
  { name: "EditingApplication", kind: "项目类", responsibility: "项目 Revision、创作对象和业务命令的统一门面", module: "@videocut/application" },
  { name: "VideoProductionFlow", kind: "流程门面类", responsibility: "按五个顶层阶段组织 EditingApplication 的公开调用，不复制业务状态", module: "@videocut/application" },
  { name: "createProductionFlow", kind: "函数", responsibility: "从既有 EditingApplication 创建五阶段流程门面", module: "@videocut/application" },
  { name: "ProjectRepository", kind: "持久化类", responsibility: "SQLite 项目、Revision、任务与导出记录的持久化", module: "@videocut/application" },
  { name: "AssetProviderRegistry", kind: "素材 Provider 类", responsibility: "素材搜索、候选审阅和受管下载 Provider 的目录", module: "@videocut/acquisition" },
  { name: "ComfyUIBridgeClient", kind: "Bridge 客户端类", responsibility: "动态读取 ComfyUI Workflow Schema 并提交 Bridge 任务", module: "@videocut/bridge" },
  { name: "FunASRService", kind: "转写服务类", responsibility: "转写与时间信息的服务边界", module: "@videocut/speech" },
  { name: "SourceCaptionAlignmentService", kind: "原声字幕服务类", responsibility: "使用 Provider 段级时间证据，自动生成一段一屏的默认字幕 Program；内部 token 仅用于校验和异常重分屏", module: "@videocut/speech" },
  { name: "OmniVoiceSegmentService", kind: "语音服务类", responsibility: "段级语音合成与真实音频时长校验", module: "@videocut/speech" },
  { name: "RevisionRenderer", kind: "渲染器类", responsibility: "Preview、Render Preflight 与导出渲染", module: "Render Worker" },
  { name: "evaluateQuality", kind: "函数", responsibility: "质量规则、审片结论与交付门禁", module: "@videocut/quality" },
  { name: "McpServer", kind: "SDK 类", responsibility: "为 Codex 注册工具的协议适配层", module: "@modelcontextprotocol/sdk/server/mcp.js" }
] as const;

export interface McpCapabilityGroup {
  /** 稳定的分组标识，供测试和程序定位。 */
  id: string;
  /** 显示给用户的能力分组名称。 */
  name: string;
  /** 用一句话说明该分组解决的业务问题。 */
  description: string;
  /** 属于该分组的真实 MCP 工具名；必须与 mcp.ts 注册结果一致。 */
  tools: readonly string[];
}

/** MCP 的连接入口只保留协议和公开名称；业务工具的内部实现不在总览展开。 */
export const MCP_SERVER_DESCRIPTOR = {
  name: "video-editor-mcp", // Codex 配置中注册的 MCP Server 名称。
  transport: "stdio", // 当前通过标准输入输出与 Codex 通信，不开放额外网络端口。
  entry: "video-editor-mcp 模块", // 启动 MCP Server 的应用模块名称。
  overviewTool: "read_project_overview" // 用于读取本总览的只读 MCP 工具。
} as const;

/**
 * MCP 的用户可读能力目录。工具仍在 mcp.ts 注册；新增工具必须同时归入这里，
 * tests/project-overview.test.ts 会静态比对，防止目录悄悄过期。
 */
export const MCP_CAPABILITY_GROUPS: readonly McpCapabilityGroup[] = [
  // 只读入口：先看全局配置和工具目录，再选择实际业务工具。
  {
    id: "overview",
    name: "项目总览",
    description: "读取本文件汇总的配置、流程、关键入口和 MCP 目录。",
    tools: ["read_project_overview", "read_runtime_release"]
  },
  // 项目对象、Revision 和多人/多 Agent 协作的基础操作。
  {
    id: "project",
    name: "项目与协作",
    description: "创建和定位项目、读取 Revision 与故事、打开工作台、管理 Codex 工作单和平台修复交接。",
    tools: [
      "open_web_workbench", "list_projects", "create_project", "target_project", "read_project", "read_story", "manage_story",
      "preview_project_frame_rate_change", "set_project_frame_rate",
      "get_editor_url", "focus_editor_object", "read_impact_report", "list_revisions", "read_agent_work_orders",
      "claim_agent_work_order", "complete_agent_work_order", "release_agent_work_order", "report_editing_blocker",
      "list_repair_tickets", "claim_repair_ticket", "release_repair_ticket", "resolve_repair_ticket_without_deployment", "mark_repair_candidate_ready",
      "mark_repair_deployed", "acknowledge_repair_deployment", "rollback_revision"
    ]
  },
  // 素材文件、候选素材和来源信息。
  {
    id: "assets",
    name: "素材与来源",
    description: "浏览、导入、检验、搜索、获取素材，并保留来源和需求事实。",
    tools: [
      "browse_assets", "inspect_asset", "manage_asset_requirements", "list_asset_providers", "search_media_candidates", "acquire_source_material", "inspect_media_candidate",
      "acquire_media_asset", "read_asset_provenance", "import_media", "extract_source_audio", "update_asset_metadata",
      "analyze_media", "read_media_observations", "search_media_fragments", "correct_media_observation", "retry_media_job"
    ]
  },
  // 音频主线：转写、脚本、语音、字幕与音乐音效。
  {
    id: "speech",
    name: "转写、语音与声音",
    description: "处理转写、语义脚本、语音合成与对齐、字幕、对白和 BGM/SFX。",
    tools: [
      "submit_transcription", "generate_source_audio_captions", "generate_speech_captions", "read_source_audio_alignment", "apply_source_caption_program", "apply_manual_transcript", "read_script", "apply_semantic_units", "apply_authored_script", "apply_script",
      "read_speech_asset", "manage_voice_references", "read_speech_timing", "submit_speech_alignment",
      "read_speech_alignment", "rebuild_speech_timeline", "submit_voice_synthesis", "submit_speech_placement", "submit_dialogue_processing",
      "select_dialogue_processing_variant", "read_captions", "edit_captions", "browse_local_sound_effects",
      "inspect_local_sound_effect", "import_local_sound_effect", "browse_sound_sources", "manage_audio", "set_audio_mix_gain", "set_dialogue_muted",
      "manage_sound_plans", "recommend_sound_candidates", "preview_sound_alternatives", "review_sound_mix", "set_audio_output_target"
    ]
  },
  // 人物口播和 Presenter 场景的主线组装。
  {
    id: "presenter",
    name: "人物口播主线",
    description: "组装 A-roll、人物场景和人物语音时间线。",
    tools: ["assemble_presenter_track", "edit_presenter_source", "compile_presenter_scenes", "create_presenter_timeline", "align_presenter_to_speech"]
  },
  // 以旁白、证据、数据或 UI 解释为主的片型。
  {
    id: "explainer",
    name: "视觉解释片",
    description: "管理叙事地图、证据采集和 Explainer Scene 程序。",
    tools: [
      "read_narrative_map", "manage_narrative_map", "read_evidence_capture", "manage_evidence_capture",
      "read_explainer_scene_programs", "compile_explainer_scenes", "set_explainer_program_enabled"
    ]
  },
  // 实拍事件驱动的 Vlog，以及多机位同步和切换。
  {
    id: "vlog_multicam",
    name: "Vlog 与多机位",
    description: "分析实拍事件、镜头选择与音乐节拍，并同步、验证和编译多机位节目。",
    tools: [
      "read_vlog_plan", "submit_vlog_analysis", "manage_vlog_events", "manage_vlog_shot_selects", "compile_vlog_montage",
      "manage_vlog_music_beats", "read_multicam_plan", "submit_multicam_sync", "create_manual_multicam_group",
      "verify_multicam_group", "manage_multicam_cuts", "compile_multicam_program"
    ]
  },
  // 生成内容与数字人物的可验证任务和能力记录。
  {
    id: "generation_actor",
    name: "生成与人物能力",
    description: "提交音乐、视频与数字人物任务，并管理可验证的人物能力和表演记录。",
    tools: [
      "submit_music_generation", "submit_video_generation", "read_actor_performances", "read_actor_capabilities",
      "manage_actor_capabilities", "manage_actor_performance", "submit_avatar_job"
    ]
  },
  // 场景、视觉处理、Cutaway、效果和时间线的编排操作。
  {
    id: "timeline_visuals",
    name: "场景、视觉与时间线",
    description: "创建场景、管理视觉处理、Cutaway、效果和时间线位置，并请求轻量预览。",
    tools: [
      "browse_scene_types", "create_scene", "trim_scene", "manage_visual_treatment", "manage_cutaways", "replace_scene_asset",
      "browse_effect_types", "manage_effect_cues", "move_item", "preview_timeline",
      "read_motion_capabilities", "browse_motion_sources", "inspect_motion_reference", "search_motion_mechanisms", "read_motion_mechanism", "analyze_motion_reference", "submit_motion_work", "read_motion_work", "review_motion_work"
    ]
  },
  // 生产运行、创作决定、质量报告和连续预览证据。
  {
    id: "production_quality",
    name: "生产与质量",
    description: "记录创作决定，运行生产流程，读取技能交接、图结构和连续预览审片证据。",
    tools: [
      "start_production_run", "record_creative_decision", "record_editorial_quality_review", "complete_production_run",
      "read_skill_execution_report", "validate_project_graph", "read_quality_report", "render_preview_range",
      "inspect_composed_frames"
    ]
  },
  // 导出、渲染预检、Artifact 审核与异步任务查询。
  {
    id: "delivery",
    name: "交付与异步任务",
    description: "提交导出、执行渲染预检、读取和审核 Artifact、批准交付并跟踪任务。",
    tools: [
      "submit_export", "run_render_preflight", "track_export", "read_export_artifact", "record_export_artifact_review",
      "approve_export_artifact", "track_job", "read_job_diagnostics"
    ]
  }
];

/** Node 服务、Worker 与发行 Runtime 的环境变量目录；敏感值只展示“是否已配置”。 */
export const NODE_RUNTIME_CONFIGURATION_CATALOG = [
  { key: "ATTENTION_INSTALLED_PLUGIN", group: "开发验收", description: "部署验收脚本显式指定的已安装插件目录" },
  { key: "ATTENTION_VERIFY_EXISTING", group: "开发验收", description: "候选诊断脚本仅核验已有结果，不创建验收样本", defaultValue: "0" },
  // 工作区：所有项目级持久化数据的落盘位置。
  { key: "VIDEOCUT_WORKSPACE", group: "工作区", description: "项目数据库、素材与导出目录", defaultValue: "<cwd>/workspace" },
  // HTTP：本地 Server、Web 工作台与日志的连接配置。
  { key: "HOST", group: "HTTP", description: "Server 与 Runtime 监听地址", defaultValue: RUNTIME_CONFIG_DEFAULTS.serverHost },
  { key: "PORT", group: "HTTP", description: "Server 与 Runtime 监听端口", defaultValue: String(RUNTIME_CONFIG_DEFAULTS.serverPort) },
  { key: "WEB_ORIGIN", group: "HTTP", description: "开发态 Web 工作台地址", defaultValue: RUNTIME_CONFIG_DEFAULTS.webOrigin },
  { key: "SERVE_WEB", group: "HTTP", description: "Server 是否托管静态 Web 产物", defaultValue: "false" },
  { key: "LOG_LEVEL", group: "HTTP", description: "Fastify 日志级别", defaultValue: RUNTIME_CONFIG_DEFAULTS.logLevel },
  // Bridge：所有 ComfyUI Bridge HTTP 调用共用的地址。
  { key: "COMFYUI_BRIDGE_URL", group: "Bridge", description: "ComfyUI Bridge HTTP API 根地址", defaultValue: RUNTIME_CONFIG_DEFAULTS.bridgeApiBaseUrl },
  { key: "VIDEOCUT_VIDEO_ANALYSIS_WORKFLOW_ID", group: "素材理解", description: "外部视频原声理解工作流" },
  { key: "VIDEOCUT_AUDIO_ANALYSIS_WORKFLOW_ID", group: "素材理解", description: "外部原生音频理解工作流" },
  { key: "VIDEOCUT_IMAGE_ANALYSIS_WORKFLOW_ID", group: "素材理解", description: "外部图片及页面理解工作流" },
  { key: "VIDEOCUT_EMBEDDING_WORKFLOW_ID", group: "素材理解", description: "外部文本向量工作流" },
  { key: "VIDEOCUT_ANALYSIS_MODEL_REVISION", group: "素材理解", description: "观察模型版本，隔离分析缓存" },
  { key: "VIDEOCUT_EMBEDDING_MODEL_REVISION", group: "素材理解", description: "向量模型版本，隔离语义索引" },
  // Provider：第三方素材服务的凭据；密钥不会出现在项目总览响应中。
  { key: "HTTP_PROXY", group: "网络", description: "外部素材 HTTP 代理，可包含凭据", sensitive: true },
  { key: "HTTPS_PROXY", group: "网络", description: "外部素材 HTTPS 代理，可包含凭据", sensitive: true },
  { key: "NO_PROXY", group: "网络", description: "代理排除地址；本地 API 始终直连" },
  { key: "VIDEOCUT_YT_DLP_PATH", group: "Provider", description: "可选 yt-dlp 可执行文件路径；缺省使用 python -m yt_dlp，须安装 yt-dlp[default] 并提供 Node 与 FFmpeg" },
  { key: "PEXELS_API_KEY", group: "Provider", description: "Pexels 官方视频 API 密钥；配置后启用视频检索与下载", sensitive: true },
  // 下载限制：防止单个外部文件异常占满工作区磁盘。
  { key: "VIDEOFLOWCUT_MOTION_FRAME_CACHE_MIB", group: "动效资源", description: "视频帧内存缓存目标（MiB），不是进程总内存限额", defaultValue: "256" },
  { key: "VIDEOFLOWCUT_MOTION_SCRATCH_MIB", group: "动效资源", description: "可回收视频解码缓存驻留限额（MiB）", defaultValue: "512" },
  { key: "VIDEOFLOWCUT_MOTION_DISK_RESERVE_MIB", group: "动效资源", description: "动效任务磁盘安全余量（MiB）", defaultValue: "1024" },
  { key: "VIDEOFLOWCUT_MOTION_FRAME_TIMEOUT_MS", group: "动效资源", description: "单帧无完成超时（毫秒），不限制作品总时长", defaultValue: "12000" },
  { key: "VIDEOCUT_MAX_ASSET_DOWNLOAD_BYTES", group: "下载限制", description: "普通 Provider 素材下载上限", defaultValue: String(RUNTIME_CONFIG_DEFAULTS.maxAssetDownloadBytes) },
  { key: "VIDEOCUT_MAX_WIKIMEDIA_DOWNLOAD_BYTES", group: "下载限制", description: "Wikimedia Commons 下载上限", defaultValue: String(RUNTIME_CONFIG_DEFAULTS.maxWikimediaDownloadBytes) },
  { key: "VIDEOCUT_MAX_GENERATED_VIDEO_BYTES", group: "下载限制", description: "Bridge 生成视频下载上限", defaultValue: String(RUNTIME_CONFIG_DEFAULTS.maxGeneratedVideoBytes) },
  // 本地声音资产只接受白名单根目录；MCP 从不接收自由绝对路径来绕过该限制。
  { key: "VIDEOFLOWCUT_SFX_ROOTS", group: "本地音效", description: "本地音效根目录，多个目录用当前系统路径分隔符分开", defaultValue: "（未配置）" },
  // 发行 Runtime：插件打包版本定位 Web、Remotion 与开发回退路径所需的信息。
  { key: "VIDEOFLOWCUT_RUNTIME_DIST", group: "发行 Runtime", description: "插件发行运行时目录；受管字体只从其中fonts目录读取，不读取系统目录或任意字体URL" },
  { key: "VIDEOFLOWCUT_WEB_ROOT", group: "发行 Runtime", description: "静态 Web 产物目录" },
  { key: "VIDEOFLOWCUT_REMOTION_ENTRY", group: "发行 Runtime", description: "发行版 Remotion 入口" },
  { key: "VIDEOFLOWCUT_NODE_MODULES", group: "发行 Runtime", description: "Remotion 打包时额外查找的 node_modules 目录" },
  { key: "VIDEOFLOWCUT_BROWSER_EXECUTABLE", group: "发行 Runtime", description: "部署前已准备并验证的渲染浏览器绝对路径" },
  { key: "VIDEOFLOWCUT_RENDER_SOURCE_ROOT", group: "发行 Runtime", description: "开发态 Render Worker 源码根目录" },
  { key: "VIDEOFLOWCUT_REMOTION_CONTRACTS_ENTRY", group: "发行 Runtime", description: "开发态 Remotion Contracts 入口" },
  { key: "VIDEOFLOWCUT_RUNTIME_TOKEN", group: "发行 Runtime", description: "Runtime 内部控制接口令牌", sensitive: true },
  { key: "VIDEOFLOWCUT_RUNTIME_ID", group: "发行 Runtime", description: "Runtime 实例标识", defaultValue: RUNTIME_CONFIG_DEFAULTS.runtimeId },
  { key: "VIDEOFLOWCUT_RELEASE_ID", group: "发行 Runtime", description: "Runtime 与 MCP 必须一致的发行版本标识", defaultValue: RUNTIME_CONFIG_DEFAULTS.releaseId }
] as const;

/**
 * 浏览器配置只在 Vite 构建或浏览器运行时读取。它列在总览中供维护者查看，
 * 但 project-overview 不会被 Web 打包入口导入，避免把 Node 依赖带进浏览器。
 */
export const WEB_CONFIGURATION_CATALOG = [
  // 浏览器向 Server 请求 API 的地址；开发、生产默认值不同。
  {
    key: "VITE_API_BASE",
    group: "Web API",
    scope: "浏览器构建时环境变量",
    source: "apps/web/src/api.ts",
    description: "Web 工作台请求 API 的基础地址；开发态默认 http://127.0.0.1:3100，生产态默认当前页面来源。"
  },
  // Vite 自带的构建环境标记，不是项目维护者手动设置的变量。
  {
    key: "DEV",
    group: "Web API",
    scope: "Vite 内置浏览器标记",
    source: "apps/web/src/api.ts",
    description: "判断当前是否为 Vite 开发态；它不是用户设置的环境变量。"
  },
  // 本地 Vite 工作台的固定监听地址，方便一眼查到开发访问入口。
  {
    key: "vite.server.host",
    group: "Vite 开发服务",
    scope: "固定开发配置",
    source: "apps/web/vite.config.ts",
    description: "Vite 开发服务监听地址；当前不是环境变量。",
    defaultValue: "127.0.0.1"
  },
  // 本地 Vite 工作台的固定监听端口。
  {
    key: "vite.server.port",
    group: "Vite 开发服务",
    scope: "固定开发配置",
    source: "apps/web/vite.config.ts",
    description: "Vite 开发服务监听端口；当前不是环境变量。",
    defaultValue: "5173"
  }
] as const;

/** 插件启动器自己的配置不会传给浏览器，也不会改变 Server 的 HOST / PORT 含义。 */
export const PLUGIN_LAUNCHER_CONFIGURATION_CATALOG = [
  // 插件启动器需先定位宿主仓库，再启动相应 Runtime。
  {
    key: "VIDEOFLOWCUT_REPO_ROOT",
    group: "插件启动器",
    scope: "Node 启动器环境变量或 --repo-root 参数",
    source: "plugins/videoflowcut/scripts/runtime-launcher.mjs",
    description: "定位宿主仓库；未设置时依次尝试发行指针和插件相对目录。"
  },
  // 插件 Runtime 独立于 Vite 的对外服务端口。
  {
    key: "VIDEOFLOWCUT_PORT",
    group: "插件启动器",
    scope: "Node 启动器环境变量或 --port 参数",
    source: "plugins/videoflowcut/scripts/runtime-launcher.mjs",
    description: "插件 Runtime 端口，必须是 1024 到 65535 的整数。",
    defaultValue: "3100"
  },
  // Node 的依赖查找路径；启动器会在保留现有值的前提下追加项目依赖目录。
  {
    key: "NODE_PATH",
    group: "插件启动器",
    scope: "Node 继承环境变量",
    source: "plugins/videoflowcut/scripts/repo-root.mjs",
    description: "发行 Runtime 与 MCP 启动器用于定位宿主仓库 node_modules；会保留原有路径并追加仓库依赖路径。"
  }
] as const;

/** 真实服务不会读取该变量；它只用于手工触发阶段 1 live E2E 的隔离工作区。 */
export const EVALUATION_CONFIGURATION_CATALOG = [
  {
    key: "VIDEOCUT_AUDIT_SOURCE_ENTRY",
    group: "渲染回归审计",
    scope: "scripts/render-snapshot-regression.e2e.ts",
    source: "scripts/render-snapshot-regression.e2e.ts",
    description: "仅手动回归脚本使用；值为 1 时验证源码入口，不改变正式 Runtime 配置。"
  },
  {
    key: "VIDEOCUT_AUDIT_CONCURRENCY",
    group: "渲染回归审计",
    scope: "scripts/render-snapshot-regression.e2e.ts",
    source: "scripts/render-snapshot-regression.e2e.ts",
    description: "仅控制手动渲染审计的并发，默认 1；不是生产 Worker 配置。"
  },
  // 该变量只影响手工 live E2E，不会改变普通项目的生产工作区。
  {
    key: "VIDEOCUT_LIVE_WORKSPACE",
    group: "本地 E2E",
    scope: "scripts/presenter-stage1-live.e2e.ts",
    source: "scripts/presenter-stage1-live.e2e.ts",
    description: "阶段 1 live E2E 的临时工作区；未设置时脚本自行创建临时目录。"
  }
] as const;

/**
 * 全仓库显式环境变量和固定 Web 配置的唯一可读目录。
 * 静态测试会将实际访问的 process.env / import.meta.env 名称与该目录逐项比对。
 */
export const RUNTIME_CONFIGURATION_CATALOG = [
  ...NODE_RUNTIME_CONFIGURATION_CATALOG,
  ...WEB_CONFIGURATION_CATALOG,
  ...PLUGIN_LAUNCHER_CONFIGURATION_CATALOG,
  ...EVALUATION_CONFIGURATION_CATALOG
] as const;

/** 返回给 MCP 的安全总览：可读配置不泄漏密钥，且不会执行任何剪辑、转写或渲染。 */
export function getProjectOverview(options: ReadRuntimeConfigOptions = {}) {
  const config = readRuntimeConfig(options);
  return {
    title: "VideoFlowCut 项目总览", // MCP 返回对象的显示标题。
    configuration: {
      workspaceRoot: config.workspace.root, // 当前项目实际写入磁盘的根目录。
      http: config.http, // Server、Web 工作台和日志配置。
      bridge: config.bridge, // ComfyUI Bridge 的安全地址信息。
      semantic: config.semantic,
      downloads: config.downloads, // 外部素材和生成文件的下载上限。
      motion: config.motion, // 动效缓存驻留限额与磁盘安全余量。
      localSoundEffects: { roots: config.localSoundEffects.roots }, // 仅受控根目录可用于本地音效浏览和导入。
      providers: { requiresKey: false, sources: ["wikimedia-commons", "youtube", "mixkit", "mixkit_music", ...(process.env.PEXELS_API_KEY?.trim() ? ["pexels"] : [])], webResearch: "通过宿主浏览器使用公开网站搜索和阅读；选定网页、图片或 PDF 通过 acquire_source_material 取得" },
      runtime: {
        distributionDirectory: config.runtime.distributionDirectory, // 插件发行 Runtime 根目录。
        runtimeId: config.runtime.runtimeId, // 当前 Runtime 实例标识。
        releaseId: config.runtime.releaseId, // 当前 MCP/Runtime 应共同验证的发行版本。
        webRoot: config.runtime.webRoot, // 静态 Web 产物目录。
        remotionEntry: config.runtime.remotionEntry, // Remotion 渲染入口。
        nodeModulesConfigured: Boolean(config.runtime.nodeModules), // 仅提示是否配置额外依赖路径。
        renderSourceRoot: config.runtime.renderSourceRoot, // 开发态渲染源码目录。
        remotionContractsEntry: config.runtime.remotionContractsEntry, // 开发态渲染契约入口。
        runtimeTokenConfigured: Boolean(config.runtime.runtimeToken) // 仅提示内部令牌是否存在。
      }
    },
    configurationCatalog: {
      all: RUNTIME_CONFIGURATION_CATALOG, // 全部可见配置项的汇总目录。
      nodeRuntime: NODE_RUNTIME_CONFIGURATION_CATALOG, // Node Server、Worker、Runtime 的配置。
      web: WEB_CONFIGURATION_CATALOG, // 浏览器和 Vite 开发服务的配置。
      pluginLauncher: PLUGIN_LAUNCHER_CONFIGURATION_CATALOG, // 插件启动脚本的配置。
      evaluation: EVALUATION_CONFIGURATION_CATALOG // 仅测试脚本使用的配置。
    },
    coreProductionFlow: CORE_PRODUCTION_FLOW, // 用户只需按此顺序理解的五步生产链。
    keyApplicationEntries: KEY_APPLICATION_ENTRIES, // 每一步会接触到的真实公开入口。
    mcpServer: MCP_SERVER_DESCRIPTOR, // Codex 连接 MCP 时使用的协议入口。
    mcpCapabilityGroups: MCP_CAPABILITY_GROUPS // MCP 工具按业务能力归类后的目录。
  };
}
