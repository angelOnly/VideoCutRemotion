import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { searchLibrary, readLibraryMechanism } from '../../../references/motion-cases/skillry/tools/library-store.mjs';
import { termsFor } from '../../../references/motion-cases/skillry/taxonomy.mjs';
import { projectTemplateMotionSearchResult, projectTemplateMotionMechanismResult } from './motion-library-output.js';

const id = z.string().regex(/^\d{3}-m\d{2}$/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const choices = (field: string) => z.array(z.enum(termsFor(field) as [string, ...string[]])).max(20).optional();

export function registerMotionLibraryTools(server: McpServer, root = resolve(process.cwd(), 'references/motion-cases/skillry'), ..._removedProjectArguments: unknown[]) {
  const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: 'MOTION_LIBRARY_UNAVAILABLE', message: String(error), sideEffects: 'none' }) }] });
  server.registerTool('search_motion_mechanisms', {
    description: '按实际内容和演出关系查询本地机制词法库，默认返回 3 个摘要；无向量、模型或网络回退。',
    inputSchema: {
      query: z.string().max(1000).optional(), stages: z.array(z.string().min(1).max(1000)).min(1).max(8).optional(),
      categories: choices('categories'), actions: choices('actions'), entry: choices('entry'), exit: choices('exit'), holds: choices('holds'), exclude_actions: choices('actions'),
      similar_to: id.optional(), before: id.optional(), after: id.optional(), ids: z.array(id).min(1).max(40).optional(),
      selection: z.string().max(16000).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional(), source_sha256: fingerprint.optional()
    }
  }, async request => {
    try {
      const filters = [request.categories, request.actions, request.entry, request.exit, request.holds];
      if (!request.query?.trim() && !request.stages?.length && !request.ids?.length && !request.similar_to && !request.before && !request.after && !request.selection && !filters.some(values => values?.length)) {
        throw new Error('请提供内容关系、筛选条件或机制 ID；后台不提供全库分页浏览');
      }
      // 精确 ID 与采用清单禁止分页参数，不能给它们注入默认 limit。
      const result = searchLibrary(root, { ...request, ...(!request.ids && !request.selection ? { limit: request.limit ?? 3 } : {}) });
      return { content: [{ type: 'text', text: JSON.stringify({ ...projectTemplateMotionSearchResult(result), query: request, diagnostics: { mode: 'lexical', semantic_used: false, reason: '仅词法检索；无结果时调整词语或筛选' } }) }] };
    } catch (error) { return failure(error); }
  });
  server.registerTool('read_motion_mechanism', {
    description: '默认只读取本地机制正文；显式 include_storyboard=true 才附静态分镜，静态图片不代表连续审片。',
    inputSchema: { id, part: z.literal('mechanism').optional(), source_sha256: fingerprint.optional(), include_storyboard: z.boolean().optional() }
  }, async request => {
    try {
      const loaded = readLibraryMechanism(root, { ...request, include_storyboard: request.include_storyboard ?? false });
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: JSON.stringify(projectTemplateMotionMechanismResult(loaded.result)) }];
      if (loaded.image) content.push({ type: 'image', data: loaded.image, mimeType: 'image/jpeg' });
      return { content };
    } catch (error) { return failure(error); }
  });
}
