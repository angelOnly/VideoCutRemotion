/** 只导入应用服务的类型信息；这不会在运行时额外加载或创建服务。 */
import type { EditingApplication } from "./index";

/** 五步生产导航使用的固定阶段标识，供代码、界面和测试共同识别同一阶段。 */
export type VideoProductionStageKey =
  | "materials" // 第一步：读取和登记素材。
  | "understanding" // 第二步：分析并理解素材。
  | "direction" // 第三步：由导演做内容规划。
  | "production" // 第四步：把计划编译成成片结构。
  | "delivery"; // 第五步：预览、导出并交付。

/**
 * 从 EditingApplication 自动收集所有公开“命令”名称。
 * 这样底层命令改名或删除时，下面的流程说明会在编译时提醒开发者同步更新。
 */
export type VideoProductionApplicationMethod = {
  // 逐个检查应用服务的成员：只有可以被调用的函数才会保留为流程入口。
  [Key in keyof EditingApplication]: EditingApplication[Key] extends (...args: never[]) => unknown ? Key : never;
  // 把保留下来的函数名称合并为一个可选名称列表。
}[keyof EditingApplication];

/** 一个阶段中单个可调用入口的、面向阅读者的说明。 */
export type VideoProductionStageEntry = Readonly<{
  /** 界面或文档显示给用户看的简短动作名称。 */
  label: string;
  /** 这个动作实际转发到 EditingApplication 的哪个公开方法。 */
  applicationMethod: VideoProductionApplicationMethod;
  /** 说明该入口负责什么，以及它不会替用户做什么决定。 */
  note: string;
}>;

/** 五步导航中一个完整阶段的结构。 */
export type VideoProductionStage = Readonly<{
  /** 稳定的机器识别名称，不随界面文案变化。 */
  key: VideoProductionStageKey;
  /** 用户看到的步骤编号和中文阶段名称。 */
  title: string;
  /** 这个阶段要达成的业务目标。 */
  goal: string;
  /** 当前阶段统一通过的核心应用服务类名称。 */
  coreClass: "EditingApplication";
  /** 用户在该阶段可选择的已有应用入口。 */
  entryPoints: readonly VideoProductionStageEntry[];
}>;

/**
 * 一屏可读的生产地图。
 *
 * `entryPoints` 既是用户阅读入口，也是与 EditingApplication 公开命令保持同步的类型合同；
 * 它不表示按顺序自动执行，具体素材选择、叙事和视觉判断仍由导演或调用方明确提供。
 */
export const VIDEO_PRODUCTION_STAGES = [
  // 第一阶段先登记“有什么素材”和“素材是否可用”，还不决定怎样剪进成片。
  {
    key: "materials",
    title: "1. 素材读取",
    goal: "建立项目，登记已受管的本地素材，并记录素材需求、来源事实。",
    coreClass: "EditingApplication",
    // 这一阶段只开放素材事实、素材需求和分析任务的入口。
    entryPoints: [
      // 新建一个有版本记录的剪辑项目。
      { label: "创建项目", applicationMethod: "createProject", note: "建立 Project 与第一版 Revision。" },
      // 文件已安全导入后，把它登记为项目素材并启动媒体分析。
      { label: "登记素材", applicationMethod: "registerImportedAsset", note: "上层已安全导入文件后，登记素材并提交媒体分析。" },
      // 查看媒体分析是否已完成，避免使用尚未准备好的素材。
      { label: "跟踪素材分析", applicationMethod: "trackJob", note: "确认媒体分析任务已完成；转写、镜头分析和同步只能使用已就绪素材。" },
      // 补充素材的来源和角色等已知事实，不在此评价创意好坏。
      { label: "补充素材事实", applicationMethod: "updateAssetEditorialMetadata", note: "记录角色、标签、来源信息，不替代内容判断。" },
      // 记录成片还缺什么素材以及为什么缺，不直接安排画面切换。
      { label: "提出素材需求", applicationMethod: "manageAssetRequirement", note: "说明缺少什么素材和原因，不直接决定 Cutaway。" },
      // 保存素材平台返回的候选及筛选过程，保证来源可追溯。
      { label: "记录搜索与候选", applicationMethod: "recordAssetSearch", note: "保存 Provider 返回的候选和过滤结果。" }
    ]
  },
  // 第二阶段把已登记素材变成可验证的文字、镜头或同步候选，仍不替导演下结论。
  {
    key: "understanding",
    title: "2. 理解视频",
    goal: "把素材转为可追溯的转写、镜头或同步候选；候选不是自动创作结论。",
    coreClass: "EditingApplication",
    // 这些入口启动分析或读取分析结果。
    entryPoints: [
      // 为含声音且已就绪的素材提交语音转写。
      { label: "提交转写", applicationMethod: "submitTranscription", note: "为已就绪且有声音的素材创建转写 Job。" },
      // 为实拍或混合视频提交可测量的镜头分析。
      { label: "提交镜头分析", applicationMethod: "submitVlogAnalysis", note: "为 Vlog/Hybrid 素材创建可测量的镜头分析 Job。" },
      // 为多机位素材生成同步候选，之后仍需用预览验证。
      { label: "提交多机位同步", applicationMethod: "submitMulticamSync", note: "生成同步候选，后续仍需预览确认。" },
      // 读取三类理解任务的完成、失败和结果状态。
      { label: "跟踪理解任务", applicationMethod: "trackJob", note: "读取转写、镜头分析或同步任务的完成、失败与结果状态。" },
      // 从当前项目版本读回已确认的事实和分析状态。
      { label: "读取当前事实", applicationMethod: "readProject", note: "从当前 Revision 读取素材、分析结果和状态。" }
    ]
  },
  // 第三阶段由人或主工作流做创作决定，并将已确认结论写入当前版本。
  {
    key: "direction",
    title: "3. 导演规划",
    goal: "由人或主工作流明确故事、语义、镜头与视觉意图，再写入当前 Revision。",
    coreClass: "EditingApplication",
    // 这些入口只保存明确的导演结论，门面不会自行补全内容。
    entryPoints: [
      // 写入故事节拍和叙事顺序。
      { label: "更新故事", applicationMethod: "updateStory", note: "写入 StoryBeat 与叙事顺序，不根据关键词自行编故事。" },
      // 保存审查过的语义边界。
      { label: "确认语义单元", applicationMethod: "applySemanticUnits", note: "将已审查的语义边界写入项目。" },
      // 根据明确选择的语义单元生成当前脚本。
      { label: "确认脚本", applicationMethod: "applyScript", note: "以明确选择的 SemanticUnit 生成当前 Script。" },
      // 为视觉解释型视频记录叙事地图。
      { label: "规划解释结构", applicationMethod: "manageNarrativeMap", note: "为视觉解释片写入 NarrativeMap。" },
      // 决定人物保留、B-roll、动态图形或安静区等视觉处理。
      { label: "规划视觉处理", applicationMethod: "manageVisualTreatment", note: "写入保持人物、B-roll、Remotion 或安静区等决定。" },
      // 把已分析的实拍证据组织成 Vlog 事件。
      { label: "规划 Vlog 事件", applicationMethod: "manageVlogEvents", note: "把已分析的实拍证据组织成事件，而不是猜测不存在的动作。" },
      // 人工确认 Vlog 镜头的用途和连续性理由。
      { label: "确认 Vlog 镜头选择", applicationMethod: "manageVlogShotSelects", note: "由导演明确镜头用途与连续性理由，不能按技术评分自动入选。" },
      // 将连续预览已验证的多机位同步候选写成可编译事实。
      { label: "确认多机位同步", applicationMethod: "verifyMulticamGroup", note: "只把已完成连续预览的同步候选写为可编译事实。" },
      // 由导演确定每一段使用哪个机位，不绕过已验证的偏移。
      { label: "规划多机位切换", applicationMethod: "manageMulticamCuts", note: "由导演明确机位和会话范围，不绕过已验证的同步偏移。" }
    ]
  },
  // 第四阶段将已确认的计划变成时间线、画面、字幕和声音，不能暗中改写主线。
  {
    key: "production",
    title: "4. 成片生产",
    goal: "把已经确认的导演计划编译为时间线、画面、字幕和声音；不在这里悄悄重写主线。",
    coreClass: "EditingApplication",
    // 这些入口把既定计划落实为可播放的项目对象。
    entryPoints: [
      // 将已选 A-roll 排成 Presenter 的物理主画面。
      { label: "组装 Presenter 主线", applicationMethod: "assemblePresenterTrack", note: "将已经选择的 A-roll 组织为物理主画面，不自动生成叙事场景。" },
      // 根据已确认的故事、语义和视觉计划生成 Presenter 场景。
      { label: "编译 Presenter 场景", applicationMethod: "compilePresenterScenes", note: "只根据已确认的故事、语义和视觉计划编译 Presenter 场景。" },
      // 将视觉解释计划变成可播放的 Scene Program。
      { label: "编译 Explainer", applicationMethod: "compileExplainerScenes", note: "将已确认的解释场景编译为 Scene Program。" },
      // 将确认过的 Vlog 镜头选择变成蒙太奇。
      { label: "编译 Vlog", applicationMethod: "compileVlogMontage", note: "将已确认的镜头选择编译为 Montage。" },
      // 用已验证的同步和已确认的机位切换生成多机位节目。
      { label: "编译多机位", applicationMethod: "compileMulticamProgram", note: "只使用已验证的同步和人工确认的机位切换。" },
      // 按既定场景规则放置、替换或移除辅助画面。
      { label: "放置视觉包装", applicationMethod: "manageCutaway", note: "按既定场景决定放置、替换或移除 Cutaway。" },
      // 为当前已稳定的主线编辑字幕卡，不更改脚本或语音。
      { label: "编辑字幕", applicationMethod: "editCaptions", note: "只编辑当前稳定主线的字幕 Card，不改变 Script 或音频。" },
      // 为明确的声音点位写入背景音乐或音效提示。
      { label: "制作 BGM / SFX", applicationMethod: "manageAudio", note: "写入明确的 AudioCue，不自动猜测声音落点。" }
    ]
  },
  // 第五阶段先检查真实合成结果，再导出并批准某一个具体成片文件。
  {
    key: "delivery",
    title: "5. 预览与交付",
    goal: "先查看真实合成和预检，再导出、复核与批准具体 Artifact。",
    coreClass: "EditingApplication",
    // 这些入口只处理预览、导出和成片文件的复核与批准。
    entryPoints: [
      // 为指定项目版本创建预览任务。
      { label: "提交预览", applicationMethod: "submitPreview", note: "创建目标 Revision 的 Preview Job。" },
      // 导出前检查文件和运行环境依赖。
      { label: "提交交付预检", applicationMethod: "submitRenderPreflight", note: "检查目标 Revision 的文件、权限和运行时依赖。" },
      // 发起草稿或正式交付导出，导出本身不等于用户批准。
      { label: "提交导出", applicationMethod: "submitExport", note: "区分 draft 与 delivery，不把导出当成批准。" },
      // 读取预览、预检或导出任务的状态和结果。
      { label: "跟踪交付任务", applicationMethod: "trackJob", note: "读取 Preview、预检或导出 Job 的完成、失败与结果状态。" },
      // 把审片证据绑定到某一个实际导出的正式成片文件。
      { label: "登记成片复核", applicationMethod: "recordExportArtifactReview", note: "将五轮审片证据绑定到具体 delivery Artifact。" },
      // 仅批准已经复核且未被新版本替换的正式成片。
      { label: "批准交付", applicationMethod: "approveExportArtifact", note: "只批准已复核且未被替换的 delivery Artifact。" }
    ]
  }
] as const satisfies readonly VideoProductionStage[];

/** 从核心应用服务中取出某个命令的函数签名，供门面保持完全一致的入参与返回值。 */
type ApplicationCommand<Method extends VideoProductionApplicationMethod> = Extract<
  EditingApplication[Method],
  (...args: never[]) => unknown
>;

/** 根据命令名称得到该命令唯一的请求参数类型。 */
type ApplicationInput<Method extends VideoProductionApplicationMethod> = Parameters<ApplicationCommand<Method>>[0];

/** 根据命令名称得到该命令原样返回的结果类型。 */
type ApplicationResult<Method extends VideoProductionApplicationMethod> = ReturnType<ApplicationCommand<Method>>;

/** 素材读取门面：只登记事实和异步分析入口，不决定素材在成片中的具体用法。 */
export class VideoProductionMaterials {
  /** 保存已有应用服务的引用；不会创建新的数据库、项目或状态。 */
  constructor(private readonly application: EditingApplication) {}

  /** 创建一个项目及其初始版本；请求和结果与核心应用服务保持一致。 */
  createProject(input: ApplicationInput<"createProject">): ApplicationResult<"createProject"> {
    // 原样转交给已有服务，由已有服务负责保存和校验。
    return this.application.createProject(input);
  }

  /** 登记已经由上层安全导入的素材，并发起其媒体分析。 */
  registerImportedAsset(input: ApplicationInput<"registerImportedAsset">): ApplicationResult<"registerImportedAsset"> {
    // 门面不直接读写文件，只转交既有的素材登记命令。
    return this.application.registerImportedAsset(input);
  }

  /** 读取一个异步任务当前的完成、失败或进行中状态。 */
  trackJob(input: ApplicationInput<"trackJob">): ApplicationResult<"trackJob"> {
    // 返回既有任务服务的真实状态和结果，不制造新的状态。
    return this.application.trackJob(input);
  }

  /** 补充素材角色、标签、来源等编辑事实。 */
  updateAssetEditorialMetadata(input: ApplicationInput<"updateAssetEditorialMetadata">): ApplicationResult<"updateAssetEditorialMetadata"> {
    // 原样交给核心应用服务保存，不替用户判断素材是否好用。
    return this.application.updateAssetEditorialMetadata(input);
  }

  /** 记录项目还缺少的素材及其用途说明。 */
  manageAssetRequirement(input: ApplicationInput<"manageAssetRequirement">): ApplicationResult<"manageAssetRequirement"> {
    // 只保存素材需求，不自动搜索或决定最终画面切换。
    return this.application.manageAssetRequirement(input);
  }

  /** 保存外部素材搜索的候选、筛选结果和可追溯信息。 */
  recordAssetSearch(input: ApplicationInput<"recordAssetSearch">): ApplicationResult<"recordAssetSearch"> {
    // 调用既有搜索记录命令，门面不访问任何外部素材平台。
    return this.application.recordAssetSearch(input);
  }
}

/** 视频理解门面：发起或读取可验证的分析，不把候选分析结果伪装成导演决定。 */
export class VideoProductionUnderstanding {
  /** 保存已有应用服务的引用；不会创建另一份项目数据。 */
  constructor(private readonly application: EditingApplication) {}

  /** 为已就绪的有声素材提交语音转写任务。 */
  submitTranscription(input: ApplicationInput<"submitTranscription">): ApplicationResult<"submitTranscription"> {
    // 原样转发，实际转写由既有异步任务链处理。
    return this.application.submitTranscription(input);
  }

  /** 为实拍或混合视频提交镜头分析任务。 */
  submitVlogAnalysis(input: ApplicationInput<"submitVlogAnalysis">): ApplicationResult<"submitVlogAnalysis"> {
    // 原样转发，门面不自行推断镜头内容。
    return this.application.submitVlogAnalysis(input);
  }

  /** 为同一场录制的多机位素材提交同步候选计算。 */
  submitMulticamSync(input: ApplicationInput<"submitMulticamSync">): ApplicationResult<"submitMulticamSync"> {
    // 原样转发，同步候选仍需在后续阶段用预览确认。
    return this.application.submitMulticamSync(input);
  }

  /** 跟踪转写、镜头分析或多机位同步等异步任务。 */
  trackJob(input: ApplicationInput<"trackJob">): ApplicationResult<"trackJob"> {
    // 返回已有任务链的真实状态，不对结果做二次解释。
    return this.application.trackJob(input);
  }

  /** 读取当前项目版本中已经保存的素材、分析和状态事实。 */
  readProject(input: ApplicationInput<"readProject">): ApplicationResult<"readProject"> {
    // 直接读取现有项目版本，不创建或修改任何内容。
    return this.application.readProject(input);
  }
}

/** 导演规划门面：调用方必须提供自己的创作结论，门面不会补全或推断这些结论。 */
export class VideoProductionDirection {
  /** 保存已有应用服务的引用；导演结论仍由调用方提供。 */
  constructor(private readonly application: EditingApplication) {}

  /** 写入故事节拍和叙事顺序。 */
  updateStory(input: ApplicationInput<"updateStory">): ApplicationResult<"updateStory"> {
    // 将调用方已确认的故事原样交给核心应用服务。
    return this.application.updateStory(input);
  }

  /** 写入已经审查过的语义单元边界。 */
  applySemanticUnits(input: ApplicationInput<"applySemanticUnits">): ApplicationResult<"applySemanticUnits"> {
    // 不按标点或关键词自动补切，只保存调用方提交的边界。
    return this.application.applySemanticUnits(input);
  }

  /** 根据明确选择的语义单元写入当前脚本。 */
  applyScript(input: ApplicationInput<"applyScript">): ApplicationResult<"applyScript"> {
    // 原样转发脚本请求，实际版本校验仍由核心应用服务执行。
    return this.application.applyScript(input);
  }

  /** 为视觉解释类视频保存叙事地图。 */
  manageNarrativeMap(input: ApplicationInput<"manageNarrativeMap">): ApplicationResult<"manageNarrativeMap"> {
    // 只提交已有的解释结构，不自动生成事实或观点。
    return this.application.manageNarrativeMap(input);
  }

  /** 保存每个故事节拍应如何呈现的视觉处理决定。 */
  manageVisualTreatment(input: ApplicationInput<"manageVisualTreatment">): ApplicationResult<"manageVisualTreatment"> {
    // 原样转交，门面不会凭关键词自动选 B-roll 或效果。
    return this.application.manageVisualTreatment(input);
  }

  /** 保存从实拍分析证据整理出的 Vlog 事件。 */
  manageVlogEvents(input: ApplicationInput<"manageVlogEvents">): ApplicationResult<"manageVlogEvents"> {
    // 核心应用服务负责保存；门面不会猜测素材中不存在的动作。
    return this.application.manageVlogEvents(input);
  }

  /** 保存导演确认过的 Vlog 镜头选择与连续性理由。 */
  manageVlogShotSelects(input: ApplicationInput<"manageVlogShotSelects">): ApplicationResult<"manageVlogShotSelects"> {
    // 原样转发，不会按技术分数擅自将镜头加入成片。
    return this.application.manageVlogShotSelects(input);
  }

  /** 将已用连续预览验证的多机位同步候选确认下来。 */
  verifyMulticamGroup(input: ApplicationInput<"verifyMulticamGroup">): ApplicationResult<"verifyMulticamGroup"> {
    // 由既有服务执行版本和预览证据校验。
    return this.application.verifyMulticamGroup(input);
  }

  /** 保存导演决定的多机位切换点和使用机位。 */
  manageMulticamCuts(input: ApplicationInput<"manageMulticamCuts">): ApplicationResult<"manageMulticamCuts"> {
    // 原样转发，避免绕开已验证的同步偏移。
    return this.application.manageMulticamCuts(input);
  }
}

/** 成片生产门面：仅把明确的计划交给既有编译命令，不在门面层实现剪辑业务规则。 */
export class VideoProductionCompilation {
  /** 保存已有应用服务的引用；不会新建第二套编译器。 */
  constructor(private readonly application: EditingApplication) {}

  /** 将已选择的人物主镜头组织为 Presenter 的物理主画面。 */
  assemblePresenterTrack(input: ApplicationInput<"assemblePresenterTrack">): ApplicationResult<"assemblePresenterTrack"> {
    // 仅调用已有组装命令，不在门面层自动写故事或场景。
    return this.application.assemblePresenterTrack(input);
  }

  /** 依据已确认的故事、语义和视觉计划编译 Presenter 场景。 */
  compilePresenterScenes(input: ApplicationInput<"compilePresenterScenes">): ApplicationResult<"compilePresenterScenes"> {
    // 将请求交给既有编译器，由它执行依赖与版本检查。
    return this.application.compilePresenterScenes(input);
  }

  /** 将已确认的视觉解释计划编译成场景程序。 */
  compileExplainerScenes(input: ApplicationInput<"compileExplainerScenes">): ApplicationResult<"compileExplainerScenes"> {
    // 原样调用既有 Explainer 编译命令，不生成新的叙事决定。
    return this.application.compileExplainerScenes(input);
  }

  /** 将已确认的 Vlog 镜头选择编译为连续蒙太奇。 */
  compileVlogMontage(input: ApplicationInput<"compileVlogMontage">): ApplicationResult<"compileVlogMontage"> {
    // 原样转发，由已有编译器保持镜头选择与版本一致。
    return this.application.compileVlogMontage(input);
  }

  /** 将已验证的多机位同步和切换计划编译为节目结构。 */
  compileMulticamProgram(input: ApplicationInput<"compileMulticamProgram">): ApplicationResult<"compileMulticamProgram"> {
    // 既有服务负责确保只使用已验证的同步数据。
    return this.application.compileMulticamProgram(input);
  }

  /** 按既定场景决定放置、替换或移除辅助画面。 */
  manageCutaway(input: ApplicationInput<"manageCutaway">): ApplicationResult<"manageCutaway"> {
    // 原样转发，不会因为素材存在就自动插入画面。
    return this.application.manageCutaway(input);
  }

  /** 为当前稳定主线编辑字幕卡。 */
  editCaptions(input: ApplicationInput<"editCaptions">): ApplicationResult<"editCaptions"> {
    // 只调用字幕编辑命令，不改写脚本或生成新的语音。
    return this.application.editCaptions(input);
  }

  /** 写入已经明确设计的背景音乐、淡化和音效提示。 */
  manageAudio(input: ApplicationInput<"manageAudio">): ApplicationResult<"manageAudio"> {
    // 原样转发音频计划，不在门面层猜测声音落点。
    return this.application.manageAudio(input);
  }
}

/** 预览交付门面：所有命令仍由既有 Job 和 Artifact 门禁处理，门面不绕过任何校验。 */
export class VideoProductionDelivery {
  /** 保存已有应用服务的引用；不会另建导出记录或审批状态。 */
  constructor(private readonly application: EditingApplication) {}

  /** 为指定项目版本提交真实合成预览任务。 */
  submitPreview(input: ApplicationInput<"submitPreview">): ApplicationResult<"submitPreview"> {
    // 原样转发，由已有任务链生成可查看的预览结果。
    return this.application.submitPreview(input);
  }

  /** 在导出前检查文件和运行时依赖是否齐全。 */
  submitRenderPreflight(input: ApplicationInput<"submitRenderPreflight">): ApplicationResult<"submitRenderPreflight"> {
    // 原样调用预检，门面不会跳过任何交付门禁。
    return this.application.submitRenderPreflight(input);
  }

  /** 提交草稿或正式交付的导出任务。 */
  submitExport(input: ApplicationInput<"submitExport">): ApplicationResult<"submitExport"> {
    // 原样转发，导出成功仍不代表用户已经批准成片。
    return this.application.submitExport(input);
  }

  /** 跟踪预览、预检和导出任务的真实状态。 */
  trackJob(input: ApplicationInput<"trackJob">): ApplicationResult<"trackJob"> {
    // 直接返回既有 Job 系统的状态和结果。
    return this.application.trackJob(input);
  }

  /** 将审片结论和证据登记到一个具体的正式成片文件。 */
  recordExportArtifactReview(input: ApplicationInput<"recordExportArtifactReview">): ApplicationResult<"recordExportArtifactReview"> {
    // 原样转发，确保复核证据由既有 Artifact 规则绑定。
    return this.application.recordExportArtifactReview(input);
  }

  /** 批准已经复核通过且没有被新版本替换的正式成片文件。 */
  approveExportArtifact(input: ApplicationInput<"approveExportArtifact">): ApplicationResult<"approveExportArtifact"> {
    // 原样转发，已有服务继续负责审批前置条件。
    return this.application.approveExportArtifact(input);
  }
}

/**
 * 高层生产流程门面。
 *
 * 它只保存同一个 EditingApplication 引用；各阶段方法都一对一委托给原有公开命令。
 * 因此现有 Revision、Job、权限和交付门禁保持完全不变。
 */
export class VideoProductionFlow {
  /** 供界面或文档直接展示的五阶段导航，不包含项目运行状态。 */
  readonly stages = VIDEO_PRODUCTION_STAGES;
  /** 第一步素材读取的简化入口。 */
  readonly materials: VideoProductionMaterials;
  /** 第二步视频理解的简化入口。 */
  readonly understanding: VideoProductionUnderstanding;
  /** 第三步导演规划的简化入口。 */
  readonly direction: VideoProductionDirection;
  /** 第四步成片生产的简化入口。 */
  readonly production: VideoProductionCompilation;
  /** 第五步预览与交付的简化入口。 */
  readonly delivery: VideoProductionDelivery;

  /** 使用一个现有应用服务组装五个门面，不创建额外的项目或数据库。 */
  constructor(public readonly application: EditingApplication) {
    // 创建第一步门面，并共享同一个应用服务。
    this.materials = new VideoProductionMaterials(application);
    // 创建第二步门面，并共享同一个应用服务。
    this.understanding = new VideoProductionUnderstanding(application);
    // 创建第三步门面，并共享同一个应用服务。
    this.direction = new VideoProductionDirection(application);
    // 创建第四步门面，并共享同一个应用服务。
    this.production = new VideoProductionCompilation(application);
    // 创建第五步门面，并共享同一个应用服务。
    this.delivery = new VideoProductionDelivery(application);
  }
}

/** 使用已有 EditingApplication 创建高层流程门面；不会创建额外仓储或项目状态。 */
export function createProductionFlow(application: EditingApplication): VideoProductionFlow {
  // 返回只做命令转发的门面对象，所有真实处理仍在已有应用服务中完成。
  return new VideoProductionFlow(application);
}
