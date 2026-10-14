import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
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
  const { root, manifest } = await readSkillManifest(repo);
  assert.equal((await listFiles(root)).some(path => path.endsWith('/SKILL.md')), false, '后台映射源不能被宿主递归注册为第二组同名技能');
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
