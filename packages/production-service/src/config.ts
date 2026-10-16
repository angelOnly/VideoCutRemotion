import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { ProductionError } from './contracts.js';
export type ProductionConfig=ReturnType<typeof readProductionConfig>;
/** 灰度开关只在配置入口解析，任务指令与媒体工作共用同一份结果。 */
export function readOptimizationConfig(env:NodeJS.ProcessEnv=process.env){
  const boolean=(name:string,fallback:boolean)=>{
    const value=env[name];if(value===undefined)return fallback;
    if(value==='true')return true;if(value==='false')return false;
    throw new ProductionError('CONFIG_INVALID',`${name} 必须是 true 或 false`,503);
  };
  const qaMaxReviewers=Number(env.TEXTVIDEO_QA_MAX_REVIEWERS??3);
  if(!Number.isInteger(qaMaxReviewers)||qaMaxReviewers<1||qaMaxReviewers>3)throw new ProductionError('CONFIG_INVALID','TEXTVIDEO_QA_MAX_REVIEWERS 必须是 1 到 3 的整数',503);
  const sceneCutMode=env.TEXTVIDEO_SCENE_CUT_MODE??'accurate';
  if(sceneCutMode!=='accurate'&&sceneCutMode!=='hybrid')throw new ProductionError('CONFIG_INVALID','TEXTVIDEO_SCENE_CUT_MODE 必须是 accurate 或 hybrid',503);
  const renderStrategy=env.TEXTVIDEO_RENDER_STRATEGY??'scene-chunks';
  if(renderStrategy!=='scene-chunks'&&renderStrategy!=='whole-slices')throw new ProductionError('CONFIG_INVALID','TEXTVIDEO_RENDER_STRATEGY 必须是 scene-chunks 或 whole-slices',503);
  const integer=(name:string,fallback:number,max:number)=>{const value=Number(env[name]??fallback);if(!Number.isInteger(value)||value<1||value>max)throw new ProductionError('CONFIG_INVALID',`${name} 必须是 1 到 ${max} 的整数`,503);return value;};
  return {qaParallelReview:boolean('TEXTVIDEO_QA_PARALLEL_REVIEW',true),qaMaxReviewers,previewOnDemand:boolean('TEXTVIDEO_PREVIEW_ON_DEMAND',true),sceneCutMode:sceneCutMode as 'accurate'|'hybrid',mediaTiming:boolean('TEXTVIDEO_MEDIA_TIMING',true),renderStrategy:renderStrategy as 'scene-chunks'|'whole-slices',mediaGlobalConcurrency:integer('TEXTVIDEO_MEDIA_GLOBAL_CONCURRENCY',24,128),mediaRunConcurrency:integer('TEXTVIDEO_MEDIA_RUN_CONCURRENCY',6,8),mediaProcessConcurrency:integer('TEXTVIDEO_MEDIA_PROCESS_CONCURRENCY',7,32)};
}
export function readProductionConfig(){
  const required=(name:string)=>{const value=process.env[name];if(!value)throw new ProductionError('CONFIG_REQUIRED',`缺少部署配置 ${name}`,503);return value;};
  const positive=(name:string,fallback:number,max:number)=>{const value=Number(process.env[name]??fallback);if(!Number.isInteger(value)||value<1||value>max)throw new ProductionError('CONFIG_INVALID',`${name} 必须是 1 到 ${max} 的整数`,503);return value;};
  const optimization=readOptimizationConfig();
  const maxActiveRuns=positive('TEXTVIDEO_MAX_ACTIVE_RUNS',4,4),renderConcurrency=positive('TEXTVIDEO_RENDER_CONCURRENCY',3,32);
  if(renderConcurrency>optimization.mediaGlobalConcurrency)throw new ProductionError('CONFIG_INVALID','单片绘图并发不能超过全局绘图预算',503);
  const speechConcurrency=positive('TEXTVIDEO_SPEECH_CONCURRENCY',20,20),speechPerRunConcurrency=positive('TEXTVIDEO_SPEECH_PER_RUN_CONCURRENCY',5,5);
  if(speechPerRunConcurrency>speechConcurrency)throw new ProductionError('CONFIG_INVALID','单任务配音并发不能超过全局并发',503);
  const pluginRoot=resolve(required('TEXTVIDEO_PLUGIN_ROOT')),dataRoot=resolve(required('TEXTVIDEO_DATA_ROOT'));
  const release=JSON.parse(readFileSync(join(pluginRoot,'runtime/dist/manifest.json'),'utf8'));
  return { ...optimization,pluginRoot,dataRoot,release,host:process.env.TEXTVIDEO_HOST??'127.0.0.1',port:Number(process.env.TEXTVIDEO_PORT??3410),
    apiToken:required('TEXTVIDEO_API_TOKEN'),accountId:process.env.TEXTVIDEO_ACCOUNT_ID??'local',
    webSubmitAddresses:(process.env.TEXTVIDEO_WEB_SUBMIT_ADDRESSES??'').split(',').map(s=>s.trim()).filter(Boolean),
    templateBase:required('CUSTOM_TEMPLATE_API_BASE_URL'),callbackBase:required('CALLBACK_BASE_URL'),callbackSecret:required('CALLBACK_SECRET'),
    mediaBase:required('MEDIA_PUBLIC_BASE_URL').replace(/\/$/,''),dependencyRoot:resolve(required('TEXTVIDEO_DEPENDENCY_ROOT')),
    codexExecutable:required('CODEX_EXECUTABLE'),codexHome:resolve(required('TEXTVIDEO_CODEX_HOME')),model:process.env.TEXTVIDEO_MODEL??'gpt-6-astra',
    browser:process.env.REMOTION_BROWSER_EXECUTABLE,voicesPath:process.env.DOUBAO_VOICES_FILE,
    searchEnabled:process.env.TEXTVIDEO_NETWORK_SEARCH==='true',maxActiveRuns,renderConcurrency,speechConcurrency,speechPerRunConcurrency,
    ready:{codex:existsSync(required('CODEX_EXECUTABLE')),tts:Boolean(process.env.DOUBAO_API_KEY&&process.env.DOUBAO_VOICES_FILE),dependencies:existsSync(join(required('TEXTVIDEO_DEPENDENCY_ROOT'),'node_modules/remotion/package.json'))}
  };
}
