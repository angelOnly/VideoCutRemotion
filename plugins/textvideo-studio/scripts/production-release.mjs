import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const pluginRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function digestTree(root,ignore=()=>false){const hash=createHash('sha256');function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(dir,entry.name),name=relative(root,path).replaceAll('\\','/');if(ignore(name))continue;if(entry.isDirectory())walk(path);else{hash.update(name);hash.update('\0');hash.update(readFileSync(path));hash.update('\0');}}}walk(root);return hash.digest('hex');}
export const runtimeScripts=['production-release.mjs','production-launcher.mjs','production-mcp-launcher.mjs'];
export function releaseIdentity(root){return 'release-'+createHash('sha256').update(digestTree(join(root,'runtime/dist'),n=>n==='manifest.json')).update(digestTree(join(root,'skills'))).update(runtimeScripts.map(name=>readFileSync(join(root,'scripts',name),'utf8')).join('\0')).update(readFileSync(join(root,'.codex-plugin/plugin.json'))).update(readFileSync(join(root,'.mcp.json'))).digest('hex');}
export function verifyRelease(root=pluginRoot){const manifest=JSON.parse(readFileSync(join(root,'runtime/dist/manifest.json'),'utf8'));if(manifest.releaseId!==releaseIdentity(root)||manifest.skillsDigest!==digestTree(join(root,'skills')))throw new Error('插件发行完整性校验失败');return manifest;}
export function deploymentEnvironment(root=pluginRoot){verifyRelease(root);const dependency=process.env.TEXTVIDEO_DEPENDENCY_ROOT;if(!dependency||!existsSync(join(dependency,'node_modules/remotion/package.json')))throw new Error('必须配置 TEXTVIDEO_DEPENDENCY_ROOT 并准备固定依赖');return {...process.env,TEXTVIDEO_PLUGIN_ROOT:root,NODE_PATH:join(dependency,'node_modules')};}
