import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import { renderManagedMotion, verifyMotionPreviewFrames } from "../apps/render-worker/src/motion-renderer.js";
import { runProcess, probeMedia } from "@videocut/speech";

const output = resolve(".candidate/media-intelligence-20260908/selected-cases");
await mkdir(output, { recursive: true });
const results: Array<Record<string, unknown>> = [];
for (const name of ["sim-paper", "smooth-relay", "ticket-phone", "product-fan", "cover-flow", "comment-focus"]) {
  const directory = resolve(`.agents/skills/motion-case-library/references/cases/motion-case-${name}/assets`);
  const fixture = JSON.parse(await readFile(join(directory, "fixture.json"), "utf8"));
  const parts = fixture.parts ?? [{ source: fixture.sourceFiles[0], ...fixture }];
  const images: Record<string, string> = {};
  for (const [slot, file] of Object.entries(fixture.imageSlots)) images[slot] = `data:image/jpeg;base64,${(await readFile(join(directory, String(file)))).toString("base64")}`;
  for (const part of parts) {
    let source = await readFile(join(directory, part.source), "utf8");
    const archivedHash = createHash("sha256").update(source).digest("hex");
    if (name === "product-fan") {
      // 从用户选定的 v2 派生验收作品；同一时序对象同时驱动画面和事件，不手填第二套帧。
      source = `const timings = { fan: [30,100], gather: [125,195], drop: [200,295] };\nexport function resolveMotionEvents(){return [{id:'fan',meaning:'同一组产品展开',startFrame:timings.fan[0],endFrame:timings.fan[1]},{id:'gather',meaning:'回收注意力',startFrame:timings.gather[0],endFrame:timings.gather[1]},{id:'drop',meaning:'行动箭头接管',startFrame:timings.drop[0],endFrame:timings.drop[1]}];}\n` + source.replace("const fan=p(f,30,100),gather=p(f,125,195),drop=p(f,200,295);", "const fan=p(f,timings.fan[0],timings.fan[1]),gather=p(f,timings.gather[0],timings.gather[1]),drop=p(f,timings.drop[0],timings.drop[1]);");
    }
    const work = motionSubmissionSchema.parse({ name: `${fixture.title} · 技术验收`, source, props: part.props, width: part.width, height: part.height, fps: part.fps, durationInFrames: part.durationInFrames, creativeBrief: "以用户当前选定的原案例核验隔离编译、连续渲染与作品动作事件。仅限本地技术验收，不代表声音听审或引用权利通过。", });
    const fingerprint = createHash("sha256").update(JSON.stringify(work)).digest("hex");
    const target = join(output, name, part.source.replace(/\.tsx$/u, ""));
    await mkdir(target, { recursive: true });
    let result;
    const previous = JSON.parse(await readFile(join(target, "verification.json"), "utf8").catch(() => "null"));
    if (previous?.fingerprint === fingerprint && await stat(join(target, "preview.mp4")).catch(() => undefined)) {
      await verifyMotionPreviewFrames(join(target, "preview.mp4"), work.durationInFrames, work.fps); result = previous;
    } else {
      const rendered = await renderManagedMotion(work, target, images);
      result = { case: name, part: part.source, archivedHash, fingerprint, preview: rendered.previewPath, engineVersion: rendered.engineVersion, events: rendered.events, frameCount: rendered.frameHashes.length, fps: work.fps, audioReview: "inconclusive", note: "这是分段动效渲染；SIM 后段底层素材和合集交叠分别依照 fixture 合成。" };
      await writeFile(join(target, "verification.json"), JSON.stringify(result, null, 2));
      await writeFile(join(target, "work.json"), JSON.stringify(work, null, 2));
    }
    results.push(result); await writeFile(join(output, "report.json"), JSON.stringify(results, null, 2));
    console.log(`${name}/${part.source}：${work.durationInFrames} 帧，${result.engineVersion}`);
  }
}

// 外层实拍与跨段过渡属于组合合同，复用已渲染帧，不改动冻结案例。
const compositions: Array<Record<string, unknown>> = [];
for (const name of ["sim-paper", "smooth-relay"]) {
  const directory = resolve(`.agents/skills/motion-case-library/references/cases/motion-case-${name}/assets`);
  const fixture = JSON.parse(await readFile(join(directory, "fixture.json"), "utf8"));
  const target = join(output, name, "composed.mp4");
  if (name === "sim-paper") {
    const normalize = `scale=${fixture.width}:${fixture.height}:force_original_aspect_ratio=increase,crop=${fixture.width}:${fixture.height},fps=${fixture.fps},setsar=1`;
    await runProcess("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", `color=black:s=${fixture.width}x${fixture.height}:r=${fixture.fps}:d=24`,
      "-i", join(directory, "tower.mp4"), "-i", join(directory, "phone.mp4"), "-framerate", "24", "-i", join(output, name, "motion/frames/frame-%05d.png"),
      "-filter_complex", `[1:v]${normalize},trim=duration=4,setpts=PTS-STARTPTS+16/TB[tower];[2:v]${normalize},trim=duration=4,setpts=PTS-STARTPTS+20/TB[phone];[0:v][tower]overlay=eof_action=pass:repeatlast=0[b1];[b1][phone]overlay=eof_action=pass:repeatlast=0[b2];[b2][3:v]overlay=eof_action=pass:shortest=1[v]`,
      "-map", "[v]", "-an", "-frames:v", "576", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", target], 180000);
  } else {
    await runProcess("ffmpeg", ["-hide_banner", "-y", "-i", join(output, name, "sim/preview.mp4"), "-i", join(output, name, "qci/preview.mp4"), "-i", join(output, name, "clock/preview.mp4"),
      "-filter_complex", "[0:v]settb=1/30,setpts=PTS-STARTPTS[a];[1:v]settb=1/30,setpts=PTS-STARTPTS[b];[2:v]settb=1/30,setpts=PTS-STARTPTS[c];[a][b]xfade=transition=smoothleft:duration=0.8:offset=5.2[ab];[ab][c]xfade=transition=smoothleft:duration=0.8:offset=12.733333333[v]",
      "-map", "[v]", "-an", "-frames:v", "577", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", target], 180000);
  }
  await verifyMotionPreviewFrames(target, fixture.durationInFrames, fixture.fps);
  compositions.push({ case: name, path: target, metadata: await probeMedia(target), note: "按最新案例的真实外层输入/24帧过渡组合，仅本地技术审阅；没有新增声音结论。" });
}
await writeFile(join(output, "compositions.json"), JSON.stringify(compositions, null, 2));
