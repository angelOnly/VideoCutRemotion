import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';

/** 明确映射发行正文，不用正则删改通用工作流，也不沿旧引用自动扩大发行范围。 */
export async function readSkillManifest(repoRoot) {
  const root = join(repoRoot, '.agents/skills');
  const templateRoot = join(root, '_shared/template-production');
  const manifest = JSON.parse(await readFile(join(templateRoot, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 2 || manifest.sourceRoot !== '.agents/skills') throw new Error('技能维护源版本或根目录不符合合同');
  const professional = new Set(manifest.professionalSources);
  if (!professional.size || professional.size !== manifest.professionalSources.length) throw new Error('专业正文来源为空或重复');
  const realRoot = await realpath(root);
  const checkSource = async path => {
    // 词法检查不能阻止符号链接逃逸；复制前核对真实路径及普通文件身份。
    const actual = await realpath(join(root, path));
    const within = relative(realRoot, actual);
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('技能来源真实路径越界');
    if (!(await stat(actual)).isFile()) throw new Error('技能来源必须是普通文件');
    return actual;
  };
  const sourceSkills = (await readdir(join(repoRoot, '.agents/skills'), { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.name.startsWith('_')).map(entry => entry.name).sort();
  if (manifest.retainedSkills.length !== 18 || manifest.excludedSkills.length !== 11 || manifest.excludedHistoricalCases.length !== 13) throw new Error('后台技能处置数量不符合合同');
  const declared = [...manifest.retainedSkills, ...manifest.excludedSkills].sort();
  if (new Set(declared).size !== declared.length || JSON.stringify(declared) !== JSON.stringify(sourceSkills)) throw new Error('源技能未完整登记保留或排除策略');
  const historical = (await readdir(join(repoRoot, '.agents/skills/motion-case-library/references/cases'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (JSON.stringify(historical) !== JSON.stringify([...manifest.excludedHistoricalCases].sort())) throw new Error('历史案例排除清单与维护源不一致');
  for (const [files, allowed] of [[manifest.renderFiles, manifest.retainedSkills], [manifest.analysisFiles, ['production-coordinator']]]) {
    const entryNames = files.filter(file => file.target.endsWith('/SKILL.md')).map(file => file.target.split('/')[0]).sort();
    if (JSON.stringify(entryNames) !== JSON.stringify([...allowed].sort())) throw new Error('阶段技能入口不符合允许清单');
    const targets = new Set();
    const sources = new Set();
    for (const file of files) {
      for (const path of [file.source, file.target]) if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || !part)) throw new Error('技能映射路径越界');
      if (targets.has(file.target)) throw new Error('技能目标路径重复');
      targets.add(file.target);
      if (!file.source.startsWith('_shared/template-production/') && !professional.has(file.source)) throw new Error('专业来源未在明确清单中登记');
      if (professional.has(file.source) && (!/^[a-z-]+\/references\/[a-z-]+\.md$/.test(file.source) || file.source !== file.target || !manifest.retainedSkills.includes(file.source.split('/')[0]))) throw new Error('专业正文必须映射到所属保留技能的同名参考');
      const actualSource = await checkSource(file.source);
      if (sources.has(actualSource)) throw new Error('阶段专业或操作正文重复映射');
      sources.add(actualSource);
    }
    // 仅核查显式 Markdown 相对链接，链接必须在本阶段的映射闭包内。
    for (const file of files.filter(file => file.target.endsWith('.md'))) {
      const body = await readFile(join(root, file.source), 'utf8');
      for (const forbidden of [...manifest.excludedSkills, ...manifest.excludedHistoricalCases, 'TOPIC_TO_FILM.md', 'validated-index.md', 'validated-use.md', 'r92-family-index.md', 'skillry-retrieval.md']) {
        if (body.includes(forbidden)) throw new Error(`后台技能仍引用排除入口：${file.target} → ${forbidden}`);
      }
      for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = match[1].split('#')[0];
        if (!href || /^[a-z]+:/i.test(href)) continue;
        const target = relative('/view', resolve('/view', dirname(file.target), href)).replaceAll('\\', '/');
        if (!targets.has(target)) throw new Error(`技能引用不在阶段发行闭包：${file.target} → ${href}`);
      }
    }
  }
  for (const source of professional) {
    if (manifest.renderFiles.filter(file => file.source === source).length !== 1 || manifest.analysisFiles.some(file => file.source === source)) throw new Error('专业正文必须只在 Render 清单中映射一次');
  }
  const targets = new Set(manifest.renderFiles.map(file => file.target));
  if (Object.keys(manifest.roles ?? {}).sort().join() !== ['audio', 'coordinator', 'director', 'reviewer', 'visual'].join()) throw new Error('角色读取清单不完整');
  for (const role of Object.values(manifest.roles)) {
    for (const entry of role.entries) if (!targets.has(`${entry}/SKILL.md`)) throw new Error('角色入口不在发行闭包');
    for (const reference of [...role.references, ...(role.conditionalReferences ?? [])]) if (!targets.has(reference)) throw new Error('角色参考不在发行闭包');
  }
  return { root, templateRoot, manifest };
}

export async function listFiles(root, base = root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, base));
    else files.push(relative(base, path).replaceAll('\\', '/'));
  }
  return files.sort();
}

export async function verifySkillView(root, sourceRoot, files) {
  const actual = await listFiles(root), expected = files.map(file => file.target).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`阶段技能资源不符合明确清单：${root}`);
  for (const file of files) {
    const [source, target] = await Promise.all([readFile(join(sourceRoot, file.source)), readFile(join(root, file.target))]);
    if (!source.equals(target)) throw new Error(`阶段技能内容已漂移：${file.target}`);
  }
}
