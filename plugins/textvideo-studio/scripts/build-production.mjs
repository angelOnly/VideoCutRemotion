import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pluginRoot,digestTree,releaseIdentity } from './production-release.mjs';
import { packageMotionLibrary } from './package-motion-library.mjs';
const repo=resolve(pluginRoot,'../..'),dist=join(pluginRoot,'runtime/dist');
// 只替换仓库内明确的生成目录，不触碰服务数据或安装缓存。
if(relative(join(pluginRoot,'runtime'),dist)!=='dist')throw new Error('发行目录越界');
await rm(dist,{recursive:true,force:true,maxRetries:10,retryDelay:200});await mkdir(dist,{recursive:true});
const options={bundle:true,format:'cjs',platform:'node',target:'node22',packages:'external',sourcemap:'linked',sourcesContent:false,logLevel:'warning'};
await Promise.all([
  build({...options,entryPoints:[join(repo,'apps/runtime/src/index.ts')],outfile:join(dist,'runtime.cjs')}),
  build({...options,entryPoints:[join(repo,'apps/server/src/mcp.ts')],outfile:join(dist,'mcp.cjs')}),
  build({...options,entryPoints:[join(repo,'packages/production-service/src/review-cli.ts')],outfile:join(dist,'review.cjs')})
]);
// 只打包词法检索、机制正文和静态分镜的依赖闭包。
const motionLibrary = await packageMotionLibrary(join(repo,'references/motion-cases/skillry'),join(dist,'motion-library'));
await cp(join(repo,'packages/motion-work/fonts'),join(dist,'fonts'),{recursive:true});
const pkg=JSON.parse(await readFile(join(repo,'package.json'),'utf8'));await writeFile(join(dist,'dependencies.json'),JSON.stringify({engines:pkg.engines,dependencies:pkg.dependencies},null,2));
const plugin=JSON.parse(await readFile(join(pluginRoot,'.codex-plugin/plugin.json'),'utf8'));
await writeFile(join(dist,'manifest.json'),JSON.stringify({schemaVersion:3,pluginVersion:plugin.version,releaseId:releaseIdentity(pluginRoot),skillsDigest:digestTree(join(pluginRoot,'skills')),skillViewsDigest:digestTree(join(pluginRoot,'skills-stages')),skillViews:{analysis:'skills-stages/analysis',render:'skills-stages/render'},motionLibrary,runtimeEntry:'runtime.cjs',mcpEntry:'mcp.cjs',codexProtocolVersion:'0.144.4',nodeRuntime:'>=22.5.0',capabilities:{localModels:false,lexical:true,networkSearchDefault:false},dependencies:'固定 Node 包、Chromium、FFmpeg/ffprobe、Codex CLI 和豆包凭据由部署清单准备'},null,2));
console.log('已生成文本驱动生产插件发行物：'+dist);
