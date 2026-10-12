import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { prepareMotionVideos } from "../apps/render-worker/src/motion-video.js";
import { renderManagedMotion } from "../apps/render-worker/src/motion-renderer.js";
import { prepareMotionFonts } from "../packages/motion-work/src/fonts.js";
import { MotionDiagnostics } from "../apps/render-worker/src/motion-diagnostics.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";

// 固定输入仅从已失败Job只读导出；候选副本与缓存均在独立工作区，不调用正式应用写入。
const root = resolve(process.env.VIDEOCUT_WORKSPACE ?? "");
if (!process.env.VIDEOCUT_WORKSPACE || root.toLowerCase().includes("videocut\\workspace")) throw new Error("必须指定独立候选工作区");
const job = JSON.parse(await readFile(".repair-validation/attention-motion-input.json", "utf8"));
const sourceRoot = resolve("workspace/projects", job.projectId);
const output = join(root, "motion-reproduction", String(Date.now()));
await mkdir(output, { recursive: true });
const work = motionSubmissionSchema.parse(job.payload.work);
const diagnostics = new MotionDiagnostics({ jobId: job.id, version: job.payload.version }, progress => console.log(JSON.stringify(progress)));
let provider: Awaited<ReturnType<typeof prepareMotionVideos>> | undefined;
try {
  diagnostics.stage("source_copy");
  for (const binding of [...job.payload.boundImages, ...job.payload.boundVideos]) {
    const target = join(root, binding.managedPath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceRoot, binding.managedPath), target);
  }
  const fonts = prepareMotionFonts(work, job.payload.boundFonts);
  const images: Record<string, string> = {};
  for (const image of job.payload.boundImages) {
    const bytes = await readFile(join(root, image.managedPath));
    images[image.slot] = `data:${bytes[0] === 255 ? "image/jpeg" : "image/png"};base64,${bytes.toString("base64")}`;
  }
  diagnostics.stage("video_preparation");
  provider = await prepareMotionVideos(root, output, work, job.payload.boundVideos, job.payload.engineVersion);
  const result = await renderManagedMotion(work, output, images, provider, undefined, fonts, diagnostics);
  await provider.verifySources();
  await writeFile(join(output, "validation.json"), JSON.stringify({ frameCount: result.frameHashes.length, previewPath: result.previewPath, determinism: result.determinism, summary: diagnostics.summary() }, null, 2));
  console.log(JSON.stringify({ success: true, frameCount: result.frameHashes.length, output }));
} catch (error) {
  console.error(JSON.stringify(await diagnostics.save(root, job.id, error), null, 2));
  process.exitCode = 1;
} finally { await provider?.close(); }
