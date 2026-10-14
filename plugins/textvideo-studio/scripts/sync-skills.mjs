import { mkdir, rm, copyFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pluginRoot } from './production-release.mjs';
import { readSkillManifest, verifySkillView } from './skill-manifest.mjs';

const { root, manifest } = await readSkillManifest(resolve(pluginRoot, '../..'));
// 仅清理本插件的生成树；维护源及其它插件不受影响。
for (const [target, files] of [
  [join(pluginRoot, 'skills'), manifest.renderFiles],
  [join(pluginRoot, 'skills-stages/analysis'), manifest.analysisFiles],
  [join(pluginRoot, 'skills-stages/render'), manifest.renderFiles]
]) {
  await rm(target, { recursive: true, force: true });
  for (const file of files) {
    const path = join(target, file.target);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(join(root, file.source), path);
  }
  await verifySkillView(target, root, files);
}
console.log('已生成独立后台技能视图：Analysis 1 项、Render 18 项；排除 11 项工作流与 13 个历史案例包。');
