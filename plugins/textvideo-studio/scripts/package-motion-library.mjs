import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { buildIndex } from '../../../references/motion-cases/skillry/tools/mechanism-index.mjs';
import { parseMechanism } from '../../../references/motion-cases/skillry/document-format.mjs';

// 词法检索及索引校验的实际模块闭包，不复制网页浏览、旧 CLI、整片卡片或视频。
export const mechanismModules = ['case-catalogue.json', 'document-format.mjs', 'mechanism-search.mjs', 'selection.mjs', 'taxonomy.mjs', 'tools/mechanism-index.mjs', 'tools/library-store.mjs'];
export async function packageMotionLibrary(source, target) {
  await mkdir(target, { recursive: true });
  for (const name of mechanismModules) {
    await mkdir(dirname(join(target, name)), { recursive: true });
    await copyFile(join(source, name), join(target, name));
  }
  const catalogue = JSON.parse(await readFile(join(source, 'case-catalogue.json'), 'utf8'));
  for (const entry of catalogue.cases.filter(entry => entry.analysis_kind === 'mechanisms-v1')) {
    const directory = `${entry.directory}/mechanisms`;
    await mkdir(join(target, directory), { recursive: true });
    for (const name of (await readdir(join(source, directory))).filter(name => /^m\d{2}\.md$/.test(name))) {
      const { metadata, body } = parseMechanism(await readFile(join(source, directory, name), 'utf8'));
      // 用文档结构明确去掉视频切片段，保留运动指令和组合调整正文。
      delete metadata.clip;
      const lines = body.split('\n'), kept = [];
      let videoSection = false;
      for (const line of lines) {
        if (line.startsWith('## ')) videoSection = line.trim() === '## 视频切片';
        if (!videoSection) kept.push(line);
      }
      const serialized = '---\n' + Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\n' + kept.join('\n');
      await writeFile(join(target, directory, name), serialized);
      await copyFile(join(source, directory, name.replace('.md', '.jpg')), join(target, directory, name.replace('.md', '.jpg')));
    }
  }
  const index = buildIndex(target);
  await writeFile(join(target, 'mechanism-index.json'), JSON.stringify(index, null, 2));
  return { count: index.count, source_sha256: index.source_sha256 };
}
