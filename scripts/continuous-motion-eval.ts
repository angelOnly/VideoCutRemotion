/** 作者提供设计；本脚本只负责隔离渲染与整段/分块技术对照。 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { motionFixture } from "../tests/fixtures/managed-motion.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";
import { bindMotionFonts, prepareMotionFonts } from "../packages/motion-work/src/fonts.js";
import { prepareMotionVideos, hashMotionFile } from "../apps/render-worker/src/motion-video.js";
import { renderManagedMotion } from "../apps/render-worker/src/motion-renderer.js";

const fixture = resolve("tests/fixtures/continuous-overlap"), output = resolve(process.argv[2] ?? ".repair-validation/continuous-semantic/overlap");
const parameters = JSON.parse(await readFile(join(fixture, "overlap-parameters.json"), "utf8"));
const root = resolve("."), hash = await hashMotionFile(join(root, parameters.managedPath));
assert.equal(hash, parameters.sourceHashFromCatalogue);
await mkdir(output, { recursive: true });
const results: Record<string, any> = {};
for (const [name, sourceFile, offset, count] of [
  ["before", parameters.beforeSource, 0, parameters.durationInFrames],
  ["after", parameters.afterSource, 0, parameters.durationInFrames],
  ["first", parameters.afterSource, 0, parameters.splitTest.splitFrame],
  ["second", parameters.afterSource, parameters.splitTest.splitFrame, parameters.durationInFrames-parameters.splitTest.splitFrame]
] as Array<[string,string,number,number]>) {
  if (name === "before" && process.argv.includes("--after-only")) continue;
  const binding = { assetId: parameters.videoBinding.assetId, sourceStartMs: offset*1000/parameters.fps, sourceEndMs: (offset+count)*1000/parameters.fps, startFrame:0, endFrame:count };
  const work = motionSubmissionSchema.parse({ ...motionFixture, source: await readFile(join(fixture,sourceFile),"utf8"), props:{offset}, width:parameters.width, height:parameters.height, fps:parameters.fps, durationInFrames:count, fontBindings:parameters.fontBindings, videoBindings:{footage:binding} });
  const fonts = prepareMotionFonts(work, bindMotionFonts(work));
  const provider = await prepareMotionVideos(root, join(output, `decode-${name}`), work, [{...binding,slot:"footage",hash,managedPath:parameters.managedPath}]);
  try { results[name] = await renderManagedMotion(work, join(output,name), {}, provider, undefined, fonts); }
  finally { await provider.close(); }
  await writeFile(join(output,`${name}.json`),JSON.stringify(results[name],null,2));
  console.log(JSON.stringify({name,frames:results[name].frameHashes.length}));
}
assert.deepEqual([...results.first.frameHashes,...results.second.frameHashes],results.after.frameHashes);
await writeFile(join(output,"verification.json"),JSON.stringify({sourceHash:hash,frames:parameters.durationInFrames,splitFrame:parameters.splitTest.splitFrame,equal:true,fonts:parameters.fontBindings,review:"逐帧一致性通过；作者观感检查另记，不由哈希判断审美"},null,2));
console.log("整段与分块全部288帧一致");
