import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access, cp, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readSkillManifest, verifySkillView, listFiles } from '../plugins/textvideo-studio/scripts/skill-manifest.mjs';
import { packageMotionLibrary, mechanismModules } from '../plugins/textvideo-studio/scripts/package-motion-library.mjs';
import { registerMotionLibraryTools } from '../apps/server/src/motion-library-tools.js';
import { projectTemplateMotionSearchResult } from '../apps/server/src/motion-library-output.js';

const repo = process.cwd(), plugin = join(repo, 'plugins/textvideo-studio');

test('后台技能完整处置 29 项，阶段链接闭包与发行字节一致，历史源保留', async () => {
  const { root, templateRoot, manifest } = await readSkillManifest(repo);
  assert.equal((await listFiles(templateRoot)).some(path => path.endsWith('/SKILL.md')), false, '后台映射源不能被宿主递归注册为第二组同名技能');
  assert.equal(manifest.retainedSkills.length, 18);
  assert.equal(manifest.excludedSkills.length, 11);
  assert.equal(manifest.excludedHistoricalCases.length, 13);
  await verifySkillView(join(plugin, 'skills'), root, manifest.renderFiles);
  await verifySkillView(join(plugin, 'skills-stages/render'), root, manifest.renderFiles);
  await verifySkillView(join(plugin, 'skills-stages/analysis'), root, manifest.analysisFiles);
  const analysis = await listFiles(join(plugin, 'skills-stages/analysis'));
  assert.equal(analysis.filter(path => path.endsWith('/SKILL.md')).length, 1);
  assert.equal(analysis.some(path => /\.tsx?$/.test(path)), false);
  for (const name of manifest.excludedSkills) await access(join(repo, '.agents/skills', name, 'SKILL.md'));
  for (const name of manifest.excludedHistoricalCases) await access(join(repo, '.agents/skills/motion-case-library/references/cases', name));
});

test('恢复正文保留 0.1.8 专业原段、唯一维护源与角色读取闭包，不发行旧操作', async () => {
  const { root, manifest } = await readSkillManifest(repo);
  const provenance = JSON.parse(await readFile(join(repo, 'tests/fixtures/production-knowledge-baseline.json'), 'utf8'));
  assert.equal(provenance.baseline, 'a128eee');
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  for (const entry of provenance.files) {
    const body = await readFile(join(root, entry.target), 'utf8');
    const hashes = new Set(body.split(/\n\s*\n/).map((paragraph: string) => digest(paragraph.trim())));
    for (const hash of entry.preservedParagraphs) assert.ok(hashes.has(hash), `完整专业原段被删改：${entry.target} ${hash}`);
    assert.equal(manifest.renderFiles.filter((file: any) => file.source === entry.target).length, 1);
  }
  for (const file of manifest.renderFiles) {
    const body = await readFile(join(root, file.source), 'utf8');
    assert.doesNotMatch(body, /generate_speech_captions|submit_motion_work|apply_authored_script|read_motion_capabilities|manage_effect_cues|semantic_used|analyze_motion_reference|pauseBefore\/After/);
  }
  assert.ok(manifest.roles.visual.references.includes('effect-timing/references/timing-design.md'));
  assert.ok(manifest.roles.audio.references.includes('voice-production/references/speech-performance.md'));
  assert.ok(manifest.roles.audio.references.includes('captions/references/caption-design.md'));
});

test('专业映射拒绝未登记来源、重复、真实路径逃逸及不完整角色引用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'textvideo-skill-boundary-'));
  try {
    await cp(join(repo, '.agents'), join(directory, '.agents'), { recursive: true });
    const path = join(directory, '.agents/skills/_shared/template-production/manifest.json');
    const original = JSON.parse(await readFile(path, 'utf8'));
    const assertMutation = async (change: (manifest: any) => void, error: RegExp) => {
      const candidate = structuredClone(original); change(candidate);
      await writeFile(path, JSON.stringify(candidate));
      await assert.rejects(readSkillManifest(directory), error);
    };
    await assertMutation(m => { m.renderFiles.push({ source: 'captions/references/caption-operations.md', target: 'captions/references/old.md' }); }, /未在明确清单/);
    await assertMutation(m => { m.renderFiles.push(m.renderFiles.at(-1)); }, /目标路径重复/);
    await assertMutation(m => { m.roles.audio.references.push('captions/references/missing.md'); }, /角色参考不在发行闭包/);
    await assertMutation(m => { m.renderFiles[0].source = '../outside.md'; }, /路径越界/);
    await writeFile(path, JSON.stringify(original));
    const source = join(directory, '.agents/skills', original.professionalSources[0]);
    const outside = join(directory, 'outside.md');
    await writeFile(outside, '越界正文'); await rm(source); await symlink(outside, source);
    await assert.rejects(readSkillManifest(directory), /真实路径越界/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('后台机制摘要不带全 taxonomy、源码检索正文或整片浏览入口', () => {
  const raw = { source_sha256: 'a'.repeat(64), taxonomy: { actions: ['大词表'] }, cards: [{ id: '001-m01', purpose: '比较', relation: '保持参照', start_state: '整体', end_state: '并列', overview: 'overview.md', search_text: '详细内部索引', retrieval: { categories: ['all'] } }] };
  const compact = projectTemplateMotionSearchResult(raw);
  assert.equal(compact.taxonomy, undefined);
  assert.deepEqual(compact.cards, [{ id: '001-m01', purpose: '比较', relation: '保持参照', start_state: '整体', end_state: '并列' }]);
  assert.ok(raw.taxonomy);
});

test('最小机制发行包支持实际词法检索和按需静态图，不开放全库或 overview', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'textvideo-mechanism-release-'));
  const server = new McpServer({ name: '机制发行验证', version: '1' });
  const client = new Client({ name: '测试客户端', version: '1' });
  try {
    const built = await packageMotionLibrary(join(repo, 'references/motion-cases/skillry'), directory);
    assert.equal(built.count, 567);
    for (const file of await listFiles(directory)) assert.ok(mechanismModules.includes(file) || file === 'mechanism-index.json' || /^cases\/[a-zA-Z0-9-]+\/mechanisms\/m\d{2}\.(md|jpg)$/.test(file), file);
    registerMotionLibraryTools(server, directory);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const search = await client.callTool({ name: 'search_motion_mechanisms', arguments: { query: '比较' } });
    assert.notEqual(search.isError, true);
    const result = JSON.parse((search.content as any[])[0].text);
    assert.equal(result.cards.length, 3);
    assert.equal(result.taxonomy, undefined);
    assert.equal(result.source_sha256, built.source_sha256);
    const id = result.cards[0].id;
    const located = await client.callTool({ name: 'search_motion_mechanisms', arguments: { ids: [id] } });
    assert.notEqual(located.isError, true);
    assert.equal(JSON.parse((located.content as any[])[0].text).cards[0].id, id);
    const read = await client.callTool({ name: 'read_motion_mechanism', arguments: { id } });
    assert.notEqual(read.isError, true);
    assert.equal((read.content as any[]).length, 1, '默认详情不附图片');
    assert.ok(JSON.parse((read.content as any[])[0].text).body.includes('运动指令'));
    const pictured = await client.callTool({ name: 'read_motion_mechanism', arguments: { id, include_storyboard: true } });
    assert.ok((pictured.content as any[]).some(item => item.type === 'image'));
    assert.equal((await client.callTool({ name: 'read_motion_mechanism', arguments: { id, part: 'overview' } })).isError, true);
    assert.equal((await client.callTool({ name: 'search_motion_mechanisms', arguments: {} })).isError, true);
    assert.equal((await client.callTool({ name: 'read_motion_mechanism', arguments: { id, source_sha256: 'f'.repeat(64) } })).isError, true);
  } finally {
    await client.close(); await server.close(); await rm(directory, { recursive: true, force: true });
  }
});


test('模板发行由 Codex 选择检查，不恢复最终视听发布限制',async()=>{
  const review=await readFile(join(plugin,'skills/production-coordinator/references/review.md'),'utf8');
  const exported=await readFile(join(plugin,'skills/production-coordinator/references/export.md'),'utf8');
  assert.match(review,/Worker 只执行媒体工具/);assert.match(review,/不会启动模型/);assert.match(review,/assign_review_work/);assert.doesNotMatch(review,/claim_review_work|previewRequests/);
  assert.match(exported,/未观察内容仅如实记入 checks/);
  assert.match(exported,/deliveryPath/);
  assert.doesNotMatch(exported,/通过 prepare_review 的 final|缺关键连续看听.*不发布/);
});
