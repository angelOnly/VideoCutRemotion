import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { ProductionError } from './contracts.js';
export type ProductionConfig=ReturnType<typeof readProductionConfig>;
export function readProductionConfig(){
  const required=(name:string)=>{const value=process.env[name];if(!value)throw new ProductionError('CONFIG_REQUIRED',`缺少部署配置 ${name}`,503);return value;};
  const pluginRoot=resolve(required('TEXTVIDEO_PLUGIN_ROOT')),dataRoot=resolve(required('TEXTVIDEO_DATA_ROOT'));
  const release=JSON.parse(readFileSync(join(pluginRoot,'runtime/dist/manifest.json'),'utf8'));
  return { pluginRoot,dataRoot,release,host:process.env.TEXTVIDEO_HOST??'127.0.0.1',port:Number(process.env.TEXTVIDEO_PORT??3410),
    apiToken:required('TEXTVIDEO_API_TOKEN'),accountId:process.env.TEXTVIDEO_ACCOUNT_ID??'local',
    templateBase:required('CUSTOM_TEMPLATE_API_BASE_URL'),callbackBase:required('CALLBACK_BASE_URL'),callbackSecret:required('CALLBACK_SECRET'),
    mediaBase:required('MEDIA_PUBLIC_BASE_URL').replace(/\/$/,''),dependencyRoot:resolve(required('TEXTVIDEO_DEPENDENCY_ROOT')),
    codexExecutable:required('CODEX_EXECUTABLE'),codexHome:resolve(required('TEXTVIDEO_CODEX_HOME')),model:process.env.TEXTVIDEO_MODEL,
    browser:process.env.REMOTION_BROWSER_EXECUTABLE,voicesPath:process.env.DOUBAO_VOICES_FILE,
    searchEnabled:process.env.TEXTVIDEO_NETWORK_SEARCH==='true',renderConcurrency:Number(process.env.TEXTVIDEO_RENDER_CONCURRENCY??2),
    ready:{codex:existsSync(required('CODEX_EXECUTABLE')),tts:Boolean(process.env.DOUBAO_API_KEY&&process.env.DOUBAO_VOICES_FILE),dependencies:existsSync(join(required('TEXTVIDEO_DEPENDENCY_ROOT'),'node_modules/remotion/package.json'))}
  };
}
