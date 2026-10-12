import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssetRequest } from "@videocut/contracts";
import { MixkitMusicProvider, MixkitSoundProvider } from "../packages/asset-acquisition/src/mixkit.js";
import { MIXKIT_MUSIC_CATEGORIES, MIXKIT_SOUND_CATEGORIES } from "../packages/asset-acquisition/src/sound-catalog.js";

// 只核验已声明分类的公开页面；不下载试听、原文件或递归遍历链接。
const report: Array<Record<string, unknown>> = [];
const output = resolve(".candidate/media-intelligence-20260908/mixkit-catalog-live.json");
await mkdir(resolve(".candidate/media-intelligence-20260908"), { recursive: true });
for (const music of [false, true]) {
  const provider = music ? new MixkitMusicProvider() : new MixkitSoundProvider();
  for (const query of music ? MIXKIT_MUSIC_CATEGORIES : MIXKIT_SOUND_CATEGORIES) {
    try {
      const rows = await provider.search({ request: { mediaKind: "audio", role: music ? "bgm" : "sfx" } as AssetRequest, query });
      report.push({ provider: provider.name, query, status: "passed", count: rows.length, sourceUrl: rows[0].sourceUrl, });
      console.log(`${provider.name}/${query}: ${rows.length}`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      report.push({ provider: provider.name, query, status: "failed", code, error: String(error) });
      console.log(`${provider.name}/${query}: ${code ?? String(error)}`); process.exitCode = 1;
      if (code === "MIXKIT_RATE_LIMITED") { await writeFile(output, JSON.stringify(report, null, 2)); process.exit(1); }
    }
    await writeFile(output, JSON.stringify(report, null, 2));
  }
}
