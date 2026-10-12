import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectMotionReference } from "../apps/server/src/motion-reference.js";

const evidence = await inspectMotionReference(process.argv[2] ?? "https://remotion.onda.video/components", process.argv[3] === undefined ? undefined : Number(process.argv[3]));
const root = await mkdtemp(join(tmpdir(), "videocut-motion-reference-"));
const { images, ...metadata } = evidence;
const paths: string[] = [];
for (const [index, image] of images.entries()) {
  const path = join(root, `sample-${index}.png`);
  await writeFile(path, Buffer.from(image.data, "base64"));
  paths.push(path);
}
console.log(JSON.stringify({ ...metadata, paths }));
