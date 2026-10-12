import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * 以流式方式计算受管媒体哈希。视频导入可能达到数 GB，不能为去重把整个文件读进 Node 堆。
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
