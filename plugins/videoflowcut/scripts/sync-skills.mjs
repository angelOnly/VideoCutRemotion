import { mkdir, writeFile } from "node:fs/promises";
import { syncTree } from "./sync-tree.mjs";
import { join } from "node:path";
import { pluginRootFromModule, resolveRepoRoot } from "./repo-root.mjs";

const pluginRoot = pluginRootFromModule(import.meta.url);
const repoRoot = resolveRepoRoot({ pluginRoot });
const sourceRoot = join(repoRoot, ".agents", "skills");
const targetRoot = join(pluginRoot, "skills");

await syncTree(sourceRoot, targetRoot);

/**
 * Codex 插件校验会把 skills/ 下的一级目录都当作 Skill。
 * 根仓库的 _shared 是纯参考目录；发行副本补一个内部说明，使原有 ../_shared 相对引用保持可用。
 * 它只能被其它 Skill 按需读取，不能作为自动注入的独立工作流。
 */
const generatedSharedRoot = join(targetRoot, "_shared");
await mkdir(join(generatedSharedRoot, "agents"), { recursive: true });
await Promise.all([
  writeFile(join(generatedSharedRoot, "SKILL.md"), `---
name: videoflowcut-shared-reference
description: VideoFlowCut 内部共享参考资料。仅供其它 VideoFlowCut Skill 按需读取，不作为独立视频工作流。
---

# VideoFlowCut 共享参考资料

此目录保存跨角色的创作依据、当前稿、版本与交接约定。应由具体 VideoFlowCut 工作流引用，不应单独替代项目分析、创作判断或实际预览验证。
`, "utf8"),
  writeFile(join(generatedSharedRoot, "agents", "openai.yaml"), `interface:
  display_name: "VideoFlowCut 共享参考资料"
  short_description: "仅供 VideoFlowCut Skills 按需引用"
policy:
  allow_implicit_invocation: false
`, "utf8")
]);

console.log(`已从唯一 Skills 源同步插件发行副本：${sourceRoot} → ${targetRoot}`);
