import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pluginRoot,verifyRelease,digestTree } from './production-release.mjs';
import { pathToFileURL } from 'node:url';
const manifest=verifyRelease();
// 独立项目必须保持独立身份，防止构建或安装时再次覆盖旧插件。
const plugin=JSON.parse(readFileSync(join(pluginRoot,'.codex-plugin/plugin.json'),'utf8'));
const mcp=JSON.parse(readFileSync(join(pluginRoot,'.mcp.json'),'utf8'));
if(plugin.name!=='textvideo-studio'||Object.keys(mcp.mcpServers).join(',')!=='textvideo-studio'||plugin.version!==manifest.pluginVersion)throw new Error('独立插件身份或版本不一致');
// 从已打包资源实际检索和阅读，不能仅在含全部原片的源码库上通过测试。
const library=join(pluginRoot,'runtime/dist/motion-library');
const {searchLibrary,readLibraryMechanism}=await import(pathToFileURL(join(library,'tools/library-store.mjs')).href);
const found=searchLibrary(library,{query:'比较',limit:1});
if(!found.cards?.length)throw new Error('发行词法库检索未返回机制');
const read=readLibraryMechanism(library,{id:found.cards[0].id});
if(!read.image||!read.result.body)throw new Error('发行词法库缺少正文或分镜图');
for(const entry of ['runtime.cjs','mcp.cjs','review.cjs']){const code=readFileSync(join(pluginRoot,'runtime/dist',entry),'utf8');for(const forbidden of ['ComfyUIBridge','runWorkerForever','OmniVoice','submit_transcription','analyze_motion_reference'])if(code.includes(forbidden))throw new Error(`发行物仍包含已删除能力：${forbidden}`);}
console.log(JSON.stringify({status:'passed',releaseId:manifest.releaseId,skillsDigest:manifest.skillsDigest,capabilities:manifest.capabilities}));
