import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pluginRoot,digestTree,releaseIdentity } from './production-release.mjs';
import { buildIndex } from '../../../references/motion-cases/skillry/tools/mechanisms.mjs';
const repo=resolve(pluginRoot,'../..'),dist=join(pluginRoot,'runtime/dist');
// 只替换仓库内明确的生成目录，不触碰服务数据或安装缓存。
if(relative(join(pluginRoot,'runtime'),dist)!=='dist')throw new Error('发行目录越界');
await rm(dist,{recursive:true,force:true,maxRetries:10,retryDelay:200});await mkdir(dist,{recursive:true});
const options={bundle:true,format:'cjs',platform:'node',target:'node22',packages:'external',sourcemap:'linked',sourcesContent:false,logLevel:'warning'};
await Promise.all([
  build({...options,entryPoints:[join(repo,'apps/runtime/src/index.ts')],outfile:join(dist,'runtime.cjs')}),
  build({...options,entryPoints:[join(repo,'apps/server/src/mcp.ts')],outfile:join(dist,'mcp.cjs')})
]);
// 机制正文、词法索引和静态分镜随发行；不复制历史原片和模型集成。
await cp(join(repo,'references/motion-cases/skillry'),join(dist,'motion-library'),{recursive:true,filter:path=>!/[\\/](__pycache__|\.git|node_modules)([\\/]|$)/.test(path)&&! /\.(mp4|webm|mov|pyc)$/i.test(path)});
// 静态发行不含视频：同步去掉派生副本的切片引用，再从实际正文重建索引。
const library=join(dist,'motion-library');
for(const file of await readdir(join(library,'cases'),{recursive:true})){
  if(!/[/\\]mechanisms[/\\]m\d{2}\.md$/.test('/'+file))continue;
  const path=join(library,'cases',file);let body=await readFile(path,'utf8');
  body=body.replace(/^clip: [^\r\n]*\r?\n/m,'');
  const start=body.indexOf('\n## 视频切片');
  if(start>=0){const end=body.indexOf('\n## ',start+1);body=body.slice(0,start)+'\n\n> 本发行仅包含机制文字与静态分镜，不包含视频切片。\n'+(end<0?'':body.slice(end));}
  await writeFile(path,body);
}
await writeFile(join(library,'mechanism-index.json'),JSON.stringify(buildIndex(library),null,2));
await cp(join(repo,'packages/motion-work/fonts'),join(dist,'fonts'),{recursive:true});
const pkg=JSON.parse(await readFile(join(repo,'package.json'),'utf8'));await writeFile(join(dist,'dependencies.json'),JSON.stringify({engines:pkg.engines,dependencies:pkg.dependencies},null,2));
const plugin=JSON.parse(await readFile(join(pluginRoot,'.codex-plugin/plugin.json'),'utf8'));
await writeFile(join(dist,'manifest.json'),JSON.stringify({schemaVersion:3,pluginVersion:plugin.version,releaseId:releaseIdentity(pluginRoot),skillsDigest:digestTree(join(pluginRoot,'skills')),runtimeEntry:'runtime.cjs',mcpEntry:'mcp.cjs',codexProtocolVersion:'0.144.4',nodeRuntime:'>=22.5.0',capabilities:{localModels:false,lexical:true,networkSearchDefault:false},dependencies:'固定 Node 包、Chromium、FFmpeg/ffprobe、Codex CLI 和豆包凭据由部署清单准备'},null,2));
console.log('已生成文本驱动生产插件发行物：'+dist);
