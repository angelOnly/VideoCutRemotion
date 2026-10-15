import {build} from 'esbuild';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(process.argv[2]);
const {readFile}=await import('node:fs/promises');
const manifest=JSON.parse(await readFile(resolve(root,'renderer/renderer-manifest.json'),'utf8'));
if(manifest.timelineContract!=='sentence-timeline/1'||manifest.timelineDataRef!=='timeline.json')throw new Error('模板缺少单一 JSON 时间线合同');
const source=await readFile(resolve(root,'renderer',manifest.timelineModule),'utf8');
if(!source.includes("import timelineData from '../timeline.json'")||!/export const timeline: FinanceTimeline = timelineData as FinanceTimeline;/.test(source))throw new Error('渲染入口未使用唯一时间线');
JSON.parse(await readFile(resolve(root,'renderer',manifest.timelineDataRef),'utf8'));

// 编译本地模块及新增示例，外部依赖由正式运行环境提供。
await build({entryPoints:[resolve(root,'renderer/src/index.ts'),resolve(root,'renderer/src/safe-visuals.tsx')],bundle:true,write:false,outdir:'unused',platform:'browser',packages:'external',jsx:'automatic',nodePaths:[resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules')]});
console.log('模板源码编译通过');

// 对生成后的真实校验器跑边界用例，未通过就不允许打包ZIP。
const {createRequire}=await import('node:module');
const assert=(await import('node:assert/strict')).default;
const require=createRequire(import.meta.url);
const compiled=await build({entryPoints:[resolve(root,'renderer/src/validateTimeline.ts')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'});
const mod={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(require,mod,mod.exports);
const {validateTimeline}=mod.exports;
const timing=await build({entryPoints:[resolve(root,'renderer/src/intro-timing.ts')],bundle:true,write:false,platform:'node',format:'cjs'});
const timingMod={exports:{}};new Function('module','exports',timing.outputFiles[0].text)(timingMod,timingMod.exports);
const {isIntroFrame}=timingMod.exports;
const make=()=>({width:1920,height:1080,fps:30,totalFrames:100,chapters:[{id:'c',from:0,endFrameExclusive:100,label:'测试',title:'标题',summary:'摘要',visualBlocks:[{id:'v',kind:'metric',startFrame:0,endFrameExclusive:100,props:{label:'数值',value:'90%',detail:'测试'}}]}],scenes:[{id:'s',from:0,frames:100,speaker:'male-chief',summary:'测试',intro:{fromFrame:20,frames:30,src:'test.mp4',muted:true},visualBlocks:[],captions:[],utterances:[]}]});
validateTimeline(make());
const scene=make().scenes[0];assert.equal(isIntroFrame(scene,19),false);assert.equal(isIntroFrame(scene,20),true);assert.equal(isIntroFrame(scene,49),true);assert.equal(isIntroFrame(scene,50),false);
for(const [from,to] of [[1,100],[0,99]]){const value=make();value.chapters[0].visualBlocks[0].startFrame=from;value.chapters[0].visualBlocks[0].endFrameExclusive=to;assert.throws(()=>validateTimeline(value),/图解覆盖/);}
const gap=make();gap.chapters[0].from=1;gap.chapters[0].visualBlocks[0].endFrameExclusive=99;assert.throws(()=>validateTimeline(gap),/章节覆盖/);
const missing=make();delete missing.scenes[0].intro.frames;assert.throws(()=>validateTimeline(missing),/实测/);
const overlap=make();overlap.scenes[0].chapter={frames:25};assert.throws(()=>validateTimeline(overlap),/重叠/);
console.log('片头首末帧、片头前后正文覆盖和转场冲突检查通过');
