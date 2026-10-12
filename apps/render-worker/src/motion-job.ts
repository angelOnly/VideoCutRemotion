import { MotionDiagnostics } from "./motion-diagnostics.js";
import { readRuntimeConfig } from "@videocut/project-overview";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { EditingApplication } from "@videocut/application";
import type { JobRecord } from "@videocut/contracts";
import { probeMedia } from "@videocut/speech";
import { boundMotionFontSchema, boundMotionImageSchema, boundMotionVideoSchema, motionSubmissionSchema, parseMotionEvents } from "../../../packages/motion-work/src/schema.js";
import { prepareMotionFonts } from "../../../packages/motion-work/src/fonts.js";
import { motionHash, motionHashEngine, MOTION_ENGINE_VERSION } from "../../../packages/motion-work/src/compiler.js";
import { motionFrameName, renderManagedMotion, verifyMotionPreviewFrames, type MotionRenderResult } from "./motion-renderer.js";
import { MotionDeterminismError } from "./motion-determinism.js";
import { prepareMotionVideos } from "./motion-video.js";
import { DomainError } from "@videocut/domain";
import { checkMotionDiskSpace, motionOutputBudget } from "./motion-output-budget.js";

export async function runMotionJob(application: EditingApplication, job: JobRecord, render = renderManagedMotion, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const diagnostics = new MotionDiagnostics({ jobId: job.id, version: job.payload.version, releaseId: readRuntimeConfig().runtime.releaseId }, state => application.recordJobCheckpoint(job.id, { motionProgress: state }));
  try { return await executeMotionJob(application, job, render, signal, diagnostics); }
  catch (error) {
    const current = application.trackJob(job.id);
    try {
      const report = await diagnostics.save(readRuntimeConfig().workspace.root, job.id, error);
      application.updateJob(job.id, { status: current.status, result: { ...current.result, motionFailure: report } });
    } catch (persistError) {
      diagnostics.additional(persistError, "diagnostic_persistence");
      try { application.recordJobCheckpoint(job.id, { motionFailure: { ...diagnostics.summary(), persistenceError: String(persistError) } }); }
      catch (checkpointError) { console.error("动画诊断保存失败", String(persistError), String(checkpointError)); }
    }
    throw error;
  }
}

async function executeMotionJob(application: EditingApplication, job: JobRecord, render: typeof renderManagedMotion, signal: AbortSignal | undefined, diagnostics: MotionDiagnostics): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  if (job.payload.engineVersion !== MOTION_ENGINE_VERSION) throw new DomainError("历史作品产物保持可读；重新生成须按当前合同提交新版本", "MOTION_ENGINE_UPGRADE_REQUIRED");
  const work = motionSubmissionSchema.parse(job.payload.work);
  const boundImages = boundMotionImageSchema.array().parse(job.payload.boundImages ?? []);
  const boundVideos = boundMotionVideoSchema.array().parse(job.payload.boundVideos ?? []);
  const boundFonts = boundMotionFontSchema.array().parse(job.payload.boundFonts ?? []);
  const hashEngineVersion = motionHashEngine(work, boundImages, job.payload.version, job.payload.engineVersion, boundVideos, boundFonts);
  const version = motionHash(work, boundImages, hashEngineVersion, boundVideos, boundFonts);
  if (job.kind !== "motion_generation" || version !== job.payload.version) throw new Error("MOTION_VERSION_MISMATCH");
  if (Object.keys(work.imageBindings).length !== boundImages.length || new Set(boundImages.map((image) => image.slot)).size !== boundImages.length || boundImages.some((image) => work.imageBindings[image.slot] !== image.assetId)) throw new Error("MOTION_IMAGE_BINDING_MISMATCH");
  if (Object.keys(work.videoBindings ?? {}).length !== boundVideos.length || new Set(boundVideos.map(v => v.slot)).size !== boundVideos.length || boundVideos.some(v => { const b = work.videoBindings?.[v.slot]; return !b || b.assetId !== v.assetId || b.sourceStartMs !== v.sourceStartMs || b.sourceEndMs !== v.sourceEndMs || b.startFrame !== v.startFrame || b.endFrame !== v.endFrame || b.decodeScale !== v.decodeScale; })) throw new Error("MOTION_VIDEO_BINDING_MISMATCH");
  if (Object.keys(work.fontBindings ?? {}).length !== boundFonts.length || new Set(boundFonts.map(f => f.slot)).size !== boundFonts.length
    || boundFonts.some(f => work.fontBindings?.[f.slot] !== f.fontId || f.family !== `VFC_${f.hash}`)) throw new Error("MOTION_FONT_BINDING_MISMATCH");
  diagnostics.stage("font_preparation");
  const fonts = prepareMotionFonts(work, boundFonts);
  const snapshot = application.readProject(job.projectId).snapshot;
  const directory = join(snapshot.project.rootPath, "assets", "derived", "motion", job.id, version);
  const parent = join(snapshot.project.rootPath, "assets", "derived", "motion", job.id);
  await mkdir(parent, { recursive: true });
  if (!await stat(directory).catch(() => undefined)) {
    const temporary = await mkdtemp(join(parent, ".render-"));
    let preserveTemporary = false;
    try {
      diagnostics.stage("image_preparation");
      const outputBudget = motionOutputBudget(work.width, work.height, work.durationInFrames);
      const imageData: Record<string, string> = {};
      if (fonts.length) {
        await mkdir(join(temporary, "resources", "font-files"), { recursive: true });
        for (const { binding, dataUrl, format } of new Map(fonts.map(font => [font.binding.hash, font])).values()) {
          // 按原件格式保存；TTF不伪装成OTF，缓存仍以内容哈希固定身份。
          await writeFile(join(temporary, "resources", "font-files", `${binding.hash}.${format}`), Buffer.from(dataUrl.split(",")[1], "base64"));
        }
      }
      if (boundImages.length) await mkdir(join(temporary, "resources"), { recursive: true });
      for (const image of boundImages) {
        const path = await realpath(resolve(snapshot.project.rootPath, image.managedPath));
        const relativePath = relative(await realpath(snapshot.project.rootPath), path);
        if (isAbsolute(relativePath) || relativePath.startsWith("..")) throw new Error("MOTION_IMAGE_PATH_REJECTED");
        const info = await stat(path);
        if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("MOTION_IMAGE_BUDGET");
        const bytes = await readFile(path);
        if (createHash("sha256").update(bytes).digest("hex") !== image.hash) throw new Error("MOTION_IMAGE_CHANGED");
        const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
        if (!mime) throw new Error("MOTION_IMAGE_FORMAT: 支持已验证 PNG、JPEG、WebP 图片");
        imageData[image.slot] = `data:${mime};base64,${bytes.toString("base64")}`;
        await writeFile(join(temporary, "resources", image.slot), bytes);
      }
      diagnostics.stage("video_preparation");
      const provider = await prepareMotionVideos(snapshot.project.rootPath, temporary, work, boundVideos, hashEngineVersion, signal);
      let rendered: MotionRenderResult;
      try {
        // 源检查后、实际解码前预检；先回收旧缓存，不把缓存限额再次当成必需空间。
        await provider.reserveDiskSpace(outputBudget * 2 + provider.workingSetBytes);
        const disk = await statfs(temporary);
        checkMotionDiskSpace(disk.bavail * disk.bsize, outputBudget, outputBudget + provider.workingSetBytes);
        rendered = await render(work, temporary, imageData, provider, signal, fonts, diagnostics);
        await provider.verifySources();
      } catch (error) {
        // 渲染失败也核查源身份，避免途中改变的原片留下可被下一版本命中的缓存。
        if (!signal?.aborted) { try { await provider.verifySources(); } catch (sourceError) { diagnostics.additional(sourceError, "verify_sources"); } }
        throw error;
      } finally { try { await provider.close(); } catch (closeError) { diagnostics.additional(closeError, "provider_close"); } }
      await writeFile(join(temporary, "source.json"), JSON.stringify(work, null, 2));
      const previewHash = createHash("sha256").update(await readFile(rendered.previewPath)).digest("hex");
      await writeFile(join(temporary, "manifest.json"), JSON.stringify({ version, hashEngineVersion, previewHash, frameHashes: rendered.frameHashes, engineVersion: rendered.engineVersion, sandbox: rendered.sandbox, boundImages, boundVideos, ...(boundFonts.length ? { boundFonts } : {}), videoDecodes: provider.videos, videoResources: provider.stats, events: rendered.events, determinism: rendered.determinism }, null, 2));
      signal?.throwIfAborted();
      if (application.trackJob(job.id).status === "cancelled") throw new DomainError("作品任务已取消", "MOTION_CANCELLED");
      await rename(temporary, directory);
    } catch (error) {
      if (error instanceof MotionDeterminismError) {
        // 只保留小量对比证据，失败帧缓存仍清理；诊断归属 Job，不创建 Asset 或视频 Revision。
        const diagnostics = join(parent, `diagnostics-${basename(temporary).slice(".render-".length)}`);
        try {
          await rename(join(temporary, "diagnostics"), diagnostics);
        } catch (persistError) {
          preserveTemporary = true;
          throw new DomainError(`${error.message}；诊断迁移失败，证据保留于 ${join(temporary, "diagnostics")}：${String(persistError)}`, "MOTION_DIAGNOSTIC_PERSIST_FAILED");
        }
        const reportPath = relative(snapshot.project.rootPath, join(diagnostics, "report.json")).replaceAll("\\", "/");
        const current = application.trackJob(job.id);
        application.updateJob(job.id, { status: current.status, result: { ...current.result, motionDiagnostics: { ...error.report, reportPath } } });
        throw error;
      }
      throw error;
    } finally {
      // temporary 由 mkdtemp 在此任务的受管目录中创建，绝不删除项目根或旧作品版本。
      if (!preserveTemporary) { try { await rm(temporary, { recursive: true, force: true }); } catch (cleanupError) { diagnostics.additional(cleanupError, "temporary_cleanup"); } }
    }
  }
  diagnostics.stage("output_validation");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as MotionRenderResult & { version: string; hashEngineVersion?: string; previewHash: string; videoDecodes?: Record<string, unknown> };
  const storedSource = motionSubmissionSchema.parse(JSON.parse(await readFile(join(directory, "source.json"), "utf8")));
  if (manifest.version !== version || !Array.isArray(manifest.frameHashes) || manifest.frameHashes.length !== work.durationInFrames || motionHash(storedSource, boundImages, manifest.hashEngineVersion ?? manifest.engineVersion, boundVideos, boundFonts) !== version) throw new Error("MOTION_CACHE_CORRUPT");
  if (JSON.stringify((manifest as any).boundFonts ?? []) !== JSON.stringify(boundFonts)) throw new Error("MOTION_FONT_CACHE_CORRUPT");
  for (const font of boundFonts) {
    try {
      const format = fonts.find(prepared => prepared.binding.slot === font.slot)!.format;
      if (createHash("sha256").update(await readFile(join(directory, "resources", "font-files", `${font.hash}.${format}`))).digest("hex") !== font.hash) throw new Error("文件校验值不符");
    } catch (error) { throw new Error(`MOTION_FONT_CACHE_CORRUPT: ${font.fontId}；${String(error)}`); }
  }
  for (const image of boundImages) {
    if (createHash("sha256").update(await readFile(join(directory, "resources", image.slot))).digest("hex") !== image.hash) throw new Error("MOTION_RESOURCE_CACHE_CORRUPT");
  }
  // 完整作品缓存独立于可回收的解码缓存；重生成时才需要重新检查原片。
  if (JSON.stringify((manifest as any).boundVideos ?? []) !== JSON.stringify(boundVideos)) throw new Error("MOTION_RESOURCE_CACHE_CORRUPT");
  for (let frame = 0; frame < work.durationInFrames; frame++) {
    signal?.throwIfAborted();
    const bytes = await readFile(join(directory, "frames", motionFrameName(frame)));
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.frameHashes[frame]) throw new Error("MOTION_CACHE_CORRUPT");
  }
  const previewPath = join(directory, "preview.mp4");
  const metadata = await probeMedia(previewPath);
  await verifyMotionPreviewFrames(previewPath, work.durationInFrames, work.fps);
  if (metadata.width !== work.width || metadata.height !== work.height || Math.abs(metadata.durationMs - work.durationInFrames / work.fps * 1000) > 1000 / work.fps + 2) throw new Error("MOTION_OUTPUT_MISMATCH");
  const sourceHash = createHash("sha256").update(await readFile(previewPath)).digest("hex");
  if (sourceHash !== manifest.previewHash) throw new Error("MOTION_PREVIEW_CACHE_CORRUPT");
  // 缓存命中也从已校验 PNG 重测，不能让损坏的元数据伪装成安全证据；兼容没有测量的旧缓存。
  const eventMap = manifest.events === undefined ? undefined : { version, fps: work.fps, frameCount: work.durationInFrames, events: parseMotionEvents(manifest.events, work.durationInFrames) };
  signal?.throwIfAborted();
  const asset = application.completeManagedMotion({ projectId: job.projectId, jobId: job.id, engineVersion: manifest.engineVersion, sourceHash, metadata, eventMap });
  const motionDiagnostics = manifest.determinism ? { ...manifest.determinism, reportPath: relative(snapshot.project.rootPath, join(directory, "diagnostics", "report.json")).replaceAll("\\", "/") } : undefined;
  return { assetId: asset.id, version, videoDecodes: manifest.videoDecodes, sandbox: manifest.sandbox, workReviewRequired: true, sourcePath: asset.motion!.sourcePath, previewPath: asset.managedPath, ...(motionDiagnostics ? { motionDiagnostics } : {}) };
}
