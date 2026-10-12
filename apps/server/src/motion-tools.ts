import { toolErrorResult } from "./tool-error.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EditingApplication } from "@videocut/application";
import { MOTION_SOURCES } from "../../../packages/motion-work/src/catalog.js";
import { motionSubmissionSchema, motionReviewFields } from "../../../packages/motion-work/src/schema.js";
import { inspectMotionReferenceViaRuntime } from "./motion-reference-client.js";
import { listMotionFonts, MotionFontUnknownError } from "../../../packages/motion-work/src/fonts.js";
import { motionAllowedImports, MOTION_ENGINE_VERSION } from "../../../packages/motion-work/src/compiler.js";

export function registerMotionTools(server: McpServer, application: EditingApplication, projectIdFrom: (value?: string) => string) {
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const failure = toolErrorResult;
  server.registerTool("read_motion_capabilities", {
    title: "读取受管动画能力与字体", description: "只读查询当前动画引擎、允许导入的接口及随Runtime发布的字体。fontBindings用槽名映射fontId；平台校验文件并在首次挂载前加载，源码使用props.fonts[槽位]的family、weight、style，不自行加载字体或联网。新增字体需要发布新版Runtime。",
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, async () => { try { return result({ engineVersion: MOTION_ENGINE_VERSION, allowedImports: motionAllowedImports(), fonts: listMotionFonts(),
    videoBindings: { maxSlots: null, clock: "work_root", playback: "normal_speed_muted", description: "不设作品视频选段总数上限；每槽固定源身份、哈希、源范围和作品帧范围。分块串行解码并复用缓存，真实资源不足明确失败，不删减选段或静默降质；解码块预算不等于浏览器总内存预算。" },
    fontBindingExample: { title: "noto-sans-sc-bold" }, execution: "仅使用已登记本地字体；通过fontBindings声明，props.fonts由平台注入。配色、描边与帧驱动动效由作者生成，不要求花字模板。理想字体未收录不是平台故障：主任务控制流程，原视觉作者推荐最多3款，使用get_editor_url(panel=fonts,font_preview=...)让用户在工作台预览后通过聊天确认；等待时继续无依赖工作，不报工单、不自动替代。已登记原件缺失、变更或加载失败仍明确报错。" }); } catch (error) { return failure(error); } });
  server.registerTool("inspect_motion_reference", {
    title: "查看在线动效参考", description: "在独立浏览器只读查看四个来源的公开页面。先返回预览索引和页面截图，再通过 preview_index 连续采样一个动效；不下载媒体，不跨越登录、验证或付费限制。",
    inputSchema: { source_url: z.string().url(), preview_index: z.number().int().nonnegative().max(300).optional(), sample_duration_ms: z.number().int().min(1000).max(20000).default(6000) }, annotations: { readOnlyHint: true }
  }, async ({ source_url, preview_index, sample_duration_ms }) => { try {
    const { images, ...evidence } = await inspectMotionReferenceViaRuntime(source_url, preview_index, sample_duration_ms);
    return { content: [...result({ ...evidence, samples: images.map(({ elapsedMs }) => ({ elapsedMs })) }).content, ...images.map((item) => ({ type: "image" as const, mimeType: "image/png", data: item.data }))] };
  } catch (error) { return failure(error); } });
  server.registerTool("browse_motion_sources", { title: "在线动效来源", description: "返回已选的四个在线视觉参考库与访问入口，不下载整库，不表示已经观看预览。AE/Jitter 与开源组件均可作为 Remotion 实现参考。", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => result({ sources: MOTION_SOURCES, execution: "通过 submit_motion_work 提交默认导出的 React + Remotion TSX；原创作品按内容设计并填写 creativeBrief；仅在需要参考时观看并记录布局、运动、节奏和适配依据。" }));
  server.registerTool("submit_motion_work", {
    title: "生成受管 Remotion 作品", description: "新作品填写 work.creativeBrief，提交固定源码、Props、图片及视频绑定，排队隔离渲染；不自动放入Timeline。修改作品重新提交并填写previousAssetId。视频最多4个选段，每槽声明assetId、sourceStartMs、sourceEndMs、startFrame、endFrame及可选decodeScale；源码import {TimelineVideo} from '@videoflowcut/motion'，以slot、fit、style显示。平台使用作品根时钟，内部Sequence不重置源时间，不接受offsetInFrames。输出帧数以endFrame-startFrame为准，源范围允许毫秒取整及不足一帧余量；正常速度且静音，原声在声音轨明确编排。源不足、源变化或取帧越界报错，不自动冻结或循环。原片按内容身份共享，不按槽复制；解码缓存按需生成、有界回收，不按原片或累计解码512MB拒绝。完整作品不设30秒、900帧或650000000累计像素帧门槛，由Worker提前检查完整输出及临时工作区真实磁盘需求；失败不登记半件Asset。画布宽高64–1920偶数、fps15–60整数；所有帧连续渲染并验证，一个Job产生一个完整Asset。imageBindings将图片映射到props.assets，使用Remotion Img，不允许任意资源URL。历史作品产物可读；历史引擎重新生成须按新合同提交。技术生成不替代连续审片。",
    // 源码拒绝经应用层确认未入队后，由统一错误映射返回定位与纠正依据；不自动重试。
    inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), idempotency_key: z.string().min(1).max(160), work: motionSubmissionSchema }
  }, async ({ project_id, base_revision_id, idempotency_key, work }) => { try { return result(application.submitManagedMotion({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, idempotencyKey: idempotency_key, work })); } catch (error) {
    // 只对明确发生在createJob之前的未知ID开放选择纠正，不放宽运行失败或未知结果重放。
    if (error instanceof MotionFontUnknownError) return { ...result({ error: error.message, code: "MOTION_FONT_UNKNOWN", stage: "validation", fontId: error.fontId,
      sideEffects: "none", safeToRetry: true, recovery: "select_registered_font", selectionRequired: true,
      instruction: "不提交修复工单。主任务请原作者推荐已登记字体，展示工作台预览，收到用户选择后修订方案并正常提交；不能直接重放原输入。" }), isError: true };
    return failure(error);
  } });
  server.registerTool("read_motion_work", {
    title: "读取作品源码与状态", description: "读取所属项目的固定输入、Job、生成 Asset 与审阅状态；不会修改作品。", inputSchema: { project_id: z.string().optional(), job_id: z.string() }, annotations: { readOnlyHint: true }
  }, async ({ project_id, job_id }) => { try { return result(application.readManagedMotion(projectIdFrom(project_id), job_id)); } catch (error) { return failure(error); } });
  server.registerTool("review_motion_work", {
    title: "记录作品动态审阅", description: "对照 creativeBrief 查看作品，再记录 outcome、note 和 evidence。evidence范围为半开区间[startFrame,endFrame)：work_proxy使用作品局部帧；project_preview使用项目全局帧，并绑定同Revision成功Preview。failed/inconclusive可记录与该版本有效Cue相交的实际局部观察，无需覆盖整件；抽帧点和未确认范围写入note，不把未观看范围扩大成证据。只有passed要求完整覆盖作品及continuous_video/audiovisual连续证据。未审或证据不足如实保留，不阻挡放置、修订、制作完成或导出；只有技术/用途条件参与阻挡。reference_match只兼容历史参考作品，不能与outcome同传。合成与最终文件仍须独立审阅。",
    inputSchema: { project_id: z.string().optional(), base_revision_id: z.number().int().positive(), asset_id: z.string(), reference_match: motionReviewFields.referenceMatch, outcome: motionReviewFields.outcome, note: motionReviewFields.note, evidence: motionReviewFields.evidence }
  }, async ({ project_id, base_revision_id, asset_id, reference_match, outcome, evidence, note }) => { try { return result(await application.reviewManagedMotion({ projectId: projectIdFrom(project_id), baseRevision: base_revision_id, assetId: asset_id, referenceMatch: reference_match, outcome, evidence, note })); } catch (error) { return failure(error); } });
}
