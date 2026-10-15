import { build } from 'esbuild';
import { join } from 'node:path';
import { ProductionError } from './contracts.js';
import { regular } from './files.js';

/** 提前执行模板自身的纯校验，不在通用服务另写一套模板时间规则。 */
export async function validateTemplateTimeline(project:string,timeline:unknown,manifest:{timelineValidator?:string}){
  if(!manifest.timelineValidator)return;
  const entryPoint=await regular(join(project,'renderer'),manifest.timelineValidator);
  try{
    const result=await build({entryPoints:[entryPoint],bundle:true,write:false,format:'cjs',platform:'neutral',target:'es2022',logLevel:'silent'});
    const module={exports:{} as {validateTimeline?:(timeline:unknown)=>unknown}};
    new Function('module','exports',result.outputFiles[0].text)(module,module.exports);
    if(typeof module.exports.validateTimeline!=='function')throw new Error('须导出纯函数 validateTimeline');
    // 校验只观察候选数据，不能替作者悄悄修改动作或待提交的时间线。
    await module.exports.validateTimeline(structuredClone(timeline));
  }catch(error){
    throw new ProductionError('TEMPLATE_TIMELINE_INVALID',`模板时间线校验失败（${manifest.timelineValidator}）：${error instanceof Error?error.message:String(error)}`);
  }
}
